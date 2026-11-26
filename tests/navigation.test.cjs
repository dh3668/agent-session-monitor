'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { openSession, startSession, openUsage, probeAgyConversation } = require('../src/navigation.cjs');

const id = '00000001-0002-4000-a000-000000000000';

const ideStore = { probeAgyConversation: async () => 'ide' };

function fakeEditor({ installed = true, failCommand, ackAgy = true, folder = '/work/one', selection, fileType = 2, chatLocation = 'secondarySidebar' } = {}) {
  const commands = [];
  const notices = [];
  const vscode = {
    Uri: { from: (parts) => parts, file: (fsPath) => ({ fsPath }) },
    FileType: { Directory: 2 },
    env: { uriScheme: 'vscode-insiders', asExternalUri: async uri => ({ ...uri, query: 'windowId=17' }) },
    extensions: { getExtension: () => installed ? { activate: async () => {} } : undefined },
    workspace: {
      getConfiguration: () => ({ get: () => chatLocation }),
      fs: { stat: async () => ({ type: fileType }) },
      getWorkspaceFolder: (uri) => uri.fsPath === folder ? { name: 'project' } : undefined,
    },
    window: {
      showWarningMessage: (message) => notices.push(message),
      showInformationMessage: (message, ...items) => {
        notices.push(message);
        return items.includes(selection) ? selection : undefined;
      },
    },
    commands: {
      async executeCommand(command, ...args) {
        commands.push([command, ...args]);
        if (failCommand === command) throw new Error('Unavailable');
        if (command === 'antigravity.openConversation' && ackAgy) return true;
      },
    },
  };
  return { vscode, commands, notices };
}

const rightAgy = ['vscode.moveViews', {
  viewIds: ['antigravity.panel'], destinationId: 'workbench.view.extension.agentSessionMonitorChats',
}];
const rightCodex = ['vscode.moveViews', {
  viewIds: ['chatgpt.sidebarView'], destinationId: 'workbench.view.extension.agentSessionMonitorChats',
}];
const claudeOpen = sessionId => ['claude-vscode.editor.open', sessionId, undefined, undefined,
  undefined, undefined, { programmatic: 'honor-preferred-location' }];

for (const [provider, expectedCommands] of [
  ['claude', [['claude-vscode.sidebar.open'], claudeOpen(id)]],
  ['codex', [rightCodex, ['vscode.open', { scheme: 'vscode-insiders', authority: 'openai.chatgpt',
    path: '/local/' + id, query: 'windowId=17' }]]],
  ['agy', [rightAgy, ['antigravity.openConversation', id]]],
]) {
  test(`opens the exact ${provider} conversation without forcing an editor tab`, async () => {
    const { vscode, commands } = fakeEditor();
    const session = { provider, sessionId: id, cwd: '/work/one' };
    assert.equal(await openSession(vscode, session, ideStore), true);
    assert.deepEqual(commands, expectedCommands);
  });
}

for (const [provider, expectedCommands] of [
  ['claude', [['claude-vscode.sidebar.open'], claudeOpen(undefined)]],
  ['codex', [rightCodex, ['chatgpt.newChat']]],
  ['agy', [rightAgy, ['antigravity.panel.focus'], ['antigravity.startNewConversation']]],
]) {
  test(`starts the ${provider} blank composer, without a prompt`, async () => {
    const { vscode, commands } = fakeEditor();
    assert.equal(await startSession(vscode, provider), true);
    assert.deepEqual(commands, expectedCommands);
  });
}

test('last-used placement preserves the native layout and an existing Claude tab', async () => {
  const { vscode, commands } = fakeEditor({ chatLocation: 'lastUsed' });
  await openSession(vscode, { provider: 'claude', sessionId: id, cwd: '/work/one' });
  await openSession(vscode, { provider: 'codex', sessionId: id, cwd: '/work/one' });
  await openSession(vscode, { provider: 'agy', sessionId: id, cwd: '/work/one' }, ideStore);
  assert.deepEqual(commands, [
    claudeOpen(id),
    ['vscode.open', { scheme: 'vscode-insiders', authority: 'openai.chatgpt', path: '/local/' + id, query: 'windowId=17' }],
    ['antigravity.openConversation', id],
  ]);
});

