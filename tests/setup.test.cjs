'use strict';
require('../media/i18n.js').setLocale('ko'); // These cases check the Korean text; i18n.test.cjs covers English.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { configureHooks, getConfigPath, hookStatus, unquoteBinary, evaluateCodexTrustFromList, evaluateCodexTrustFromToml, codexBinary } = require('../src/setup.cjs');
const { EVENT_NAMES } = require('../src/hook.cjs');

async function fixture(t, provider) {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), '현황판 \' setup-'));
  t.after(() => fs.rm(homeDir, {recursive: true, force: true}));
  const options = {homeDir, env: {}, provider, nodePath: process.execPath,
    hookPath: path.join(homeDir, 'run $(echo x).cjs'), stateDir: path.join(homeDir, 'state')};
  const file = getConfigPath(provider, options);
  async function write(text) {
    await fs.mkdir(path.dirname(file), {recursive: true});
    await fs.writeFile(file, text, {mode: 0o640});
  }
  const raw = () => fs.readFile(file, 'utf8');
  const read = async () => JSON.parse(await raw());
  const apply = (action, extra = {}) => configureHooks({...options, action, ...extra});
  return { options, file, write, raw, read, apply };
}

for (const provider of ['claude', 'codex', 'agy']) {
  test(provider + ' install, CLI argument quoting, idempotent update, and clean removal', async t => {
    const ctx = await fixture(t, provider);
    const userGroup = {matcher: 'Bash', hooks: [{type:'command', command: 'echo preserve'}]};
    const settings = provider === 'agy' ? {myHook: {PreToolUse: [userGroup]}} :
      {other: {text: 'a\\" : b'}, hooks: {PreToolUse: [userGroup], SessionStart: [{hooks: [{type:'command',command:'echo one'}]}]}};
    await ctx.write(JSON.stringify(settings, null, 2) + '\n');
    assert.equal((await ctx.apply('install')).changed, true);
    const installed = await ctx.raw();
    assert.equal((await ctx.apply('install')).changed, false);
    assert.equal(await ctx.raw(), installed);
    const events = provider === 'agy' ? (await ctx.read())['local-vscode-agent-session-monitor'] : (await ctx.read()).hooks;
    for (const event of ['SubagentStart','SubagentStop']) {
      if (provider === 'agy') assert.equal(events[event],undefined);
      else assert.match(events[event][0].hooks[0].command,new RegExp(event));
    }
    if (provider === 'claude') {
      assert.match(events.PostModelSwitch[0].hooks[0].command, /PostModelSwitch/);
      assert.match(events.PermissionDenied[0].hooks[0].command, /PermissionDenied/);
      assert.equal(events.PreToolUse.at(-1).matcher, '^(AskUserQuestion|ExitPlanMode)$');
    }
    if (provider === 'codex') {
      assert.equal(events.PreToolUse.at(-1).matcher, '^(request_user_input|request_permissions)$');
    }
    const handlers = events.PreToolUse.at(-1).hooks;
    assert.match(events.PreToolUse.at(-1).matcher, provider === 'agy' ? /ask_permission/ :
      provider === 'claude' ? /AskUserQuestion/ : /request_user_input/);
    if (provider === 'agy') {
      assert.equal(events.SessionStart[0].type, 'command');
      assert.equal(events.PreToolUse.at(-1).matcher,
        '^(ask_permission|ask_question|notify_user|run_command|write_file|write_to_file|edit_file|replace_file_content|multi_replace_file_content|read_file|view_file|read_url_content)$');
      assert.equal(events.PostToolUse.at(-1).matcher, '*');
    }
    await fs.writeFile(ctx.options.hookPath, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
    const run = spawnSync('/bin/sh', ['-c', handlers[0].command], {encoding:'utf8'});
    assert.equal(run.status, 0);
    assert.deepEqual(JSON.parse(run.stdout), [provider, 'PreToolUse', ctx.options.stateDir]);
    await ctx.apply('install', {nodePath: '/another/node'});
    assert.ok((await ctx.raw()).includes('/another/node'));
    assert.ok(!(await ctx.raw()).includes(ctx.options.nodePath));
    assert.equal((await ctx.apply('remove')).changed, true);
    assert.deepEqual(await ctx.read(), settings);
    assert.equal((await fs.stat(ctx.file)).mode & 0o777, 0o640);
    assert.equal((await ctx.apply('remove')).changed, false);
  });
}

test('parallel installation persists one registration and honors peers editing the same file', async t => {
  const ctx = await fixture(t, 'codex');
  const results = await Promise.all([ctx.apply('install'), ctx.apply('install')]);
  assert.deepEqual(results.map(x => x.changed).sort(), [false, true]);
  const config = await ctx.read();
  config.hooks.Stop[0].hooks.push({type: 'command', command: 'echo user-added'});
  await ctx.write(JSON.stringify(config));
  await ctx.apply('remove');
  assert.deepEqual(await ctx.read(), {hooks: {Stop: [{hooks: [{type:'command',command:'echo user-added'}]}]}});
});

test('refuses malformed or lossy settings without printing any contents', async t => {
  const ctx = await fixture(t, 'claude');
  for (const input of ['// secret\n{}', '{"secret": 1, "secret": 3}', '{"hooks": null}',
    '{"hooks": {"Stop": "secret"}}', '{"big": 88888888888888888888}']) {
    await ctx.write(input);
    await assert.rejects(ctx.apply('install'), err => !err.message.includes('secret'));
    assert.equal(await ctx.raw(), input);
  }
});

test('does not create user config on missing uninstall and preserves a symlink target', async t => {
  const ctx = await fixture(t, 'agy');
  assert.equal((await ctx.apply('remove')).changed, false);
  await assert.rejects(fs.access(path.dirname(ctx.file)), {code:'ENOENT'});
  const target = path.join(ctx.options.homeDir, 'target');
  await fs.writeFile(target, '{}');
  await fs.mkdir(path.dirname(ctx.file), {recursive:true});
  await fs.symlink(target, ctx.file);
  await assert.rejects(ctx.apply('install'), /링크/);
  assert.equal(await fs.readFile(target, 'utf8'), '{}');
});

test('removes hooks even when Node has been uninstalled; read-only settings stay intact', async t => {
  const ctx = await fixture(t, 'codex');
  await ctx.apply('install');
  const installed = await ctx.raw();
  await fs.chmod(ctx.file, 0o400);
  await assert.rejects(ctx.apply('remove', {nodePath: undefined}), /읽기 전용/);
  assert.equal(await ctx.raw(), installed);
  await fs.chmod(ctx.file, 0o600);
  assert.equal((await ctx.apply('remove', {nodePath: undefined})).changed, true);
  assert.deepEqual(await ctx.read(), {});
});

test('preserves an existing setup lock and identifies its path for crash recovery', async t => {
  const ctx = await fixture(t, 'claude');
  await ctx.write('{}');
  const lockPath = ctx.file + '.agent-session-monitor.lock';
  await fs.writeFile(lockPath, 'other-window');
  await assert.rejects(ctx.apply('install'), err => err.message.endsWith(lockPath));
  assert.equal(await ctx.raw(), '{}');
  assert.equal(await fs.readFile(lockPath, 'utf8'), 'other-window');
});

test('a setup lock left by a crashed window more than a minute ago is reclaimed', async t => {
  const ctx = await fixture(t, 'claude');
  await ctx.write('{}');
  const lockPath = ctx.file + '.agent-session-monitor.lock';
  await fs.writeFile(lockPath, 'crashed-window');
  const old = new Date(Date.now() - 2 * 60000);
  await fs.utimes(lockPath, old, old);
  assert.equal((await ctx.apply('install')).changed, true);
  assert.ok((await ctx.read()).hooks.Stop);
  await assert.rejects(fs.access(lockPath), {code: 'ENOENT'});
  const leftovers = (await fs.readdir(path.dirname(ctx.file))).filter(name => name.includes('.stale') || name.endsWith('.lock'));
  assert.deepEqual(leftovers, []);
});

test('Codex trust is checked for a connected registration even without verifying hook files', async t => {
  const ctx = await fixture(t, 'codex');
  await ctx.apply('install');
  let listed = 0;
  const status = await hookStatus({ ...ctx.options, checkTrust: true, listCodexHooks: async () => { listed++; return []; } });
  assert.equal(listed, 1);
  assert.equal(status, 'untrusted');
  assert.equal(await hookStatus({ ...ctx.options }), 'connected', 'registration alone still reads as connected');
  assert.equal(await hookStatus({ ...ctx.options, provider: 'claude', checkTrust: true }), 'missing');
});

for (const provider of ['claude', 'codex', 'agy']) {
  test(provider + ' hook status reads missing, connected and partial installs without writing', async t => {
    const ctx = await fixture(t, provider);
    const status = (extra = {}) => hookStatus({...ctx.options, ...extra});
    assert.equal(await status(), 'missing', 'no settings file');
    await ctx.write('{"hooks": ');
    assert.equal(await status(), 'missing', 'unparsable settings');
    await ctx.write('{}');
    assert.equal(await status(), 'missing');
    await ctx.apply('install');
    const installed = await ctx.raw();
    const stat = await fs.stat(ctx.file);
    assert.equal(await status(), 'connected');
    assert.equal(await ctx.raw(), installed);
    assert.equal((await fs.stat(ctx.file)).mtimeMs, stat.mtimeMs, 'the check never rewrites settings');
    assert.equal(await status({stateDir: path.join(ctx.options.homeDir, 'another-profile')}), 'missing',
      'another installation of the extension is not this one');
    const config = await ctx.read();
    const block = provider === 'agy' ? config['local-vscode-agent-session-monitor'] : config.hooks;
    const [first] = EVENT_NAMES[provider];
    const removed = structuredClone(config);
    delete (provider === 'agy' ? removed['local-vscode-agent-session-monitor'] : removed.hooks)[first];
    await ctx.write(JSON.stringify(removed));
    assert.equal(await status(), 'update', 'one event is missing');
    const doubled = structuredClone(config);
    const target = (provider === 'agy' ? doubled['local-vscode-agent-session-monitor'] : doubled.hooks).PreToolUse.at(-1);
    target.hooks.push({...target.hooks[0]});
    await ctx.write(JSON.stringify(doubled));
    assert.equal(await status(), 'update', 'a duplicated handler is rewritten by an install');
    const rematched = structuredClone(config);
    (provider === 'agy' ? rematched['local-vscode-agent-session-monitor'] : rematched.hooks).PreToolUse.at(-1).matcher = '.*';
    await ctx.write(JSON.stringify(rematched));
    assert.equal(await status(), 'update', 'an older matcher');
    await ctx.write('\uFEFF' + JSON.stringify(config));
    assert.equal(await status(), 'connected', 'a byte-order mark is accepted');
    const foreign = {hooks: Object.fromEntries(Object.keys(block).map(event => [event, [{hooks: [{type: 'command',
      command: "'/bin/node' '/elsewhere/hook.cjs' '" + provider + "' '" + event + "' '" + ctx.options.stateDir + "'", timeout: 3}]}]]))};
    await ctx.write(JSON.stringify(provider === 'agy' ? {'local-vscode-agent-session-monitor': foreign.hooks} : foreign));
    assert.equal(await status(), 'missing', "someone else's hooks are not a connection");
  });
}

test('Claude permission hook allows the longest inline window; an earlier 55 s install reads as an update', async t => {
  const ctx = await fixture(t, 'claude');
  await ctx.apply('install');
  const config = await ctx.read();
  for (const [event, entries] of Object.entries(config.hooks)) {
    assert.equal(entries.at(-1).hooks[0].timeout, event === 'PermissionRequest' ? 600 : 3, event);
  }
  config.hooks.PermissionRequest.at(-1).hooks[0].timeout = 55;
  await ctx.write(JSON.stringify(config, null, 2));
  assert.equal(await hookStatus(ctx.options), 'update');
  assert.equal((await ctx.apply('install')).changed, true);
  assert.equal((await ctx.read()).hooks.PermissionRequest.at(-1).hooks[0].timeout, 600);
  assert.equal(await hookStatus(ctx.options), 'connected');
  const codex = await fixture(t, 'codex');
  await codex.apply('install');
  assert.equal((await codex.read()).hooks.PermissionRequest.at(-1).hooks[0].timeout, 3);
});

test('provider config directories reflect home overrides only for the corresponding provider', () => {
  const options = {homeDir: '/temp-home', env: {CODEX_HOME: '/codex-home', CLAUDE_CONFIG_DIR: '/claude-home'}};
  assert.equal(getConfigPath('claude', options), '/claude-home/settings.json');
  assert.equal(getConfigPath('codex', options), '/codex-home/hooks.json');
  assert.equal(getConfigPath('agy', options), '/temp-home/.gemini/config/hooks.json');
  assert.throws(() => getConfigPath('other', options), /지원/);
});

test('hookStatus with verifyFiles detects dead node binary or missing hook script and unquoteBinary handles quotes', async t => {
  assert.equal(unquoteBinary("'/opt/homebrew/bin/node'"), '/opt/homebrew/bin/node');
  assert.equal(unquoteBinary("'/Users/o'\\''neil/bin/node'"), "/Users/o'neil/bin/node");
  assert.equal(unquoteBinary('/unquoted/node'), undefined);
  assert.equal(unquoteBinary("'/bin/node' && true"), undefined);

  const ctx = await fixture(t, 'claude');
  await fs.writeFile(ctx.options.hookPath, '// hook\n', { mode: 0o600 });
  await ctx.apply('install');
  assert.equal(await hookStatus({ ...ctx.options, verifyFiles: true }), 'connected');

  // Missing hook script reports update when verifyFiles is true, while default stays connected.
  await fs.unlink(ctx.options.hookPath);
  assert.equal(await hookStatus(ctx.options), 'connected');
  assert.equal(await hookStatus({ ...ctx.options, verifyFiles: true }), 'update');

  // Restore hook script, install pointing to a nonexistent node binary -> update when verifyFiles is true.
  await fs.writeFile(ctx.options.hookPath, '// hook\n', { mode: 0o600 });
  await ctx.apply('install', { nodePath: path.join(ctx.options.homeDir, 'missing-node') });
  assert.equal(await hookStatus({ ...ctx.options, verifyFiles: true }), 'update');

  // Non-executable file as node binary -> update when verifyFiles is true.
  const nonExec = path.join(ctx.options.homeDir, 'non-exec-node');
  await fs.writeFile(nonExec, '#!/bin/sh\n', { mode: 0o600 });
  await ctx.apply('install', { nodePath: nonExec });
  assert.equal(await hookStatus({ ...ctx.options, verifyFiles: true }), 'update');

  // Older PreToolUse matchers across all three providers report update until reinstalled.
  for (const [provider, oldMatcher] of [
    ['claude', '^AskUserQuestion$'],
    ['codex', '^request_user_input$'],
    ['agy', '^(ask_permission|ask_question|notify_user)$'],
  ]) {
    const older = await fixture(t, provider);
    await older.apply('install');
    assert.equal(await hookStatus(older.options), 'connected', provider);
    const cfg = await older.read();
    const block = provider === 'agy' ? cfg['local-vscode-agent-session-monitor'] : cfg.hooks;
    block.PreToolUse.at(-1).matcher = oldMatcher;
    await older.write(JSON.stringify(cfg, null, 2));
    assert.equal(await hookStatus(older.options), 'update', provider + ' old matcher');
  }
});

test('Codex trust check distinguishes registration from actual trust, isolates monitor hooks from third-party hooks, and never writes config.toml', async t => {
  const ctx = await fixture(t, 'codex');
  await fs.writeFile(ctx.options.hookPath, '// hook\n', { mode: 0o600 });
  // Pre-seed third-party (.orca) hooks alongside monitor hooks in the same hooks.json.
  await ctx.write(JSON.stringify({
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: '/opt/orca/hook.sh SessionStart' }] }],
      Stop: [{ hooks: [{ type: 'command', command: '/opt/orca/hook.sh Stop' }] }],
    },
  }, null, 2));
  await ctx.apply('install');
  const config = await ctx.read();
  const tomlPath = path.join(path.dirname(ctx.file), 'config.toml');
  const initialToml = 'model = "gpt-5.4"\n\n[hooks.state."' + ctx.file + ':session_start:0:0"]\ntrusted_hash = "sha256:orca1"\n';
  await fs.writeFile(tomlPath, initialToml, { mode: 0o600 });

  const toCamel = e => e[0].toLowerCase() + e.slice(1);
  const makeList = (monitorTrust, extraOverrides = {}) => [
    { eventName: 'sessionStart', handlerType: 'command', command: '/opt/orca/hook.sh SessionStart', sourcePath: ctx.file, enabled: true, trustStatus: 'trusted' },
    ...EVENT_NAMES.codex.map(event => ({
      eventName: toCamel(event),
      handlerType: 'command',
      command: config.hooks[event].at(-1).hooks[0].command,
      sourcePath: ctx.file,
      enabled: true,
      trustStatus: monitorTrust,
      ...extraOverrides[event],
    })),
  ];

  // 1. All 10 monitor hooks untrusted while third-party .orca hook is trusted -> 'untrusted'.
  assert.equal(
    await hookStatus({ ...ctx.options, verifyFiles: true, checkTrust: true, listCodexHooks: async () => makeList('untrusted') }),
    'untrusted',
  );
  // 2. Partial trust (9 trusted + 1 modified or disabled) -> 'untrusted'.
  assert.equal(
    evaluateCodexTrustFromList(makeList('trusted', { Stop: { trustStatus: 'modified' } }), { configPath: ctx.file, ...ctx.options }),
    'untrusted',
  );
  assert.equal(
    evaluateCodexTrustFromList(makeList('trusted', { PreToolUse: { enabled: false } }), { configPath: ctx.file, ...ctx.options }),
    'untrusted',
  );
  // 3. All 10 monitor hooks trusted or managed -> 'connected'.
  assert.equal(
    await hookStatus({ ...ctx.options, verifyFiles: true, checkTrust: true, listCodexHooks: async () => makeList('trusted', { SessionStart: { trustStatus: 'managed' } }) }),
    'connected',
  );
  // 4. Fallback to config.toml when hooks/list RPC is unavailable: only .orca trusted -> 'untrusted'.
  assert.equal(
    await hookStatus({ ...ctx.options, verifyFiles: true, checkTrust: true, listCodexHooks: async () => null }),
    'untrusted',
  );
  // Existing trust records may be for a previous command at exactly the same position.
  const toSnake = e => e.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  const trustedSections = EVENT_NAMES.codex.map(event => {
    const groupIdx = config.hooks[event].length - 1;
    return `[hooks.state."${ctx.file}:${toSnake(event)}:${groupIdx}:0"]\ntrusted_hash = "sha256:${'a'.repeat(64)}"\n`;
  }).join('\n');
  assert.equal(
    evaluateCodexTrustFromToml(initialToml + '\n' + trustedSections, {
      configPath: ctx.file,
      entries: EVENT_NAMES.codex.map(event => ({ event, groupIndex: config.hooks[event].length - 1, hookIndex: 0 })),
    }),
    'unverified',
  );
  // 5. Never mutates config.toml during trust checks.
  assert.equal(await fs.readFile(tomlPath, 'utf8'), initialToml);
  const unavailable = () => hookStatus({ ...ctx.options, verifyFiles: true, checkTrust: true, listCodexHooks: async () => null });
  await fs.writeFile(tomlPath, trustedSections);
  assert.equal(await unavailable(), 'unverified');
  await fs.unlink(tomlPath);
  assert.equal(await unavailable(), 'unverified');

  // 6. codexBinary discovers executable under isolated nvm bin directory cleanly.
  const nvmBin = path.join(ctx.options.homeDir, '.nvm', 'versions', 'node', 'v22.17.1', 'bin');
  const fakeCodex = path.join(nvmBin, 'codex');
  await fs.mkdir(nvmBin, { recursive: true });
  await fs.writeFile(fakeCodex, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.equal(await codexBinary({ homeDir: ctx.options.homeDir, env: { PATH: '' } }), fakeCodex);
});
