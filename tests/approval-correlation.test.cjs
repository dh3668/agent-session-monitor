'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const hook = require('../src/hook.cjs');
const { toSession, readSessions } = require('../src/model.cjs');
const { readCodexResolvedPending } = require('../src/live-state.cjs');
const { noticeFor } = require('../src/manual.cjs');
const { matchesFilter, requestFilePaths } = require('../media/format.js');

const NOW = 1_780_000_000_000;
const cwd = '/work/project';
const patch = content => '*** Begin Patch\n*** Add File: deeply/nested/review.txt\n+' + content + '\n*** End Patch';
const quote = value => "'" + String(value).replaceAll("'", "''") + "'";

async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-approval-'));
  t.after(() => fs.rm(dir, { force: true, recursive: true }));
  return dir;
}

async function fixture(t) {
  const dir = await temp(t);
  const store = path.join(dir, '.codex');
  await fs.mkdir(store);
  const run = (file, sql) => execFileSync('/usr/bin/sqlite3', [path.join(store, file)], { input: sql });
  const history = sql => run('thread_history_1.sqlite', sql);
  const rollout = path.join(store, 'rollout.jsonl');
  run('state_5.sqlite', 'CREATE TABLE threads(id,rollout_path); INSERT INTO threads VALUES (\'thread\',' + quote(rollout) + ');');
  history('CREATE TABLE thread_items(thread_id,turn_id,item_id,item_type,item_json,created_at_ms,completed_at_ms);');
  function complete(id, at) {
    const item = { id, status: 'declined', changes: [{ path: cwd + '/deeply/nested/review.txt' }] };
    history("INSERT INTO thread_items VALUES ('thread','turn'," + quote(id) + ",'fileChange'," + quote(JSON.stringify(item)) + ',' + at + ',' + at + ');');
  }
  const resolved = async snapshot => [...((await readCodexResolvedPending([toSession(snapshot, NOW + 120000)],
    { homeDir: dir, env: {} })).get('codex/thread') || [])];
  return { rollout, complete, resolved, history };
}

function codexWait(body, id) {
  return hook.normalize('codex', 'PermissionRequest', { session_id: 'thread', turn_id: 'turn', cwd,
    tool_name: 'apply_patch', tool_input: body, ...(id && { tool_use_id: id }) });
}

test('concurrent Codex approvals for the same path resolve by native item ID despite large prior output and diffs', async t => {
  const { complete, resolved, history } = await fixture(t);
  const first = codexWait(patch('A'), 'call_a'), second = codexWait(patch('B'), 'call_b');
  const snapshot = hook.advance(hook.advance(null, first, NOW), second, NOW + 1);
  history("INSERT INTO thread_items VALUES ('thread','old','old-cmd','commandExecution',json_object('status','completed','aggregatedOutput',hex(zeroblob(700000))),1,1);");
  history("INSERT INTO thread_items VALUES ('thread','turn','other','fileChange',json_object('status','completed','changes',json_array(json_object('path','/irrelevant','diff',hex(zeroblob(700000)))))," + NOW + "," + (NOW + 2) + ");");
  complete('call_b', NOW + 3);
  assert.deepEqual(await resolved(snapshot), [second.key]);
  assert.deepEqual(await resolved(snapshot), [second.key]);
  assert.doesNotMatch(JSON.stringify(snapshot), /call_a|call_b|review\.txt|Begin Patch/);
  const post = hook.normalize('codex', 'PostToolUse', { session_id: 'thread', turn_id: 'turn', cwd,
    tool_name: 'apply_patch', tool_input: patch('A'), tool_use_id: 'call_a' });
  assert.deepEqual(Object.keys(hook.advance(snapshot, post, NOW + 4).pending), [second.key]);
});

test('without hook IDs, Codex uses original rollout arguments and leaves ambiguous same-file approvals pending', async t => {
  const { rollout, complete, resolved } = await fixture(t);
  const first = codexWait(patch('A')), second = codexWait(patch('B'));
  const snapshot = hook.advance(hook.advance(null, first, NOW), second, NOW + 1);
  complete('native_b', NOW + 10);
  assert.deepEqual(await resolved(snapshot), []);
  await fs.writeFile(rollout, JSON.stringify({ type: 'response_item',
    payload: { type: 'function_call', call_id: 'native_b', name: 'exec_command',
      arguments: JSON.stringify({ cmd: "apply_patch <<'PATCH'\n" + patch('B') + '\nPATCH' }) } }) + '\n');
  assert.deepEqual(await resolved(snapshot), [second.key]);
  assert.deepEqual(await resolved(snapshot), [second.key]);
});

