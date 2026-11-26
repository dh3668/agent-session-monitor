'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { setTimeout: wait } = require('node:timers/promises');
const { normalize, record } = require('../src/hook.cjs');

test('registered view and status bar follow overlapping waits, completion, acknowledgment and another turn', async t => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-view-'));
  const saved = new Map();
  const commands = new Map();
  const notices = [], opened = [], seedKeys = [], preferences = new Map();
  const folder = value => ({name:path.basename(value),uri:{scheme:'file',fsPath:value}});
  const dispose = () => {};
  const status = { show: dispose, dispose };
  let panelData, view, receive, configurationChanged, focusChanged, foldersChanged, picked, pendingRead;
  let subscription = false, canOpen = true, openGate;
  const quotaCalls = [];
  const vscode = {
    window: {
      state: { focused: true },
      showQuickPick:async items => {picked = items; return items[0];},
      showInformationMessage: async message => { notices.push(message); },
      onDidChangeWindowState: callback => { focusChanged = callback; return {dispose}; },
      registerWebviewViewProvider(id, provider) {
        assert.equal(id, 'agentSessionMonitor.sessions');
        view = { visible:true, onDidDispose: () => ({dispose}), onDidChangeVisibility: () => ({dispose}), webview: {
          cspSource:'unit.invalid', asWebviewUri: value => value,
          postMessage(message) { panelData = message; return Promise.resolve(true); },
          onDidReceiveMessage(fn) { receive = fn; return { dispose }; },
        } };
        provider.resolveWebviewView(view);
        receive({type:'ready'});
        return {dispose};
      },
      createStatusBarItem: () => status,
    },
    extensions:{getExtension:() => undefined}, Uri:{joinPath:(...pieces) => pieces.join('/')},
    workspace: { workspaceFolders:[folder("/repo")], onDidChangeWorkspaceFolders:cb => {foldersChanged=cb;return {dispose};}, isTrusted:true, onDidChangeConfiguration:cb => { configurationChanged = cb; return {dispose}; },
      getConfiguration: () => ({ get: (name, fallback) => name === 'subscriptionUsage' ? subscription : fallback }) },
    commands: { registerCommand(key, cb) { commands.set(key, cb); return { dispose }; } },
    TreeItem: class { constructor(label) { this.label = label; } },
    ThemeIcon: class {}, ThemeColor: class {},
    TreeItemCollapsibleState: { Collapsed: 1, Expanded: 2 }, StatusBarAlignment: { Left: 1 },
    EventEmitter: class { fire() {} dispose() {} },
  };
  const original = Module._load;
  let activate;
  try {
    Module._load = function (id, ...args) {
      if (id === 'vscode') return vscode;
      if (id === './children.cjs') return { createChildReader: () => async rows => {
        seedKeys.push(...rows.map(row=>row.key));
        if (pendingRead) { const gate=pendingRead; pendingRead=undefined; gate.enter(); await gate.promise; }
        return rows;
      } };
      if (id === './navigation.cjs') return {openSession:async (_,row)=>{ opened.push(row.key); if (openGate) { const gate = openGate; openGate = undefined; gate.enter(); await gate.promise; } return canOpen; }};
      if (id === './quota.cjs') return { createQuotaReader: () => async provider => {
        quotaCalls.push(provider);
        return {status:'ready',windows:[{label:'주간',percent:14,kind:'used'}]};
      } };
      if (id === './metadata.cjs') return {
        createRecentReader: () => async () => [],
        createMetadataReader: () => async rows => ({sessions:new Map(rows.map(r => [r.key,{title:'검토 기록',execution:{model:'fixture-model',modelSource:'setting'}}])),providerUsage:{}}),
      };
      // Never read the real tool settings or raise a real notification from a test.
      if (id === './setup.cjs') return { hookStatus: async () => 'missing', configureHooks: async () => ({changed:false}) };
      if (id === './notify.cjs') {
        const real = original.call(this, id, ...args);
        return {...real, createNotifier: options => real.createNotifier({...options, platform:'test'})};
      }
      return original.call(this, id, ...args);
    };
    ({ activate } = require('../src/extension.cjs'));
  } finally { Module._load = original; }
  const context = {
    globalStorageUri: { fsPath: storage }, extensionUri: '/fixture', extensionPath: path.resolve(__dirname, '..'), subscriptions: [],
    workspaceState: {get:key=>preferences.get(key),update:(key,value)=>preferences.set(key,value)},
    globalState: { get: key => saved.get(key), update: (key, value) => saved.set(key, value) },
  };
  t.after(async () => {
    for (const item of context.subscriptions) item.dispose();
    await fs.rm(storage, { recursive: true, force: true });
  });
  preferences.set('sessionLayout.v1',{preferences:{sort:'recent',hideCompleted:false}});
  await activate(context);
  const run = (name, ...args) => commands.get('agentSessionMonitor.' + name)(...args);
  const fixture = (session_id) => ({ session_id, cwd: '/repo' });
  const directory = path.join(storage, 'sessions');
  const update = (event, id) => record(directory, normalize('claude', event, {...fixture(id), ...(event === 'Stop' && {last_assistant_message:'fixture reply'})}));
  assert.deepEqual(panelData.sessions, []);
  assert.equal(panelData.workspaceLabel,'repo');
  await record(directory, normalize('claude','PermissionRequest',{session_id:'foreign',cwd:'/repo-backup'}));
  await update('UserPromptSubmit', 'other');
  await update('PermissionRequest', 'review');
  await run('refresh');
  assert.equal(panelData.preferences.sort,'priority');
  await receive({action:'setSort',value:'attention'});
  assert.deepEqual(panelData.sessions.map(r => r.status), ['approval', 'working']);
  assert.ok(!seedKeys.includes('claude/foreign'));
  assert.equal(panelData.sessions[0].title, '검토 기록');
  assert.equal(view.badge.value, 1);
  assert.match(notices[0], /승인 대기/);
  assert.match(status.text, /승인 1.*진행 1/);
  const waiting = panelData.sessions[0];
  await run('dismiss', waiting);
  assert.equal(view.badge.value, 1);
  await update('Stop', 'review');
  await run('refresh');
  assert.equal(view.badge.value, 1);
  assert.equal(panelData.unreadCount,1);
  assert.match(notices.at(-1), /응답 완료/);
  const finished = panelData.sessions.find(row => row.status === 'done');
  await receive({action:'setHideCompleted',value:true});
  assert.ok(panelData.sessions.some(row=>row.replyUnread), 'a fresh response stays visible with completed hidden');
  await receive({action:'markSeen',key:finished.key,provider:'claude',replyAt:finished.replyAt-1});
  canOpen = false;
  await run('nextAttention');
  assert.ok(panelData.sessions.some(row=>row.replyUnread), 'provider picker fallback keeps the reply unread');
  canOpen = true;
  await run('nextAttention');
  assert.equal(view.badge,undefined);
  assert.equal(preferences.get('replySeen:' + finished.key),finished.replyAt);
  assert.equal(panelData.hiddenCompleted,1);
  assert.deepEqual(panelData.sessions.map(row=>row.status),['working']);
  await receive({action:'setHideCompleted',value:false});
  assert.ok(panelData.sessions.some(row=>row.key === finished.key));
  await receive({action:'setPinned',key:'claude/other',provider:'claude',value:true});
  assert.equal(panelData.sessions[0].key,'claude/other');
  assert.ok(panelData.sessions[0].pinned);
  await receive({action:'setAttentionOnly',value:true});
  assert.deepEqual(panelData.sessions,[]);
  await receive({action:'setAttentionOnly',value:false});
  await receive({action:'moveProvider',provider:'codex',direction:'up'});
  assert.equal(panelData.preferences.sort,'manual');
  assert.equal(panelData.preferences.providerOrder[0],'codex');
  await receive({action:'setSort',value:'recent'});
  assert.equal(panelData.preferences.providerOrder[0],'claude');
  await receive({action:'setSort',value:'manual'});
  assert.equal(panelData.preferences.providerOrder[0],'codex');
  await run('switchSession');
  assert.ok(!picked.some(item=>item.key==='claude/foreign'));
  assert.deepEqual(opened,['claude/review','claude/review','claude/other']);
  assert.ok(picked[0].detail.includes('fixture-model'));
  await run('previousSession');
  await run('previousSession');
  assert.deepEqual(opened.slice(-2),['claude/review','claude/other']);
  assert.ok(preferences.get('sessionLayout.v1').pins.includes('claude/other'));
  await run('dismiss', finished);
  assert.equal(panelData.sessions.filter(row => row.status === 'done').length, 0);
  await update('UserPromptSubmit', 'review');
  await run('refresh');
  assert.match(status.text, /진행 2/);
  await update('Stop','review'); await run('refresh');
  const first = panelData.sessions.find(r=>r.key === finished.key);
  let opening, openedGate;
  const entered = new Promise(resolve=>{ opening = resolve; });
  openGate = {enter:opening,promise:new Promise(resolve=>{ openedGate=resolve; })};
  const jump = run('open', first);
  await entered;
  await update('UserPromptSubmit','review');
  await update('Stop','review');
  await run('refresh');
  openedGate();
  await jump;
  const second = panelData.sessions.find(r=>r.key === finished.key);
  assert.ok(second.replyUnread && second.replyAt > first.replyAt, 'a reply arriving during navigation remains unread');
  await receive({action:'markSeen',provider:'claude',key:second.key,replyAt:second.replyAt});
  assert.equal(panelData.unreadCount,0);
  await update('PermissionRequest','approve-next');
  await record(directory,normalize('claude','PreToolUse',{...fixture('answer-next'),tool_name:'AskUserQuestion'}));
  await run('refresh');
  await run('nextAttention');
  await run('nextAttention');
  await run('nextAttention');
  assert.deepEqual(opened.slice(-3),['claude/answer-next','claude/approve-next','claude/answer-next']);
  assert.equal(panelData.attentionCount,2,'opening a request cannot settle it');
  assert.equal(status.command, 'agentSessionMonitor.sessions.focus');
  assert.equal(quotaCalls.length, 0, 'disabled account lookups must not launch a provider');
  assert.equal(panelData.quotas.codex.status, 'unavailable');
  vscode.window.state.focused = false;
  subscription = true;
  configurationChanged({affectsConfiguration:key => key.endsWith('subscriptionUsage')});
  await receive({action:'refreshQuota',provider:'claude'});
  assert.equal(quotaCalls.length, 0, 'an unfocused window must not query the account');
  vscode.window.state.focused = true;
  focusChanged(vscode.window.state);
  for (let n=0; n<100 && panelData.quotas.agy.status !== 'ready'; n++) await wait(10);
  assert.deepEqual([...quotaCalls].sort(), ['agy','claude','codex']);
  assert.equal(panelData.quotas.agy.windows[0].percent,14);
  await receive({action:'refreshQuota',provider:'agy'});
  assert.equal(quotaCalls.length,3, 'rapid refreshes are shared with the cached first load');
  let enter, release;
  const scanning = new Promise(resolve=>{enter = resolve;});
  pendingRead = {enter, promise:new Promise(resolve=>{release = resolve;})};
  const prior = run('refresh');
  await scanning;
  vscode.workspace.workspaceFolders = [folder('/repo-backup')];
  foldersChanged();
  assert.deepEqual(panelData.sessions,[], 'old rows clear immediately on a folder switch');
  release();
  await prior;
  assert.deepEqual(panelData.sessions.map(x=>x.key), ['claude/foreign']);
  assert.equal(panelData.attentionCount,1);
  vscode.workspace.workspaceFolders = [];
  foldersChanged();
  await run('refresh');
  assert.equal(panelData.hasWorkspace,false);
  assert.deepEqual(panelData.sessions,[]);
  assert.equal(view.badge,undefined);
});

function loadExtension(vscode, stubs) {
  const file = require.resolve('../src/extension.cjs');
  delete require.cache[file];
  const original = Module._load;
  try {
    Module._load = function (id, ...args) {
      if (id === 'vscode') return vscode;
      if (Object.hasOwn(stubs, id)) return typeof stubs[id] === 'function' ? stubs[id](original.call(this, id, ...args)) : stubs[id];
      return original.call(this, id, ...args);
    };
    return require(file).activate;
  } finally { Module._load = original; }
}

