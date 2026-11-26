'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
const { isDeepStrictEqual } = require('node:util');

const EVENT_NAMES = {
  claude: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PermissionDenied', 'Notification',
    'PostToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure', 'SessionEnd', 'SubagentStart', 'SubagentStop', 'PostModelSwitch'],
  codex: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse',
    'Stop', 'Interrupt', 'SessionEnd', 'SubagentStart', 'SubagentStop'],
  agy: ['SessionStart', 'PreInvocation', 'PreToolUse', 'PostToolUse', 'Stop'],
};

const digest = value => createHash('sha256').update(value).digest('hex');
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(value);
const validCwd = value => typeof value === 'string' && value.length <= 4096 &&
  path.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value);
const validModel = value => typeof value === 'string' && value.length <= 128 && /^[a-zA-Z0-9][a-zA-Z0-9._:/+@-]*(?:\[1[mM]\])?$/.test(value) &&
  !['auto', 'default', 'inherit', 'unknown'].includes(value.toLowerCase());
const validEffort = value => ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(value);
const ERROR_REASONS = new Set([
  'rate_limit', 'billing_error', 'authentication_failed',
  'max_output_tokens', 'server_error', 'invalid_request', 'max_steps_exceeded',
]);
const SESSION_SOURCES = new Set(['startup', 'resume', 'clear', 'compact', 'fork']);
const AGY_NORMAL_STOP = new Set(['model_stop', 'NO_TOOL_CALL', 'TERMINAL_STEP_TYPE', 'INJECTED_RESPONSE']);
const AGY_STEP_LIMIT_STOP = new Set(['max_steps_exceeded', 'MAX_INVOCATIONS', 'MAX_FORCED_INVOCATIONS']);
const AGY_TOKEN_LIMIT_STOP = new Set(['MAX_TOKEN_BUDGET_EXCEEDED']);
const AGY_ERROR_STOP = new Set(['error', 'ERROR']);
const AGY_CANCEL_STOP = new Set(['USER_CANCELED', 'cancelled', 'canceled']);

// Classify a failure into a fixed allowlisted category so disk snapshots never carry raw error text.
function errorReasonFor(provider, name, payload) {
  if (name === 'StopFailure') {
    if (typeof payload.error === 'string') {
      if (ERROR_REASONS.has(payload.error)) return payload.error;
      if (payload.error === 'oauth_org_not_allowed') return 'authentication_failed';
      if (payload.error === 'account_on_hold') return 'billing_error';
    }
    const hint = [payload.error, payload.error_details, payload.last_assistant_message]
      .filter(value => typeof value === 'string').join(' ').slice(0, 1024);
    if (/\b(?:rate[_ -]?limit|usage[_ -]?limit|too many requests|429)\b|hit your limit|사용량|한도/i.test(hint)) return 'rate_limit';
    if (/\b(?:billing|credit balance|payment|quota exceeded)\b/i.test(hint)) return 'billing_error';
    if (/\b(?:authentication|unauthorized|invalid[_ ]api[_ ]key|401)\b/i.test(hint)) return 'authentication_failed';
    if (/\bmax[_ ]?output[_ ]?tokens\b/i.test(hint)) return 'max_output_tokens';
    if (/\b(?:overloaded|overloaded_error|529|500|502|503|service unavailable|internal server error)\b/i.test(hint)) return 'server_error';
    if (/\b(?:prompt is too long|context length|too many tokens)\b/i.test(hint)) return 'invalid_request';
    return;
  }
  if (provider === 'agy' && name === 'Stop') {
    if (AGY_STEP_LIMIT_STOP.has(payload.terminationReason)) return 'max_steps_exceeded';
    if (AGY_TOKEN_LIMIT_STOP.has(payload.terminationReason)) return 'max_output_tokens';
    if (typeof payload.error === 'string' && payload.error.trim()) {
      const hint = payload.error.slice(0, 1024);
      if (/\b(?:rate[_ -]?limit|usage[_ -]?limit|resource[_ ]?exhausted|too many requests|429)\b|quota/i.test(hint)) return 'rate_limit';
      if (/\b(?:authentication|unauthorized|unauthenticated|401)\b/i.test(hint)) return 'authentication_failed';
      if (/\b(?:billing|payment)\b/i.test(hint)) return 'billing_error';
    }
  }
}

function hookExecution(provider, name, payload) {
  const execution = {};
  if (provider === 'agy' && name === 'PreInvocation' && validModel(payload.modelName)) {
    execution.model = payload.modelName;
    execution.modelSource = 'call';
    const variant = /^gemini-\d[\w.-]*-(minimal|low|medium|high|xhigh|max|ultra)$/i.exec(payload.modelName);
    if (variant) Object.assign(execution, {effort: variant[1].toLowerCase(), effortSource: 'call'});
  }
  if (provider === 'codex' || (provider === 'claude' && ['SessionStart', 'PostModelSwitch', 'SubagentStart'].includes(name))) {
    const model = name === 'PostModelSwitch' ? payload.to_model : payload.model;
    if (validModel(model)) Object.assign(execution, {model, modelSource: 'setting'});
  }
  if (provider === 'claude') {
    const rawEffort = typeof payload.effort === 'string' ? payload.effort : payload.effort?.level;
    const effort = typeof rawEffort === 'string' ? rawEffort.toLowerCase() : undefined;
    if (validEffort(effort)) Object.assign(execution, {effort, effortSource: 'setting'});
  }
  if (provider === 'codex') {
    const rawEffort = payload.reasoning_effort ?? payload.effort?.level ?? payload.effort;
    const effort = typeof rawEffort === 'string' ? rawEffort.toLowerCase() : undefined;
    if (validEffort(effort)) Object.assign(execution, {effort, effortSource: 'setting'});
  }
  return Object.keys(execution).length ? execution : undefined;
}

// Keep multi-root hooks within the snapshot reader's 64 KiB limit even for
// long Unicode paths. Optional hook events can omit the list entirely.
function localWorkspacePaths(input) {
  if (!Array.isArray(input)) return;
  const paths = new Set();
  let bytes = 0;
  for (const candidate of input) {
    if (!validCwd(candidate)) continue;
    const folder = path.resolve(candidate);
    if (paths.has(folder)) continue;
    const size = Buffer.byteLength(JSON.stringify(folder));
    if (bytes + size > 16000) continue;
    paths.add(folder);
    bytes += size;
    if (paths.size === 32) break;
  }
  return [...paths];
}

