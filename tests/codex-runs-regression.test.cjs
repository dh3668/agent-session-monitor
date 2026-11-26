'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { liveStateFingerprint, readCodexLiveRuns } = require('../src/live-state.cjs');
const { createChildReader } = require('../src/children.cjs');
const { arrangeSessions, markQuiet } = require('../src/workspace-sessions.cjs');

test('a long Codex turn and its spawned family survive earlier stale lock files and stop independently', async t => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-family-'));
  const workspace = path.join(homeDir, 'workspace');
  const base = path.join(homeDir, '.codex');
  const locks = path.join(base, 'thread-writer-locks');
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  await fs.mkdir(workspace);
  await fs.mkdir(locks, { recursive: true });
  const oldIds = Array.from({ length: 201 }, (_, i) => 'a-' + String(i).padStart(3, '0'));
  const ids = ['z-parent', 'z-child', 'z-guardian', 'z-crashed'];
  await Promise.all([...oldIds, ...ids].map(id => fs.writeFile(path.join(locks, id + '.lock'), '')));
  const now = Date.now();
  const started = Math.floor((now - 20 * 60000) / 1000);
  const db = (filename, sql) => execFileSync('/usr/bin/sqlite3', [path.join(base, filename), sql]);
  db('state_5.sqlite', `
    CREATE TABLE threads(id PRIMARY KEY,cwd,title,updated_at,source,agent_path);
    INSERT INTO threads VALUES
      ('z-parent','${workspace}','Parent',${started},'vscode',NULL),
      ('z-child','${workspace}','Child',${started},'{"subagent":{"thread_spawn":{"parent_thread_id":"z-parent"}}}','/root/test'),
      ('z-guardian','${workspace}','Guardian',${started},'{"subagent":{"other":"guardian"}}',NULL),
      ('z-crashed','${workspace}','No writer',${started},'cli',NULL);
    CREATE TABLE thread_spawn_edges(parent_thread_id,child_thread_id PRIMARY KEY);
    INSERT INTO thread_spawn_edges VALUES ('z-parent','z-child');
  `);
  db('thread_history_1.sqlite', `
    CREATE TABLE thread_turns(thread_id,turn_id,rollout_ordinal,status,started_at);
    INSERT INTO thread_turns VALUES ${ids.map(id => `('${id}','turn-1',0,'inProgress',${started})`).join(',')};
  `);

  // Hold real writer locks in a separate process until the test closes its stdin.
  const writer = spawn('/usr/bin/perl', ['-MFcntl=:flock', '-e', [
    'my @held;',
    'for my $p (@ARGV) { open(my $fh, "<", $p) or die $!; flock($fh, LOCK_EX) or die $!; push @held, $fh; }',
    '$|=1; print "ready\n"; <STDIN>;',
  ].join(' '), '--', ...ids.slice(0, 3).map(id => path.join(locks, id + '.lock'))]);
  const exit = once(writer, 'exit');
  t.after(async () => { writer.stdin.end(); await exit; });
  await Promise.race([once(writer.stdout, 'data'), exit.then(() => { throw new Error('writer exited before taking locks'); })]);
  const opts = { homeDir, env: {}, now: () => now };
  const readChildren = createChildReader(opts);
  const active = () => readCodexLiveRuns([workspace], opts).then(result => result.runs);
  const runs = await active();
  assert.deepEqual(runs.map(r => r.sessionId).sort(), ['z-child', 'z-parent']);
  const family = markQuiet(await readChildren(runs), now);
  const child = family.find(r => r.sessionId === 'z-child');
  assert.equal(child.parentKey, 'codex/z-parent');
  assert.equal(child.isSubagent, true);
  for (const row of family) {
    assert.equal(row.status, 'working');
    assert.equal(row.quiet, undefined);
    assert.equal(row.workSince, started * 1000, 'actual start time is preserved');
  }
  assert.equal(arrangeSessions(family).workingCount, 1, 'one working conversation with a working child');

  db('thread_history_1.sqlite', "UPDATE thread_turns SET status='completed' WHERE thread_id='z-parent'");
  const childOnly = markQuiet(await readChildren(await active()), now);
  assert.equal(childOnly.find(r => r.sessionId === 'z-parent').status, 'recent');
  assert.equal(childOnly.find(r => r.sessionId === 'z-child').status, 'working');
  assert.equal(arrangeSessions(childOnly).workingCount, 1, 'a live child keeps its family in progress');

  db('thread_history_1.sqlite', "UPDATE thread_turns SET status='completed' WHERE thread_id='z-child'");
  assert.deepEqual(await active(), []);
  db('thread_history_1.sqlite', `INSERT INTO thread_turns VALUES ('z-parent','turn-2',1,'inProgress',${Math.floor(now / 1000)})`);
  const resumed = await active();
  assert.deepEqual(resumed.map(r => r.turnId), ['turn-2']);
  const fingerprint = await liveStateFingerprint(resumed, opts);
  writer.stdin.end();
  await exit;
  assert.notEqual(await liveStateFingerprint(resumed, opts), fingerprint, 'writer exit is noticed even without a DB update');
  assert.deepEqual(await active(), []);
});

