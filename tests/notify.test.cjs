'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const {
  clean,
  NOTIFICATIONS_SETTINGS_URL,
  defaultHelperPath,
  systemNotify,
  deliverNotification,
  clearNotifications,
  notificationPermission,
  createClaims,
  createNotifier,
} = require('../src/notify.cjs');
const {
  APP_ICON_PNG,
  LOGO_SPECS,
  resolveNotificationLogo,
  resolveWebviewLogos,
} = require('../src/logos.cjs');

function createMockSpawn(handler) {
  const calls = [];
  const spawn = (file, args, options) => {
    const child = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let input = '';
    stdin.on('data', chunk => { input += String(chunk); });
    child.stdin = stdin;
    child.stdout = stdout;
    child.stderr = stderr;
    child.killedWith = null;
    child.kill = signal => { child.killedWith = signal || 'SIGTERM'; };
    const record = { file, args, options, child, get input() { return input; } };
    calls.push(record);
    stdin.on('finish', () => {
      handler(record, { stdout, stderr, child });
    });
    return child;
  };
  return { spawn, calls };
}

test('a system notification passes every text as its own argument, never as AppleScript source', async () => {
  const calls = [];
  const execFile = (file, args, options, done) => { calls.push({ file, args, options }); done(null, '', ''); };
  const hostile = '" & (do shell script "id") & "\n-e\n--';
  assert.equal(await systemNotify({ title: '에이전트 세션', subtitle: 'repo', body: hostile }, { execFile, platform: 'darwin' }), true);
  const [{ file, args, options }] = calls;
  assert.equal(file, '/usr/bin/osascript');
  assert.deepEqual(args.slice(0, 7), ['-e', 'on run argv',
    '-e', 'display notification (item 1 of argv) with title (item 2 of argv) subtitle (item 3 of argv)', '-e', 'end run', '--']);
  assert.deepEqual(args.slice(7), [hostile, '에이전트 세션', 'repo']);
  assert.ok(args.slice(0, 6).every(part => !part.includes('do shell script')));
  assert.ok(options.timeout > 0 && options.timeout <= 10000);
  assert.equal(options.shell, undefined);
  const control = String.fromCharCode(0, 7, 0x1b) + '제목' + String.fromCharCode(0x202e);
  await systemNotify({ title: control, body: 'a\nb'.repeat(400) }, { execFile, platform: 'darwin' });
  assert.equal(calls[1].args[8], '제목', 'control and bidi characters are removed');
  assert.equal(calls[1].args[9], '', 'a missing subtitle is an empty argument');
  assert.ok(calls[1].args[7].length <= 600 && calls[1].args[7].includes('\n'));
  assert.equal(clean(control, 20), '제목');
});

test('notifications are a no-op off macOS and never throw or reject', async () => {
  let called = false;
  assert.equal(await systemNotify({ title: 't', body: 'b' }, { execFile: () => { called = true; }, platform: 'linux' }), false);
  assert.equal(called, false);
  assert.equal(await systemNotify({ title: 't', body: 'b' }, { execFile: () => { throw new Error('spawn failed'); }, platform: 'darwin' }), false);
  assert.equal(await systemNotify({ title: 't', body: 'b' }, { execFile: (_f, _a, _o, done) => done(new Error('timed out')), platform: 'darwin' }), false);
  assert.equal(await systemNotify(undefined, { execFile: (_f, _a, _o, done) => done(null), platform: 'darwin' }), true);
  assert.deepEqual(await deliverNotification({ title: 't' }, { platform: 'win32' }), { ok: false, permission: 'unsupported', backend: 'none' });
  assert.equal(await clearNotifications({ group: 'g' }, { platform: 'linux' }), false);
  assert.deepEqual(await notificationPermission({ platform: 'linux' }), { ok: false, permission: 'unsupported', backend: 'none' });
});

