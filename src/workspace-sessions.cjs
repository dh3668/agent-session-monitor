'use strict';

const fs = require('node:fs/promises');
const {realpathSync, statSync} = require('node:fs');
const path = require('node:path');
const { isUnderDir } = require('./shared.cjs');

const FOLDER_CHECK_LIMIT = 128;

function absolute(value) {
  return typeof value === 'string' && path.isAbsolute(value) && !/[\0-\x1f]/.test(value);
}

// A scope belongs to one scan. Reuse it before and after reading provider indexes
// so an explicit foreign hook cannot reappear as a child with an inferred folder.
async function createWorkspaceScope(folders, { resolvedRoots, folderCache } = {}) {
  const canonical = new Map();
  function resolve(location) {
    if (!canonical.has(location)) {
      const lookup = fs.realpath(location).catch(async error => {
        // Keep historical paths whose last directories were removed. Resolve the
        // nearest existing ancestor so symlinked parents keep their boundaries.
        if (error.code !== 'ENOENT') return;
        const link = await fs.readlink(location).catch(() => undefined);
        if (link) return resolve(path.resolve(path.dirname(location),link));
        const parent = path.dirname(location);
        if (parent === location) return;
        const resolved = await resolve(parent);
        return resolved && path.join(resolved, path.basename(location));
      });
      canonical.set(location, lookup);
    }
    return canonical.get(location);
  }
  let roots;
  if (Array.isArray(resolvedRoots)) {
    roots = resolvedRoots;
  } else {
    const requested = new Set();
    for (const entry of folders || []) {
      const uri = entry?.uri ?? entry;
      const location = typeof uri === 'string' ? uri :
        uri?.scheme === 'file' && (!uri.authority || uri.authority === 'localhost') && uri.fsPath;
      if (absolute(location)) requested.add(path.resolve(location));
    }
    roots = (await Promise.all([...requested].map(async local => ({local, real:await resolve(local)}))))
      .filter(root => root.real).sort((a,b) => b.real.length - a.real.length);
  }
  const paths = [...new Set(roots.flatMap(r => [r.local,r.real]))];
  const outside = new Set();
  const checkedFolders = folderCache instanceof Map ? folderCache : new Map();

  async function localFolder(location) {
    if (!absolute(location)) return;
    const local = path.resolve(location);
    const physical = await resolve(local);
    if (!physical) return;
    const root = roots.find(r => isUnderDir(physical,r.real));
    if (!root) return;
    // VS Code opens files by the spelling of the user's workspace folder.
    if (isUnderDir(local,root.local)) return local;
    return path.join(root.local, path.relative(root.real,physical));
  }

  async function filter(rows) {
    if (!roots.length) return [];
    const byKey = new Map(rows.map(row => [row.key,row]));
    const membership = new Map();
    const inherited = new Set();
    await Promise.all(rows.map(async row => {
      if (outside.has(row.key)) { membership.set(row.key,null); return; }
      const candidates = Array.isArray(row.workspacePaths) ? row.workspacePaths :
        !row.workspaceInherited && row.cwd ? [row.cwd] : undefined;
      if (!candidates) { inherited.add(row.key); return; }
      const member = (await Promise.all(candidates.map(localFolder))).find(Boolean);
      membership.set(row.key,member || null);
      if (!member) outside.add(row.key);
    }));
    function belongs(row) {
      const chain = new Set();
      let cursor = row;
      while (cursor && !membership.has(cursor.key) && !chain.has(cursor.key)) {
        chain.add(cursor.key);
        const parent = cursor.isSubagent && byKey.get(cursor.parentKey);
        cursor = parent?.provider === cursor.provider ? parent : undefined;
      }
      const location = cursor ? membership.get(cursor.key) : null;
      for (const key of chain) membership.set(key,location || null);
      return location;
    }
    const scoped = [];
    for (const row of rows) {
      const cwd = belongs(row);
      if (!cwd) continue;
      if (inherited.has(row.key)) scoped.push({...row,cwd,workspaceInherited:true});
      else scoped.push(cwd === row.cwd ? row : {...row,cwd});
    }
    return scoped;
  }
  function containsExistingFolder(cwd, { maxAgeMs = 0 } = {}) {
    if (!absolute(cwd)) return false;
    const now = maxAgeMs > 0 ? Date.now() : 0;
    if (maxAgeMs > 0) {
      const cached = checkedFolders.get(cwd);
      if (cached && now - cached.at < maxAgeMs) return cached.ok;
    }
    let ok = false;
    try {
      const physical = realpathSync.native(cwd);
      if (statSync(physical).isDirectory()) {
        ok = roots.some(root => {
          if (!isUnderDir(physical,root.real)) return false;
          // The folder may itself be a symlink retargeted since the last scan.
          try { return realpathSync.native(root.local) === root.real; } catch { return false; }
        });
      }
    } catch { ok = false; }
    if (maxAgeMs > 0 || checkedFolders.has(cwd)) {
      checkedFolders.delete(cwd);
      checkedFolders.set(cwd, { ok, at: now || Date.now() });
      if (checkedFolders.size > FOLDER_CHECK_LIMIT) checkedFolders.delete(checkedFolders.keys().next().value);
    }
    return ok;
  }
  return { paths, roots, filter, containsExistingFolder };
}

