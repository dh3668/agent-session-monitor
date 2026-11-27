'use strict';
require('../media/i18n.js').setLocale('ko'); // These cases check the Korean text; i18n.test.cjs covers English.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const hook = require('../src/hook.cjs');
const { toSession, resolveSessionWaits, deduplicateGenericParentApprovals } = require('../src/model.cjs');
const {
  readCodexLiveRuns,
  readCodexResolvedPending,
  readAgyResolvedSteps,
  fileChangeTargetHash,
} = require('../src/live-state.cjs');

async function tempHome(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-live-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  async function write(rel, content) {
    const full = path.join(dir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, typeof content === 'string' ? content : JSON.stringify(content));
    return full;
  }
  async function db(rel, sql) {
    const full = path.join(dir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    execFileSync('/usr/bin/sqlite3', ['-batch', full, sql]);
    return full;
  }
  return { dir, write, db };
}

test('Codex live running detector catches new and resumed inProgress turns with live locks and rejects completed or crashed threads', async t => {
  const { dir, write, db } = await tempHome(t);
  const now = Date.UTC(2026, 10, 26, 10, 0, 0);
  const sec = Math.floor(now / 1000);
  const repo = '/work/app';
  await db('.codex/state_5.sqlite', `
    CREATE TABLE threads(id,cwd,title,name,updated_at,archived,source,rollout_path,model,reasoning_effort);
    INSERT INTO threads VALUES
      ('new-run','${repo}','새 작업',NULL,${sec - 5},0,'cli','','gpt-5.4','high'),
      ('resumed-run','${repo}','재개 대화','재개 대화',${sec - 2},0,'vscode','','gpt-5.4','medium'),
      ('done-recent','${repo}','방금 완료',NULL,${sec - 1},0,'vscode','','gpt-5.4','low'),
      ('crashed-old','${repo}','비정상 종료',NULL,${sec - 3600},0,'cli','','gpt-5.4','low'),
      ('other-repo','/work/other','다른 폴더',NULL,${sec - 1},0,'vscode','','gpt-5.4','low');
  `);
  await db('.codex/thread_history_1.sqlite', `
    CREATE TABLE thread_turns(thread_id,turn_id,rollout_ordinal,status,started_at,completed_at);
    INSERT INTO thread_turns VALUES
      ('new-run','turn-1',0,'inProgress',${sec - 5},NULL),
      ('resumed-run','turn-old',0,'completed',${sec - 600},${sec - 500}),
      ('resumed-run','turn-2',1,'inProgress',${sec - 2},NULL),
      ('done-recent','turn-9',0,'completed',${sec - 20},${sec - 1}),
      ('crashed-old','turn-dead',0,'inProgress',${sec - 3600},NULL),
      ('other-repo','turn-other',0,'inProgress',${sec - 1},NULL);
  `);
  const lockNew = await write('.codex/thread-writer-locks/new-run.lock', '');
  const lockResumed = await write('.codex/thread-writer-locks/resumed-run.lock', '');
  const lockDone = await write('.codex/thread-writer-locks/done-recent.lock', '');
  await write('.codex/thread-writer-locks/crashed-old.lock', ''); // unlocked stale lock file
  const lockOther = await write('.codex/thread-writer-locks/other-repo.lock', '');

  const liveLocks = new Set([lockNew, lockResumed, lockDone, lockOther]);
  const res = await readCodexLiveRuns([repo], {
    homeDir: dir,
    env: {},
    now: () => now,
    checkLocks: async files => ({ checked: true, locked: new Set(files.filter(f => liveLocks.has(f))) }),
  });
  assert.equal(res.capability, 'available');
  assert.deepEqual(res.runs.map(r => r.sessionId).sort(), ['new-run', 'resumed-run']);
  const resumed = res.runs.find(r => r.sessionId === 'resumed-run');
  assert.equal(resumed.status, 'working');
  assert.equal(resumed.turnId, 'turn-2');
  assert.equal(resumed.workSince, (sec - 2) * 1000);
  assert.deepEqual(resumed.nativeExecution, { model: 'gpt-5.4', modelSource: 'setting', effort: 'medium', effortSource: 'setting' });

  // When checkLocks fails (unsupported platform/tool), capability is 'unavailable'.
  const unavailable = await readCodexLiveRuns([repo], {
    homeDir: dir,
    env: {},
    checkLocks: async () => ({ checked: false, locked: new Set() }),
  });
  assert.equal(unavailable.capability, 'unavailable');
  assert.deepEqual(unavailable.runs, []);
});

test('Codex live running detector falls back to rollout JSONL when thread_history_1.sqlite is absent', async t => {
  const { dir, write, db } = await tempHome(t);
  const now = Date.UTC(2026, 10, 26, 10, 0, 0);
  const sec = Math.floor(now / 1000);
  const openRollout = await write('.codex/sessions/open.jsonl', [
    JSON.stringify({ timestamp: new Date(now - 5000).toISOString(), type: 'event_msg', payload: { type: 'task_started', turn_id: 't-open' } }),
  ].join('\n') + '\n');
  const closedRollout = await write('.codex/sessions/closed.jsonl', [
    JSON.stringify({ timestamp: new Date(now - 5000).toISOString(), type: 'event_msg', payload: { type: 'task_started', turn_id: 't-closed' } }),
    JSON.stringify({ timestamp: new Date(now - 1000).toISOString(), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't-closed' } }),
  ].join('\n') + '\n');
  await db('.codex/state_5.sqlite', `
    CREATE TABLE threads(id,cwd,title,updated_at,archived,source,rollout_path);
    INSERT INTO threads VALUES
      ('open-1','/work/app','열린 턴',${sec},0,'cli','${openRollout}'),
      ('closed-1','/work/app','닫힌 턴',${sec},0,'cli','${closedRollout}');
  `);
  const lockOpen = await write('.codex/thread-writer-locks/open-1.lock', '');
  const lockClosed = await write('.codex/thread-writer-locks/closed-1.lock', '');
  const res = await readCodexLiveRuns(['/work/app'], {
    homeDir: dir,
    env: {},
    now: () => now,
    checkLocks: async () => ({ checked: true, locked: new Set([lockOpen, lockClosed]) }),
  });
  assert.deepEqual(res.runs.map(r => r.sessionId), ['open-1']);
  assert.equal(res.runs[0].turnId, 't-open');
});

