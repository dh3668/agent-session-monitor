'use strict';
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { PROVIDERS, STATES } = require('./model.cjs');
const { validModel, validEffort, ERROR_REASONS } = require('./hook.cjs');
const { resolveWebviewLogos } = require('./logos.cjs');
const { fileTargetOf, requestFilePaths } = require('../media/format.js');

const PANEL_SCRIPTS = Object.freeze(['format.js', 'panel-core.js', 'panel-cards.js', 'panel-views.js', 'panel.js']);
const LENS_MODES = new Set(['all', 'attention', 'working']);
const UNSET = Symbol('unset');
const text = value => typeof value === 'string' ? value : '';
const sortModes = new Set(['priority', 'recent', 'attention', 'manual']);
const count = (value, fallback = 0) => Number.isSafeInteger(value) && value >= 0 ? value : fallback;
const timestamp = value => Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000 ? value : undefined;
const limited = (value, max) => text(value).slice(0, max);
const connectionStates = new Set(['connected', 'untrusted', 'unverified', 'update', 'missing', 'muted', 'absent']);

// A question request is shown only when every question can be answered here.
function questionsView(action) {
  const list = Array.isArray(action.questions) ? action.questions :
    text(action.question) ? [{ question: action.question, choices: action.choices }] : [];
  if (!list.length || list.length > 4) return;
  const questions = [];
  for (const item of list) {
    const choices = Array.isArray(item?.choices) ? item.choices : [];
    if (!text(item?.question).trim() || !choices.length || choices.length > 6 ||
        choices.some(choice => !text(choice?.label).trim())) return;
    questions.push({ question: item.question, header: limited(item.header, 40), multiSelect: item.multiSelect === true,
      choices: choices.map(choice => ({ label: choice.label, description: text(choice.description) })) });
  }
  return questions;
}

const PLAN_STATUSES = new Set(['completed', 'in_progress', 'pending', 'skipped', 'failed']);

function stepView(value) {
  const tool = limited(value?.tool, 80).trim(), target = limited(value?.target, 200).trim();
  if (!tool && !target) return;
  return { tool, target, ...(timestamp(value.at) && { at: value.at }), ...(value?.failed === true && { failed: true }) };
}

function planView(list) {
  if (!Array.isArray(list) || !list.length) return;
  const items = [];
  for (const entry of list.slice(0, 12)) {
    const label = limited(entry?.text, 120).trim();
    if (!label || !PLAN_STATUSES.has(entry?.status)) continue;
    items.push({ text: label, status: entry.status });
  }
  return items.length ? items : undefined;
}

function changedFilesView(list) {
  if (!Array.isArray(list) || !list.length) return;
  const files = [];
  const seen = new Set();
  for (const item of list.slice(0, 16)) {
    if (typeof item !== 'string') continue;
    const clean = item.trim();
    if (!clean || clean.length > 200 || /[\0-\x1f\x7f]/.test(clean) || seen.has(clean)) continue;
    seen.add(clean);
    files.push(clean);
  }
  return files.length ? files : undefined;
}

function elsewhereView(list) {
  const result = [];
  for (const item of Array.isArray(list) ? list.slice(0, 8) : []) {
    const cwd = text(item?.cwd);
    const input = count(item?.input), approval = count(item?.approval);
    if (!path.isAbsolute(cwd) || /[\0-\x1f\x7f]/.test(cwd) || !(input + approval)) continue;
    result.push({ cwd, folder: limited(item.folder, 80) || path.basename(cwd), input, approval });
  }
  return result;
}

function quotaView(entry) {
  if (!entry || !['ready', 'loading', 'stale', 'unavailable'].includes(entry.status))
    return { status: 'unavailable', windows: [] };
  const windows = [];
  for (const window of Array.isArray(entry.windows) ? entry.windows : []) {
    if (!window || !text(window.label).trim() || !['used', 'remaining'].includes(window.kind) ||
        !Number.isFinite(window.percent) || window.percent < 0 || window.percent > 100) continue;
    windows.push({ label: window.label, kind: window.kind, percent: window.percent, resetsAt: timestamp(window.resetsAt) });
  }
  const status = !windows.length && (entry.status === 'ready' || entry.status === 'stale') ? 'unavailable' : entry.status;
  return { status, windows: status === 'unavailable' ? [] : windows, updatedAt: timestamp(entry.updatedAt),
    plan: text(entry.plan), message: text(entry.message) };
}

