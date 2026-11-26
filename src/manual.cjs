'use strict';

// Local, short-lived interaction with a specific Claude PermissionRequest, and
// display-only notices: requests that only their own chat can answer, and what a
// session is doing. The hook only accepts a response signed by the VS Code window it
// contacted. Content stays in memory on both ends; nothing here is written to disk.
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// Both ends refuse any other request, notice or decision shape, so a hook and a
// window from different releases leave the request to the official chat.
const PROTOCOL = 2;
const LIMIT = 64 * 1024;
const DETAIL_LIMIT = 10000;
const DESCRIPTOR_LIMIT = 8192;
const PREVIEW_PRIORITY_KEYS = [
  'file_path', 'notebook_path', 'path', 'Path', 'TargetFile', 'AbsolutePath', 'planFilePath',
  'command', 'cmd', 'CommandLine', 'BypassSandbox', 'bypassSandbox', 'Url', 'url',
  'questions', 'permissions', 'justification', 'toolSummary', 'description', 'Description', 'Message', 'reason',
  'plan', 'patch', 'input',
];
const WINDOW_MS = 45000, MIN_WINDOW = 15000, MAX_WINDOW = 540000;
const HANDSHAKE_MS = 350, NOTICE_MS = 300, SETUP_MS = 5000;
// Activity is sent on every tool call: a window that cannot prove itself this fast is skipped.
const ACTIVITY_MS = 150;
const PREVIEW_LIMIT = 64, PREVIEW_MS = 30 * 60000;
const PROVIDERS = ['claude', 'codex', 'agy'];
const uuid = () => crypto.randomUUID();
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeId = id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(id);
const validToken = token => typeof token === 'string' && /^[0-9a-f-]{36}$/.test(token);
const validRef = ref => typeof ref === 'string' && /^[a-z0-9]{1,64}$/.test(ref);
const validCwd = cwd => typeof cwd === 'string' && cwd.length <= 4096 && path.isAbsolute(cwd) &&
  !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(cwd);
const clampWindow = value => Number.isFinite(value) ? Math.round(Math.min(MAX_WINDOW, Math.max(MIN_WINDOW, value))) : WINDOW_MS;
const directoryFor = stateDir => path.join(path.dirname(stateDir), 'approval-windows');
// Loaded only once a connection or an activity notice needs them, so a hook that
// finds no window to contact pays for neither.
const lines = () => require('node:readline');
const content = () => require('./activity.cjs');
// The row a hook event belongs to, as the monitor derives it from the stored snapshot.
const rowKey = (provider, event) => provider === 'claude' && event.parentSessionId ?
  'claude/' + event.parentSessionId + '/' + event.sessionId : provider + '/' + event.sessionId;
function validKey(key, provider) {
  if (typeof key !== 'string') return false;
  const [owner, ...ids] = key.split('/');
  return owner === provider && (ids.length === 1 || (ids.length === 2 && provider === 'claude')) && ids.every(safeId);
}

