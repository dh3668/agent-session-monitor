'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { query, quote, nativeExecution, codexExecutionColumns, codexTitle, codexTitleSql, claudeChildResponse, mainCheckout, projectSlug, tableColumns, codexDbFiles, latestCodexDb, statStamp, dbStamp, clearMainCheckoutCache } = require('./metadata.cjs');
const { cleanLabel, toSession } = require('./model.cjs');
const { DAY, AGY_SURFACES, providerConfigDir, createLru } = require('./shared.cjs');

const configDir = (provider, homeDir, env) => providerConfigDir(provider, { homeDir, env, fallbackRelative: true });
const validId = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(id);
const CLAUDE_RESPONSE_LIMIT = 48;
const AGY_ROLE_CACHE_MAX = 512;
const agyRoleCache = createLru(AGY_ROLE_CACHE_MAX);

const agyRoleKey = (db, id, updatedAt) => db + '\0' + id + '\0' + updatedAt;

// Anchor every traversal to session IDs already present on the monitor. Walking
// up first also identifies the parent when only a child's hook has fired.
function related(ids, edges) {
  return 'WITH RECURSIVE requested(id) AS (VALUES ' + ids.map(id => '(' + quote(id) + ')').join(',') + '), ' +
    'edges(id,parent) AS NOT MATERIALIZED (' + edges + '), ' +
    'ancestors(id) AS (SELECT id FROM requested UNION SELECT e.parent FROM edges e JOIN ancestors a ON e.id=a.id ' +
      "WHERE length(e.parent)>0 LIMIT 2048), " +
    'family(id) AS (SELECT id FROM ancestors UNION SELECT e.id FROM edges e JOIN family f ON e.parent=f.id LIMIT 2048) ';
}

async function claudeIndex(parents, opts) {
  if (!parents.length) return [];
  const base = configDir('claude', opts.homeDir, opts.env);
  const projects = path.join(base,'projects');
  let projectDirs;
  const loadFallbackDirs = async () => {
    if (!projectDirs) {
      projectDirs = (await fs.readdir(projects,{withFileTypes:true}).catch(() => [])).filter(e => e.isDirectory()).slice(0,100).map(e => e.name);
    }
    return projectDirs;
  };
  const records = [];
  for (const {id:root,cwd} of parents) {
    // Worktree conversations may live in the main checkout's project directory.
    // Check local slug and verified main checkout slug first before scanning other folders.
    const hasCwd = typeof cwd === 'string' && path.isAbsolute(cwd);
    const localSlug = hasCwd ? projectSlug(cwd) : '';
    const main = hasCwd ? await mainCheckout(cwd) : undefined;
    const mainSlug = main ? projectSlug(main) : '';
    const prioritized = [...new Set([localSlug, mainSlug].filter(Boolean))];
    let dir;
    for (const project of prioritized) {
      const candidate = path.join(projects,project,root,'subagents');
      if ((await fs.lstat(candidate).catch(() => undefined))?.isDirectory()) { dir = candidate; break; }
    }
    if (!dir && !main) {
      const checked = new Set(prioritized);
      for (const project of await loadFallbackDirs()) {
        if (checked.has(project)) continue;
        const candidate = path.join(projects,project,root,'subagents');
        if ((await fs.lstat(candidate).catch(() => undefined))?.isDirectory()) { dir = candidate; break; }
      }
    }
    if (!dir) continue;
    opts.onDiscovered?.(root, dir);
    const files = await fs.readdir(dir,{withFileTypes:true}).catch(() => []);
    const items = new Map();
    for (let i=0; i<files.length; i+=32) {
      await Promise.all(files.slice(i,i+32).map(async file => {
        const match = file.isFile() && /^agent-([A-Za-z0-9][A-Za-z0-9._-]{0,159})\.(meta\.json|jsonl)$/.exec(file.name);
        if (!match || match[1] === root || /^(?:acompact|aprompt_suggestion)(?:-|$)/i.test(match[1])) return;
        const location = path.join(dir,file.name);
        const stat = await fs.lstat(location).catch(() => undefined);
        if (!stat?.isFile()) return;
        const id = match[1];
        const item = items.get(id) || {provider:'claude',root,parent:root,id,cwd,status:'recent',updatedAt:0};
        item.updatedAt = Math.max(item.updatedAt,Math.floor(stat.mtimeMs));
        if (match[2] === 'meta.json' && stat.size <= 64*1024) item.meta = location;
        if (match[2] === 'jsonl') item.responseFile = location;
        items.set(id,item);
      }));
    }
    const recent = [...items.values()].filter(row => row.updatedAt >= opts.start && row.updatedAt <= opts.end)
      .sort((a,b) => b.updatedAt-a.updatedAt).slice(0,512);
    const withMeta = recent.filter(item => item.meta);
    for (let i=0; i<withMeta.length; i+=64) {
      const values = withMeta.slice(i,i+64).map(r => '(' + quote(r.id) + ',' + quote(r.meta) + ')').join(',');
      const metadata = await query(':memory:', 'WITH files(id,p) AS (VALUES ' + values +
        '), data AS MATERIALIZED (SELECT id,CAST(readfile(p) AS TEXT) AS j FROM files) ' +
        "SELECT id,substr(json_extract(j,'$.agentType'),1,100) AS role," +
        "substr(json_extract(j,'$.name'),1,100) AS nickname," +
        "substr(json_extract(j,'$.description'),1,100) AS task," +
        "json_extract(j,'$.parentAgentId') AS parentAgent," +
        "CASE WHEN json_type(j,'$.model')='text' THEN substr(json_extract(j,'$.model'),1,129) END AS model," +
        "CASE WHEN json_type(j,'$.effort')='text' THEN substr(json_extract(j,'$.effort'),1,32) END AS effort " +
        'FROM data WHERE json_valid(j)',opts.sqlitePath);
      for (const {id,role,nickname,task,parentAgent,model,effort} of metadata) {
        const item = items.get(id);
        if (!item) continue;
        item.role = role;
        if (nickname) item.nickname = nickname;
        if (task) item.task = task;
        item.execution = nativeExecution(model,effort,'setting');
        if (validId(parentAgent) && parentAgent !== id) item.parent = parentAgent;
      }
    }
    records.push(...recent);
  }
  // Only the most recent, exact child IDs need a response lookup. Keep the
  // total budget per scan bounded even across several large session families.
  const candidates = records.filter(item => item.responseFile).sort((a,b) => b.updatedAt-a.updatedAt).slice(0,CLAUDE_RESPONSE_LIMIT);
  for (let i=0; i<candidates.length; i+=8) {
    await Promise.all(candidates.slice(i,i+8).map(async item => {
      const observed = await claudeChildResponse(item.responseFile,item.root,item.id);
      if (observed) item.execution = {...item.execution,...observed};
    }));
  }
  return records;
}

