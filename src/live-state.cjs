'use strict';

// Read-only runtime state probes for official agent stores:
// 1. Codex live running turns (thread_turns inProgress + live OS writer lock, never mtime guesses).
// 2. Codex declined/completed fileChange/commandExecution items to clear orphaned approvals.
// 3. Antigravity terminated tool steps (transcript.jsonl / per-conversation DB) to clear rejected soft waits.
// Strictly read-only; no prompts, diffs, commands, or raw text ever leave memory or reach disk snapshots.

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const {
  query, querySessions, quote, nativeExecution, codexExecutionColumns, codexTitle, codexTitleSql,
  tableColumns, latestCodexDb, statStamp, dbStamp,
} = require('./metadata.cjs');
const { AGY_SURFACES, CODEX_INTERACTIVE_SOURCES, isUnderDir, providerConfigDir } = require('./shared.cjs');

const { toolKey, shellCommandText } = require('./hook.cjs');

const exec = promisify(execFile);
const digest = value => createHash('sha256').update(value).digest('hex');
const validId = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id);
const configDir = (provider, homeDir, env) => providerConfigDir(provider, { homeDir, env, fallbackRelative: true });

const ROLLOUT_TAIL_BYTES = 65536;
const AGY_TRANSCRIPT_TAIL_BYTES = 65536;
// Official CortexStepStatus values in the per-conversation SQLite store.
const AGY_STEP_STATUS = {
  1: 'PENDING', 2: 'RUNNING', 3: 'DONE', 4: 'INVALID', 5: 'CLEARED',
  6: 'CANCELED', 7: 'ERROR', 8: 'GENERATING', 9: 'WAITING', 11: 'QUEUED', 12: 'INTERRUPTED',
};
const AGY_ENDED_WITHOUT_SUCCESS = new Set(['ERROR', 'CANCELED', 'CANCELLED', 'INTERRUPTED', 'HALTED', 'CLEARED', 'INVALID']);
const AGY_ACTIVE_STATUSES = new Set(['PENDING', 'RUNNING', 'WAITING', 'QUEUED', 'GENERATING']);

function normalizePathForHash(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return '';
  let normalized = path.resolve(rawPath.trim());
  if (normalized === '/private/var' || normalized.startsWith('/private/var/')) normalized = normalized.slice('/private'.length);
  else if (normalized === '/private/tmp' || normalized.startsWith('/private/tmp/')) normalized = normalized.slice('/private'.length);
  return normalized;
}

function fileChangeTargetHash(paths, cwd = '') {
  const hasCwd = typeof cwd === 'string' && path.isAbsolute(cwd);
  const canonical = new Set();
  for (const candidate of Array.isArray(paths) ? paths : []) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (!trimmed || trimmed.length > 4096 || trimmed.includes('\0')) continue;
    if (!hasCwd && !path.isAbsolute(trimmed)) continue;
    const resolved = hasCwd ? path.resolve(cwd, trimmed) : path.resolve(trimmed);
    const norm = normalizePathForHash(resolved);
    if (norm) canonical.add(norm);
  }
  if (!canonical.size) return '';
  return 'fc:' + digest(JSON.stringify([...canonical].sort()));
}

function commandTargetHashes(rawCommand) {
  const trimmed = shellCommandText(rawCommand);
  if (!trimmed) return [];
  const commands = new Set([trimmed]);
  // Earlier snapshots used a plain space join for argv.
  if (Array.isArray(rawCommand)) commands.add(rawCommand.join(' ').trim());
  // Codex wraps shell commands as `/bin/zsh -lc <cmd>` or `/bin/sh -c <cmd>`.
  const wrapped = /^(?:\/(?:usr\/)?(?:local\/)?bin\/)?(?:z|ba|da|a)?sh\s+-l?c\s+([\s\S]+)$/.exec(trimmed);
  if (wrapped) {
    const inner = wrapped[1].trim();
    commands.add(inner);
    if ((inner.startsWith("'") && inner.endsWith("'")) || (inner.startsWith('"') && inner.endsWith('"'))) {
      commands.add(inner.slice(1, -1).replaceAll("'\\''", "'").replaceAll("'\"'\"'", "'").trim());
    }
  }
  const hashes = new Set();
  for (const command of commands) {
    if (!command) continue;
    hashes.add('cmd:' + digest(command));
    if (command.includes("'\"'\"'")) hashes.add('cmd:' + digest(command.replaceAll("'\"'\"'", "'\\''")));
  }
  return [...hashes];
}