test('Codex declined apply_patch clears only its matching approval while preserving parallel requests, retries, and other sessions', async t => {
  const { dir, db } = await tempHome(t);
  const cwd = '/work/app';
  const now = 1_770_000_050_000;
  const patchA = '*** Begin Patch\n*** Add File: qa-marker.txt\n+hello\n*** End Patch';
  const patchB = '*** Begin Patch\n*** Update File: keep-me.txt\n*** Move to: keep-moved.txt\n@@\n-a\n+b\n*** End Patch';
  const codexEv = (sessionId, name, fields) => hook.normalize('codex', name, { session_id: sessionId, cwd, turn_id: 'turn-1', ...fields });

  let snap1 = hook.advance(null, codexEv('sess-1', 'UserPromptSubmit', {}), now - 10000);
  snap1 = hook.advance(snap1, codexEv('sess-1', 'PermissionRequest', { tool_name: 'apply_patch', tool_input: { command: patchA } }), now - 5000);
  snap1 = hook.advance(snap1, codexEv('sess-1', 'PermissionRequest', { tool_name: 'apply_patch', tool_input: { command: patchB } }), now - 4000);
  const row1 = toSession(snap1, now);
  const refA = row1.pendingEntries.find(e => e.target === fileChangeTargetHash(['qa-marker.txt'], cwd)).ref;
  const refB = row1.pendingEntries.find(e => e.ref !== refA).ref;

  // Session 2 asks for the EXACT SAME patchA — must NOT be cleared by Session 1's decline.
  let snap2 = hook.advance(null, codexEv('sess-2', 'UserPromptSubmit', {}), now - 10000);
  snap2 = hook.advance(snap2, codexEv('sess-2', 'PermissionRequest', { tool_name: 'apply_patch', tool_input: { command: patchA } }), now - 3000);
  const row2 = toSession(snap2, now);

  // thread_items records: sess-1 declined qa-marker.txt AND succeeded on `pwd`, plus an OLD declined keep-me.txt before refB started.
  const declinedA = JSON.stringify({ status: 'declined', changes: [{ path: path.join(cwd, 'qa-marker.txt') }] });
  const completedPwd = JSON.stringify({ status: 'completed', command: '/bin/zsh -lc pwd' });
  const oldDeclinedB = JSON.stringify({ status: 'declined', changes: [{ path: path.join(cwd, 'keep-me.txt'), kind: { type: 'update', move_path: path.join(cwd, 'keep-moved.txt') } }] });
  await db('.codex/thread_history_1.sqlite', `
    CREATE TABLE thread_items(thread_id,turn_id,rollout_ordinal,item_type,item_json,created_at_ms,completed_at_ms);
    INSERT INTO thread_items VALUES
      ('sess-1','turn-1',1,'fileChange','${oldDeclinedB}',${now - 9000},${now - 8500}),
      ('sess-1','turn-1',2,'fileChange','${declinedA}',${now - 4500},${now - 4200}),
      ('sess-1','turn-1',3,'commandExecution','${completedPwd}',${now - 2000},${now - 1900});
  `);

  const resolved = await readCodexResolvedPending([row1, row2], { homeDir: dir, env: {} });
  assert.deepEqual([...(resolved.get('codex/sess-1') || [])], [refA], 'only declined qa-marker.txt clears; pwd and old decline do not clear refB');
  assert.equal(resolved.has('codex/sess-2'), false, 'other session with identical patch is untouched');

  const updated1 = resolveSessionWaits(row1, { resolvedRefs: resolved.get('codex/sess-1') }, now);
  assert.equal(updated1.status, 'approval');
  assert.deepEqual(updated1.pendingRefs, [refB]);

  // Once patchB is also declined after its wait started, session 1 clears cleanly to 'working'.
  const freshDeclinedB = JSON.stringify({ status: 'declined', changes: [{ path: path.join(cwd, 'keep-me.txt'), kind: { type: 'update', move_path: path.join(cwd, 'keep-moved.txt') } }] });
  await db('.codex/thread_history_1.sqlite', `
    INSERT INTO thread_items VALUES ('sess-1','turn-1',4,'fileChange','${freshDeclinedB}',${now - 1500},${now - 1000});
  `);
  const resolved2 = await readCodexResolvedPending([updated1, row2], { homeDir: dir, env: {} });
  const final1 = resolveSessionWaits(updated1, { resolvedRefs: resolved2.get('codex/sess-1') }, now);
  assert.equal(final1.status, 'working');
  assert.equal(final1.pendingRefs, undefined);
  assert.equal(resolved2.has('codex/sess-2'), false);
});