test('only the first window to claim a change announces it, release allows reclaim, and day-old markers are pruned', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-claims-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'notifications');
  let now = Date.now();
  const first = createClaims(directory, { now: () => now }), second = createClaims(directory, { now: () => now });
  const id = 'claude/a|approval|123';
  assert.deepEqual(await Promise.all([first.claim(id), second.claim(id)]).then(results => results.sort()), [false, true]);
  assert.equal(await first.claim(id), false, 'already claimed');
  assert.equal(await second.claim('claude/a|approval|124'), true, 'a later request is a new change');
  const marker = path.join(directory, createHash('sha256').update(id).digest('hex'));
  assert.equal((await fs.stat(marker)).size, 0, 'a marker holds no session content');
  if (process.platform !== 'win32') assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);

  // Releasing a marker after failed delivery lets another window or retry claim it again.
  assert.equal(await first.release(id), true);
  assert.equal(await first.release(id), false, 'releasing an absent marker returns false cleanly');
  assert.equal(await second.claim(id), true, 're-claimed after release');

  const old = (Date.now() - 2 * 86400000) / 1000;
  await fs.utimes(marker, old, old);
  await fs.writeFile(path.join(directory, 'unrelated.txt'), 'x');
  await first.prune();
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  assert.ok((await fs.readdir(directory)).includes('unrelated.txt'), 'only markers are pruned');
  assert.equal(await first.claim(id), true, 'a pruned marker can be claimed again');

  // A storage failure other than an existing marker still announces the change.
  const blocked = path.join(root, 'blocked');
  await fs.writeFile(blocked, '');
  assert.equal(await createClaims(path.join(blocked, 'notifications')).claim(id), true);
  now += 1;
  const notifier = createNotifier({ directory, platform: 'linux' });
  assert.deepEqual(notifier.delays, { local: 1500, remote: 3000 });
  assert.equal(await notifier.show({ title: 't', body: 'b' }), false);
});

test('native helper sends sanitized JSON over stdin and preserves allowlisted editor URIs', async () => {
  let osascriptCalls = 0;
  const execFile = () => { osascriptCalls++; };
  const { spawn, calls } = createMockSpawn((_rec, { stdout, child }) => {
    stdout.end(JSON.stringify({ ok: true, permission: 'granted', id: 'notif-1' }) + '\n');
    child.emit('close', 0);
  });

  const result = await deliverNotification({
    id: 'notif-1\nignored',
    group: 'claude/session-1',
    title: 'Claude Code · 승인 대기' + '\u202e',
    subtitle: 'agent-session-monitor',
    body: '결제 로직 수정 — npm test',
    logoPath: '/abs/path/claude.png',
    openUri: 'vscode://local-tools.agent-session-monitor/focus?key=claude%2Fsession-1&windowId=4',
    workspaceRoot: '/Users/dev/project',
    appName: 'Visual Studio Code',
    interruptionLevel: 'timeSensitive',
    sound: true,
  }, {
    helperPath: '/app/AgentSessionNotifier',
    spawn,
    execFile,
    platform: 'darwin',
  });

  assert.deepEqual(result, { ok: true, permission: 'granted', backend: 'native', id: 'notif-1' });
  assert.equal(osascriptCalls, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, '/app/AgentSessionNotifier');
  assert.deepEqual(calls[0].args, ['--send']);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.shell, undefined);

  const sent = JSON.parse(calls[0].input);
  assert.equal(sent.id, 'notif-1 ignored');
  assert.equal(sent.group, 'claude/session-1');
  assert.equal(sent.title, 'Claude Code · 승인 대기');
  assert.equal(sent.logoPath, '/abs/path/claude.png');
  assert.equal(sent.openUri, 'vscode://local-tools.agent-session-monitor/focus?key=claude%2Fsession-1&windowId=4');
  assert.equal(sent.workspaceRoot, '/Users/dev/project');
  assert.equal(sent.appName, 'Visual Studio Code');
  assert.equal(sent.interruptionLevel, 'timeSensitive');
  assert.equal(sent.sound, true);

  // Unsafe URI schemes and relative paths are stripped before reaching the native helper.
  await deliverNotification({
    title: 't',
    body: 'b',
    openUri: 'javascript:alert(1)',
    logoPath: 'relative/logo.png',
    workspaceRoot: '../escape',
    interruptionLevel: 'critical',
    sound: false,
  }, {
    helperPath: '/app/AgentSessionNotifier',
    spawn,
    execFile,
    platform: 'darwin',
  });
  const sanitized = JSON.parse(calls[1].input);
  assert.equal(sanitized.openUri, undefined);
  assert.equal(sanitized.logoPath, undefined);
  assert.equal(sanitized.workspaceRoot, undefined);
  assert.equal(sanitized.interruptionLevel, undefined);
  assert.equal(sanitized.sound, false);
});