// Pretty-printed tool input with bidi controls made visible, or nothing when it is too large to show.
function escapeBidi(text) {
  return text.replace(/[\u202a-\u202e\u2066-\u2069]/gu, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
}

function describe(input) {
  let text;
  try { text = JSON.stringify(input, null, 2); } catch { return; }
  if (typeof text !== 'string') return;
  text = escapeBidi(text);
  return Buffer.byteLength(text) <= DETAIL_LIMIT ? text : undefined;
}

function sliceUtf8(text, maxBytes) {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let lo = 0, hi = Math.min(text.length, maxBytes);
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    let end = mid;
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
    if (Buffer.byteLength(text.slice(0, end)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  let end = lo;
  if (end > 0) {
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
  }
  return text.slice(0, end);
}

// Bounded read-only preview for oversized tool inputs (> DETAIL_LIMIT). Preserves key
// identifying fields first, truncates large bodies without splitting surrogate pairs,
// and attaches `_truncated: { totalBytes, shownBytes }`. Never used for inline approvals.
function describePreview(input) {
  let full;
  try { full = JSON.stringify(input, null, 2); } catch { return; }
  if (typeof full !== 'string') return;
  const escaped = escapeBidi(full);
  const totalBytes = Buffer.byteLength(escaped);
  if (totalBytes <= DETAIL_LIMIT) return escaped;
  const serialize = obj => escapeBidi(JSON.stringify(obj, null, 2));
  const finalize = obj => {
    let shownBytes = 0;
    let out = '';
    for (let i = 0; i < 3; i++) {
      obj._truncated = { totalBytes, shownBytes };
      out = serialize(obj);
      const next = Buffer.byteLength(out);
      if (next === shownBytes) break;
      shownBytes = next;
    }
    return Buffer.byteLength(out) <= DETAIL_LIMIT ? out : undefined;
  };
  if (!isObject(input)) {
    const summary = typeof input === 'string' ? sliceUtf8(input, 4000) + '…' : sliceUtf8(full, 4000) + '…';
    return finalize({ value: summary });
  }
  const preview = {};
  const keys = [
    ...PREVIEW_PRIORITY_KEYS.filter(key => Object.hasOwn(input, key)),
    ...Object.keys(input).filter(key => !PREVIEW_PRIORITY_KEYS.includes(key) && key !== '_truncated'),
  ].slice(0, 24);
  const reserve = 128;
  const fits = candidate => Buffer.byteLength(serialize({ ...candidate, _truncated: { totalBytes, shownBytes: DETAIL_LIMIT } })) <= DETAIL_LIMIT - reserve;
  const summarizeValue = (value, maxFieldBytes) => {
    if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') {
      if (Buffer.byteLength(value) <= maxFieldBytes) return value;
      return sliceUtf8(value, Math.max(16, maxFieldBytes - 3)) + '…';
    }
    try {
      const encoded = JSON.stringify(value);
      if (typeof encoded === 'string' && Buffer.byteLength(encoded) <= maxFieldBytes) return value;
      if (typeof encoded === 'string') return sliceUtf8(encoded, Math.max(16, maxFieldBytes - 3)) + '…';
    } catch { /* Fall through. */ }
    return Array.isArray(value) ? '[Array(' + value.length + ')]' : '[Object]';
  };
  for (const key of keys) {
    const isPriority = PREVIEW_PRIORITY_KEYS.includes(key);
    const budget = isPriority ? 2000 : 1200;
    const candidate = { ...preview, [key]: summarizeValue(input[key], budget) };
    if (fits(candidate)) { preview[key] = candidate[key]; continue; }
    if (isPriority) {
      const tighter = { ...preview, [key]: summarizeValue(input[key], 256) };
      if (fits(tighter)) preview[key] = tighter[key];
    }
  }
  return finalize(preview);
}

// Claude's input names the offered answers `options`; the request on the wire, `choices`.
// Answers are keyed by question text, so every question must be distinct.
function questionList(list, field) {
  if (!Array.isArray(list) || list.length < 1 || list.length > 4) return;
  const questions = [], texts = new Set();
  for (const item of list) {
    if (!isObject(item) || typeof item.question !== 'string' || !item.question.trim() || texts.has(item.question) ||
        (item.header != null && typeof item.header !== 'string') ||
        (item.multiSelect != null && typeof item.multiSelect !== 'boolean')) return;
    const options = item[field];
    if (!Array.isArray(options) || options.length < 2 || options.length > 6) return;
    const labels = new Set(), choices = [];
    for (const option of options) {
      if (!isObject(option) || typeof option.label !== 'string' || !option.label.trim() || labels.has(option.label) ||
          (option.description != null && typeof option.description !== 'string')) return;
      labels.add(option.label);
      choices.push({ label: option.label, description: option.description || '' });
    }
    texts.add(item.question);
    questions.push({ question: item.question, header: item.header || '', multiSelect: item.multiSelect === true, choices });
  }
  return questions;
}

// One array of offered indices per question: exactly one for a single choice,
// one or more distinct ones where the question allows several.
function validAnswers(questions, answers) {
  return Array.isArray(questions) && Array.isArray(answers) && answers.length === questions.length &&
    answers.every((picked, at) => {
      const question = questions[at];
      return isObject(question) && Array.isArray(question.choices) && Array.isArray(picked) && picked.length >= 1 &&
        (question.multiSelect === true || picked.length === 1) && new Set(picked).size === picked.length &&
        picked.every(choice => Number.isInteger(choice) && choice >= 0 && choice < question.choices.length);
    });
}

function requestFor(provider, event, payload) {
  // Codex may route its permission requests to a configured reviewer. Its native
  // chat owns that flow. Only Claude's documented human callback is handled here.
  if (provider !== 'claude' || event !== 'PermissionRequest' || payload?.agent_id ||
      !safeId(payload?.session_id) || payload.hook_event_name !== event || !validCwd(payload.cwd) ||
      !safeId(payload.tool_name) || !isObject(payload.tool_input)) return;
  if (payload.tool_name === 'ExitPlanMode' || payload.tool_name === 'EnterPlanMode') return;
  const detail = describe(payload.tool_input);
  if (!detail) return;
  const request = { version: PROTOCOL, key: 'claude/' + payload.session_id, provider: 'claude', tool: payload.tool_name,
    cwd: payload.cwd, detail, kind: 'approval' };
  if (request.tool === 'AskUserQuestion') {
    const questions = questionList(payload.tool_input.questions, 'options');
    const prior = payload.tool_input.answers;
    if (!questions || (prior != null && (typeof prior !== 'object' || Object.keys(prior).length))) return;
    Object.assign(request, { kind: 'question', questions });
  }
  return request;
}

function hookResponse(request, payload, choice) {
  if (!isObject(request) || !isObject(choice)) return;
  let decision;
  if (request.kind === 'question' && choice.action === 'answer' && validAnswers(request.questions, choice.answers) &&
      isObject(payload?.tool_input)) {
    // The Agent SDK's form: each key is the question text, each value the chosen
    // label; several labels are joined with ", ". The questions pass through unchanged.
    const answers = Object.fromEntries(request.questions.map((question, at) => [question.question,
      [...choice.answers[at]].sort((a, b) => a - b).map(index => question.choices[index].label).join(', ')]));
    decision = { behavior: 'allow', updatedInput: { ...payload.tool_input, answers } };
  } else if (request.kind === 'approval' && ['approve', 'deny'].includes(choice.action)) {
    decision = { behavior: choice.action === 'approve' ? 'allow' : 'deny' };
  }
  if (decision) return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
}

// What a waiting row may show when the request is not answered here. `event` is
// the hook's normalized wait; the key is the one the monitor derives in toSession.
function noticeFor(provider, payload, event) {
  if (!PROVIDERS.includes(provider) || !isObject(payload) || !isObject(event) ||
      (event.action !== 'wait' && event.action !== 'soft_wait') ||
      !safeId(event.sessionId) || !validCwd(event.cwd) || !validRef(event.key) ||
      (event.parentSessionId !== undefined && !safeId(event.parentSessionId))) return;
  const tool = provider === 'agy' ? payload.toolCall?.name : payload.tool_name;
  const input = provider === 'agy' ? payload.toolCall?.args : payload.tool_input;
  if (!safeId(tool) || input == null) return;
  const detail = describePreview(input);
  if (!detail) return;
  return { version: PROTOCOL, key: rowKey(provider, event), provider, tool, cwd: event.cwd, detail, ref: event.key };
}

// What a hook event says about its session's row, display-only; see activity.cjs.
function activityNotice(provider, name, payload, event, options) {
  if (!PROVIDERS.includes(provider) || !isObject(event) || !safeId(event.sessionId) || !validCwd(event.cwd) ||
      (event.parentSessionId !== undefined && !safeId(event.parentSessionId))) return;
  const toolCwd = validCwd(event.toolCwd) ? event.toolCwd : event.cwd;
  const turn = safeId(event.turn) ? event.turn : undefined;
  let update;
  try { update = content().activityFor(provider, name, payload, toolCwd, options); } catch { return; }
  return update && { version: PROTOCOL, key: rowKey(provider, event), provider, cwd: event.cwd, ...(turn && { turn }), ...update };
}

function acceptedRequest(req, workspace) {
  if (!isObject(req) || req.version !== PROTOCOL || req.provider !== 'claude' || req.cwd !== workspace ||
      typeof req.key !== 'string' || !req.key.startsWith('claude/') || !safeId(req.key.slice(7)) || !safeId(req.tool) ||
      typeof req.detail !== 'string' || Buffer.byteLength(req.detail) > DETAIL_LIMIT || !validRef(req.ref) ||
      !Number.isSafeInteger(req.window) || req.window < MIN_WINDOW || req.window > MAX_WINDOW) return;
  const action = { kind: req.kind, key: req.key, provider: 'claude', tool: req.tool, cwd: req.cwd, detail: req.detail,
    ref: req.ref, window: req.window };
  if (req.kind === 'approval') return req.questions === undefined ? action : undefined;
  if (req.kind !== 'question') return;
  const questions = questionList(req.questions, 'choices');
  return questions && { ...action, questions };
}

function acceptedNotice(notice, workspace) {
  if (!isObject(notice) || notice.version !== PROTOCOL || !PROVIDERS.includes(notice.provider) || notice.cwd !== workspace ||
      !safeId(notice.tool) || typeof notice.detail !== 'string' || Buffer.byteLength(notice.detail) > DETAIL_LIMIT ||
      !validRef(notice.ref) || !validKey(notice.key, notice.provider)) return;
  return { key: notice.key, tool: notice.tool, detail: notice.detail, cwd: notice.cwd, ref: notice.ref };
}

function acceptedActivityNotice(notice, workspace) {
  if (!isObject(notice) || notice.version !== PROTOCOL || !PROVIDERS.includes(notice.provider) || notice.cwd !== workspace ||
      !validKey(notice.key, notice.provider)) return;
  if (notice.turn !== undefined && !safeId(notice.turn)) return;
  const update = content().acceptedActivity(notice);
  return update && { key: notice.key, update };
}

// Bounded, in-memory content for waiting rows. The newest entry for the session
// wins, restricted to requests that are still outstanding when those are known.
function createPreviews({ limit = PREVIEW_LIMIT, ttl = PREVIEW_MS, now = Date.now } = {}) {
  // Kept oldest first, so expired entries are a prefix: a read drops them without copying the rest.
  let items = [];
  const expire = () => {
    const time = now();
    let stale = 0;
    while (stale < items.length && time - items[stale].at >= ttl) stale++;
    if (stale) items = items.slice(stale);
  };
  return {
    remember({ key, ref, tool, detail, cwd }) {
      expire();
      items = items.filter(item => item.key !== key || item.ref !== ref);
      items.push({ key, ref, tool, detail, cwd, at: now() });
      if (items.length > limit) items = items.slice(-limit);
    },
    get(key, refs) {
      expire();
      const open = Array.isArray(refs) && refs.length ? new Set(refs) : undefined;
      const time = now();
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i];
        if (item.key === key && (!open || open.has(item.ref)) && time - item.at < ttl) return { tool: item.tool, detail: item.detail };
      }
    },
    // An entry newer than the scan that judged it may describe a wait that scan has not read yet.
    prune(keep, since) {
      expire();
      items = items.filter(item => item.at >= since || keep(item.key, item.ref));
    },
  };
}