test('Antigravity rejected read_file clears only that soft wait even when official summary DB reports IDLE, while keeping active waits and parallel/other sessions intact', async t => {
  const { dir, write, db } = await tempHome(t);
  const now = 1_770_000_050_000;
  const agySoft = (conversationId, stepIdx, file) => hook.normalize('agy', 'PreToolUse', {
    conversationId, workspacePaths: ['/work/app'], stepIdx,
    toolCall: { name: 'read_file', args: { Path: file } },
  }, { homeDir: dir });

  // Session A: two parallel external read_file calls (step 2 and step 3).
  let snapA = hook.advance(null, hook.normalize('agy', 'PreInvocation', { conversationId: 'agy-a', workspacePaths: ['/work/app'] }), now - 10000);
  snapA = hook.advance(snapA, agySoft('agy-a', 2, '/etc/hosts'), now - 8000);
  snapA = hook.advance(snapA, agySoft('agy-a', 3, '/etc/passwd'), now - 7000);
  const rowA = toSession(snapA, now); // matured past 4s soft delay -> approval
  assert.equal(rowA.status, 'approval');
  assert.equal(rowA.pendingSoftEntries.length, 2);

  // Session B: identical stepIdx 2 still waiting.
  let snapB = hook.advance(null, hook.normalize('agy', 'PreInvocation', { conversationId: 'agy-b', workspacePaths: ['/work/app'] }), now - 10000);
  snapB = hook.advance(snapB, agySoft('agy-b', 2, '/etc/hosts'), now - 8000);
  const rowB = toSession(snapB, now);

  // The summary can be IDLE while the individual steps are WAITING (9).
  await db('.gemini/antigravity/conversation_summaries.db', `
    CREATE TABLE conversation_summaries(conversation_id,status);
    INSERT INTO conversation_summaries VALUES ('agy-a','CASCADE_RUN_STATUS_IDLE'),('agy-b','CASCADE_RUN_STATUS_IDLE');
  `);
  await db('.gemini/antigravity/conversations/agy-a.db', `
    CREATE TABLE steps(idx,status,error_details);
    INSERT INTO steps VALUES (2,9,''),(3,9,'');
  `);
  await db('.gemini/antigravity/conversations/agy-b.db', `
    CREATE TABLE steps(idx,status,error_details);
    INSERT INTO steps VALUES (2,9,'');
  `);
  const whileWaiting = await readAgyResolvedSteps([rowA, rowB], { homeDir: dir });
  assert.equal(whileWaiting.size, 0, 'IDLE summary alone must never clear an active waiting approval');

  // User rejects step 2 on Session A only -> transcript logs ERROR and steps DB sets status=7.
  await write('.gemini/antigravity/brain/agy-a/.system_generated/logs/transcript.jsonl',
    JSON.stringify({ step_index: 2, type: 'GENERIC', status: 'ERROR', error: 'permission check failed for read_file' }) + '\n');
  await db('.gemini/antigravity/conversations/agy-a.db', "UPDATE steps SET status=7, error_details='denied' WHERE idx=2;");

  const afterOne = await readAgyResolvedSteps([rowA, rowB], { homeDir: dir });
  assert.equal(afterOne.has('agy/agy-b'), false, 'Session B must remain completely untouched');
  const resA1 = afterOne.get('agy/agy-a');
  assert.equal(resA1.resolvedSoftRefs.size, 1);
  assert.equal(resA1.haltedOnReject, false, 'step 3 is still waiting');
  const nextA = resolveSessionWaits(rowA, resA1, now);
  assert.equal(nextA.status, 'approval', 'step 3 still keeps Session A in approval');
  assert.equal(nextA.pendingSoftEntries.length, 1);
  assert.equal(nextA.pendingSoftEntries[0].stepIdx, 3);

  // User also rejects step 3 on Session A -> all waits rejected + IDLE summary -> clears to idle!
  await db('.gemini/antigravity/conversations/agy-a.db', "UPDATE steps SET status=7, error_details='denied' WHERE idx=3;");
  const afterBoth = await readAgyResolvedSteps([nextA, rowB], { homeDir: dir });
  const resA2 = afterBoth.get('agy/agy-a');
  assert.equal(resA2.haltedOnReject, true);
  const doneA = resolveSessionWaits(nextA, resA2, now);
  assert.equal(doneA.status, 'idle');
  assert.equal(doneA.pendingRefs, undefined);
  assert.equal(afterBoth.has('agy/agy-b'), false);
});