test('permission denied from native helper NEVER falls back to osascript', async () => {
  let osascriptCalls = 0;
  const execFile = (_f, _a, _o, done) => { osascriptCalls++; done(null, '', ''); };
  const { spawn } = createMockSpawn((_rec, { stdout, child }) => {
    stdout.end(JSON.stringify({ ok: false, permission: 'denied' }) + '\n');
    child.emit('close', 0);
  });

  const result = await deliverNotification(
    { title: 'Claude Code', body: '승인 대기' },
    { helperPath: '/app/AgentSessionNotifier', spawn, execFile, platform: 'darwin' },
  );
  assert.deepEqual(result, { ok: false, permission: 'denied', backend: 'native' });
  assert.equal(osascriptCalls, 0, 'osascript must not run when macOS notifications are denied');
  assert.equal(
    await systemNotify({ title: 'Claude Code', body: '승인 대기' }, { helperPath: '/app/AgentSessionNotifier', spawn, execFile, platform: 'darwin' }),
    false,
  );
  assert.equal(osascriptCalls, 0);
});

test('missing native helper (ENOENT or absent file) falls back cleanly to osascript', async () => {
  const osascriptCalls = [];
  const execFile = (file, args, options, done) => { osascriptCalls.push({ file, args, options }); done(null, '', ''); };

  // Case 1: fsSync.existsSync reports helper missing on disk.
  const resMissingFile = await deliverNotification(
    { title: '에이전트 세션', subtitle: 'repo', body: '응답 완료' },
    {
      helperPath: '/missing/AgentSessionNotifier',
      fsSync: { existsSync: () => false },
      execFile,
      platform: 'darwin',
    },
  );
  assert.deepEqual(resMissingFile, { ok: true, permission: 'unknown', backend: 'osascript' });
  assert.equal(osascriptCalls.length, 1);
  assert.equal(osascriptCalls[0].file, '/usr/bin/osascript');

  // Case 2: spawn emits ENOENT asynchronously.
  const { spawn } = createMockSpawn((_rec, { child }) => {
    const err = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    child.emit('error', err);
  });
  const resEnoent = await deliverNotification(
    { title: '에이전트 세션', subtitle: 'repo', body: '승인 대기' },
    {
      helperPath: '/missing/AgentSessionNotifier',
      spawn,
      execFile,
      platform: 'darwin',
    },
  );
  assert.deepEqual(resEnoent, { ok: true, permission: 'unknown', backend: 'osascript' });
  assert.equal(osascriptCalls.length, 2);
});