test('connections, quiet work, other folders, away notifications, previews and multi-question answers', async t => {
  const { spawn } = require('node:child_process');
  const { createHash } = require('node:crypto');
  const { readSessions } = require('../src/model.cjs');
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-host-'));
  const storage = path.join(base, 'storage'), workspace = path.join(base, 'project');
  const api = path.join(base, 'api'), gone = path.join(base, 'gone');
  await Promise.all([storage, workspace, api, gone].map(dir => fs.mkdir(dir, {recursive:true})));
  const config = { notifications:'attentionAndDone', awayNotifications:true, otherFolders:true, inlineActionSeconds:45, inlineActions:true, subscriptionUsage:false };
  const installed = new Set(['anthropic.claude-code', 'openai.chatgpt']);
  const hookStates = { claude:'connected', codex:'missing', agy:'missing' };
  const messages = { info:[], warning:[], error:[] }, picks = [], executed = [], exec = [], configured = [], runtimeCalls = [];
  const saved = new Map(), workspaceStore = new Map(), commands = new Map();
  let infoAnswer = () => undefined, pick = items => items.filter(item => item.picked);
  let panelData, view, receive, configurationChanged;
  const dispose = () => {};
  const status = { show: dispose, dispose };
  const vscode = {
    window: {
      state: { focused: true },
      showInformationMessage: async (message, ...actions) => { messages.info.push(message); return infoAnswer(message, actions); },
      showWarningMessage: async message => { messages.warning.push(message); },
      showErrorMessage: async message => { messages.error.push(message); },
      showQuickPick: async (items, options) => { picks.push({items, options}); return pick(items, options); },
      onDidChangeWindowState: () => ({dispose}),
      registerWebviewViewProvider(id, provider) {
        view = { visible:true, onDidDispose: () => ({dispose}), onDidChangeVisibility: () => ({dispose}), webview: {
          cspSource:'unit.invalid', asWebviewUri: value => value,
          postMessage(message) { if (message.type === 'state') panelData = message; return Promise.resolve(true); },
          onDidReceiveMessage(fn) { receive = fn; return { dispose }; },
        } };
        provider.resolveWebviewView(view);
        receive({type:'ready'});
        return {dispose};
      },
      createStatusBarItem: () => status,
    },
    extensions: { getExtension: id => installed.has(id) ? { extensionPath:'/nonexistent/' + id, extensionUri:'vendor:' + id } : undefined },
    Uri: { joinPath: (...pieces) => pieces.join('/'), file: fsPath => ({scheme:'file', fsPath}) },
    workspace: { workspaceFolders:[{name:'project', uri:{scheme:'file', fsPath:workspace}}], isTrusted:true,
      onDidChangeWorkspaceFolders: () => ({dispose}), onDidChangeConfiguration: cb => { configurationChanged = cb; return {dispose}; },
      getConfiguration: () => ({ get: (name, fallback) => Object.hasOwn(config, name) ? config[name] : fallback }) },
    commands: { registerCommand(name, cb) { commands.set(name, cb); return {dispose}; }, executeCommand: async (...args) => { executed.push(args); } },
    ThemeColor: class { constructor(id) { this.id = id; } },
    StatusBarAlignment: { Left: 1 },
  };
  const activate = loadExtension(vscode, {
    './children.cjs': { createChildReader: () => async rows => rows },
    './navigation.cjs': { openSession: async () => true, startSession: async () => true, openUsage: async () => true },
    './quota.cjs': { createQuotaReader: () => async () => ({status:'unavailable', windows:[]}) },
    './metadata.cjs': { createRecentReader: () => async () => [],
      createMetadataReader: () => async rows => ({sessions:new Map(rows.map(r => [r.key, {title:'대화 ' + r.sessionId}])), providerUsage:{}}) },
    './setup.cjs': { hookStatus: async ({provider}) => hookStates[provider], configureHooks: async options => {
      configured.push(options);
      if (options.provider === 'agy' && options.action === 'install') throw new Error('설정 파일이 잠겨 있습니다.');
      return {changed:true, ...(options.provider === 'codex' && options.action === 'install' && {notice:'Codex CLI의 /hooks에서 추가된 훅을 검토하고 신뢰한 뒤 사용하세요.'})};
    } },
    './runtime.cjs': { nodeExecutable: async () => process.execPath, prepareRuntime: async root => {
      runtimeCalls.push(root);
      return {hookPath:path.join(root, 'runtime', 'hook.cjs'), stateDir:path.join(root, 'sessions')};
    } },
    './notify.cjs': real => ({...real, createNotifier: options => real.createNotifier({...options, platform:'darwin',
      delays:{local:30, remote:60}, execFile: (file, args, _options, done) => { exec.push({file, args}); done(null); }})}),
  });
  const context = {
    globalStorageUri: { fsPath: storage }, extensionUri: '/fixture', extensionPath: path.resolve(__dirname, '..'), subscriptions: [],
    workspaceState: { get: key => workspaceStore.get(key), update: async (key, value) => { workspaceStore.set(key, value); } },
    globalState: { get: key => saved.get(key), update: async (key, value) => { saved.set(key, value); } },
  };
  t.after(async () => {
    for (const item of context.subscriptions) item.dispose();
    await wait(50);
    await fs.rm(base, { recursive: true, force: true, maxRetries: 3 });
  });
  const run = (name, ...args) => commands.get('agentSessionMonitor.' + name)(...args);
  const until = async (check, label, poke) => {
    for (let i = 0; i < 300; i++) {
      if (await check()) return;
      if (poke) await poke();
      await wait(10);
    }
    throw new Error('Timed out: ' + label);
  };
  const directory = path.join(storage, 'sessions');
  const hookEvent = (provider, name, input) => record(directory, normalize(provider, name, input));
  const claude = (id, name, extra = {}) => hookEvent('claude', name, {session_id:id, cwd:workspace, ...extra});
  const rowOf = key => panelData.sessions.find(row => row.key === key);
  const marker = id => path.join(storage, 'notifications', createHash('sha256').update(id).digest('hex'));
  // A claim names the change from the row alone: its event, then the open requests it waits on.
  const claimOf = async key => {
    const row = (await readSessions(directory)).find(item => item.key === key);
    const refs = [...new Set(row.pendingRefs || [])].sort();
    return [row.key, row.status, row.waitSince || row.updatedAt].join('|') + (refs.length ? '|' + refs.join(',') : '');
  };
  const spawnHook = (provider, name, input) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve(__dirname, '../src/hook.cjs'), provider, name, directory],
      {stdio:['pipe','pipe','pipe'], env:{...process.env, CLAUDE_CODE_ENTRYPOINT:'claude-vscode'}});
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.once('error', reject);
    child.once('close', code => code || stderr ? reject(new Error(stderr)) : resolve(stdout));
    child.stdin.end(JSON.stringify(input));
  });

  // Connection state: hooks read once at activation, the deployed hook refreshed because one tool is connected.
  await activate(context);
  await until(() => panelData?.connections?.claude, 'first connection check');
  assert.deepEqual(panelData.connections, {claude:'connected', codex:'missing', agy:'absent'});
  assert.deepEqual(runtimeCalls, [storage]);
  assert.deepEqual(panelData.elsewhere, []);
  await receive({action:'hideConnect', provider:'codex'});
  assert.equal(saved.get('connectMuted:codex'), true);
  assert.equal(panelData.connections.codex, 'muted');
  hookStates.codex = 'update';
  receive({type:'ready'});
  await until(() => panelData.connections.codex === 'update', 'a visible panel reads the settings again');
  assert.equal(saved.get('connectMuted:codex'), undefined, 'a connected tool prompts again if it is ever removed');

  // One palette run connects several tools and reports once, including a failure.
  pick = items => items.filter(item => item.picked || item.id === 'agy');
  await run('connect');
  assert.equal(picks.at(-1).options.canPickMany, true);
  assert.deepEqual(picks.at(-1).items.map(({id, description, picked}) => [id, description, picked]),
    [['claude','연결됨',false], ['codex','업데이트 필요',true], ['agy','연결 안 됨 · VS Code 확장 없음',false]]);
  assert.deepEqual(configured.map(({action, provider}) => [action, provider]), [['install','codex'], ['install','agy']]);
  assert.deepEqual([configured[0].nodePath, configured[0].hookPath], [process.execPath, path.join(storage, 'runtime', 'hook.cjs')]);
  assert.equal(messages.error.at(-1), 'Codex 연결 설정을 저장했습니다. · Codex CLI의 /hooks에서 추가된 훅을 검토하고 신뢰한 뒤 사용하세요. · ' +
    'Antigravity 연결 설정을 바꾸지 못했습니다. 설정 파일이 잠겨 있습니다.');
  configured.length = 0;
  pick = items => items.filter(item => item.picked);
  await run('disconnect');
  assert.deepEqual(picks.at(-1).items.map(item => item.picked), [true, true, false]);
  assert.deepEqual(configured.map(({action, provider}) => [action, provider]), [['remove','claude'], ['remove','codex']]);
  assert.equal(messages.info.at(-1), 'Claude Code, Codex 상태 훅 연결을 해제했습니다.');
  configured.length = 0;
  pick = () => undefined;
  await run('connect');
  assert.deepEqual(configured, [], 'a dismissed picker changes nothing');
  await receive({action:'connect', provider:'codex'});
  assert.equal(messages.info.at(-1), 'Codex · 연결 설정을 저장했습니다. · Codex CLI의 /hooks에서 추가된 훅을 검토하고 신뢰한 뒤 사용하세요.');

  // A turn without any signal for a while is quiet: ranked after live work and not counted as progress.
  const now = Date.now();
  await fs.writeFile(path.join(directory, 'f'.repeat(64) + '.json'), JSON.stringify({provider:'claude', sessionId:'ghost', cwd:workspace,
    status:'working', updatedAt:now - 20 * 60000, workSince:now - 25 * 60000}));
  await claude('live', 'UserPromptSubmit', {prompt_id:'p1'});
  await run('refresh');
  assert.deepEqual([rowOf('claude/ghost').quiet, rowOf('claude/ghost').signalAt], [true, now - 20 * 60000]);
  assert.equal(rowOf('claude/live').quiet, undefined);
  assert.ok(panelData.sessions.indexOf(rowOf('claude/live')) < panelData.sessions.indexOf(rowOf('claude/ghost')));
  assert.match(status.text, /진행 1(?!\d)/);
  assert.equal(status.backgroundColor, undefined);
  await claude('asking', 'PermissionRequest', {tool_name:'Bash', tool_input:{command:'npm test'}});
  await run('refresh');
  assert.equal(status.backgroundColor?.id, 'statusBarItem.warningBackground');
  await until(() => messages.info.includes('대화 asking · 승인 대기'), 'a focused window keeps its toast');
  await claude('broken', 'StopFailure');
  await claude('asking', 'PostToolUse', {tool_name:'Bash', tool_input:{command:'npm test'}});
  await run('refresh');
  assert.equal(rowOf('claude/broken').status, 'error');
  assert.equal(status.backgroundColor, undefined, 'an error alone does not colour the status bar');

  // Requests waiting in a folder this window does not show.
  infoAnswer = (_message, actions) => actions.includes('폴더 열기') ? '폴더 열기' : undefined;
  await hookEvent('claude', 'PermissionRequest', {session_id:'api-approval', cwd:api, tool_name:'Bash', tool_input:{command:'deploy'}});
  await hookEvent('claude', 'PreToolUse', {session_id:'api-question', cwd:api, tool_name:'AskUserQuestion', tool_input:{questions:[]}});
  await run('refresh');
  assert.deepEqual(panelData.elsewhere, [{cwd:api, folder:'api', input:1, approval:1}]);
  assert.match(status.text, /다른 폴더 2/);
  assert.ok(!panelData.sessions.some(row => row.key.startsWith('claude/api-')));
  assert.equal(view.badge.value, 1, 'the badge counts only this workspace');
  await until(() => executed.length, 'the toast action opens that folder');
  assert.ok(messages.info.includes('다른 폴더 · api · 답변 대기\n다른 폴더 · api · 승인 대기'));
  assert.deepEqual(executed, [['vscode.openFolder', {scheme:'file', fsPath:api}, {forceNewWindow:true}]]);
  infoAnswer = () => undefined;
  executed.length = 0;
  await receive({action:'openFolder', cwd:api});
  await receive({action:'openFolder', cwd:workspace});
  assert.deepEqual(executed, [['vscode.openFolder', {scheme:'file', fsPath:api}, {forceNewWindow:true}]]);
  await hookEvent('codex', 'PermissionRequest', {session_id:'gone-1', cwd:gone, turn_id:'t', tool_name:'Bash', tool_input:{command:'x'}});
  await run('refresh');
  assert.deepEqual(panelData.elsewhere.map(item => item.folder), ['api', 'gone']);
  await fs.rm(gone, {recursive:true});
  await receive({action:'openFolder', cwd:gone});
  assert.equal(messages.warning.at(-1), '작업 폴더를 열 수 없습니다. 폴더가 아직 해당 경로에 있는지 확인해 주세요.');
  config.otherFolders = false;
  configurationChanged({affectsConfiguration: key => key === 'agentSessionMonitor.otherFolders'});
  await until(() => !panelData.elsewhere.length, 'the setting hides other folders');
  assert.doesNotMatch(status.text, /다른 폴더/);
  await hookEvent('claude', 'PermissionRequest', {session_id:'api-hidden', cwd:api, tool_name:'Bash', tool_input:{command:'hidden'}});
  await run('refresh');
  const toasts = messages.info.length;
  config.otherFolders = true;
  configurationChanged({affectsConfiguration: key => key === 'agentSessionMonitor.otherFolders'});
  await until(() => panelData.elsewhere[0]?.approval === 2, 'shown again', () => run('refresh'));
  await wait(100);
  assert.equal(messages.info.length, toasts, 'turning the list back on does not announce old requests');
  assert.doesNotMatch(status.tooltip, /읽지 못했습니다/);

  // An unfocused window raises a system notification after a pause, only for what it can claim.
  vscode.window.state.focused = false;
  await claude('away', 'PermissionRequest', {tool_name:'Read', tool_input:{file_path:'/a'}});
  await run('refresh');
  await until(() => exec.length === 1, 'system notification');
  assert.equal(exec[0].file, '/usr/bin/osascript');
  assert.deepEqual(exec[0].args.slice(-4), ['--', '대화 away · 승인 대기', 'Claude Code · 승인 대기', 'project']);
  assert.equal(messages.info.length, toasts, 'no toast in an unfocused window');
  await claude('claimed', 'PermissionRequest', {tool_name:'Read', tool_input:{file_path:'/b'}});
  await fs.writeFile(marker(await claimOf('claude/claimed')), '', {flag:'wx'});
  await run('refresh');
  await wait(150);
  assert.equal(exec.length, 1, 'another window already announced it');
  config.awayNotifications = false;
  await claude('unseen', 'PermissionRequest', {tool_name:'Read', tool_input:{file_path:'/c'}});
  await run('refresh');
  await wait(150);
  assert.equal(exec.length, 1);
  await assert.rejects(fs.stat(marker(await claimOf('claude/unseen'))), {code:'ENOENT'},
    'a window that will not show the alert leaves it to the others');
  config.awayNotifications = true;
  await hookEvent('claude', 'PermissionRequest', {session_id:'api-away', cwd:api, tool_name:'Bash', tool_input:{command:'ship'}});
  await run('refresh');
  await until(() => exec.length === 2, 'another folder while away');
  assert.deepEqual(exec[1].args.slice(-4), ['--', 'api · 승인 대기', 'Claude Code · 승인 대기', 'api · 다른 폴더']);
  await Promise.all(['m1', 'm2', 'm3', 'm4'].map(id => claude(id, 'PermissionRequest', {tool_name:'Read', tool_input:{file_path:'/' + id}})));
  await run('refresh');
  await until(() => exec.length === 3, 'several changes in one notification');
  // Four parallel writes can land a millisecond apart in any order, so only the oldest three are named, in some order.
  const lines = exec[2].args.at(-3).split('\n');
  assert.equal(lines.length, 4);
  assert.equal(lines[3], '외 1건');
  assert.equal(new Set(lines.slice(0, 3)).size, 3);
  assert.ok(lines.slice(0, 3).every(line => /^대화 m[1-4] · 승인 대기$/.test(line)), lines.join(' / '));
  vscode.window.state.focused = true;

  // All replies read at once.
  for (const id of ['r1', 'r2']) {
    await claude(id, 'UserPromptSubmit', {prompt_id:'p'});
    await claude(id, 'Stop', {prompt_id:'p', last_assistant_message:'완료'});
  }
  await run('refresh');
  assert.equal(panelData.unreadCount, 2);
  await receive({action:'markAllSeen'});
  assert.equal(panelData.unreadCount, 0);
  assert.ok(workspaceStore.get('replySeen:claude/r1') && workspaceStore.get('replySeen:claude/r2'));
  await run('markAllSeen');
  assert.equal(messages.info.at(-1), '현재 폴더에 읽지 않은 새 응답이 없습니다.');

  // A request this window cannot answer shows its content while it waits, then the content goes.
  const bash = {session_id:'codex-wait', cwd:workspace, turn_id:'t1', tool_name:'Bash', tool_input:{command:'npm test'}};
  assert.equal(await spawnHook('codex', 'PermissionRequest', bash), '');
  await until(() => rowOf('codex/codex-wait')?.preview, 'preview', () => run('refresh'));
  assert.deepEqual(rowOf('codex/codex-wait').preview, {tool:'Bash', detail:JSON.stringify(bash.tool_input, null, 2)});
  assert.equal(await spawnHook('codex', 'PostToolUse', bash), '');
  await run('refresh');
  assert.deepEqual([rowOf('codex/codex-wait').status, rowOf('codex/codex-wait').preview], ['working', undefined]);

  // Several questions answered here, with the visible expiry of the inline window.
  const questions = [{question:'어디에 배치할까요?', header:'배치', options:[{label:'왼쪽'}, {label:'오른쪽'}]},
    {question:'함께 바꿀 항목', multiSelect:true, options:[{label:'여백'}, {label:'글꼴'}, {label:'색상'}]}];
  const started = Date.now();
  const answered = spawnHook('claude', 'PermissionRequest', {session_id:'ask-1', hook_event_name:'PermissionRequest', cwd:workspace,
    tool_name:'AskUserQuestion', tool_input:{questions}});
  await until(() => rowOf('claude/ask-1')?.action, 'inline request', () => run('refresh'));
  const action = rowOf('claude/ask-1').action;
  assert.deepEqual(action.questions.map(q => [q.header, q.multiSelect, q.choices.length]), [['배치', false, 2], ['', true, 3]]);
  assert.ok(action.expiresAt >= started + 45000 && action.expiresAt <= Date.now() + 45000);
  await receive({action:'answer', provider:'claude', key:'claude/ask-1', token:action.token, answers:[[1], [2, 0]]});
  assert.deepEqual(JSON.parse(await answered).hookSpecificOutput.decision.updatedInput,
    {questions, answers:{'어디에 배치할까요?':'오른쪽', '함께 바꿀 항목':'여백, 색상'}});
  config.inlineActionSeconds = 120;
  configurationChanged({affectsConfiguration: key => key === 'agentSessionMonitor.inlineActionSeconds'});
  const registry = path.join(storage, 'approval-windows');
  const windowMs = async () => {
    const [name] = (await fs.readdir(registry)).filter(entry => entry.endsWith('.json'));
    return JSON.parse(await fs.readFile(path.join(registry, name), 'utf8')).windowMs;
  };
  await until(async () => await windowMs() === 120000, 'the descriptor follows the setting');
});

