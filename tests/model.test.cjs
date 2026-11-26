'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { counts, toSession, readSessions, createSessionReader, pruneExpiredSessions, sessionLabel } = require('../src/model.cjs');
const { prepareRuntime, nodeCandidates, nodeExecutable } = require('../src/runtime.cjs');
const { normalize, record } = require('../src/hook.cjs');
const now = Date.now();
const row = (status, id, more = {}) => toSession({ provider: 'claude', sessionId: id, status, cwd: '/x/alpha', updatedAt: now, ...more }, now);

test('count statuses and distinguish two threads in one folder', () => {
  const records = [row('done', 'aaaa-done'), row('working', 'aaaa-work'), row('input', 'aaaa-input'), row('approval', 'aaaa-permission')];
  assert.deepEqual(counts(records), { attention: 2, approval: 1, input: 1, error: 0, done: 1, working: 1 });
  assert.notEqual(sessionLabel(records[0]), sessionLabel(records[1]));
  assert.equal(sessionLabel(records[0], '검토'), '검토');
});

test('legacy rows retain their wait age without fabricated replies or execution fields', () => {
  assert.equal(row('approval','legacy').waitSince, now);
  assert.equal(row('done','legacy').replyAt, undefined);
  const current = row('input','current',{waitSince:now-100,replyAt:now-200,workSince:now-500,
    execution:{model:'gpt-6',modelSource:'setting',modelAt:now,effort:'medium',effortSource:'request',effortAt:now}});
  assert.deepEqual([current.waitSince,current.replyAt,current.workSince,current.execution.effort], [now-100,now-200,now-500,'medium']);
  assert.equal(row('done','invalid',{replyAt:now+90000,execution:{model:'private comment',modelSource:'setting',modelAt:now}}).execution,undefined);
  const child = row('done','leaf',{parentSessionId:'parent',replyAt:now,completedAt:now});
  assert.equal(child.completedAt,now);
  assert.equal(child.replyAt,undefined);
});

test('snapshot turn IDs follow the session ID character and length limits', () => {
  for (const turn of ['a.b:c_d-9', 't'.repeat(160)]) assert.equal(row('working', 'id', { turn }).turn, turn);
  for (const turn of ['', 't'.repeat(161), 'a\n', 'b\0c', 'a\tb', '../elsewhere', {}, 5]) {
    assert.equal(row('working', 'id', { turn }).turn, undefined);
  }
});

test('a running soft wait leaves hard requests, other mature waits and future wakeups independent', () => {
  const { resolveSessionWaits } = require('../src/model.cjs');
  const pendingSoft = {
    running: { status: 'input', since: now - 20000, after: now - 1000 },
    waiting: { status: 'approval', since: now - 11000, after: now },
    later: { status: 'approval', since: now, after: now + 3000 },
  };
  const state = row('approval', 's', { provider: 'agy', pending: { hard: 'approval' }, pendingAt: { hard: now - 5000 }, pendingSoft });
  assert.equal(state.status, 'input');
  const live = resolveSessionWaits(state, { runningSoftRefs: new Set(['running']) }, now);
  assert.deepEqual([live.status, live.waitSince, live.pendingRefs], ['approval', now - 11000, ['hard', 'waiting']]);
  assert.deepEqual(live.softPendingRefs, ['running', 'later']);
  assert.equal(live.nextSoftWaitAt, now + 3000);
  assert.equal(live.pendingSoftEntries.length, 3);
});