test('clearNotifications, notificationPermission, and createNotifier wire helper commands properly', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-notifier-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const { spawn, calls } = createMockSpawn((rec, { stdout, child }) => {
    if (rec.args[0] === '--status') {
      stdout.end(JSON.stringify({ ok: true, permission: 'granted', alertSetting: 'enabled', soundSetting: 'enabled' }) + '\n');
    } else if (rec.args[0] === '--clear') {
      stdout.end(JSON.stringify({ ok: true, cleared: 2 }) + '\n');
    } else {
      stdout.end(JSON.stringify({ ok: true, permission: 'granted', id: 'n2' }) + '\n');
    }
    child.emit('close', 0);
  });

  const notifier = createNotifier({
    directory: path.join(root, 'claims'),
    helperPath: '/app/AgentSessionNotifier',
    spawn,
    platform: 'darwin',
  });

  const status = await notifier.permission();
  assert.deepEqual(status, { ok: true, permission: 'granted', backend: 'native', alertSetting: 'enabled', soundSetting: 'enabled' });

  assert.equal(await notifier.clear({ ids: ['a', 'b'], group: 'claude/1' }), true);
  assert.deepEqual(JSON.parse(calls[1].input), { ids: ['a', 'b'], group: 'claude/1' });
  assert.equal(await notifier.clear({}), false, 'empty clear target does not spawn helper');
  assert.equal(calls.length, 2);

  const delivered = await notifier.deliver({ title: 'Codex · 응답 완료', body: '테스트 통과' });
  assert.equal(delivered.ok, true);
  assert.equal(delivered.backend, 'native');

  // Helper unavailable status check
  const unavailable = await notificationPermission({
    helperPath: '/missing/AgentSessionNotifier',
    fsSync: { existsSync: () => false },
    platform: 'darwin',
  });
  assert.deepEqual(unavailable, { ok: false, permission: 'unavailable', backend: 'none' });
  assert.ok(defaultHelperPath('/ext').endsWith(path.join('native', 'AgentSessionNotifier.app', 'Contents', 'MacOS', 'AgentSessionNotifier')));
  assert.match(NOTIFICATIONS_SETTINGS_URL, /^x-apple\.systempreferences:/);
});

test('src/logos.cjs skips SVGs for macOS notifications, prefers vendor PNGs, and falls back to bundled icons', () => {
  const existing = new Set([
    '/ext/media/icons/app.png',
    '/ext/media/icons/claude.png',
    '/ext/media/icons/codex.png',
    '/ext/media/icons/agy.png',
    '/vendors/claude/resources/claude-logo.png',
    '/vendors/codex/resources/blossom-black.svg',
    '/vendors/codex/resources/blossom.dark.png',
    '/vendors/agy/img/logo.png',
  ]);
  const fakeFs = { existsSync: p => existing.has(p) };
  const vscodeWithVendors = {
    extensions: {
      getExtension: id => ({
        'anthropic.claude-code': { extensionPath: '/vendors/claude' },
        'openai.chatgpt': { extensionPath: '/vendors/codex' },
        'google.google-antigravity': { extensionPath: '/vendors/agy' },
      })[id],
    },
  };

  assert.equal(resolveNotificationLogo('claude', { vscode: vscodeWithVendors, extensionPath: '/ext', fsSync: fakeFs }), '/vendors/claude/resources/claude-logo.png');
  assert.equal(resolveNotificationLogo('codex', { vscode: vscodeWithVendors, extensionPath: '/ext', fsSync: fakeFs }), '/vendors/codex/resources/blossom.dark.png',
    'must skip blossom-black.svg and use installed vendor blossom.dark.png (opaque black badge with white mark) when openai.chatgpt is installed');
  assert.equal(resolveNotificationLogo('agy', { vscode: vscodeWithVendors, extensionPath: '/ext', fsSync: fakeFs }), '/vendors/agy/img/logo.png');

  // If Codex vendor only has SVG (no blossom.dark.png), bundled codex.png is used cleanly.
  existing.delete('/vendors/codex/resources/blossom.dark.png');
  assert.equal(resolveNotificationLogo('codex', { vscode: vscodeWithVendors, extensionPath: '/ext', fsSync: fakeFs }), '/ext/media/icons/codex.png');
  existing.add('/vendors/codex/resources/blossom.dark.png');

  // CLI-only user without any vendor extensions gets crisp bundled PNG fallbacks.
  const vscodeNoVendors = { extensions: { getExtension: () => undefined } };
  assert.equal(resolveNotificationLogo('claude', { vscode: vscodeNoVendors, extensionPath: '/ext', fsSync: fakeFs }), '/ext/media/icons/claude.png');
  assert.equal(resolveNotificationLogo('codex', { vscode: vscodeNoVendors, extensionPath: '/ext', fsSync: fakeFs }), '/ext/media/icons/codex.png');
  assert.equal(resolveNotificationLogo('agy', { vscode: vscodeNoVendors, extensionPath: '/ext', fsSync: fakeFs }), '/ext/media/icons/agy.png');

  // Unknown or mixed providers fall back to app.png.
  assert.equal(resolveNotificationLogo(undefined, { vscode: vscodeNoVendors, extensionPath: '/ext', fsSync: fakeFs }), '/ext/media/icons/app.png');
  assert.equal(resolveNotificationLogo('multiple', { vscode: vscodeNoVendors, extensionPath: '/ext', fsSync: fakeFs }), '/ext/media/icons/app.png');

  // Verify real generated PNG assets exist on disk and have valid PNG signatures.
  const repoRoot = path.resolve(__dirname, '..');
  const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (const name of [APP_ICON_PNG, LOGO_SPECS.claude.fallbackPng, LOGO_SPECS.codex.fallbackPng, LOGO_SPECS.agy.fallbackPng]) {
    const filePath = path.join(repoRoot, 'media', 'icons', name);
    assert.ok(fsSync.existsSync(filePath), `expected icon ${name} to exist`);
    const header = fsSync.readFileSync(filePath).subarray(0, 8);
    assert.deepEqual(header, pngMagic, `${name} should be a valid PNG`);
  }
});