// Non-blocking read-only OS flock probe. Uses /usr/bin/perl (available on macOS and Linux
// without requiring Xcode CLI license agreement) to test LOCK_EX|LOCK_NB on existing lock files.
async function checkFlocks(lockFiles) {
  const existing = [];
  for (const file of lockFiles) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) continue;
    const st = await fs.lstat(file).catch(() => undefined);
    if (st?.isFile()) existing.push(file);
  }
  if (!existing.length) return { checked: true, locked: new Set() };
  const perlScript =
    'use Fcntl qw(:flock); ' +
    'for my $f (@ARGV) { ' +
    '  open(my $fh, "<", $f) or next; ' +
    '  if (flock($fh, LOCK_EX | LOCK_NB)) { flock($fh, LOCK_UN); } ' +
    '  else { print "$f\\n"; } ' +
    '  close($fh); ' +
    '}';
  for (const perlPath of ['/usr/bin/perl', 'perl']) {
    try {
      const { stdout } = await exec(perlPath, ['-e', perlScript, '--', ...existing], { timeout: 2000, maxBuffer: 256 * 1024 });
      const locked = new Set(stdout.split('\n').map(line => line.trim()).filter(Boolean));
      return { checked: true, locked };
    } catch (error) {
      if (error?.code !== 'ENOENT') break;
    }
  }
  return { checked: false, locked: new Set() };
}

async function readTailLines(file, maxBytes) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return [];
  let handle;
  try {
    const lst = await fs.lstat(file);
    if (!lst.isFile() || !lst.size) return [];
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = await handle.stat();
    if (!st.isFile() || !st.size) return [];
    const start = Math.max(0, st.size - maxBytes);
    const buf = Buffer.alloc(st.size - start);
    const { bytesRead } = await handle.read(buf, 0, buf.length, start);
    const lines = buf.subarray(0, bytesRead).toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines;
  } catch {
    return [];
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function rolloutHasOpenTurn(rolloutPath) {
  const lines = await readTailLines(rolloutPath, ROLLOUT_TAIL_BYTES);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !/"type"\s*:\s*"event_msg"/.test(line)) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type !== 'event_msg') continue;
    const kind = entry.payload?.type;
    if (kind === 'task_complete' || kind === 'turn_aborted') return null;
    if (kind === 'task_started') {
      const ts = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
      return {
        turnId: typeof entry.payload?.turn_id === 'string' ? entry.payload.turn_id : '',
        startedAt: Number.isFinite(ts) && ts > 0 ? ts : 0,
      };
    }
  }
  return null;
}

function toEpochMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
}