test('a window that opens on existing waits lists them without announcing them', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-start-'));
  const storage = path.join(base, 'storage'), workspace = path.join(base, 'project'), other = path.join(base, 'other');
  await Promise.all([storage, workspace, other].map(dir => fs.mkdir(dir, {recursive:true})));
  const directory = path.join(storage, 'sessions');
  const wait4 = (id, cwd) => record(directory, normalize('claude', 'PermissionRequest', {session_id:id, cwd, tool_name:'Read', tool_input:{file_path:'/' + id}}));
  await wait4('earlier', workspace);
  await wait4('elsewhere', other);
  const toasts = [], exec = [], commands = new Map();
  let panelData, receive;
  const dispose = () => {};
  const vscode = {
    window: { state:{focused:true}, showInformationMessage: async message => { toasts.push(message); },
      onDidChangeWindowState: () => ({dispose}), createStatusBarItem: () => ({show:dispose, dispose}),
      registerWebviewViewProvider(id, provider) {
        provider.resolveWebviewView({ visible:true, onDidDispose: () => ({dispose}), onDidChangeVisibility: () => ({dispose}), webview: {
          cspSource:'unit.invalid', asWebviewUri: value => value, onDidReceiveMessage(fn) { receive = fn; return {dispose}; },
          postMessage(message) { if (message.type === 'state') panelData = message; return Promise.resolve(true); } } });
        receive({type:'ready'});
        return {dispose};
      } },
    extensions:{getExtension:() => undefined}, Uri:{joinPath:(...pieces) => pieces.join('/')},
    workspace:{ workspaceFolders:[{name:'project', uri:{scheme:'file', fsPath:workspace}}], isTrusted:true,
      onDidChangeWorkspaceFolders: () => ({dispose}), onDidChangeConfiguration: () => ({dispose}),
      getConfiguration: () => ({ get: (name, fallback) => name === 'subscriptionUsage' ? false : fallback }) },
    commands:{ registerCommand(name, cb) { commands.set(name, cb); return {dispose}; } },
    ThemeColor: class { constructor(id) { this.id = id; } }, StatusBarAlignment:{Left:1},
  };
  const activate = loadExtension(vscode, {
    './children.cjs': { createChildReader: () => async rows => rows },
    './quota.cjs': { createQuotaReader: () => async () => ({status:'unavailable', windows:[]}) },
    './metadata.cjs': { createRecentReader: () => async () => [], createMetadataReader: () => async () => ({sessions:new Map(), providerUsage:{}}) },
    './setup.cjs': { hookStatus: async () => 'missing', configureHooks: async () => ({changed:false}) },
    './notify.cjs': real => ({...real, createNotifier: options => real.createNotifier({...options, platform:'darwin',
      delays:{local:10, remote:10}, execFile: (file, args, _options, done) => { exec.push(args); done(null); }})}),
  });
  const context = { globalStorageUri:{fsPath:storage}, extensionUri:'/fixture', extensionPath:path.resolve(__dirname, '..'), subscriptions:[],
    workspaceState:{get:() => undefined, update:async () => {}}, globalState:{get:() => undefined, update:async () => {}} };
  t.after(async () => {
    for (const item of context.subscriptions) item.dispose();
    await wait(50);
    await fs.rm(base, {recursive:true, force:true, maxRetries:3});
  });
  await activate(context);
  assert.deepEqual(panelData.sessions.map(row => row.key), ['claude/earlier']);
  assert.deepEqual(panelData.elsewhere.map(item => [item.folder, item.approval]), [['other', 1]]);
  vscode.window.state.focused = false;
  await commands.get('agentSessionMonitor.refresh')();
  await wait(100);
  assert.deepEqual([toasts, exec], [[], []], 'what was already waiting when the window opened is not announced');
  vscode.window.state.focused = true;
  await wait4('later', workspace);
  await commands.get('agentSessionMonitor.refresh')();
  for (let i = 0; i < 100 && !toasts.length; i++) await wait(10);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0], /later.* · 승인 대기/);
});