test('resolveWebviewLogos supports both vendor-installed and CLI-only fallback marks', () => {
  const webview = { asWebviewUri: uri => ({ toString: () => 'webview:' + uri }) };
  const makeVscode = installed => ({
    Uri: { joinPath: (...parts) => parts.join('/') },
    extensions: { getExtension: id => installed.has(id) ? { extensionUri: 'vendor/' + id } : undefined },
  });

  // All vendor extensions installed
  const withAll = resolveWebviewLogos(
    makeVscode(new Set(['anthropic.claude-code', 'openai.chatgpt', 'google.google-antigravity'])),
    'extRoot',
    webview,
  );
  assert.equal(withAll.localResourceRoots.length, 4);
  assert.equal(withAll.localResourceRoots[0], 'extRoot/media');
  const codexInstalled = withAll.marks.find(m => m.id === 'codex');
  assert.equal(codexInstalled.ink, true);
  assert.deepEqual(codexInstalled.uris, [
    'webview:vendor/openai.chatgpt/resources/blossom-black.svg',
    'webview:vendor/openai.chatgpt/resources/blossom.dark.png',
  ]);
  assert.equal(codexInstalled.fallbackUri, 'webview:extRoot/media/icons/codex.png');

  // CLI-only user (no vendor extensions installed)
  const cliOnly = resolveWebviewLogos(makeVscode(new Set()), 'extRoot', webview);
  assert.deepEqual(cliOnly.localResourceRoots, ['extRoot/media']);
  assert.equal(cliOnly.marks.length, 3);
  for (const mark of cliOnly.marks) {
    assert.equal(mark.ink, false, 'full-color fallback badges must not be inverted with data-ink');
    assert.equal(mark.isFallback, true);
    assert.deepEqual(mark.uris, ['webview:extRoot/media/icons/' + LOGO_SPECS[mark.id].fallbackPng]);
  }
});