function codexTaskName(agentPath) {
  if (typeof agentPath !== 'string') return '';
  const parts = agentPath.split('/').map(s => s.trim()).filter(Boolean);
  if (parts[0] === 'root') parts.shift();
  return cleanLabel(parts.slice(-2).join('/'));
}

// Bounds-checked pure-JS protobuf wire reader strictly extracting AGY subagent Role
// at wire path field 17 -> field 8 -> field 2 inside conversation_summaries.raw_summary.
function readVarint(buf, pos, end) {
  let value = 0, mult = 1, count = 0;
  while (pos < end && count < 8) {
    const b = buf[pos++];
    value += (b & 0x7f) * mult;
    if (!(b & 0x80)) return [value, pos];
    mult *= 128;
    count++;
  }
}

function readProtoField(buf, start, end, wantedField) {
  let pos = start;
  while (pos < end) {
    const tagRes = readVarint(buf, pos, end);
    if (!tagRes || tagRes[0] <= 0) return;
    const tag = tagRes[0];
    pos = tagRes[1];
    const field = Math.floor(tag / 8), wire = tag % 8;
    if (wire === 0) {
      let guard = 0, done = false;
      while (pos < end && guard < 10) {
        const b = buf[pos++];
        guard++;
        if (!(b & 0x80)) { done = true; break; }
      }
      if (!done) return;
    } else if (wire === 1) {
      pos += 8;
      if (pos > end) return;
    } else if (wire === 2) {
      const lenRes = readVarint(buf, pos, end);
      if (!lenRes) return;
      const len = lenRes[0];
      pos = lenRes[1];
      if (!Number.isSafeInteger(len) || len < 0 || pos + len > end) return;
      if (field === wantedField) return [pos, pos + len];
      pos += len;
    } else if (wire === 5) {
      pos += 4;
      if (pos > end) return;
    } else {
      return;
    }
  }
}