async function codexRunCandidates(roots, knownIds, locksDir, stateDb, historyDb, sqlitePath) {
  const lockEntries = await fs.readdir(locksDir, { withFileTypes: true }).catch(() => null);
  if (!lockEntries || !stateDb) return;
  const lockFiles = new Map(lockEntries
    .filter(e => e.isFile() && e.name.endsWith('.lock') && validId(e.name.slice(0, -5)))
    .map(e => [e.name.slice(0, -5), path.join(locksDir, e.name)]));
  if (!lockFiles.size) return [];

  const [stateCols, historyCols, edgeCols] = await Promise.all([
    tableColumns(stateDb, 'threads', sqlitePath),
    tableColumns(historyDb, 'thread_turns', sqlitePath),
    tableColumns(stateDb, 'thread_spawn_edges', sqlitePath),
  ]);
  if (!stateCols.has('id') || !stateCols.has('cwd')) return;

  const activeTurns = new Map();
  const usedHistoryDb = ['thread_id', 'status', 'rollout_ordinal'].every(col => historyCols.has(col));
  let candidateIds = [...lockFiles.keys()];
  if (usedHistoryDb) {
    const startedCol = historyCols.has('started_at') ? 't.started_at' : 'NULL';
    const turnIdCol = historyCols.has('turn_id') ? 't.turn_id' : "''";
    // A lock file outlives its writer. Check the newest turn for every candidate in
    // bounded batches; ordering directory entries cannot prioritize active threads.
    const rows = await querySessions(historyDb, candidateIds, list =>
      'SELECT t.thread_id AS id,' + turnIdCol + ' AS turnId,' + startedCol + ' AS startedAt ' +
      'FROM thread_turns t WHERE t.thread_id IN (' + list + ") AND t.status='inProgress' " +
      'AND t.rollout_ordinal=(SELECT max(u.rollout_ordinal) FROM thread_turns u WHERE u.thread_id=t.thread_id)',
      sqlitePath);
    for (const r of rows) {
      activeTurns.set(r.id, { turnId: typeof r.turnId === 'string' ? r.turnId : '', startedAt: toEpochMs(r.startedAt) });
    }
    candidateIds = [...activeTurns.keys()];
    if (!candidateIds.length) return [];
  }

  const timeCol = stateCols.has('updated_at_ms') && stateCols.has('updated_at') ? 'coalesce(updated_at_ms,updated_at*1000)' :
    stateCols.has('updated_at_ms') ? 'updated_at_ms' : stateCols.has('updated_at') ? 'updated_at*1000' : '0';
  const titleCol = stateCols.has('title') ? codexTitleSql(stateCols) : "''";
  const namedCol = stateCols.has('name') ? "length(trim(coalesce(name,''))) > 0" : '0';
  const sourceCol = stateCols.has('source') ? 'source' : "''";
  const archivedCol = stateCols.has('archived') ? 'coalesce(archived,0)' : '0';
  const rolloutCol = stateCols.has('rollout_path') ? 'rollout_path' : "''";
  const agentPathCol = stateCols.has('agent_path') ? "coalesce(agent_path,'')" : "''";
  const agentRoleCol = stateCols.has('agent_role') ? "coalesce(agent_role,'')" : "''";
  const attachedCol = stateCols.has('attached_thread_parent_id') ? "coalesce(attached_thread_parent_id,'')" : "''";
  const parentCol = edgeCols.has('child_thread_id') && edgeCols.has('parent_thread_id')
    ? '(SELECT parent_thread_id FROM thread_spawn_edges WHERE child_thread_id=threads.id)' : 'NULL';
  const knownSet = new Set(knownIds);
  const threadRows = await querySessions(stateDb, candidateIds, list =>
    'SELECT id,cwd,' + titleCol + ' AS title,' + namedCol + ' AS named,' + timeCol + ' AS updatedAt,' +
    sourceCol + ' AS source,' + archivedCol + ' AS archived,' + rolloutCol + ' AS rolloutPath,' +
    agentPathCol + ' AS agentPath,' + agentRoleCol + ' AS agentRole,' + attachedCol + ' AS attachedParent,' +
    parentCol + ' AS spawnParent,' + codexExecutionColumns(stateCols) +
    ' FROM threads WHERE id IN (' + list + ')', sqlitePath);

  const scopedThreads = [];
  for (const row of threadRows) {
    if (row.archived || typeof row.cwd !== 'string' || !path.isAbsolute(row.cwd)) continue;
    const resolvedCwd = await fs.realpath(row.cwd).catch(() => path.resolve(row.cwd));
    if (!roots.some(root => isUnderDir(resolvedCwd, root))) continue;
    let subagent;
    if (typeof row.source === 'string' && row.source.startsWith('{')) {
      try { subagent = JSON.parse(row.source)?.subagent; } catch { /* unknown source */ }
    }
    // Guardian/review workers are internal. Only a spawn relationship can create a child row.
    if (subagent && !subagent.thread_spawn) continue;
    const parentId = row.spawnParent || subagent?.thread_spawn?.parent_thread_id;
    if (parentId && (!validId(parentId) || parentId === row.id)) continue;
    if (!parentId && (row.agentPath || row.agentRole || row.attachedParent || subagent)) continue;
    if (!parentId && row.source && !CODEX_INTERACTIVE_SOURCES.includes(row.source) && !knownSet.has(row.id)) continue;
    scopedThreads.push({ ...row, parentId, resolvedCwd, lockFile: lockFiles.get(row.id), turn: activeTurns.get(row.id) });
  }
  return scopedThreads;
}

