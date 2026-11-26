'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { localWorkspacePaths, validModel, validEffort, sameApprovalWindow, ERROR_REASONS } = require('./hook.cjs');
const { DAY, isObject, stripControlBidi } = require('./shared.cjs');

const PROVIDERS = Object.freeze({ claude: 'Claude Code', codex: 'Codex', agy: 'Antigravity' });
const STATES = Object.freeze({
  approval: { label: '승인 대기', icon: 'shield', group: 'attention' },
  input: { label: '답변 대기', icon: 'question', group: 'attention' },
  error: { label: '오류', icon: 'error', group: 'attention' },
  working: { label: '작업 중', icon: 'sync', group: 'working' },
  done: { label: '응답 완료', icon: 'pass', group: 'finished' },
  idle: { label: '멈춤', icon: 'circle-outline', group: 'recent' },
  recent: { label: '최근 대화', icon: 'history', group: 'recent' },
  stale: { label: '최근 신호 없음', icon: 'history', group: 'recent' },
});
const SUBAGENT_STALE_MS = 2 * 3600000;
const SNAPSHOT_FILE_RE = /^[a-f0-9]{64}\.json$/;
const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,160}$/;
const UNCOMPUTED = Symbol('uncomputed');

function cleanLabel(value) {
  return stripControlBidi(value, { max: 100 });
}

function isUnstartedSnapshot(data) {
  if (!data || data.status !== 'idle' || data.parentSessionId) return false;
  if (data.unstarted === true) return true;
  // Pre-fix Claude/Codex SessionStart/SessionEnd snapshots on disk have idle status with zero turns or activity.
  return (data.provider === 'claude' || data.provider === 'codex') &&
    !data.turn && !data.workSince && !data.replyAt && !data.completedAt && !data.interrupted;
}