function agySubagentRole(hex) {
  if (typeof hex !== 'string' || !hex || hex.length % 2 !== 0 || hex.length > 262144 || !/^[0-9a-fA-F]+$/.test(hex)) return '';
  const buf = Buffer.from(hex, 'hex');
  const f17 = readProtoField(buf, 0, buf.length, 17);
  if (!f17) return '';
  const f8 = readProtoField(buf, f17[0], f17[1], 8);
  if (!f8) return '';
  const f2 = readProtoField(buf, f8[0], f8[1], 2);
  if (!f2) return '';
  return cleanLabel(buf.subarray(f2[0], f2[1]).toString('utf8'));
}

async function codexIndex(ids, opts) {
  if (!ids.length) return [];
  const base = configDir('codex', opts.homeDir, opts.env);
  const files = await codexDbFiles(base);
  for (const db of files) {
    const [threads, edges] = await Promise.all([
      tableColumns(db, 'threads', opts.sqlitePath),
      tableColumns(db, 'thread_spawn_edges', opts.sqlitePath),
    ]);
    if (!threads.has('id') || !threads.has('updated_at') || !edges.has('parent_thread_id') || !edges.has('child_thread_id')) continue;
    const time = threads.has('updated_at_ms') ? 'coalesce(t.updated_at_ms,t.updated_at*1000)' : 't.updated_at*1000';
    const parentCwd = threads.has('cwd') ? "p.cwd" : "''";
    const nickname = threads.has('agent_nickname') ? 'substr(t.agent_nickname,1,100)' : "''";
    const role = threads.has('agent_role') ? 'substr(t.agent_role,1,100)' : "''";
    const agentPath = threads.has('agent_path') ? 'substr(t.agent_path,1,200)' : "''";
    const title = threads.has('title') ? codexTitleSql(threads, 't.') : threads.has('name') ? 'substr(t.name,1,150)' : "''";
    const named = threads.has('name') ? "length(trim(coalesce(t.name,''))) > 0" : '0';
    const sql = related(ids, 'SELECT child_thread_id,parent_thread_id FROM thread_spawn_edges') +
      ' SELECT t.id,e.parent,t.cwd,' + time + ' AS updatedAt,' + parentCwd + ' AS parentCwd,' + nickname + ' AS nickname,' + role + ' AS role,' +
      agentPath + ' AS agentPath,' + title + ' AS title,' + named + ' AS named,' + codexExecutionColumns(threads,'t.') + ' ' +
      'FROM family f JOIN edges e ON e.id=f.id JOIN threads t ON t.id=f.id LEFT JOIN threads p ON p.id=e.parent WHERE ' + time +
      ' BETWEEN ' + opts.start + ' AND ' + opts.end + ' ORDER BY updatedAt DESC LIMIT 512';
    return (await query(db,sql,opts.sqlitePath)).map(item => ({...item,provider:'codex',status:'recent',
      task: codexTaskName(item.agentPath),
      fallbackTitle: codexTitle({ title: item.title, named: item.named }),
      execution:nativeExecution(item.model,item.effort,'setting')}));
  }
  return [];
}

// Some Antigravity children record multiple workspaces. Preserve all local
// candidates; an explicit remote-only list cannot inherit a local parent.
function workspaceUris(raw) {
  if (!raw) return;
  let value;
  try { value = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(value)) return [];
  if (!value.length) return;
  return [...new Set(value.flatMap(uri => {
    try { return typeof uri === 'string' ? [fileURLToPath(uri)] : []; } catch { return []; }
  }))];
}