const QUIET_AFTER = 15 * 60000;
const WAIT_QUIET_AFTER = 2 * 3600000;
const isAttention = row => ((row.status === 'input' || row.status === 'approval') && !row.quiet) ||
  (row.status === 'error' && !row.errorAcked);
const attentionPriority = row => (row.status === 'input' && !row.quiet) ? 0 :
  (row.status === 'approval' && !row.quiet) ? 1 : (row.status === 'error' && !row.errorAcked) ? 2 : 3;
const isLiveWorking = row => row.status === 'working' && !row.quiet;
const signal = row => Math.max(
  Number.isSafeInteger(row.updatedAt) ? row.updatedAt : 0,
  Number.isSafeInteger(row.activityAt) ? row.activityAt : 0,
  Number.isSafeInteger(row.activity?.at) ? row.activity.at : 0,
);
// Transcript file mtime (`native.updatedAt` merged into `activityAt`) bumps when the
// interruption record itself is written, so interruption checks compare against hook signals only.
const hookSignal = row => Math.max(
  Number.isSafeInteger(row.updatedAt) ? row.updatedAt : 0,
  Number.isSafeInteger(row.hookActivityAt) ? row.hookActivityAt : 0,
  Number.isSafeInteger(row.activity?.at) ? row.activity.at : 0,
);

// Claude's Stop hook does not fire for an interrupted turn and nothing else marks
// the end, so a turn can stay "working" indefinitely. A family that has produced
// no signal for a while is kept apart from live work; it is not declared finished.
// Similarly, a subagent whose last signal preceded a parent's StopFailure error is
// immediately treated as silent rather than live work blocking dismissal, and a
// long-abandoned approval/input wait ages into quiet so it does not trap attention.
function markQuiet(rows, now, quietAfter = QUIET_AFTER, waitQuietAfter = Math.max(WAIT_QUIET_AFTER, quietAfter)) {
  const byKey = new Map(rows.map(row => [row.key, row]));
  const children = new Map();
  for (const row of rows) {
    if (!row.isSubagent || typeof row.parentKey !== 'string') continue;
    if (!children.has(row.parentKey)) children.set(row.parentKey,[]);
    children.get(row.parentKey).push(row);
  }
  function parentTerminatedAt(row) {
    let cursor = row;
    const seen = new Set([row.key]);
    while (cursor?.isSubagent && typeof cursor.parentKey === 'string' && !seen.has(cursor.parentKey)) {
      seen.add(cursor.parentKey);
      const parent = byKey.get(cursor.parentKey);
      if (!parent || parent.provider !== row.provider) break;
      if ((parent.status === 'error' || (parent.status === 'idle' && parent.interrupted === true)) &&
          Number.isSafeInteger(parent.updatedAt)) return parent.updatedAt;
      cursor = parent;
    }
    return 0;
  }
  return rows.map(row => {
    const waiting = row.status === 'approval' || row.status === 'input';
    if (row.status !== 'working' && !waiting) return row;
    // The native writer lock and current turn were checked together on this scan.
    // A quiet command can run for hours without producing another activity record.
    if (row.status === 'working' && row.liveTurnConfirmed) return row;
    let latest = 0;
    const visited = new Set(), stack = [row];
    while (stack.length) {
      const node = stack.pop();
      if (visited.has(node.key)) continue;
      visited.add(node.key);
      latest = Math.max(latest, node.status === 'working' && node.liveTurnConfirmed ? now : signal(node));
      for (const child of children.get(node.key) || []) if (child.provider === row.provider) stack.push(child);
    }
    const terminatedAt = row.isSubagent ? parentTerminatedAt(row) : 0;
    const abandoned = terminatedAt > 0 && terminatedAt >= latest;
    if (waiting) {
      const interrupted = Number.isSafeInteger(row.interruptedAt) && row.interruptedAt >= hookSignal(row);
      return now - latest >= waitQuietAfter || interrupted || abandoned ? {...row, quiet:true, signalAt: interrupted ? row.interruptedAt : latest} : row;
    }
    const turnInterrupted = Number.isSafeInteger(row.turnInterruptedAt) && row.turnInterruptedAt >= hookSignal(row);
    return now - latest >= quietAfter || abandoned || turnInterrupted ? {...row, quiet:true, signalAt: turnInterrupted ? row.turnInterruptedAt : latest} : row;
  });
}

