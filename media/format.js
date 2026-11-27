// Pure formatting and ordering used by the panel. Kept free of the DOM so the
// same file runs in the webview and under the test runner.
(root => {
  'use strict';
  const { t, phrase, locale, perLocale } = typeof module === 'object' && module.exports ? require('./i18n.js') : root.AgentSessionI18n;
  const oneDecimal = perLocale(tag => new Intl.NumberFormat(tag, {maximumFractionDigits: 1}));
  // Whole minutes only: a row that just changed needs no number next to it.
  function sinceText(kind, from, now = Date.now()) {
    const minutes = Math.floor((now - Number(from)) / 60000);
    if (!(minutes >= 1)) return '';
    const amount = minutes < 60 ? t('{0}m', minutes) : minutes < 1440 ? t('{0}h', Math.floor(minutes / 60)) : t('{0}d', Math.floor(minutes / 1440));
    return kind === 'ago' ? t('{0} ago', amount) : amount;
  }
  function remainingText(expiresAt, now = Date.now()) {
    const seconds = Math.max(0, Math.ceil((Number(expiresAt) - now) / 1000));
    return seconds >= 60 ? t('{0}m {1}s left', Math.floor(seconds / 60), seconds % 60) : t('{0}s left', seconds);
  }
  // Concise relative countdown until a subscription quota window resets.
  function resetInText(resetsAt, now = Date.now()) {
    const ms = Number(resetsAt) - now;
    if (!(ms > 0) || !Number.isFinite(ms)) return '';
    if (ms < 60000) return t('soon');
    const minutes = Math.ceil(ms / 60000);
    if (minutes < 60) return t('in {0}m', minutes);
    const hours = Math.floor(minutes / 60);
    const rem = minutes % 60;
    if (hours < 24) return rem ? t('in {0}h {1}m', hours, rem) : t('in {0}h', hours);
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return remHours ? t('in {0}d {1}h', days, remHours) : t('in {0}d', days);
  }
  function diffStats(before, after) {
    const ops = lineChanges(before ? before.split('\n') : [], after ? after.split('\n') : []);
    let added = 0, removed = 0;
    for (const [kind] of ops) {
      if (kind === 'added') added++;
      else if (kind === 'removed') removed++;
    }
    return { added, removed };
  }
  function percentLabel(value) {
    if (value > 0 && value < .1) return '<0.1';
    if (value < 100 && value > 99.9) return '>99.9';
    return oneDecimal().format(value);
  }
  function byteSizeText(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n < 0) return '0B';
    if (n < 1024) return Math.round(n) + 'B';
    const kb = n / 1024;
    if (kb < 1024) return (kb >= 10 ? Math.round(kb) : oneDecimal().format(kb)) + 'KB';
    return oneDecimal().format(kb / 1024) + 'MB';
  }
  const leftOf = window => window.kind === 'remaining' ? window.percent : 100 - window.percent;
  // Text from a request is shown exactly as it will be used. Whatever a reader
  // cannot see, or that reorders what they do see, is written out as an escape:
  // controls, format and bidirectional characters, default-ignorable code points,
  // line and paragraph separators. A joiner or presentation selector stays only
  // inside an emoji, where it is what makes it one picture.
  const picture = '\\p{Extended_Pictographic}(?:' + String.fromCodePoint(0xFE0F) + '|\\p{Emoji_Modifier})?';
  const unseen = new RegExp('(' + picture + '(?:' + String.fromCodePoint(0x200D) + picture + ')*)|' +
    '[\\p{Cc}\\p{Cf}\\p{Default_Ignorable_Code_Point}\\p{Zl}\\p{Zp}' + String.fromCodePoint(0x2800) + ']', 'gu');
  function escaped(character) {
    const point = character.codePointAt(0);
    return point > 0xFFFF ? '\\u{' + point.toString(16) + '}' : '\\u' + point.toString(16).padStart(4, '0');
  }
  const visible = value => String(value).replace(unseen, (match, emoji) =>
    emoji !== undefined || match === '\t' || match === '\n' ? match : escaped(match));
  // In a command, a space other than the plain one does not split words for a shell,
  // though it looks as if it did. It is written out like anything else that misleads.
  const visibleCommand = value => visible(value).replace(/[^\S \t\n\r]/g, escaped);
  // An argument list keeps its word boundaries: a word a shell would split or
  // interpret is quoted, so the line reads as what will actually run.
  const shellWord = word => /^[A-Za-z0-9_@%+=:,.\/-]+$/.test(word) ? word : "'" + word.replaceAll("'", "'\\''") + "'";
  const shellJoin = words => words.map(shellWord).join(' ');
  // A long run of empty lines is folded into a count, so nothing can hide below blank space.
  function foldBlankRuns(value) {
    const text = String(value);
    const parts = [];
    let last = 0;
    for (const match of text.matchAll(/(?:^[^\S\n]*\n){4,}/gm)) {
      if (match.index > last) parts.push({ text: text.slice(last, match.index) });
      parts.push({ blank: match[0].split('\n').length - 1 });
      last = match.index + match[0].length;
    }
    if (last < text.length || !parts.length) parts.push({ text: text.slice(last) });
    return parts;
  }
  // Line operations between two texts. Small inputs get a real diff; anything
  // larger falls back to trimming the lines both ends share.
  function lineChanges(old, next) {
    const ops = [];
    if (old.length * next.length > 60000) {
      let head = 0;
      while (head < old.length && head < next.length && old[head] === next[head]) head++;
      let tail = 0;
      while (tail < old.length - head && tail < next.length - head && old[old.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
      for (const value of old.slice(0, head)) ops.push(['same', value]);
      for (const value of old.slice(head, old.length - tail)) ops.push(['removed', value]);
      for (const value of next.slice(head, next.length - tail)) ops.push(['added', value]);
      for (const value of old.slice(old.length - tail)) ops.push(['same', value]);
      return ops;
    }
    const width = next.length + 1;
    const common = new Uint16Array((old.length + 1) * width);
    for (let i = old.length - 1; i >= 0; i--) for (let j = next.length - 1; j >= 0; j--) {
      common[i * width + j] = old[i] === next[j] ? common[(i + 1) * width + j + 1] + 1 :
        Math.max(common[(i + 1) * width + j], common[i * width + j + 1]);
    }
    let i = 0, j = 0;
    while (i < old.length || j < next.length) {
      if (i < old.length && j < next.length && old[i] === next[j]) { ops.push(['same', old[i]]); i++; j++; }
      else if (i < old.length && (j === next.length || common[(i + 1) * width + j] >= common[i * width + j + 1])) ops.push(['removed', old[i++]]);
      else ops.push(['added', next[j++]]);
    }
    return ops;
  }
  const GEMINI_EFFORT_SUFFIX = /-(?:minimal|low|medium|high|xhigh|max|ultra)$/i;
  const formatGemini = value => value.split('-').filter(Boolean)
    .map(part => /^\d/.test(part) ? part : part[0].toUpperCase() + part.slice(1).toLowerCase()).join(' ');
  const GPT_TOKENS = { codex: 'Codex', spark: 'Spark', astra: 'Astra', pro: 'Pro', max: 'Max', turbo: 'Turbo', mini: 'mini', nano: 'nano' };
  const CLAUDE_ALIASES = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable', mythos: 'Mythos', opusplan: 'Opus Plan' };
  const CLAUDE_SUFFIX = '(?:(?:-v\\d+)?(?:-(?:latest|thinking|fast))?(?:[-@]\\d{8})?(?:-(?:latest|thinking|fast))?(?:-v\\d+)?(?::\\d+)?)?$';
  const CLAUDE_FAMILY_RE = new RegExp('^claude-([a-z]+)-(\\d+)(?:-(\\d{1,3}))?' + CLAUDE_SUFFIX, 'i');
  const CLAUDE_LEGACY_RE = new RegExp('^claude-(\\d+)(?:-(\\d{1,3}))?-([a-z]+)' + CLAUDE_SUFFIX, 'i');
  function modelName(model, execution, id) {
    if (!model) return '';
    if (id === 'agy' && execution?.modelSource === 'call' && execution.effortSource === 'call' &&
        execution.effort && model.toLowerCase().endsWith('-' + execution.effort.toLowerCase())) {
      const base = model.slice(0, -(execution.effort.length + 1));
      if (/^gemini-/i.test(base)) return formatGemini(base);
      return base;
    }
    if (/^gemini-\d/i.test(model) && !GEMINI_EFFORT_SUFFIX.test(model)) return formatGemini(model);
    if (/^gpt-/i.test(model)) {
      const stripped = model.replace(/-\d{4}-\d{2}-\d{2}$/, '');
      const parts = stripped.slice(4).split('-');
      let cut = parts.length;
      while (cut > 1 && (Object.hasOwn(GPT_TOKENS, parts[cut - 1].toLowerCase()) || /^[a-z]{3,}$/i.test(parts[cut - 1]))) cut--;
      const head = 'GPT-' + parts.slice(0, cut).join('-');
      const tail = parts.slice(cut).map(part => {
        const lower = part.toLowerCase();
        return Object.hasOwn(GPT_TOKENS, lower) ? GPT_TOKENS[lower] : lower[0].toUpperCase() + lower.slice(1);
      });
      return [head, ...tail].join(' ');
    }
    if (/^o\d/i.test(model)) return model.replace(/-\d{4}-\d{2}-\d{2}$/, '');
    // Any Claude family reads as "Family 5.2"; a date suffix or Bedrock/Vertex revision is a snapshot, not a version.
    const wide = /\[1m\]$/i.test(model);
    const raw = wide ? model.slice(0, -4) : model;
    const base = raw.replace(/^(?:(?:[a-z]{2,6}\.)?anthropic\.|anthropic\/)/i, '');
    const aliasKey = base.toLowerCase();
    if (Object.hasOwn(CLAUDE_ALIASES, aliasKey)) return CLAUDE_ALIASES[aliasKey] + (wide ? ' (1M)' : '');
    const family = CLAUDE_FAMILY_RE.exec(base);
    const legacy = family ? undefined : CLAUDE_LEGACY_RE.exec(base);
    const [name, major, minor] = family ? [family[1], family[2], family[3]] : legacy ? [legacy[3], legacy[1], legacy[2]] : [];
    if (!name) return model;
    return name[0].toUpperCase() + name.slice(1).toLowerCase() + ' ' + major + (minor ? '.' + minor : '') + (wide ? ' (1M)' : '');
  }
  // A quota window is named by what it limits (nothing for the whole account) and by
  // its period: a number of minutes, a known period, or the provider's own word for it.
  // Neither is stored in a display language, so a cached window reads right in any.
  const PERIOD_MINUTES = { session: 300, hourly: 60, daily: 1440, weekly: 10080, monthly: 43200, primary: 1, secondary: 10080 };
  const PERIOD_LABELS = {
    session: phrase('Session'), hourly: phrase('Hourly'), daily: phrase('Daily'), weekly: phrase('Weekly'), monthly: phrase('Monthly'),
    primary: phrase('Primary window'), secondary: phrase('Secondary window'),
  };
  const QUOTA_NAMES = { 'OAuth apps': phrase('OAuth apps') };
  const isMinutes = period => Number.isSafeInteger(period) && period > 0;
  function periodMinutes(period) {
    if (isMinutes(period)) return period;
    return typeof period === 'string' && Object.hasOwn(PERIOD_MINUTES, period) ? PERIOD_MINUTES[period] : Infinity;
  }
  function periodLabel(period) {
    if (isMinutes(period)) {
      if (period === 10080) return t('Weekly');
      if (period % 1440 === 0) return t('{0}d', period / 1440);
      if (period % 60 === 0) return t('{0}h', period / 60);
      return t('{0}m', period);
    }
    if (typeof period !== 'string') return '';
    return Object.hasOwn(PERIOD_LABELS, period) ? t(PERIOD_LABELS[period]) : period;
  }
  const quotaName = name => typeof name !== 'string' ? '' : Object.hasOwn(QUOTA_NAMES, name) ? t(QUOTA_NAMES[name]) : name;
  const quotaLabel = w => [quotaName(w?.name), periodLabel(w?.period)].filter(Boolean).join(' · ');
  // The same window keeps one identity whatever language it is shown in.
  const quotaKey = w => (w?.name || '') + '|' + (w?.period ?? '');
  const windowDuration = w => periodMinutes(w.period);
  function representativeWindow(id, windows) {
    if (!windows.length) return;
    // Account-wide windows come first. Antigravity reports only model groups.
    const general = windows.filter(w => !w.name && Number.isFinite(windowDuration(w)));
    const gemini = id === 'agy' ? windows.filter(w => /^Gemini\b/i.test(w.name || '') && periodLabel(w.period)) : [];
    const candidates = general.length ? general : gemini.length ? gemini : windows;
    // The limit that runs out first is the one to watch; a tie goes to the shorter window.
    return candidates.reduce((best, w) => leftOf(w) < leftOf(best) ||
      leftOf(w) === leftOf(best) && windowDuration(w) < windowDuration(best) ? w : best);
  }
  function shortName(name) {
    const full = quotaName(name);
    if (/^Gemini Models$/i.test(full)) return 'Gemini';
    if (/^Claude and GPT models$/i.test(full)) return 'Claude/GPT';
    return full;
  }
  function shortLimitLabel(w) {
    const short = shortName(w?.name);
    return [short, periodLabel(w?.period)].filter(Boolean).join(short !== quotaName(w?.name) ? ' ' : ' · ');
  }
  // What a limit other than the account's own is named by, without its period: "Opus · Weekly" is "Opus".
  // A limit that is nothing but a period keeps it.
  const limitName = w => shortName(w?.name) || periodLabel(w?.period);
  const isWait = row => Boolean(row && (row.status === 'input' || row.status === 'approval') && !row.quiet);
  // Requests with something to show: answerable here (action) or readable only (preview).
  function digest(text) {
    let hash = 5381;
    for (let at = 0; at < text.length; at++) hash = (hash * 33 ^ text.charCodeAt(at)) >>> 0;
    return hash.toString(36);
  }
  // A read-only request is told apart by what it asks, so two in a row from one session are two requests.
  const requestToken = row => !isWait(row) ? undefined : row.action?.token || (row.preview
    ? 'preview:' + row.key + ':' + (row.waitSince || 0) + ':' + digest((row.preview.tool || '') + '\n' + (row.preview.detail || '')) : undefined);
  // Closing a request is remembered for that wait of that session, whether it can
  // still be answered here or has become read-only in the meantime.
  const dismissKey = row => row.key + '|' + (row.waitSince || 0);
  // Most important first: answerable inline requests (soonest deadline first) before
  // read-only previews, then a question before an approval, then whoever has waited longest.
  function requestOrder(sessions) {
    return sessions.filter(requestToken).sort((a, b) => {
      const actionDiff = (a.action ? 0 : 1) - (b.action ? 0 : 1);
      if (actionDiff) return actionDiff;
      const deadlineA = Number.isSafeInteger(a.action?.expiresAt) ? a.action.expiresAt : Infinity;
      const deadlineB = Number.isSafeInteger(b.action?.expiresAt) ? b.action.expiresAt : Infinity;
      if (deadlineA !== deadlineB) return deadlineA - deadlineB;
      return (a.status === 'input' ? 0 : 1) - (b.status === 'input' ? 0 : 1) ||
        (a.waitSince || a.updatedAt) - (b.waitSince || b.updatedAt) || a.key.localeCompare(b.key);
    });
  }
  // Tool names as the three agents report them, grouped by what a step does.
  // An unknown name is shown as it is rather than guessed at.
  const toolKinds = [
    ['command', phrase('Run command'), /^(bash|shell|shell_command|exec_command|run_command|run_terminal_cmd|local_shell|unified_exec|write_stdin|command_status|send_command_input|read_terminal|manage_task)$/i],
    ['patch', phrase('Edit file'), /^(edit|multiedit|apply_patch|str_replace_editor|replace_file_content|multi_replace_file_content|notebookedit|edit_file)$/i],
    ['write', phrase('Write file'), /^(write|write_file|write_to_file|create_file)$/i],
    ['read', phrase('Read file'), /^(read|read_file|view_file|view_image|view_file_outline|view_code_item|view|open_file|notebookread|read_mcp_resource|readmcpresourcetool)$/i],
    ['search', phrase('Search'), /^(grep|grep_files|glob|ls|list_dir|find_by_name|grep_search|codebase_search|search_files|toolsearch|tool_search|list_mcp_resources|list_mcp_resource_templates|lsp|listmcpresourcestool)$/i],
    ['web', phrase('Web lookup'), /^(webfetch|websearch|web_search|search_query|read_url_content|search_web)$/i],
    ['agent', phrase('Subtask'), /^(task|agent|spawn_agent|invoke_subagent|define_subagent|manage_subagents|run_workflow|swarm|browser_subagent|workflow|wait_agent|wait|send_input|send_message|sendmessage|teamcreate|teamdelete|followup_task|close_agent|resume_agent|interrupt_agent|list_agents|taskoutput|taskstop)$/i],
    ['plan', phrase('Update plan'), /^(todowrite|update_plan|update_steps|taskcreate|taskupdate|tasklist|taskget|exitplanmode|enterplanmode|task_boundary|croncreate|crondelete|cronlist|schedule)$/i],
    ['focus', phrase('Progress'), /^update_focus$/i],
    ['skill', phrase('Run skill'), /^skill$/i],
    ['permission', phrase('Permission request'), /^(ask_permission|request_permissions)$/i],
    ['question', phrase('Question'), /^(askuserquestion|request_user_input|ask_question|notify_user)$/i],
  ];
  const TOOL_KIND_CACHE = new Map();
  const TOOL_KIND_EMPTY = Object.freeze({ kind: 'other', label: '' });
  const MCP_TOOL_RE = /^mcp__(.+?)__(.+)$/;
  function toolKind(tool) {
    if (typeof tool !== 'string' || !tool) return TOOL_KIND_EMPTY;
    const cacheKey = locale() + '\0' + tool;
    const cached = TOOL_KIND_CACHE.get(cacheKey);
    if (cached) return cached;
    let result;
    for (const [kind, label, pattern] of toolKinds) {
      if (pattern.test(tool)) { result = Object.freeze({ kind, label: t(label) }); break; }
    }
    if (!result) {
      const mcp = MCP_TOOL_RE.exec(tool);
      result = Object.freeze({ kind: 'other', label: mcp ? mcp[1] + ' · ' + mcp[2] : tool });
    }
    if (TOOL_KIND_CACHE.size >= 256) TOOL_KIND_CACHE.delete(TOOL_KIND_CACHE.keys().next().value);
    TOOL_KIND_CACHE.set(cacheKey, result);
    return result;
  }
  const oneLine = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  function stepText(step) {
    if (!step) return '';
    return [toolKind(step.tool).label, oneLine(step.target)].filter(Boolean).join(' · ');
  }
  function parseInput(detail) {
    try {
      const value = JSON.parse(detail);
      if (typeof value === 'string' && value.trimStart().startsWith('*** Begin Patch')) return { patch: value };
      if (value?._truncated && typeof value.value === 'string' && value.value.trimStart().startsWith('*** Begin Patch')) {
        const { value: patch, ...metadata } = value;
        return { ...metadata, patch };
      }
      return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
    } catch { return; }
  }
  const pathTail = file => String(file).split(/[\\/]/).filter(Boolean).slice(-2).join('/');
  const PATCH_FILE_RE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
  const PATCH_TARGET_RE = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm;
  const PATCH_HEADER_RE = /^\*\*\* (Add|Update|Delete) File:\s*(.+)$/;
  const PATCH_MOVE_RE = /^\*\*\* Move to:\s*(.+)$/;
  const CONTROL_CHAR_RE = /[\0-\x1f\x7f]/;
  const FILE_KEYS = ['file_path', 'filePath', 'notebook_path', 'path', 'Path', 'File', 'TargetFile', 'AbsolutePath'];
  const REQUEST_PATH_KEYS = ['file_path', 'filePath', 'notebook_path', 'planFilePath', 'path', 'Path', 'File', 'TargetFile', 'AbsolutePath'];
  const PATH_INPUT_KEYS = new Set(REQUEST_PATH_KEYS);
  const PATCH_KEYS = ['command', 'patch', 'input'];
  const CMD_KEYS = ['command', 'cmd', 'CommandLine'];
  const EDIT_PAIRS = [['old_string', 'new_string'], ['Target', 'Replacement'], ['TargetContent', 'ReplacementContent']];
  const CONTENT_KEYS = ['content', 'Content', 'CodeContent'];
  const CMD_NOTE_KEYS = ['description', 'justification', 'Description', 'toolSummary'];
  const EDIT_NOTE_KEYS = ['Description', 'toolSummary'];
  const REASON_NOTE_KEYS = ['reason'];
  const CWD_KEYS = ['workdir', 'cwd', 'Cwd'];
  const INPUT_TARGET_KEYS = [
    ...CMD_KEYS, ...REQUEST_PATH_KEYS,
    'pattern', 'Pattern', 'query', 'Query', 'url', 'Url', 'focus', 'skill', 'task_name', 'reason',
    'description', 'Description', 'Message', 'prompt', 'Prompt', 'chars',
  ];
  function previewQuestions(input) {
    if (!input || typeof input !== 'object' || !Array.isArray(input.questions) || !input.questions.length) return;
    const list = [];
    for (const item of input.questions) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return;
      if (typeof item.question !== 'string' || !item.question.trim()) return;
      const choices = [];
      if (item.options !== undefined) {
        if (!Array.isArray(item.options)) return;
        for (const opt of item.options) {
          if (typeof opt === 'string' && opt.trim()) {
            choices.push({ label: opt, description: '' });
          } else if (opt && typeof opt === 'object' && !Array.isArray(opt) && typeof opt.label === 'string' && opt.label.trim()) {
            choices.push({ label: opt.label, description: typeof opt.description === 'string' ? opt.description : '' });
          } else {
            return;
          }
        }
      }
      list.push({
        question: item.question,
        header: typeof item.header === 'string' ? item.header.trim() : '',
        multiSelect: item.multiSelect === true || item.is_multi_select === true,
        isOther: item.isOther === true,
        choices,
      });
    }
    return list;
  }
  function patchKeyOf(input) {
    if (!input) return;
    return PATCH_KEYS.find(key => typeof input[key] === 'string' && input[key].trimStart().startsWith('*** Begin Patch'));
  }
  function patchFilesOf(patch) {
    const files = [];
    if (typeof patch !== 'string') return files;
    for (const [, name] of patch.matchAll(PATCH_FILE_RE)) {
      const clean = name.trim();
      if (clean && !files.includes(clean)) files.push(clean);
      if (files.length >= 16) break;
    }
    return files;
  }
  function requestFilePaths(detail, tool) {
    if (typeof detail !== 'string') return [];
    const found = [];
    const seen = new Set();
    const addPath = candidate => {
      if (typeof candidate !== 'string') return;
      const clean = candidate.trim();
      if (clean && clean.length <= 4096 && !CONTROL_CHAR_RE.test(clean) && !seen.has(clean)) {
        seen.add(clean);
        found.push(clean);
      }
    };
    const addPatchPaths = body => {
      if (typeof body !== 'string') return;
      for (const [, name] of body.matchAll(PATCH_TARGET_RE)) {
        addPath(name);
        if (found.length >= 64) break;
      }
    };
    const parsed = parseInput(detail);
    if (!parsed) {
      if (tool === 'apply_patch' || detail.trimStart().startsWith('*** Begin Patch')) {
        addPatchPaths(detail);
      }
      return found;
    }
    for (const key of REQUEST_PATH_KEYS) addPath(parsed[key]);
    const perms = parsed.permissions;
    if (perms && typeof perms === 'object' && !Array.isArray(perms)) {
      const fsPerms = perms.file_system || perms.filesystem;
      if (fsPerms && typeof fsPerms === 'object' && !Array.isArray(fsPerms)) {
        for (const access of ['read', 'write']) {
          const entry = fsPerms[access];
          if (typeof entry === 'string') addPath(entry);
          else if (Array.isArray(entry)) for (const item of entry) addPath(item);
        }
      }
    }
    const patchKey = patchKeyOf(parsed);
    const body = patchKey ? parsed[patchKey] : (tool === 'apply_patch' ? PATCH_KEYS.map(key => parsed[key]).find(value => typeof value === 'string') : undefined);
    addPatchPaths(body);
    return found;
  }
  function parseApplyPatch(patch) {
    if (typeof patch !== 'string') return [];
    const rawLines = patch.replace(/\r\n/g, '\n').split('\n');
    const start = rawLines.findIndex(line => line.trim() === '*** Begin Patch');
    if (start < 0) return [];
    for (let i = 0; i < start; i++) if (rawLines[i].trim()) return [];
    const sections = [];
    let current;
    let endIndex = rawLines.length;
    for (let i = start + 1; i < rawLines.length; i++) {
      const line = rawLines[i];
      if (line.trim() === '*** End Patch') {
        endIndex = i;
        break;
      }
      const header = PATCH_HEADER_RE.exec(line);
      if (header) {
        const filePath = header[2].trim();
        if (!filePath) return [];
        current = { op: header[1].toLowerCase(), path: filePath, moveTo: '', lines: [], stats: { added: 0, removed: 0 }, rawLines: [line] };
        sections.push(current);
        continue;
      }
      if (!current) {
        if (line.trim()) return [];
        continue;
      }
      current.rawLines.push(line);
      const move = PATCH_MOVE_RE.exec(line);
      if (move) {
        current.moveTo = move[1].trim();
      } else if (line.trim() === '*** End of File') {
        // Metadata marker kept in rawLines only.
      } else if (line.startsWith('@@')) {
        current.lines.push(['hunk', line]);
      } else if (line.startsWith('+')) {
        current.lines.push(['added', line.slice(1)]);
        current.stats.added++;
      } else if (line.startsWith('-')) {
        current.lines.push(['removed', line.slice(1)]);
        current.stats.removed++;
      } else if (line.startsWith(' ')) {
        current.lines.push(['same', line.slice(1)]);
      } else if (line !== '') {
        current.lines.push(['same', line]);
      } else if (current.lines.length && i < rawLines.length - 1 && rawLines[i + 1].trim() !== '*** End Patch') {
        current.lines.push(['same', '']);
      }
    }
    for (let i = endIndex + 1; i < rawLines.length; i++) if (rawLines[i].trim()) return [];
    return sections.map(({ rawLines: chunk, ...rest }) => ({ ...rest, raw: chunk.join('\n') }));
  }
  // The one argument that says what a call is about: the command, the file, the query.
  function inputTarget(input) {
    if (!input) return '';
    const qs = previewQuestions(input);
    if (qs) return oneLine(qs[0].question);
    const patchKey = patchKeyOf(input);
    if (patchKey) {
      const files = patchFilesOf(input[patchKey]);
      if (files.length > 1) return t('{0} and {1} more', pathTail(files[0]), files.length - 1);
      if (files.length === 1) return pathTail(files[0]);
    }
    const cmdWordsKey = ['command', 'cmd'].find(key =>
      Array.isArray(input[key]) && input[key].length > 0 && input[key].every(part => typeof part === 'string'));
    if (cmdWordsKey) {
      return oneLine(shellJoin(input[cmdWordsKey]));
    }
    if (typeof input.plan === 'string' && input.plan.trim()) {
      const heading = input.plan.split('\n').map(line => line.replace(/^\s*#+\s*/, '').trim()).find(Boolean);
      if (heading) return oneLine(heading);
    }
    for (const key of INPUT_TARGET_KEYS) {
      if (typeof input[key] !== 'string' || !input[key].trim()) continue;
      const first = input[key].trim().split('\n')[0];
      return PATH_INPUT_KEYS.has(key) ? pathTail(first) : oneLine(first);
    }
    return '';
  }
  const asText = value => typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  const PERMISSION_LABELS = {
    file_system: phrase('File system'), filesystem: phrase('File system'),
    network: phrase('Network'), env: phrase('Environment variables'), macos: 'macOS',
    read: phrase('Read'), write: phrase('Write'), enabled: phrase('Allowed'), hosts: phrase('Hosts'), domains: phrase('Domains'),
  };
  function formatPermissionFields(obj, prefix = '') {
    const out = [];
    const labelOf = key => Object.hasOwn(PERMISSION_LABELS, key) ? t(PERMISSION_LABELS[key]) : key;
    for (const [key, value] of Object.entries(obj)) {
      const name = prefix ? prefix + ' · ' + labelOf(key) : labelOf(key);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const nested = formatPermissionFields(value, name);
        if (nested.length) out.push(...nested);
        else out.push({ kind: 'field', name, value: '{}' });
      } else if (Array.isArray(value)) {
        out.push({ kind: 'field', name, value: value.length ? value.map(asText).join(', ') : t('(none)') });
      } else if (typeof value === 'boolean') {
        out.push({ kind: 'field', name, value: value ? t('Yes') : t('No') });
      } else {
        out.push({ kind: 'field', name, value: asText(value) });
      }
    }
    return out;
  }
  // What a request will do, as blocks to show in order. An argument counts as
  // shown only when its value is actually on screen; everything else is listed
  // by name, so nothing that changes the call is left out of view.
  function requestBlocks(detail, cwd) {
    const blocks = [];
    const input = parseInput(detail);
    const place = () => { if (cwd) blocks.push({ kind: 'field', name: t('Working directory'), value: cwd }); };
    if (!input) {
      if (detail) blocks.push({ kind: 'code', text: detail, label: t('Full request') });
      place();
      return blocks;
    }
    const shown = new Set();
    const trunc = input._truncated;
    if (trunc && typeof trunc === 'object' && !Array.isArray(trunc)) {
      const totalBytes = Number(trunc.totalBytes);
      const shownBytes = Number(trunc.shownBytes);
      if (Number.isFinite(totalBytes) && totalBytes > 0 && Number.isFinite(shownBytes) && shownBytes >= 0) {
        shown.add('_truncated');
        blocks.push({ kind: 'truncated', totalBytes: Math.round(totalBytes), shownBytes: Math.round(shownBytes) });
      }
    }
    const isText = key => typeof input[key] === 'string';
    const promoteNote = keys => {
      const key = keys.find(k => !shown.has(k) && isText(k) && input[k].trim());
      if (!key) return;
      shown.add(key);
      blocks.push({ kind: 'note', text: input[key] });
    };
    const qs = previewQuestions(input);
    const fileKey = FILE_KEYS.find(isText);
    const patchKey = patchKeyOf(input);
    const cmdKey = !patchKey ? CMD_KEYS.find(isText) : undefined;
    const cmdWordsKey = ['command', 'cmd'].find(key =>
      Array.isArray(input[key]) && input[key].length > 0 && input[key].every(part => typeof part === 'string'));
    const editPair = EDIT_PAIRS.find(([oldKey, newKey]) => oldKey in input || newKey in input);
    const edited = editPair ? editPair.filter(key => key in input) : [];
    const contentKey = CONTENT_KEYS.find(isText);
    const hasEditLike = Boolean(editPair || 'edits' in input || 'ReplacementChunks' in input || 'new_source' in input ||
      CONTENT_KEYS.some(key => key in input));
    if (qs) {
      shown.add('questions');
      blocks.push({ kind: 'questions', questions: qs });
    } else if (patchKey) {
      shown.add(patchKey);
      const sections = parseApplyPatch(input[patchKey]);
      if (sections.length) {
        for (const section of sections) {
          blocks.push({
            kind: 'path',
            text: section.moveTo ? section.path + ' → ' + section.moveTo : section.path,
            file: section.moveTo || section.path,
            stats: section.stats,
          });
          blocks.push({ kind: 'patch', lines: section.lines, raw: section.raw });
        }
      } else {
        for (const file of patchFilesOf(input[patchKey])) blocks.push({ kind: 'path', text: file });
        blocks.push({ kind: 'code', text: input[patchKey], label: t('Patch') });
      }
    } else if (cmdWordsKey || cmdKey) {
      shown.add(cmdWordsKey || cmdKey);
      promoteNote(CMD_NOTE_KEYS);
      blocks.push({ kind: 'code', text: cmdWordsKey ? shellJoin(input[cmdWordsKey]) : input[cmdKey], label: t('Command to run') });
    } else if (isText('plan')) {
      shown.add('plan');
      if (isText('planFilePath')) {
        shown.add('planFilePath');
        blocks.push({ kind: 'path', text: input.planFilePath });
      }
      blocks.push({ kind: 'code', text: input.plan, label: t('Plan') });
    } else if (fileKey && isText('new_source')) {
      shown.add(fileKey);
      shown.add('new_source');
      blocks.push({ kind: 'path', text: input[fileKey] }, { kind: 'code', text: input.new_source, label: t('New cell content') });
    } else if (fileKey && edited.length && edited.every(isText)) {
      promoteNote(EDIT_NOTE_KEYS);
      for (const key of [fileKey, ...edited]) shown.add(key);
      blocks.push({ kind: 'path', text: input[fileKey] }, { kind: 'change', before: input[editPair[0]] || '', after: input[editPair[1]] || '' });
    } else if (fileKey && Array.isArray(input.edits) && input.edits.length && input.edits.every(edit => edit && typeof edit === 'object' &&
        !Array.isArray(edit) && typeof edit.old_string === 'string' && typeof edit.new_string === 'string')) {
      shown.add(fileKey);
      shown.add('edits');
      blocks.push({ kind: 'path', text: input[fileKey] });
      input.edits.forEach((edit, at) => {
        blocks.push({ kind: 'change', before: edit.old_string, after: edit.new_string });
        for (const [key, value] of Object.entries(edit)) {
          if (key !== 'old_string' && key !== 'new_string') blocks.push({ kind: 'field', name: 'edits[' + at + '].' + key, value: asText(value) });
        }
      });
    } else if (fileKey && Array.isArray(input.ReplacementChunks) && input.ReplacementChunks.length &&
        input.ReplacementChunks.every(chunk => chunk && typeof chunk === 'object' && !Array.isArray(chunk) &&
          typeof chunk.TargetContent === 'string' && typeof chunk.ReplacementContent === 'string')) {
      promoteNote(EDIT_NOTE_KEYS);
      shown.add(fileKey);
      shown.add('ReplacementChunks');
      blocks.push({ kind: 'path', text: input[fileKey] });
      input.ReplacementChunks.forEach((chunk, at) => {
        blocks.push({ kind: 'change', before: chunk.TargetContent, after: chunk.ReplacementContent });
        for (const [key, value] of Object.entries(chunk)) {
          if (key !== 'TargetContent' && key !== 'ReplacementContent') {
            blocks.push({ kind: 'field', name: 'ReplacementChunks[' + at + '].' + key, value: asText(value) });
          }
        }
      });
    } else if (fileKey && contentKey) {
      promoteNote(EDIT_NOTE_KEYS);
      shown.add(fileKey);
      shown.add(contentKey);
      // Writing a file replaces all of it; an empty one is still a change.
      blocks.push({ kind: 'path', text: input[fileKey] }, { kind: 'content', text: input[contentKey] });
    } else if (fileKey && !hasEditLike && input[fileKey].trim()) {
      promoteNote(EDIT_NOTE_KEYS);
      shown.add(fileKey);
      blocks.push({ kind: 'path', text: input[fileKey] });
    } else if (input.permissions != null && (isText('reason') || (typeof input.permissions === 'object' && !Array.isArray(input.permissions)))) {
      promoteNote(REASON_NOTE_KEYS);
      if (input.permissions && typeof input.permissions === 'object' && !Array.isArray(input.permissions)) {
        shown.add('permissions');
        const permFields = formatPermissionFields(input.permissions);
        if (permFields.length) blocks.push(...permFields);
        else blocks.push({ kind: 'field', name: t('Permissions'), value: '{}' });
      }
    }
    if (!shown.has('planFilePath') && isText('planFilePath') && input.planFilePath.trim()) {
      shown.add('planFilePath');
      blocks.push({ kind: 'path', text: input.planFilePath });
    }
    if (!shown.has('allowedPrompts') && Array.isArray(input.allowedPrompts) &&
        input.allowedPrompts.every(item => item && typeof item === 'object' && !Array.isArray(item) &&
          typeof item.tool === 'string' && typeof item.prompt === 'string')) {
      shown.add('allowedPrompts');
      for (const item of input.allowedPrompts) {
        const extra = Object.entries(item).filter(([k]) => k !== 'tool' && k !== 'prompt');
        const summary = [item.tool.trim(), item.prompt.trim()].filter(Boolean).join(' · ') +
          (extra.length ? ' (' + extra.map(([k, v]) => k + ': ' + asText(v)).join(', ') + ')' : '');
        blocks.push({ kind: 'field', name: t('Allowed prompt'), value: summary });
      }
    }
    for (const [key, value] of Object.entries(input)) {
      if (shown.has(key)) continue;
      if (typeof value === 'string' && value.includes('\n')) blocks.push({ kind: 'long', name: key, text: value });
      else blocks.push({ kind: 'field', name: key, value: asText(value) });
    }
    const sameCwd = Boolean(cwd && CWD_KEYS.some(key => typeof input[key] === 'string' && input[key].trim() === cwd.trim()));
    if (!sameCwd) place();
    return blocks;
  }
  function requestSummary(row) {
    const request = row.action || row.preview;
    if (!request) return '';
    if (request.kind === 'question') return oneLine(request.questions[0].question);
    const input = parseInput(request.detail);
    const qs = previewQuestions(input);
    if (qs) return oneLine(qs[0].question);
    return stepText({ tool: request.tool, target: inputTarget(input) });
  }
  function activePlanStep(row) {
    if (!Array.isArray(row?.plan)) return '';
    const current = row.plan.find(item => item.status === 'in_progress');
    return current?.text ? oneLine(current.text) : '';
  }
  const ERROR_LABELS = {
    rate_limit: phrase('Limit reached'),
    billing_error: phrase('Check billing'),
    authentication_failed: phrase('Sign-in required'),
    max_output_tokens: phrase('Output limit'),
    server_error: phrase('Server error'),
    invalid_request: phrase('Request error'),
    max_steps_exceeded: phrase('Step limit'),
  };
  // Each is a whole phrase: how a reason joins the verb differs between languages.
  const STOPPED_LABELS = {
    billing_error: phrase('Stopped: check billing'),
    authentication_failed: phrase('Stopped: sign-in required'),
    max_output_tokens: phrase('Stopped: output limit'),
    server_error: phrase('Stopped: server error'),
    invalid_request: phrase('Stopped: request error'),
    max_steps_exceeded: phrase('Stopped: step limit'),
  };
  const known = (table, reason) => typeof reason === 'string' && Object.hasOwn(table, reason);
  function errorLabel(reason) {
    return known(ERROR_LABELS, reason) ? t(ERROR_LABELS[reason]) : t('Error');
  }
  function depletedQuotaHint(quota, now = Date.now()) {
    if (!quota || (quota.status !== 'ready' && quota.status !== 'stale') || !Array.isArray(quota.windows) || !quota.windows.length) return;
    const depleted = quota.windows.filter(w => leftOf(w) <= 0.5);
    if (!depleted.length) return;
    const best = depleted.reduce((a, b) =>
      leftOf(b) < leftOf(a) || (leftOf(b) === leftOf(a) && windowDuration(b) < windowDuration(a)) ? b : a);
    return { label: quotaLabel(best), resetsAt: best.resetsAt, resetIn: best.resetsAt ? resetInText(best.resetsAt, now) : '' };
  }
  function workPhase(row) {
    if (!row) return { kind: 'idle', label: '' };
    if (row.quiet && (row.status === 'working' || row.status === 'input' || row.status === 'approval')) {
      if (row.status === 'input' || row.status === 'approval') {
        return { kind: 'quiet', label: t('No signal · May have been declined or stopped') };
      }
      return { kind: 'quiet', label: row.isSubagent ? t('No signal · Probably finished') : t('No signal · May have stopped') };
    }
    if (row.status === 'input') return { kind: 'input', label: t('Waiting for your answer') };
    if (row.status === 'approval') return { kind: 'approval', label: t('Waiting for approval') };
    if (row.status === 'error') {
      const kind = row.errorAcked ? 'idle' : 'error';
      const acked = text => row.errorAcked ? t('{0} (acknowledged)', text) : text;
      if (row.errorReason === 'rate_limit') return { kind, label: acked(t('Usage limit reached')) };
      if (row.errorReason) {
        return { kind, label: row.errorAcked || !known(STOPPED_LABELS, row.errorReason)
          ? acked(errorLabel(row.errorReason)) : t(STOPPED_LABELS[row.errorReason]) };
      }
      return { kind, label: row.errorAcked ? t('Earlier error (acknowledged)') : t('Stopped by an error') };
    }
    if (row.replyUnread && row.status === 'done') return { kind: 'done', label: t('New reply received') };
    if (row.status === 'done') return { kind: 'done', label: t('Finished') };
    if (row.status === 'working') {
      const kind = row.activity ? toolKind(row.activity.tool).kind : '';
      if (row.activity?.failed) return { kind: 'error', label: t('Last step failed · Recovering') };
      if (kind === 'patch' || kind === 'write') return { kind: 'edit', label: t('Editing code') };
      if (kind === 'command') return { kind: 'run', label: t('Running commands · Verifying') };
      if (kind === 'read' || kind === 'search' || kind === 'web') return { kind: 'explore', label: t('Reading code') };
      if (kind === 'plan') return { kind: 'plan', label: t('Planning the work') };
      if (kind === 'agent') return { kind: 'agent', label: t('Coordinating subtasks') };
      if (kind === 'skill') return { kind: 'working', label: t('Running a skill') };
      return { kind: 'working', label: t('Work in progress') };
    }
    if (row.status === 'idle' && row.interrupted) return { kind: 'idle', label: t('Interrupted') };
    return { kind: 'idle', label: t('Inactive') };
  }
  const FILE_KINDS = new Set(['patch', 'write', 'read']);
  const NON_FILE_READ_RE = /^(?:read_mcp_resource|readmcpresourcetool)$/i;
  function fileTargetOf(step) {
    if (!step || !step.target || step.target.startsWith('…')) return '';
    if (typeof step.tool === 'string' && NON_FILE_READ_RE.test(step.tool)) return '';
    return FILE_KINDS.has(toolKind(step.tool).kind) ? step.target : '';
  }
  const PROVIDER_NAMES = { claude: 'Claude Code', codex: 'Codex', agy: 'Antigravity' };
  const STATUS_NAMES = { approval: phrase('Approval needed'), input: phrase('Answer needed'), working: phrase('Working'), error: phrase('Error'),
    done: phrase('Replied'), idle: phrase('Paused'), stale: phrase('No signal'), recent: phrase('Recent') };
  function searchHaystack(row) {
    return [
      row.title, row.prompt, row.reply, row.focus, row.project, PROVIDER_NAMES[row.provider],
      row.replyUnread && row.status === 'done' ? t('New reply') : known(STATUS_NAMES, row.status) && t(STATUS_NAMES[row.status]),
      row.status === 'idle' && row.interrupted && t('Interrupted'),
      row.status === 'error' && errorLabel(row.errorReason),
      row.quiet && t('No signal'),
      modelName(row.execution?.model, row.execution, row.provider),
      row.execution?.model, row.execution?.effort,
      requestSummary(row),
      stepText(row.activity),
      ...requestFilePaths(row.action?.detail, row.action?.tool),
      ...requestFilePaths(row.preview?.detail, row.preview?.tool),
      ...(row.changedFiles || []),
      ...(row.plan || []).map(item => item.text),
      ...(row.steps || []).map(stepText),
    ].filter(Boolean).join(' ').toLowerCase();
  }
  function matchesFilter(row, query) {
    const terms = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return true;
    const haystack = searchHaystack(row);
    return terms.every(term => haystack.includes(term));
  }
  // The second line of a row: what is being asked, what is being done, or what was answered.
  function subtitleFor(row) {
    if (isWait(row)) return requestSummary(row) || stepText(row.activity) || oneLine(row.prompt);
    if (row.status === 'working') {
      const kind = row.activity ? toolKind(row.activity.tool).kind : '';
      const target = row.activity ? oneLine(row.activity.target) : '';
      if (kind === 'plan' && (!target || /^#\d+$/.test(target))) {
        const current = activePlanStep(row);
        if (current) return t('Plan · {0}', current);
        if (oneLine(row.focus)) return oneLine(row.focus);
      }
      if (kind === 'focus') {
        const focusText = target || oneLine(row.focus);
        if (focusText) return focusText;
      }
      return stepText(row.activity) || oneLine(row.focus) || activePlanStep(row) || oneLine(row.prompt);
    }
    if (row.status === 'done' || row.status === 'error') return oneLine(row.reply);
    return '';
  }
  const api = { sinceText, remainingText, resetInText, diffStats, percentLabel, byteSizeText, leftOf, visible, visibleCommand, shellJoin, foldBlankRuns, lineChanges,
    modelName, quotaLabel, quotaKey, representativeWindow, shortLimitLabel, limitName, isWait, requestToken, dismissKey, requestOrder, toolKind, stepText, parseInput, previewQuestions,
    parseApplyPatch, requestFilePaths, inputTarget, requestBlocks, requestSummary, activePlanStep, errorLabel, depletedQuotaHint, workPhase, fileTargetOf,
    searchHaystack, matchesFilter, subtitleFor };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AgentSessionFormat = api;
})(globalThis);