async function agyIndex(ids, opts) {
  if (!ids.length) return [];
  const batches = await Promise.all(AGY_SURFACES.map(async surface => {
    const db = path.join(opts.homeDir,'.gemini',surface,'conversation_summaries.db');
    if (!(await fs.lstat(db).catch(() => undefined))?.isFile()) return [];
    const cols = await tableColumns(db,'conversation_summaries',opts.sqlitePath);
    if (!['conversation_id','parent_conversation_id','last_modified_time'].every(k => cols.has(k))) return [];
    const time = "CAST(strftime('%s',s.last_modified_time) AS INTEGER)*1000";
    const role = cols.has('agent_name') ? 'substr(s.agent_name,1,100)' : "''";
    const title = cols.has('title') ? 'substr(s.title,1,150)' : "''";
    const status = cols.has('status') ? 's.status' : "''";
    const killed = cols.has('killed') ? 's.killed' : '0';
    const workspace = cols.has('workspace_uris') ? 's.workspace_uris' : 'NULL';
    const parentWorkspace = cols.has('workspace_uris') ? 'p.workspace_uris' : 'NULL';
    const edges = 'SELECT conversation_id,parent_conversation_id FROM conversation_summaries WHERE length(parent_conversation_id)>0';
    // Step 1: lightweight metadata query without raw_summary so large families never exceed maxBuffer.
    const sql = related(ids,edges) + 'SELECT s.conversation_id AS id,s.parent_conversation_id AS parent,' +
      time + " AS updatedAt,CAST(strftime('%s',p.last_modified_time) AS INTEGER)*1000 AS parentUpdatedAt," +
      role + ' AS role,' + title + ' AS title,' +
      status + ' AS nativeStatus,' + killed + ' AS killed,' +
      workspace + ' AS uris,' + parentWorkspace + ' AS parentUris FROM family f JOIN conversation_summaries s ON s.conversation_id=f.id ' +
      'LEFT JOIN conversation_summaries p ON p.conversation_id=s.parent_conversation_id WHERE length(s.parent_conversation_id)>0 AND ' +
      '(' + status + "='CASCADE_RUN_STATUS_RUNNING' OR " + time + ' <= 0 OR ' +
      time + ' BETWEEN ' + opts.start + ' AND ' + opts.end + ") ORDER BY (nativeStatus='CASCADE_RUN_STATUS_RUNNING') DESC, updatedAt DESC LIMIT 512";
    const rows = await query(db,sql,opts.sqlitePath);
    const roleMap = new Map();
    // Step 2: enrich subagent Role from raw_summary in bounded batches only where needed, reusing cached roles.
    if (cols.has('raw_summary') && rows.length) {
      const genericRole = value => ['', 'self', 'default', 'general-purpose'].includes(cleanLabel(value).toLowerCase());
      const candidates = rows.filter(item => (!cleanLabel(item.title) || genericRole(item.role)) && validId(item.id))
        .slice(0, 64);
      const rowById = new Map(candidates.map(item => [item.id, item]));
      const needRole = [];
      for (const item of candidates) {
        const cached = agyRoleCache.get(agyRoleKey(db, item.id, item.updatedAt));
        if (cached !== undefined) {
          if (cached) roleMap.set(item.id, cached);
        } else {
          needRole.push(item.id);
        }
      }
      if (needRole.length) {
        const blobQuery = list => "SELECT conversation_id AS id," +
          "CASE WHEN typeof(raw_summary)='blob' AND length(raw_summary)<=131072 THEN hex(raw_summary) END AS rawSummary " +
          'FROM conversation_summaries WHERE conversation_id IN (' + list + ')';
        for (let i = 0; i < needRole.length; i += 8) {
          const chunk = needRole.slice(i, i + 8);
          let blobs = await query(db, blobQuery(chunk.map(quote).join(',')), opts.sqlitePath);
          if (!blobs.length && chunk.length > 1) {
            blobs = [];
            for (const single of chunk) {
              const one = await query(db, blobQuery(quote(single)), opts.sqlitePath);
              blobs.push(...one);
            }
          }
          for (const entry of blobs) {
            const parsed = agySubagentRole(entry.rawSummary);
            const item = rowById.get(entry.id);
            if (parsed) {
              roleMap.set(entry.id, parsed);
              if (item) agyRoleCache.set(agyRoleKey(db, entry.id, item.updatedAt), parsed);
            } else if (item && (item.killed || item.nativeStatus === 'CASCADE_RUN_STATUS_IDLE')) {
              agyRoleCache.set(agyRoleKey(db, entry.id, item.updatedAt), '');
            }
          }
        }
      }
    }
    return rows.map(item => {
      const workspaces = workspaceUris(item.uris);
      const parentPaths = workspaceUris(item.parentUris);
      const resolvedRole = roleMap.get(item.id) || cleanLabel(item.title) || cleanLabel(item.role);
      const updatedAt = Number.isSafeInteger(item.updatedAt) && item.updatedAt > 0 ? item.updatedAt :
        Math.max(opts.start, Math.min(opts.end, item.parentUpdatedAt > 0 ? item.parentUpdatedAt : opts.now || Date.now()));
      return {...item,updatedAt,role:resolvedRole,provider:'agy',cwd:workspaces?.[0],workspacePaths:workspaces,parentPaths,
        status:item.killed || item.nativeStatus === 'CASCADE_RUN_STATUS_IDLE' ? 'idle' :
          item.nativeStatus === 'CASCADE_RUN_STATUS_RUNNING' ? 'working' : 'recent'};
    });
  }));
  return batches.flat().sort((a,b) => a.updatedAt-b.updatedAt);
}