// PermissionRequest does not carry tool_use_id. Correlate the request and its result
// without persisting any arguments. Bash may add a description only to the request.
function canonicalJson(value) {
  return JSON.stringify(value, (_, entry) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
}

const SHELL_TOOLS = new Set(['Bash', 'exec_command', 'shell_command', 'shell', 'local_shell', 'unified_exec']);
const PATCH_TARGET_LINE_RE = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to):\s*(.+)$/gm;
const AGY_WRITE_TOOLS = new Set(['write_file', 'write_to_file', 'edit_file', 'replace_file_content', 'multi_replace_file_content']);
const AGY_READ_TOOLS = new Set(['read_file', 'view_file']);
const AGY_SOFT_WAIT_TOOLS = new Set(['run_command', 'read_url_content', ...AGY_WRITE_TOOLS, ...AGY_READ_TOOLS]);
const AGY_TURBO_PRESET = 'AGENT_PERMISSION_PRESET_TURBO';
const AGY_REVIEW_PRESET = 'AGENT_PERMISSION_PRESET_REQUEST_REVIEW';
const SOFT_WAIT_LIMIT = 16;
const isStringArray = value => Array.isArray(value) && value.every(part => typeof part === 'string');

function shellCommandText(command) {
  if (typeof command === 'string') return command.trim();
  if (!isStringArray(command)) return '';
  if (command.length === 3 && /^(?:\/(?:usr\/)?(?:local\/)?bin\/)?(?:z|ba|da|a)?sh$/.test(command[0]) &&
      /^-l?c$/.test(command[1])) return command[2].trim();
  return command.map(arg => /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : "'" + arg.replaceAll("'", "'\\''") + "'").join(' ');
}

function normalizeTargetPath(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return '';
  let normalized = path.resolve(rawPath.trim());
  if (normalized === '/private/var' || normalized.startsWith('/private/var/')) normalized = normalized.slice('/private'.length);
  else if (normalized === '/private/tmp' || normalized.startsWith('/private/tmp/')) normalized = normalized.slice('/private'.length);
  return normalized;
}

// Compute an opaque target hash for Codex PermissionRequest items so declined patches
// or commands can be matched against official runtime completion records without
// ever persisting file paths, commands, or diffs to disk snapshots.
function pendingTargetFor(provider, tool, payload, cwd) {
  if (provider !== 'codex' || !tool) return;
  const args = payload?.tool_input;
  if (tool === 'apply_patch') {
    const body = typeof args === 'string' ? args :
      (args && typeof args === 'object' ? (args.command ?? args.patch ?? args.input) : '');
    if (typeof body !== 'string' || !body.trim()) return;
    const hasCwd = validCwd(cwd);
    const canonical = new Set();
    for (const [, raw] of body.matchAll(PATCH_TARGET_LINE_RE)) {
      const trimmed = raw.trim();
      if (!trimmed || trimmed.length > 4096 || trimmed.includes('\0')) continue;
      if (!hasCwd && !path.isAbsolute(trimmed)) continue;
      const resolved = hasCwd ? path.resolve(cwd, trimmed) : path.resolve(trimmed);
      const norm = normalizeTargetPath(resolved);
      if (norm) canonical.add(norm);
    }
    if (!canonical.size) return;
    return 'fc:' + digest(JSON.stringify([...canonical].sort()));
  }
  if (SHELL_TOOLS.has(tool)) {
    const command = typeof args?.command === 'string' || isStringArray(args?.command) ? args.command : args?.cmd ?? args;
    const trimmed = shellCommandText(command);
    if (!trimmed) return;
    return 'cmd:' + digest(trimmed);
  }
}

function toolKey(sessionId, payload, tool) {
  if (!tool) return 'generic';
  const call = payload.toolCall;
  if (call && Number.isSafeInteger(payload.stepIdx)) return digest(sessionId + ':step:' + payload.stepIdx);
  if (call && typeof call.id === 'string' && call.id) return digest(sessionId + ':call:' + call.id);
  const args = call?.args ?? payload.tool_input;
  let signature = null;
  if (typeof args === 'string') {
    signature = args;
  } else if (args && typeof args === 'object') {
    if (SHELL_TOOLS.has(tool) && (typeof args.command === 'string' || typeof args.cmd === 'string' ||
        isStringArray(args.command) || isStringArray(args.cmd))) {
      signature = (typeof args.command === 'string' || isStringArray(args.command)) ? args.command : args.cmd;
    } else if (tool === 'apply_patch' && (typeof args.command === 'string' || typeof args.patch === 'string' || typeof args.input === 'string')) {
      signature = args.command ?? args.patch ?? args.input;
    } else if (tool === 'write_stdin') {
      signature = JSON.stringify([args.session_id ?? null, args.chars ?? args.input ?? '']);
    } else if (tool === 'request_permissions') {
      signature = JSON.stringify([args.reason ?? '', args.permissions ?? null]);
    } else if (tool === 'ExitPlanMode' && (typeof args.plan === 'string' || typeof args.planFilePath === 'string')) {
      signature = canonicalJson([args.plan ?? '', args.planFilePath ?? '']);
    } else if (['AskUserQuestion', 'request_user_input', 'ask_question'].includes(tool) && Array.isArray(args.questions)) {
      signature = canonicalJson(args.questions);
    } else signature = canonicalJson(args);
  }
  return digest(JSON.stringify([sessionId, tool, signature]));
}

function codexCallRef(payload) {
  const id = [payload.tool_use_id, payload.call_id, payload.item_id].find(value =>
    typeof value === 'string' && value.length > 0 && value.length <= 512);
  return id && digest(id);
}