test('deduplicateGenericParentApprovals suppresses generic-only parent wait under approving child but keeps genuine parent approvals', () => {
  const child = {
    provider: 'claude', key: 'claude/p1/c1', isSubagent: true, parentKey: 'claude/p1',
    status: 'approval', pendingRefs: ['deadbeef01'], pendingEntries: [{ ref: 'deadbeef01', status: 'approval', since: 100 }],
  };
  const genericParent = {
    provider: 'claude', key: 'claude/p1', status: 'approval', waitSince: 106,
    pendingRefs: ['generic'], pendingEntries: [{ ref: 'generic', status: 'approval', since: 106 }],
  };
  const deduped = deduplicateGenericParentApprovals([genericParent, child]);
  assert.equal(deduped[0].status, 'working');
  assert.equal(deduped[0].pendingRefs, undefined);
  assert.equal(deduped[1].status, 'approval');

  const realParent = {
    provider: 'claude', key: 'claude/p1', status: 'approval', waitSince: 90,
    pendingRefs: ['cafe0001'], pendingEntries: [{ ref: 'cafe0001', status: 'approval', since: 90 }],
  };
  const preserved = deduplicateGenericParentApprovals([realParent, child]);
  assert.equal(preserved[0].status, 'approval');
  assert.equal(preserved[1].status, 'approval');
});