const systemNow = Date.now;
// Candidate metadata and empty scans can be reused briefly. Every positive result
// still probes the flock because a writer can exit without touching either database.
let codexRunCache;

async function readCodexLiveRuns(workspacePaths, {
  homeDir = os.homedir(), env = process.env, sqlitePath = '/usr/bin/sqlite3',
  knownIds = [], checkLocks = checkFlocks, now = Date.now,
} = {}) {
  const rawRoots = (workspacePaths || []).filter(p => typeof p === 'string' && path.isAbsolute(p)).map(p => path.resolve(p));
  if (!rawRoots.length) return { runs: [], capability: 'available' };
  const physicalRoots = await Promise.all(rawRoots.map(p => fs.realpath(p).catch(() => p)));
  const roots = [...new Set([...rawRoots, ...physicalRoots])].sort();
  const base = configDir('codex', homeDir, env);
  const locksDir = path.join(base, 'thread-writer-locks');
  const historyDb = path.join(base, 'thread_history_1.sqlite');
  const stateDb = await latestCodexDb(base);
  let fingerprint;
  const started = now();
  if (checkLocks === checkFlocks && now === systemNow) {
    const stamps = await Promise.all([statStamp(locksDir), stateDb && dbStamp(stateDb), dbStamp(historyDb)]);
    fingerprint = JSON.stringify([base, sqlitePath, stateDb, roots, [...new Set(knownIds)].sort(), stamps]);
  }
  let cached = fingerprint && codexRunCache;
  if (!cached || cached.fingerprint !== fingerprint || started < cached.at || started - cached.at >= 2000) {
    const candidates = await codexRunCandidates(roots, knownIds, locksDir, stateDb, historyDb, sqlitePath);
    cached = { fingerprint, at: started, candidates };
    if (fingerprint) codexRunCache = cached;
  }
  const scopedThreads = cached.candidates;
  if (!scopedThreads) return { runs: [], capability: 'unavailable' };
  if (cached.empty) return { runs: [], capability: 'available' };

  const liveThreads = [];
  // Bound the Perl argv/output even when the history database is unavailable.
  for (let i = 0; i < scopedThreads.length; i += 128) {
    const batch = scopedThreads.slice(i, i + 128);
    const lockCheck = await checkLocks(batch.map(t => t.lockFile));
    if (!lockCheck.checked) return { runs: [], capability: 'unavailable' };
    liveThreads.push(...batch.filter(t => lockCheck.locked.has(t.lockFile)));
  }

  const currentNow = now();
  const runs = [];
  for (const row of liveThreads) {
    const turn = row.turn || await rolloutHasOpenTurn(row.rolloutPath);
    if (!turn) continue;

    const updatedAt = toEpochMs(row.updatedAt) || turn.startedAt || currentNow;
    const startedAt = turn.startedAt || updatedAt;
    const title = codexTitle(row);
    const execution = nativeExecution(row.model, row.effort, 'setting');
    runs.push({
      provider: 'codex',
      sessionId: row.id,
      key: 'codex/' + row.id,
      cwd: row.resolvedCwd,
      status: 'working',
      liveTurnConfirmed: true,
      ...(row.parentId && { isSubagent: true, parentKey: 'codex/' + row.parentId, canOpen: true }),
      turnId: turn.turnId,
      workSince: startedAt,
      updatedAt: Math.max(updatedAt, startedAt),
      ...(title && { title }),
      ...(execution && { nativeExecution: execution }),
    });
  }
  cached.empty = runs.length === 0;
  return { runs, capability: 'available' };
}

