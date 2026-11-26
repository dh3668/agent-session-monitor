'use strict';

// What a session is doing, in its own words: the request that started its turn,
// the steps taken since, plan progress, the files it changed and the start of its
// last reply. Hooks extract it from the provider's payload and a window keeps it in
// memory only. File contents, diffs and tool results are never part of it.
const path = require('node:path');
const { createHash } = require('node:crypto');

const PROMPT_LIMIT = 300, REPLY_LIMIT = 400, TARGET_LIMIT = 200, FOCUS_LIMIT = 160;
const STEP_LIMIT = 8, FILES_PER_STEP = 64, FILE_LIMIT = 999, CHANGED_FILE_VIEW_LIMIT = 16, PLAN_LIMIT = 500, PLAN_ITEM_LIMIT = 12, PLAN_TEXT_LIMIT = 120;
const SESSION_LIMIT = 128, SESSION_MS = 12 * 3600000;
const TARGET_KEYS = [
  'command', 'cmd', 'CommandLine',
  'file_path', 'filePath', 'notebook_path', 'path', 'Path', 'File', 'TargetFile', 'AbsolutePath',
  'SearchPath', 'SearchDirectory', 'DirectoryPath',
  'pattern', 'Pattern', 'query', 'Query', 'url', 'Url',
  'focus', 'skill', 'task_name', 'subject', 'activeForm', 'Role', 'TaskName', 'TaskStatus',
  'toolSummary', 'summary', 'description', 'Description', 'prompt', 'Prompt', 'message', 'Message', 'reason', 'chars',
];
const PATH_KEYS = new Set(['file_path', 'filePath', 'notebook_path', 'path', 'Path', 'File', 'TargetFile', 'AbsolutePath', 'SearchPath', 'SearchDirectory', 'DirectoryPath']);
const FILE_TOOL_PATTERN = /^(edit|multiedit|apply_patch|str_replace_editor|replace_file_content|multi_replace_file_content|notebookedit|edit_file|write|write_file|write_to_file|create_file|read|read_file|view_file|view_file_outline|view_code_item|view_image|view|open_file|notebookread)$/i;
const FILE_PATH_KEYS = ['file_path', 'filePath', 'planFilePath', 'notebook_path', 'path', 'Path', 'File', 'TargetFile', 'AbsolutePath'];
const PLAN_STATUSES = new Set(['completed', 'in_progress', 'pending', 'skipped', 'failed']);
const TASK_OP_STATUSES = new Set(['completed', 'in_progress', 'pending', 'deleted']);
// Tools that write the one file their input names. Codex's apply_patch names its own.
const WRITERS = Object.freeze({
  Edit: 'file_path', MultiEdit: 'file_path', Write: 'file_path', NotebookEdit: 'notebook_path',
  edit_file: 'Path', write_file: 'Path',
  replace_file_content: 'TargetFile', multi_replace_file_content: 'TargetFile', write_to_file: 'TargetFile',
});
const PLANS = Object.freeze({ TodoWrite: 'todos', update_plan: 'plan', update_steps: 'steps' });
const PATCH_HEADER = /^\*\*\* (Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm;
// The Codex IDE extension sends the editor's context ahead of the request itself.
const CODEX_CONTEXT = '# Context from my IDE setup:', CODEX_REQUEST = '## My request for Codex:';
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(value);
const validFile = file => typeof file === 'string' && file.length <= 4096 && path.isAbsolute(file) && !file.includes('\0');
const validPlan = plan => isObject(plan) && Number.isSafeInteger(plan.total) && plan.total >= 0 && plan.total <= PLAN_LIMIT &&
  Number.isSafeInteger(plan.done) && plan.done >= 0 && plan.done <= plan.total;
const validPlanItem = item => isObject(item) && typeof item.text === 'string' && item.text.length <= PLAN_TEXT_LIMIT * 4 &&
  PLAN_STATUSES.has(item.status);
const validTaskId = value => typeof value === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(value);
function normalizePlanStatus(value) {
  if (value === 'done') return 'completed';
  if (value === 'inProgress') return 'in_progress';
  return PLAN_STATUSES.has(value) ? value : 'pending';
}

// Direction overrides and invisible characters are shown as escapes, never obeyed.
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/gu;
const reveal = text => text.replace(HIDDEN, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));