function underDir(candidate, folder) {
  const rel = path.relative(folder, candidate);
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

function expandMacVar(dir) {
  if (dir.startsWith('/var/')) return [dir, '/private' + dir];
  if (dir.startsWith('/private/var/')) return [dir, dir.slice('/private'.length)];
  return [dir];
}

// Antigravity has no PermissionRequest hook; PreToolUse fires before its internal
// permission policy runs. Tools that may open an approval dialog register a delayed
// soft wait that promotes only if PostToolUse has not fired within the tool's normal
// synchronous window. Never fires under Turbo mode.
function agySoftWait(tool, args, roots, { agyPreset = '', homeDir = os.homedir(), tmpDir = os.tmpdir() } = {}) {
  if (agyPreset === AGY_TURBO_PRESET || !args || typeof args !== 'object' || Array.isArray(args)) return;
  if (tool === 'run_command') {
    if (typeof args.CommandLine !== 'string' || !args.CommandLine.trim()) return;
    const bypass = args.BypassSandbox === true || args.bypassSandbox === true;
    const review = agyPreset === AGY_REVIEW_PRESET;
    const rawWait = Number(args.WaitMsBeforeAsync ?? args.waitMsBeforeAsync);
    const hasWait = Number.isFinite(rawWait) && rawWait > 0;
    if (bypass || review) {
      const base = hasWait ? Math.min(45000, Math.max(3000, Math.round(rawWait))) : 10000;
      return { status: 'approval', delayMs: base + 6000 };
    }
    if (hasWait) {
      const base = Math.min(45000, Math.max(5000, Math.round(rawWait)));
      return { status: 'approval', delayMs: base + 8000 };
    }
    return;
  }
  if (AGY_WRITE_TOOLS.has(tool) || AGY_READ_TOOLS.has(tool)) {
    if (agyPreset === AGY_REVIEW_PRESET && AGY_WRITE_TOOLS.has(tool)) {
      return { status: 'approval', delayMs: 4000 };
    }
    const rawPath = [args.Path, args.TargetFile, args.AbsolutePath, args.file_path, args.path].find(validCwd);
    if (!rawPath || !Array.isArray(roots) || !roots.length) return;
    const resolved = path.resolve(rawPath);
    const safeDirs = [...roots, '/tmp', '/private/tmp', path.resolve(tmpDir), path.join(path.resolve(homeDir), '.gemini')]
      .flatMap(expandMacVar);
    if (safeDirs.some(dir => underDir(resolved, dir))) return;
    return { status: 'approval', delayMs: 4000 };
  }
  if (tool === 'read_url_content') {
    if ((typeof args.Url === 'string' && args.Url.trim()) || (typeof args.url === 'string' && args.url.trim())) {
      return { status: 'approval', delayMs: 12000 };
    }
  }
}

async function readAgyPermissionPreset(homeDir = os.homedir()) {
  try {
    const file = path.join(homeDir, '.gemini', 'config', 'config.json');
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > 64 * 1024) return '';
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    const preset = parsed?.userSettings?.permissionPreset ?? parsed?.permissionPreset;
    return typeof preset === 'string' ? preset : '';
  } catch {
    return '';
  }
}