function normalizePreferences(value) {
  const preferences = value || {};
  const order = Array.isArray(preferences.providerOrder) ? preferences.providerOrder : [];
  const known = id => typeof id === 'string' && Object.hasOwn(PROVIDERS, id);
  const providerOrder = [...new Set([...order.filter(known), ...Object.keys(PROVIDERS)])];
  return { sort: sortModes.has(preferences.sort) ? preferences.sort : 'priority', providerOrder,
    attentionOnly: preferences.attentionOnly === true, hideCompleted: preferences.hideCompleted === true };
}

const isViewSession = session => Boolean(session) && Object.hasOwn(PROVIDERS, session.provider) &&
  Object.hasOwn(STATES, session.status) && typeof session.key === 'string' && session.key.startsWith(session.provider + '/');
const isWaiting = status => status === 'input' || status === 'approval';
const isQuiet = session => (session.status === 'working' || isWaiting(session.status)) && session.quiet === true;

// The request a row may answer here, or nothing. `row` carries the already projected
// status, subagent and quiet flags.
function requestView(session, row = { status: session.status, isSubagent: Boolean(session.isSubagent), quiet: isQuiet(session) }) {
  const { action } = session;
  const { status } = row;
  if (row.isSubagent || row.quiet || !action || !text(action.token) || !((status === 'approval' && action.kind === 'approval') ||
      (status === 'input' && action.kind === 'question'))) return;
  const request = { kind: action.kind, token: action.token, tool: text(action.tool), detail: text(action.detail),
    cwd: text(action.cwd), pendingCount: Number(action.pendingCount || session.pendingCount || 1) };
  if (timestamp(action.expiresAt)) request.expiresAt = action.expiresAt;
  if (action.kind === 'approval') {
    request.allow = action.allow === true;
    request.deny = action.deny === true;
    return request;
  }
  request.questions = questionsView(action);
  return request.questions ? request : undefined;
}

// What the badge and title line need, read straight from the incoming state with the
// same rules as viewState, so a hidden view never builds or serialises the full list.
function badgeSummary(state) {
  const description = text(state.workspaceLabel) || undefined;
  let attention = count(state.attentionCount, -1), unread = count(state.unreadCount, -1);
  if (attention < 0 || unread < 0) {
    let attentionRows = 0, unreadRows = 0;
    for (const session of state.sessions || []) {
      if (!isViewSession(session)) continue;
      const errorAcked = session.status === 'error' && session.errorAcked === true;
      if (STATES[session.status].group === 'attention' && !errorAcked && !isQuiet(session)) attentionRows++;
      if (session.status === 'done' && session.replyUnread === true && timestamp(session.replyAt)) unreadRows++;
    }
    if (attention < 0) attention = attentionRows;
    if (unread < 0) unread = unreadRows;
  }
  return { description, value: attention + unread };
}