// At most `max` characters and never half a surrogate pair. A cut is marked; a path keeps its end.
function clip(text, max, keepEnd = false) {
  if (text.length <= max) return text;
  if (keepEnd) {
    const cut = text.slice(text.length - max + 1);
    const first = cut.charCodeAt(0);
    return '…' + (first >= 0xdc00 && first <= 0xdfff ? cut.slice(1) : cut);
  }
  const cut = text.slice(0, max - 1);
  const last = cut.charCodeAt(cut.length - 1);
  return (last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut) + '…';
}

// The first non-blank line as one line of display text. Work is bounded for any input size.
function lineOf(value, max, keepEnd = false) {
  if (typeof value !== 'string') return '';
  const start = value.search(/\S/);
  if (start < 0) return '';
  let line = value.slice(start, start + (keepEnd ? 4096 : max * 4));
  const end = line.search(/[\r\n]/);
  if (end >= 0) line = line.slice(0, end);
  return clip(reveal(line).replace(/\s+/g, ' ').trim(), max, keepEnd);
}

// The beginning of a request or a reply, its line breaks kept.
function textOf(value, max) {
  if (typeof value !== 'string') return '';
  const start = value.search(/\S/);
  if (start < 0) return '';
  return clip(reveal(value.slice(start, start + max * 4).replace(/\r\n?/g, '\n')).trimEnd(), max);
}

const OUTSIDE_PATH_LIMIT = 48;
const isInside = (root, file) => {
  const relative = path.relative(root, file);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
};

// A long path outside the folder shows its last few segments: a narrow row cuts
// text at its end, so a full path would show only a shared prefix, never the file.
function outsidePath(file) {
  if (file.length <= OUTSIDE_PATH_LIMIT) return file;
  const parts = file.split(path.sep).filter(Boolean);
  for (const count of [3, 2, 1]) {
    if (parts.length <= count) continue;
    const tail = '…' + path.sep + parts.slice(-count).join(path.sep);
    if (tail.length <= OUTSIDE_PATH_LIMIT || count === 1) return clip(tail, TARGET_LIMIT, true);
  }
  return clip(file, TARGET_LIMIT, true);
}

// A path inside the session's folder reads relative to it, so a narrow row still shows
// the file; any other path keeps its end. The folder itself says nothing.
function pathOf(value, cwd) {
  const file = lineOf(value, 4096, true);
  if (file && typeof cwd === 'string' && path.isAbsolute(cwd) && path.isAbsolute(file)) {
    const relative = path.relative(cwd, file);
    if (!relative) return '';
    if (isInside(cwd, file)) return clip(relative, TARGET_LIMIT, true);
    return outsidePath(file);
  }
  return clip(file, TARGET_LIMIT, true);
}

// The one argument that says what a step is about: the command, the file, the search, the address.
function stepTarget(input, cwd) {
  if (!isObject(input)) return '';
  const cmdWords = ['command', 'cmd'].map(key => input[key])
    .find(value => Array.isArray(value) && value.length <= 4096 && value.every(part => typeof part === 'string'));
  if (cmdWords) {
    let joined = '';
    for (const part of cmdWords) {
      joined += (joined ? ' ' : '') + part;
      if (joined.length > TARGET_LIMIT * 4) break;
    }
    const target = lineOf(joined, TARGET_LIMIT);
    if (target) return target;
  }
  if (Array.isArray(input.questions) && typeof input.questions[0]?.question === 'string') {
    const question = lineOf(input.questions[0].question, TARGET_LIMIT);
    if (question) return question;
  }
  for (const key of TARGET_KEYS) {
    const target = PATH_KEYS.has(key) ? pathOf(input[key], cwd) : lineOf(input[key], TARGET_LIMIT);
    if (target) return target;
  }
  return '';
}