function normalize(provider, name, payload, options = {}) {
  if (!Object.hasOwn(EVENT_NAMES, provider) || !EVENT_NAMES[provider].includes(name)) return;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
  const reported = payload.hook_event_name ?? payload.hookEventName;
  if (reported != null && reported !== name) return;
  const rootId = provider === 'agy' ? payload.conversationId : payload.session_id;
  if (!validId(rootId)) return;
  const lifecycle = name === 'SubagentStart' || name === 'SubagentStop';
  const child = lifecycle || payload.agent_id != null;
  if (child && (!validId(payload.agent_id) || payload.agent_id === rootId || provider === 'agy')) return;
  if (child && !lifecycle && !['UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PermissionDenied', 'Notification', 'PostToolUse', 'PostToolUseFailure'].includes(name) && !(provider === 'codex' && name === 'Interrupt')) return;
  const sessionId = child ? payload.agent_id : rootId;
  const roots = provider === 'agy' ? localWorkspacePaths(payload.workspacePaths) : undefined;
  const payloadCwd = validCwd(payload.cwd) ? path.resolve(payload.cwd) : '';
  const cwdInRoots = payloadCwd && roots?.some(root => underDir(payloadCwd, root));
  const claudeRoot = provider === 'claude' && validCwd(process.env.CLAUDE_PROJECT_DIR) ? path.resolve(process.env.CLAUDE_PROJECT_DIR) : '';
  const pinnedClaudeRoot = claudeRoot && payloadCwd && underDir(payloadCwd, claudeRoot) ? claudeRoot : '';
  const cwd = pinnedClaudeRoot || ((cwdInRoots ? payloadCwd : roots?.[0]) ?? (validCwd(payload.cwd) ? payload.cwd : ''));
  const toolCwd = pinnedClaudeRoot && payloadCwd !== pinnedClaudeRoot ? payloadCwd : '';
  const turn = child ? '' : (payload.turn_id ?? payload.prompt_id);
  const event = { provider, sessionId, cwd, ...(toolCwd && { toolCwd }), turn: validId(turn) ? turn : '' };
  const execution = hookExecution(provider, name, payload);
  if (execution) event.execution = execution;
  if (roots) event.workspacePaths = roots.length || !cwd ? roots : [cwd];
  if (child) {
    const clean = value => typeof value === 'string'
      ? value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, '').trim().slice(0, 100) : '';
    const agentName = clean(payload.agent_name);
    const rawTypeCandidate = clean(payload.agent_type);
    const rawType = provider === 'codex' && rawTypeCandidate.toLowerCase() === 'default' ? '' : rawTypeCandidate;
    const agentType = agentName && rawType && agentName.toLowerCase() !== rawType.toLowerCase()
      ? (agentName + ' · ' + rawType).slice(0, 100) : (agentName || rawType);
    Object.assign(event, {parentSessionId: rootId, agentType});
    if (lifecycle) return name === 'SubagentStart' ? { ...event, action: 'begin' } :
      { ...event, action: 'end', status: 'done', completed: true };
  }
  const tool = provider === 'agy' ? payload.toolCall?.name : payload.tool_name;
  const question = (provider === 'agy' && tool === 'ask_question') ||
    (provider === 'claude' && tool === 'AskUserQuestion') ||
    (provider === 'codex' && tool === 'request_user_input');
  const explicitApproval = (provider === 'agy' && tool === 'ask_permission') ||
    (provider === 'codex' && tool === 'request_permissions') ||
    (provider === 'claude' && tool === 'ExitPlanMode');
  const agyNotifyBlocked = provider === 'agy' && tool === 'notify_user' && payload.toolCall?.args?.BlockedOnUser === true;
  switch (name) {
    case 'SessionStart': {
      const source = typeof payload.source === 'string' && SESSION_SOURCES.has(payload.source) ? payload.source : undefined;
      return { ...event, action: 'init', ...(source && { source }) };
    }
    case 'PostModelSwitch':
      return execution && { ...event, action: 'metadata' };
    case 'UserPromptSubmit':
      return { ...event, action: 'begin' };
    case 'PreInvocation':
      return { ...event, action: 'invoke', ...(payload.invocationNum === 1 && { firstInvocation: true }) };
    case 'PreToolUse': {
      if (question || agyNotifyBlocked || explicitApproval) {
        return { ...event, action: 'wait', status: question || agyNotifyBlocked ? 'input' : 'approval', key: toolKey(sessionId, payload, tool) };
      }
      if (provider === 'agy' && AGY_SOFT_WAIT_TOOLS.has(tool)) {
        const softRoots = event.workspacePaths ?? (event.cwd ? [event.cwd] : undefined);
        const soft = agySoftWait(tool, payload.toolCall?.args, softRoots, options);
        const stepIdx = Number.isSafeInteger(payload.stepIdx) && payload.stepIdx >= 0 ? payload.stepIdx : undefined;
        if (soft) return { ...event, action: 'soft_wait', status: soft.status, delayMs: soft.delayMs, key: toolKey(sessionId, payload, tool), ...(stepIdx !== undefined && { stepIdx }) };
      }
      return;
    }
    case 'PermissionRequest': {
      const target = pendingTargetFor(provider, tool, payload, event.toolCwd || event.cwd);
      const argsRef = toolKey(sessionId, payload, tool);
      if (target) {
        const callRef = codexCallRef(payload);
        // Some Codex builds omit the call ID. Two identical requests can still
        // be in flight (or retried), so each such wait needs its own occurrence.
        return { ...event, action: 'wait', status: 'approval', key: callRef || digest(randomUUID()),
          target, argsRef, ...(callRef && { callRef }) };
      }
      return { ...event, action: 'wait', status: question ? 'input' : 'approval', key: argsRef };
    }
    case 'PermissionDenied':
    case 'PostToolUse':
      // Most tools complete without opening a dialog; only hash a result's input
      // if there is a specific outstanding request to match when we hold the lock.
      return { ...event, action: 'resolve', resolveKey: () => toolKey(sessionId, payload, tool),
        ...(provider === 'codex' && { callRef: codexCallRef(payload) }) };
    case 'PostToolUseFailure':
      if (payload.is_interrupt === true) return { ...event, action: 'end', status: 'idle', interrupted: true };
      return { ...event, action: 'resolve', resolveKey: () => toolKey(sessionId, payload, tool) };
    case 'Notification':
      switch (payload.notification_type) {
        case 'permission_prompt':
          return { ...event, action: 'wait', status: 'approval', key: 'generic' };
        case 'elicitation_dialog':
        case 'elicitation_url_dialog':
        case 'agent_needs_input':
          return { ...event, action: 'wait', status: 'input', key: 'elicitation' };
        case 'elicitation_response':
        case 'elicitation_complete':
          return { ...event, action: 'resolve', key: 'elicitation' };
      }
      return;
    case 'SessionEnd':
      return { ...event, action: 'end', status: 'idle', sessionEnd: true };
    case 'Interrupt':
      return { ...event, action: 'end', status: 'idle', interrupted: true };
    case 'StopFailure': {
      const errorReason = errorReasonFor(provider, name, payload);
      return { ...event, action: 'end', status: 'error', ...(errorReason && { errorReason }) };
    }
    case 'Stop': {
      let status = 'done';
      if (provider === 'agy') {
        const hasError = typeof payload.error === 'string' ? /\S/.test(payload.error) : Boolean(payload.error);
        const reason = payload.terminationReason;
        if (hasError || AGY_ERROR_STOP.has(reason) || AGY_STEP_LIMIT_STOP.has(reason) || AGY_TOKEN_LIMIT_STOP.has(reason)) status = 'error';
        else if (payload.fullyIdle === false) return { ...event, action: 'ongoing' };
        else if (AGY_CANCEL_STOP.has(reason)) status = 'idle';
        else if (payload.fullyIdle !== true && !AGY_NORMAL_STOP.has(reason)) return;
        else if (reason && !AGY_NORMAL_STOP.has(reason)) status = 'idle';
      }
      const reply = status === 'done' && (provider === 'agy' ? AGY_NORMAL_STOP.has(payload.terminationReason) && payload.fullyIdle === true :
        typeof payload.last_assistant_message === 'string' && /\S/u.test(payload.last_assistant_message));
      const errorReason = status === 'error' ? errorReasonFor(provider, name, payload) : undefined;
      return { ...event, action: 'end', status, reply, ...(errorReason && { errorReason }) };
    }
  }
}

function updateExecution(stored, observed, now, modelSwitched) {
  if (!observed) return stored;
  const next = { ...stored };
  // A variant without an effort suffix supplies no effort for the new call.
  if (observed.modelSource === 'call' && next.model !== observed.model && !observed.effort) {
    delete next.effort;
    delete next.effortSource;
    delete next.effortAt;
  }
  for (const field of ['model', 'effort']) {
    const source = field + 'Source';
    if (observed[field] && (next[field] !== observed[field] || next[source] !== observed[source] || (field === 'model' && modelSwitched))) {
      next[field] = observed[field];
      next[source] = observed[source];
      next[field + 'At'] = now;
    }
  }
  return isDeepStrictEqual(next, stored) ? stored : next;
}