test('rows say what each session was asked, is doing and answered; keys decide only the open request', async t => {
  const { spawn } = require('node:child_process');
  const net = require('node:net');
  const crypto = require('node:crypto');
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-activity-'));
  const storage = path.join(base, 'storage'), workspace = path.join(base, 'project');
  await Promise.all([storage, workspace].map(dir => fs.mkdir(dir, {recursive:true})));
  const config = { subscriptionUsage:false, activityDetail:true };
  const posted = [], infos = [], contexts = [], commands = new Map(), saved = new Map();
  let receive, configurationChanged, trustGranted, hold;
  const dispose = () => {};
  const vscode = {
    window: { state:{focused:true}, showInformationMessage: async message => { infos.push(message); },
      showWarningMessage: async () => {}, showErrorMessage: async () => {}, onDidChangeWindowState: () => ({dispose}),
      createStatusBarItem: () => ({show:dispose, dispose}),
      registerWebviewViewProvider(id, provider) {
        provider.resolveWebviewView({ visible:true, onDidDispose: () => ({dispose}), onDidChangeVisibility: () => ({dispose}), webview: {
          cspSource:'unit.invalid', asWebviewUri: value => value, onDidReceiveMessage(fn) { receive = fn; return {dispose}; },
          postMessage(message) { posted.push(message); return Promise.resolve(true); } } });
        receive({type:'ready'});
        return {dispose};
      } },
    extensions:{getExtension:() => undefined}, Uri:{joinPath:(...pieces) => pieces.join('/')},
    workspace:{ workspaceFolders:[{name:'project', uri:{scheme:'file', fsPath:workspace}}], isTrusted:false,
      onDidChangeWorkspaceFolders: () => ({dispose}), onDidChangeConfiguration: cb => { configurationChanged = cb; return {dispose}; },
      onDidGrantWorkspaceTrust: cb => { trustGranted = cb; return {dispose}; },
      getConfiguration: () => ({ get: (name, fallback) => Object.hasOwn(config, name) ? config[name] : fallback }) },
    commands:{ registerCommand(name, cb) { commands.set(name, cb); return {dispose}; },
      executeCommand: async (...args) => { contexts.push(args); } },
    ThemeColor: class { constructor(id) { this.id = id; } }, StatusBarAlignment:{Left:1},
  };
  const activate = loadExtension(vscode, {
    // A scan can be held at this step, as a slow provider index would hold it.
    './children.cjs': { createChildReader: () => async rows => {
      if (hold) { const gate = hold; hold = undefined; gate.entered(); await gate.released; }
      return rows;
    } },
    './navigation.cjs': { openSession: async () => true, startSession: async () => true, openUsage: async () => true },
    './quota.cjs': { createQuotaReader: () => async () => ({status:'unavailable', windows:[]}) },
    './metadata.cjs': { createRecentReader: () => async () => [], createMetadataReader: () => async () => ({sessions:new Map(), providerUsage:{}}) },
    './setup.cjs': { hookStatus: async () => 'missing', configureHooks: async () => ({changed:false}) },
    './notify.cjs': real => ({...real, createNotifier: options => real.createNotifier({...options, platform:'test'})}),
  });
  const context = { globalStorageUri:{fsPath:storage}, extensionUri:'/fixture', extensionPath:path.resolve(__dirname, '..'), subscriptions:[],
    workspaceState:{get:() => undefined, update:async () => {}}, globalState:{get:key => saved.get(key), update:async (key, value) => { saved.set(key, value); }} };
  t.after(async () => {
    for (const item of context.subscriptions) item.dispose();
    await wait(50);
    await fs.rm(base, {recursive:true, force:true, maxRetries:3});
  });
  const run = (name, ...args) => commands.get('agentSessionMonitor.' + name)(...args);
  const states = () => posted.filter(message => message.type === 'state');
  const rowOf = key => states().at(-1)?.sessions.find(row => row.key === key);
  const until = async (check, label, poke) => {
    for (let i = 0; i < 300; i++) {
      if (await check()) return;
      if (poke) await poke();
      await wait(10);
    }
    throw new Error('Timed out: ' + label);
  };
  const directory = path.join(storage, 'sessions'), registry = path.join(storage, 'approval-windows');
  const descriptor = async () => JSON.parse(await fs.readFile(path.join(registry, (await fs.readdir(registry)).find(name => name.endsWith('.json'))), 'utf8'));
  const hook = (name, input) => new Promise((resolve, reject) => {
    const env = {...process.env};
    delete env.CLAUDE_CODE_ENTRYPOINT;
    const child = spawn(process.execPath, [path.resolve(__dirname, '../src/hook.cjs'), 'claude', name, directory], {env});
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.once('error', reject);
    child.once('close', code => code || stderr ? reject(new Error(stderr)) : resolve(stdout));
    child.stdin.end(JSON.stringify({session_id:'act-1', cwd:workspace, hook_event_name:name, ...input}));
  });
  // What a hook sends, sent directly: the window proves itself, then reads one line.
  const notify = async activity => {
    const { address, publicKey } = await descriptor();
    return new Promise(resolve => {
      const socket = net.createConnection(address);
      const nonce = crypto.randomUUID();
      let buffer = '';
      socket.on('connect', () => socket.write(JSON.stringify({nonce, cwd:workspace, purpose:'activity'}) + '\n'));
      socket.on('data', data => {
        buffer += data;
        if (!buffer.includes('\n')) return;
        const { proof } = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
        assert.ok(crypto.verify(null, Buffer.from(JSON.stringify(['hello', nonce])), publicKey, Buffer.from(proof, 'base64')));
        socket.end(JSON.stringify({activity:{version:2, key:'claude/act-1', provider:'claude', cwd:workspace, ...activity}}) + '\n');
      });
      socket.on('error', () => {});
      socket.on('close', resolve);
    });
  };
  await activate(context);

  // An untrusted folder asks for nothing; once trusted, it does.
  assert.equal((await descriptor()).activity, false);
  vscode.workspace.isTrusted = true;
  trustGranted();
  await until(async () => (await descriptor()).activity === true, 'trust advertises activity');

  // A turn from real hooks: its request, steps, plan progress, changed files and reply.
  assert.equal(await hook('UserPromptSubmit', {prompt:'결제 재시도 로직을 고쳐 줘'}), '');
  await until(() => rowOf('claude/act-1')?.prompt, 'prompt on the row', () => run('refresh'));
  assert.equal(await hook('PostToolUse', {tool_name:'Bash', tool_input:{command:'pnpm test --run'}}), '');
  await until(() => rowOf('claude/act-1')?.activity?.tool === 'Bash', 'first step');
  assert.equal(await hook('PostToolUse', {tool_name:'Edit', tool_input:{file_path:path.join(workspace, 'checkout', 'retry.ts'), old_string:'a', new_string:'b'}}), '');
  await until(() => rowOf('claude/act-1')?.changed === 1, 'changed file');
  assert.equal(await hook('PostToolUse', {tool_name:'TodoWrite', tool_input:{todos:[{content:'a', status:'completed'}, {content:'b', status:'pending'}]}}), '');
  await until(() => rowOf('claude/act-1')?.progress, 'plan progress');
  assert.equal(await hook('Stop', {last_assistant_message:'재시도를 세 번으로 제한했습니다.'}), '');
  await until(() => rowOf('claude/act-1')?.reply && rowOf('claude/act-1').status === 'done', 'reply', () => run('refresh'));
  const row = rowOf('claude/act-1');
  assert.equal(row.prompt, '결제 재시도 로직을 고쳐 줘');
  assert.deepEqual(row.steps.map(step => [step.tool, step.target]), [['TodoWrite', ''], ['Edit', 'checkout/retry.ts'], ['Bash', 'pnpm test --run']]);
  assert.deepEqual([row.activity.tool, row.progress, row.changed, row.reply], ['TodoWrite', {done:1, total:2}, 1, '재시도를 세 번으로 제한했습니다.']);
  assert.ok(Number.isSafeInteger(row.activity.at));

  // A burst of steps is drawn in a few renders, not one per step.
  const before = states().length;
  await Promise.all(Array.from({length:12}, (_, i) => notify({step:{tool:'Bash', target:'step ' + i}})));
  await until(() => rowOf('claude/act-1').steps.length === 8 && states().length > before, 'burst rendered');
  await wait(400);
  assert.ok(states().length - before <= 3, 'coalesced: ' + (states().length - before));
  // Anything else still renders at once and takes the newest step with it.
  await notify({step:{tool:'Read', target:'README.md'}});
  const now = states().length;
  await receive({action:'setSort', value:'recent'});
  assert.equal(states().length, now + 1);
  assert.equal(rowOf('claude/act-1').activity.target, 'README.md');

  // A session that leaves the list takes its activity with it, even while a scan is still running;
  // it returns with only what comes next.
  let release;
  const held = new Promise(resolve => { hold = {entered:resolve, released:new Promise(done => { release = done; })}; });
  const dismissing = receive({action:'dismiss', key:'claude/act-1', provider:'claude'});
  await held;
  await wait(20);
  await receive({action:'setSort', value:'priority'});
  assert.ok(rowOf('claude/act-1'), 'still listed until the scan completes');
  assert.deepEqual([rowOf('claude/act-1').prompt, rowOf('claude/act-1').reply, rowOf('claude/act-1').steps], [undefined, undefined, undefined]);
  release();
  await dismissing;
  await until(() => !rowOf('claude/act-1'), 'dismissed');
  assert.equal(await hook('UserPromptSubmit', {prompt:'테스트도 추가해 줘'}), '');
  await until(() => rowOf('claude/act-1')?.prompt === '테스트도 추가해 줘', 'back with its new request', () => run('refresh'));
  assert.deepEqual([rowOf('claude/act-1').reply, rowOf('claude/act-1').steps], [undefined, undefined]);

  // Off: nothing is advertised, held or shown, and nothing new is accepted. On again: it is.
  config.activityDetail = false;
  configurationChanged({affectsConfiguration: key => key === 'agentSessionMonitor.activityDetail'});
  assert.equal(rowOf('claude/act-1').prompt, undefined, 'cleared at once');
  await until(async () => (await descriptor()).activity === false, 'no longer advertised');
  await notify({step:{tool:'Bash', target:'while off'}});
  config.activityDetail = true;
  configurationChanged({affectsConfiguration: key => key === 'agentSessionMonitor.activityDetail'});
  await until(async () => (await descriptor()).activity === true, 'advertised again');
  assert.deepEqual([rowOf('claude/act-1').activity, rowOf('claude/act-1').prompt], [undefined, undefined],
    'what was held before is gone, and what arrived while off was not kept');
  await notify({step:{tool:'Bash', target:'back on'}});
  await until(() => rowOf('claude/act-1')?.activity?.target === 'back on', 'accepted again');

  // The keys ask the view to press the open request's own button, and say nothing themselves.
  const decides = () => posted.filter(message => message.type === 'decide');
  infos.length = 0;
  assert.equal(await run('allowOpenRequest'), false);
  assert.equal(await run('denyOpenRequest'), false);
  assert.deepEqual(decides(), [], 'no request on screen, nothing to press');
  receive({type:'request', kind:'approval'});
  assert.deepEqual(contexts.at(-1), ['setContext', 'agentSessionMonitor.openRequest', 'approval']);
  assert.equal(await run('allowOpenRequest'), true);
  assert.equal(await run('denyOpenRequest'), true);
  assert.deepEqual(decides(), [{type:'decide', action:'approve'}, {type:'decide', action:'deny'}]);
  assert.deepEqual(infos, []);
  // Nothing of it reached the disk.
  for (const name of await fs.readdir(directory)) assert.doesNotMatch(await fs.readFile(path.join(directory, name), 'utf8'), /재시도|pnpm|retry|step|README/);
});

test('native commands start a session of a chosen tool and arrange the list as the panel would', async t => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-commands-'));
  const started = [], picks = [], commands = new Map(), layout = new Map();
  let answer = () => undefined, panelData, receive;
  const dispose = () => {};
  const vscode = {
    window: { state:{focused:true}, showInformationMessage: async () => {}, showWarningMessage: async () => {},
      showQuickPick: async (items, options) => { picks.push({items, options}); return answer(items); },
      onDidChangeWindowState: () => ({dispose}), createStatusBarItem: () => ({show:dispose, dispose}),
      registerWebviewViewProvider(id, provider) {
        provider.resolveWebviewView({ visible:true, onDidDispose: () => ({dispose}), onDidChangeVisibility: () => ({dispose}), webview: {
          cspSource:'unit.invalid', asWebviewUri: value => value, onDidReceiveMessage(fn) { receive = fn; return {dispose}; },
          postMessage(message) { if (message.type === 'state') panelData = message; return Promise.resolve(true); } } });
        receive({type:'ready'});
        return {dispose};
      } },
    // Only Codex's own extension is installed in this window.
    extensions:{ getExtension: id => id === 'openai.chatgpt' ? {extensionPath:'/nonexistent', extensionUri:'vendor:codex'} : undefined },
    Uri:{joinPath:(...pieces) => pieces.join('/')},
    QuickPickItemKind:{ Separator:-1, Default:0 },
    workspace:{ workspaceFolders:[], isTrusted:true, onDidChangeWorkspaceFolders: () => ({dispose}), onDidChangeConfiguration: () => ({dispose}),
      getConfiguration: () => ({ get: (name, fallback) => name === 'subscriptionUsage' ? false : fallback }) },
    commands:{ registerCommand(name, cb) { commands.set(name, cb); return {dispose}; }, executeCommand: async () => {} },
    ThemeColor: class {}, StatusBarAlignment:{Left:1},
  };
  const activate = loadExtension(vscode, {
    './children.cjs': { createChildReader: () => async rows => rows },
    './navigation.cjs': { openSession: async () => true, openUsage: async () => true,
      startSession: async (_vscode, provider) => { started.push(provider); return true; } },
    './quota.cjs': { createQuotaReader: () => async () => ({status:'unavailable', windows:[]}) },
    './metadata.cjs': { createRecentReader: () => async () => [], createMetadataReader: () => async () => ({sessions:new Map(), providerUsage:{}}) },
    './setup.cjs': { hookStatus: async () => 'missing', configureHooks: async () => ({changed:false}) },
    './notify.cjs': real => ({...real, createNotifier: options => real.createNotifier({...options, platform:'test'})}),
  });
  const context = { globalStorageUri:{fsPath:storage}, extensionUri:'/fixture', extensionPath:path.resolve(__dirname, '..'), subscriptions:[],
    workspaceState:{get:key => layout.get(key), update:async (key, value) => { layout.set(key, value); }},
    globalState:{get:() => undefined, update:async () => {}} };
  t.after(async () => {
    for (const item of context.subscriptions) item.dispose();
    await wait(50);
    await fs.rm(storage, {recursive:true, force:true, maxRetries:3});
  });
  await activate(context);
  const run = (name, ...args) => commands.get('agentSessionMonitor.' + name)(...args);

  // A new session: installed tools first, the others marked, the pick starts the chosen tool.
  answer = items => items[0];
  assert.equal(await run('newSession'), true);
  assert.deepEqual(picks.at(-1).options, {title:'새 세션 시작'});
  assert.deepEqual(picks.at(-1).items.map(({id, label, description}) => [id, label, description]),
    [['codex', 'Codex', undefined], ['claude', 'Claude Code', '확장 없음'], ['agy', 'Antigravity', '확장 없음']]);
  assert.deepEqual(started, ['codex']);
  const shown = picks.length;
  await run('newSession', 'agy');
  assert.equal(picks.length, shown, 'a named tool starts without asking');
  assert.deepEqual(started, ['codex', 'agy']);
  answer = () => undefined;
  assert.equal(await run('newSession', {fsPath:'/not/a/provider'}), undefined);
  assert.equal(picks.length, shown + 1, 'anything else asks');
  assert.deepEqual(started, ['codex', 'agy'], 'a dismissed pick starts nothing');

  // Arranging: the current choice is marked, a sort mode is set, a toggle flips; dismissing changes nothing.
  const labels = () => picks.at(-1).items.map(item => item.kind === -1 ? '—' : item.label);
  const choose = label => { answer = items => items.find(item => item.label.replace('$(check) ', '') === label); return run('arrange'); };
  await choose('도구별 · 최근 활동순');
  assert.deepEqual(picks.at(-1).options, {title:'정렬 및 필터'});
  assert.deepEqual(labels(), ['$(check) 전체 중요순', '도구별 · 최근 활동순', '도구별 · 확인 우선순', '도구별 · 직접 배치', '—', '확인 필요만 보기', '완료 숨기기']);
  assert.equal(panelData.preferences.sort, 'recent');
  assert.equal(layout.get('sessionLayout.v1').preferences.sort, 'recent', 'saved as the panel saves it');
  await choose('확인 필요만 보기');
  assert.deepEqual(labels().slice(0, 2), ['전체 중요순', '$(check) 도구별 · 최근 활동순']);
  assert.equal(panelData.preferences.attentionOnly, true);
  await choose('완료 숨기기');
  assert.deepEqual(labels().slice(5), ['$(check) 확인 필요만 보기', '완료 숨기기']);
  assert.deepEqual([panelData.preferences.attentionOnly, panelData.preferences.hideCompleted], [true, true]);
  // The panel changed it while the pick was open: the toggle flips what is set now.
  answer = items => { receive({action:'setAttentionOnly', value:false}); return items.find(item => item.field === 'attentionOnly'); };
  await run('arrange');
  assert.equal(panelData.preferences.attentionOnly, true);
  await choose('확인 필요만 보기');
  assert.equal(panelData.preferences.attentionOnly, false);
  const before = JSON.stringify(layout.get('sessionLayout.v1'));
  answer = () => undefined;
  await run('arrange');
  assert.equal(JSON.stringify(layout.get('sessionLayout.v1')), before);
  answer = items => items.find(item => item.kind === -1);
  await run('arrange');
  assert.equal(JSON.stringify(layout.get('sessionLayout.v1')), before, 'the separator is not a choice');
  assert.deepEqual([panelData.preferences.sort, panelData.preferences.hideCompleted], ['recent', true]);
});