// File header lines of a Codex patch, in order; the patch body is never read into a step.
// A `*** Move to:` line replaces the preceding file's path with its destination so chips open the moved file.
function patchFiles(patch) {
  const files = [];
  if (typeof patch !== 'string') return files;
  let currentIndex = -1;
  for (const match of patch.matchAll(PATCH_HEADER)) {
    if (match[1]) {
      if (files.length >= FILES_PER_STEP) break;
      const file = match[2].trim();
      if (!file) { currentIndex = -1; continue; }
      const existing = files.indexOf(file);
      if (existing >= 0) {
        currentIndex = existing;
      } else {
        currentIndex = files.length;
        files.push(file);
      }
    } else if (match[3] && currentIndex >= 0) {
      const dest = match[3].trim();
      if (dest) {
        const dup = files.indexOf(dest);
        if (dup >= 0 && dup !== currentIndex) {
          files.splice(currentIndex, 1);
          currentIndex = dup > currentIndex ? dup - 1 : dup;
        } else {
          files[currentIndex] = dest;
        }
      }
    }
  }
  return files;
}

function patchBody(input) {
  if (!isObject(input)) return;
  for (const key of ['command', 'patch', 'input']) if (typeof input[key] === 'string') return input[key];
}

function changedFiles(tool, input, cwd) {
  if (!isObject(input)) return [];
  const named = Object.hasOwn(WRITERS, tool) ? [input[WRITERS[tool]]] : tool === 'apply_patch' ? patchFiles(patchBody(input)) : [];
  return named.filter(file => typeof file === 'string' && file.trim() && file.length <= 4096 && !file.includes('\0'))
    .map(file => path.resolve(cwd, file.trim()));
}

function stepFileFor(tool, input, cwd) {
  if (!FILE_TOOL_PATTERN.test(tool) || !isObject(input)) return '';
  const hasCwd = typeof cwd === 'string' && path.isAbsolute(cwd);
  const resolveCandidate = raw => {
    if (typeof raw !== 'string') return '';
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > 4096 || trimmed.includes('\0')) return '';
    if (!hasCwd && !path.isAbsolute(trimmed)) return '';
    const resolved = hasCwd ? path.resolve(cwd, trimmed) : path.resolve(trimmed);
    return validFile(resolved) ? resolved : '';
  };
  if (tool === 'apply_patch') return resolveCandidate(patchFiles(patchBody(input))[0]);
  for (const key of FILE_PATH_KEYS) {
    const resolved = resolveCandidate(input[key]);
    if (resolved) return resolved;
  }
  return '';
}

// A to-do, plan, or step-checklist tool rewrites the whole list each time, so one call gives the progress.
function planProgress(tool, input) {
  const list = Object.hasOwn(PLANS, tool) && isObject(input) ? input[PLANS[tool]] : undefined;
  if (!Array.isArray(list) || list.length > PLAN_LIMIT || !list.every(item => isObject(item) && typeof item.status === 'string')) return;
  return { done: list.filter(item => item.status === 'completed' || item.status === 'done').length, total: list.length };
}

// Structured checklist items from TodoWrite / update_plan / update_steps, bounded and in-memory only.
function planItems(tool, input) {
  const list = Object.hasOwn(PLANS, tool) && isObject(input) ? input[PLANS[tool]] : undefined;
  if (!Array.isArray(list) || !list.length || list.length > PLAN_LIMIT || !list.every(item => isObject(item) && typeof item.status === 'string')) return;
  const items = [];
  for (const entry of list) {
    const status = normalizePlanStatus(entry.status);
    const raw = status === 'in_progress' && typeof entry.activeForm === 'string' && entry.activeForm.trim()
      ? entry.activeForm
      : (typeof entry.content === 'string' && entry.content.trim() ? entry.content
        : (typeof entry.title === 'string' && entry.title.trim() ? entry.title : entry.step));
    const text = lineOf(raw, PLAN_TEXT_LIMIT);
    if (!text) continue;
    items.push({ text, status });
    if (items.length >= PLAN_ITEM_LIMIT) break;
  }
  return items.length ? items : undefined;
}