// Match the item ID from Codex's completion to its original rollout call. Current
// runtimes can report a shell-wrapped apply_patch to the hook as a native patch.
function rolloutArgumentRefs(sessionId, call) {
  const refs = new Set();
  let input;
  if (call.type === 'custom_tool_call') input = call.input;
  else {
    try { input = JSON.parse(call.arguments); } catch { return refs; }
  }
  if (typeof call.name !== 'string') return refs;
  refs.add(toolKey(sessionId, { tool_input: input }, call.name));
  const command = input?.cmd ?? input?.command;
  if (command != null && /^(?:Bash|exec_command|shell_command|shell|local_shell|unified_exec)$/.test(call.name)) {
    for (const hash of commandTargetHashes(command)) refs.add(hash);
    refs.add(toolKey(sessionId, { tool_input: { command } }, 'Bash'));
  }
  const body = call.name === 'apply_patch' ? (typeof input === 'string' ? input : input?.patch ?? command)
    : typeof command === 'string' && /^\s*apply_patch\s+<</.test(command) ? command : undefined;
  const patch = typeof body === 'string' && body.match(/^\*\*\* Begin Patch\r?$[\s\S]*?^\*\*\* End Patch\r?$/m)?.[0];
  if (patch) {
    for (const text of [patch, patch + '\n']) refs.add(toolKey(sessionId, { tool_input: text }, 'apply_patch'));
  }
  return refs;
}

function completionTargets(paths, cwd) {
  const sources = paths.map(pair => pair[0]);
  return [fileChangeTargetHash(sources, cwd), fileChangeTargetHash(paths.flat(), cwd)].filter(Boolean);
}