test('identical Codex retry gets a fresh occurrence and never inherits an earlier denial', async t => {
  const { rollout, complete, resolved } = await fixture(t);
  const first = codexWait(patch('same')), second = codexWait(patch('same'));
  const snapshot = hook.advance(hook.advance(null, first, NOW), second, NOW + 500);
  complete('first', NOW + 250);
  assert.notEqual(first.key, second.key);
  assert.equal(snapshot.pendingAt[second.key], NOW + 500);
  assert.deepEqual(await resolved(snapshot), [first.key]);
  const response = id => JSON.stringify({ type: 'response_item',
    payload: { type: 'custom_tool_call', call_id: id, name: 'apply_patch', input: patch('same') } });
  await fs.writeFile(rollout, response('first') + '\n' + response('second') + '\n');
  complete('second', NOW + 60500);
  assert.deepEqual(new Set(await resolved(snapshot)), new Set([first.key, second.key]));
});

test('normal Claude child reads and stops leave the parent permission reminder intact', async t => {
  const dir = await temp(t);
  const root = { session_id: 'root', cwd };
  const child = { ...root, agent_id: 'child' };
  const record = (event, fields) => hook.record(dir, hook.normalize('claude', event, fields));
  await record('UserPromptSubmit', root);
  await record('SubagentStart', child);
  await record('Notification', { ...root, notification_type: 'permission_prompt' });
  await record('PostToolUse', { ...child, tool_name: 'Read', tool_input: { file_path: 'review.txt' } });
  assert.equal((await readSessions(dir)).find(r => r.key === 'claude/root').status, 'approval');
  await record('SubagentStop', child);
  assert.equal((await readSessions(dir)).find(r => r.key === 'claude/root').status, 'approval');
});

test('string apply_patch from the Codex hook is searchable after preview serialization', () => {
  const payload = { session_id: 's', cwd, tool_name: 'apply_patch', tool_input: patch('test') };
  const preview = noticeFor('codex', payload, hook.normalize('codex', 'PermissionRequest', payload));
  assert.deepEqual(requestFilePaths(preview.detail, preview.tool), ['deeply/nested/review.txt']);
  assert.equal(matchesFilter({ status: 'approval', provider: 'codex', preview }, 'nested/review.txt'), true);
});

test('Codex completion coinciding with a retry cannot consume the retry, and old history survives the preview cap', async t => {
  const { complete, resolved } = await fixture(t);
  const first = codexWait(patch('same')), retry = codexWait(patch('same'));
  const snapshot = hook.advance(hook.advance(null, first, NOW), retry, NOW + 10);
  complete('first-native', NOW + 10);
  assert.deepEqual(await resolved(snapshot), [first.key]);
  let many;
  const events = [];
  for (let idx = 0; idx < 34; idx++) {
    const event = codexWait(patch('identical'), 'native-' + idx);
    events.push(event);
    many = hook.advance(many, event, NOW + idx);
    if (idx < 33) complete('native-' + idx, NOW + idx);
  }
  const row = toSession(many, NOW + 100);
  assert.equal(row.pendingRefs.length, 32);
  assert.deepEqual((await resolved(many)).sort(), events.slice(0, 33).map(e => e.key).sort());
  const { resolveSessionWaits } = require('../src/model.cjs');
  assert.deepEqual(resolveSessionWaits(row, { resolvedRefs: new Set(await resolved(many)) }, NOW + 100).pendingRefs, [events[33].key]);
});

test('a completion recorded before a sibling post-hook cannot be reused for the remaining same-target patch', async t => {
  const { complete, resolved } = await fixture(t);
  const first = codexWait(patch('A')), second = codexWait(patch('B'));
  let snapshot = hook.advance(hook.advance(null, first, NOW), second, NOW + 1);
  complete('call_a', NOW + 10);
  const post = hook.normalize('codex', 'PostToolUse', { session_id: 'thread', turn_id: 'turn', cwd, tool_name: 'apply_patch', tool_input: patch('A') });
  snapshot = hook.advance(snapshot, post, NOW + 12);
  assert.deepEqual(Object.keys(snapshot.pending), [second.key]);
  assert.deepEqual(await resolved(snapshot), []);
});