// Incremental Claude Code TaskCreate / TaskUpdate operations (in-memory only).
function taskOpFor(tool, input, response) {
  if (!isObject(input)) return;
  if (tool === 'TaskCreate') {
    const subject = lineOf(input.subject || input.activeForm || input.description, PLAN_TEXT_LIMIT);
    if (!subject) return;
    const activeForm = lineOf(input.activeForm, PLAN_TEXT_LIMIT);
    let rawId = response?.task?.id ?? response?.id;
    if (rawId == null) {
      const text = typeof response === 'string' ? response
        : Array.isArray(response) ? response.map(block => typeof block === 'string' ? block : typeof block?.text === 'string' ? block.text : '').join('\n')
        : typeof response?.text === 'string' ? response.text : '';
      if (text) {
        const m = /\bTask\s*#?([A-Za-z0-9._-]{1,64})\b/i.exec(text);
        if (m) rawId = m[1];
      }
    }
    const id = rawId != null && validTaskId(String(rawId)) ? String(rawId) : undefined;
    return { op: 'create', ...(id && { id }), subject, ...(activeForm && { activeForm }) };
  }
  if (tool === 'TaskUpdate') {
    const rawId = input.taskId != null ? String(input.taskId) : '';
    if (!validTaskId(rawId)) return;
    const status = typeof input.status === 'string' && TASK_OP_STATUSES.has(input.status) ? input.status : undefined;
    const subject = lineOf(input.subject, PLAN_TEXT_LIMIT);
    const activeForm = lineOf(input.activeForm, PLAN_TEXT_LIMIT);
    if (!status && !subject && !activeForm) return;
    return { op: 'update', id: rawId, ...(status && { status }), ...(subject && { subject }), ...(activeForm && { activeForm }) };
  }
}

function taskListSnapshot(response) {
  const list = Array.isArray(response?.tasks) ? response.tasks : undefined;
  if (!list || list.length > PLAN_LIMIT || !list.every(item => isObject(item) && typeof item.status === 'string')) return;
  const active = list.filter(item => item.status !== 'deleted');
  const progress = { done: active.filter(item => item.status === 'completed').length, total: active.length };
  const plan = [];
  const tasks = [];
  for (const entry of active) {
    const status = normalizePlanStatus(entry.status);
    const subject = lineOf(entry.subject, PLAN_TEXT_LIMIT);
    const activeForm = lineOf(entry.activeForm, PLAN_TEXT_LIMIT);
    const text = status === 'in_progress' && activeForm ? activeForm : (subject || activeForm);
    if (text && plan.length < PLAN_ITEM_LIMIT) plan.push({ text, status });
    const rawId = entry.id != null ? String(entry.id) : '';
    if (validTaskId(rawId) && (subject || activeForm) && tasks.length < PLAN_LIMIT) {
      tasks.push({ id: rawId, subject: subject || activeForm, ...(activeForm && { activeForm }), status });
    }
  }
  return { progress, ...(plan.length && { plan }), ...(tasks.length && { tasks }) };
}

function requestOf(provider, prompt) {
  if (provider === 'codex' && typeof prompt === 'string' && prompt.trimStart().startsWith(CODEX_CONTEXT)) {
    const at = prompt.indexOf(CODEX_REQUEST);
    if (at >= 0) prompt = prompt.slice(at + CODEX_REQUEST.length);
  }
  return textOf(prompt, PROMPT_LIMIT);
}