async function readCodexResolvedPending(codexWaitingRows, {
  homeDir = os.homedir(),
  env = process.env,
  sqlitePath = '/usr/bin/sqlite3',
} = {}) {
  const result = new Map();
  const targets = (codexWaitingRows || []).filter(row => row?.provider === 'codex' && validId(row.sessionId) &&
    row.pendingEntries?.some(entry => entry.target));
  if (!targets.length) return result;

  const base = configDir('codex', homeDir, env);
  const historyDb = path.join(base, 'thread_history_1.sqlite');
  const cols = await tableColumns(historyDb, 'thread_items', sqlitePath);
  const hasItems = ['thread_id', 'item_type', 'item_json'].every(col => cols.has(col));
  const stateDb = await latestCodexDb(base);
  const threads = stateDb ? await tableColumns(stateDb, 'threads', sqlitePath) : new Set();
  const rolloutPaths = new Map();
  if (threads.has('id') && threads.has('rollout_path')) {
    const paths = await querySessions(stateDb, targets.map(row => row.sessionId),
      ids => 'SELECT id,rollout_path FROM threads WHERE id IN (' + ids + ')', sqlitePath);
    for (const t of paths) rolloutPaths.set(t.id, t.rollout_path);
  }

  for (const row of targets) {
    const waits = row.pendingEntries.filter(entry => entry.target);
    const items = [];
    const callArgs = new Map();
    if (!hasItems || waits.some(w => !w.identified)) {
      for (const line of await readTailLines(rolloutPaths.get(row.sessionId), ROLLOUT_TAIL_BYTES)) {
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        const payload = entry?.payload;
        if (!payload) continue;
        if (entry.type === 'response_item' && ['custom_tool_call', 'function_call'].includes(payload.type) && payload.call_id) {
          const turn = payload.internal_chat_message_metadata_passthrough?.turn_id;
          if (!turn || !row.turn || turn === row.turn) callArgs.set(payload.call_id, rolloutArgumentRefs(row.sessionId, payload));
        } else if (!hasItems && entry.type === 'event_msg' && payload.type === 'item_completed') {
          if (row.turn && payload.turn_id !== row.turn) continue;
          const item = payload.item;
          const startedAt = toEpochMs(payload.started_at_ms);
          const completedAt = toEpochMs(payload.completed_at_ms) || Date.parse(entry.timestamp);
          if (item?.type === 'FileChange' && ['declined', 'failed', 'completed'].includes(item.status)) {
            const paths = Object.entries(item.changes || {}).map(([p, change]) => [p, change?.move_path]);
            items.push({ id: item.id, hashes: completionTargets(paths, row.cwd), startedAt, completedAt });
          } else if (item?.type === 'CommandExecution' && ['declined', 'failed', 'completed'].includes(item.status)) {
            items.push({ id: item.id, hashes: commandTargetHashes(item.command), startedAt, completedAt });
          }
        }
      }
    }
    if (hasItems) {
      const id = cols.has('item_id') ? 'item_id' : "json_extract(item_json,'$.id')";
      const start = cols.has('started_at_ms') ? 'started_at_ms' : 'NULL';
      const end = cols.has('completed_at_ms') ? 'completed_at_ms' : cols.has('created_at_ms') ? 'created_at_ms' : 'NULL';
      const turn = cols.has('turn_id') && row.turn ? ' AND turn_id=' + quote(row.turn) : '';
      const earliest = Math.min(...waits.map(w => w.since));
      const time = Number.isSafeInteger(earliest) && !waits.some(w => w.identified)
        ? ' AND (' + end + '>=' + earliest + ' OR ' + end + ' IS NULL)' : '';
      // Keep large command output and file diffs inside SQLite. They can exceed
      // the process output buffer even for a single, unrelated completed item.
      const files = "(SELECT json_group_array(json_array(json_extract(c.value,'$.path')," +
        "coalesce(json_extract(c.value,'$.kind.move_path'),json_extract(c.value,'$.kind.movePath')))) FROM json_each(item_json,'$.changes') c WHERE c.type='object')";
      const sql = 'SELECT ' + id + ' AS id,' + start + ' AS startedAt,' + end + ' AS completedAt,' +
        "CASE WHEN item_type='fileChange' THEN " + files + ' END AS paths,' +
        "CASE WHEN item_type='commandExecution' THEN json_extract(item_json,'$.command') END AS command," +
        "json_type(item_json,'$.command') AS commandType " +
        'FROM thread_items WHERE thread_id=' + quote(row.sessionId) + turn + time +
        " AND item_type IN ('fileChange','commandExecution') AND json_valid(item_json)" +
        " AND json_extract(item_json,'$.status') IN ('declined','failed','completed')";
      for (const record of await query(historyDb, sql, sqlitePath)) {
        let hashes;
        try {
          hashes = record.paths != null ? completionTargets(JSON.parse(record.paths), row.cwd) :
            commandTargetHashes(record.commandType === 'array' ? JSON.parse(record.command) : record.command);
        } catch { continue; }
        items.push({ id: record.id, hashes, startedAt: toEpochMs(record.startedAt), completedAt: toEpochMs(record.completedAt) });
      }
    }

    const resolved = new Set();
    const unmatched = [];
    for (const item of items) {
      const ref = typeof item.id === 'string' && digest(item.id);
      const exact = ref && waits.find(wait => wait.identified && wait.ref === ref);
      if (exact) { resolved.add(exact.ref); continue; }
      const args = callArgs.get(item.id);
      const peers = waits.filter(wait => !wait.identified && item.hashes.includes(wait.target));
      // A sibling can be removed by a successful PostToolUse while its native
      // completion remains in history. Do not reassign that completion by path.
      const candidates = peers.filter(wait => item.completedAt > wait.since &&
        (!item.startedAt || item.startedAt <= wait.since) &&
        (!args?.size || args.has(wait.argsRef || wait.ref) || args.has(wait.target)) &&
        (wait.removedPeerSince ? item.completedAt <= wait.removedPeerSince :
          !wait.sharedTarget || args?.size || peers.some(other => other.since >= item.completedAt)));
      if (candidates.length) unmatched.push(candidates);
    }
    // A later completion can uniquely identify one of two overlapping calls.
    // Consume it once, then recheck the earlier ambiguous completion. When
    // identity is still ambiguous leave both previews for the native chat.
    let changed;
    do {
      changed = false;
      for (let i = unmatched.length - 1; i >= 0; i--) {
        const remaining = unmatched[i].filter(wait => !resolved.has(wait.ref));
        if (remaining.length > 1) continue;
        unmatched.splice(i, 1);
        if (remaining.length) { resolved.add(remaining[0].ref); changed = true; }
      }
    } while (changed && unmatched.length);
    if (resolved.size) result.set(row.key, resolved);
  }
  return result;
}