const encode = (...parts) => Buffer.from(JSON.stringify(parts));
function signature(privateKey, ...parts) {
  return crypto.sign(null, encode(...parts), privateKey).toString('base64');
}
function verified(publicKey, sig, ...parts) {
  return typeof sig === 'string' && crypto.verify(null, encode(...parts), publicKey, Buffer.from(sig, 'base64'));
}
function send(socket, message) { socket.write(JSON.stringify(message) + '\n'); }
function reader(socket, fn) {
  // Bound even unterminated frames; a connection carries at most two small frames.
  let bytes = 0;
  socket.on('data', data => { bytes += data.length; if (bytes > LIMIT) socket.destroy(); });
  // readline repeats a socket's error (a missing or refused socket, a reset) on itself;
  // unheard, that would end a hook with an exception or reach the extension host.
  lines().createInterface({ input: socket, crlfDelay: Infinity }).on('error', () => socket.destroy()).on('line', line => {
    try {
      if (bytes > LIMIT || !line || socket.destroyed) return socket.destroy();
      fn(JSON.parse(line));
    } catch { socket.destroy(); }
  });
}

function containsPath(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

function ownedSocketDir(address) {
  if (typeof address !== 'string' || !path.isAbsolute(address) || path.basename(address) !== 'ui.sock') return;
  const parent = path.dirname(address);
  if (!/^asm-ui-/.test(path.basename(parent))) return;
  const root = path.resolve(path.dirname(parent));
  const allowedRoots = new Set([path.resolve(os.tmpdir()), '/tmp', '/private/tmp']);
  return allowedRoots.has(root) ? parent : undefined;
}

async function listen(stateDir, { canAccept, canNotice = () => false, canActivity = () => false, changed,
  activityChanged = changed, windowMs = () => WINDOW_MS, wantsActivity = () => false,
  workspaceRootFor = () => '', windowMeta = () => ({}) }) {
  const pending = new Map();
  const peers = new Set();
  const previews = createPreviews();
  const activity = content().createActivity();
  const keys = crypto.generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({type:'spki',format:'pem'});
  const registry = directoryFor(stateDir);
  await fs.mkdir(registry, {recursive: true, mode: 0o700});
  const tmpBase = os.tmpdir();
  // macOS/Linux sun_path is capped at 104/108 bytes; fall back to /tmp if tmpdir is long.
  const socketBase = process.platform !== 'win32' &&
    Buffer.byteLength(path.join(tmpBase, 'asm-ui-XXXXXX', 'ui.sock')) > 95 ? '/tmp' : tmpBase;
  const folder = await fs.mkdtemp(path.join(socketBase, 'asm-ui-'));
  const address = path.join(folder, 'ui.sock');
  const descriptor = path.join(registry, uuid() + '.json');
  let disposed = false, writes = Promise.resolve();
  const currentWindow = () => { try { return clampWindow(windowMs()); } catch { return WINDOW_MS; } };
  const advertised = () => { try { return wantsActivity() === true; } catch { return false; } };
  const sanitizedMeta = () => {
    try {
      const meta = windowMeta();
      if (!isObject(meta)) return {};
      const out = {};
      if (Array.isArray(meta.workspaceFolders)) {
        const folders = [...new Set(meta.workspaceFolders.filter(validCwd).map(entry => path.resolve(entry)))].slice(0, 32);
        if (folders.length) out.workspaceFolders = folders;
      }
      if (typeof meta.windowUri === 'string' && meta.windowUri.length > 0 && meta.windowUri.length <= 2048 &&
          !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(meta.windowUri)) {
        out.windowUri = meta.windowUri;
      }
      return out;
    } catch { return {}; }
  };
  const contents = () => JSON.stringify({
    address, pid: process.pid, publicKey, windowMs: currentWindow(), activity: advertised(), ...sanitizedMeta(),
  });
  const allowed = { request: cwd => canAccept(cwd, 'claude'), notice: canNotice, activity: canActivity };
  const server = net.createServer(socket => {
    peers.add(socket);
    let challenge, token, workspace, purpose;
    let timer = setTimeout(() => socket.destroy(), SETUP_MS);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => {
      peers.delete(socket); clearTimeout(timer);
      const item = pending.get(token);
      if (!item) return;
      // Expired, handed back or disconnected: the row still shows what was asked.
      pending.delete(token);
      previews.remember(item.action);
      changed();
    });
    reader(socket, packet => {
      if (!challenge) {
        if (!validToken(packet?.nonce) || !validCwd(packet.cwd)) return socket.destroy();
        purpose = ['notice', 'activity'].includes(packet.purpose) ? packet.purpose : 'request';
        if (!allowed[purpose](packet.cwd)) return socket.end();
        workspace = packet.cwd;
        challenge = packet.nonce;
        send(socket, { proof: signature(keys.privateKey, 'hello', challenge) });
        return;
      }
      if (purpose === 'notice') {
        const notice = acceptedNotice(packet?.notice, workspace);
        if (notice && canNotice(workspace)) { previews.remember(notice); changed(); }
        return socket.end();
      }
      if (purpose === 'activity') {
        const notice = acceptedActivityNotice(packet?.activity, workspace);
        let displayRoot = '';
        try {
          const root = workspaceRootFor(workspace);
          if (validCwd(root)) displayRoot = path.resolve(root);
        } catch { /* Fall back to notice workspace. */ }
        if (notice && canActivity(workspace) && activity.record(notice.key, notice.update, workspace, displayRoot)) activityChanged();
        return socket.end();
      }
      if (token || pending.size >= 16) return socket.destroy();
      const req = acceptedRequest(packet?.request, workspace);
      if (!req || !canAccept(workspace, 'claude', req)) return socket.destroy();
      // Ambiguous provider input (same tool correlation in two concurrent calls)
      // must be handled by the originating conversation for both requests.
      const duplicate = [...pending.values()].find(item => item.action.key === req.key && item.action.ref === req.ref);
      if (duplicate) {
        duplicate.socket.destroy();
        socket.destroy(); return;
      }
      token = uuid();
      const acceptedAt = Date.now();
      // The hook waits exactly req.window after this acceptance; the server keeps
      // the socket only a little longer in case the hook process stalls.
      const action = { ...req, token, allow: req.kind === 'approval', deny: req.kind === 'approval', expiresAt: acceptedAt + req.window };
      pending.set(token, { action, socket, challenge, acceptedAt });
      clearTimeout(timer);
      timer = setTimeout(() => socket.destroy(), req.window + 1500);
      send(socket, { accepted: true });
      changed();
    });
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(address, resolve); });
    server.on('error', () => {});
    await fs.writeFile(descriptor, contents(), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    server.close(); await fs.rm(folder, {recursive:true,force:true}); throw error;
  }
  // A window that crashed left its descriptor behind; every hook would read it again.
  void forgetDeparted(registry).catch(() => {});
  const deferAll = () => { for (const peer of peers) peer.destroy(); };
  return {
    forSession(key) {
      const list = [...pending.values()].filter(item => item.action.key === key);
      const first = list.find(item => item.action.kind === 'question') || list[0];
      return first && { ...first.action, pendingCount:list.length };
    },
    previewFor(key, refs) { return previews.get(key, refs); },
    prunePreviews(keep, since) { previews.prune(keep, since); },
    activityFor(key) { return activity.get(key); },
    resolveFilePath(key, file) { return activity.resolveFile(key, file); },
    pruneActivity(keep, since) { activity.prune(keep, since); },
    forgetActivity(keys) {
      const gone = new Set(keys);
      activity.prune(key => !gone.has(key), Infinity);
    },
    clearActivity() { activity.clear(); },
    decide(key, token, choice) {
      const item = pending.get(token);
      if (!item || item.action.key !== key || item.socket.destroyed || !canAccept(item.action.cwd, 'claude')) return false;
      const action = choice?.action;
      let decision;
      if (action === 'defer' || (item.action.allow && ['approve', 'deny'].includes(action))) decision = { action };
      else if (item.action.kind === 'question' && action === 'answer' && validAnswers(item.action.questions, choice.answers)) {
        decision = { action, answers: choice.answers.map(picked => [...picked]) };
      }
      if (!decision) return false;
      pending.delete(token);
      if (action === 'defer') previews.remember(item.action);
      send(item.socket, {decision, proof: signature(keys.privateKey, 'decision', item.challenge, decision)});
      item.socket.end(); changed();
      return true;
    },
    // Hooks read the inline window and whether activity is wanted from the descriptor; replace it atomically.
    updateWindow() {
      writes = writes.then(async () => {
        if (disposed) return;
        const temp = descriptor + '.' + uuid() + '.tmp';
        try {
          await fs.writeFile(temp, contents(), { flag: 'wx', mode: 0o600 });
          await fs.rename(temp, descriptor);
          if (disposed) await fs.unlink(descriptor).catch(() => {});
        } finally { await fs.rm(temp, {force:true}).catch(() => {}); }
      }).catch(() => {});
      return writes;
    },
    deferAll,
    deferSession(key) {
      for (const item of pending.values()) if (item.action.key === key) item.socket.destroy();
    },
    deferUnshown(shownKeys, since) {
      let dropped = false;
      for (const [key, item] of [...pending.entries()]) {
        if (item.acceptedAt < since && !shownKeys.has(item.action.key)) {
          pending.delete(key);
          previews.remember(item.action);
          item.socket.destroy();
          dropped = true;
        }
      }
      if (dropped) changed();
    },
    dispose() {
      disposed = true;
      deferAll(); server.close(); activity.clear(); void fs.unlink(descriptor).catch(() => {});
      void fs.rm(folder, {recursive:true,force:true}).catch(() => {});
    },
  };
}