test('macOS notifier focuses a window that has the folder open, never replaces the current one, and quits after the hand-off', () => {
  const swiftSrc = fsSync.readFileSync(path.join(__dirname, '..', 'native', 'macos-notifier', 'main.swift'), 'utf8');
  // Without a window flag the editor CLI focuses an existing window for the folder, or opens a new one.
  assert.match(swiftSrc, /proc\.arguments = \[folderPath\]/);
  assert.doesNotMatch(swiftSrc, /--new-window/);
  assert.doesNotMatch(swiftSrc, /--reuse-window/);
  // The click hands off through NSWorkspace's completion, with a safety exit instead of a fixed delay.
  assert.match(swiftSrc, /NSWorkspace\.shared\.open\(uri, configuration: config\) \{/);
  assert.match(swiftSrc, /asyncAfter\(deadline: \.now\(\) \+ 1\.5\) \{ finish\(\) \}/);
  assert.doesNotMatch(swiftSrc, /0\.45/);
  // Banners turned off are reported; several thread groups can be cleared at once.
  assert.match(swiftSrc, /settings\.alertSetting == \.disabled/);
  assert.match(swiftSrc, /let groups: \[String\]\?/);
});

test('a present helper that times out (first-run permission prompt) is reported, not replaced by osascript', async () => {
  let osascriptCalls = 0;
  const execFile = (_f, _a, _o, done) => { osascriptCalls++; done(null, '', ''); };
  const { spawn, calls } = createMockSpawn(() => { /* Never answers, like a pending permission prompt. */ });
  const result = await deliverNotification({ title: 'Claude Code', body: '승인 대기' },
    { helperPath: '/app/AgentSessionNotifier', spawn, execFile, platform: 'darwin', timeout: 20 });
  assert.deepEqual(result, { ok: false, permission: 'unknown', backend: 'native', error: 'timed out' });
  assert.equal(osascriptCalls, 0);
  assert.equal(calls[0].child.killedWith, 'SIGKILL');
});

test('banners turned off are passed on with a delivered notification, and several groups clear in one call', async () => {
  const { spawn, calls } = createMockSpawn((rec, { stdout, child }) => {
    stdout.end(JSON.stringify(rec.args[0] === '--send'
      ? { ok: true, permission: 'granted', id: 'n1', alertSetting: 'disabled' } : { ok: true }) + '\n');
    child.emit('close', 0);
  });
  const options = { helperPath: '/app/AgentSessionNotifier', spawn, platform: 'darwin' };
  assert.deepEqual(await deliverNotification({ title: 't', body: 'b' }, options),
    { ok: true, permission: 'granted', backend: 'native', id: 'n1', alertSetting: 'disabled' });
  assert.equal(await clearNotifications({ ids: ['x'], group: '/a|/b', groups: ['/a', '/b', '/a', ''] }, options), true);
  assert.deepEqual(JSON.parse(calls[1].input), { ids: ['x'], group: '/a|/b', groups: ['/a|/b', '/a', '/b'] });
  assert.equal(await clearNotifications({ groups: ['/only'] }, options), true);
  assert.deepEqual(JSON.parse(calls[2].input), { group: '/only' });
});

// Two unfocused windows listing the same sessions, sharing one claim directory.
function alertWindow(claims, { delivered, cleared, groups = ['/a', '/b'], findWindowForFolder = async () => undefined }) {
  const { createAlerts } = require('../src/alerts.cjs');
  const vscode = { window: { state: { focused: false }, showInformationMessage: async () => {}, showWarningMessage: async () => {} },
    workspace: { isTrusted: true }, env: { appName: 'Visual Studio Code' }, extensions: { getExtension: () => undefined } };
  const notifier = {
    claim: async id => { if (claims.has(id)) return false; claims.add(id); return true; },
    release: async id => claims.delete(id),
    deliver: async payload => { delivered.push(payload); return { ok: true, permission: 'granted', backend: 'native', id: payload.id }; },
    clear: async target => { cleared.push(target); return true; },
    stamp: () => String(claims.size),
    delays: { local: 0, remote: 0 },
  };
  return createAlerts({
    vscode, context: { extensionPath: path.resolve(__dirname, '..') }, directory: '/unused', notifier,
    notificationsSettingsUrl: NOTIFICATIONS_SETTINGS_URL, findWindowForFolder,
    panel: { isShowingRequest: () => false }, receipts: { unread: () => true }, quotaCache: { entries: {} },
    setting: (_name, fallback) => fallback, quotaEnabled: () => false, otherFolders: () => true, activityShown: () => false,
    isAlive: () => true, getWorkspaceRevision: () => 0, getRows: () => [], getTitle: row => row.key, projectRow: row => row,
    workspaceRootFor: () => groups[0], workspaceGroupId: () => groups.join('|'), workspaceGroups: () => groups,
    workspaceLabel: () => 'a · b', buildFocusUri: async () => '', onOpenFolder: () => {}, onReviewRow: () => {},
    log: () => {}, settle: value => Promise.resolve(value).catch(() => {}),
  });
}
const waiting = (session, refs) => ({ key: 'claude/' + session, provider: 'claude', sessionId: session, status: 'approval',
  waitSince: 100, updatedAt: 100, cwd: '/a', pendingRefs: refs });

test('windows that observed a wait at different moments claim its newly added request under one name', async () => {
  const claims = new Set(), delivered = [], cleared = [];
  const early = alertWindow(claims, { delivered, cleared }), late = alertWindow(claims, { delivered, cleared });
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));
  early.notify([], []);
  late.notify([], []);
  // Both see the first request; only the early window announces it.
  await early.notify([waiting('s1', ['a'])], []);
  await settle();
  await late.notify([waiting('s1', ['a'])], []);
  await settle();
  assert.equal(delivered.length, 1);
  // Only the late window scans while a second request arrives, and announces it.
  await late.notify([waiting('s1', ['a', 'b'])], []);
  await settle();
  assert.equal(delivered.length, 2);
  // A third arrives: the windows last saw different states, yet name the change alike.
  await Promise.all([early.notify([waiting('s1', ['c', 'a', 'b'])], []), late.notify([waiting('s1', ['a', 'b', 'c'])], [])]);
  await settle();
  assert.equal(delivered.length, 3, 'exactly one window announces the added request');
  // A request that settled announces nothing.
  await early.notify([waiting('s1', ['b', 'c'])], []);
  await settle();
  assert.equal(delivered.length, 3);
  early.dispose(); late.dispose();
});