function toSession(data, now = Date.now()) {
  if (!data || !Object.hasOwn(PROVIDERS, data.provider) || !Object.hasOwn(STATES, data.status)) return;
  if (typeof data.sessionId !== 'string' || !SESSION_ID_RE.test(data.sessionId)) return;
  if (!Number.isSafeInteger(data.updatedAt) || data.updatedAt <= 0 || data.updatedAt > now + 60000) return;
  const age = now - data.updatedAt;
  if (age > 7 * DAY) return;
  const cwd = typeof data.cwd === 'string' && path.isAbsolute(data.cwd) ? data.cwd : '';
  const workspacePaths = data.provider === 'agy' ? localWorkspacePaths(data.workspacePaths) : undefined;
  const parentId = typeof data.parentSessionId === 'string' && SESSION_ID_RE.test(data.parentSessionId) &&
    data.parentSessionId !== data.sessionId ? data.parentSessionId : undefined;
  const staleWorking = data.status === 'working' && (age > DAY || (Boolean(parentId) && age > SUBAGENT_STALE_MS));
  let status = (staleWorking || (age > DAY && ['approval', 'input'].includes(data.status))) ? 'stale' : data.status;
  const parentKey = parentId && data.provider + '/' + parentId;
  const key = data.provider === 'claude' && parentKey ? parentKey + '/' + data.sessionId : data.provider + '/' + data.sessionId;
  const validTime = value => Number.isSafeInteger(value) && value > 0 && value <= now + 60000;
  const hardStatus = ['input', 'approval'].includes(status) ? status : undefined;
  const hardWaitSince = hardStatus ? (validTime(data.waitSince) ? data.waitSince : data.updatedAt) : undefined;
  const pendingEntries = [];
  if (hardStatus && isObject(data.pending)) {
    const targets = isObject(data.pendingTargets) ? data.pendingTargets : undefined;
    for (const [ref, kind] of Object.entries(data.pending)) {
      if (!/^[a-z0-9]{1,64}$/.test(ref) || (kind !== 'approval' && kind !== 'input')) continue;
      const since = validTime(data.pendingAt?.[ref]) ? data.pendingAt[ref] : hardWaitSince;
      const target = typeof targets?.[ref] === 'string' && /^(?:fc|cmd):[a-f0-9]{64}$/.test(targets[ref]) ? targets[ref] : undefined;
      const call = data.pendingCalls?.[ref];
      const argsRef = typeof call?.argsRef === 'string' && /^[a-f0-9]{64}$/.test(call.argsRef) ? call.argsRef : undefined;
      pendingEntries.push({ ref, status: kind, since, ...(target && { target }), ...(argsRef && { argsRef }),
        ...(argsRef && call.identified === true && { identified: true }),
        ...(argsRef && call.sharedTarget === true && { sharedTarget: true }),
        ...(argsRef && validTime(call.removedPeerSince) && call.removedPeerSince >= since && { removedPeerSince: call.removedPeerSince }) });
    }
  }
  // Keep reading every occurrence in the size-bounded snapshot for native
  // reconciliation. Only the webview's preview list has a 32-reference limit.
  const hardPendingRefs = hardStatus ? pendingEntries.filter(entry => entry.status === hardStatus).slice(0, 32).map(entry => entry.ref) : [];
  // Delayed soft waits (e.g. Antigravity run_command/external-file dialogs where no
  // PermissionRequest hook exists) promote automatically once `now >= entry.after`.
  const pendingSoftEntries = [];
  const maturedSoft = [];
  const softPendingRefs = [];
  let nextSoftWaitAt = Infinity;
  if (['working', 'approval', 'input'].includes(status) && isObject(data.pendingSoft)) {
    for (const [ref, entry] of Object.entries(data.pendingSoft)) {
      if (!/^[a-z0-9]{1,64}$/.test(ref) || !isObject(entry)) continue;
      if (entry.status !== 'approval' && entry.status !== 'input') continue;
      if (!validTime(entry.since) || now - entry.since > DAY) continue;
      if (!Number.isSafeInteger(entry.after) || entry.after < entry.since || entry.after > entry.since + 60000) continue;
      const stepIdx = Number.isSafeInteger(entry.stepIdx) && entry.stepIdx >= 0 ? entry.stepIdx : undefined;
      if (pendingSoftEntries.length < 32) {
        pendingSoftEntries.push({ ref, status: entry.status, since: entry.since, after: entry.after, ...(stepIdx !== undefined && { stepIdx }) });
      }
      if (now >= entry.after) {
        maturedSoft.push({ ref, status: entry.status, since: entry.since });
      } else {
        if (softPendingRefs.length < 32) softPendingRefs.push(ref);
        if (entry.after < nextSoftWaitAt) nextSoftWaitAt = entry.after;
      }
    }
  }
  if (maturedSoft.length) {
    if (status === 'input' || maturedSoft.some(item => item.status === 'input')) status = 'input';
    else if (status === 'approval' || maturedSoft.some(item => item.status === 'approval')) status = 'approval';
  }
  const waitTimes = [];
  if (hardStatus && hardStatus === status) waitTimes.push(hardWaitSince);
  for (const item of maturedSoft) if (item.status === status) waitTimes.push(item.since);
  const waitSince = waitTimes.length ? Math.min(...waitTimes) : undefined;
  // Correlation digests of the outstanding requests of the displayed kind. A
  // display-only preview is shown only while its own request is still open.
  const refSet = new Set(hardStatus === status ? hardPendingRefs : []);
  for (const item of maturedSoft) if (item.status === status && refSet.size < 32) refSet.add(item.ref);
  const pendingRefs = [...refSet];
  const execution = {};
  for (const [field, validate] of [['model', validModel], ['effort', validEffort]]) {
    const source = data.execution?.[field + 'Source'];
    const at = data.execution?.[field + 'At'];
    if (validate(data.execution?.[field]) && ['setting', 'call', 'request', 'response'].includes(source) && validTime(at)) {
      Object.assign(execution, {[field]: data.execution[field], [field + 'Source']: source, [field + 'At']: at});
    }
  }
  const errorReason = status === 'error' && typeof data.errorReason === 'string' && ERROR_REASONS.has(data.errorReason)
    ? data.errorReason : undefined;
  const rawAgentLabel = cleanLabel(data.agentType);
  const agentTitle = data.provider === 'codex' && rawAgentLabel.toLowerCase() === 'default' ? '' : rawAgentLabel;
  return {
    provider: data.provider, sessionId: data.sessionId, cwd, status, updatedAt: data.updatedAt,
    ...(isUnstartedSnapshot(data) && { unstarted: true }),
    ...(data.interrupted && { interrupted: true }),
    ...(typeof data.turn === 'string' && SESSION_ID_RE.test(data.turn) && { turn: data.turn }),
    ...(waitSince && {waitSince}), ...(pendingRefs.length && {pendingRefs}),
    ...(pendingEntries.length && {pendingEntries}),
    ...(pendingSoftEntries.length && {pendingSoftEntries}),
    ...(softPendingRefs.length && {softPendingRefs}),
    ...(Number.isFinite(nextSoftWaitAt) && {nextSoftWaitAt}),
    ...(validTime(data.workSince) && {workSince: data.workSince}),
    ...(!parentKey && validTime(data.replyAt) && {replyAt: data.replyAt}),
    ...(parentKey && validTime(data.completedAt) && {completedAt: data.completedAt}),
    ...(errorReason && {errorReason}),
    ...(Object.keys(execution).length && {execution}),
    key, ...(workspacePaths && {workspacePaths}), ...(parentKey && { isSubagent: true, parentKey, canOpen: data.provider !== 'claude',
      title: agentTitle || '서브에이전트 · ' + data.sessionId.slice(-6) }),
  };
}