// Only a descriptor whose process no longer exists is removed; one that cannot be read is left alone.
async function forgetDeparted(registry) {
  const uid = process.getuid?.();
  for (const entry of await fs.readdir(registry, {withFileTypes:true})) {
    if (!entry.isFile() || !/^[a-f\d-]{36}\.json$/.test(entry.name)) continue;
    const file = path.join(registry, entry.name);
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.uid !== uid || stat.size > DESCRIPTOR_LIMIT) continue;
      const { pid, address } = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) continue;
      try { process.kill(pid, 0); } catch (error) {
        if (error.code === 'ESRCH') {
          await fs.unlink(file);
          const socketDir = ownedSocketDir(address);
          if (socketDir) {
            const dirStat = await fs.lstat(socketDir).catch(() => undefined);
            if (dirStat?.isDirectory() && dirStat.uid === uid) {
              await fs.rm(socketDir, { recursive: true, force: true }).catch(() => {});
            }
          }
        }
      }
    } catch { /* Another window may be replacing or removing it. */ }
  }
}

// Discovery shared by requests and notices: live windows owned by this user.
async function windows(stateDir) {
  const dir = directoryFor(stateDir);
  const uid = process.getuid?.();
  const parent = await fs.lstat(dir).catch(() => undefined);
  if (!parent?.isDirectory() || parent.uid !== uid || (parent.mode & 0o077)) return [];
  const found = [];
  for (const entry of await fs.readdir(dir, {withFileTypes:true}).catch(() => [])) {
    if (!entry.isFile() || !/^[a-f\d-]{36}\.json$/.test(entry.name)) continue;
    try {
      const file = path.join(dir, entry.name);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o077) || stat.size > DESCRIPTOR_LIMIT) continue;
      const descriptor = JSON.parse(await fs.readFile(file,'utf8'));
      if (!isObject(descriptor) || typeof descriptor.address !== 'string' || !path.isAbsolute(descriptor.address) ||
          typeof descriptor.publicKey !== 'string' || !Number.isSafeInteger(descriptor.pid) || descriptor.pid <= 0) continue;
      process.kill(descriptor.pid, 0);
      found.push(descriptor);
    } catch { /* A window may close or disappear between discovery and connection. */ }
  }
  return found;
}