// What one hook event says about its session, or nothing.
function activityFor(provider, name, payload, cwd, { restart = false, transcriptReply = '' } = {}) {
  if (!isObject(payload)) return;
  switch (name) {
    case 'UserPromptSubmit': {
      const prompt = provider !== 'agy' && requestOf(provider, payload.prompt);
      return prompt ? { prompt, restart: true } : undefined;
    }
    case 'PreInvocation': {
      const prompt = provider === 'agy' && textOf(payload.lastUserInput, PROMPT_LIMIT);
      const isRestart = restart || payload.invocationNum === 1;
      return prompt ? { prompt, ...(isRestart && { restart: true }) } : undefined;
    }
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const tool = provider === 'agy' ? payload.toolCall?.name : payload.tool_name;
      const input = provider === 'agy' ? payload.toolCall?.args : payload.tool_input;
      if (!safeId(tool)) return;
      const failed = name === 'PostToolUseFailure' || (provider === 'agy' && typeof payload.error === 'string' && /\S/.test(payload.error));
      // A patch's first line is only its envelope; the file it changes says more.
      let target = tool === 'apply_patch' ? pathOf(patchFiles(patchBody(input))[0], cwd) : stepTarget(input, cwd);
      if (!target && (tool === 'TaskUpdate' || tool === 'TaskGet') && isObject(input) && input.taskId != null && validTaskId(String(input.taskId))) {
        target = '#' + String(input.taskId);
      }
      let progress = !failed ? planProgress(tool, input) : undefined;
      let plan = progress && progress.total ? planItems(tool, input) : undefined;
      let tasks;
      if (!failed && tool === 'TaskList' && !progress) {
        const snap = taskListSnapshot(payload.tool_response);
        if (snap) { progress = snap.progress; plan = snap.plan; tasks = snap.tasks; }
      }
      const taskOp = !failed ? taskOpFor(tool, input, payload.tool_response) : undefined;
      const focus = !failed && tool === 'update_focus' && isObject(input) ? lineOf(input.focus, FOCUS_LIMIT) : '';
      const files = !failed ? changedFiles(tool, input, cwd) : [];
      const stepFile = stepFileFor(tool, input, cwd);
      return {
        step: { tool, target, ...(failed && { failed: true }) },
        ...(stepFile && { stepFile }),
        ...(progress && { progress }),
        ...(plan && { plan }),
        ...(tasks && { tasks }),
        ...(taskOp && { taskOp }),
        ...(focus && { focus }),
        ...(files.length && { files }),
      };
    }
    case 'Stop': {
      if (provider === 'agy') {
        const err = typeof payload.error === 'string' && payload.error.trim() ? textOf(payload.error, REPLY_LIMIT) : '';
        if (err) return { reply: err };
        const raw = [payload.lastAssistantMessage, payload.finalResponse, payload.response, transcriptReply]
          .find(value => typeof value === 'string' && /\S/.test(value));
        const reply = textOf(raw, REPLY_LIMIT);
        if (reply) return { reply };
        return payload.fullyIdle !== false ? { finished: true } : undefined;
      }
      const reply = textOf(payload.last_assistant_message, REPLY_LIMIT);
      return reply ? { reply } : undefined;
    }
    case 'SubagentStop': {
      const reply = provider !== 'agy' && textOf(payload.last_assistant_message, REPLY_LIMIT);
      return reply ? { reply } : undefined;
    }
    case 'StopFailure': {
      const detail = typeof payload.last_assistant_message === 'string' && payload.last_assistant_message.trim()
        ? payload.last_assistant_message : payload.error_details;
      const reply = provider !== 'agy' && textOf(detail, REPLY_LIMIT);
      return reply ? { reply } : undefined;
    }
  }
}

function acceptedTaskOp(op) {
  if (!isObject(op)) return;
  if (op.op === 'create') {
    const subject = lineOf(op.subject, PLAN_TEXT_LIMIT);
    if (!subject || (op.id !== undefined && !validTaskId(op.id))) return;
    const activeForm = lineOf(op.activeForm, PLAN_TEXT_LIMIT);
    return { op: 'create', ...(op.id && { id: op.id }), subject, ...(activeForm && { activeForm }) };
  }
  if (op.op === 'update') {
    if (!validTaskId(op.id)) return;
    if (op.status !== undefined && !TASK_OP_STATUSES.has(op.status)) return;
    const subject = lineOf(op.subject, PLAN_TEXT_LIMIT);
    const activeForm = lineOf(op.activeForm, PLAN_TEXT_LIMIT);
    if (!op.status && !subject && !activeForm) return;
    return { op: 'update', id: op.id, ...(op.status && { status: op.status }), ...(subject && { subject }), ...(activeForm && { activeForm }) };
  }
}

function acceptedTaskEntry(entry) {
  if (!isObject(entry) || !validTaskId(entry.id) || typeof entry.subject !== 'string' || !PLAN_STATUSES.has(entry.status)) return;
  if (entry.activeForm !== undefined && typeof entry.activeForm !== 'string') return;
  const subject = lineOf(entry.subject, PLAN_TEXT_LIMIT);
  if (!subject) return;
  const activeForm = lineOf(entry.activeForm, PLAN_TEXT_LIMIT);
  return { id: entry.id, subject, ...(activeForm && { activeForm }), status: entry.status };
}