async function readAgyResolvedSteps(agySoftRows, {
  homeDir = os.homedir(),
  sqlitePath = '/usr/bin/sqlite3',
} = {}) {
  const result = new Map();
  const targets = (agySoftRows || []).filter(row =>
    row?.provider === 'agy' && validId(row.sessionId) && Array.isArray(row.pendingSoftEntries) && row.pendingSoftEntries.length > 0);
  if (!targets.length) return result;

  for (const row of targets) {
    const sessionId = row.sessionId;
    const byStepIdx = new Map();
    const byRef = new Map();
    for (const entry of row.pendingSoftEntries) {
      byRef.set(entry.ref, entry);
      if (Number.isSafeInteger(entry.stepIdx) && entry.stepIdx >= 0) byStepIdx.set(entry.stepIdx, entry);
    }

    const transcriptSteps = new Map();
    const nativeSteps = new Map();
    const activeSteps = new Set();
    const matchStep = idx => byStepIdx.get(idx) || byRef.get(digest(sessionId + ':step:' + idx));

    for (const surface of AGY_SURFACES) {
      // 1. Check bounded tail of Antigravity transcript.jsonl for terminal step entries.
      const transcript = path.join(homeDir, '.gemini', surface, 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl');
      const lines = await readTailLines(transcript, AGY_TRANSCRIPT_TAIL_BYTES);
      for (const line of lines) {
        if (!line || !line.includes('"step_index"')) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (Number.isSafeInteger(entry?.step_index) && entry.step_index >= 0 && typeof entry.status === 'string') {
          const match = matchStep(entry.step_index);
          if (match) transcriptSteps.set(match.ref, { status: entry.status.toUpperCase(), at: Date.parse(entry.created_at) });
        }
      }

      const convDb = path.join(homeDir, '.gemini', surface, 'conversations', sessionId + '.db');
      const cols = await tableColumns(convDb, 'steps', sqlitePath);
      if (!cols.has('idx') || !cols.has('status')) continue;
      // Old snapshots contain only a hashed step index. In that case scan the small
      // index/status columns in pages, never loading step payloads or error details.
      const ids = [...byStepIdx.keys()];
      const knownIndices = ids.length === byRef.size;
      const activeCodes = Object.keys(AGY_STEP_STATUS).filter(code => AGY_ACTIVE_STATUSES.has(AGY_STEP_STATUS[code]));
      const filter = knownIndices ? ' AND (idx IN (' + ids.join(',') + ') OR status IN (' + activeCodes.join(',') + '))' : '';
      let cursor = -1;
      while (true) {
        const steps = await query(convDb, 'SELECT idx,status FROM steps WHERE idx>' + cursor +
          filter + ' ORDER BY idx LIMIT 256', sqlitePath);
        for (const step of steps) {
          if (!Number.isSafeInteger(step.idx) || step.idx < 0) continue;
          const status = AGY_STEP_STATUS[step.status];
          if (AGY_ACTIVE_STATUSES.has(status)) activeSteps.add(step.idx);
          const match = matchStep(step.idx);
          if (match && status) nativeSteps.set(match.ref, status);
        }
        if (steps.length < 256 || !Number.isSafeInteger(steps.at(-1).idx) || steps.at(-1).idx <= cursor) break;
        cursor = steps.at(-1).idx;
      }
    }

    const resolvedSoftRefs = new Set();
    const runningSoftRefs = new Set();
    let anyRejected = false;
    let resolvedAt = 0;
    for (const ref of byRef.keys()) {
      const transcript = transcriptSteps.get(ref);
      const native = nativeSteps.get(ref);
      const status = native || transcript?.status;
      if (native === 'RUNNING') runningSoftRefs.add(ref);
      if (status !== 'DONE' && !AGY_ENDED_WITHOUT_SUCCESS.has(status)) continue;
      resolvedSoftRefs.add(ref);
      if (status !== 'DONE') anyRejected = true;
      if (transcript?.status === status && Number.isFinite(transcript.at)) resolvedAt = Math.max(resolvedAt, transcript.at);
    }
    if (resolvedSoftRefs.size || runningSoftRefs.size) {
      // If all soft waits on this session resolved via rejection and no later step is still running,
      // check whether official conversation_summaries reports IDLE (not RUNNING).
      let haltedOnReject = false;
      if (anyRejected && resolvedSoftRefs.size === byRef.size && !row.pendingEntries?.length && !activeSteps.size) {
        let sawRunning = false;
        let sawIdle = false;
        for (const surface of AGY_SURFACES) {
          const sumDb = path.join(homeDir, '.gemini', surface, 'conversation_summaries.db');
          const sumCols = await tableColumns(sumDb, 'conversation_summaries', sqlitePath);
          if (!sumCols.has('conversation_id') || !sumCols.has('status')) continue;
          const found = await query(sumDb,
            'SELECT status FROM conversation_summaries WHERE conversation_id=' + quote(sessionId), sqlitePath);
          for (const item of found) {
            if (item.status === 'CASCADE_RUN_STATUS_RUNNING') sawRunning = true;
            else if (item.status === 'CASCADE_RUN_STATUS_IDLE') sawIdle = true;
          }
        }
        if (sawIdle && !sawRunning) haltedOnReject = true;
      }
      result.set(row.key, { resolvedSoftRefs, runningSoftRefs, haltedOnReject, resolvedAt });
    }
  }
  return result;
}

async function liveStateFingerprint(rows, { homeDir = os.homedir(), env = process.env, checkCodex = false } = {}) {
  const checks = [];
  if (checkCodex || rows.some(r => r.provider === 'codex' && ['working', 'approval', 'input'].includes(r.status))) {
    const base = configDir('codex', homeDir, env);
    const lockDir = path.join(base, 'thread-writer-locks');
    checks.push(
      statStamp(lockDir),
      dbStamp(path.join(base, 'thread_history_1.sqlite')),
      latestCodexDb(base).then(file => file ? dbStamp(file) : ''),
    );
    // A crashed writer releases its flock without writing the DB or touching the lock file.
    const activeLocks = rows.filter(row => row.provider === 'codex' && row.liveTurnConfirmed && validId(row.sessionId))
      .map(row => path.join(lockDir, row.sessionId + '.lock')).sort();
    for (let i = 0; i < activeLocks.length; i += 128) {
      checks.push(checkFlocks(activeLocks.slice(i, i + 128))
        .then(result => result.checked ? [...result.locked].sort().join('\n') : '?'));
    }
  }
  for (const row of rows) {
    if (row.provider !== 'agy' || !validId(row.sessionId) || !row.pendingSoftEntries?.length) continue;
    for (const surface of AGY_SURFACES) {
      checks.push(
        statStamp(path.join(homeDir, '.gemini', surface, 'brain', row.sessionId, '.system_generated', 'logs', 'transcript.jsonl')),
        dbStamp(path.join(homeDir, '.gemini', surface, 'conversations', row.sessionId + '.db')),
      );
    }
  }
  if (!checks.length) return '';
  return (await Promise.all(checks)).join('|');
}

module.exports = {
  fileChangeTargetHash,
  readCodexLiveRuns,
  readCodexResolvedPending,
  readAgyResolvedSteps,
  liveStateFingerprint,
};