function viewState(state) {
  const usage = {}, quotas = {};
  for (const id of Object.keys(PROVIDERS)) {
    usage[id] = text(state.usage?.[id]);
    quotas[id] = quotaView(state.quotas?.[id]);
  }
  const sessions = [];
  for (const session of state.sessions || []) {
    if (!isViewSession(session)) continue;
    const { provider, key, status } = session;
    const row = { provider, key, status, title: text(session.title), project: path.basename(text(session.cwd)),
      updatedAt: Number.isSafeInteger(session.updatedAt) ? session.updatedAt : 0, usage: text(session.usage) };
    const waiting = status === 'input' || status === 'approval';
    if (waiting && timestamp(session.waitSince)) row.waitSince = session.waitSince;
    if (status === 'working' && timestamp(session.workSince)) row.workSince = session.workSince;
    // No hook signal for a while (working turn or abandoned/rejected wait).
    if ((status === 'working' || waiting) && session.quiet === true) {
      row.quiet = true;
      if (timestamp(session.signalAt)) row.signalAt = session.signalAt;
    }
    if (status === 'error') {
      if (typeof session.errorReason === 'string' && ERROR_REASONS.has(session.errorReason)) row.errorReason = session.errorReason;
      if (session.errorAcked === true) row.errorAcked = true;
    }
    if (session.interrupted === true) row.interrupted = true;
    if (session.execution) {
      const info = session.execution;
      const execution = {};
      for (const [field, valid] of [['model', validModel], ['effort', validEffort]]) {
        if (!valid(info[field])) continue;
        execution[field] = info[field];
        if (['call','setting','response','request'].includes(info[field + 'Source'])) execution[field + 'Source'] = info[field + 'Source'];
        if (timestamp(info[field + 'At'])) execution[field + 'At'] = info[field + 'At'];
      }
      if (execution.model || execution.effort) row.execution = execution;
    }
    if (session.replyUnread === true && timestamp(session.replyAt)) {
      row.replyUnread = true;
      row.replyAt = session.replyAt;
    }
    if (session.pinned === true && !session.isSubagent) row.pinned = true;
    if (session.isSubagent) {
      row.isSubagent = true;
      row.canOpen = session.canOpen !== false;
      if (typeof session.parentKey === 'string' && session.parentKey.startsWith(provider + '/') &&
          session.parentKey !== key) row.parentKey = session.parentKey;
    }
    const request = requestView(session, row);
    if (request) row.action = request;
    // What the session is doing, in its own words: the latest step, the request
    // it is working on, the last reply, recent steps and plan progress.
    const activity = stepView(session.activity);
    if (activity) row.activity = activity;
    if (text(session.focus).trim()) row.focus = limited(session.focus.trim(), 160);
    if (text(session.prompt).trim()) row.prompt = limited(session.prompt.trim(), 300);
    if (text(session.reply).trim()) row.reply = limited(session.reply.trim(), 400);
    const steps = (Array.isArray(session.steps) ? session.steps.slice(0, 8) : []).map(stepView).filter(Boolean);
    if (steps.length) row.steps = steps;
    const total = session.progress?.total, finished = session.progress?.done;
    if (Number.isSafeInteger(total) && total > 0 && total <= 500 && Number.isSafeInteger(finished) && finished >= 0 && finished <= total) {
      row.progress = { done: finished, total };
    }
    const plan = planView(session.plan);
    if (plan) row.plan = plan;
    if (Number.isSafeInteger(session.changed) && session.changed > 0) row.changed = Math.min(session.changed, 999);
    const changedFiles = changedFilesView(session.changedFiles);
    if (changedFiles) row.changedFiles = changedFiles;
    // Display-only content for a request that its own chat has to answer.
    if (!row.action && waiting && !row.quiet && session.preview && (text(session.preview.tool) || text(session.preview.detail))) {
      const preview = { tool: limited(session.preview.tool, 160), detail: limited(session.preview.detail, 12000) };
      if (text(session.preview.cwd)) preview.cwd = text(session.preview.cwd);
      row.preview = preview;
    }
    sessions.push(row);
  }
  const rows = new Map(sessions.map(row => [row.key, row]));
  const source = new Map((state.sessions || []).filter(Boolean).map(row => [row.key, row]));
  for (const row of sessions) {
    const target = rows.get(source.get(row.key)?.priorityTargetKey);
    if (target && target.provider === row.provider && target !== row &&
        ((['input','approval'].includes(target.status) && !target.quiet) || (target.status === 'error' && !target.errorAcked) || target.replyUnread)) {
      const visited = new Set();
      let parent = target;
      while (parent && !visited.has(parent) && parent !== row) {
        visited.add(parent);
        parent = rows.get(parent.parentKey);
      }
      if (parent === row) row.priorityTargetKey = target.key;
    }
    if (row.isSubagent && row.canOpen === false) {
      const visited = new Set([row.key]);
      let parent = rows.get(row.parentKey);
      while (parent && parent.isSubagent && !visited.has(parent.key)) {
        visited.add(parent.key);
        parent = rows.get(parent.parentKey);
      }
      if (parent && !parent.isSubagent && parent.provider === row.provider) row.viaParent = true;
    }
  }
  const attention = sessions.filter(row => STATES[row.status].group === 'attention' && !row.errorAcked && !row.quiet).length;
  const connections = {};
  for (const id of Object.keys(PROVIDERS)) {
    connections[id] = connectionStates.has(state.connections?.[id]) ? state.connections[id] : 'unknown';
  }
  const codexLiveDetection = ['available', 'unavailable'].includes(state.codexLiveDetection) ? state.codexLiveDetection : 'unknown';
  return {
    sessions, usage, quotas, connections, codexLiveDetection, elsewhere: elsewhereView(state.elsewhere), workspaceLabel: text(state.workspaceLabel), hasWorkspace: state.hasWorkspace === true,
    isRemoteWorkspace: state.isRemoteWorkspace === true, scanError: limited(state.scanError, 200).trim(),
    preferences: normalizePreferences(state.preferences),
    hiddenCompleted: count(state.hiddenCompleted), attentionCount: count(state.attentionCount, attention),
    unreadCount: count(state.unreadCount, sessions.filter(row => row.replyUnread && row.status === 'done').length),
  };
}