test('openFile opens only verified workspace files and blocks paths outside the workspace', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-openfile-'));
  const storage = path.join(base, 'storage'), workspace = path.join(base, 'project'), outside = path.join(base, 'outside');
  await Promise.all([storage, path.join(workspace, 'src'), outside].map(dir => fs.mkdir(dir, { recursive: true })));
  const insideFile = path.join(workspace, 'src', 'retry.ts');
  const outsideFile = path.join(outside, 'secret.txt');
  const escapeLink = path.join(workspace, 'src', 'escape.txt');
  await fs.writeFile(insideFile, 'export const retries = 3;\n');
  await fs.writeFile(outsideFile, 'secret\n');
  await fs.symlink(outsideFile, escapeLink);
  const openedDocs = [], warnings = [], commands = new Map();
  let receive;
  const dispose = () => {};
  const vscode = {
    window: {
      state: { focused: true },
      showInformationMessage: async () => {},
      showWarningMessage: async msg => { warnings.push(msg); },
      showTextDocument: async uri => { openedDocs.push(uri.fsPath); },
      onDidChangeWindowState: () => ({ dispose }),
      createStatusBarItem: () => ({ show: dispose, dispose }),
      registerWebviewViewProvider(_id, provider) {
        provider.resolveWebviewView({
          visible: true, onDidDispose: () => ({ dispose }), onDidChangeVisibility: () => ({ dispose }),
          webview: {
            cspSource: 'unit.invalid', asWebviewUri: v => v,
            postMessage: () => Promise.resolve(true),
            onDidReceiveMessage(fn) { receive = fn; return { dispose }; },
          },
        });
        receive({ type: 'ready' });
        return { dispose };
      },
    },
    extensions: { getExtension: () => undefined },
    Uri: { joinPath: (...p) => p.join('/'), file: fsPath => ({ scheme: 'file', fsPath }) },
    workspace: {
      workspaceFolders: [{ name: 'project', uri: { scheme: 'file', fsPath: workspace } }],
      isTrusted: true,
      onDidChangeWorkspaceFolders: () => ({ dispose }),
      onDidChangeConfiguration: () => ({ dispose }),
      getConfiguration: () => ({ get: (name, fallback) => name === 'subscriptionUsage' ? false : fallback }),
    },
    commands: { registerCommand(name, cb) { commands.set(name, cb); return { dispose }; }, executeCommand: async () => {} },
    ThemeColor: class {}, StatusBarAlignment: { Left: 1 },
  };
  const activate = loadExtension(vscode, {
    './children.cjs': { createChildReader: () => async rows => rows },
    './quota.cjs': { createQuotaReader: () => async () => ({ status: 'unavailable', windows: [] }) },
    './metadata.cjs': { createRecentReader: () => async () => [], createMetadataReader: () => async () => ({ sessions: new Map(), providerUsage: {} }) },
    './setup.cjs': { hookStatus: async () => 'missing', configureHooks: async () => ({ changed: false }) },
    './notify.cjs': real => ({ ...real, createNotifier: options => real.createNotifier({ ...options, platform: 'test' }) }),
    './manual.cjs': () => ({
      listen: async () => ({
        forSession: () => undefined,
        previewFor: () => undefined,
        prunePreviews: () => {},
        activityFor: () => ({ changed: 2, changedFiles: ['src/retry.ts', 'src/escape.txt'] }),
        pruneActivity: () => {},
        forgetActivity: () => {},
        clearActivity: () => {},
        deferAll: () => {},
        deferSession: () => {},
        updateWindow: async () => {},
        dispose: () => {},
      }),
    }),
  });
  const context = {
    globalStorageUri: { fsPath: storage }, extensionUri: '/fixture', extensionPath: path.resolve(__dirname, '..'), subscriptions: [],
    workspaceState: { get: () => undefined, update: async () => {} },
    globalState: { get: () => undefined, update: async () => {} },
  };
  t.after(async () => {
    for (const item of context.subscriptions) item.dispose();
    await wait(20);
    await fs.rm(base, { recursive: true, force: true, maxRetries: 3 });
  });
  await record(path.join(storage, 'sessions'), normalize('claude', 'UserPromptSubmit', { session_id: 'f1', cwd: workspace }));
  await activate(context);
  await receive({ action: 'openFile', provider: 'claude', key: 'claude/f1', file: 'src/retry.ts' });
  assert.equal(openedDocs.length, 1);
  assert.equal(await fs.realpath(openedDocs[0]), await fs.realpath(insideFile));
  // Symlink pointing outside workspace must be rejected!
  await receive({ action: 'openFile', provider: 'claude', key: 'claude/f1', file: 'src/escape.txt' });
  assert.equal(openedDocs.length, 1);
  assert.match(warnings.at(-1), /파일을 열 수 없습니다/);
});

test('rate-limit errors can be acknowledged or dismissed even with silent subagents, and settled children clean up in bulk', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-lifecycle-'));
  const storage = path.join(base, 'storage'), workspace = path.join(base, 'project');
  await Promise.all([storage, workspace].map(dir => fs.mkdir(dir, { recursive: true })));
  const directory = path.join(storage, 'sessions');
  await fs.mkdir(directory, { recursive: true });
  const workspaceStore = new Map(), globalStore = new Map(), commands = new Map(), infos = [];
  let panelData, view, receive;
  const dispose = () => {};
  const status = { show: dispose, dispose };
  const vscode = {
    window: {
      state: { focused: true },
      showInformationMessage: async msg => { infos.push(msg); },
      showWarningMessage: async () => {},
      showErrorMessage: async () => {},
      onDidChangeWindowState: () => ({ dispose }),
      createStatusBarItem: () => status,
      registerWebviewViewProvider(_id, provider) {
        view = {
          visible: true, onDidDispose: () => ({ dispose }), onDidChangeVisibility: () => ({ dispose }),
          webview: {
            cspSource: 'unit.invalid', asWebviewUri: v => v,
            postMessage(msg) { if (msg.type === 'state') panelData = msg; return Promise.resolve(true); },
            onDidReceiveMessage(fn) { receive = fn; return { dispose }; },
          },
        };
        provider.resolveWebviewView(view);
        receive({ type: 'ready' });
        return { dispose };
      },
    },
    extensions: { getExtension: () => undefined },
    Uri: { joinPath: (...p) => p.join('/'), file: fsPath => ({ scheme: 'file', fsPath }) },
    workspace: {
      workspaceFolders: [{ name: 'project', uri: { scheme: 'file', fsPath: workspace } }],
      isTrusted: true,
      onDidChangeWorkspaceFolders: () => ({ dispose }),
      onDidChangeConfiguration: () => ({ dispose }),
      getConfiguration: () => ({ get: (name, fallback) => name === 'subscriptionUsage' ? false : fallback }),
    },
    commands: { registerCommand(name, cb) { commands.set(name, cb); return { dispose }; }, executeCommand: async () => {} },
    ThemeColor: class {}, StatusBarAlignment: { Left: 1 },
  };
  const activate = loadExtension(vscode, {
    './children.cjs': { createChildReader: () => async rows => rows },
    './navigation.cjs': { openSession: async () => true, startSession: async () => true, openUsage: async () => true },
    './quota.cjs': { createQuotaReader: () => async () => ({ status: 'unavailable', windows: [] }) },
    './metadata.cjs': { createRecentReader: () => async () => [], createMetadataReader: () => async () => ({ sessions: new Map(), providerUsage: {} }) },
    './setup.cjs': { hookStatus: async () => 'missing', configureHooks: async () => ({ changed: false }) },
    './notify.cjs': real => ({ ...real, createNotifier: options => real.createNotifier({ ...options, platform: 'test' }) }),
  });
  const context = {
    globalStorageUri: { fsPath: storage }, extensionUri: '/fixture', extensionPath: path.resolve(__dirname, '..'), subscriptions: [],
    workspaceState: { get: k => workspaceStore.get(k), update: async (k, v) => { workspaceStore.set(k, v); } },
    globalState: { get: k => globalStore.get(k), update: async (k, v) => { globalStore.set(k, v); } },
  };
  t.after(async () => {
    for (const item of context.subscriptions) item.dispose();
    await wait(20);
    await fs.rm(base, { recursive: true, force: true, maxRetries: 3 });
  });

  const now = Date.now();
  // Reproduce exact real-world state: Claude parent stopped on rate_limit with an abandoned working web-fetch child,
  // a completed child, and a separate quiet root session.
  const writeSnap = (name, body) => fs.writeFile(path.join(directory, name.repeat(64) + '.json'), JSON.stringify(body));
  await writeSnap('1', { provider: 'claude', sessionId: 'limited', cwd: workspace, status: 'error', errorReason: 'rate_limit', updatedAt: now - 2 * 60000 });
  await writeSnap('2', { provider: 'claude', sessionId: 'wf1', parentSessionId: 'limited', agentType: 'web-fetch', cwd: workspace, status: 'working', updatedAt: now - 5 * 60000 });
  await writeSnap('3', { provider: 'claude', sessionId: 'done1', parentSessionId: 'limited', agentType: 'Explore', cwd: workspace, status: 'done', updatedAt: now - 4 * 60000 });
  await writeSnap('4', { provider: 'claude', sessionId: 'quiet-root', cwd: workspace, status: 'working', updatedAt: now - 25 * 60000 });

  await activate(context);
  const run = (name, ...args) => commands.get('agentSessionMonitor.' + name)(...args);
  const rowOf = key => panelData.sessions.find(r => r.key === key);

  assert.equal(rowOf('claude/limited').errorReason, 'rate_limit');
  assert.equal(rowOf('claude/limited/wf1').quiet, true, 'child preceding parent error is immediately quiet');
  assert.equal(rowOf('claude/quiet-root').quiet, true);
  assert.equal(view.badge.value, 1);

  // 1. Acknowledge the rate-limit error without hiding the session so it stays visible to resume later.
  await receive({ action: 'ackError', provider: 'claude', key: 'claude/limited', updatedAt: rowOf('claude/limited').updatedAt });
  assert.equal(rowOf('claude/limited').errorAcked, true);
  assert.equal(panelData.attentionCount, 0);
  assert.equal(view.badge, undefined);
  assert.doesNotMatch(status.text, /오류/);

  // 2. Bulk cleanup settled/quiet subagents of the parent while keeping the parent visible.
  await receive({ action: 'dismissChildren', provider: 'claude', key: 'claude/limited' });
  assert.ok(rowOf('claude/limited'), 'parent remains visible');
  assert.equal(rowOf('claude/limited/wf1'), undefined, 'quiet subagent dismissed');
  assert.equal(rowOf('claude/limited/done1'), undefined, 'completed subagent dismissed');

  // 3. Dismiss a quiet root session directly and verify it stays hidden across refreshes.
  await receive({ action: 'dismiss', provider: 'claude', key: 'claude/quiet-root' });
  await run('refresh');
  assert.equal(rowOf('claude/quiet-root'), undefined);

  // 4. Even with a fresh abandoned web-fetch child, dismissing the errored parent succeeds and stays hidden.
  await writeSnap('5', { provider: 'claude', sessionId: 'wf2', parentSessionId: 'limited', agentType: 'web-fetch', cwd: workspace, status: 'working', updatedAt: now - 3 * 60000 });
  await run('refresh');
  assert.equal(rowOf('claude/limited/wf2').quiet, true);
  await receive({ action: 'dismiss', provider: 'claude', key: 'claude/limited' });
  await run('refresh');
  assert.equal(rowOf('claude/limited'), undefined);
  assert.equal(rowOf('claude/limited/wf2'), undefined);
  assert.equal(infos.filter(msg => /진행 중이거나 확인이 필요한 하위 작업/.test(msg)).length, 0);
});