function nextStalenessBoundary(data, now) {
  if (!data || !Number.isSafeInteger(data.updatedAt) || data.updatedAt <= 0) return Infinity;
  const futureLimit = now + 60000;
  for (const ts of [data.updatedAt, data.waitSince, data.workSince, data.replyAt, data.completedAt,
    data.execution?.modelAt, data.execution?.effortAt]) {
    if (Number.isSafeInteger(ts) && ts > futureLimit) return -Infinity;
  }
  const expiry = data.updatedAt + 7 * DAY;
  if (now > expiry) return Infinity;
  let limit = expiry;
  const hasParent = typeof data.parentSessionId === 'string' && SESSION_ID_RE.test(data.parentSessionId) &&
    data.parentSessionId !== data.sessionId;
  if (data.status === 'working' && hasParent) {
    const subStale = data.updatedAt + SUBAGENT_STALE_MS;
    if (now <= subStale) limit = Math.min(limit, subStale);
  }
  if (['working', 'approval', 'input'].includes(data.status)) {
    const dayStale = data.updatedAt + DAY;
    if (now <= dayStale) limit = Math.min(limit, dayStale);
    if (isObject(data.pendingSoft)) {
      for (const entry of Object.values(data.pendingSoft)) {
        if (!isObject(entry)) continue;
        if (Number.isSafeInteger(entry.since) && entry.since > futureLimit) return -Infinity;
        if (Number.isSafeInteger(entry.after) && Number.isSafeInteger(entry.since) &&
            entry.after >= entry.since && entry.after <= entry.since + 60000 && now < entry.after) {
          limit = Math.min(limit, entry.after - 1);
        }
      }
    }
  }
  return limit;
}

async function readSessionBatch(directory, now, readOne) {
  const files = await fs.readdir(directory, { withFileTypes: true });
  const records = [];
  const candidates = files.filter(file => file.isFile() && SNAPSHOT_FILE_RE.test(file.name));
  for (let start = 0; start < candidates.length; start += 32) {
    const batch = candidates.slice(start, start + 32);
    const rows = await Promise.all(batch.map(file => readOne(path.join(directory, file.name), now)));
    records.push(...rows.filter(Boolean));
  }
  return records;
}

async function readSessions(directory, now = Date.now()) {
  return readSessionBatch(directory, now, async (fullPath, ts) => {
    try {
      const stat = await fs.stat(fullPath);
      if (stat.size > 64 * 1024 || ts - stat.mtimeMs > 7 * DAY) return;
      const parsed = toSession(JSON.parse(await fs.readFile(fullPath, 'utf8')), ts);
      return parsed && !parsed.unstarted ? parsed : undefined;
    } catch {
      // A hook may replace a snapshot during a scan. The next scan picks it up.
      return;
    }
  });
}