test('Antigravity and Codex still open their conversation if the workbench cannot move their view', async () => {
  const { vscode, commands } = fakeEditor({ failCommand: 'vscode.moveViews' });
  assert.equal(await openSession(vscode, { provider: 'agy', sessionId: id, cwd: '/work/one' }, ideStore), true);
  assert.equal(await openSession(vscode, { provider: 'codex', sessionId: id, cwd: '/work/one' }), true);
  assert.deepEqual(commands, [
    rightAgy, ['antigravity.openConversation', id],
    rightCodex, ['vscode.open', { scheme: 'vscode-insiders', authority: 'openai.chatgpt', path: '/local/' + id, query: 'windowId=17' }],
  ]);
});

test('failed or unrecognized providers cannot start an unsolicited session', async () => {
  const { vscode, commands } = fakeEditor({ installed: false });
  assert.equal(await startSession(vscode, 'claude'), false);
  assert.equal(await startSession(vscode, 'chatgpt.newChat'), false);
  assert.deepEqual(commands, []);
});

test('an unavailable direct route opens the provider picker with an explicit message', async () => {
  const { vscode, commands, notices } = fakeEditor({ failCommand: 'antigravity.openConversation' });
  assert.equal(await openSession(vscode, { provider: 'agy', sessionId: id, cwd: '/work/one' }, ideStore), false);
  assert.deepEqual(commands, [rightAgy, ['antigravity.openConversation', id], ['antigravity.searchConversations']]);
  assert.match(notices[0], /대화 선택기/);
});

test('hands sessions from another workspace back to the original window', async () => {
  const { vscode, commands, notices } = fakeEditor();
  assert.equal(await openSession(vscode, { provider: 'claude', sessionId: id, cwd: '/work/two' }), false);
  assert.equal(commands.length, 0);
  assert.match(notices[0], /새 VS Code 창/);
});

test('a confirmed external project opens only its folder in a new window', async () => {
  const { vscode, commands } = fakeEditor({ selection: '작업 폴더 열기' });
  assert.equal(await openSession(vscode, { provider: 'claude', sessionId: id, cwd: '/work/two' }), false);
  assert.deepEqual(commands, [['vscode.openFolder', { fsPath: '/work/two' }, { forceNewWindow: true }]]);
});

test('unusable or missing workspace paths never launch a window', async () => {
  const { vscode, commands, notices } = fakeEditor({ selection: '작업 폴더 열기', fileType: 1 });
  assert.equal(await openSession(vscode, { provider: 'claude', sessionId: id, cwd: '' }), false);
  assert.equal(await openSession(vscode, { provider: 'claude', sessionId: id, cwd: '/work/file' }), false);
  assert.equal(commands.length, 0);
  assert.match(notices.at(-1), /폴더를 열 수 없습니다/);
});

test('unknown IDs only open a picker and cannot supply URI components', async () => {
  const { vscode, commands } = fakeEditor();
  assert.equal(await openSession(vscode, { provider: 'codex', sessionId: '../new?prompt=unexpected', cwd: '/work/one' }), false);
  assert.deepEqual(commands, [['chatgpt.openSidebar']]);
});

test('a missing extension is reported without invoking a command', async () => {
  const { vscode, commands, notices } = fakeEditor({ installed: false });
  assert.equal(await openSession(vscode, { provider: 'codex', sessionId: id, cwd: '/work/one' }), false);
  assert.equal(commands.length, 0);
  assert.match(notices[0], /Codex/);
});

test('Claude usage explicitly opens only the first-party account URL and handles a declined browser launch', async () => {
  const { vscode, commands, notices } = fakeEditor({ installed: false });
  const urls = [];
  vscode.env.openExternal = async uri => { urls.push(uri); return urls.length === 1; };
  assert.equal(await openUsage(vscode, 'claude'), true);
  assert.equal(await openUsage(vscode, 'claude'), false);
  assert.deepEqual(urls, Array(2).fill({ scheme: 'https', authority: 'claude.ai', path: '/settings/usage' }));
  assert.match(notices[0], /사용량 페이지/);
  assert.deepEqual(commands, []);
});