test('native macOS notification carries logo + window-bound URI, UriHandler reveals session, duplicate toasts suppress, and denied permission guides user', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-macnotify-'));
  const storage = path.join(base, 'storage'), workspace = path.join(base, 'project');
  await Promise.all([storage, workspace].map(dir => fs.mkdir(dir, { recursive: true })));
  const directory = path.join(storage, 'sessions');
  const delivered = [], cleared = [], posted = [], executed = [], warnings = [], externalUris = [], infos = [];
  let receive, uriHandler, focusChanged, nextDeliverResult = { ok: true, permission: 'granted', backend: 'native' };
  const commands = new Map();
  const dispose = () => {};
  const vscode = {
    env: {
      uriScheme: 'vscode',
      appName: 'Visual Studio Code',
      asExternalUri: async uri => ({ toString: () => `${uri.scheme}://${uri.authority}${uri.path}?${uri.query ? uri.query + '&' : ''}windowId=42` }),
      openExternal: async uri => { externalUris.push(uri); return true; },
    },
    window: {
      state: { focused: false },
      createOutputChannel: () => ({ appendLine: () => {}, dispose }),
      registerUriHandler: handler => { uriHandler = handler; return { dispose }; },
      showInformationMessage: async msg => { infos.push(msg); },
      showWarningMessage: async (msg, ...actions) => { warnings.push({ msg, actions }); return actions[0]; },
      showErrorMessage: async () => {},
      onDidChangeWindowState: cb => { focusChanged = cb; return { dispose }; },
      createStatusBarItem: () => ({ show: dispose, dispose }),
      registerWebviewViewProvider(_id, provider) {
        provider.resolveWebviewView({
          visible: true, onDidDispose: () => ({ dispose }), onDidChangeVisibility: () => ({ dispose }),
          webview: {
            cspSource: 'unit.invalid', asWebviewUri: v => v,
            postMessage: msg => { posted.push(msg); return Promise.resolve(true); },
            onDidReceiveMessage: fn => { receive = fn; return { dispose }; },
          },
        });
        receive({ type: 'ready', view: 'sessions' });
        return { dispose };
      },
    },
    extensions: { getExtension: () => undefined },
    Uri: {
      joinPath: (...p) => p.join('/'),
      file: fsPath => ({ scheme: 'file', fsPath }),
      from: parts => ({ ...parts, toString: () => `${parts.scheme}://${parts.authority}${parts.path}${parts.query ? '?' + parts.query : ''}` }),
      parse: value => ({ raw: value }),
    },
    workspace: {
      workspaceFolders: [{ name: 'project', uri: { scheme: 'file', fsPath: workspace } }],
      getWorkspaceFolder: () => ({ name: 'project', uri: { scheme: 'file', fsPath: workspace } }),
      isTrusted: true,
      onDidChangeWorkspaceFolders: () => ({ dispose }),
      onDidChangeConfiguration: () => ({ dispose }),
      getConfiguration: () => ({ get: (name, fallback) => name === 'subscriptionUsage' ? false : fallback }),
    },
    commands: {
      registerCommand: (name, cb) => { commands.set(name, cb); return { dispose }; },
      executeCommand: async (...args) => { executed.push(args); },
    },
    ThemeColor: class {}, StatusBarAlignment: { Left: 1 },
  };
  let interruptedAt;
  const activate = loadExtension(vscode, {
    './children.cjs': { createChildReader: () => async rows => rows },
    './navigation.cjs': { openSession: async () => true, startSession: async () => true, openUsage: async () => true },
    './quota.cjs': { createQuotaReader: () => async () => ({ status: 'unavailable', windows: [] }) },
    './metadata.cjs': {
      createRecentReader: () => async () => [],
      createMetadataReader: () => async rows => ({
        sessions: new Map(rows.map(r => [r.key, { title: '세션 ' + r.sessionId, ...(interruptedAt && { interruptedAt }) }])),
        providerUsage: {},
      }),
    },
    './setup.cjs': { hookStatus: async () => 'connected', configureHooks: async () => ({ changed: false }) },
    './notify.cjs': real => ({
      ...real,
      createNotifier: options => {
        const claims = real.createClaims(options.directory);
        return {
          ...claims,
          delays: { local: 15, remote: 30 },
          deliver: async payload => { delivered.push(payload); return nextDeliverResult; },
          show: async payload => { delivered.push(payload); return nextDeliverResult.ok; },
          clear: async target => { cleared.push(target); return true; },
        };
      },
    }),
    './manual.cjs': () => ({
      listen: async () => ({
        forSession: () => undefined,
        previewFor: () => undefined,
        prunePreviews: () => {},
        activityFor: () => undefined,
        resolveFilePath: () => undefined,
        pruneActivity: () => {},
        forgetActivity: () => {},
        clearActivity: () => {},
        deferAll: () => {},
        deferSession: () => {},
        updateWindow: async () => {},
        dispose: () => {},
      }),
      findWindowForFolder: async () => undefined,
    }),
  });
  const context = {
    globalStorageUri: { fsPath: storage }, extensionUri: '/fixture', extensionPath: path.resolve(__dirname, '..'), subscriptions: [],
    workspaceState: { get: () => undefined, update: async () => {} },
    globalState: { get: () => undefined, update: async () => {} },
  };
  t.after(async () => {
    for (const item of context.subscriptions) item.dispose();
    await wait(30);
    await fs.rm(base, { recursive: true, force: true, maxRetries: 3 });
  });

  await activate(context);
  const run = (name, ...args) => commands.get('agentSessionMonitor.' + name)(...args);

  // 1. Away notification includes Claude fallback PNG logo, windowId-bound openUri, and workspaceRoot.
  await record(directory, normalize('claude', 'PermissionRequest', { session_id: 'n1', cwd: workspace, tool_name: 'Bash', tool_input: { command: 'npm test' } }));
  await run('refresh');
  for (let i = 0; i < 100 && !delivered.length; i++) await wait(10);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].title, 'Claude Code · 승인 대기');
  assert.equal(delivered[0].subtitle, 'project');
  assert.match(delivered[0].logoPath, /media\/icons\/claude\.png$/);
  assert.match(delivered[0].openUri, /^vscode:\/\/local-tools\.agent-session-monitor\/focus\?.*key=claude%2Fn1.*windowId=42/);
  assert.equal(delivered[0].workspaceRoot, workspace);
  assert.equal(delivered[0].interruptionLevel, 'timeSensitive');

  // 2. Clicking the macOS notification triggers UriHandler -> focuses sidebar & reveals exact session.
  await uriHandler.handleUri({ path: '/focus', query: 'key=claude%2Fn1&windowId=42' });
  assert.ok(executed.some(args => args[0] === 'agentSessionMonitor.sessions.focus'));
  assert.ok(posted.some(msg => msg.type === 'revealSession' && msg.key === 'claude/n1'));
  assert.ok(cleared.some(target => target.ids?.includes(delivered[0].id)));

  // 3. Consecutive approval on same session (new tool / waitSince) triggers another notification!
  await record(directory, normalize('claude', 'PostToolUse', { session_id: 'n1', cwd: workspace, tool_name: 'Bash', tool_input: { command: 'npm test' } }));
  await record(directory, normalize('claude', 'PermissionRequest', { session_id: 'n1', cwd: workspace, tool_name: 'Edit', tool_input: { file_path: '/x' } }));
  await run('refresh');
  for (let i = 0; i < 100 && delivered.length < 2; i++) await wait(10);
  assert.equal(delivered.length, 2, 'consecutive approval without intermediate scan must still notify');

  // 4. Denied permission releases claim and guides user to System Settings.
  nextDeliverResult = { ok: false, permission: 'denied', backend: 'native', error: 'denied' };
  await record(directory, normalize('codex', 'PermissionRequest', { session_id: 'c1', cwd: workspace, turn_id: 't1', tool_name: 'Bash', tool_input: { command: 'ls' } }));
  await run('refresh');
  for (let i = 0; i < 100 && !warnings.length; i++) await wait(10);
  assert.match(warnings[0].msg, /macOS 알림 권한/);
  assert.equal(externalUris[0].raw, 'x-apple.systempreferences:com.apple.Notifications-Settings.extension');

  // 5. Returning focus clears workspace notifications and suppresses duplicate toasts for visibly open requests.
  vscode.window.state.focused = true;
  focusChanged({ focused: true });
  assert.ok(cleared.some(target => target.group === workspace));
  receive({ type: 'request', kind: 'approval', key: 'codex/c2' });
  const beforeToasts = infos.length;
  await record(directory, normalize('codex', 'PermissionRequest', { session_id: 'c2', cwd: workspace, turn_id: 't2', tool_name: 'Bash', tool_input: { command: 'pwd' } }));
  await run('refresh');
  await wait(40);
  assert.equal(infos.length, beforeToasts, 'visibly open request in sidebar does not raise duplicate toast');

  // 6. Metadata interruptedAt immediately quiets a rejected Claude approval so it leaves attention count.
  interruptedAt = Date.now() + 5000;
  await run('refresh', true);
  const lastState = posted.filter(m => m.type === 'state').at(-1);
  assert.equal(lastState.sessions.find(r => r.key === 'claude/n1')?.quiet, true);

  // 7. testNotification command delivers test notification cleanly.
  nextDeliverResult = { ok: true, permission: 'granted', backend: 'native' };
  await run('testNotification');
  assert.match(delivered.at(-1).title, /알림 테스트/);
});