function validateAction(message, state, now = Date.now()) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return;
  const { action, provider, key, token, value, direction } = message;
  if (action === 'refresh' || action === 'newSession') return { action };
  if (action === 'setSort') return sortModes.has(value) ? { action, value } : undefined;
  if (action === 'setHideCompleted' || action === 'setAttentionOnly') {
    return typeof value === 'boolean' ? { action, value } : undefined;
  }
  if (action === 'markAllSeen') return state.unreadCount > 0 ? { action } : undefined;
  if (action === 'openFolder') {
    return state.elsewhere.some(item => item.cwd === message.cwd) ? { action, cwd: message.cwd } : undefined;
  }
  if (typeof provider !== 'string' || !Object.hasOwn(PROVIDERS, provider)) return;
  if (action === 'moveProvider') return ['up', 'down'].includes(direction) ? { action, provider, direction } : undefined;
  if (action === 'start' || action === 'connect' || action === 'usage' || action === 'refreshQuota') return { action, provider };
  if (action === 'trustGuide') return provider === 'codex' && ['untrusted', 'unverified'].includes(state.connections[provider]) ? { action, provider } : undefined;
  if (action === 'hideConnect') return state.connections[provider] === 'missing' ? { action, provider } : undefined;
  const row = state.sessions.find(session => session.key === key && session.provider === provider);
  if (!row) return;
  if (action === 'setPinned') return !row.isSubagent && typeof value === 'boolean' ? { action, provider, key, value } : undefined;
  if (action === 'markSeen') {
    return row.replyUnread && row.replyAt && row.replyAt === message.replyAt
      ? { action, provider, key, replyAt: row.replyAt } : undefined;
  }
  if (action === 'ackError') {
    return row.status === 'error' && !row.errorAcked && row.updatedAt && row.updatedAt === message.updatedAt
      ? { action, provider, key, updatedAt: row.updatedAt } : undefined;
  }
  if (action === 'dismissChildren') {
    const byKey = new Map(state.sessions.map(session => [session.key, session]));
    const isDescendant = candidate => {
      const seen = new Set([candidate.key]);
      let cursor = candidate;
      while (cursor?.isSubagent && cursor.parentKey && !seen.has(cursor.parentKey)) {
        if (cursor.parentKey === key) return true;
        seen.add(cursor.parentKey);
        cursor = byKey.get(cursor.parentKey);
        if (cursor?.provider !== provider) return false;
      }
      return false;
    };
    const hasSettledChild = state.sessions.some(candidate =>
      candidate.isSubagent && candidate.provider === provider && isDescendant(candidate) &&
      (!['working', 'input', 'approval'].includes(candidate.status) || candidate.quiet === true) &&
      !(candidate.status === 'error' && !candidate.errorAcked));
    return hasSettledChild ? { action, provider, key } : undefined;
  }
  if (action === 'openFile') {
    const file = message.file;
    if (typeof file !== 'string' || !file || file.length > 4096 || /[\0-\x1f\x7f]/.test(file)) return;
    const allowed = new Set([
      ...(row.changedFiles || []),
      ...(row.steps || []).map(fileTargetOf).filter(Boolean),
      ...requestFilePaths(row.action?.detail, row.action?.tool),
      ...requestFilePaths(row.preview?.detail, row.preview?.tool),
    ]);
    return allowed.has(file) ? { action, provider, key, file } : undefined;
  }
  const canNavigate = row.canOpen !== false || row.viaParent === true;
  if ((action === 'open' && canNavigate) || action === 'rename' ||
      (action === 'dismiss' && (!['working', 'input', 'approval'].includes(row.status) || row.quiet === true)) ||
      (action === 'review' && canNavigate && ['input', 'approval'].includes(row.status))) return { action, provider, key };
  const request = row.action;
  if (!request || typeof token !== 'string' || request.token !== token) return;
  if (action === 'defer') return { action, provider, key, token };
  // Past its window the request belongs to the official chat again; nothing here may still decide it.
  if (request.expiresAt && now >= request.expiresAt) return;
  if (request.kind === 'approval' && ((action === 'approve' && request.allow) || (action === 'deny' && request.deny))) {
    return { action, provider, key, token };
  }
  const answers = message.answers;
  if (action === 'answer' && request.kind === 'question' && Array.isArray(answers) &&
      answers.length === request.questions.length && answers.every((picked, at) => {
        const question = request.questions[at];
        return Array.isArray(picked) && picked.length >= 1 && (question.multiSelect || picked.length === 1) &&
          new Set(picked).size === picked.length &&
          picked.every(choice => Number.isInteger(choice) && choice >= 0 && choice < question.choices.length);
      })) return { action, provider, key, token, answers: answers.map(picked => [...picked]) };
}