test('another folder’s request links to that folder’s window with its session, encoded as the editor decodes links', async () => {
  const claims = new Set(), delivered = [], cleared = [];
  const folder = '/work/R&D 한글 #1';
  // The window's own link as its host encodes it: the whole query is one encoded component.
  const windowUri = 'vscode://local-tools.agent-session-monitor/focus?' + encodeURIComponent('windowId=7');
  const alerts = alertWindow(claims, { delivered, cleared, findWindowForFolder: async () => ({ windowUri, workspaceRoot: folder }) });
  alerts.notify([], []);
  await alerts.notify([], [{ ...waiting('far', ['z']), cwd: folder + '/pkg' }]);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(delivered.length, 1);
  const link = new URL(delivered[0].openUri);
  assert.equal(link.protocol + '//' + link.host + link.pathname, 'vscode://local-tools.agent-session-monitor/focus');
  const arrived = new URLSearchParams(decodeURIComponent(link.search.slice(1)));
  assert.deepEqual([arrived.get('windowId'), arrived.get('key'), arrived.get('cwd')], ['7', 'claude/far', folder]);
  assert.equal(delivered[0].group, folder);
  alerts.dispose();
});

test('a focused multi-root window clears its own thread, each folder thread and everything it delivered; tracking stays bounded', async () => {
  const claims = new Set(), delivered = [], cleared = [];
  const alerts = alertWindow(claims, { delivered, cleared });
  alerts.notify([], []);
  const rows = Array.from({ length: 130 }, (_, i) => waiting('s' + i, ['r' + i]));
  for (let i = 0; i < rows.length; i++) await alerts.notify(rows.slice(0, i + 1), []);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(delivered.length, 130);
  alerts.clearSessionNotifications(['claude/s0']);
  assert.equal(cleared.length, 0, 'the oldest sessions were no longer tracked');
  alerts.clearSessionNotifications(['claude/s129']);
  assert.deepEqual(cleared.at(-1), { ids: [delivered.at(-1).id] });
  alerts.clearWorkspaceNotifications();
  const target = cleared.at(-1);
  assert.equal(target.group, '/a|/b');
  assert.deepEqual(target.groups, ['/a|/b', '/a', '/b']);
  assert.equal(target.ids.length, 64);
  assert.ok(target.ids.includes(delivered.at(-2).id));
  assert.ok(!target.ids.includes(delivered.at(-1).id), 'already cleared with its session');
  alerts.dispose();
});