test('Codex usage opens the official sidebar route pinned to this window; Antigravity opens the Account screen', async () => {
  const { vscode, commands } = fakeEditor();
  assert.equal(await openUsage(vscode, 'codex'), true);
  assert.equal(await openUsage(vscode, 'agy'), true);
  assert.deepEqual(commands, [
    ['vscode.open', { scheme: 'vscode-insiders', authority: 'openai.chatgpt', path: '/settings/usage', query: 'windowId=17' }],
    ['antigravity.openSettings', 'Account'],
  ]);
});

test('unknown or unavailable usage actions are not dispatched and native failures are shown', async () => {
  const missing = fakeEditor({ installed: false });
  assert.equal(await openUsage(missing.vscode, 'agy'), false);
  assert.equal(await openUsage(missing.vscode, 'https://example.invalid/'), false);
  assert.deepEqual(missing.commands, []);
  const { vscode, notices } = fakeEditor({ failCommand: 'antigravity.openSettings' });
  assert.equal(await openUsage(vscode, 'agy'), false);
  assert.equal(notices[0], 'Antigravity 계정 설정을 열 수 없습니다.');
});

test('CLI-only Codex usage falls back to chatgpt.com/codex/settings/usage when openai.chatgpt is not installed', async () => {
  const { vscode, commands, notices } = fakeEditor({ installed: false });
  const urls = [];
  vscode.env.openExternal = async uri => { urls.push(uri); return urls.length === 1; };
  assert.equal(await openUsage(vscode, 'codex'), true);
  assert.equal(await openUsage(vscode, 'codex'), false);
  assert.deepEqual(urls, Array(2).fill({ scheme: 'https', authority: 'chatgpt.com', path: '/codex/settings/usage' }));
  assert.equal(notices[0], 'Codex 사용량 페이지를 열 수 없습니다.');
  assert.deepEqual(commands, []);
});

test('Antigravity distinguishes IDE vs CLI vs unconfirmed conversations, avoids Conversation unavailable, and offers agy --resume copy', async t => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-nav-agy-'));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  const ideId = '11111111-2222-4333-8444-555555555551';
  const cliId = '11111111-2222-4333-8444-555555555552';
  const missingId = '11111111-2222-4333-8444-555555555553';

  await fs.mkdir(path.join(homeDir, '.gemini', 'antigravity', 'conversations'), { recursive: true });
  const ideDb = path.join(homeDir, '.gemini', 'antigravity', 'conversations', ideId + '.db');
  execFileSync('/usr/bin/sqlite3', [ideDb, `CREATE TABLE trajectory_meta(cascade_id);
    INSERT INTO trajectory_meta VALUES('${ideId}'); CREATE TABLE steps(idx); INSERT INTO steps VALUES(0)`]);
  await fs.mkdir(path.join(homeDir, '.gemini', 'antigravity-cli', 'conversations'), { recursive: true });
  await fs.writeFile(path.join(homeDir, '.gemini', 'antigravity-cli', 'conversations', cliId + '.db'), '');

  assert.equal(await probeAgyConversation(ideId, { homeDir }), 'ide');
  assert.equal(await probeAgyConversation(cliId, { homeDir }), 'cli');
  assert.equal(await probeAgyConversation(missingId, { homeDir }), 'unconfirmed');
  assert.equal(await probeAgyConversation(missingId, { homeDir, source: 'CORTEX_TRAJECTORY_SOURCE_CLI' }), 'cli');

  // 1. CLI-only conversation returns false (preserving unread state), does not call openConversation, and copies resume command when picked.
  const copied = [];
  const cliEnv = fakeEditor({ selection: '재개 명령 복사' });
  cliEnv.vscode.env.clipboard = { writeText: async text => copied.push(text) };
  assert.equal(await openSession(cliEnv.vscode, { provider: 'agy', sessionId: cliId, cwd: '/work/one' }, { homeDir }), false);
  assert.deepEqual(cliEnv.commands, []);
  assert.match(cliEnv.notices[0], /CLI/);
  assert.match(cliEnv.notices[0], new RegExp('agy --resume ' + cliId));
  assert.deepEqual(copied, ['agy --resume ' + cliId]);

  // 2. Unconfirmed conversation returns false and opens picker if requested.
  const missEnv = fakeEditor({ selection: '대화 선택기 열기' });
  assert.equal(await openSession(missEnv.vscode, { provider: 'agy', sessionId: missingId, cwd: '/work/one' }, { homeDir }), false);
  assert.deepEqual(missEnv.commands, [['antigravity.searchConversations']]);
  assert.match(missEnv.notices[0], /새 응답 상태를 유지/);

  // A valid trajectory plus the provider's own workspace route confirms an undefined command result.
  const ideEnv = fakeEditor({ ackAgy: false });
  const workspaceStateDb = path.join(homeDir, 'state.vscdb');
  execFileSync('/usr/bin/sqlite3', [workspaceStateDb, `CREATE TABLE ItemTable(key,value);
    INSERT INTO ItemTable VALUES('google.google-antigravity','{"lastConversationId":"${ideId}"}')`]);
  const session = { provider: 'agy', sessionId: ideId, cwd: '/work/one' };
  assert.equal(await openSession(ideEnv.vscode, session, { homeDir, workspaceStateDb }), true);
  assert.deepEqual(ideEnv.commands, [rightAgy, ['antigravity.openConversation', ideId]]);
  execFileSync('/usr/bin/sqlite3', [workspaceStateDb, `UPDATE ItemTable SET value='{"lastConversationId":"${cliId}"}'`]);
  assert.equal(await openSession(ideEnv.vscode, session, { homeDir, workspaceStateDb }), false,
    'dispatch alone must preserve unread when the provider is showing a different route');

  const faultyDb = path.join(path.dirname(ideDb), cliId + '.db');
  for (const bad of ['', 'unreadable sqlite contents']) {
    await fs.writeFile(faultyDb, bad);
    assert.equal(await probeAgyConversation(cliId, { homeDir }), 'cli');
  }
  await fs.unlink(faultyDb);
  await fs.copyFile(ideDb, faultyDb);
  assert.equal(await probeAgyConversation(cliId, { homeDir }), 'cli', 'mismatched cascade ID is not a valid IDE trajectory');

  const cliOnly = fakeEditor({ installed: false, selection: '재개 명령 복사' });
  cliOnly.vscode.env.clipboard = { writeText: async text => copied.push(text) };
  assert.equal(await openSession(cliOnly.vscode, { ...session, sessionId: cliId }, { homeDir }), false);
  assert.deepEqual(copied, Array(2).fill('agy --resume ' + cliId));
  assert.deepEqual(cliOnly.commands, []);
});