// Only an editor's own app link may focus a window; anything else in a descriptor is ignored.
const WINDOW_URI_SCHEMES = new Set(['vscode:', 'vscode-insiders:', 'cursor:', 'antigravity:', 'vscodium:']);
function windowUriOf(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(value)) return;
  try {
    const parsed = new URL(value);
    return WINDOW_URI_SCHEMES.has(parsed.protocol) && parsed.host ? value : undefined;
  } catch { return; }
}

// Locate a live window whose advertised workspaceFolders contains `cwd` (respecting directory boundaries).
// A window that can be focused by its link wins over one that cannot; among equals, the most specific root.
async function findWindowForFolder(stateDir, cwd) {
  if (!validCwd(cwd)) return;
  const target = path.resolve(cwd);
  const targetReal = await fs.realpath(target).catch(() => '');
  let best;
  for (const descriptor of await windows(stateDir)) {
    if (!Array.isArray(descriptor.workspaceFolders)) continue;
    const windowUri = windowUriOf(descriptor.windowUri);
    for (const folder of descriptor.workspaceFolders) {
      if (!validCwd(folder)) continue;
      const root = path.resolve(folder);
      let matched = containsPath(root, target);
      if (!matched && targetReal) {
        const rootReal = await fs.realpath(root).catch(() => '');
        if (rootReal) matched = containsPath(rootReal, targetReal);
      }
      if (!matched) continue;
      const better = !best || (Boolean(windowUri) !== Boolean(best.windowUri) ? Boolean(windowUri)
        : root.length > best.workspaceRoot.length);
      if (better) best = { windowUri, workspaceRoot: root };
    }
  }
  return best;
}