test('delayed soft wait preserves its in-memory preview, auto-promotes via softWaitTimer, notifies, and clears on PreInvocation', async t => {
  const { createHash } = require('node:crypto');
  const { announce, noticeFor } = require('../src/manual.cjs');
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-soft-view-'));
  const storage = path.join(base, 'storage'), workspace = path.join(base, 'project');
  await Promise.all([storage, workspace].map(dir => fs.mkdir(dir, { recursive: true })));
  const directory = path.join(storage, 'sessions');
  const posted = [], toasts = [], commands = new Map();
  let receive;
  const dispose = () => {};
  const vscode = {
    window: {
      state: { focused: true },
      showInformationMessage: async msg => { toasts.push(msg); },
      showWarningMessage: async () => {},
      showErrorMessage: async () => {},
      onDidChangeWindowState: () => ({ dispose }),
      createStatusBarItem: () => ({ show: dispose, dispose }),
      registerWebviewViewProvider(_id, provider) {
        provider.resolveWebviewView({
          visible: true, onDidDispose: () => ({ dispose }), onDidChangeVisibility: () => ({ dispose }),
          webview: {
            cspSource: 'unit.invalid', asWebviewUri: value => value,
            onDidReceiveMessage(fn) { receive = fn; return { dispose }; },
            postMessage(msg) { posted.push(msg); return Promise.resolve(true); },
          },
        });
        receive({ type: 'ready' });
        return { dispose };
      },
    },
    extensions: { getExtension: () => undefined },
    Uri: { joinPath: (...parts) => parts.join('/'), file: fsPath => ({ scheme: 'file', fsPath }) },
    workspace: {
      workspaceFolders: [{ name: 'project', uri: { scheme: 'file', fsPath: workspace } }],
      isTrusted: true,
      onDidChangeWorkspaceFolders: () => ({ dispose }),
      onDidChangeConfiguration: () => ({ dispose }),
      getConfiguration: () => ({ get: (name, fallback) => name === 'subscriptionUsage' ? false : fallback }),
    },
    commands: { registerCommand(name, cb) { commands.set(name, cb); return { dispose }; } },
    ThemeColor: class { constructor(id) { this.id = id; } },
    StatusBarAlignment: { Left: 1 },
  };
  const activate = loadExtension(vscode, {
    './children.cjs': { createChildReader: () => async rows => rows },
    './quota.cjs': { createQuotaReader: () => async () => ({ status: 'unavailable', windows: [] }) },
    './metadata.cjs': { createRecentReader: () => async () => [], createMetadataReader: () => async () => ({ sessions: new Map(), providerUsage: {} }) },
    './setup.cjs': { hookStatus: async () => 'missing', configureHooks: async () => ({ changed: false }) },
    './notify.cjs': real => ({ ...real, createNotifier: options => real.createNotifier({ ...options, platform: 'test' }) }),
  });
  const context = {
    globalStorageUri: { fsPath: storage }, extensionUri: '/fixture', extensionPath: path.resolve(__dirname, '..'), subscriptions: [],
    workspaceState: { get: () => undefined, update: async () => {} },
    globalState: { get: () => undefined, update: async () => {} },
  };
  t.after(async () => {
    for (const item of context.subscriptions) item.dispose();
    await wait(40);
    await fs.rm(base, { recursive: true, force: true, maxRetries: 3 });
  });
  await activate(context);
  const run = (name, ...args) => commands.get('agentSessionMonitor.' + name)(...args);
  const rowOf = key => posted.filter(m => m.type === 'state').at(-1)?.sessions.find(r => r.key === key);

  const payload = {
    conversationId: 'agy-vercel', workspacePaths: [workspace], stepIdx: 77,
    toolCall: { name: 'run_command', args: { CommandLine: 'vercel deploy --yes', BypassSandbox: true, WaitMsBeforeAsync: 10000, toolSummary: 'Deploy Vercel Preview' } },
  };
  const softEv = normalize('agy', 'PreToolUse', payload, { homeDir: base });
  const now = Date.now();
  const snapPath = path.join(directory, createHash('sha256').update('agy:agy-vercel').digest('hex') + '.json');
  await fs.writeFile(snapPath, JSON.stringify({
    provider: 'agy', sessionId: 'agy-vercel', cwd: workspace, workspacePaths: [workspace],
    status: 'working', updatedAt: now, workSince: now - 1000,
    pendingSoft: { [softEv.key]: { status: 'approval', since: now, after: now + 150 } },
  }));
  await announce(directory, noticeFor('agy', payload, softEv));
  await run('refresh');

  // Before maturity: stays 'working', internal softWait metadata is stripped from webview state, preview is NOT pruned.
  const initial = rowOf('agy/agy-vercel');
  assert.equal(initial?.status, 'working');
  assert.equal(initial?.softPendingRefs, undefined);
  assert.equal(initial?.nextSoftWaitAt, undefined);
  assert.equal(toasts.length, 0);

  // Without calling refresh manually, softWaitTimer wakes up, promotes to 'approval', attaches the preserved preview, and raises a toast!
  for (let i = 0; i < 150 && rowOf('agy/agy-vercel')?.status !== 'approval'; i++) await wait(15);
  const promoted = rowOf('agy/agy-vercel');
  assert.equal(promoted?.status, 'approval');
  assert.equal(promoted?.preview?.tool, 'run_command');
  assert.match(promoted?.preview?.detail || '', /Deploy Vercel Preview/);
  for (let i = 0; i < 50 && !toasts.length; i++) await wait(10);
  assert.match(toasts[0] || '', /승인 대기/);

  // Simulating "4 No" rejection (PreInvocation without PostToolUse) clears back to 'working'.
  await record(directory, normalize('agy', 'PreInvocation', { conversationId: 'agy-vercel', workspacePaths: [workspace] }));
  await run('refresh');
  assert.equal(rowOf('agy/agy-vercel')?.status, 'working');
  assert.equal(rowOf('agy/agy-vercel')?.preview, undefined);
});