test('reviewing an unavailable conversation preserves its notification and unread receipt', async () => {
  const { createActions } = require('../src/commands.cjs');
  const cleared = [], marked = [], row = { key: 'agy/' + id, provider: 'agy', sessionId: id, cwd: '/work/one', replyAt: 1000 };
  let opened = false;
  const actions = createActions({
    getWorkspaceRevision: () => 0, getRows: () => [row], getBridge: () => undefined,
    openSession: async () => opened, isAlive: () => true,
    alerts: { clearSessionNotifications: keys => cleared.push(...keys) }, receipts: { mark: r => marked.push(r.key) },
  });
  await actions.reviewRow(row);
  assert.deepEqual(cleared, []);
  assert.deepEqual(marked, []);
  opened = true;
  await actions.reviewRow(row);
  assert.ok(cleared.includes(row.key));
  assert.deepEqual(marked, [row.key]);
});

test('a legacy .pb Antigravity conversation counts as opened once the provider shows its route', async t => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-agy-legacy-'));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  const legacyId = '11111111-2222-4333-8444-555555555561';
  const dir = path.join(homeDir, '.gemini', 'antigravity', 'conversations');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, legacyId + '.pb'), 'trajectory');
  assert.equal(await probeAgyConversation(legacyId, { homeDir }), 'legacy');
  const workspaceStateDb = path.join(homeDir, 'state.vscdb');
  execFileSync('/usr/bin/sqlite3', [workspaceStateDb, 'CREATE TABLE ItemTable(key,value); ' +
    "INSERT INTO ItemTable VALUES('google.google-antigravity','{\"lastConversationId\":\"" + legacyId + "\"}')"]);
  const session = { provider: 'agy', sessionId: legacyId, cwd: '/work/one' };
  const editor = fakeEditor({ ackAgy: false });
  assert.equal(await openSession(editor.vscode, session, { homeDir, workspaceStateDb }), true);
  assert.deepEqual(editor.commands, [rightAgy, ['antigravity.openConversation', legacyId]]);
  assert.deepEqual(editor.notices, []);
});