function triageRank(row) {
  if (isAttention(row)) return attentionPriority(row);
  if (row.replyUnread) return 3;
  if (row.status === 'working') return row.quiet ? 5 : 4;
  if (row.quiet && (row.status === 'input' || row.status === 'approval')) return 5;
  return 6;
}

// New replies are newest first, requests are oldest first. Background activity
// can update a thread's native index without producing a reply for the user.
function compareTriage(a,b) {
  const rank = triageRank(a), other = triageRank(b);
  if (rank !== other) return rank - other;
  if (rank < 3) return (a.waitSince || a.updatedAt) - (b.waitSince || b.updatedAt) || a.key.localeCompare(b.key);
  const stamp = row => rank === 3 ? row.replyAt : rank === 4 ? row.workSince || row.turnStartedAt || 0 :
    rank === 5 ? row.signalAt || 0 : row.replyAt || row.completedAt || row.activityAt || row.updatedAt;
  return stamp(b) - stamp(a) || a.key.localeCompare(b.key);
}

// Hook rows that this window's scope excludes but that wait for the user, grouped
// by folder. A child without its own folder uses its nearest same-provider parent's.
function waitingElsewhere(rows, inScope, limit = 8) {
  const byKey = new Map(rows.map(row => [row.key,row]));
  const waiting = [], groups = new Map();
  for (const row of rows) {
    if (!['input','approval'].includes(row.status) || inScope(row.key)) continue;
    let cursor = row;
    const visited = new Set();
    while (cursor && !absolute(cursor.cwd) && cursor.isSubagent && !visited.has(cursor.key)) {
      visited.add(cursor.key);
      const parent = byKey.get(cursor.parentKey);
      cursor = parent?.provider === row.provider ? parent : undefined;
    }
    const cwd = absolute(cursor?.cwd) && cursor.cwd;
    if (!cwd) continue;
    waiting.push(cwd === row.cwd ? row : {...row,cwd});
    const group = groups.get(cwd) || {cwd, folder:path.basename(cwd) || cwd, input:0, approval:0, since:Infinity};
    group[row.status]++;
    group.since = Math.min(group.since, row.waitSince || row.updatedAt);
    groups.set(cwd,group);
  }
  const folders = [...groups.values()].sort((a,b) => b.input + b.approval - a.input - a.approval ||
    a.since - b.since || a.cwd.localeCompare(b.cwd)).slice(0,limit).map(({since, ...group}) => group);
  return {waiting,folders};
}

function familyTree(rows) {
  const nodes = new Map(rows.map(row => [row.key,{
    row, target:row, hasUnread:Boolean(row.replyUnread), attentionCount:Number(isAttention(row)), children:[],
    familyTime:Math.max(row.updatedAt, Number.isSafeInteger(row.activityAt) ? row.activityAt : 0),
    priority:attentionPriority(row),
    complete:row.status === 'done', lastUpdate:row.updatedAt, protectedChild:false,
  }]));
  for (const node of nodes.values()) {
    const parent = node.row.isSubagent && nodes.get(node.row.parentKey);
    if (parent && parent !== node && parent.row.provider === node.row.provider) node.parent = parent;
  }
  // Break malformed provider cycles before aggregating descendants or emitting
  // the tree. Such a component has no confirmed parent and stays visible.
  const checked = new Set();
  for (const node of nodes.values()) {
    let cursor = node;
    const branch = new Set();
    while (cursor && !checked.has(cursor) && !branch.has(cursor)) {
      branch.add(cursor);
      cursor = cursor.parent;
    }
    if (branch.has(cursor)) { cursor.parent = undefined; cursor.complete = false; }
    for (const member of branch) checked.add(member);
  }
  const roots = [];
  for (const node of nodes.values()) (node.parent ? node.parent.children : roots).push(node);
  const order = [...roots];
  for (let i=0; i<order.length; i++) for (const child of order[i].children) order.push(child);
  for (let i=order.length-1; i>=0; i--) {
    const node = order[i];
    if (!node.parent) continue;
    node.parent.familyTime = Math.max(node.parent.familyTime, node.familyTime);
    if (compareTriage(node.target,node.parent.target) < 0) node.parent.target = node.target;
    node.parent.hasUnread ||= node.hasUnread;
    node.parent.attentionCount += node.attentionCount;
    node.parent.priority = Math.min(node.parent.priority, node.priority);
    // A quiet (no-signal) subagent does not keep a completed parent from hiding with completed work,
    // unless that quiet branch still contains live, waiting, or unread descendants.
    node.parent.complete &&= node.complete || (Boolean(node.row.quiet) && !node.protectedChild && !node.attentionCount && !node.hasUnread);
    node.parent.lastUpdate = Math.max(node.parent.lastUpdate,node.lastUpdate);
    node.parent.protectedChild ||= node.protectedChild || isLiveWorking(node.row) || isAttention(node.row);
  }
  return {nodes,roots,order};
}