// Cache raw parsed JSON and derived session per snapshot file keyed by mtimeNs:ctimeNs:size:ino
// so unchanged snapshots skip disk reads and re-parsing until the next staleness boundary.
function createSessionReader() {
  const cache = new Map();
  return async function readSessionsCached(directory, now = Date.now()) {
    const seen = new Set();
    const records = await readSessionBatch(directory, now, async (fullPath, ts) => {
      seen.add(fullPath);
      try {
        const stat = await fs.stat(fullPath, { bigint: true });
        const mtimeMs = Number(stat.mtimeNs / 1000000n);
        if (stat.size > 64n * 1024n || ts - mtimeMs > 7 * DAY) {
          cache.delete(fullPath);
          return;
        }
        const stamp = stat.mtimeNs + ':' + stat.ctimeNs + ':' + stat.size + ':' + stat.ino;
        let entry = cache.get(fullPath);
        if (!entry || entry.stamp !== stamp) {
          let data;
          try {
            data = JSON.parse(await fs.readFile(fullPath, 'utf8'));
          } catch (error) {
            if (!(error instanceof SyntaxError)) {
              cache.delete(fullPath);
              return;
            }
            data = undefined;
          }
          entry = { stamp, data, session: UNCOMPUTED, cachedAt: 0, validUntil: -Infinity };
          cache.set(fullPath, entry);
        }
        if (!entry.data) return;
        if (entry.session !== UNCOMPUTED && ts >= entry.cachedAt && ts <= entry.validUntil) {
          return entry.session;
        }
        const parsed = toSession(entry.data, ts);
        entry.session = parsed && !parsed.unstarted ? parsed : undefined;
        entry.cachedAt = ts;
        entry.validUntil = nextStalenessBoundary(entry.data, ts);
        return entry.session;
      } catch {
        cache.delete(fullPath);
        return;
      }
    });
    for (const key of cache.keys()) if (!seen.has(key)) cache.delete(key);
    return records;
  };
}

async function pruneExpiredSessions(directory, now = Date.now()) {
  const files = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const candidates = files.filter(file => file.isFile() && SNAPSHOT_FILE_RE.test(file.name));
  let removed = 0;
  for (let start = 0; start < candidates.length; start += 32) {
    const batch = candidates.slice(start, start + 32);
    await Promise.all(batch.map(async file => {
      const fullPath = path.join(directory, file.name);
      const stat = await fs.lstat(fullPath).catch(() => undefined);
      if (!stat?.isFile() || now - stat.mtimeMs <= 7 * DAY) return;
      try {
        await fs.unlink(fullPath);
        removed++;
      } catch { /* Another window may have already pruned it. */ }
    }));
  }
  return removed;
}

function sessionLabel(row, alias) {
  const cleaned = cleanLabel(alias);
  if (cleaned) return cleaned;
  const project = cleanLabel(path.basename(row.cwd));
  // Newer UUIDv7 thread IDs share a time prefix; use the trailing digits.
  return [project || '이름 없는 세션', row.sessionId.slice(-6)].join(' · ');
}