// A window checks every field again: the hook may come from another release.
function acceptedActivity(update) {
  if (!isObject(update)) return;
  if (update.turn !== undefined && !safeId(update.turn)) return;
  const turn = update.turn || undefined;
  const kinds = ['prompt', 'step', 'reply', 'finished'].filter(kind => update[kind] !== undefined);
  if (kinds.length !== 1) return;
  if (kinds[0] === 'finished') {
    return update.finished === true ? { finished: true, ...(turn && { turn }) } : undefined;
  }
  if (kinds[0] === 'prompt') {
    const prompt = textOf(update.prompt, PROMPT_LIMIT);
    return prompt ? { prompt, restart: update.restart === true, ...(turn && { turn }) } : undefined;
  }
  if (kinds[0] === 'reply') {
    const reply = textOf(update.reply, REPLY_LIMIT);
    return reply ? { reply, ...(turn && { turn }) } : undefined;
  }
  const { step, stepFile, progress, plan, tasks, taskOp, focus, files = [] } = update;
  if (!isObject(step) || !safeId(step.tool) || (step.target !== undefined && typeof step.target !== 'string') ||
      (step.failed !== undefined && typeof step.failed !== 'boolean') ||
      (stepFile !== undefined && !validFile(stepFile)) ||
      (progress !== undefined && !validPlan(progress)) ||
      (plan !== undefined && (!Array.isArray(plan) || plan.length > PLAN_ITEM_LIMIT || !plan.every(validPlanItem))) ||
      (tasks !== undefined && (!Array.isArray(tasks) || tasks.length > PLAN_LIMIT)) ||
      (focus !== undefined && typeof focus !== 'string') ||
      !Array.isArray(files) || files.length > FILES_PER_STEP || !files.every(validFile)) return;
  let cleanTasks;
  if (tasks !== undefined) {
    cleanTasks = [];
    for (const entry of tasks) {
      const clean = acceptedTaskEntry(entry);
      if (!clean) return;
      cleanTasks.push(clean);
    }
  }
  const cleanTaskOp = taskOp !== undefined ? acceptedTaskOp(taskOp) : undefined;
  if (taskOp !== undefined && !cleanTaskOp) return;
  const cleanPlan = Array.isArray(plan) ? plan.map(item => ({ text: lineOf(item.text, PLAN_TEXT_LIMIT), status: item.status })).filter(item => item.text) : undefined;
  const cleanFocus = typeof focus === 'string' ? lineOf(focus, FOCUS_LIMIT) : '';
  return {
    ...(turn && { turn }),
    step: { tool: step.tool, target: lineOf(step.target, TARGET_LIMIT), ...(step.failed === true && { failed: true }) },
    ...(stepFile && { stepFile }),
    ...(progress && { progress: { done: progress.done, total: progress.total } }),
    ...(cleanPlan?.length && { plan: cleanPlan }),
    ...(cleanTasks?.length && { tasks: cleanTasks }),
    ...(cleanTaskOp && { taskOp: cleanTaskOp }),
    ...(cleanFocus && { focus: cleanFocus }),
    files: [...files],
  };
}