test('Codex caches unchanged scans for two seconds and invalidates on store, scope, file or probe changes', async t => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-run-cache-'));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  const base = path.join(homeDir, '.codex'), locks = path.join(base, 'thread-writer-locks');
  const workspace = path.join(homeDir, 'workspace'), alias = path.join(homeDir, 'linked-project');
  await fs.mkdir(locks, { recursive: true });
  await fs.mkdir(workspace);
  await fs.symlink(workspace, alias);
  const thread = path.join(locks, 'thread.lock');
  await fs.writeFile(thread, '');
  const db = (name, sql) => execFileSync('/usr/bin/sqlite3', [path.join(base, name), sql]);
  db('state_5.sqlite', `CREATE TABLE threads(id,cwd,source); INSERT INTO threads VALUES ('thread','${alias}','cli')`);
  db('thread_history_1.sqlite', "CREATE TABLE thread_turns(thread_id,status,rollout_ordinal); INSERT INTO thread_turns VALUES('thread','completed',0)");
  let scans = 0;
  const readdir = fs.readdir;
  t.mock.method(fs, 'readdir', (dir, ...args) => {
    if (dir === locks) scans++;
    return readdir(dir, ...args);
  });
  const opts = { homeDir, env: {} };
  const read = (overrides = {}, roots = [workspace]) => readCodexLiveRuns(roots, { ...opts, ...overrides });
  assert.deepEqual(await read(), { runs: [], capability: 'available' });
  await read();
  assert.equal(scans, 1);
  await read({ knownIds: ['thread'] });
  await read({ knownIds: ['thread'] }, [homeDir]);
  assert.equal(scans, 3, 'scope and known threads are part of the key');
  await read();
  await fs.writeFile(path.join(locks, 'another.lock'), '');
  await read();
  db('state_5.sqlite', "UPDATE threads SET source='vscode'");
  await read();
  db('thread_history_1.sqlite', "UPDATE thread_turns SET status='inProgress'");
  await read();
  assert.equal(scans, 7, 'each lock directory or database change triggers a new scan');
  const checkLocks = async files => ({ checked: true, locked: new Set(files) });
  for (let i = 0; i < 2; i++) {
    const live = await read({ checkLocks });
    assert.deepEqual(live.runs.map(r => r.cwd), [await fs.realpath(workspace)], 'a thread opened via an alias belongs to its physical workspace');
    await read({ now: () => 1000 });
  }
  assert.equal(scans, 11, 'injected locks and clocks bypass the cache');
  await read({ sqlitePath: path.join(homeDir, 'no-sqlite') });
  assert.equal(scans, 12);
  assert.equal((await read({ env: { CODEX_HOME: path.join(homeDir, 'other') } })).capability, 'unavailable');
  await read();
  const last = scans;
  await new Promise(resolve => setTimeout(resolve, 2050));
  await read();
  assert.equal(scans, last + 1, 'an unchanged empty scan expires even if the flock changes without a write');
});