function resolveSessionWaits(row, { resolvedRefs, resolvedSoftRefs, runningSoftRefs, haltedOnReject = false, resolvedAt = 0 } = {}, now = Date.now()) {
  if (!row || !['working', 'approval', 'input'].includes(row.status)) return row;
  const origHard = Array.isArray(row.pendingEntries) ? row.pendingEntries : [];
  const origSoft = Array.isArray(row.pendingSoftEntries) ? row.pendingSoftEntries : [];
  const hard = resolvedRefs?.size ? origHard.filter(entry => !resolvedRefs.has(entry.ref)) : origHard;
  const soft = resolvedSoftRefs?.size ? origSoft.filter(entry => !resolvedSoftRefs.has(entry.ref)) : origSoft;
  if (hard.length === origHard.length && soft.length === origSoft.length &&
      !(runningSoftRefs?.size && soft.some(entry => runningSoftRefs.has(entry.ref)))) return row;

  const maturedSoft = [];
  const softPendingRefs = [];
  let nextSoftWaitAt = Infinity;
  for (const entry of soft) {
    if (now >= entry.after && !runningSoftRefs?.has(entry.ref)) maturedSoft.push(entry);
    else {
      if (softPendingRefs.length < 32) softPendingRefs.push(entry.ref);
      if (entry.after > now && entry.after < nextSoftWaitAt) nextSoftWaitAt = entry.after;
    }
  }

  let status;
  if (hard.some(e => e.status === 'input') || maturedSoft.some(e => e.status === 'input')) status = 'input';
  else if (hard.some(e => e.status === 'approval') || maturedSoft.some(e => e.status === 'approval')) status = 'approval';
  else if (haltedOnReject && !soft.length && !hard.length) status = 'idle';
  else status = 'working';

  const waitTimes = [];
  const pendingRefs = [];
  if (status === 'input' || status === 'approval') {
    for (const entry of [...hard, ...maturedSoft]) {
      if (entry.status !== status) continue;
      if (Number.isSafeInteger(entry.since) && entry.since > 0) waitTimes.push(entry.since);
      if (pendingRefs.length < 32 && !pendingRefs.includes(entry.ref)) pendingRefs.push(entry.ref);
    }
  }
  const waitSince = waitTimes.length ? Math.min(...waitTimes) : undefined;
  const {
    waitSince: _ws, pendingRefs: _pr, pendingEntries: _pe,
    pendingSoftEntries: _pse, softPendingRefs: _spr, nextSoftWaitAt: _nsw,
    ...rest
  } = row;
  const updatedAt = Number.isSafeInteger(resolvedAt) && resolvedAt > row.updatedAt ? resolvedAt : row.updatedAt;
  return {
    ...rest,
    status,
    updatedAt,
    ...(waitSince && { waitSince }),
    ...(pendingRefs.length && { pendingRefs }),
    ...(hard.length && { pendingEntries: hard }),
    ...(soft.length && { pendingSoftEntries: soft }),
    ...(softPendingRefs.length && { softPendingRefs }),
    ...(Number.isFinite(nextSoftWaitAt) && { nextSoftWaitAt }),
  };
}

function isGenericOnlyApproval(row) {
  if (!row || row.provider !== 'claude' || row.status !== 'approval') return false;
  if (row.pendingSoftEntries?.length) return false;
  if (Array.isArray(row.pendingEntries) && row.pendingEntries.length) {
    return row.pendingEntries.every(entry => entry.ref === 'generic' && entry.status === 'approval');
  }
  return Array.isArray(row.pendingRefs) && row.pendingRefs.length === 1 && row.pendingRefs[0] === 'generic';
}

function deduplicateGenericParentApprovals(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return rows;
  const byKey = new Map(rows.map(row => [row.key, row]));
  const suppressedParents = new Set();
  for (const row of rows) {
    if (row.provider !== 'claude' || !row.isSubagent || row.status !== 'approval' || row.quiet) continue;
    const childTimes = row.pendingEntries?.filter(e => e.ref !== 'generic' && e.status === 'approval').map(e => e.since) || [];
    if (!childTimes.length && row.pendingRefs?.some(ref => ref !== 'generic')) childTimes.push(row.waitSince);
    if (!childTimes.length) continue;
    const seen = new Set([row.key]);
    let cursor = row.parentKey ? byKey.get(row.parentKey) : undefined;
    while (cursor && cursor.provider === 'claude' && !seen.has(cursor.key)) {
      seen.add(cursor.key);
      if (childTimes.some(at => sameApprovalWindow(cursor.waitSince, at))) {
        suppressedParents.add(cursor.key);
      }
      cursor = cursor.isSubagent && cursor.parentKey ? byKey.get(cursor.parentKey) : undefined;
    }
  }
  if (!suppressedParents.size) return rows;
  let changed = false;
  const next = rows.map(row => {
    if (!suppressedParents.has(row.key) || !isGenericOnlyApproval(row)) return row;
    changed = true;
    const { waitSince: _ws, pendingRefs: _pr, pendingEntries: _pe, ...rest } = row;
    return { ...rest, status: 'working' };
  });
  return changed ? next : rows;
}

function counts(rows) {
  const result = { attention: 0, approval: 0, input: 0, error: 0, working: 0, done: 0 };
  for (const { status } of rows) {
    if (Object.hasOwn(result, status)) result[status]++;
    if (STATES[status].group === 'attention') result.attention++;
  }
  return result;
}

module.exports = {
  PROVIDERS,
  STATES,
  SUBAGENT_STALE_MS,
  cleanLabel,
  readSessions,
  createSessionReader,
  pruneExpiredSessions,
  toSession,
  resolveSessionWaits,
  deduplicateGenericParentApprovals,
  sessionLabel,
  counts,
};