function subagentLabel(m) {
  const task = cleanLabel(m.task);
  const nickname = cleanLabel(m.nickname);
  const role = cleanLabel(m.role);
  if (task) {
    if (m.provider === 'codex') {
      const meaningfulRole = role && role.toLowerCase() !== 'default' ? role : '';
      return [...new Set([task, meaningfulRole, nickname].filter(Boolean))].join(' · ');
    }
    const prefix = nickname || (role && role.toLowerCase() !== 'general-purpose' ? role : '');
    return prefix && prefix.toLowerCase() !== task.toLowerCase() ? (prefix + ' · ' + task).slice(0, 100) : task;
  }
  const meaningfulRole = m.provider === 'codex' && role.toLowerCase() === 'default' ? '' : role;
  const primary = [...new Set([nickname, meaningfulRole].filter(Boolean))].join(' · ');
  if (primary) return primary;
  return m.provider === 'codex' ? cleanLabel(m.fallbackTitle) : '';
}

function merge(rows, indexed, now) {
  const result = new Map(rows.map(row => [row.key,row]));
  const parentLocations = new Map();
  for (const m of indexed) {
    if (!validId(m.id) || !validId(m.parent) || m.id === m.parent) continue;
    const label = subagentLabel(m);
    const native = toSession({provider:m.provider,sessionId:m.id,parentSessionId:m.root || m.parent,
      cwd:m.cwd,updatedAt:m.updatedAt,status:m.status,agentType:label},now);
    if (!native) continue;
    if (m.root && m.parent !== m.root) native.parentKey = 'claude/' + m.root + '/' + m.parent;
    if (m.parentPaths || m.parentCwd) parentLocations.set(native.parentKey,m.parentPaths || [m.parentCwd]);
    const previous = result.get(native.key);
    // A hook gives an actual lifecycle/approval state even if the local index
    // is newer. Codex's open spawn edge alone only means the thread exists.
    // An explicitly killed Antigravity child must stay idle even if its hook stuck on working.
    const observed = previous && previous.status !== 'recent' && !previous.indexedChild;
    const keepObservedStatus = observed && !(m.provider === 'agy' && m.killed && ['working','approval','input'].includes(previous.status));
    const hookCwd = previous?.workspaceInherited ? '' : previous?.cwd;
    const workspacePaths = m.workspacePaths ?? previous?.workspacePaths;
    for (const field of ['completedAt','execution']) {
      if (previous?.[field] !== undefined) native[field] = previous[field];
    }
    if (keepObservedStatus) {
      for (const field of ['waitSince','pendingRefs','pendingEntries','pendingSoftEntries','softPendingRefs','nextSoftWaitAt',
        'workSince','liveTurnConfirmed','errorReason','interrupted','activityAt']) {
        if (previous[field] !== undefined) native[field] = previous[field];
      }
    }
    if (previous?.replyAt !== undefined) {
      if (native.isSubagent) native.completedAt = native.completedAt || previous.replyAt;
      else native.replyAt = previous.replyAt;
    }
    result.set(native.key, {...native, ...(keepObservedStatus && {status:previous.status,updatedAt:previous.updatedAt}),
      ...(m.execution && {nativeExecution:m.execution}),
      cwd:hookCwd || native.cwd || previous?.cwd || '', title:label ? native.title : previous?.title || native.title,
      ...(workspacePaths && {workspacePaths}),
      ...(!hookCwd && (m.provider === 'claude' || !native.cwd) && {workspaceInherited:true}),
      indexedChild:!keepObservedStatus});
  }
  for (const child of result.values()) {
    if (!child.isSubagent || !child.parentKey || result.has(child.parentKey)) continue;
    const [,rootId,agentId] = child.parentKey.split('/');
    const parentId = agentId || rootId;
    if (!validId(parentId)) continue;
    const known = parentLocations.get(child.parentKey);
    const concreteCwd = !known && Boolean(child.cwd) && !child.workspaceInherited;
    result.set(child.parentKey,{provider:child.provider,sessionId:parentId,cwd:known?.[0] || child.cwd,status:'recent',
      ...(known ? {workspacePaths:known} : concreteCwd ? {} : {workspaceInherited:true}),
      updatedAt:child.updatedAt,key:child.parentKey,...(agentId && {isSubagent:true,canOpen:false,
        title:'서브에이전트 · ' + agentId.slice(-6),parentKey:'claude/' + rootId})});
  }
  // AGY's child index need not repeat the workspace. Children of children can
  // still open in the correct workspace without inspecting a conversation.
  for (const child of result.values()) {
    if (!child.isSubagent || child.cwd) continue;
    let parent = result.get(child.parentKey);
    const visited = new Set([child.key]);
    while (parent && !parent.cwd && !visited.has(parent.key)) {
      visited.add(parent.key);
      parent = result.get(parent.parentKey);
    }
    if (parent?.cwd) result.set(child.key,{...child,cwd:parent.cwd});
  }
  return [...result.values()];
}