test('stale work is shown separately and invalid or aged snapshots are ignored', () => {
  const { SUBAGENT_STALE_MS } = require('../src/model.cjs');
  const day = 86400000;
  assert.equal(row('working', 'abc', { updatedAt: now - 2 * day }).status, 'stale');
  assert.equal(row('approval', 'abc', { updatedAt: now - 2 * day }).status, 'stale');
  // An orphaned working subagent settles to stale faster than a root session.
  assert.equal(row('working', 'sub-old', { parentSessionId: 'root', updatedAt: now - SUBAGENT_STALE_MS - 1000 }).status, 'stale');
  assert.equal(row('working', 'root-3h', { updatedAt: now - SUBAGENT_STALE_MS - 1000 }).status, 'working');
  assert.equal(row('approval', 'sub-wait', { parentSessionId: 'root', updatedAt: now - SUBAGENT_STALE_MS - 1000 }).status, 'approval');
  assert.equal(row('error', 'limited', { errorReason: 'rate_limit' }).errorReason, 'rate_limit');
  assert.equal(row('error', 'bad-reason', { errorReason: 'private_text' }).errorReason, undefined);
  assert.equal(row('done', 'done-reason', { errorReason: 'rate_limit' }).errorReason, undefined);
  assert.equal(row('done', 'abc', { updatedAt: now - 8 * day }), undefined);
  assert.equal(row('done', 'abc', { provider: '__proto__' }), undefined);
  assert.equal(row('done', 'abc', { updatedAt: now + day }), undefined);
});

test('runtime copy creates isolated destinations and real hook snapshots reach the sidebar model', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-flow-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const runtime = await prepareRuntime(home, path.resolve(__dirname, '..'));
  assert.deepEqual(await prepareRuntime(home, path.resolve(__dirname, '..')), runtime);
  const fixture = { session_id: 'fixture-1', cwd: '/repo', tool_name: 'Bash' };
  await record(runtime.stateDir, normalize('claude', 'PermissionRequest', fixture));
  await fs.writeFile(path.join(runtime.stateDir, 'a'.repeat(64) + '.json'), '#corrupt');
  const [observed] = await readSessions(runtime.stateDir);
  assert.deepEqual([observed.provider, observed.status], ['claude', 'approval']);
  await record(runtime.stateDir, normalize('claude', 'Stop', fixture));
  assert.equal((await readSessions(runtime.stateDir))[0].status, 'done');
});

test('a stopped session reads 멈춤, and a waiting row lists only the open requests of its displayed kind', () => {
  const { STATES } = require('../src/model.cjs');
  assert.equal(STATES.idle.label, '멈춤');
  const digest = character => character.repeat(64);
  const waiting = row('input', 'refs', { pending: { [digest('a')]: 'input', [digest('b')]: 'approval', generic: 'input', '../x': 'input' } });
  assert.deepEqual(waiting.pendingRefs, [digest('a'), 'generic']);
  assert.equal(row('working', 'refs', { pending: { [digest('a')]: 'input' } }).pendingRefs, undefined);
  assert.equal(row('approval', 'refs', { pending: ['x'] }).pendingRefs, undefined);
  assert.equal(row('input', 'refs', { updatedAt: now - 2 * 86400000, pending: { [digest('a')]: 'input' } }).pendingRefs, undefined, 'stale waits expose nothing');
});

test('the deployed hook carries what it loads and reports activity from its own copy', async t => {
  const { spawn } = require('node:child_process');
  const { listen } = require('../src/manual.cjs');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-deployed-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const runtime = await prepareRuntime(home, path.resolve(__dirname, '..'));
  assert.deepEqual((await fs.readdir(path.dirname(runtime.hookPath))).sort(), ['activity.cjs', 'hook.cjs', 'manual.cjs']);
  const server = await listen(runtime.stateDir, { canAccept: () => false, canActivity: () => true, wantsActivity: () => true, changed() {} });
  t.after(() => server.dispose());
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runtime.hookPath, 'claude', 'PostToolUse', runtime.stateDir]);
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify({ session_id: 'deployed-1', cwd: '/repo', tool_name: 'Bash', tool_input: { command: 'make check' } }));
  });
  assert.deepEqual(output, { code: 0, stdout: '', stderr: '' });
  for (let i = 0; i < 100 && !server.activityFor('claude/deployed-1'); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(server.activityFor('claude/deployed-1').activity.target, 'make check');
});