test('integration: Codex untrusted/live runs, AGY rejected wait & CLI open preserve unread, Claude subagent dedup, Codex patch decline', async t => {
  const { createHash } = require('node:crypto');
  const { announce, noticeFor } = require('../src/manual.cjs');
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-7bugs-view-'));
  const storage = path.join(base, 'storage'), workspace = path.join(base, 'project');
  await Promise.all([storage, workspace].map(dir => fs.mkdir(dir, { recursive: true })));
  const directory = path.join(storage, 'sessions');
  const posted = [], infoMsgs = [], copied = [], commands = new Map(), executed = [];
  const status = { show() {}, dispose() {} };
  let receive, view, infoSelection;
  let codexHookState = 'untrusted';
  let liveCodexRuns = [];
  let codexResolvedMap = new Map();
  let agyResolvedMap = new Map();
  let agyAvailability = 'cli';
  const dispose = () => {};
  const vscode = {
    window: {
      state: { focused: true },
      showInformationMessage: async (msg, ...items) => {
        infoMsgs.push(msg);
        return items.includes(infoSelection) ? infoSelection : undefined;
      },
      showWarningMessage: async () => {},
      showErrorMessage: async () => {},
      onDidChangeWindowState: () => ({ dispose }),
      createStatusBarItem: () => status,
      registerWebviewViewProvider(_id, provider) {
        view = {
          visible: true, onDidDispose: () => ({ dispose }), onDidChangeVisibility: () => ({ dispose }),
          webview: {
            cspSource: 'unit.invalid', asWebviewUri: value => value,
            onDidReceiveMessage(fn) { receive = fn; return { dispose }; },
            postMessage(msg) { posted.push(msg); return Promise.resolve(true); },
          },
        };
        provider.resolveWebviewView(view);
        receive({ type: 'ready' });
        return { dispose };
      },
    },
    env: { clipboard: { writeText: async text => copied.push(text) } },
    extensions: { getExtension: () => ({ activate: async () => {} }) },
    Uri: { joinPath: (...parts) => parts.join('/'), file: fsPath => ({ scheme: 'file', fsPath }) },
    workspace: {
      workspaceFolders: [{ name: 'project', uri: { scheme: 'file', fsPath: workspace } }],
      isTrusted: true,
      getWorkspaceFolder: uri => uri.fsPath === workspace ? { name: 'project' } : undefined,
      onDidChangeWorkspaceFolders: () => ({ dispose }),
      onDidChangeConfiguration: () => ({ dispose }),
      getConfiguration: () => ({ get: (name, fallback) => name === 'subscriptionUsage' ? false : fallback }),
    },
    commands: {
      registerCommand(name, cb) { commands.set(name, cb); return { dispose }; },
      executeCommand: async (cmd, ...args) => {
        executed.push([cmd, ...args]);
        if (cmd === 'antigravity.openConversation') return true;
      },
    },
    ThemeColor: class { constructor(id) { this.id = id; } },
    StatusBarAlignment: { Left: 1 },
  };
  const { openSession: realOpenSession } = require('../src/navigation.cjs');
  const savedWorkspace = new Map();
  const activate = loadExtension(vscode, {
    './children.cjs': { createChildReader: () => async rows => rows },
    './quota.cjs': { createQuotaReader: () => async () => ({ status: 'unavailable', windows: [] }) },
    './metadata.cjs': {
      createRecentReader: () => async () => [
        { provider: 'codex', sessionId: 'cx-live', cwd: workspace, status: 'recent', updatedAt: Date.now() - 60000, key: 'codex/cx-live', title: '재개할 Codex' },
      ],
      createMetadataReader: () => async () => ({ sessions: new Map(), providerUsage: {} }),
    },
    './setup.cjs': { hookStatus: async ({ provider }) => provider === 'codex' ? codexHookState : 'connected', configureHooks: async () => ({ changed: false }) },
    './navigation.cjs': {
      openSession: (vs, target, opts) => realOpenSession(vs, target, { ...opts, probeAgyConversation: async () => agyAvailability }),
      startSession: async () => true,
      openUsage: async () => true,
    },
    './live-state.cjs': {
      readCodexLiveRuns: async () => ({ runs: liveCodexRuns, capability: 'available' }),
      readCodexResolvedPending: async () => codexResolvedMap,
      readAgyResolvedSteps: async () => agyResolvedMap,
      liveStateFingerprint: async () => '',
    },
    './notify.cjs': real => ({ ...real, createNotifier: options => real.createNotifier({ ...options, platform: 'test' }) }),
  });
  const context = {
    globalStorageUri: { fsPath: storage }, extensionUri: '/fixture', extensionPath: path.resolve(__dirname, '..'), subscriptions: [],
    workspaceState: { get: k => savedWorkspace.get(k), update: async (k, v) => { savedWorkspace.set(k, v); } },
    globalState: { get: () => undefined, update: async () => {} },
  };
  t.after(async () => {
    for (const item of context.subscriptions) item.dispose();
    await wait(40);
    await fs.rm(base, { recursive: true, force: true, maxRetries: 3 });
  });
  await activate(context);
  const run = (name, ...args) => commands.get('agentSessionMonitor.' + name)(...args);
  const latestState = () => posted.filter(m => m.type === 'state').at(-1);

  // Bug #1: Codex untrusted state surfaced, trustGuide copies /hooks, and hookless live run moves recent -> working -> recent.
  assert.equal(latestState().connections.codex, 'untrusted');
  infoSelection = '/hooks 복사';
  await receive({ action: 'trustGuide', provider: 'codex' });
  await wait(20);
  assert.deepEqual(copied, ['/hooks']);
  assert.equal(latestState().sessions.find(r => r.key === 'codex/cx-live')?.status, 'recent');

  liveCodexRuns = [{ provider: 'codex', sessionId: 'cx-live', key: 'codex/cx-live', cwd: workspace, status: 'working', turnId: 'turn-live', workSince: Date.now() - 1000, updatedAt: Date.now() }];
  await run('refresh');
  assert.equal(latestState().sessions.find(r => r.key === 'codex/cx-live')?.status, 'working');
  assert.match(status.text, /진행 1/);

  liveCodexRuns = [];
  await run('refresh');
  assert.equal(latestState().sessions.find(r => r.key === 'codex/cx-live')?.status, 'recent');

  // Bug #4: Claude subagent approval + parent generic Notification -> badge & attention count stay 1, then 2 on real parent approval.
  await record(directory, normalize('claude', 'UserPromptSubmit', { session_id: 'cl-root', cwd: workspace, prompt_id: 't1' }));
  await record(directory, normalize('claude', 'SubagentStart', { session_id: 'cl-root', agent_id: 'cl-sub', agent_type: 'Writer', cwd: workspace }));
  await record(directory, normalize('claude', 'PermissionRequest', { session_id: 'cl-root', agent_id: 'cl-sub', cwd: workspace, tool_name: 'Write', tool_input: { file_path: '/x' } }));
  await record(directory, normalize('claude', 'Notification', { session_id: 'cl-root', cwd: workspace, notification_type: 'permission_prompt' }));
  await run('refresh');
  assert.equal(latestState().attentionCount, 1);
  assert.equal(view.badge?.value, 1);
  assert.match(status.text, /승인 1/);
  assert.equal(latestState().sessions.find(r => r.key === 'claude/cl-root')?.status, 'working');
  assert.equal(latestState().sessions.find(r => r.key === 'claude/cl-root/cl-sub')?.status, 'approval');

  await record(directory, normalize('claude', 'PermissionRequest', { session_id: 'cl-root', cwd: workspace, tool_name: 'Bash', tool_input: { command: 'npm test' } }));
  await run('refresh');
  assert.equal(latestState().attentionCount, 2);
  assert.equal(view.badge?.value, 2);
  assert.match(status.text, /승인 2/);
  await record(directory, normalize('claude', 'Stop', { session_id: 'cl-root', cwd: workspace, prompt_id: 't1' }));
  await record(directory, normalize('claude', 'SubagentStop', { session_id: 'cl-root', agent_id: 'cl-sub', cwd: workspace }));

  // Bug #5: Codex declined apply_patch clears approval card & preview via readCodexResolvedPending.
  const patchPayload = { session_id: 'cx-decline', cwd: workspace, turn_id: 't1', tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Add File: qa-marker.txt\n+x\n*** End Patch' } };
  const cxWait = normalize('codex', 'PermissionRequest', patchPayload);
  await record(directory, cxWait);
  await announce(directory, noticeFor('codex', patchPayload, cxWait));
  await run('refresh');
  assert.equal(latestState().sessions.find(r => r.key === 'codex/cx-decline')?.status, 'approval');
  assert.ok(latestState().sessions.find(r => r.key === 'codex/cx-decline')?.preview);
  codexResolvedMap = new Map([['codex/cx-decline', new Set([cxWait.key])]]);
  await run('refresh');
  assert.equal(latestState().sessions.find(r => r.key === 'codex/cx-decline')?.status, 'working');
  assert.equal(latestState().sessions.find(r => r.key === 'codex/cx-decline')?.preview, undefined);
  codexResolvedMap = new Map();

  // Bug #2 & #3: AGY rejected soft wait clears to idle; CLI-only AGY conversation keeps 새 응답 unread while IDE conversation marks read.
  const agyUuid = '22222222-3333-4444-8555-666666666666';
  const agyPayload = { conversationId: agyUuid, workspacePaths: [workspace], stepIdx: 2, toolCall: { name: 'read_file', args: { Path: '/etc/hosts' } } };
  const agyEv = normalize('agy', 'PreToolUse', agyPayload, { homeDir: base });
  const past = Date.now() - 10000;
  await fs.writeFile(path.join(directory, createHash('sha256').update('agy:' + agyUuid).digest('hex') + '.json'), JSON.stringify({
    provider: 'agy', sessionId: agyUuid, cwd: workspace, workspacePaths: [workspace],
    status: 'working', updatedAt: past, workSince: past,
    pendingSoft: { [agyEv.key]: { status: 'approval', since: past, after: past + 4000, stepIdx: 2 } },
  }));
  await run('refresh');
  assert.equal(latestState().sessions.find(r => r.key === 'agy/' + agyUuid)?.status, 'approval');
  agyResolvedMap = new Map([['agy/' + agyUuid, { resolvedSoftRefs: new Set([agyEv.key]), haltedOnReject: true, resolvedAt: Date.now() }]]);
  await run('refresh');
  assert.equal(latestState().sessions.find(r => r.key === 'agy/' + agyUuid)?.status, 'idle');
  agyResolvedMap = new Map();

  // Complete AGY conversation with unread reply: CLI open must preserve 새 응답, IDE open marks read.
  await record(directory, normalize('agy', 'PreInvocation', { conversationId: agyUuid, workspacePaths: [workspace] }));
  await record(directory, normalize('agy', 'Stop', { conversationId: agyUuid, workspacePaths: [workspace], fullyIdle: true, terminationReason: 'model_stop' }));
  await run('refresh');
  assert.equal(latestState().sessions.find(r => r.key === 'agy/' + agyUuid)?.replyUnread, true);
  assert.equal(latestState().unreadCount, 1);

  agyAvailability = 'cli';
  infoSelection = undefined;
  await receive({ action: 'open', provider: 'agy', key: 'agy/' + agyUuid });
  await wait(20);
  assert.equal(latestState().sessions.find(r => r.key === 'agy/' + agyUuid)?.replyUnread, true, 'CLI open preserves 새 응답');
  assert.equal(latestState().unreadCount, 1);

  agyAvailability = 'ide';
  await receive({ action: 'open', provider: 'agy', key: 'agy/' + agyUuid });
  await wait(20);
  assert.equal(latestState().sessions.find(r => r.key === 'agy/' + agyUuid)?.replyUnread, undefined, 'confirmed IDE open marks read');
  assert.equal(latestState().unreadCount, 0);
});

// A window with the host's real link encoding: Uri.toString() encodes the query as one
// component unless asked to skip encoding, and an arriving link is decoded once.
async function linkedWindow(t, { trusted = true, folder = 'project', globalEntries = {}, layout, before } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-links-'));
  const storage = path.join(base, 'storage'), workspace = path.join(base, folder);
  await Promise.all([path.join(storage, 'sessions'), workspace].map(dir => fs.mkdir(dir, { recursive: true, mode: 0o700 })));
  await before?.({ directory: path.join(storage, 'sessions'), workspace });
  const delivered = [], executed = [], liveCalls = [], posted = [];
  const commands = new Map(), saved = new Map(Object.entries(globalEntries)), savedWorkspace = new Map(layout ? [['sessionLayout.v1', layout]] : []);
  let uriHandler, receive;
  const dispose = () => {};
  const uri = parts => ({ ...parts,
    toString: skipEncoding => parts.scheme + '://' + parts.authority + parts.path +
      (parts.query ? '?' + (skipEncoding ? parts.query : encodeURIComponent(parts.query)) : '') });
  const vscode = {
    env: { uriScheme: 'vscode', appName: 'Visual Studio Code', openExternal: async () => true,
      asExternalUri: async value => uri({ ...value, query: (value.query ? value.query + '&' : '') + 'windowId=42' }) },
    window: {
      state: { focused: false },
      createOutputChannel: () => ({ appendLine: () => {}, dispose }),
      registerUriHandler: handler => { uriHandler = handler; return { dispose }; },
      showInformationMessage: async () => {}, showWarningMessage: async () => {}, showErrorMessage: async () => {},
      onDidChangeWindowState: () => ({ dispose }),
      createStatusBarItem: () => ({ show: dispose, dispose }),
      registerWebviewViewProvider(_id, provider) {
        provider.resolveWebviewView({ visible: true, onDidDispose: () => ({ dispose }), onDidChangeVisibility: () => ({ dispose }),
          webview: { cspSource: 'unit.invalid', asWebviewUri: v => v, postMessage: msg => { posted.push(msg); return Promise.resolve(true); },
            onDidReceiveMessage: fn => { receive = fn; return { dispose }; } } });
        receive({ type: 'ready', view: 'sessions' });
        return { dispose };
      },
    },
    extensions: { getExtension: () => undefined },
    Uri: { joinPath: (...p) => p.join('/'), file: fsPath => ({ scheme: 'file', fsPath }), from: uri, parse: value => ({ raw: value }) },
    workspace: {
      workspaceFolders: [{ name: folder, uri: { scheme: 'file', fsPath: workspace } }],
      getWorkspaceFolder: () => ({ name: folder, uri: { scheme: 'file', fsPath: workspace } }),
      isTrusted: trusted,
      onDidChangeWorkspaceFolders: () => ({ dispose }), onDidChangeConfiguration: () => ({ dispose }),
      getConfiguration: () => ({ get: (name, fallback) => name === 'subscriptionUsage' ? false : fallback }),
    },
    commands: { registerCommand: (name, cb) => { commands.set(name, cb); return { dispose }; }, executeCommand: async (...args) => { executed.push(args); } },
    ThemeColor: class {}, StatusBarAlignment: { Left: 1 },
  };
  const activate = loadExtension(vscode, {
    './children.cjs': { createChildReader: () => async rows => rows },
    './navigation.cjs': { openSession: async () => true, startSession: async () => true, openUsage: async () => true },
    './quota.cjs': { createQuotaReader: () => async () => ({ status: 'unavailable', windows: [] }) },
    './metadata.cjs': { createRecentReader: () => async () => [], createMetadataReader: () => async () => ({ sessions: new Map(), providerUsage: {} }) },
    './setup.cjs': { hookStatus: async () => 'connected', configureHooks: async () => ({ changed: false }) },
    './live-state.cjs': real => ({ ...real, readCodexLiveRuns: async (...args) => { liveCalls.push(args); return { runs: [], capability: 'available' }; } }),
    './notify.cjs': real => ({ ...real, createNotifier: options => ({ ...real.createClaims(options.directory), delays: { local: 10, remote: 20 },
      deliver: async payload => { delivered.push(payload); return { ok: true, permission: 'granted', backend: 'native' }; },
      show: async () => true, clear: async () => true }) }),
    './manual.cjs': real => ({ ...real, findWindowForFolder: async () => undefined }),
  });
  const context = {
    globalStorageUri: { fsPath: storage }, extensionUri: '/fixture', extensionPath: path.resolve(__dirname, '..'), subscriptions: [],
    workspaceState: { get: key => savedWorkspace.get(key), update: async (key, value) => { savedWorkspace.set(key, value); } },
    globalState: { get: key => saved.get(key), update: async (key, value) => { if (value === undefined) saved.delete(key); else saved.set(key, value); },
      keys: () => [...saved.keys()] },
  };
  t.after(async () => {
    for (const item of context.subscriptions) item.dispose();
    await wait(30);
    await fs.rm(base, { recursive: true, force: true, maxRetries: 3 });
  });
  await activate(context);
  // What the host hands the extension when the OS opens a link: the query decoded once.
  const arrive = link => {
    const parsed = new URL(link);
    return { path: parsed.pathname, query: decodeURIComponent(parsed.search.slice(1)) };
  };
  return { base, workspace, directory: path.join(storage, 'sessions'), delivered, executed, liveCalls, posted, saved, savedWorkspace,
    run: (name, ...args) => commands.get('agentSessionMonitor.' + name)(...args), uriHandler: () => uriHandler, arrive };
}

test('notification links survive any folder name, and a click meant for a closed window opens only a folder with a known session', async t => {
  const w = await linkedWindow(t, { folder: 'R&D 한글 #1 +x' });
  await w.run('testNotification');
  const link = w.delivered.at(-1).openUri;
  assert.match(link, /^vscode:\/\/local-tools\.agent-session-monitor\/focus\?[\x21-\x7e]+$/, 'one encoded, printable link');
  const arrived = new URLSearchParams(w.arrive(link).query);
  assert.equal(arrived.get('cwd'), w.workspace, 'the folder name arrives intact');
  assert.equal(arrived.get('windowId'), '42', 'the window binding is not swallowed by the folder name');

  // A finished session in a folder whose window has closed.
  const other = path.join(w.base, 'closed project');
  await fs.mkdir(other);
  await record(w.directory, normalize('claude', 'UserPromptSubmit', { session_id: 'closed-1', cwd: other, prompt: 'x' }));
  await record(w.directory, normalize('claude', 'Stop', { session_id: 'closed-1', cwd: other, last_assistant_message: 'done' }));
  const click = cwd => w.uriHandler().handleUri({ path: '/focus', query: new URLSearchParams({ key: 'claude/closed-1', cwd }).toString() });
  await click(other);
  assert.deepEqual(w.executed.filter(args => args[0] === 'vscode.openFolder'), [['vscode.openFolder', { scheme: 'file', fsPath: other }, { forceNewWindow: true }]]);
  // A link naming a folder no session ran in, the home folder, or this window's own folder opens nothing.
  for (const cwd of [path.join(w.base, 'unrelated'), os.homedir(), '/', w.workspace]) await click(cwd);
  assert.equal(w.executed.filter(args => args[0] === 'vscode.openFolder').length, 1);
});

test('a restricted window lists sessions read-only: it neither probes live Codex writers nor announces', async t => {
  const w = await linkedWindow(t, { trusted: false });
  await record(w.directory, normalize('claude', 'PermissionRequest', { session_id: 'r1', cwd: w.workspace, tool_name: 'Bash', tool_input: { command: 'ls' } }));
  await w.run('refresh');
  await record(w.directory, normalize('claude', 'PermissionRequest', { session_id: 'r2', cwd: w.workspace, tool_name: 'Bash', tool_input: { command: 'pwd' } }));
  await w.run('refresh');
  await wait(60);
  assert.ok(w.posted.filter(m => m.type === 'state').at(-1).sessions.some(row => row.key === 'claude/r2'), 'still listed');
  assert.deepEqual(w.liveCalls, []);
  assert.deepEqual(w.delivered, []);
});

test('names and pins of sessions no window has listed for half a year are let go; recent or unknown ones are kept', async t => {
  const day = Math.floor(Date.now() / 86400000);
  const w = await linkedWindow(t, {
    globalEntries: { 'alias:claude/old': '옛 이름', 'alias:claude/live': '지금 이름', 'alias:claude/fresh': '새 이름',
      'namedSessionsSeen.v1': { 'claude/old': day - 200, 'claude/live': day - 200, 'claude/gone': day - 400, 'claude/elsewhere': day - 3 } },
    layout: { version: 2, pins: ['claude/old', 'claude/live'] },
    // The session is listed when the window opens, which is when storage is first pruned.
    before: ({ directory, workspace }) => record(directory, normalize('claude', 'UserPromptSubmit', { session_id: 'live', cwd: workspace, prompt: 'x' })),
  });
  for (let i = 0; i < 100 && w.saved.has('alias:claude/old'); i++) await wait(10);
  assert.equal(w.saved.get('alias:claude/old'), undefined);
  assert.equal(w.saved.get('alias:claude/live'), '지금 이름');
  assert.equal(w.saved.get('alias:claude/fresh'), '새 이름', 'a name seen for the first time starts its clock');
  for (let i = 0; i < 100 && w.savedWorkspace.get('sessionLayout.v1').pins.includes('claude/old'); i++) await wait(10);
  assert.deepEqual(w.savedWorkspace.get('sessionLayout.v1').pins, ['claude/live']);
  assert.deepEqual(w.saved.get('namedSessionsSeen.v1'), { 'claude/live': day, 'claude/fresh': day, 'claude/elsewhere': day - 3 });
});