function contact(descriptor, request) {
  return new Promise(resolve => {
    const socket = net.createConnection(descriptor.address);
    const nonce = uuid();
    let authenticated = false, accepted = false, choice;
    let timer = setTimeout(() => socket.destroy(), HANDSHAKE_MS);
    socket.once('connect', () => send(socket, { nonce, cwd: request.cwd }));
    socket.on('error', () => socket.destroy());
    socket.once('close', () => { clearTimeout(timer); resolve({ accepted, choice }); });
    reader(socket, packet => {
      if (!authenticated) {
        if (!verified(descriptor.publicKey, packet?.proof, 'hello', nonce)) return socket.destroy();
        authenticated = true; send(socket, { request }); return;
      }
      if (!accepted && packet?.accepted === true) {
        accepted = true; clearTimeout(timer); timer = setTimeout(() => socket.destroy(), clampWindow(request.window));
        return;
      }
      if (accepted && isObject(packet?.decision) && verified(descriptor.publicKey, packet.proof, 'decision', nonce, packet.decision)) {
        choice = packet.decision;
      }
      socket.destroy();
    });
  });
}

// The first window that shows the request owns it until a decision, a handoff or
// its window (read from that window's descriptor) runs out.
async function ask(stateDir, request) {
  if (!request) return { accepted: false };
  for (const descriptor of await windows(stateDir)) {
    try {
      const reply = await contact(descriptor, { ...request, window: clampWindow(descriptor.windowMs) });
      if (reply.accepted) return reply;
    } catch { /* A window may close or disappear between discovery and connection. */ }
  }
  return { accepted: false };
}