async function dbChildrenFingerprint(codex, agy, env, homeDir) {
  if (!codex.length && !agy.length) return '';
  const checks = [];
  if (codex.length) {
    const base = configDir('codex', homeDir, env);
    checks.push(statStamp(base));
    const newest = await latestCodexDb(base);
    if (newest) checks.push(dbStamp(newest));
  }
  if (agy.length) {
    for (const surface of AGY_SURFACES) {
      checks.push(dbStamp(path.join(homeDir, '.gemini', surface, 'conversation_summaries.db')));
    }
  }
  return (await Promise.all(checks)).join('|');
}

async function claudeChildrenFingerprint(claude, discoveredDirs, env, homeDir) {
  if (!claude.length) return { fp: '', truncated: false };
  const base = configDir('claude', homeDir, env);
  const projects = path.join(base, 'projects');
  const checks = [statStamp(projects)];
  const seenDirs = new Set();
  let fileBudget = 128;
  let truncated = claude.length > 32;
  for (const { id, cwd } of claude.slice(0, 32)) {
    const dirs = [];
    const discovered = discoveredDirs.get(id);
    if (discovered) dirs.push(discovered);
    if (typeof cwd === 'string' && path.isAbsolute(cwd)) {
      const localSlug = projectSlug(cwd);
      const main = await mainCheckout(cwd);
      const mainSlug = main ? projectSlug(main) : '';
      for (const slug of new Set([localSlug, mainSlug].filter(Boolean))) {
        dirs.push(path.join(projects, slug, id, 'subagents'));
      }
    }
    for (const dir of dirs) {
      if (seenDirs.has(dir)) continue;
      seenDirs.add(dir);
      const dirStamp = await statStamp(dir);
      checks.push(Promise.resolve(dirStamp));
      if (dirStamp) {
        if (fileBudget > 0) {
          const files = (await fs.readdir(dir, { withFileTypes: true }).catch(() => []))
            .filter(f => f.isFile() && /^agent-[A-Za-z0-9][A-Za-z0-9._-]{0,159}\.(?:meta\.json|jsonl)$/.test(f.name))
            .map(f => f.name).sort();
          checks.push(Promise.resolve(String(files.length)));
          if (files.length > fileBudget) truncated = true;
          const slice = files.slice(0, fileBudget);
          fileBudget -= slice.length;
          for (const name of slice) checks.push(statStamp(path.join(dir, name)));
        } else {
          truncated = true;
        }
      }
    }
  }
  return { fp: (await Promise.all(checks)).join('|'), truncated };
}