test('unstarted and legacy blank idle snapshots stay hidden while real idle sessions remain visible; generic Codex default role is suppressed', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-unstarted-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const write = (name, obj) => fs.writeFile(path.join(dir, name + '.json'), JSON.stringify({ updatedAt: now, cwd: '/repo', ...obj }));
  await Promise.all([
    write('a'.repeat(64), { provider: 'claude', sessionId: 'new-blank', status: 'idle', unstarted: true }),
    write('b'.repeat(64), { provider: 'claude', sessionId: 'legacy-blank', status: 'idle' }),
    write('c'.repeat(64), { provider: 'claude', sessionId: 'real-idle', status: 'idle', workSince: now - 5000 }),
    write('d'.repeat(64), { provider: 'codex', sessionId: 'codex-interrupted', status: 'idle', interrupted: 'turn-1' }),
    write('e'.repeat(64), { provider: 'codex', sessionId: 'codex-sub', parentSessionId: 'root', status: 'working', agentType: 'default' }),
  ]);
  const rows = await readSessions(dir, now);
  assert.deepEqual(rows.map(r => r.sessionId).sort(), ['codex-interrupted', 'codex-sub', 'real-idle']);
  assert.equal(rows.find(r => r.sessionId === 'codex-interrupted').interrupted, true);
  assert.equal(rows.find(r => r.sessionId === 'real-idle').interrupted, undefined);
  assert.doesNotMatch(rows.find(r => r.sessionId === 'codex-sub').title, /\bdefault\b/i);
});

test('pruneExpiredSessions removes only 7-day-old session snapshots and createSessionReader caches unchanged files', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-prune-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const day = 86400000;
  const expiredFile = path.join(dir, '1'.repeat(64) + '.json');
  const freshFile = path.join(dir, '2'.repeat(64) + '.json');
  const otherFile = path.join(dir, 'notes.json');
  await fs.writeFile(expiredFile, JSON.stringify({ provider: 'claude', sessionId: 'old', cwd: '/repo', status: 'done', updatedAt: now - 8 * day }));
  await fs.writeFile(freshFile, JSON.stringify({ provider: 'claude', sessionId: 'sub', parentSessionId: 'root', cwd: '/repo', status: 'working', updatedAt: now }));
  await fs.writeFile(otherFile, '{}');
  const oldTime = new Date(now - 8 * day);
  await fs.utimes(expiredFile, oldTime, oldTime);
  await fs.utimes(otherFile, oldTime, oldTime);

  assert.equal(await pruneExpiredSessions(dir, now), 1);
  await assert.rejects(fs.stat(expiredFile), { code: 'ENOENT' });
  await fs.stat(freshFile);
  await fs.stat(otherFile);

  // createSessionReader caches parsed session until the next staleness boundary while detecting in-place writes.
  const readCached = createSessionReader();
  const initial = await readCached(dir, now);
  assert.equal(initial.length, 1);
  assert.equal(initial[0].status, 'working');
  const repeated = await readCached(dir, now + 60000);
  assert.equal(repeated[0], initial[0], 'unchanged file reuses cached session before staleness boundary');
  const aged = await readCached(dir, now + 3 * 3600000);
  assert.equal(aged[0].status, 'stale', 'staleness updates against current clock even on cache hit');
  // Updating the file invalidates the cache immediately.
  await fs.writeFile(freshFile, JSON.stringify({ provider: 'claude', sessionId: 'sub', parentSessionId: 'root', cwd: '/repo', status: 'done', updatedAt: now + 3 * 3600000 }));
  const updated = await readCached(dir, now + 3 * 3600000);
  assert.equal(updated[0].status, 'done');
});