function advance(previous, event, now) {
  const { provider, sessionId, action, turn } = event;
  const isChild = Boolean(event.parentSessionId || previous?.parentSessionId);
  const terminal = previous && ['done', 'error'].includes(previous.status);
  const changedTurn = !isChild && !!(turn && previous?.turn && turn !== previous.turn);
  const firstInvocation = action === 'invoke' && event.firstInvocation === true;
  if (changedTurn && previous.priorTurns?.includes(turn)) return previous;
  if (changedTurn && action !== 'begin' && action !== 'metadata' && action !== 'init' && !firstInvocation && !event.completed) return previous;
  const execution = updateExecution(previous?.execution, event.execution, now, action === 'metadata');
  const withExecution = () => previous && execution !== previous.execution ? { ...previous, execution } : previous;
  // Ending a standby/blank session that never ran a turn should leave no ghost snapshot behind.
  if (event.sessionEnd && (!previous || previous.unstarted)) return undefined;
  // Codex includes model/cwd on every turn event; blank SessionStart needs no snapshot at all.
  if (!previous && provider === 'codex' && action === 'init') return undefined;
  if (previous && ((action === 'init' && !event.workspacePaths) || action === 'metadata')) {
    if (previous.unstarted && action === 'init' && ['compact', 'fork'].includes(event.source)) {
      const { unstarted: _u, ...started } = withExecution();
      return { ...started, updatedAt: Math.max(now, (previous.updatedAt || 0) + 1) };
    }
    return withExecution();
  }
  if (previous?.interrupted && ((action !== 'begin' && action !== 'invoke') ||
    (action === 'begin' && turn && !changedTurn))) return withExecution();
  if (previous?.status === 'error' && action === 'end' && event.status === 'done') return withExecution();
  const isWaitAction = action === 'wait' || action === 'soft_wait';
  const staleSameTurnWait = isWaitAction && (previous?.status === 'error' || now - (previous?.updatedAt || 0) < 1500);
  if (terminal && (action === 'resolve' || (action === 'end' && event.status === 'idle') ||
      (turn && turn === previous.turn && (action === 'begin' || staleSameTurnWait)))) return withExecution();

  let pending = { ...previous?.pending };
  // Older snapshots store kinds only. Seed their existing wait time once before
  // any newer request can alter the displayed queue.
  let pendingAt = Object.fromEntries(Object.keys(pending).map(key =>
    [key, previous.pendingAt?.[key] || previous.waitSince || previous.updatedAt]));
  let pendingTargets = {};
  if (previous?.pendingTargets && typeof previous.pendingTargets === 'object' && !Array.isArray(previous.pendingTargets)) {
    for (const [key, target] of Object.entries(previous.pendingTargets)) {
      if (Object.hasOwn(pending, key) && typeof target === 'string' && /^(?:fc|cmd):[a-f0-9]{64}$/.test(target)) {
        pendingTargets[key] = target;
      }
    }
  }
  let pendingSoft = {};
  let pendingCalls = {};
  for (const key of Object.keys(pending)) {
    const call = previous?.pendingCalls?.[key];
    if (typeof call?.argsRef === 'string' && /^[a-f0-9]{64}$/.test(call.argsRef)) {
      pendingCalls[key] = { argsRef: call.argsRef, ...(call.identified === true && { identified: true }),
        ...(call.sharedTarget === true && { sharedTarget: true }),
        ...(Number.isSafeInteger(call.removedPeerSince) && { removedPeerSince: call.removedPeerSince }) };
    }
  }
  if (previous?.pendingSoft && typeof previous.pendingSoft === 'object' && !Array.isArray(previous.pendingSoft)) {
    for (const [key, entry] of Object.entries(previous.pendingSoft)) {
      if (entry && typeof entry === 'object' && !Array.isArray(entry) &&
          (entry.status === 'approval' || entry.status === 'input') &&
          Number.isSafeInteger(entry.since) && Number.isSafeInteger(entry.after)) {
        pendingSoft[key] = {
          status: entry.status,
          after: entry.after,
          since: entry.since,
          ...(Number.isSafeInteger(entry.stepIdx) && entry.stepIdx >= 0 && { stepIdx: entry.stepIdx }),
        };
      }
    }
  }
  const remove = key => { delete pending[key]; delete pendingAt[key]; delete pendingTargets[key]; delete pendingCalls[key]; delete pendingSoft[key]; };
  let status = previous?.status || 'idle';
  let workSince = previous?.workSince;
  let replyAt = previous?.replyAt;
  let completedAt = previous?.completedAt;
  let errorReason = previous?.status === 'error' ? previous.errorReason : undefined;
  const start = action === 'begin' && (!turn || changedTurn || !previous?.turn || status === 'idle');
  const invokeStart = action === 'invoke' && (firstInvocation || terminal || status === 'idle');
  if (action === 'ongoing' && status === 'idle') status = 'working';
  if (action === 'invoke') pendingSoft = {};
  if (start || invokeStart || action === 'end') {
    pending = {};
    pendingAt = {};
    pendingTargets = {};
    pendingCalls = {};
    pendingSoft = {};
    status = action === 'end' ? event.status : 'working';
    errorReason = status === 'error' ? event.errorReason : undefined;
    if (start || invokeStart) workSince = now;
    if (status === 'done' && previous?.status !== 'done') {
      if (event.reply) replyAt = now;
      if (event.completed) completedAt = now;
    }
  } else if (action === 'soft_wait') {
    const delayMs = Number.isSafeInteger(event.delayMs) && event.delayMs >= 0 && event.delayMs <= 60000 ? event.delayMs : 0;
    if (event.key && !Object.hasOwn(pendingSoft, event.key) && !Object.hasOwn(pending, event.key)) {
      const keys = Object.keys(pendingSoft);
      if (keys.length >= SOFT_WAIT_LIMIT) {
        keys.sort((a, b) => (pendingSoft[a].since || 0) - (pendingSoft[b].since || 0));
        delete pendingSoft[keys[0]];
      }
      pendingSoft[event.key] = {
        status: event.status,
        after: now + delayMs,
        since: now,
        ...(Number.isSafeInteger(event.stepIdx) && event.stepIdx >= 0 && { stepIdx: event.stepIdx }),
      };
    }
    if (!['working', 'input', 'approval'].includes(status)) {
      status = 'working';
      errorReason = undefined;
    }
  } else if (action === 'wait' || action === 'resolve') {
    if (action === 'wait') {
      delete pendingSoft[event.key];
      if (event.key !== 'generic' || !Object.values(pending).includes('approval')) {
        const genericAt = event.status === pending.generic ? pendingAt.generic : undefined;
        if (event.key !== 'generic' && genericAt) remove('generic');
        if (pending[event.key] !== event.status) pendingAt[event.key] = genericAt || now;
        pending[event.key] = event.status;
        if (event.key !== 'generic' && typeof event.target === 'string' && /^(?:fc|cmd):[a-f0-9]{64}$/.test(event.target)) {
          pendingTargets[event.key] = event.target;
          if (event.argsRef) {
            const peers = Object.keys(pendingTargets).filter(key => key !== event.key && pendingTargets[key] === event.target);
            for (const key of peers) {
              pendingCalls[key] = { ...pendingCalls[key], argsRef: pendingCalls[key]?.argsRef || key, sharedTarget: true };
            }
            pendingCalls[event.key] = { ...pendingCalls[event.key], argsRef: event.argsRef,
              ...(event.callRef && { identified: true }), ...(peers.length && { sharedTarget: true }) };
          }
        }
      }
    } else {
      const specificWait = Object.keys(pending).some(key => key !== 'generic');
      const hasSoft = Object.keys(pendingSoft).length > 0;
      let key = event.key ?? ((specificWait || hasSoft) && event.resolveKey());
      if (provider === 'codex' && !event.key && key) {
        if (event.callRef && Object.hasOwn(pending, event.callRef)) key = event.callRef;
        else {
          const matches = Object.keys(pendingCalls).filter(ref => pendingCalls[ref].argsRef === key &&
            !(event.callRef && pendingCalls[ref].identified));
          if (matches.length === 1) key = matches[0];
          else if (!event.callRef && matches.length > 1) {
            key = matches.reduce((latest, ref) => pendingAt[ref] >= pendingAt[latest] ? ref : latest);
            // A later native completion with these same arguments may belong to the removed retry.
            for (const ref of matches) {
              if (ref !== key) pendingCalls[ref].removedPeerSince = Math.min(pendingCalls[ref].removedPeerSince ?? Infinity, pendingAt[key]);
            }
          }
        }
      }
      const resolvedKind = pending[key];
      if (key) remove(key);
      if (key !== 'elicitation' && resolvedKind !== 'input' && !specificWait) remove('generic');
    }
    const kinds = Object.values(pending);
    status = kinds.includes('input') ? 'input' : kinds.includes('approval') ? 'approval' : 'working';
  }
  if (!workSince && !terminal && ['working', 'input', 'approval'].includes(status)) workSince = previous?.updatedAt || now;
  const times = Object.keys(pending).filter(key => pending[key] === status).map(key => pendingAt[key]);
  const waitSince = times.length ? Math.min(...times) : undefined;
  const hasPendingTargets = Object.keys(pendingTargets).length > 0;
  const hasPendingSoft = Object.keys(pendingSoft).length > 0;
  const nextTurn = isChild ? '' : ((['metadata', 'init'].includes(action) && previous?.turn) || turn || previous?.turn || '');
  const priorTurns = changedTurn && (action === 'begin' || firstInvocation) ?
    [...(previous.priorTurns || []), previous.turn].slice(-16) : (isChild ? undefined : previous?.priorTurns);
  const workspacePaths = provider === 'agy' ? event.workspacePaths ?? previous?.workspacePaths : undefined;
  const cwd = event.workspacePaths ? event.cwd : event.cwd || previous?.cwd || '';
  const parentSessionId = event.parentSessionId || previous?.parentSessionId;
  const agentType = event.agentType || previous?.agentType;
  const unstarted = (action === 'init' && (!previous || previous.unstarted) && !['compact', 'fork'].includes(event.source)) ||
    (action === 'metadata' && !previous);
  const snapshot = { provider, sessionId, cwd, status, updatedAt: previous?.updatedAt || now,
    ...(unstarted && {unstarted: true}),
    ...(workspacePaths && {workspacePaths}), ...(nextTurn && {turn: nextTurn}),
    ...(priorTurns && {priorTurns}), ...(event.interrupted && {interrupted: true}),
    ...(times.length && {pending, pendingAt, waitSince}),
    ...(times.length && hasPendingTargets && {pendingTargets}),
    ...(times.length && Object.keys(pendingCalls).length && {pendingCalls}),
    ...(hasPendingSoft && {pendingSoft}),
    ...(workSince && {workSince}),
    ...(parentSessionId && {parentSessionId}), ...(agentType && {agentType}),
    ...(replyAt && {replyAt}), ...(completedAt && {completedAt}),
    ...(status === 'error' && errorReason && {errorReason}), ...(execution && {execution}),
  };
  const heartbeatDue = status === 'working' && previous && now - previous.updatedAt >= 600000;
  if (!heartbeatDue && previous && isDeepStrictEqual(snapshot, withExecution())) return withExecution();
  snapshot.updatedAt = Math.max(now, (previous?.updatedAt || 0) + 1);
  return snapshot;
}