test('a malformed Codex completion projection cannot abort other items or sessions', async t => {
  const { dir, write, db } = await tempHome(t);
  const now = Date.now();
  const snapshots = ['first', 'second'].map(session_id => {
    const event = hook.normalize('codex', 'PermissionRequest', { session_id, cwd: '/repo', tool_name: 'Bash', tool_input: { command: 'pwd' } });
    return toSession(hook.advance(null, event, now - 100), now);
  });
  await db('.codex/thread_history_1.sqlite', 'CREATE TABLE thread_items(thread_id,item_type,item_json,completed_at_ms)');
  // Exercise the same sqlitePath boundary as a real scan, with one corrupt paths projection.
  const output = JSON.stringify([{ paths: '{broken' }, { paths: 'null' }, { command: 'pwd', completedAt: now }]);
  const sqlitePath = await write('sqlite-proxy', [
    '#!/bin/sh', 'case "$*" in', '  *" AS paths,"*) echo \'' + output + '\';;', '  *) exec /usr/bin/sqlite3 "$@";;', 'esac',
  ].join('\n'));
  await fs.chmod(sqlitePath, 0o700);
  const resolved = await readCodexResolvedPending(snapshots, { homeDir: dir, env: {}, sqlitePath });
  for (const row of snapshots) assert.deepEqual(resolved.get(row.key), new Set(row.pendingRefs));
});

test('Antigravity db-only cancellations and interruptions release their own wait; a later active step prevents idle', async t => {
  const { dir, db } = await tempHome(t);
  const now = Date.now(), id = 'agy-db-only';
  const opts = { homeDir: dir };
  const event = hook.normalize('agy', 'PreToolUse', { conversationId: id, workspacePaths: ['/work/app'],
    stepIdx: 2, toolCall: { name: 'read_file', args: { Path: '/etc/hosts' } } }, opts);
  const row = toSession(hook.advance(null, event, now - 10000), now);
  const conv = '.gemini/antigravity/conversations/' + id + '.db';
  await db('.gemini/antigravity/conversation_summaries.db', `CREATE TABLE conversation_summaries(conversation_id,status);
    INSERT INTO conversation_summaries VALUES ('${id}','CASCADE_RUN_STATUS_IDLE')`);
  await db(conv, 'CREATE TABLE steps(idx INTEGER PRIMARY KEY,status,error_details); INSERT INTO steps VALUES(2,6,NULL)');
  for (const status of [6, 12, 4, 5]) {
    await db(conv, 'UPDATE steps SET status=' + status + ' WHERE idx=2');
    const result = (await readAgyResolvedSteps([row], opts)).get(row.key);
    assert.deepEqual([...result.resolvedSoftRefs], [event.key]);
    assert.equal(resolveSessionWaits(row, result, now).status, 'idle');
  }
  // The waiting step lies outside the latest five steps. Other independent steps completed later.
  await db(conv, 'INSERT INTO steps VALUES(3,9,NULL),(10,3,NULL),(11,3,NULL),(12,3,NULL),(13,3,NULL),(14,3,NULL)');
  for (const status of [9, 1, 8, 11, 2]) {
    await db(conv, 'UPDATE steps SET status=' + status + ' WHERE idx=3');
    const result = (await readAgyResolvedSteps([row], opts)).get(row.key);
    assert.equal(result.haltedOnReject, false);
    assert.equal(resolveSessionWaits(row, result, now).status, 'working');
  }
});

