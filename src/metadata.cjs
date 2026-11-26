'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { constants } = require('node:fs');
const os = require('node:os');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { validModel, validEffort } = require('./hook.cjs');
const { DAY, UUID_RE, AGY_SURFACES, CODEX_INTERACTIVE_SOURCES, isObject, isUnderDir, providerConfigDir, createLru } = require('./shared.cjs');

const configDir = (provider, homeDir, env) => providerConfigDir(provider, { homeDir, env, fallbackRelative: true });

const exec = promisify(execFile);

// macOS ships /usr/bin/sqlite3; Linux distributions may install it elsewhere on PATH.
// Resolved once; an explicit `sqlitePath` option always takes precedence.
let sqliteResolved;
function defaultSqlitePath(env = process.env) {
  if (sqliteResolved) return sqliteResolved;
  const dirs = ['/usr/bin', ...(typeof env?.PATH === 'string' ? env.PATH.split(path.delimiter) : []),
    '/opt/homebrew/bin', '/usr/local/bin'].filter(dir => path.isAbsolute(dir));
  for (const dir of new Set(dirs)) {
    const candidate = path.join(dir, 'sqlite3');
    try {
      fsSync.accessSync(candidate, constants.X_OK);
      if (fsSync.statSync(candidate).isFile()) return (sqliteResolved = candidate);
    } catch { /* Try the next directory. */ }
  }
  // Leave the lookup to execFile's own PATH search; a missing binary only empties metadata.
  return 'sqlite3';
}

const validId = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id);
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const format = value => value.toLocaleString('ko-KR');
const amount = value => Number.isSafeInteger(value) && value >= 0;
const titleText = value => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 140) : '';

function nativeExecution(model, effort, source, modelAt) {
  const result = {};
  if (validModel(model) && model.toLowerCase() !== 'unknown') {
    result.model = model;
    result.modelSource = source;
    if (Number.isSafeInteger(modelAt) && modelAt > 0) result.modelAt = modelAt;
  }
  if (validEffort(effort)) {
    result.effort = effort;
    result.effortSource = source;
  }
  return result.model || result.effort ? result : undefined;
}

function codexExecutionColumns(fields, prefix = '') {
  const column = name => {
    const field = prefix + name;
    return fields.has(name) ? "CASE WHEN typeof(" + field + ")='text' THEN substr(" + field + ',1,129) END' : 'NULL';
  };
  return column('model') + ' AS model,' + column('reasoning_effort') + ' AS effort';
}

const CODEX_CONTEXT_PREFIX = '# Context from my IDE setup:';
const CODEX_REQUEST_MARKER = '## My request for Codex:';

function codexTitleSql(fields, prefix = '') {
  const titleCol = prefix + 'title';
  const stripped = "CASE WHEN substr(ltrim(coalesce(" + titleCol + ",''),' '||char(9)||char(10)||char(13)),1," +
    CODEX_CONTEXT_PREFIX.length + ')=' + quote(CODEX_CONTEXT_PREFIX) +
    ' AND instr(' + titleCol + ',' + quote(CODEX_REQUEST_MARKER) + ')>0 ' +
    'THEN substr(' + titleCol + ',instr(' + titleCol + ',' + quote(CODEX_REQUEST_MARKER) + ')+' + CODEX_REQUEST_MARKER.length + ',200) ' +
    'ELSE substr(' + titleCol + ',1,150) END';
  if (!fields.has('name')) return stripped;
  const nameCol = prefix + 'name';
  return "CASE WHEN length(trim(coalesce(" + nameCol + ",'')))>0 THEN substr(" + nameCol + ',1,150) ELSE ' + stripped + ' END';
}

function codexTitle(record) {
  let value = titleText(record.title);
  // The DB's fallback title can be generated from an IDE bootstrapping
  // message. A named thread or native rename index takes precedence.
  if (!record.named) {
    if (value.startsWith(CODEX_CONTEXT_PREFIX)) {
      const at = value.indexOf(CODEX_REQUEST_MARKER);
      value = at >= 0 ? titleText(value.slice(at + CODEX_REQUEST_MARKER.length)) : '';
    }
    if (/^(?:#\s*AGENTS\.md instructions for\s|<(?:environment_context|user_instructions|INSTRUCTIONS)>)/i.test(value)) return '';
  }
  return value;
}

async function regular(file, limit = Infinity) {
  try {
    const stat = await fs.lstat(file);
    return stat.isFile() && stat.size <= limit;
  } catch { return false; }
}

async function entries(dir) {
  try { return await fs.readdir(dir, { withFileTypes: true }); } catch { return []; }
}

async function statStamp(file) {
  const st = await fs.stat(file, { bigint: true }).catch(() => undefined);
  return st ? st.mtimeNs + ':' + st.ctimeNs + ':' + st.size + ':' + st.ino : '';
}

async function dbStamp(file) {
  const [main, wal, shm] = await Promise.all([statStamp(file), statStamp(file + '-wal'), statStamp(file + '-shm')]);
  return main + ';' + wal + ';' + shm;
}

const TABLE_COLUMNS_MAX = 128;
const TABLE_COLUMNS_TTL_MS = 5 * 60000;
const tableColumnsCache = createLru(TABLE_COLUMNS_MAX);

function invalidateTableColumns(dbPath) {
  if (!dbPath || dbPath === ':memory:') return;
  const prefix = dbPath + '\0';
  for (const key of [...tableColumnsCache.keys()]) {
    if (key.startsWith(prefix)) tableColumnsCache.delete(key);
  }
}

// A schema changes far less often than rows. Every WAL append touches -wal/-shm, so
// the cache follows only the main file (replaced, checkpointed or grown) within a
// generous TTL; a query that fails against a stale column list invalidates it at once.
async function tableColumns(dbPath, table, executable) {
  const stamp = await statStamp(dbPath);
  if (!stamp) return new Set();
  const key = dbPath + '\0' + table + '\0' + executable;
  const cached = tableColumnsCache.get(key);
  if (cached && cached.stamp === stamp && Date.now() - cached.at < TABLE_COLUMNS_TTL_MS) return cached.cols;
  const rows = await query(dbPath, 'SELECT name FROM pragma_table_info(' + quote(table) + ')', executable);
  const cols = new Set(rows.map(c => c.name).filter(Boolean));
  if (cols.size) tableColumnsCache.set(key, { stamp, cols, at: Date.now() });
  else tableColumnsCache.delete(key);
  return cols;
}

const CODEX_DB_CACHE_MAX = 32;
const codexDbCache = createLru(CODEX_DB_CACHE_MAX);

async function codexDbFiles(base) {
  const stamp = await statStamp(base);
  if (!stamp) return [];
  const cached = codexDbCache.get(base);
  if (cached && cached.stamp === stamp) return cached.files;
  const files = (await entries(base))
    .filter(f => f.isFile() && /^state_\d+\.sqlite$/.test(f.name))
    .map(f => f.name)
    .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
    .map(name => path.join(base, name));
  codexDbCache.set(base, { stamp, files });
  return files;
}

async function latestCodexDb(base) {
  return (await codexDbFiles(base))[0];
}

async function readJsonSafe(file, limit) {
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = await handle.stat();
    if (!st.isFile() || st.size > limit) return;
    return JSON.parse(await handle.readFile('utf8'));
  } catch { return; }
  finally { if (handle) await handle.close().catch(() => {}); }
}

// Run read-only queries off the extension host thread. Database columns and JSON
// paths are fixed here; no prompt, message, preview, or binary payload is selected.
async function checkpointFingerprint(file) {
  try {
    const db = await fs.stat(file, { bigint: true });
    try {
      await fs.lstat(file + '-wal');
      return;
    } catch (error) { if (error.code !== 'ENOENT') return; }
    return [db.ino,db.size,db.mtimeNs,db.ctimeNs].join(':');
  } catch { return; }
}

async function query(file, sql, executable, { immutable = true } = {}) {
  try {
    // A checkpointed WAL-mode DB without sidecars can otherwise need to create
    // its WAL index on a read-only open. Use an immutable read only while the
    // on-disk DB stays unchanged and there is no WAL. A writer that appears
    // mid-read invalidates that snapshot; the normal read-only open then sees
    // its WAL, so the query is repeated once that way instead of dropped.
    const snapshot = file === ':memory:' || !immutable ? undefined : await checkpointFingerprint(file);
    const target = snapshot ? pathToFileURL(file).href + '?immutable=1' : file;
    const args = ['-batch', '-init', '/dev/null', '-readonly', '-noheader', '-json', '-cmd', '.timeout 200', target,
      'PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; ' + sql];
    const { stdout } = await exec(executable, args, { timeout: 2000, maxBuffer: 1024 * 1024 });
    if (!snapshot || snapshot === await checkpointFingerprint(file)) return JSON.parse(stdout || '[]');
  } catch {
    invalidateTableColumns(file);
    return [];
  }
  return query(file, sql, executable, { immutable: false });
}

async function querySessions(db, ids, sql, executable) {
  if (!ids.length || !await regular(db)) return [];
  const result = [];
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200).map(quote).join(',');
    result.push(...await query(db, sql(batch), executable));
  }
  return result;
}