const STALE_LOCK_MS = 5000;

async function reclaimStaleLock(lock) {
  const stat = await fs.lstat(lock).catch(() => null);
  if (!stat?.isDirectory() || Date.now() - stat.mtimeMs <= STALE_LOCK_MS) return;
  const entries = await fs.readdir(lock, { withFileTypes: true }).catch(() => null);
  if (!entries) return;
  const now = Date.now();
  for (const entry of entries) {
    const file = path.join(lock, entry.name);
    const entryStat = await fs.lstat(file).catch(() => null);
    // If a fresh owner just created a marker inside a newly acquired lock, back off.
    if (entryStat && now - entryStat.mtimeMs <= STALE_LOCK_MS) return;
  }
  for (const entry of entries) {
    await fs.unlink(path.join(lock, entry.name)).catch(() => {});
  }
  await fs.rmdir(lock).catch(() => {});
}

// Different tools in the same turn can run hooks in parallel processes. A session
// lock protects the read/modify/write. A crashed writer leaves only a reclaimable
// lock; ownership tokens ensure a slow writer never removes another process's lock.
async function acquireLock(lock) {
  const deadline = Date.now() + 1800;
  for (;;) {
    try {
      await fs.mkdir(lock, { mode: 0o700 });
      const token = randomUUID();
      const marker = path.join(lock, token);
      try {
        await fs.writeFile(marker, '', { mode: 0o600, flag: 'wx' });
        const stat = await fs.lstat(lock);
        return { lock, marker, ino: stat.ino };
      } catch (error) {
        await fs.unlink(marker).catch(() => {});
        if (error.code !== 'ENOENT') await fs.rmdir(lock).catch(() => {});
        throw error;
      }
    } catch (error) {
      if (error.code !== 'EEXIST' && error.code !== 'ENOENT') throw error;
      if (error.code === 'EEXIST') await reclaimStaleLock(lock);
      if (Date.now() >= deadline) throw new Error('Timed out waiting for the session lock');
      await sleep(8 + Math.random() * 12);
    }
  }
}