test('overlapping identical calls finish in a different order and can be separated by their native lifetimes', async t => {
  const { rollout, complete, resolved, history } = await fixture(t);
  const a = codexWait(patch('same')), b = codexWait(patch('same'));
  const snapshot = hook.advance(hook.advance(null, a, NOW + 10), b, NOW + 30);
  const calls = ['a', 'b'].map(id => JSON.stringify({ type: 'response_item',
    payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: id, input: patch('same') } }));
  await fs.writeFile(rollout, calls.join('\n') + '\n');
  complete('a', NOW + 40);
  history('ALTER TABLE thread_items ADD COLUMN started_at_ms; UPDATE thread_items SET started_at_ms=' + NOW + ';');
  assert.deepEqual(await resolved(snapshot), []);
  const item = { status: 'declined', changes: [{ path: cwd + '/deeply/nested/review.txt' }] };
  history("INSERT INTO thread_items VALUES ('thread','turn','b','fileChange'," + quote(JSON.stringify(item)) +
    ',' + (NOW + 20) + ',' + (NOW + 50) + ',' + (NOW + 20) + ');');
  assert.deepEqual(new Set(await resolved(snapshot)), new Set([a.key, b.key]));
});

test('a Codex command retry finishes by its latest arguments while the earlier denial still reconciles from history', async t => {
  const { history, resolved, rollout } = await fixture(t);
  const fields = { session_id: 'thread', turn_id: 'turn', cwd, tool_name: 'exec_command',
    tool_input: { cmd: ['echo', "private one's file"] } };
  const wait = () => hook.normalize('codex', 'PermissionRequest', fields);
  const first = wait(), retry = wait();
  let snapshot = hook.advance(hook.advance(null, first, NOW), retry, NOW + 100);
  const item = (status, id, at, command) => history("INSERT INTO thread_items VALUES ('thread','turn'," + quote(id) +
    ",'commandExecution'," + quote(JSON.stringify({ status, command })) + ',' + at + ',' + at + ')');
  item('declined', 'first', NOW + 50, "/bin/zsh -lc echo 'private one'\"'\"'s file'");
  assert.deepEqual(await resolved(snapshot), [first.key]);
  item('completed', 'retry', NOW + 180, fields.tool_input.cmd);
  const calls = ['first', 'retry'].map(call_id => JSON.stringify({ type: 'response_item', payload: {
    type: 'function_call', name: fields.tool_name, call_id, arguments: JSON.stringify({ cmd: "echo 'private one'\\''s file'" }),
  } })).join('\n');
  await fs.writeFile(rollout, calls);
  assert.deepEqual(new Set(await resolved(snapshot)), new Set([first.key, retry.key]), 'history alone can reconcile both matching outcomes');
  snapshot.pendingCalls.stray = { argsRef: retry.argsRef, raw: 'private text' };
  const post = hook.normalize('codex', 'PostToolUse', fields);
  snapshot = hook.advance(snapshot, post, NOW + 200);
  assert.deepEqual(Object.keys(snapshot.pending), [first.key]);
  assert.deepEqual(Object.keys(snapshot.pendingCalls), [first.key]);
  assert.doesNotMatch(JSON.stringify(snapshot), /private|echo|stray/);
  await fs.writeFile(rollout, '');
  assert.deepEqual(await resolved(snapshot), [first.key]);
  history("DELETE FROM thread_items WHERE item_id='first'");
  await fs.writeFile(rollout, calls);
  assert.deepEqual(await resolved(snapshot), [], 'a completed retry cannot clear the older wait');

  for (const status of ['failed', 'completed']) {
    history('DELETE FROM thread_items');
    const wrapped = { ...fields, tool_input: { command: ['/bin/bash', '-lc', 'echo private test'] } };
    const latest = hook.normalize('codex', 'PermissionRequest', wrapped);
    item(status, 'native', NOW + 250, "/bin/bash -lc 'echo private test'");
    assert.deepEqual(await resolved(hook.advance(null, latest, NOW)), [latest.key]);
  }
});

test('Codex reconciles completed and failed rollout commands without storing argv or command output', async t => {
  const { rollout, history, resolved } = await fixture(t);
  history('DROP TABLE thread_items');
  let snapshot;
  const events = [], lines = [];
  for (const [i, status] of ['declined', 'failed', 'completed'].entries()) {
    const command = ['echo', 'secret value ' + i];
    const event = hook.normalize('codex', 'PermissionRequest', { session_id: 'thread', turn_id: 'turn', cwd,
      tool_name: 'shell', tool_input: { command } });
    snapshot = hook.advance(snapshot, event, NOW + i);
    events.push(event.key);
    lines.push(JSON.stringify({ type: 'event_msg', timestamp: new Date(NOW + 100).toISOString(),
      payload: { type: 'item_completed', turn_id: 'turn', item: { type: 'CommandExecution', status, command } } }));
  }
  await fs.writeFile(rollout, lines.join('\n') + '\n');
  assert.deepEqual(new Set(await resolved(snapshot)), new Set(events));
  assert.doesNotMatch(JSON.stringify(snapshot), /echo|secret/);
});