function add(view, provider, record, quantityLabel) {
  if (!validId(record.id)) return;
  const key = provider + '/' + record.id;
  const current = view.sessions.get(key) || {};
  const title = titleText(record.title);
  if (title) current.title = title;
  if (quantityLabel && amount(record.quantity)) current.usage = quantityLabel(record.quantity);
  if (record.execution) current.execution = record.execution;
  if (Number.isSafeInteger(record.interruptedAt) && record.interruptedAt > 0) {
    current.interruptedAt = Math.max(current.interruptedAt || 0, record.interruptedAt);
  }
  if (Number.isSafeInteger(record.turnInterruptedAt) && record.turnInterruptedAt > 0) {
    current.turnInterruptedAt = Math.max(current.turnInterruptedAt || 0, record.turnInterruptedAt);
  }
  if (typeof record.agySource === 'string' && record.agySource && !current.agySource) {
    current.agySource = record.agySource;
  }
  if (current.title || current.usage || current.execution || current.interruptedAt || current.turnInterruptedAt || current.agySource) view.sessions.set(key, current);
}

function groupUsage(records, suffix) {
  const measured = records.filter(r => amount(r.quantity));
  if (!measured.length) return;
  const sum = measured.reduce((acc, r) => acc + r.quantity, 0);
  if (Number.isSafeInteger(sum)) return measured.length + '개 세션 · ' + format(sum) + suffix;
}

const codexIndexCache = createLru(8);

async function readCodexSessionIndex(index) {
  const st = await fs.lstat(index, { bigint: true }).catch(() => undefined);
  if (!st?.isFile() || st.size > 8n * 1024n * 1024n) {
    codexIndexCache.delete(index);
    return;
  }
  const stamp = st.mtimeNs + ':' + st.ctimeNs + ':' + st.size + ':' + st.ino;
  const cached = codexIndexCache.get(index);
  if (cached && cached.stamp === stamp) return cached.entries;
  const data = await fs.readFile(index, 'utf8').catch(() => undefined);
  if (typeof data !== 'string') return;
  const entriesMap = new Map();
  for (const line of data.split('\n')) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (typeof row?.id !== 'string' || typeof row.thread_name !== 'string') continue;
      const at = typeof row.updated_at === 'string' ? Date.parse(row.updated_at) : NaN;
      entriesMap.set(row.id, { id: row.id, title: row.thread_name, at: Number.isFinite(at) ? at : 0 });
    } catch { /* Ignore a partial last entry. */ }
  }
  codexIndexCache.set(index, { stamp, entries: entriesMap });
  return entriesMap;
}

async function collectCodex(view, rows, base, executable) {
  if (!rows.length) return;
  const ids = [...new Set(rows.map(row => row.sessionId))];
  const files = await codexDbFiles(base);
  const records = [];
  for (const db of files) {
    const fields = await tableColumns(db, 'threads', executable);
    if (!fields.has('id') || !fields.has('title')) continue;
    const titleSql = codexTitleSql(fields);
    const usage = fields.has('tokens_used') ? 'tokens_used' : 'NULL';
    const named = fields.has('name') ? "length(trim(coalesce(name,''))) > 0" : '0';
    const time = fields.has('updated_at_ms') ? 'coalesce(updated_at_ms,updated_at*1000)' :
      fields.has('updated_at') ? 'updated_at*1000' : '0';
    records.push(...await querySessions(db, ids,
      list => 'SELECT id,' + titleSql + ' AS title,' + usage +
        ' AS quantity,' + named + ' AS named,' + time + ' AS updatedAt,' + codexExecutionColumns(fields) +
        ' FROM threads WHERE id IN (' + list + ')', executable));
    // The highest readable schema is the current state store.
    break;
  }
  for (const record of records) add(view, 'codex', { ...record, title:codexTitle(record),
    execution:nativeExecution(record.model,record.effort,'setting') }, n => '누적 ' + format(n) + ' 토큰');
  const usage = groupUsage(records, ' 토큰 누적');
  if (usage) view.providerUsage.codex = usage;

  // Codex also updates this small title-only index for renames. Its most
  // recent entry can precede or follow the SQLite title update.
  if (!ids.length) return;
  const indexEntries = await readCodexSessionIndex(path.join(base, 'session_index.jsonl'));
  if (!indexEntries?.size) return;
  const sqlById = new Map(records.map(row => [row.id, row]));
  for (const id of ids) {
    const entry = indexEntries.get(id);
    if (!entry) continue;
    const sqlRow = sqlById.get(entry.id);
    // Unnamed threads always accept session_index; explicitly named threads accept a strictly newer rename timestamp.
    if (!sqlRow?.named || (entry.at > 0 && entry.at > (Number(sqlRow.updatedAt) || 0))) {
      add(view, 'codex', { id: entry.id, title: entry.title });
    }
  }
}

function parseAgyWorkspacePaths(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const paths = [];
  for (const uri of parsed) {
    if (typeof uri !== 'string' || !uri.startsWith('file://')) continue;
    try {
      const folder = path.resolve(fileURLToPath(uri));
      if (!paths.includes(folder)) paths.push(folder);
    } catch { /* ignore invalid URI */ }
  }
  return paths;
}

async function collectAgy(view, rows, home, executable) {
  if (!rows.length) return;
  const ids = [...new Set(rows.map(r => r.sessionId))];
  const merged = new Map();
  for (const surface of AGY_SURFACES) {
    const db = path.join(home, '.gemini', surface, 'conversation_summaries.db');
    if (!await regular(db)) continue;
    const cols = await tableColumns(db, 'conversation_summaries', executable);
    if (!cols.has('conversation_id') || !cols.has('title')) continue;
    const quantity = cols.has('step_count') ? 'step_count' : 'NULL';
    const sourceCol = cols.has('source') ? 'source' : "''";
    const batch = await querySessions(db, ids,
      list => 'SELECT conversation_id AS id,substr(title,1,150) AS title,' + quantity + ' AS quantity,' + sourceCol + ' AS agySource ' +
        'FROM conversation_summaries WHERE conversation_id IN (' + list + ')', executable);
    for (const r of batch) {
      if (!validId(r.id)) continue;
      let current = merged.get(r.id);
      if (!current) {
        current = { id: r.id, title: '', quantity: undefined, agySource: '' };
        merged.set(r.id, current);
      }
      const nextTitle = titleText(r.title);
      if (!current.title && nextTitle) current.title = nextTitle;
      if (amount(r.quantity)) {
        if (current.quantity === undefined) current.quantity = r.quantity;
        else if (current.quantity === 0 && r.quantity > 0) current.quantity = r.quantity;
      }
      if (!current.agySource && typeof r.agySource === 'string' && r.agySource.trim()) {
        current.agySource = r.agySource.trim();
      }
    }
  }
  const records = [...merged.values()];
  for (const record of records) {
    add(view, 'agy', record, n => '대화 ' + format(n) + '단계');
  }
  const usage = groupUsage(records, '단계 진행');
  if (usage) view.providerUsage.agy = usage;
}

const HEAD_BYTES = 32768;
const TAIL_BYTES = 32768;
const TITLE_SCAN_LIMIT = 4 * 1024 * 1024;
const TITLE_SCAN_CHUNK = 65536;
const captionCache = createLru(256);