async function releaseLock(lease) {
  if (!lease) return;
  const stat = await fs.lstat(lease.lock).catch(() => null);
  if (!stat?.isDirectory() || stat.ino !== lease.ino) return;
  await fs.unlink(lease.marker).catch(() => {});
  // rmdir atomically refuses to remove a non-empty directory if another owner reclaimed it.
  await fs.rmdir(lease.lock).catch(() => {});
}

const SNAPSHOT_FILE_RE = /^[a-f0-9]{64}\.json$/;
// Claude posts the generic reminder about six seconds after the actual prompt.
// Events from a different request may share the same parent for hours.
const CLAUDE_NOTIFICATION_WINDOW_MS = 15000;
const sameApprovalWindow = (a, b) => Number.isSafeInteger(a) && Number.isSafeInteger(b) &&
  Math.abs(a - b) <= CLAUDE_NOTIFICATION_WINDOW_MS;

async function hasActiveChildApproval(stateDir, parentSessionId, now = Date.now()) {
  const files = await fs.readdir(stateDir, { withFileTypes: true }).catch(() => []);
  for (const file of files) {
    if (!file.isFile() || !SNAPSHOT_FILE_RE.test(file.name)) continue;
    const full = path.join(stateDir, file.name);
    try {
      const stat = await fs.lstat(full);
      if (!stat.isFile() || stat.size > 64 * 1024 || now - stat.mtimeMs > CLAUDE_NOTIFICATION_WINDOW_MS + STALE_LOCK_MS) continue;
      const snap = JSON.parse(await fs.readFile(full, 'utf8'));
      if (snap?.provider === 'claude' && snap.parentSessionId === parentSessionId && snap.status === 'approval' &&
          Object.entries(snap.pending || {}).some(([ref, kind]) => ref !== 'generic' && kind === 'approval' &&
            sameApprovalWindow(snap.pendingAt?.[ref] || snap.waitSince, now))) {
        return true;
      }
    } catch { /* ignore concurrent snapshot updates */ }
  }
  return false;
}

async function clearParentGenericApproval(stateDir, parentSessionId, childWaitAt) {
  const base = path.join(stateDir, digest('claude:' + parentSessionId));
  const filename = base + '.json';
  const lock = base + '.lock';
  let lease;
  const temporary = base + '.' + randomUUID() + '.tmp';
  try {
    lease = await acquireLock(lock);
    const previous = JSON.parse(await fs.readFile(filename, 'utf8'));
    if (!previous || previous.status !== 'approval' || !previous.pending || typeof previous.pending !== 'object') return;
    const keys = Object.keys(previous.pending);
    if (keys.length !== 1 || keys[0] !== 'generic' || previous.pending.generic !== 'approval') return;
    if (!sameApprovalWindow(previous.pendingAt?.generic || previous.waitSince, childWaitAt)) return;
    const { pending: _p, pendingAt: _pa, pendingTargets: _pt, waitSince: _ws, ...rest } = previous;
    const now = Date.now();
    const next = { ...rest, status: 'working', updatedAt: Math.max(now, (previous.updatedAt || 0) + 1) };
    await fs.writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, filename);
  } catch { /* parent missing or already updated */ }
  finally {
    await fs.unlink(temporary).catch(() => {});
    await releaseLock(lease);
  }
}