// Per-session activity, bounded in sessions, age, steps and files. A new request
// starts a new turn; the previous reply stays until the next one arrives.
function createActivity({ limit = SESSION_LIMIT, ttl = SESSION_MS, now = Date.now } = {}) {
  const sessions = new Map();
  const fileId = file => createHash('sha256').update(file).digest('base64');
  function rememberLookup(item, label, abs) {
    if (!label || !abs) return;
    item.fileLookup.delete(label);
    item.fileLookup.set(label, abs);
    while (item.fileLookup.size > 128) item.fileLookup.delete(item.fileLookup.keys().next().value);
  }
  function rememberPriorTurn(item, oldTurn) {
    if (!oldTurn) return;
    item.priorTurns.delete(oldTurn);
    item.priorTurns.add(oldTurn);
    while (item.priorTurns.size > 16) item.priorTurns.delete(item.priorTurns.values().next().value);
  }
  function syncTasksToPlan(item) {
    if (!item.tasks?.size) { item.progress = undefined; item.plan = undefined; return; }
    const entries = [...item.tasks.values()];
    const done = entries.filter(entry => entry.status === 'completed').length;
    item.progress = { done, total: entries.length };
    item.plan = entries.slice(0, PLAN_ITEM_LIMIT).map(entry => ({
      text: entry.status === 'in_progress' && entry.activeForm ? entry.activeForm : entry.subject,
      status: entry.status,
    }));
  }
  return {
    // Whether anything a row shows has changed.
    record(key, { prompt, restart, turn, step, stepFile, progress, plan, tasks, taskOp, focus, files = [], reply, finished }, cwd = '', displayRoot = '') {
      const time = now();
      for (const [other, entry] of sessions) if (time - entry.at >= ttl) sessions.delete(other);
      const existing = sessions.get(key);
      if (existing && turn) {
        if (prompt && restart && existing.priorTurns.has(turn)) return false;
        if (!prompt && (existing.priorTurns.has(turn) || (existing.turn && turn !== existing.turn))) return false;
      }
      if (finished === true && !existing) return false;
      const item = existing || { steps: [], files: new Set(), fileEntries: [], fileLookup: new Map(), turn: undefined, priorTurns: new Set(), rootCwd: '' };
      if (displayRoot && path.isAbsolute(displayRoot)) item.rootCwd = path.resolve(displayRoot);
      const root = (displayRoot && path.isAbsolute(displayRoot) ? path.resolve(displayRoot) : '') || item.rootCwd || cwd;
      // The least recently active session is the first to go.
      sessions.delete(key);
      sessions.set(key, item);
      item.at = time;
      while (sessions.size > limit) sessions.delete(sessions.keys().next().value);
      if (prompt) {
        if (!restart && prompt === item.prompt) {
          if (turn && !item.turn) item.turn = turn;
          return false;
        }
        if (turn && item.turn && turn !== item.turn) rememberPriorTurn(item, item.turn);
        else if (restart && !turn && item.turn) { rememberPriorTurn(item, item.turn); item.turn = undefined; }
        if (turn) item.turn = turn;
        Object.assign(item, { prompt, steps: [], files: new Set(), fileEntries: [], fileLookup: new Map(),
          progress: undefined, plan: undefined, tasks: undefined, nextTaskSeq: 1, focus: undefined });
        return true;
      }
      if (finished === true) {
        const changed = item.focus !== undefined || item.reply !== undefined;
        item.focus = undefined;
        item.reply = undefined;
        return changed;
      }
      if (reply) {
        if (reply === item.reply) return false;
        item.reply = reply;
        item.focus = undefined;
        return true;
      }
      if (!step) return false;
      let stepTargetDisplay = step.target;
      if (step.tool === 'TaskUpdate' && typeof stepTargetDisplay === 'string' && stepTargetDisplay.startsWith('#')) {
        const existingTask = item.tasks?.get(stepTargetDisplay.slice(1));
        if (existingTask) stepTargetDisplay = existingTask.activeForm || existingTask.subject || stepTargetDisplay;
      }
      if (stepFile && validFile(stepFile)) {
        const abs = path.resolve(stepFile);
        const rel = pathOf(abs, root);
        if (rel) stepTargetDisplay = rel;
        rememberLookup(item, stepTargetDisplay, abs);
        if (step.target && step.target !== stepTargetDisplay) rememberLookup(item, step.target, abs);
        rememberLookup(item, abs, abs);
      } else if (FILE_TOOL_PATTERN.test(step.tool) && files.length === 1 && step.target) {
        rememberLookup(item, step.target, path.resolve(files[0]));
      }
      item.steps = [{ tool: step.tool, target: stepTargetDisplay, at: time, ...(step.failed && { failed: true }) }, ...item.steps].slice(0, STEP_LIMIT);
      if (focus) item.focus = focus;
      if (Array.isArray(tasks) && tasks.length) {
        item.tasks = new Map();
        let maxSeq = 0;
        for (const entry of tasks.slice(0, PLAN_LIMIT)) {
          item.tasks.set(entry.id, { subject: entry.subject, ...(entry.activeForm && { activeForm: entry.activeForm }), status: entry.status });
          if (/^\d+$/.test(entry.id)) maxSeq = Math.max(maxSeq, Number(entry.id));
        }
        item.nextTaskSeq = Math.max(item.nextTaskSeq || 1, maxSeq + 1);
        syncTasksToPlan(item);
      } else if (progress) {
        item.tasks = undefined;
        item.progress = progress.total ? { ...progress } : undefined;
        item.plan = progress.total && Array.isArray(plan) && plan.length ? plan.map(entry => ({ ...entry })) : undefined;
      } else if (taskOp) {
        if (!item.tasks) { item.tasks = new Map(); item.nextTaskSeq = 1; }
        if (taskOp.op === 'create' && item.tasks.size < PLAN_LIMIT) {
          const id = taskOp.id || String(item.nextTaskSeq++);
          item.tasks.set(id, { subject: taskOp.subject, activeForm: taskOp.activeForm, status: 'pending' });
        } else if (taskOp.op === 'update') {
          if (taskOp.status === 'deleted') item.tasks.delete(taskOp.id);
          else {
            const existingTask = item.tasks.get(taskOp.id);
            if (existingTask) {
              if (taskOp.status) existingTask.status = taskOp.status;
              if (taskOp.subject) existingTask.subject = taskOp.subject;
              if (taskOp.activeForm) existingTask.activeForm = taskOp.activeForm;
            } else if (taskOp.subject && item.tasks.size < PLAN_LIMIT) {
              item.tasks.set(taskOp.id, { subject: taskOp.subject, activeForm: taskOp.activeForm, status: taskOp.status || 'pending' });
            }
          }
        }
        syncTasksToPlan(item);
      }
      // The workspace footprint counts and offers only files inside the folder; a scratch
      // file elsewhere could not be opened from this window anyway.
      const rooted = typeof root === 'string' && path.isAbsolute(root);
      for (const file of files) {
        const abs = path.resolve(file);
        if (rooted && !isInside(root, abs)) continue;
        if (item.files.size < FILE_LIMIT) item.files.add(fileId(abs));
        const display = pathOf(abs, root);
        if (display) {
          item.fileEntries = [{ abs, display }, ...item.fileEntries.filter(entry => entry.abs !== abs)].slice(0, CHANGED_FILE_VIEW_LIMIT);
          rememberLookup(item, display, abs);
          rememberLookup(item, abs, abs);
        }
      }
      return true;
    },
    resolveFile(key, file) {
      if (typeof file !== 'string' || !file) return;
      const item = sessions.get(key);
      if (!item) return;
      if (now() - item.at >= ttl) { sessions.delete(key); return; }
      const entry = item.fileEntries.find(candidate => candidate.display === file || candidate.abs === file);
      if (entry) return entry.abs;
      return item.fileLookup.get(file);
    },
    get(key) {
      const item = sessions.get(key);
      if (!item) return;
      if (now() - item.at >= ttl) { sessions.delete(key); return; }
      const view = {};
      if (item.prompt) view.prompt = item.prompt;
      if (item.reply) view.reply = item.reply;
      if (item.focus) view.focus = item.focus;
      if (item.steps.length) {
        view.activity = { ...item.steps[0] };
        view.steps = item.steps.map(entry => ({ ...entry }));
      }
      if (item.progress) view.progress = { ...item.progress };
      if (item.plan?.length) view.plan = item.plan.map(entry => ({ ...entry }));
      if (item.files.size) view.changed = item.files.size;
      if (item.fileEntries.length) view.changedFiles = item.fileEntries.map(entry => entry.display);
      return Object.keys(view).length ? view : undefined;
    },
    // A session updated after the scan that judged it may be one that scan has not read yet.
    prune(keep, since) {
      for (const [key, item] of sessions) if (item.at < since && !keep(key)) sessions.delete(key);
    },
    clear() { sessions.clear(); },
    get size() { return sessions.size; },
  };
}

module.exports = { activityFor, acceptedActivity, createActivity, stepTarget, patchFiles, planProgress, planItems,
  PROMPT_LIMIT, REPLY_LIMIT, TARGET_LIMIT, STEP_LIMIT, FILE_LIMIT, CHANGED_FILE_VIEW_LIMIT, PLAN_ITEM_LIMIT };