const INTERRUPTION_MARKER = /\[Request interrupted by user|The user doesn't want to proceed with this tool use/;
const TURN_INTERRUPTION_MARKER = /\[Request interrupted by user/;

function hasSubstantiveUserContent(content) {
  if (typeof content === 'string') return /\S/u.test(content);
  if (!Array.isArray(content)) return false;
  return content.some(part =>
    (part?.type === 'text' && typeof part.text === 'string' && /\S/u.test(part.text)) ||
    part?.type === 'image' || part?.type === 'document');
}

function isTurnInterruption(content) {
  if (typeof content === 'string') return TURN_INTERRUPTION_MARKER.test(content);
  if (!Array.isArray(content)) return false;
  return content.some(part =>
    part?.type === 'text' && typeof part.text === 'string' && TURN_INTERRUPTION_MARKER.test(part.text));
}

function isUserInterruption(content) {
  if (typeof content === 'string') return INTERRUPTION_MARKER.test(content);
  if (!Array.isArray(content)) return false;
  return content.some(part => {
    if (!part || typeof part !== 'object') return false;
    if (part.type === 'text' && typeof part.text === 'string' && INTERRUPTION_MARKER.test(part.text)) return true;
    if (part.type === 'tool_result') {
      if (typeof part.content === 'string' && INTERRUPTION_MARKER.test(part.content)) return true;
      if (Array.isArray(part.content)) {
        return part.content.some(sub => sub?.type === 'text' && typeof sub.text === 'string' && INTERRUPTION_MARKER.test(sub.text));
      }
    }
    return false;
  });
}

async function claudeWindows(file, includeHead) {
  let handle;
  try {
    handle = await fs.open(file,constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = await handle.stat();
    if (!st.isFile() || !st.size) return;
    const tailStart = Math.max(0,st.size-TAIL_BYTES);
    const whole = tailStart === 0 || (includeHead && tailStart <= HEAD_BYTES);
    const windows = whole ? [[0,st.size]] :
      [...(includeHead ? [[0,HEAD_BYTES]] : []), [tailStart,st.size]];
    const lines = [];
    let headCount = 0;
    for (const [start,end] of windows) {
      const buffer = Buffer.alloc(end-start);
      const {bytesRead} = await handle.read(buffer,0,buffer.length,start);
      const chunk = buffer.subarray(0,bytesRead).toString('utf8').split('\n');
      if (start > 0) chunk.shift();
      if (start + bytesRead < st.size) chunk.pop();
      lines.push(...chunk);
      if (!whole && start === 0) headCount = lines.length;
    }
    // `headCount` lines come from the head window; the rest are the newest records.
    return {lines,headCount:whole ? 0 : headCount,whole,updatedAt:Math.floor(st.mtimeMs),size:st.size};
  } catch { return; }
  finally { if (handle) await handle.close().catch(() => {}); }
}

// Claude appends ai-title/custom-title records mid-transcript; scan the middle gap boundedly
// for title records only when head+tail windows did not contain one.
async function scanMiddleTitles(file, id, size) {
  const start = HEAD_BYTES;
  const end = Math.min(size - TAIL_BYTES, start + TITLE_SCAN_LIMIT);
  if (end <= start) return {};
  let handle;
  let manual, ai;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let carry = '';
    const buf = Buffer.alloc(TITLE_SCAN_CHUNK);
    for (let pos = start; pos < end; pos += TITLE_SCAN_CHUNK) {
      const toRead = Math.min(TITLE_SCAN_CHUNK, end - pos);
      const { bytesRead } = await handle.read(buf, 0, toRead, pos);
      if (!bytesRead) break;
      const lines = (carry + buf.subarray(0, bytesRead).toString('utf8')).split('\n');
      if (pos === start) lines.shift();
      carry = lines.pop() || '';
      for (const line of lines) {
        if (!/"type"\s*:\s*"(?:custom-title|ai-title)"/.test(line)) continue;
        try {
          const item = JSON.parse(line);
          if (item.sessionId && item.sessionId !== id) continue;
          if (item.isSidechain === true || item.isMeta || item.isCompactSummary) continue;
          if (item.type === 'custom-title') manual = titleText(item.customTitle) || manual;
          if (item.type === 'ai-title') ai = titleText(item.aiTitle) || ai;
        } catch { /* Ignore partial line. */ }
      }
    }
  } catch { /* Best-effort title scan. */ }
  finally { if (handle) await handle.close().catch(() => {}); }
  return { manual, ai };
}

// A single tool result or file dump can be larger than the tail window, pushing
// the latest assistant record out of it. Walk back from the end of the file in
// bounded chunks, visiting complete lines newest first, until `visit` returns true.
const BACK_SCAN_CHUNK = 65536;
const BACK_SCAN_LIMIT = 1024 * 1024;

async function scanLinesBackward(file, visit, limit = BACK_SCAN_LIMIT) {
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = await handle.stat();
    if (!st.isFile() || !st.size) return;
    const floor = Math.max(0, st.size - limit);
    // Pieces of the line that continues past the chunk being read, in file order.
    let carry = [];
    let pos = st.size;
    while (pos > floor) {
      const start = Math.max(floor, pos - BACK_SCAN_CHUNK);
      const buffer = Buffer.alloc(pos - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      if (bytesRead !== buffer.length) return;
      let lineEnd = buffer.length;
      for (let i = buffer.length - 1; i >= 0; i--) {
        if (buffer[i] !== 0x0a) continue;
        const piece = buffer.subarray(i + 1, lineEnd);
        const line = carry.length ? Buffer.concat([piece, ...carry]) : piece;
        carry = [];
        lineEnd = i;
        if (line.length && visit(line)) return;
      }
      if (lineEnd) carry.unshift(buffer.subarray(0, lineEnd));
      pos = start;
    }
    // Only the first line of the file is complete without a preceding newline.
    if (floor === 0 && carry.length) visit(Buffer.concat(carry));
  } catch { /* Best-effort scan. */ }
  finally { if (handle) await handle.close().catch(() => {}); }
}

const ASSISTANT_BYTES = Buffer.from('"assistant"');
const USER_BYTES = Buffer.from('"user"');
const INTERRUPTION_BYTES = [Buffer.from('[Request interrupted by user'), Buffer.from("doesn't want to proceed with this tool use")];
const parseLine = line => { try { return JSON.parse(line.toString('utf8')); } catch { return undefined; } };

function claudeResponse(item, rootId, agentId) {
  if (item.type !== 'assistant' || item.sessionId !== rootId || item.isMeta || item.isCompactSummary ||
      item.message?.role !== 'assistant') return;
  if (agentId ? item.agentId !== agentId || item.isSidechain !== true : item.agentId || item.isSidechain === true) return;
  const at = typeof item.timestamp === 'string' ? Date.parse(item.timestamp) : undefined;
  return nativeExecution(item.message.model,undefined,'response',at);
}

// Newest first: user interruptions until the latest reply of the main conversation,
// and the latest observed response model. Interruptions older than that reply were
// answered and no longer describe the turn.
async function claudeRecentTurn(file, id, { wantExecution = true, wantTurn = true } = {}) {
  const result = {};
  let needExecution = wantExecution, needTurn = wantTurn;
  const stamp = item => {
    const at = typeof item.timestamp === 'string' ? Date.parse(item.timestamp) : NaN;
    return Number.isSafeInteger(at) && at > 0 ? at : undefined;
  };
  await scanLinesBackward(file, line => {
    const assistant = line.includes(ASSISTANT_BYTES);
    const interruption = needTurn && line.includes(USER_BYTES) && INTERRUPTION_BYTES.some(marker => line.includes(marker));
    if (!assistant && !interruption) return false;
    const item = parseLine(line);
    if (!item || (item.sessionId && item.sessionId !== id) || item.isSidechain === true || item.isMeta || item.isCompactSummary) return false;
    if (item.type === 'assistant') {
      if (needExecution) {
        const observed = claudeResponse(item, id);
        if (observed) { result.execution = observed; needExecution = false; }
      }
      if (needTurn && !item.agentId) { result.rootReply = true; needTurn = false; }
    } else if (item.type === 'user' && needTurn) {
      const at = stamp(item);
      if (at && isUserInterruption(item.message?.content)) result.interruptedAt = Math.max(result.interruptedAt || 0, at);
      if (at && isTurnInterruption(item.message?.content)) result.turnInterruptedAt = Math.max(result.turnInterruptedAt || 0, at);
    }
    return !needExecution && !needTurn;
  });
  return result;
}

const CHILD_RESPONSE_MAX = 256;
const childResponseCache = createLru(CHILD_RESPONSE_MAX);

async function claudeChildResponse(file, rootId, agentId) {
  const st = await fs.lstat(file, { bigint: true }).catch(() => undefined);
  if (!st?.isFile() || !st.size) return;
  const cached = childResponseCache.get(file);
  if (cached && cached.size === st.size && cached.mtimeNs === st.mtimeNs && cached.ctimeNs === st.ctimeNs &&
      cached.ino === st.ino && cached.rootId === rootId && cached.agentId === agentId) {
    return cached.value;
  }
  const window = await claudeWindows(file, false);
  if (!window) return;
  let value;
  for (let i = window.lines.length - 1; i >= 0; i--) {
    const line = window.lines[i];
    if (!/"type"\s*:\s*"assistant"/.test(line)) continue;
    try {
      const observation = claudeResponse(JSON.parse(line), rootId, agentId);
      if (observation) { value = observation; break; }
    } catch { /* Ignore partial or invalid JSONL records. */ }
  }
  if (!value && !window.whole) {
    await scanLinesBackward(file, line => {
      if (!line.includes(ASSISTANT_BYTES)) return false;
      const item = parseLine(line);
      value = item && claudeResponse(item, rootId, agentId);
      return Boolean(value);
    });
  }
  childResponseCache.set(file, { rootId, agentId, size: st.size, mtimeNs: st.mtimeNs, ctimeNs: st.ctimeNs, ino: st.ino, value });
  return value;
}

async function claudeCaption(file, id) {
  if (!UUID_RE.test(id)) return;
  const st = await fs.lstat(file, { bigint: true }).catch(() => undefined);
  if (!st?.isFile() || !st.size) return;
  const cached = captionCache.get(file);
  if (cached && cached.size === st.size && cached.mtimeNs === st.mtimeNs && cached.ctimeNs === st.ctimeNs &&
      cached.ino === st.ino && cached.id === id) {
    return cached.value;
  }
  const window = await claudeWindows(file,true);
  if (!window) return;
  let manual, ai, cwd, execution, hasUser = false, interruptedAt, turnInterruptedAt;
  let tailExecution, tailRootReply = false;
  for (let index = 0; index < window.lines.length; index++) {
    const line = window.lines[index];
    if (!/"type"\s*:\s*"(?:user|assistant|custom-title|ai-title)"/.test(line)) continue;
    let item;
    try { item = JSON.parse(line); } catch { continue; }
    if (item.sessionId && item.sessionId !== id) continue;
    if (item.isSidechain === true || item.isMeta || item.isCompactSummary) continue;
    if (item.type === 'assistant') {
      const observed = claudeResponse(item,id);
      execution = observed || execution;
      if (!item.agentId) turnInterruptedAt = undefined;
      if (index >= window.headCount) {
        tailExecution = observed || tailExecution;
        if (!item.agentId) tailRootReply = true;
      }
    }
    if (item.type === 'custom-title') manual = titleText(item.customTitle) || manual;
    if (item.type === 'ai-title') ai = titleText(item.aiTitle) || ai;
    if (item.type === 'user') {
      if (hasSubstantiveUserContent(item.message?.content)) hasUser = true;
      if (!cwd && typeof item.cwd === 'string' && path.isAbsolute(item.cwd)) cwd = item.cwd;
      const at = typeof item.timestamp === 'string' ? Date.parse(item.timestamp) : NaN;
      if (isUserInterruption(item.message?.content)) {
        if (Number.isSafeInteger(at) && at > 0) interruptedAt = Math.max(interruptedAt || 0, at);
      }
      if (isTurnInterruption(item.message?.content)) {
        if (Number.isSafeInteger(at) && at > 0) turnInterruptedAt = Math.max(turnInterruptedAt || 0, at);
      }
    }
  }
  // The tail held no reply of the main conversation: recover the latest model, and
  // whether that turn was interrupted, from the records that precede it.
  if (!window.whole && (!tailExecution || !tailRootReply)) {
    const back = await claudeRecentTurn(file, id, { wantExecution: !tailExecution, wantTurn: !tailRootReply });
    if (back.execution) execution = back.execution;
    if (!tailRootReply) {
      if (back.rootReply) turnInterruptedAt = back.turnInterruptedAt;
      else if (back.turnInterruptedAt) turnInterruptedAt = Math.max(turnInterruptedAt || 0, back.turnInterruptedAt);
    }
    if (back.interruptedAt) interruptedAt = Math.max(interruptedAt || 0, back.interruptedAt);
  }
  if (!manual && !ai && window.size > HEAD_BYTES + TAIL_BYTES) {
    const mid = await scanMiddleTitles(file, id, window.size);
    manual = manual || mid.manual;
    ai = ai || mid.ai;
  }
  const value = { id, title: manual || ai, titleKind: manual ? 'custom' : ai ? 'ai' : undefined,
    cwd, hasUser, execution, ...(interruptedAt && { interruptedAt }), ...(turnInterruptedAt && { turnInterruptedAt }), updatedAt: window.updatedAt };
  captionCache.set(file, { id, size: st.size, mtimeNs: st.mtimeNs, ctimeNs: st.ctimeNs, ino: st.ino, value });
  return value;
}

async function collectClaudeCaptions(view, rows, base, setRankedTitle, discoveredPaths, onDiscovered) {
  const wanted = rows.filter(r => !r.isSubagent && UUID_RE.test(r.sessionId));
  if (!wanted.length) return;
  const projects = path.join(base,'projects');
  let fallbackFolders;
  const loadFallback = async () => {
    if (!fallbackFolders) fallbackFolders = (await entries(projects)).filter(f => f.isDirectory()).slice(0,100).map(f => f.name);
    return fallbackFolders;
  };
  for (const row of wanted) {
    const hasCwd = typeof row.cwd === 'string' && path.isAbsolute(row.cwd);
    const localSlug = hasCwd ? projectSlug(row.cwd) : '';
    const main = hasCwd ? await mainCheckout(row.cwd) : undefined;
    const mainSlug = main ? projectSlug(main) : '';
    const prioritized = [...new Set([localSlug, mainSlug].filter(Boolean))];
    let metadata;
    for (const slug of prioritized) {
      metadata = await claudeCaption(path.join(projects,slug,row.sessionId+'.jsonl'),row.sessionId);
      if (metadata) break;
    }
    if (!metadata) {
      const remembered = discoveredPaths?.get(row.sessionId);
      if (remembered) {
        metadata = await claudeCaption(remembered, row.sessionId);
        if (!metadata) discoveredPaths.delete(row.sessionId);
      }
    }
    // Only scan unrelated project folders when the worktree main checkout could not be determined.
    if (!metadata && !main) {
      const checked = new Set(prioritized);
      for (const slug of await loadFallback()) {
        if (checked.has(slug)) continue;
        const candidate = path.join(projects,slug,row.sessionId+'.jsonl');
        metadata = await claudeCaption(candidate,row.sessionId);
        if (metadata) {
          onDiscovered?.(row.sessionId, candidate);
          break;
        }
      }
    }
    if (metadata) {
      add(view, 'claude', { id: metadata.id, execution: metadata.execution, interruptedAt: metadata.interruptedAt, turnInterruptedAt: metadata.turnInterruptedAt });
      if (metadata.title) setRankedTitle(metadata.id, metadata.title, metadata.titleKind === 'custom' ? 4 : 2);
    }
  }
}

async function recentClaudeCaptions(roots, projects, dirs, range, discoveredFiles) {
  const candidates = [];
  for (const dir of dirs) {
    const full = path.join(projects,dir);
    const children = (await entries(full)).filter(entry => entry.isFile() && entry.name.endsWith('.jsonl') &&
      UUID_RE.test(entry.name.slice(0,-6)));
    for (let i = 0; i < children.length; i += 32) {
      const batch = await Promise.all(children.slice(i,i+32).map(async f => {
        const file = path.join(full,f.name);
        const stat = await fs.lstat(file).catch(() => undefined);
        if (stat?.isFile() && stat.mtimeMs >= range.start && stat.mtimeMs <= range.end)
          return {file,id:f.name.slice(0,-6),updatedAt:stat.mtimeMs};
      }));
      candidates.push(...batch.filter(Boolean));
    }
  }
  const found = [];
  for (const candidate of candidates.sort((a,b) => b.updatedAt-a.updatedAt).slice(0,12)) {
    const item = await claudeCaption(candidate.file,candidate.id);
    if (item?.cwd && roots.some(root => isUnderDir(path.resolve(item.cwd),root)) && item.hasUser) {
      discoveredFiles?.add(candidate.file);
      found.push(item);
    }
    if (found.length >= RECENT_LIMIT) break;
  }
  return found;
}

const claudeStatsCache = createLru(16);
const claudePidCache = createLru(16);

async function livePidDirSnapshot(liveDir, limit = Infinity) {
  const dirStamp = await statStamp(liveDir);
  if (!dirStamp) return { dirStamp: '', files: [], fp: '' };
  const all = (await entries(liveDir))
    .filter(f => f.isFile() && /^\d+\.json$/.test(f.name))
    .map(f => f.name)
    .sort();
  const files = Number.isFinite(limit) ? all.slice(0, limit) : all;
  const stamps = await Promise.all(files.map(name => statStamp(path.join(liveDir, name))));
  const fp = dirStamp + '|' + all.length + '|' + files.map((name, i) => name + '=' + stamps[i]).join(',');
  return { dirStamp, files, fp };
}

async function readClaudeStats(statsPath) {
  const stamp = await statStamp(statsPath);
  if (!stamp) return;
  const cached = claudeStatsCache.get(statsPath);
  if (cached && cached.stamp === stamp) return cached.usage;
  const item = await readJsonSafe(statsPath, 4 * 1024 * 1024);
  const usage = isObject(item) && typeof item.lastComputedDate === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(item.lastComputedDate) && amount(item.totalMessages)
    ? item.lastComputedDate + ' 기준 · 누적 메시지 ' + format(item.totalMessages) + '개'
    : undefined;
  claudeStatsCache.set(statsPath, { stamp, usage });
  return usage;
}

async function readClaudePidSessions(liveDir) {
  const { dirStamp, files: live, fp } = await livePidDirSnapshot(liveDir);
  if (!dirStamp || !live.length) return [];
  const cached = claudePidCache.get(liveDir);
  if (cached && cached.fp === fp) return cached.records;
  const records = [];
  for (let i = 0; i < live.length; i += 32) {
    const batch = await Promise.all(live.slice(i, i + 32).map(async name => {
      const data = await readJsonSafe(path.join(liveDir, name), 256 * 1024);
      if (!isObject(data)) return;
      const id = typeof data.sessionId === 'string' ? data.sessionId : undefined;
      if (!id) return;
      const rawUpdated = data.updatedAt ?? data.startedAt;
      return {
        id,
        cwd: typeof data.cwd === 'string' ? data.cwd : undefined,
        name: typeof data.name === 'string' ? data.name.slice(0, 150) : undefined,
        nameSource: typeof data.nameSource === 'string' ? data.nameSource : undefined,
        status: typeof data.status === 'string' ? data.status : undefined,
        kind: typeof data.kind === 'string' ? data.kind : undefined,
        updatedAt: typeof rawUpdated === 'number' && Number.isFinite(rawUpdated) ? rawUpdated : undefined,
      };
    }));
    for (const item of batch) if (item) records.push(item);
  }
  claudePidCache.set(liveDir, { fp, records });
  return records;
}

async function collectClaude(view, rows, base, executable, discoveredPaths, onDiscovered) {
  if (!rows.length) return;
  // /stats is an aggregate cache; always display its own cutoff date.
  const statsUsage = await readClaudeStats(path.join(base, 'stats-cache.json'));
  if (statsUsage) view.providerUsage.claude = statsUsage;
  const ids = [...new Set(rows.map(r => r.sessionId))];
  const projects = path.join(base, 'projects');
  const dirs = new Set();
  for (const row of rows) {
    if (typeof row.cwd !== 'string' || !path.isAbsolute(row.cwd)) continue;
    dirs.add(projectSlug(row.cwd));
    const main = await mainCheckout(row.cwd);
    if (main) dirs.add(projectSlug(main));
  }
  // Explicit precedence: explicit live PID name (5) > JSONL custom-title (4) >
  // index customTitle (3) > JSONL ai-title / live auto name (2) > index summary (1).
  // Derived startup slugs (nameSource='derived') are never used as titles.
  const ranks = new Map();
  const setRankedTitle = (id, rawTitle, rank) => {
    const clean = titleText(rawTitle);
    if (!clean || rank < (ranks.get(id) || 0)) return;
    ranks.set(id, rank);
    add(view, 'claude', { id, title: clean });
  };
  // The legacy index includes firstPrompt. Return only matching id, name,
  // and message count from SQLite's projection, never the original JSON.
  for (const dir of dirs) {
    const index = path.join(projects, dir, 'sessions-index.json');
    if (!await regular(index, 8 * 1024 * 1024)) continue;
    for (let i = 0; i < ids.length; i += 200) {
      const idList = ids.slice(i, i + 200).map(quote).join(',');
      const found = await query(':memory:',
        "SELECT json_extract(value,'$.sessionId') AS id,substr(json_extract(value,'$.customTitle'),1,150) AS customTitle," +
        "substr(json_extract(value,'$.summary'),1,150) AS summary,json_extract(value,'$.messageCount') AS quantity " +
        'FROM json_each(CAST(readfile(' + quote(index) + ") AS TEXT),'$.entries') WHERE json_extract(value,'$.sessionId') IN (" + idList + ')',
        executable);
      for (const row of found) {
        add(view, 'claude', { id: row.id, quantity: row.quantity }, n => '메시지 ' + format(n) + '개');
        if (row.customTitle) setRankedTitle(row.id, row.customTitle, 3);
        else if (row.summary) setRankedTitle(row.id, row.summary, 1);
      }
    }
  }

  // Current Claude Code publishes live session names in small PID records.
  // Ignore auto-derived startup slugs (nameSource='derived') so real titles shine through.
  const wantedIds = new Set(ids);
  const liveRecords = await readClaudePidSessions(path.join(base, 'sessions'));
  for (const row of liveRecords) {
    if (!wantedIds.has(row.id) || row.nameSource === 'derived') continue;
    setRankedTitle(row.id, row.name, row.nameSource === 'auto' ? 2 : 5);
  }
  await collectClaudeCaptions(view, rows, base, setRankedTitle, discoveredPaths, onDiscovered);
}

async function metadataFingerprint(valid, env, homeDir, discoveredPaths) {
  const providers = new Set(valid.map(r => r.provider));
  const checks = [];
  if (providers.has('agy')) {
    for (const surface of AGY_SURFACES) {
      checks.push(dbStamp(path.join(homeDir, '.gemini', surface, 'conversation_summaries.db')));
    }
  }
  if (providers.has('codex')) {
    const base = configDir('codex', homeDir, env);
    checks.push(statStamp(base), statStamp(path.join(base, 'session_index.jsonl')));
    const newest = await latestCodexDb(base);
    if (newest) checks.push(dbStamp(newest));
  }
  if (providers.has('claude')) {
    const base = configDir('claude', homeDir, env);
    checks.push(
      livePidDirSnapshot(path.join(base, 'sessions'), 64).then(s => s.fp),
      statStamp(path.join(base, 'stats-cache.json')),
    );
    const seenSlugs = new Set();
    const seenJsonl = new Set();
    const claudeRows = valid.filter(r => r.provider === 'claude')
      .sort((a, b) => a.sessionId.localeCompare(b.sessionId)).slice(0, 32);
    for (const row of claudeRows) {
      if (typeof row.cwd === 'string' && path.isAbsolute(row.cwd)) {
        const main = await mainCheckout(row.cwd);
        const slugs = [...new Set([projectSlug(row.cwd), main ? projectSlug(main) : ''].filter(Boolean))];
        for (const slug of slugs) {
          if (!seenSlugs.has(slug)) {
            seenSlugs.add(slug);
            checks.push(statStamp(path.join(base, 'projects', slug, 'sessions-index.json')));
          }
          if (UUID_RE.test(row.sessionId)) {
            const jsonl = path.join(base, 'projects', slug, row.sessionId + '.jsonl');
            if (!seenJsonl.has(jsonl)) { seenJsonl.add(jsonl); checks.push(statStamp(jsonl)); }
          }
        }
      }
      const discovered = discoveredPaths?.get(row.sessionId);
      if (discovered && !seenJsonl.has(discovered)) {
        seenJsonl.add(discovered);
        checks.push(statStamp(discovered));
      }
    }
  }
  return (await Promise.all(checks)).join('|');
}

// Hook events arrive in bursts and each one schedules a scan 100 ms later. Within this
// window the same rows reuse the previous answer without statting every source again.
const REUSE_MS = 1500;

function createMetadataReader({ homeDir = os.homedir(), env = process.env, cacheMs = 12000,
  sqlitePath = defaultSqlitePath(env), now = Date.now } = {}) {
  let last;
  let timestamp;
  let signature;
  let checkedKeys, lastKeys, checkedAt = -Infinity;
  const discoveredPaths = createLru(64);
  const safetyTtl = cacheMs > 0 ? Math.max(cacheMs, 5 * 60000) : 0;
  const reuseMs = cacheMs > 0 ? Math.min(REUSE_MS, cacheMs) : 0;
  return async function readMetadata(rows, { force = false } = {}) {
    if (force) { clearMainCheckoutCache(); discoveredPaths.clear(); }
    const valid = rows.filter(r => r && validId(r.sessionId) && ['claude','codex','agy'].includes(r.provider));
    const keyTuple = valid.map(r => [r.provider, r.sessionId, r.cwd]).sort((a, b) =>
      (a[0] + '\0' + a[1]).localeCompare(b[0] + '\0' + b[1]));
    const keys = JSON.stringify(keyTuple);
    const started = now();
    // Reused only as the answer for these very rows, checked moments ago.
    if (!force && last && keys === lastKeys && keys === checkedKeys && started - checkedAt >= 0 && started - checkedAt < reuseMs) return last;
    checkedKeys = keys;
    checkedAt = started;
    let fp = await metadataFingerprint(valid, env, homeDir, discoveredPaths);
    let next = JSON.stringify([keyTuple, fp]);
    if (!force && last && signature === next && now() - timestamp < safetyTtl) return last;
    const view = { sessions: new Map(), providerUsage: {} };
    const by = provider => valid.filter(r => r.provider === provider);
    let discoveredChanged = false;
    const onDiscovered = (id, file) => {
      if (discoveredPaths.get(id) !== file) {
        discoveredPaths.set(id, file);
        discoveredChanged = true;
      }
    };
    await Promise.allSettled([
      collectCodex(view, by('codex'), configDir('codex', homeDir, env), sqlitePath),
      collectAgy(view, by('agy'), homeDir, sqlitePath),
      collectClaude(view, by('claude'), configDir('claude', homeDir, env), sqlitePath, discoveredPaths, onDiscovered),
    ]);
    // A live Claude process removes its PID record at exit. Keep the most
    // recent title in memory while that session remains on the board.
    for (const row of valid) {
      const key = row.provider + '/' + row.sessionId;
      const remembered = last?.sessions.get(key)?.title;
      if (remembered && !view.sessions.get(key)?.title)
        view.sessions.set(key, { ...view.sessions.get(key), title: remembered });
    }
    if (discoveredChanged) {
      fp = await metadataFingerprint(valid, env, homeDir, discoveredPaths);
      next = JSON.stringify([keyTuple, fp]);
    }
    signature = next;
    timestamp = now();
    last = view;
    lastKeys = keys;
    return view;
  };
}


const RECENT_LIMIT = 4;
const RECENT_DAYS_MS = 7 * DAY;
const AGY_CANDIDATE_LIMIT = 600;
const underSql = (field, roots) => '(' + roots.map(root => {
  const prefix = root.endsWith('/') ? root : root + '/';
  return '(' + field + '=' + quote(root) + ' OR substr(' + field + ',1,' +
    'length(' + quote(prefix) + '))=' + quote(prefix) + ')';
}).join(' OR ') + ')';

async function recentCodex(roots, range, base, executable) {
  const databases = await codexDbFiles(base);
  for (const db of databases) {
    const cols = await tableColumns(db, 'threads', executable);
    if (!['id','cwd','title','updated_at'].every(k => cols.has(k))) continue;
    const time = cols.has('updated_at_ms') ? 'coalesce(updated_at_ms,updated_at*1000)' : 'updated_at*1000';
    const filters = [underSql('cwd',roots), time + ' BETWEEN ' + range.start + ' AND ' + range.end];
    if (cols.has('archived')) filters.push('coalesce(archived,0)=0');
    if (cols.has('source')) filters.push('source IN (' + CODEX_INTERACTIVE_SOURCES.map(quote).join(',') + ')');
    if (cols.has('thread_source')) filters.push("coalesce(thread_source,'user') IN ('user','voice_chat')");
    for (const field of ['agent_role','agent_nickname','agent_path','attached_thread_parent_id'])
      if (cols.has(field)) filters.push("coalesce(" + field + ",'')=''");
    if (cols.has('ephemeral')) filters.push('coalesce(ephemeral,0)=0');
    const title = cols.has('name') ? "coalesce(nullif(name,''),title)" : 'title';
    // Codex defines visible non-empty threads via preview <> '' (never has_user_event, which stays 0).
    if (cols.has('preview')) {
      filters.push("(length(trim(coalesce(preview,'')))>0 OR length(trim(coalesce(" + (cols.has('name') ? 'name' : 'title') + ",'')))>0)");
    } else {
      filters.push('length(trim(coalesce(' + title + ",'')))>0");
    }
    const named = cols.has('name') ? "length(trim(coalesce(name,'')))>0" : '0';
    const records = await query(db,'SELECT id,cwd,' + codexTitleSql(cols) + ' AS title,' + named + ' AS named,' +
      time + ' AS updatedAt FROM threads WHERE ' + filters.join(' AND ') +
      ' ORDER BY updatedAt DESC,id LIMIT ' + RECENT_LIMIT,executable);
    return records.map(record => ({ ...record, title:codexTitle(record) }));
  }
  return [];
}

async function recentAgy(roots, range, home, executable) {
  const uriRoots = roots.map(root => pathToFileURL(root).href);
  const surfaceDbs = [];
  for (const surface of AGY_SURFACES) {
    const db = path.join(home, '.gemini', surface, 'conversation_summaries.db');
    if (!await regular(db)) continue;
    const cols = await tableColumns(db, 'conversation_summaries', executable);
    if (cols.has('conversation_id')) surfaceDbs.push({ db, cols });
  }

  const candidateIds = new Set();
  // Workspace, title and timestamps may each exist in different copies. Select only
  // scoped identifiers here, newest first, then apply recency and the UI limit to the
  // merged rows. A copy without a usable time may take it from another surface, so it
  // is kept ahead of dated ones; the long tail of old conversations is never paged.
  for (const { db, cols } of surfaceDbs) {
    if (!cols.has('workspace_uris')) continue;
    const time = cols.has('last_modified_time')
      ? "CAST(strftime('%s',s.last_modified_time) AS INTEGER)" : 'NULL';
    const page = await query(db,
      'SELECT id FROM (SELECT s.conversation_id AS id,' + time + ' AS t FROM conversation_summaries s ' +
      'WHERE length(s.conversation_id) BETWEEN 1 AND 200 AND EXISTS (SELECT 1 FROM ' +
      "json_each(CASE WHEN json_valid(s.workspace_uris) THEN s.workspace_uris ELSE '[]' END) w " +
      'WHERE ' + underSql('w.value', uriRoots) + ')) ' +
      'ORDER BY coalesce(t,0)>0, t DESC, id LIMIT ' + AGY_CANDIDATE_LIMIT, executable);
    for (const row of page) if (validId(row.id)) candidateIds.add(row.id);
  }
  if (!candidateIds.size) return [];

  // Pass 2: fetch all fields for every candidate from all surfaces and merge field-by-field by conversation_id.
  const ids = [...candidateIds];
  const merged = new Map();
  for (const { db, cols } of surfaceDbs) {
    const hasUserInputCol = cols.has('last_user_input_time');
    const selectFields = [
      'conversation_id AS id',
      (cols.has('workspace_uris') ? 'workspace_uris' : 'NULL') + ' AS workspaceUris',
      (cols.has('title') ? 'substr(title,1,150)' : 'NULL') + ' AS title',
      (cols.has('last_modified_time') ? "CAST(strftime('%s',last_modified_time) AS INTEGER)*1000" : 'NULL') + ' AS updatedAt',
      (hasUserInputCol ? "CAST(strftime('%s',last_user_input_time) AS INTEGER)*1000" : 'NULL') + ' AS userInputAt',
      (cols.has('parent_conversation_id') ? 'parent_conversation_id' : 'NULL') + ' AS parentId',
      ...['nesting_depth', 'killed', 'archived'].map(name => cols.has(name) ? name : '0 AS ' + name),
    ];
    const batch = await querySessions(db, ids,
      list => 'SELECT ' + selectFields.join(',') + ' FROM conversation_summaries WHERE conversation_id IN (' + list + ')',
      executable);
    for (const row of batch) {
      if (!validId(row.id)) continue;
      let current = merged.get(row.id);
      if (!current) {
        current = {
          id: row.id, title: '', updatedAt: 0,
          userInputAt: 0, sawUserInputCol: false, workspacePaths: [], excluded: false,
        };
        merged.set(row.id, current);
      }
      if (row.parentId || Number(row.nesting_depth) > 0 || Number(row.killed) !== 0 || Number(row.archived) !== 0) {
        current.excluded = true;
      }
      const nextTitle = titleText(row.title);
      if (!current.title && nextTitle) current.title = nextTitle;
      if (Number.isSafeInteger(row.updatedAt) && row.updatedAt > 0 && row.updatedAt <= range.end && row.updatedAt > current.updatedAt) {
        current.updatedAt = row.updatedAt;
      }
      if (hasUserInputCol) {
        current.sawUserInputCol = true;
        if (Number.isSafeInteger(row.userInputAt) && row.userInputAt > current.userInputAt) {
          current.userInputAt = row.userInputAt;
        }
      }
      for (const folder of parseAgyWorkspacePaths(row.workspaceUris)) {
        if (!current.workspacePaths.includes(folder)) current.workspacePaths.push(folder);
      }
    }
  }

  const result = [];
  for (const item of merged.values()) {
    if (item.excluded || !item.title) continue;
    if (item.sawUserInputCol && item.userInputAt <= 0) continue;
    if (item.updatedAt < range.start || item.updatedAt > range.end) continue;
    const cwd = item.workspacePaths.find(folder => roots.some(root => isUnderDir(folder, root)));
    if (!cwd) continue;
    result.push({ id: item.id, cwd, title: item.title, updatedAt: item.updatedAt });
  }
  return result.sort((a, b) => (b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id));
}

const projectSlug = cwd => cwd.replace(/[^A-Za-z0-9-]/g,'-');

const MAIN_CHECKOUT_TTL_MS = 60000;
const MAIN_CHECKOUT_MAX = 64;
const mainCheckoutCache = createLru(MAIN_CHECKOUT_MAX);

function clearMainCheckoutCache() {
  mainCheckoutCache.clear();
}

// Linked worktrees may store their sessions under the main checkout's slug.
// Verify Git's reciprocal registration before considering that checkout.
async function resolveMainCheckout(folder) {
  for (let dir=folder; ; dir=path.dirname(dir)) {
    const marker = path.join(dir,'.git');
    const st = await fs.lstat(marker).catch(() => undefined);
    if (st) {
      if (!st.isFile() || st.size > 8192) return;
      const pointer = (await fs.readFile(marker,'utf8').catch(() => '')).trim().match(/^gitdir: ([^\r\n]+)$/);
      if (!pointer) return;
      const admin = path.resolve(dir,pointer[1]);
      if (path.basename(path.dirname(admin)) !== 'worktrees') return;
      const common = path.dirname(path.dirname(admin));
      if (path.basename(common) !== '.git') return;
      const back = path.join(admin,'gitdir');
      if (!await regular(back,8192)) return;
      const target = (await fs.readFile(back,'utf8').catch(() => '')).trim();
      if (!target) return;
      const real = name => fs.realpath(name).catch(() => undefined);
      const [linked,expected] = await Promise.all([real(path.resolve(admin,target)),real(marker)]);
      return linked && linked === expected ? path.dirname(common) : undefined;
    }
    if (dir === path.dirname(dir)) return;
  }
}

async function mainCheckout(folder) {
  if (typeof folder !== 'string' || !folder) return;
  const nowMs = Date.now();
  const cached = mainCheckoutCache.get(folder);
  if (cached && nowMs - cached.at < MAIN_CHECKOUT_TTL_MS) return cached.value;
  const value = await resolveMainCheckout(folder);
  mainCheckoutCache.set(folder, { value, at: nowMs });
  return value;
}

// Follow only workspace directories which can encode a known Claude slug.
async function childDirs(folder) {
  const handle = await fs.opendir(folder).catch(() => undefined);
  if (!handle) return [];
  const children = [];
  let inspected = 0;
  try {
    for await (const entry of handle) {
      if (entry.isDirectory()) children.push(entry.name);
      if (++inspected >= 2048) break;
    }
  } catch { /* A workspace can be removed during discovery. */ }
  return children;
}

async function recentClaudeDirs(roots, projects) {
  const names = new Set((await entries(projects)).filter(e => e.isDirectory()).map(e => e.name));
  const exact = roots.map(projectSlug);
  const indexes = new Set(exact.filter(name => names.has(name)));
  const captions = new Set(indexes);
  // A prefix may also spell a sibling project ("/repo-other" and "/repo/other"
  // share a slug). An index can verify its own cwd. For transcript discovery,
  // also require an actual descendant directory and never follow a symlink.
  const nested = [...names].filter(name => exact.some(prefix => name.startsWith(prefix + '-'))).sort().slice(0,100);
  for (const name of nested) indexes.add(name);
  const prefixes = new Set();
  for (const name of nested) {
    for (let i=1; i<name.length; i++) if (name[i] === '-') prefixes.add(name.slice(0,i));
  }
  const paths = roots.map(folder => ({folder,depth:0}));
  const visited = new Set(roots);
  const nestedNames = new Set(nested);
  for (let i=0; i<paths.length && i<128; i++) {
    const {folder,depth} = paths[i];
    if (depth >= 16 || !prefixes.has(projectSlug(folder))) continue;
    for (const name of await childDirs(folder)) {
      const child = path.join(folder,name);
      const slug = projectSlug(child);
      if (nestedNames.has(slug)) captions.add(slug);
      if (prefixes.has(slug) && !visited.has(child)) {
        visited.add(child); paths.push({folder:child,depth:depth+1});
      }
    }
  }
  for (const main of await Promise.all(roots.map(mainCheckout))) {
    if (main && names.has(projectSlug(main))) {
      indexes.add(projectSlug(main)); captions.add(projectSlug(main));
    }
  }
  return {indexes,captions};
}

async function recentClaude(roots, range, base, executable, discoveredFiles) {
  const result = [];
  const projects = path.join(base,'projects');
  const dirs = await recentClaudeDirs(roots,projects);
  for (const dir of dirs.indexes) {
    const index = path.join(base,'projects',dir,'sessions-index.json');
    if (!await regular(index,8 * 1024 * 1024)) continue;
    const found = await query(':memory:',
      'WITH source(j) AS (SELECT CAST(readfile(' + quote(index) + ') AS TEXT)), ' +
      "data AS (SELECT json_extract(value,'$.sessionId') AS session, coalesce(json_extract(value,'$.projectPath')," +
      "json_extract(j,'$.originalPath')) AS cwd,substr(coalesce(nullif(json_extract(value,'$.customTitle'),'')," +
      "json_extract(value,'$.summary')),1,150) AS title,coalesce(CAST(strftime('%s',json_extract(value,'$.modified')) AS INTEGER)*1000," +
      "json_extract(value,'$.fileMtime')) AS updatedAt FROM source,json_each(j,'$.entries') " +
      "WHERE coalesce(json_extract(value,'$.isSidechain'),0)=0 AND coalesce(json_extract(value,'$.archived'),0)=0 " +
      "AND coalesce(json_extract(value,'$.messageCount'),1)>0) " +
      'SELECT session AS id,cwd,title,updatedAt FROM data WHERE ' + underSql('cwd',roots) +
      ' AND updatedAt BETWEEN ' + range.start + ' AND ' + range.end + ' ORDER BY updatedAt DESC,session LIMIT ' + RECENT_LIMIT,
      executable);
    result.push(...found);
  }
  const captions = await recentClaudeCaptions(roots,projects,dirs.captions,range,discoveredFiles);
  result.push(...captions);
  const verifiedIds = new Set(result.map(item => item.id));
  const captionDirs = [...dirs.captions];
  const pidSessions = await readClaudePidSessions(path.join(base, 'sessions'));
  const pidCandidates = pidSessions
    .filter(r => r.kind === 'interactive' && typeof r.cwd === 'string' && path.isAbsolute(r.cwd) &&
      roots.some(root => isUnderDir(path.resolve(r.cwd), root)) &&
      Number.isSafeInteger(r.updatedAt) && r.updatedAt >= range.start && r.updatedAt <= range.end)
    .sort((a, b) => (b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id))
    .slice(0, 64)
    .map(r => ({
      id: r.id,
      cwd: r.cwd,
      title: r.nameSource === 'derived' ? null : (r.name ?? null),
      status: r.status,
      nameSource: r.nameSource,
      updatedAt: r.updatedAt,
    }));
  // Ignore blank standby tabs spawned when opening an empty Claude composer (no transcript/user turn yet).
  for (const row of pidCandidates) {
    if (verifiedIds.has(row.id) || row.status === 'busy' || row.status === 'blocked') {
      result.push(row);
      continue;
    }
    if (UUID_RE.test(row.id)) {
      const slugs = new Set([typeof row.cwd === 'string' && path.isAbsolute(row.cwd) ? projectSlug(row.cwd) : '', ...captionDirs].filter(Boolean));
      let backed = false;
      for (const slug of slugs) {
        const file = path.join(projects, slug, row.id + '.jsonl');
        const cap = await claudeCaption(file, row.id);
        if (cap?.hasUser) {
          discoveredFiles?.add(file);
          backed = true;
          if (!row.title && cap.title) row.title = cap.title;
          break;
        }
      }
      if (backed) result.push(row);
    } else if (row.status !== 'idle' && row.nameSource !== 'derived' && titleText(row.title)) {
      result.push(row);
    }
  }
  return result;
}

async function recentFingerprint(roots, env, homeDir, rememberedFiles) {
  const codexBase = configDir('codex', homeDir, env);
  const claudeBase = configDir('claude', homeDir, env);
  const checks = [statStamp(codexBase)];

  const newestCodex = await latestCodexDb(codexBase);
  if (newestCodex) checks.push(dbStamp(newestCodex));

  for (const surface of AGY_SURFACES) {
    checks.push(dbStamp(path.join(homeDir, '.gemini', surface, 'conversation_summaries.db')));
  }

  checks.push(livePidDirSnapshot(path.join(claudeBase, 'sessions'), 64).then(s => s.fp));

  const projects = path.join(claudeBase, 'projects');
  checks.push(statStamp(projects));
  const projectNames = (await entries(projects)).filter(e => e.isDirectory()).map(e => e.name);
  const nameSet = new Set(projectNames);
  const exact = roots.map(projectSlug);
  const mainSlugs = (await Promise.all(roots.map(mainCheckout)))
    .filter(Boolean)
    .map(projectSlug)
    .filter(s => nameSet.has(s));
  const primary = [...new Set([...exact.filter(s => nameSet.has(s)), ...mainSlugs])];
  const primarySet = new Set(primary);
  const nested = projectNames
    .filter(name => !primarySet.has(name) && exact.some(prefix => name.startsWith(prefix + '-')))
    .sort();
  const slugs = [...primary, ...nested].slice(0, 32);
  let truncated = primary.length + nested.length > 32;
  let jsonlBudget = 128;
  const statFiles = new Set();
  for (const slug of slugs) {
    const full = path.join(projects, slug);
    checks.push(statStamp(full), statStamp(path.join(full, 'sessions-index.json')));
    if (jsonlBudget > 0) {
      const files = (await entries(full))
        .filter(e => e.isFile() && e.name.endsWith('.jsonl') && UUID_RE.test(e.name.slice(0, -6)))
        .map(e => e.name).sort();
      checks.push(Promise.resolve(String(files.length)));
      if (files.length > jsonlBudget) truncated = true;
      const slice = files.slice(0, jsonlBudget);
      jsonlBudget -= slice.length;
      for (const name of slice) {
        const file = path.join(full, name);
        if (!statFiles.has(file)) { statFiles.add(file); checks.push(statStamp(file)); }
      }
    } else {
      truncated = true;
    }
  }
  for (const file of rememberedFiles || []) {
    if (!statFiles.has(file)) { statFiles.add(file); checks.push(statStamp(file)); }
  }
  return { fp: (await Promise.all(checks)).join('|'), truncated };
}

function createRecentReader({ homeDir = os.homedir(), env = process.env, cacheMs = 30000,
  sqlitePath = defaultSqlitePath(env), now = Date.now } = {}) {
  let cache;
  let signature;
  let lastRead;
  let checkedRoots, cacheRoots, checkedAt = -Infinity;
  let rememberedFiles = [];
  const safetyTtl = cacheMs > 0 ? Math.max(cacheMs, 5 * 60000) : 0;
  const reuseMs = cacheMs > 0 ? Math.min(REUSE_MS, cacheMs) : 0;
  return async function readRecent(workspacePaths, { force = false } = {}) {
    if (force) { clearMainCheckoutCache(); rememberedFiles = []; }
    const roots = [...new Set((workspacePaths || []).filter(p => typeof p === 'string' && path.isAbsolute(p) &&
      !/[\x00-\x1f]/.test(p)).map(p => path.resolve(p)))].sort();
    if (!roots.length) return [];
    const current = now();
    const rootKey = roots.join('\0');
    if (!force && cache && rootKey === cacheRoots && rootKey === checkedRoots && current - checkedAt >= 0 && current - checkedAt < reuseMs) return cache;
    checkedRoots = rootKey;
    checkedAt = current;
    const { fp, truncated } = await recentFingerprint(roots, env, homeDir, rememberedFiles);
    let next = JSON.stringify([roots, fp]);
    const ttl = truncated ? cacheMs : safetyTtl;
    if (!force && cache && signature === next && current - lastRead < ttl) return cache;
    const range = { start: Math.floor(current - RECENT_DAYS_MS), end: Math.floor(current + 60000) };
    const sources = ['claude','codex','agy'];
    const discoveredFiles = new Set();
    const groups = await Promise.allSettled([
      recentClaude(roots,range,configDir('claude', homeDir, env),sqlitePath,discoveredFiles),
      recentCodex(roots,range,configDir('codex', homeDir, env),sqlitePath),
      recentAgy(roots,range,homeDir,sqlitePath),
    ]);
    const result = [];
    for (let i = 0; i < sources.length; i++) {
      const provider = sources[i];
      if (groups[i].status !== 'fulfilled') continue;
      const seen = new Set();
      const records = groups[i].value.sort((a,b) => b.updatedAt - a.updatedAt);
      for (const record of records) {
        if (!validId(record.id) || seen.has(record.id) || typeof record.cwd !== 'string' || !path.isAbsolute(record.cwd) ||
            !roots.some(root => isUnderDir(path.resolve(record.cwd),root)) || !Number.isSafeInteger(record.updatedAt) ||
            record.updatedAt < range.start || record.updatedAt > range.end) continue;
        seen.add(record.id);
        const title = titleText(record.title);
        result.push({ provider, sessionId:record.id, cwd:path.resolve(record.cwd), status:'recent',
          updatedAt:record.updatedAt, key:provider + '/' + record.id, ...(title && {title}) });
        if (seen.size === RECENT_LIMIT) break;
      }
    }
    const nextRemembered = [...discoveredFiles].sort().slice(0, 32);
    if (nextRemembered.join('\0') !== rememberedFiles.join('\0')) {
      rememberedFiles = nextRemembered;
      const refreshed = await recentFingerprint(roots, env, homeDir, rememberedFiles);
      next = JSON.stringify([roots, refreshed.fp]);
    }
    cache = result;
    cacheRoots = rootKey;
    signature = next;
    lastRead = current;
    return result;
  };
}

module.exports = { createMetadataReader, createRecentReader, query, querySessions, quote, nativeExecution, codexExecutionColumns, codexTitle, codexTitleSql, claudeChildResponse, mainCheckout, projectSlug, tableColumns, latestCodexDb, codexDbFiles, statStamp, dbStamp, clearMainCheckoutCache, defaultSqlitePath, invalidateTableColumns };