test('only native RUNNING suppresses a mature Antigravity command wait, including legacy hash-only snapshots', async t => {
  const { dir, write, db } = await tempHome(t);
  const now = Date.now(), opts = { homeDir: dir };
  const event = hook.normalize('agy', 'PreToolUse', { conversationId: 'cmd', workspacePaths: ['/repo'], stepIdx: 12,
    toolCall: { name: 'run_command', args: { CommandLine: 'private command', BypassSandbox: true, WaitMsBeforeAsync: 10000 } } });
  const snapshot = hook.advance(null, event, now - 20000);
  assert.doesNotMatch(JSON.stringify(snapshot), /private command/);
  const row = toSession(snapshot, now);
  const legacy = { ...row, pendingSoftEntries: row.pendingSoftEntries.map(({ stepIdx, ...entry }) => entry) };
  const file = '.gemini/antigravity/conversations/cmd.db';
  await db('.gemini/antigravity/conversation_summaries.db', "CREATE TABLE conversation_summaries(conversation_id,status); INSERT INTO conversation_summaries VALUES('cmd','CASCADE_RUN_STATUS_IDLE')");
  await db(file, 'CREATE TABLE steps(idx INTEGER PRIMARY KEY,status); INSERT INTO steps VALUES(12,2),(13,3),(14,3)');
  await write('.gemini/antigravity/brain/cmd/.system_generated/logs/transcript.jsonl', [
    { step_index: 12, status: 'DONE' }, { step_index: 13, status: 'RUNNING' }, { step_index: 14, status: 'GENERATING' },
  ].map(entry => JSON.stringify(entry)).join('\n'));
  for (const source of [row, legacy]) {
    assert.equal(source.status, 'approval');
    const state = (await readAgyResolvedSteps([source], opts)).get(source.key);
    assert.deepEqual(state, { resolvedSoftRefs: new Set(), runningSoftRefs: new Set([event.key]), haltedOnReject: false, resolvedAt: 0 });
    const running = resolveSessionWaits(source, state, now);
    assert.equal(running.status, 'working');
    assert.equal(running.waitSince, undefined);
    assert.equal(running.pendingRefs, undefined);
    assert.equal(running.nextSoftWaitAt, undefined);
    assert.deepEqual(running.softPendingRefs, [event.key]);
    assert.deepEqual(running.pendingSoftEntries, source.pendingSoftEntries);
  }
  for (const code of [9, 1, 8, 11]) {
    await db(file, 'UPDATE steps SET status=' + code + ' WHERE idx=12');
    assert.equal((await readAgyResolvedSteps([row], opts)).has(row.key), false, 'active status ' + code);
  }
  for (const code of [3, 7]) {
    await db(file, 'UPDATE steps SET status=' + code + ' WHERE idx=12');
    const state = (await readAgyResolvedSteps([row], opts)).get(row.key);
    assert.deepEqual(state.runningSoftRefs, new Set());
    assert.deepEqual(state.resolvedSoftRefs, new Set([event.key]));
    assert.equal(state.haltedOnReject, code === 7, 'completed unrelated steps cannot keep the conversation active');
  }
});