function hideable(node) {
  // The clicked row's error or quiet state can be dismissed. Live work or unresolved
  // requests/errors in descendants must remain reachable through the parent.
  return Boolean(node && !node.protectedChild && (!['working','approval','input'].includes(node.row.status) || node.row.quiet === true));
}

function dismissalFor(rows,key) {
  const node = familyTree(rows).nodes.get(key);
  return hideable(node) ? {cutoff:node.lastUpdate} : undefined;
}

// Collect the top-most settled/quiet child branches under `parentKey` that can be
// dismissed in one action without hiding any live work, waiting request, or unread error.
function dismissableChildren(rows, parentKey) {
  const root = familyTree(rows).nodes.get(parentKey);
  if (!root) return [];
  const targets = [];
  const collectSubtreeKeys = node => {
    const out = [node.row.key];
    for (const child of node.children) out.push(...collectSubtreeKeys(child));
    return out;
  };
  const visit = node => {
    for (const child of node.children) {
      if (hideable(child) && !isAttention(child.row)) {
        targets.push({ key: child.row.key, cutoff: child.lastUpdate, hiddenKeys: collectSubtreeKeys(child) });
      } else {
        visit(child);
      }
    }
  };
  visit(root);
  return targets;
}

function undismissedSessions(rows,getCutoff) {
  const {order,nodes} = familyTree(rows);
  for (const node of order) {
    const cutoff = getCutoff(node.row.key);
    // A new child or later turn reopens the family with its original context.
    node.hidden = node.parent?.hidden || (Number.isSafeInteger(cutoff) && node.lastUpdate <= cutoff && hideable(node));
  }
  return rows.filter(row => !nodes.get(row.key)?.hidden);
}

// A child's update surfaces its parent. Only fully observed completion counts;
// a historical child or an orphan has no confirmed family completion.
function arrangeSessions(rows, {sort = 'recent', hideCompleted = false, attentionOnly = false, pinnedKeys = []} = {}) {
  const {roots} = familyTree(rows);
  const completed = node => !node.row.isSubagent && node.complete && !node.hasUnread && !node.attentionCount && !node.protectedChild;
  const completedCount = roots.filter(completed).length;
  const compare = (a,b) => (sort === 'attention' ? a.priority - b.priority : 0) ||
    b.familyTime - a.familyTime || a.row.key.localeCompare(b.row.key);
  const pins = new Map([...pinnedKeys].map((key,i) => [key,i]));
  const byTriage = (a,b) => compareTriage(a.target,b.target);
  const pinnedOrder = (a,b) => (pins.get(a.row.key) ?? Infinity) - (pins.get(b.row.key) ?? Infinity);
  roots.sort((a,b) => {
    if (sort !== 'priority') return pinnedOrder(a,b) || compare(a,b);
    const rank = triageRank(a.target);
    if (rank >= 4 && rank === triageRank(b.target)) return pinnedOrder(a,b) || byTriage(a,b);
    return byTriage(a,b);
  });
  const stack = roots.filter(root => !(hideCompleted && completed(root))).reverse();
  const sessions = [];
  while (stack.length) {
    const node = stack.pop();
    if (attentionOnly && node.priority > 2 && !node.hasUnread) continue;
    const promote = node.target !== node.row && triageRank(node.target) < 4;
    sessions.push(promote ? {...node.row,priorityTargetKey:node.target.key,priorityTargetCount:node.attentionCount} : node.row);
    node.children.sort(sort === 'priority' ? byTriage : compare);
    for (let i=node.children.length-1; i>=0; i--) stack.push(node.children[i]);
  }
  return {sessions,completedCount,workingCount:roots.filter(root => isLiveWorking(root.target)).length};
}

module.exports = { createWorkspaceScope, arrangeSessions, dismissalFor, dismissableChildren, undismissedSessions, compareTriage, triageRank, markQuiet, waitingElsewhere, QUIET_AFTER, WAIT_QUIET_AFTER };