test('nodeCandidates discovers volta, asdf, mise, fnm and highest semver nvm installation', async t => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-node-'));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  const versions = ['v18.20.0', 'v20.9.0', 'v20.11.1', 'v22.2.0'];
  for (const v of versions) {
    await fs.mkdir(path.join(homeDir, '.nvm', 'versions', 'node', v, 'bin'), { recursive: true });
  }
  const list = await nodeCandidates({ homeDir, env: { PATH: '' }, systemPaths: [] });
  assert.deepEqual(list, [
    path.join(homeDir, '.volta', 'bin', 'node'),
    path.join(homeDir, '.asdf', 'shims', 'node'),
    path.join(homeDir, '.local', 'share', 'mise', 'shims', 'node'),
    path.join(homeDir, '.fnm', 'current', 'bin', 'node'),
    path.join(homeDir, '.nvm', 'versions', 'node', 'v22.2.0', 'bin', 'node'),
    path.join(homeDir, '.nvm', 'versions', 'node', 'v20.11.1', 'bin', 'node'),
    path.join(homeDir, '.nvm', 'versions', 'node', 'v20.9.0', 'bin', 'node'),
    path.join(homeDir, '.nvm', 'versions', 'node', 'v18.20.0', 'bin', 'node'),
  ]);
  const stub = path.join(homeDir, '.nvm', 'versions', 'node', 'v22.2.0', 'bin', 'node');
  await fs.writeFile(stub, '#!/bin/sh\necho v22.2.0\n', { mode: 0o700 });
  assert.equal(await nodeExecutable({ homeDir, env: { PATH: '' }, systemPaths: [] }), stub);
});

test('pendingSoft stays working until maturity, promotes automatically at after, and wakes createSessionReader at the exact boundary', async t => {
  const refA = 'a'.repeat(64);
  const refB = 'b'.repeat(64);
  const snap = {
    provider: 'agy', sessionId: 'soft-1', cwd: '/repo', status: 'working', updatedAt: now, workSince: now - 5000,
    pendingSoft: {
      [refA]: { status: 'approval', since: now, after: now + 16000 },
      [refB]: { status: 'input', since: now + 1000, after: now + 20000 },
      '../bad': { status: 'approval', since: now, after: now + 1000 },
      ['c'.repeat(64)]: { status: 'approval', since: now, after: now + 90000 }, // > 60s window rejected
    },
  };
  // Before maturation: remains working, exposes softPendingRefs & earliest nextSoftWaitAt.
  const early = toSession(snap, now + 15999);
  assert.equal(early.status, 'working');
  assert.equal(early.waitSince, undefined);
  assert.equal(early.pendingRefs, undefined);
  assert.deepEqual(early.softPendingRefs, [refA, refB]);
  assert.equal(early.nextSoftWaitAt, now + 16000);

  // At refA maturation: promotes to approval with waitSince = since and refB still soft-pending.
  const mid = toSession(snap, now + 16000);
  assert.equal(mid.status, 'approval');
  assert.equal(mid.waitSince, now);
  assert.deepEqual(mid.pendingRefs, [refA]);
  assert.deepEqual(mid.softPendingRefs, [refB]);
  assert.equal(mid.nextSoftWaitAt, now + 20000);

  // At refB maturation: input outranks approval.
  const later = toSession(snap, now + 20000);
  assert.equal(later.status, 'input');
  assert.equal(later.waitSince, now + 1000);
  assert.deepEqual(later.pendingRefs, [refB]);
  assert.equal(later.softPendingRefs, undefined);
  assert.equal(later.nextSoftWaitAt, undefined);

  // createSessionReader reuses cache before after and invalidates at exact after without any file write.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-soft-cache-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, '3'.repeat(64) + '.json'), JSON.stringify({
    provider: 'agy', sessionId: 'soft-cache', cwd: '/repo', status: 'working', updatedAt: now,
    pendingSoft: { [refA]: { status: 'approval', since: now, after: now + 10000 } },
  }));
  const readCached = createSessionReader();
  const s1 = (await readCached(dir, now + 1000))[0];
  assert.equal(s1.status, 'working');
  const s2 = (await readCached(dir, now + 9999))[0];
  assert.equal(s2, s1, 'reuses cached working session right up to after - 1');
  const s3 = (await readCached(dir, now + 10000))[0];
  assert.equal(s3.status, 'approval', 'promotes at exact after boundary without file rewrite');
  assert.deepEqual(s3.pendingRefs, [refA]);
  // Aged (>24h) snapshots become stale and never promote soft waits.
  assert.equal(toSession(snap, now + 2 * 86400000).status, 'stale');
});