// Display-only and fire-and-forget: after a window proves its identity it receives one
// line and nothing is awaited from it. Windows are contacted in parallel and each
// connection is cut after `ms`. A preview waits for the window to close the connection;
// activity, sent on every tool call, closes it as soon as the line is written.
function deliver(descriptor, hello, message, ms, linger) {
  return new Promise(resolve => {
    let socket;
    try { socket = net.createConnection(descriptor.address); } catch { return resolve(false); }
    const nonce = uuid();
    let sent = false;
    const timer = setTimeout(() => socket.destroy(), ms);
    socket.once('connect', () => send(socket, { nonce, ...hello }));
    socket.on('error', () => socket.destroy());
    socket.once('close', () => { clearTimeout(timer); resolve(sent); });
    reader(socket, packet => {
      if (sent || !verified(descriptor.publicKey, packet?.proof, 'hello', nonce)) return socket.destroy();
      sent = true;
      socket.end(JSON.stringify(message) + '\n', linger ? undefined : () => socket.destroy());
    });
  });
}

// A stalled window delays a notifying hook by at most a few hundred milliseconds.
async function announce(stateDir, notice) {
  if (!notice) return;
  const targets = await windows(stateDir);
  await Promise.all(targets.map(descriptor => deliver(descriptor, { cwd: notice.cwd, purpose: 'notice' }, { notice }, NOTICE_MS, true)));
}

// Windows that asked for activity in their descriptor. A hook that finds none connects to nothing.
async function activityWindows(stateDir) {
  return (await windows(stateDir)).filter(descriptor => descriptor.activity === true);
}

async function reportActivity(targets, notice) {
  if (!notice || !Array.isArray(targets)) return;
  await Promise.all(targets.map(descriptor =>
    deliver(descriptor, { cwd: notice.cwd, purpose: 'activity' }, { activity: notice }, ACTIVITY_MS, false)));
}

module.exports = { requestFor, hookResponse, noticeFor, activityNotice, describePreview, listen, ask, announce,
  activityWindows, reportActivity, findWindowForFolder, forgetDeparted, createPreviews, clampWindow, PROTOCOL };