function escapeAttribute(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function defaultFilter() {
  return { lens: 'all', providerFilter: 'all', hasSearch: false };
}

function parseFilter(message, fallback) {
  const lens = LENS_MODES.has(message?.lens) ? message.lens : fallback.lens;
  const providerFilter = message?.providerFilter === 'all' ||
    (typeof message?.providerFilter === 'string' && Object.hasOwn(PROVIDERS, message.providerFilter))
    ? message.providerFilter : fallback.providerFilter;
  const hasSearch = typeof message?.hasSearch === 'boolean' ? message.hasSearch : fallback.hasSearch;
  return { lens, providerFilter, hasSearch };
}

function sameFilter(a, b) {
  return a.lens === b.lens && a.providerFilter === b.providerFilter && a.hasSearch === b.hasSearch;
}

function createPanel(vscode, extensionUri, onAction, onVisibilityChange = () => {}, onFilterChange = () => {}) {
  let active, listener, disposeListener, visibilityListener, ready = false, quotaOverview = false, openRequest = '', openRequestKey = '', openRequestVisible = false;
  let filter = defaultFilter(), pendingReveal;
  let lastSentSig, lastLogoSig = '', lastDescription = UNSET, lastBadgeValue = UNSET;
  // Keybindings for "allow/deny the open request" are enabled only while one is on screen.
  function announce(kind, key = '', visible = true) {
    const next = ['approval', 'question', 'preview'].includes(kind) && panel.canHandleRequests() ? kind : '';
    openRequestKey = next && typeof key === 'string' ? key : '';
    openRequestVisible = Boolean(next && visible !== false);
    if (next === openRequest) return;
    openRequest = next;
    void vscode.commands?.executeCommand?.('setContext', 'agentSessionMonitor.openRequest', next);
  }
  // The incoming state is kept as given; its view projection is built only when something
  // reads it (a visible view, an action to validate, a request to reveal), once per change.
  let raw = {}, rawSig, built = viewState({}), stale = false;
  // `rev` counts distinct states sent to the view; `revSig` names the content it stands for.
  let rev = 0, revSig;
  const current = () => {
    if (stale) { built = viewState(raw); stale = false; }
    return built;
  };
  function send(force = false) {
    if (!panel.isVisible()) return;
    const state = current();
    const sig = rawSig ?? JSON.stringify(state);
    if (!force && sig === lastSentSig) return;
    lastSentSig = sig;
    if (sig !== revSig) { rev++; revSig = sig; }
    void active.webview.postMessage({ type: 'state', rev, ...state });
  }
  function logoSignature(marks) {
    return JSON.stringify(marks.map(({ id, ink, uris, fallbackUri, isFallback }) => [
      id, Boolean(ink), uris, fallbackUri, Boolean(isFallback),
    ]));
  }
  function applyHtml(view, resolved, sig) {
    const web = view.webview;
    const media = vscode.Uri.joinPath(extensionUri, 'media');
    web.options = { enableScripts: true, localResourceRoots: resolved.localResourceRoots };
    const nonce = randomBytes(20).toString('hex');
    const resource = name => escapeAttribute(web.asWebviewUri(vscode.Uri.joinPath(media, name)).toString());
    const source = escapeAttribute(web.cspSource);
    const images = resolved.marks.map(({ id, ink, uris: [first, second], fallbackUri, isFallback }) => {
      const fallback = second || (!isFallback ? fallbackUri : undefined);
      return '<img data-logo="' + id + '"' + (ink ? ' data-ink' : '') + (isFallback ? ' data-bundled' : '') + ' src="' + escapeAttribute(first) + '"' +
        (fallback ? ' data-fallback="' + escapeAttribute(fallback) + '"' : '') + ' alt="">';
    }).join('');
    const scripts = PANEL_SCRIPTS.map(name => `<script nonce="${nonce}" src="${resource(name)}"></script>`).join('');
    lastLogoSig = sig;
    web.html = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${source}; style-src ${source}; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none';">
<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${resource('panel.css')}"><title>에이전트 세션 모니터</title></head>
<body><template id="logos">${images}</template><main id="sessions" aria-label="에이전트별 세션"></main>${scripts}</body></html>`;
  }
  function cleanup() {
    const hadView = Boolean(active);
    listener?.dispose(); disposeListener?.dispose(); visibilityListener?.dispose();
    listener = undefined; disposeListener = undefined; visibilityListener = undefined;
    active = undefined; ready = false; quotaOverview = false;
    lastSentSig = undefined; lastLogoSig = ''; lastDescription = UNSET; lastBadgeValue = UNSET;
    filter = defaultFilter();
    announce('', '');
    if (hadView) onVisibilityChange(false);
  }
  const panel = {
    resolveWebviewView(view) {
      cleanup();
      active = view;
      const web = view.webview;
      const resolved = resolveWebviewLogos(vscode, extensionUri, web);
      listener = web.onDidReceiveMessage(message => {
        if (message?.type === 'ready') {
          ready = true;
          quotaOverview = message.view === 'quotas';
          const prevFilter = filter;
          filter = parseFilter(message, defaultFilter());
          onVisibilityChange(panel.isVisible());
          if (!sameFilter(prevFilter, filter)) onFilterChange({ ...filter });
          lastSentSig = undefined;
          send(true);
          if (pendingReveal && Date.now() <= pendingReveal.expiresAt) {
            const key = pendingReveal.key;
            pendingReveal = undefined;
            void active?.webview.postMessage({ type: 'revealSession', key });
          } else {
            pendingReveal = undefined;
          }
          return;
        }
        if (!panel.isVisible()) return;
        if (message?.type === 'view' && ['quotas', 'sessions'].includes(message.view)) {
          quotaOverview = message.view === 'quotas';
          if (quotaOverview) announce('', '');
          onVisibilityChange(true);
          return;
        }
        if (message?.type === 'filter') {
          const prevFilter = filter;
          filter = parseFilter(message, filter);
          if (!sameFilter(prevFilter, filter)) {
            if (openRequestKey) {
              const openProvider = openRequestKey.split('/')[0];
              if (!panel.canHandleRequests(openProvider)) announce('', '');
            }
            onFilterChange({ ...filter });
          }
          return;
        }
        if (message?.type === 'request') { announce(message.kind, message.key, message.visible); return; }
        const valid = validateAction(message, current());
        if (valid && (!quotaOverview || valid.action === 'refreshQuota' || valid.action === 'usage')) return onAction(valid);
      });
      disposeListener = view.onDidDispose(cleanup);
      visibilityListener = view.onDidChangeVisibility(() => {
        ready = false;
        lastSentSig = undefined;
        announce('', '');
        onVisibilityChange(false);
        if (view.visible) void web.postMessage({ type: 'probe' });
      });
      applyHtml(view, resolved, logoSignature(resolved.marks));
      panel.applyBadge();
    },
    // Re-resolve vendor logos when workspace trust is granted or extensions are installed/updated,
    // reloading the webview HTML only when the resolved local resource URIs actually change.
    refreshLogos() {
      if (!active) return false;
      const resolved = resolveWebviewLogos(vscode, extensionUri, active.webview);
      const sig = logoSignature(resolved.marks);
      if (sig === lastLogoSig) return false;
      const wasVisible = panel.isVisible();
      ready = false;
      lastSentSig = undefined;
      announce('', '');
      if (wasVisible) onVisibilityChange(false);
      applyHtml(active, resolved, sig);
      return true;
    },
    isVisible() { return Boolean(active?.visible && ready); },
    canHandleRequests(provider) {
      if (!panel.isVisible() || quotaOverview) return false;
      if (provider === undefined) return true;
      if (typeof provider !== 'string' || !Object.hasOwn(PROVIDERS, provider)) return false;
      return filter.lens !== 'working' &&
        (filter.providerFilter === 'all' || filter.providerFilter === provider);
    },
    isShowingRequest(key) {
      return Boolean(panel.canHandleRequests() && openRequest && openRequestVisible && typeof key === 'string' && key && openRequestKey === key);
    },
    shownActionKeys() {
      if (!stale) return new Set(built.sessions.filter(row => row.action).map(row => row.key));
      // Hidden: the same answer from the incoming rows, without projecting the whole list.
      const keys = new Set();
      for (const session of raw.sessions || []) if (isViewSession(session) && requestView(session)) keys.add(session.key);
      return keys;
    },
    async revealRequest(key) {
      if (!panel.canHandleRequests()) return false;
      const row = current().sessions.find(item => item.key === key);
      if (!row?.action) return false;
      try {
        return await active.webview.postMessage({ type: 'revealRequest', key, token: row.action.token }) === true;
      } catch { return false; }
    },
    async revealSession(key, { queue = false } = {}) {
      if (typeof key !== 'string' || !key) return false;
      if (!panel.isVisible()) {
        if (queue) {
          // Remember briefly so clicking a macOS notification while the sidebar was
          // hidden still reveals the exact session once the webview reports ready.
          pendingReveal = { key, expiresAt: Date.now() + 5000 };
          return true;
        }
        return false;
      }
      pendingReveal = undefined;
      try {
        return await active.webview.postMessage({ type: 'revealSession', key }) === true;
      } catch { return false; }
    },
    // Ask the view to act on the request it is showing, as if its button were pressed.
    // The view decides: it knows what is on screen and for how long.
    async decideOpen(action) {
      if (!['approve', 'deny'].includes(action) || !panel.canHandleRequests() || !openRequest) return false;
      try { return await active.webview.postMessage({ type: 'decide', action }) === true; } catch { return false; }
    },
    // `signature`, when the caller already serialised `next` to detect a change, stands in
    // for serialising its projection again; equal input always projects to equal output.
    setState(next, signature) {
      raw = next || {};
      rawSig = typeof signature === 'string' ? signature : undefined;
      stale = true;
      panel.applyBadge();
      send();
    },
    // The badge counts what wants the user; the title line names the folder the list is for.
    applyBadge() {
      if (!active) return;
      const { description, value } = stale ? badgeSummary(raw)
        : { description: built.workspaceLabel || undefined, value: built.attentionCount + built.unreadCount };
      if (description !== lastDescription) {
        lastDescription = description;
        active.description = description;
      }
      if (value !== lastBadgeValue) {
        lastBadgeValue = value;
        active.badge = value ? { value, tooltip: '확인할 세션 ' + value + '개' } : undefined;
      }
    },
    dispose: cleanup,
  };
  return panel;
}
module.exports = { createPanel, viewState, validateAction, normalizePreferences, PANEL_SCRIPTS };