function createChildReader({homeDir=os.homedir(), env=process.env, sqlitePath='/usr/bin/sqlite3',
  cacheMs=10000, claudeCacheMs=90000, now=Date.now}={}) {
  let cache, claudeCache;
  const discoveredDirs = createLru(64);
  const dbSafetyTtl = cacheMs > 0 ? Math.max(cacheMs, 5 * 60000) : 0;
  const claudeSafetyTtl = claudeCacheMs > 0 ? Math.max(claudeCacheMs, 5 * 60000) : 0;
  return async function readChildren(rows,{force=false}={}) {
    if (force) { clearMainCheckoutCache(); discoveredDirs.clear(); }
    const ids = provider => [...new Set(rows.filter(r => r.provider === provider && validId(r.sessionId)).map(r => r.sessionId))].sort();
    const codex = ids('codex'), agy = ids('agy');
    const parents = new Map();
    for (const row of rows) {
      if (row.provider !== 'claude') continue;
      const id = row.isSubagent ? row.parentKey?.split('/')[1] : row.sessionId;
      if (validId(id) && !parents.get(id)) parents.set(id,typeof row.cwd === 'string' ? row.cwd : '');
    }
    const claude = [...parents].sort(([a],[b]) => a.localeCompare(b)).map(([id,cwd]) => ({id,cwd}));
    const signature = JSON.stringify([codex,agy]);
    const claudeSignature = JSON.stringify(claude);
    const timestamp = now();
    const generic = rec => !cleanLabel(rec?.task) && ['', 'self', 'default', 'general-purpose'].includes(cleanLabel(rec?.role).toLowerCase());
    const cachedClaudeMap = new Map((claudeCache?.records || []).map(r => [(r.root || r.parent) + '/' + r.id, r]));
    const missingClaudeChild = rows.some(r => {
      if (r.provider !== 'claude' || !r.isSubagent) return false;
      const cached = cachedClaudeMap.get(r.parentKey?.split('/')[1] + '/' + r.sessionId);
      return !cached || (['working', 'input', 'approval'].includes(r.status) && (generic(cached) || !cached.execution?.model));
    });
    const cachedDbMap = new Map((cache?.records || []).map(r => [r.provider + '/' + r.id, r]));
    const missingDbChild = rows.some(r => (r.provider === 'codex' || r.provider === 'agy') && r.isSubagent &&
      (!cachedDbMap.has(r.provider + '/' + r.sessionId) || (['working', 'input', 'approval'].includes(r.status) && generic(cachedDbMap.get(r.provider + '/' + r.sessionId)))));
    const shortReuseDb = !force && cacheMs > 0 && Boolean(cache) && cache.signature === signature &&
      timestamp - cache.timestamp < cacheMs && (!missingDbChild || timestamp - cache.timestamp < 2000);
    const shortReuseClaude = !force && claudeCacheMs > 0 && Boolean(claudeCache) && claudeCache.signature === claudeSignature &&
      timestamp - claudeCache.timestamp < claudeCacheMs && (!missingClaudeChild || timestamp - claudeCache.timestamp < 2000);
    const [dbFp, claudeFpRes] = await Promise.all([
      shortReuseDb ? undefined : dbChildrenFingerprint(codex, agy, env, homeDir),
      shortReuseClaude ? undefined : claudeChildrenFingerprint(claude, discoveredDirs, env, homeDir),
    ]);
    const reuseDb = shortReuseDb || (!force && Boolean(cache) && cache.signature === signature &&
      timestamp - cache.timestamp < dbSafetyTtl && cache.fp === dbFp);
    const claudeTtl = claudeFpRes?.truncated ? (missingClaudeChild ? 2000 : claudeCacheMs) : claudeSafetyTtl;
    const reuseClaude = shortReuseClaude || (!force && Boolean(claudeCache) && claudeCache.signature === claudeSignature &&
      timestamp - claudeCache.timestamp < claudeTtl && claudeCache.fp === claudeFpRes.fp);
    let discoveredChanged = false;
    const onDiscovered = (root, dir) => {
      if (discoveredDirs.get(root) !== dir) {
        discoveredDirs.set(root, dir);
        discoveredChanged = true;
      }
    };
    const opts = {homeDir,env,sqlitePath,now:timestamp,start:Math.floor(timestamp-7*DAY),end:Math.floor(timestamp+60000),onDiscovered};
    const [dbRecords,claudeRecords] = await Promise.all([
      reuseDb ? cache.records : Promise.allSettled([codexIndex(codex,opts),agyIndex(agy,opts)])
        .then(batches => batches.flatMap(batch => batch.status === 'fulfilled' ? batch.value : [])),
      reuseClaude ? claudeCache.records : claudeIndex(claude,opts).catch(() => []),
    ]);
    if (!reuseDb) cache = {signature,fp:dbFp,timestamp,records:dbRecords};
    if (!reuseClaude) {
      const nextClaudeFp = discoveredChanged
        ? (await claudeChildrenFingerprint(claude, discoveredDirs, env, homeDir)).fp
        : claudeFpRes.fp;
      claudeCache = {signature:claudeSignature,fp:nextClaudeFp,timestamp,records:claudeRecords};
    }
    return merge(rows,[...dbRecords,...claudeRecords],timestamp);
  };
}

module.exports = {createChildReader};