async function record(stateDir, event, { captureWait = false, expectedWait } = {}) {
  if (!event || !path.isAbsolute(stateDir)) return { changed: false, restarted: false };
  await fs.mkdir(stateDir, { mode: 0o700, recursive: true });
  const scope = event.provider === 'claude' && event.parentSessionId ? event.parentSessionId + '/' : '';
  const base = path.join(stateDir, digest(event.provider + ':' + scope + event.sessionId));
  const filename = base + '.json';
  const lock = base + '.lock';
  const lease = await acquireLock(lock);
  const temporary = base + '.' + randomUUID() + '.tmp';
  let result, waitAt;
  try {
    // A child can acquire its approval while the parent's reminder is waiting for this lock.
    if (event.provider === 'claude' && !event.parentSessionId && event.action === 'wait' &&
        event.status === 'approval' && event.key === 'generic' && await hasActiveChildApproval(stateDir, event.sessionId)) {
      return { changed: false, restarted: false, recordedWait: false };
    }
    let previous;
    try {
      previous = JSON.parse(await fs.readFile(filename, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    if (expectedWait && (previous?.pending?.[event.key] !== event.status || previous.turn !== expectedWait.turn ||
        previous.pendingAt?.[event.key] !== expectedWait.waitAt)) return { changed: false, restarted: false };
    const restarted = event.action === 'invoke' && (!previous || ['done', 'error', 'idle'].includes(previous.status) || event.firstInvocation === true);
    const next = advance(previous, event, Date.now());
    if (expectedWait && next?.pending?.[event.key]) return { changed: false, restarted: false };
    const recordedWait = Boolean(event.action === 'wait' && next?.pending?.[event.key] === event.status && (!event.turn || next.turn === event.turn));
    if (recordedWait) waitAt = next.pendingAt?.[event.key];
    const waitMeta = event.action === 'wait' ? { recordedWait, ...(captureWait && recordedWait && { waitAt, turn: next.turn }) } : {};
    if (next === previous) {
      result = { changed: false, restarted, ...waitMeta };
    } else if (!next) {
      if (previous) await fs.unlink(filename).catch(() => {});
      result = { changed: Boolean(previous), restarted: false, ...waitMeta };
    } else {
      await fs.writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, filename);
      result = { changed: true, restarted, ...waitMeta };
    }
  } finally {
    await fs.unlink(temporary).catch(() => {});
    await releaseLock(lease);
  }
  // Release child lock before touching parent snapshot to avoid lock inversion.
  if (event.provider === 'claude' && event.parentSessionId && event.action === 'wait' &&
      event.status === 'approval' && event.key !== 'generic' && result?.recordedWait) {
    await clearParentGenericApproval(stateDir, event.parentSessionId, waitAt);
  }
  return result;
}

// Display-only, on every tool call. A hook that has already run this long has cost the
// agent enough, so it skips the notice and the run stays far below the 3 s hook timeout.
const ACTIVITY_BUDGET_MS = 1500;
const DESCRIPTOR_LIMIT = 8192;
const AGY_TRANSCRIPT_TAIL_BYTES = 32768;

// Bounded, in-memory tail read of an Antigravity JSONL transcript to recover the
// latest final PLANNER_RESPONSE reply when Stop omits an inline reply field.
async function readAgyTranscriptReply(transcriptPath) {
  if (!validCwd(transcriptPath)) return '';
  let handle;
  try {
    const lst = await fs.lstat(transcriptPath);
    if (!lst.isFile() || !lst.size) return '';
    handle = await fs.open(transcriptPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || !stat.size) return '';
    const start = Math.max(0, stat.size - AGY_TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(stat.size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    if (start > 0) lines.shift();
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line || !/"type"\s*:\s*"(?:PLANNER_RESPONSE|USER_INPUT|USER_MESSAGE)"/.test(line)) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry?.type === 'USER_INPUT' || entry?.type === 'USER_MESSAGE') break;
      if (entry?.type !== 'PLANNER_RESPONSE') continue;
      const calls = entry.tool_calls ?? entry.toolCalls ?? entry.plannerResponse?.toolCalls;
      if (Array.isArray(calls) && calls.length > 0) return '';
      const text = [entry.response, entry.content, entry.modifiedResponse, entry.text,
        entry.plannerResponse?.modifiedResponse, entry.plannerResponse?.response]
        .find(value => typeof value === 'string' && /\S/.test(value));
      if (text) return text;
    }
    return '';
  } catch {
    return '';
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

// Only a hint, so that a hook loads nothing more while no window wants activity;
// manual.cjs checks each window it contacts in full.
async function activityWanted(stateDir) {
  const registry = path.join(path.dirname(stateDir), 'approval-windows');
  for (const entry of await fs.readdir(registry).catch(() => [])) {
    if (!/^[a-f\d-]{36}\.json$/.test(entry)) continue;
    try {
      const file = path.join(registry, entry);
      const stat = await fs.lstat(file);
      if (stat.isFile() && stat.size <= DESCRIPTOR_LIMIT && JSON.parse(await fs.readFile(file, 'utf8'))?.activity === true) return true;
    } catch { /* A window may replace or remove its descriptor at any time. */ }
  }
  return false;
}
async function sendActivity(stateDir, provider, name, payload, event, options = {}) {
  if (process.uptime() * 1000 > ACTIVITY_BUDGET_MS || !await activityWanted(stateDir)) return;
  const manual = require('./manual.cjs');
  const targets = await manual.activityWindows(stateDir);
  if (!targets.length) return;
  let transcriptReply = '';
  if (provider === 'agy' && name === 'Stop' && event.status === 'done' &&
      ![payload.lastAssistantMessage, payload.finalResponse, payload.response].some(value => typeof value === 'string' && /\S/.test(value))) {
    transcriptReply = await readAgyTranscriptReply(payload.transcriptPath);
  }
  await manual.reportActivity(targets, manual.activityNotice(provider, name, payload, event, {
    ...options, ...(transcriptReply && { transcriptReply }),
  }));
}

async function main() {
  const [provider, name, stateDir] = process.argv.slice(2);
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size <= 16 * 1024 * 1024) chunks.push(chunk);
  }
  if (size > 16 * 1024 * 1024) return;
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const normalizeOptions = provider === 'agy' && name === 'PreToolUse' && AGY_SOFT_WAIT_TOOLS.has(payload?.toolCall?.name)
    ? { agyPreset: await readAgyPermissionPreset() } : undefined;
  const event = normalize(provider, name, payload, normalizeOptions);
  const inline = provider === 'claude' && name === 'PermissionRequest' && !event?.parentSessionId &&
    process.env.CLAUDE_CODE_ENTRYPOINT === 'claude-vscode';
  const recorded = await record(stateDir, event, { captureWait: inline });
  if (!event || !path.isAbsolute(stateDir)) return;
  if (event.action === 'soft_wait') {
    if (!recorded?.changed) return;
    const manual = require('./manual.cjs');
    await manual.announce(stateDir, manual.noticeFor(provider, payload, event));
    return;
  }
  if (event.action !== 'wait') {
    const restart = Boolean(recorded?.restarted || (provider === 'agy' && name === 'PreInvocation' && payload.invocationNum === 1));
    return sendActivity(stateDir, provider, name, payload, event, { restart });
  }
  if (recorded?.recordedWait === false) return;
  const manual = require('./manual.cjs');
  if (recorded?.recordedWait && inline) {
    const request = manual.requestFor(provider, name, payload);
    if (request) {
      request.ref = event.key;
      const { accepted, choice } = await manual.ask(stateDir, request);
      // The window that showed the request keeps its content if it ends undecided.
      if (accepted) {
        if (!choice || choice.action === 'defer') return;
        const response = manual.hookResponse(request, payload, choice);
        if (response) {
          const resolved = await record(stateDir, { ...event, action: 'resolve' }, { expectedWait: recorded });
          if (resolved.changed) process.stdout.write(JSON.stringify(response) + '\n');
        }
        return;
      }
    }
  }
  // Display-only: the request's own chat still answers it. Nothing is printed.
  await manual.announce(stateDir, manual.noticeFor(provider, payload, event));
}

if (require.main === module) {
  // Google's "allow" delegates to the remaining hooks and the user's normal
  // permission policy. Its separate "auto_approve" decision is never used.
  main().catch(() => {}).finally(() => {
    const [, , provider, name] = process.argv;
    if (provider === 'agy' && name === 'PreToolUse') process.stdout.write('{"decision":"allow"}\n');
    else if (provider === 'agy' || (provider === 'codex' && ['Stop', 'SubagentStop'].includes(name))) process.stdout.write('{}\n');
  });
}

module.exports = { EVENT_NAMES, ERROR_REASONS, STALE_LOCK_MS, normalize, advance, record, toolKey, shellCommandText, sameApprovalWindow, acquireLock, releaseLock, localWorkspacePaths, validModel, validEffort, readAgyTranscriptReply, readAgyPermissionPreset };
