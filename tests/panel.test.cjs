'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPanel, viewState, validateAction } = require('../src/panel.cjs');

const permission = {
  key: 'claude/thread1', provider: 'claude', status: 'approval', title: '모바일 네비게이션 수정',
  cwd: '/local/demo', action: { kind: 'approval', token: 'request1', tool: 'Bash', detail: 'echo "<tag>"',
    cwd: '/local/demo', allow: true, deny: true },
};
const question = { ...permission, key: 'claude/thread2', status: 'input', action: { kind: 'question', token: 'req2',
  questions: [{ question: '배치를 선택해 주세요', header: '배치', multiSelect: false,
    choices: [{ label: '왼쪽', description: '기본 위치' }, { label: '오른쪽' }] },
  { question: '함께 적용할 항목', multiSelect: true, choices: [{ label: '여백' }, { label: '글꼴' }, { label: '색상' }] }] } };
const state = viewState({ sessions: [permission, question], usage: { claude: '세션 토큰 100' } });

test('panel exposes only display fields and complete requested scope', () => {
  const s = viewState({ sessions: [{ ...permission, secret: 'omit', accountId: 'omit' }] }).sessions[0];
  assert.equal(s.project, 'demo');
  assert.equal(s.secret, undefined);
  assert.equal(s.cwd, undefined);
  assert.equal(s.action.detail, 'echo "<tag>"');
  assert.equal(s.action.cwd, '/local/demo');
  assert.equal(viewState({ sessions: [{ ...permission, status: 'done' }] }).sessions[0].action, undefined);
  assert.deepEqual(viewState({ sessions: [{ ...permission, provider: '__proto__' }] }).sessions, []);
});

test('direct actions require current pending token, provider, button and session', () => {
  const msg = { action: 'approve', provider: 'claude', key: permission.key, token: permission.action.token };
  assert.deepEqual(validateAction(msg, state), msg);
  for (const invalid of [{ ...msg, provider: 'codex' }, { ...msg, key: question.key }, { ...msg, token: 'old' },
    { ...msg, action: 'dismiss' }, { ...msg, action: 'answer', answers: [[0]] }]) assert.equal(validateAction(invalid, state), undefined);
  const withoutAllow = viewState({ sessions: [{ ...permission, action: { ...permission.action, allow: false } }] });
  assert.equal(validateAction(msg, withoutAllow), undefined);
});

test('group usage opens for the chosen provider even with no history or cached totals', () => {
  for (const provider of ['claude', 'codex', 'agy']) {
    assert.deepEqual(validateAction({ action: 'usage', provider, token: 'discard', key: 'unrelated' }, viewState({})),
      { action: 'usage', provider });
  }
  assert.equal(validateAction({ action: 'usage', provider: 'unknown' }, viewState({})), undefined);
});

test('quota projection preserves zero, remaining and reset times and omits account details', () => {
  const resetsAt = Date.UTC(2026, 10, 27, 12);
  const limits = viewState({ usage: { claude: '123 tokens' }, quotas: { codex: {
    status: 'ready', plan: 'Pro', updatedAt: resetsAt - 1, account: 'private', windows: [
      { label: '5시간', kind: 'used', percent: 0, resetsAt, account: 'private' },
      { label: '주간', kind: 'remaining', percent: 23.8 }, { label: '누락', kind: 'used', percent: null },
      { label: '범위 초과', kind: 'used', percent: 103 }, { label: '알 수 없음', percent: 30 },
    ],
  } } }).quotas;
  assert.deepEqual(limits.codex, { status: 'ready', plan: 'Pro', updatedAt: resetsAt - 1, message: '',
    windows: [{ label: '5시간', kind: 'used', percent: 0, resetsAt },
      { label: '주간', kind: 'remaining', percent: 23.8, resetsAt: undefined }] });
  assert.deepEqual(limits.claude, { status: 'unavailable', windows: [] });
});

test('a stale or loading window can retain its last measurement; missing limits never imply zero', () => {
  const window = { label: '5시간', kind: 'used', percent: 100 };
  for (const status of ['stale', 'loading']) {
    const result = viewState({ quotas: { agy: { status, windows: [window] } } }).quotas.agy;
    assert.equal(result.status, status);
    assert.equal(result.windows[0].percent, 100);
  }
  for (const status of ['ready', 'stale', 'unavailable']) {
    const result = viewState({ quotas: { claude: { status, windows: [] } } }).quotas.claude;
    assert.equal(result.status, 'unavailable');
    assert.equal(result.windows.length, 0);
  }
  assert.deepEqual(validateAction({ action: 'refreshQuota', provider: 'agy', key: permission.key }, state),
    { action: 'refreshQuota', provider: 'agy' });
  assert.equal(validateAction({ action: 'refreshQuota', provider: 'unknown' }, state), undefined);
});

test('subagents open their own native route or a verified parent without borrowing inline permissions', () => {
  const sub = { ...permission, key: 'claude/child', isSubagent: true, parentKey: permission.key, canOpen: false };
  const native = { ...sub, key: 'codex/child', provider: 'codex', parentKey: 'codex/parent', canOpen: true };
  const snapshot = viewState({ sessions: [permission, sub, native] });
  assert.equal(snapshot.sessions[1].parentKey, permission.key);
  assert.equal(snapshot.sessions[1].action, undefined);
  assert.equal(snapshot.sessions[1].viaParent, true);
  for (const action of ['open', 'review']) {
    const message = {action, key:sub.key, provider:sub.provider};
    assert.deepEqual(validateAction(message,snapshot), message);
    assert.equal(validateAction(message,viewState({sessions:[sub]})), undefined);
  }
  assert.equal(validateAction({action:'approve',key:sub.key,provider:sub.provider,token:permission.action.token}, snapshot),undefined);
  const open = { action: 'open', key: native.key, provider: native.provider };
  assert.deepEqual(validateAction(open, snapshot), open);
  for (const parentKey of [sub.key, native.parentKey]) {
    const [orphan] = viewState({ sessions: [{ ...sub, parentKey }] }).sessions;
    assert.equal(orphan.parentKey, undefined);
    assert.equal(orphan.isSubagent, true);
  }
});

test('question answers need one offered choice per question, several only where the question allows it', () => {
  const msg = { action: 'answer', provider: 'claude', key: question.key, token: question.action.token, answers: [[1], [0, 2]] };
  assert.deepEqual(validateAction({ ...msg, index: 0, extra: 'drop' }, state), msg);
  for (const answers of [[[0]], [[0], []], [[0, 1], [0]], [[2], [0]], [[0], [3]], [[0], [1, 1]], [['0'], [0]], [[0.5], [0]],
    [[-1], [0]], [0, 0], 'x', undefined]) assert.equal(validateAction({ ...msg, answers }, state), undefined);
  assert.equal(validateAction({ ...msg, action: 'approve' }, state), undefined);
  assert.deepEqual(validateAction({ ...msg, action: 'defer' }, state),
    { action: 'defer', provider: 'claude', key: question.key, token: question.action.token });
  const shown = state.sessions[1].action;
  assert.deepEqual(shown.questions.map(q => [q.header, q.multiSelect, q.choices.length]), [['배치', false, 2], ['', true, 3]]);
  // An older single-question request is still readable; a malformed one is left to its own chat.
  const legacy = viewState({ sessions: [{ ...question, action: { kind: 'question', token: 't', question: '하나만', choices: [{ label: '예' }] } }] });
  assert.deepEqual(legacy.sessions[0].action.questions, [{ question: '하나만', header: '', multiSelect: false, choices: [{ label: '예', description: '' }] }]);
  for (const questions of [[], [{ question: '', choices: [{ label: 'a' }] }], [{ question: 'q', choices: [] }], [{ question: 'q', choices: [{ label: ' ' }] }],
    Array.from({ length: 5 }, () => ({ question: 'q', choices: [{ label: 'a' }] }))]) {
    assert.equal(viewState({ sessions: [{ ...question, action: { kind: 'question', token: 't', questions } }] }).sessions[0].action, undefined);
  }
});

test('timing, quiet work, previews, connection states and other folders are projected as display data only', () => {
  const at = Date.UTC(2026, 10, 24, 9);
  const waitingRow = { ...permission, waitSince: at, workSince: at - 5, action: { ...permission.action, expiresAt: at + 45000 } };
  const working = { ...permission, key: 'claude/busy', status: 'working', action: undefined, workSince: at - 9, waitSince: at, quiet: true, signalAt: at - 3 };
  const remote = { ...permission, key: 'codex/ask', provider: 'codex', action: undefined, preview: { tool: 'shell', detail: '{"command":"ls"}', secret: 'omit' } };
  const done = { ...permission, key: 'claude/done', status: 'done', action: undefined, quiet: true, preview: { tool: 'x', detail: 'y' }, waitSince: at };
  const s = viewState({ sessions: [waitingRow, working, remote, done], connections: { claude: 'connected', codex: 'update', agy: 'bogus' },
    elsewhere: [{ cwd: '/work/api', folder: 'api', approval: 2, input: 0, token: 'omit' }, { cwd: 'relative', approval: 1 },
      { cwd: '/work/idle', approval: 0, input: 0 }, { cwd: '/work/web', input: 1 }], unreadCount: 2 });
  assert.equal(s.sessions[0].waitSince, at);
  assert.equal(s.sessions[0].workSince, undefined);
  assert.equal(s.sessions[0].action.expiresAt, at + 45000);
  assert.deepEqual([s.sessions[1].workSince, s.sessions[1].quiet, s.sessions[1].signalAt, s.sessions[1].waitSince], [at - 9, true, at - 3, undefined]);
  assert.deepEqual(s.sessions[2].preview, { tool: 'shell', detail: '{"command":"ls"}' });
  assert.deepEqual([s.sessions[3].quiet, s.sessions[3].preview, s.sessions[3].waitSince], [undefined, undefined, undefined]);
  assert.equal(s.sessions[0].preview, undefined, 'a request that can be answered here needs no separate preview');
  assert.deepEqual(s.connections, { claude: 'connected', codex: 'update', agy: 'unknown' });
  assert.deepEqual(s.elsewhere, [{ cwd: '/work/api', folder: 'api', input: 0, approval: 2 }, { cwd: '/work/web', folder: 'web', input: 1, approval: 0 }]);
  assert.deepEqual(validateAction({ action: 'openFolder', cwd: '/work/api', extra: 1 }, s), { action: 'openFolder', cwd: '/work/api' });
  assert.equal(validateAction({ action: 'openFolder', cwd: '/work/other' }, s), undefined);
  assert.deepEqual(validateAction({ action: 'markAllSeen', provider: 'x' }, s), { action: 'markAllSeen' });
  assert.equal(validateAction({ action: 'markAllSeen' }, viewState({})), undefined);
  assert.equal(validateAction({ action: 'hideConnect', provider: 'codex' }, s), undefined, 'only a never-connected tool can be muted');
  const missing = viewState({ connections: { agy: 'missing' } });
  assert.deepEqual(validateAction({ action: 'hideConnect', provider: 'agy', key: 'x' }, missing), { action: 'hideConnect', provider: 'agy' });
  assert.deepEqual(validateAction({ action: 'connect', provider: 'agy' }, missing), { action: 'connect', provider: 'agy' });
  const untrusted = viewState({ connections: { codex: 'untrusted' }, codexLiveDetection: 'available' });
  assert.equal(untrusted.connections.codex, 'untrusted');
  assert.equal(untrusted.codexLiveDetection, 'available');
  assert.deepEqual(validateAction({ action: 'trustGuide', provider: 'codex' }, untrusted), { action: 'trustGuide', provider: 'codex' });
  assert.equal(validateAction({ action: 'trustGuide', provider: 'agy' }, untrusted), undefined);
  const unverified = viewState({ connections: { codex: 'unverified' } });
  assert.equal(unverified.connections.codex, 'unverified');
  assert.deepEqual(validateAction({ action: 'trustGuide', provider: 'codex' }, unverified), { action: 'trustGuide', provider: 'codex' });
});

function fakePanel() {
  const subscriptions = new Map();
  const listen = (key, fn) => {
    subscriptions.set(key, fn);
    return { dispose() { subscriptions.delete(key); } };
  };
  const postMessages = [], actions = [], visibility = [];
  const view = {
    visible: true,
    onDidDispose: fn => listen('dispose', fn),
    onDidChangeVisibility: fn => listen('visible', fn),
    webview: {
      cspSource: 'https://local.test',
      asWebviewUri: path => path,
      postMessage: message => { postMessages.push(message); return Promise.resolve(true); },
      onDidReceiveMessage: fn => listen('message', fn),
    },
  };
  const vscode = { Uri: { joinPath: (...parts) => parts.join('/') },
    extensions: { getExtension: id => ({ extensionUri: 'installed/' + id }) } };
  const panel = createPanel(vscode, 'root', value => actions.push(value), value => visibility.push(value));
  const emit = (key, value) => subscriptions.get(key)?.(value);
  return { view, panel, actions, visibility, emit, postMessages };
}

test('quota-only view leaves quota polling visible and hands inline actions back to the agent', () => {
  const { view, panel, actions, visibility, emit } = fakePanel();
  panel.setState({ sessions: [permission] });
  panel.resolveWebviewView(view);
  assert.equal(panel.canHandleRequests(), false);
  emit('message', { type: 'ready', view: 'sessions' });
  assert.equal(panel.canHandleRequests(), true);
  emit('message', { type: 'view', view: 'quotas' });
  assert.equal(visibility.at(-1), true);
  assert.equal(panel.isVisible(), true);
  assert.equal(panel.canHandleRequests(), false);
  const approve = { action: 'approve', provider: 'claude', key: permission.key, token: permission.action.token };
  const refresh = { action: 'refreshQuota', provider: 'claude' };
  emit('message', approve);
  emit('message', refresh);
  assert.deepEqual(actions, [refresh]);
  view.visible = false; emit('visible');
  view.visible = true; emit('visible');
  emit('message', { type: 'ready', view: 'quotas' });
  assert.equal(panel.canHandleRequests(), false);
  emit('message', { type: 'view', view: 'sessions' });
  assert.equal(panel.canHandleRequests(), true);
  emit('message', approve);
  assert.deepEqual(actions, [refresh, approve]);
  panel.dispose();
  assert.equal(panel.canHandleRequests(), false);
});

test('the view names the folder its list is for beside its title, and nothing when there is none', () => {
  const { view, panel } = fakePanel();
  panel.setState({ sessions: [permission], workspaceLabel: 'my-app' });
  panel.resolveWebviewView(view);
  assert.equal(view.description, 'my-app');
  panel.setState({ sessions: [permission] });
  assert.equal(view.description, undefined);
});

test('local official marks, restrictive CSP, and ready/visible lifecycle', () => {
  const { view, panel, actions, visibility, emit, postMessages } = fakePanel();
  panel.setState({ sessions: [permission] });
  panel.resolveWebviewView(view);
  assert.equal(panel.isVisible(), false);
  assert.equal(view.badge.value, 1);
  assert.match(view.webview.html, /default-src 'none'/);
  assert.match(view.webview.html, /script-src 'nonce-[a-f0-9]+'/);
  assert.ok(!view.webview.html.includes(permission.title));
  assert.match(view.webview.html, /<title>에이전트 세션 모니터<\/title>/);
  assert.match(view.webview.html, /<img data-logo="agy" src="installed\/google\.google-antigravity\/img\/logo\.png" data-fallback="root\/media\/icons\/agy\.png" alt="">/);
  // A mark drawn in ink comes first and says so; secondary vendor files or bundled PNGs are named as fallbacks.
  assert.match(view.webview.html, /<img data-logo="codex" data-ink src="installed\/openai\.chatgpt\/resources\/blossom-black\.svg" data-fallback="installed\/openai\.chatgpt\/resources\/blossom\.dark\.png" alt="">/);
  assert.match(view.webview.html, /<img data-logo="claude" src="installed\/anthropic\.claude-code\/resources\/claude-logo\.png" data-fallback="root\/media\/icons\/claude\.png" alt="">/);
  emit('message', { type: 'ready' });
  assert.ok(panel.isVisible());
  assert.equal(postMessages.at(-1).sessions[0].title, permission.title);
  view.visible = false;
  emit('visible');
  const message = { action: 'approve', provider: 'claude', key: permission.key, token: 'request1' };
  emit('message', message);
  assert.equal(actions.length, 0);
  view.visible = true; emit('visible');
  assert.equal(postMessages.at(-1).type, 'probe');
  assert.equal(panel.isVisible(), false);
  emit('message', { type: 'ready' });
  emit('message', message);
  assert.deepEqual(actions, [message]);
  panel.dispose();
  assert.equal(visibility.at(-1), false);
  assert.equal(panel.isVisible(), false);
});

test('workspace summary and layout project only known display fields and keep all three providers reachable', () => {
  const workspaceLabel = '작업 폴더';
  const result = viewState({ sessions: [permission],
    workspaceLabel, hasWorkspace:true, hiddenCompleted:3, attentionCount:2,
    preferences:{ sort:'manual', providerOrder:['agy','agy','uninstalled','codex'], hideCompleted:true, attentionOnly:false, token:'private' },
  });
  assert.equal(result.workspaceLabel, workspaceLabel);
  assert.equal(result.hasWorkspace,true);
  assert.equal(result.hiddenCompleted,3);
  assert.equal(result.attentionCount,2);
  assert.deepEqual(result.preferences,{sort:'manual',providerOrder:['agy','codex','claude'],hideCompleted:true,attentionOnly:false});
  const fallback = viewState({sessions:[permission], workspaceLabel:42, hasWorkspace:'true', hiddenCompleted:-2, attentionCount:NaN,
    preferences:{sort:'other', providerOrder:[{},'__proto__'],hideCompleted:'yes',attentionOnly:1}});
  assert.equal(fallback.hiddenCompleted,0);
  assert.equal(fallback.hasWorkspace,false);
  assert.equal(fallback.workspaceLabel,'');
  assert.equal(fallback.attentionCount,1);
  assert.deepEqual(fallback.preferences,{sort:'priority',providerOrder:['claude','codex','agy'],hideCompleted:false,attentionOnly:false});
});

test('preference actions accept only expected enums, directions, provider IDs and typed booleans', () => {
  for (const value of ['priority','recent','attention','manual']) {
    assert.deepEqual(validateAction({action:'setSort',value,token:'discard'},state),{action:'setSort',value});
  }
  for (const action of ['setHideCompleted','setAttentionOnly']) {
    for (const value of [true,false]) assert.deepEqual(validateAction({action,value},state),{action,value});
    for (const value of ['true',1,null]) assert.equal(validateAction({action,value},state),undefined);
  }
  for (const direction of ['up','down']) {
    const msg = {action:'moveProvider',provider:'agy',direction};
    assert.deepEqual(validateAction({...msg,providerOrder:['codex']},state),msg);
  }
  for (const invalid of [{action:'setSort',value:'provider'}, {action:'setSort',value:['recent']},
    {action:'moveProvider',provider:'__proto__',direction:'up'}, {action:'moveProvider',provider:'claude',direction:'first'}]) {
    assert.equal(validateAction(invalid,state),undefined);
  }
});

test('pinning uses the current rendered workspace row, cannot promote a child, and keeps metadata private', () => {
  const root = {...permission, pinned:true};
  const child = {...permission, key:'claude/child',parentKey:root.key,isSubagent:true,pinned:true};
  const snapshot = viewState({sessions:[root,child]});
  assert.equal(snapshot.sessions[0].pinned,true);
  assert.equal(snapshot.sessions[1].pinned,undefined);
  const msg = {action:'setPinned',key:root.key,provider:'claude',value:false};
  assert.deepEqual(validateAction({...msg,token:'private'},snapshot),msg);
  for (const invalid of [{...msg,value:1},{...msg,key:child.key},{...msg,key:'claude/other-workspace'},
    {...msg,provider:'codex'}]) assert.equal(validateAction(invalid,snapshot),undefined);
});

test('preference changes are accepted only from a visible session dashboard and the badge uses scoped attention', () => {
  const { view,panel,actions,emit } = fakePanel();
  panel.resolveWebviewView(view);
  panel.setState({sessions:[],attentionCount:3,hasWorkspace:true});
  assert.equal(view.badge.value,3);
  const toggle = {action:'setAttentionOnly',value:true};
  emit('message',toggle);
  emit('message',{type:'ready',view:'quotas'});
  emit('message',toggle);
  assert.deepEqual(actions,[]);
  emit('message',{type:'view',view:'sessions'});
  emit('message',toggle);
  assert.deepEqual(actions,[toggle]);
  panel.setState({sessions:[],attentionCount:0,hasWorkspace:false});
  assert.equal(view.badge,undefined);
  panel.dispose();
});

test('execution and unread state belong to each row and stale marks cannot consume a newer reply', () => {
  const done = {...permission, status:'done', replyAt:3000, replyUnread:true,
    execution:{model:'claude-sonnet-4-6',modelSource:'response',modelAt:2900,effort:'medium',effortSource:'setting',effortAt:2000,private:'omit'}};
  const child = {...permission,key:'claude/child',isSubagent:true,parentKey:done.key,execution:{model:'bad model',effort:'unknown'}};
  const s = viewState({sessions:[done,child]});
  assert.deepEqual(s.sessions[0].execution,{model:'claude-sonnet-4-6',modelSource:'response',modelAt:2900,effort:'medium',effortSource:'setting',effortAt:2000});
  assert.equal(s.sessions[1].execution,undefined);
  const seen = {action:'markSeen',provider:'claude',key:done.key,replyAt:3000};
  assert.deepEqual(validateAction(seen,s),seen);
  for (const copy of [{...seen,replyAt:2900},{...seen,key:child.key},{...seen,provider:'codex'}]) assert.equal(validateAction(copy,s),undefined);
});
test('collapsed representative is limited to actual same-provider waiting descendants', () => {
  const root = {...permission,status:'done',priorityTargetKey:'claude/leaf'};
  const child = {...permission,key:'claude/child',isSubagent:true,parentKey:root.key};
  const leaf = {...child,key:'claude/leaf',parentKey:child.key,status:'input'};
  const rows = [root, child, leaf];
  assert.equal(viewState({sessions:rows}).sessions[0].priorityTargetKey,leaf.key);
  for (const invalid of [{...leaf,parentKey:'claude/other'},{...leaf,status:'done'},{...leaf,parentKey:leaf.key}]) {
    assert.equal(viewState({sessions:[root,child,invalid]}).sessions[0].priorityTargetKey,undefined);
  }
});
test('next request reveals only the current request in a ready and visible session view', async () => {
  const {view,panel,emit,postMessages,actions} = fakePanel();
  panel.setState({sessions:[permission]});
  panel.resolveWebviewView(view);
  assert.equal(await panel.revealRequest(permission.key), false);
  emit('message',{type:'ready',view:'sessions'});
  assert.equal(await panel.revealRequest('codex/other'), false);
  assert.equal(await panel.revealRequest(permission.key), true);
  assert.deepEqual(postMessages.at(-1),{type:'revealRequest',key:permission.key,token:'request1'});
  assert.deepEqual(actions,[]);
  emit('message',{type:'view',view:'quotas'});
  assert.equal(await panel.revealRequest(permission.key), false);
  emit('message',{type:'view',view:'sessions'});
  panel.setState({sessions:[{...permission,status:'done'}]});
  assert.equal(await panel.revealRequest(permission.key), false);
});

test('what a session is doing reaches the view as bounded text; malformed pieces are dropped', () => {
  const at = Date.UTC(2026, 10, 24, 9);
  const busy = { ...permission, status: 'working', action: undefined,
    activity: { tool: 'Edit', target: 'src/a.ts', at, secret: 'omit' }, prompt: '  결제 재시도 로직을 고쳐 줘  ', reply: 'x'.repeat(900),
    steps: [{ tool: 'Bash', target: 'pnpm test', at }, { tool: '', target: '' }, null, { tool: 'Read', target: 'a'.repeat(400) },
      ...Array.from({ length: 12 }, () => ({ tool: 'Grep' }))],
    progress: { done: 3, total: 7 }, changed: 4 };
  const row = viewState({ sessions: [busy] }).sessions[0];
  assert.deepEqual(row.activity, { tool: 'Edit', target: 'src/a.ts', at });
  assert.equal(row.prompt, '결제 재시도 로직을 고쳐 줘');
  assert.equal(row.reply.length, 400);
  assert.equal(row.steps.length, 6, 'only the first eight entries are read, and the empty ones among them are dropped');
  assert.equal(row.steps[1].target.length, 200);
  assert.deepEqual(row.progress, { done: 3, total: 7 });
  assert.equal(row.changed, 4);
  const odd = viewState({ sessions: [{ ...busy, activity: { tool: 7 }, prompt: 5, reply: '   ', steps: 'x',
    progress: { done: 9, total: 7 }, changed: -1 }] }).sessions[0];
  for (const field of ['activity', 'prompt', 'reply', 'steps', 'progress', 'changed']) assert.equal(odd[field], undefined, field);
});

test('the open request is announced to keybindings only while the session view can act on it', async () => {
  const { view, panel, emit, postMessages } = fakePanel();
  const contexts = [];
  const vscode = { Uri: { joinPath: (...parts) => parts.join('/') }, extensions: { getExtension: () => undefined },
    commands: { executeCommand: (name, key, value) => { contexts.push([name, key, value]); } } };
  const keyed = createPanel(vscode, 'root', () => {}, () => {});
  const subscriptions = new Map();
  const listen = (key, fn) => { subscriptions.set(key, fn); return { dispose() {} }; };
  const posted = [];
  const host = { visible: true, onDidDispose: fn => listen('dispose', fn), onDidChangeVisibility: fn => listen('visible', fn),
    webview: { cspSource: 'x', asWebviewUri: p => p, postMessage: m => { posted.push(m); return Promise.resolve(true); },
      onDidReceiveMessage: fn => listen('message', fn) } };
  keyed.setState({ sessions: [permission] });
  keyed.resolveWebviewView(host);
  subscriptions.get('message')({ type: 'request', kind: 'approval' });
  assert.deepEqual(contexts, [], 'nothing is announced before the view is ready');
  assert.equal(await keyed.decideOpen('approve'), false);
  subscriptions.get('message')({ type: 'ready', view: 'sessions' });
  subscriptions.get('message')({ type: 'request', kind: 'approval' });
  subscriptions.get('message')({ type: 'request', kind: 'approval' });
  assert.deepEqual(contexts, [['setContext', 'agentSessionMonitor.openRequest', 'approval']]);
  assert.equal(await keyed.decideOpen('approve'), true);
  assert.deepEqual(posted.at(-1), { type: 'decide', action: 'approve' });
  assert.equal(await keyed.decideOpen('always'), false);
  subscriptions.get('message')({ type: 'request', kind: 'bogus' });
  assert.equal(contexts.at(-1)[2], '');
  assert.equal(await keyed.decideOpen('deny'), false, 'no open request, nothing to decide');
  subscriptions.get('message')({ type: 'request', kind: 'question' });
  subscriptions.get('message')({ type: 'view', view: 'quotas' });
  assert.equal(contexts.at(-1)[2], '', 'the quota view shows no request');
  subscriptions.get('message')({ type: 'view', view: 'sessions' });
  subscriptions.get('message')({ type: 'request', kind: 'question' });
  host.visible = false; subscriptions.get('visible')();
  assert.equal(contexts.at(-1)[2], '');
  keyed.dispose();
  // A host without the commands API (older test doubles) must not break the panel.
  panel.resolveWebviewView(view);
  emit('message', { type: 'ready' });
  emit('message', { type: 'request', kind: 'approval' });
  assert.equal(await panel.decideOpen('approve'), true);
  assert.deepEqual(postMessages.at(-1), { type: 'decide', action: 'approve' });
  panel.dispose();
});

test('a decision is refused once the window for answering here has passed; handing back is always allowed', () => {
  const at = Date.UTC(2026, 10, 24, 9);
  const timed = viewState({ sessions: [{ ...permission, action: { ...permission.action, expiresAt: at + 45000 } },
    { ...question, action: { ...question.action, expiresAt: at + 45000 } }] });
  const approve = { action: 'approve', provider: 'claude', key: permission.key, token: permission.action.token };
  const answer = { action: 'answer', provider: 'claude', key: question.key, token: question.action.token, answers: [[0], [1]] };
  for (const message of [approve, { ...approve, action: 'deny' }, answer]) {
    assert.deepEqual(validateAction(message, timed, at + 44999), message);
    assert.equal(validateAction(message, timed, at + 45000), undefined);
    assert.equal(validateAction(message, timed, at + 90000), undefined);
  }
  assert.deepEqual(validateAction({ ...approve, action: 'defer' }, timed, at + 90000), { ...approve, action: 'defer' });
  assert.deepEqual(validateAction(approve, state, at + 9e9), approve, 'a request without a stated window is not timed here');
});

test('plan checklist, changed files, failed steps and openFile actions are strictly allowlisted', () => {
  const rich = {
    ...permission,
    status: 'approval',
    action: {
      kind: 'approval', token: 'req-file', tool: 'Edit',
      detail: JSON.stringify({ file_path: '/local/demo/src/nav.tsx', old_string: 'a', new_string: 'b' }),
      cwd: '/local/demo', allow: true, deny: true,
    },
    steps: [
      { tool: 'Bash', target: 'pnpm test', failed: true },
      { tool: 'Read', target: 'src/header.tsx' },
      { tool: 'Read', target: '…/truncated.tsx' },
    ],
    plan: [
      { text: '  문제 분석  ', status: 'completed' },
      { text: '네비게이션 수정', status: 'in_progress' },
      { text: '잘못된 상태', status: 'bogus' },
      { text: '   ', status: 'pending' },
    ],
    changedFiles: ['src/nav.tsx', 'src/nav.tsx', 'src/menu.tsx', 'bad\0file.ts'],
  };
  const snap = viewState({ sessions: [rich] });
  const row = snap.sessions[0];
  assert.deepEqual(row.plan, [{ text: '문제 분석', status: 'completed' }, { text: '네비게이션 수정', status: 'in_progress' }]);
  assert.deepEqual(row.changedFiles, ['src/nav.tsx', 'src/menu.tsx']);
  assert.equal(row.steps[0].failed, true);
  assert.equal(row.steps[1].failed, undefined);

  assert.deepEqual(validateAction({ action: 'openFile', provider: 'claude', key: rich.key, file: 'src/menu.tsx' }, snap),
    { action: 'openFile', provider: 'claude', key: rich.key, file: 'src/menu.tsx' });
  assert.deepEqual(validateAction({ action: 'openFile', provider: 'claude', key: rich.key, file: 'src/header.tsx' }, snap),
    { action: 'openFile', provider: 'claude', key: rich.key, file: 'src/header.tsx' });
  assert.deepEqual(validateAction({ action: 'openFile', provider: 'claude', key: rich.key, file: '/local/demo/src/nav.tsx' }, snap),
    { action: 'openFile', provider: 'claude', key: rich.key, file: '/local/demo/src/nav.tsx' });

  for (const bad of ['../etc/passwd', '/etc/passwd', 'pnpm test', '…/truncated.tsx', '', 'src/unlisted.ts', 'src/a\nb']) {
    assert.equal(validateAction({ action: 'openFile', provider: 'claude', key: rich.key, file: bad }, snap), undefined, bad);
  }
});

test('quiet dismissal, error acknowledgment, errorReason projection and bulk child cleanup are strictly validated', () => {
  const at = Date.UTC(2026, 10, 25, 10);
  const errRow = { ...permission, key: 'claude/err', status: 'error', updatedAt: at, errorReason: 'rate_limit', action: undefined };
  const ackedRow = { ...errRow, key: 'claude/acked', errorAcked: true, errorReason: 'bogus_reason' };
  const quietRow = { ...permission, key: 'claude/quiet', status: 'working', quiet: true, signalAt: at - 60000, action: undefined };
  const liveRow = { ...permission, key: 'claude/live', status: 'working', action: undefined };
  const quietChild = { ...quietRow, key: 'claude/err/kid1', isSubagent: true, parentKey: 'claude/err', canOpen: false };
  const liveChild = { ...liveRow, key: 'claude/live/kid2', isSubagent: true, parentKey: 'claude/live', canOpen: false };
  const snap = viewState({ sessions: [errRow, ackedRow, quietRow, liveRow, quietChild, liveChild] });

  assert.equal(snap.sessions[0].errorReason, 'rate_limit');
  assert.equal(snap.sessions[0].errorAcked, undefined);
  assert.equal(snap.sessions[1].errorReason, undefined);
  assert.equal(snap.sessions[1].errorAcked, true);
  assert.equal(snap.attentionCount, 1, 'acknowledged error does not add to fallback attention count');

  // Quiet rows can be dismissed; live working rows cannot.
  assert.deepEqual(validateAction({ action: 'dismiss', provider: 'claude', key: 'claude/quiet' }, snap),
    { action: 'dismiss', provider: 'claude', key: 'claude/quiet' });
  assert.equal(validateAction({ action: 'dismiss', provider: 'claude', key: 'claude/live' }, snap), undefined);

  // ackError requires exact updatedAt and unacknowledged error status.
  assert.deepEqual(validateAction({ action: 'ackError', provider: 'claude', key: 'claude/err', updatedAt: at }, snap),
    { action: 'ackError', provider: 'claude', key: 'claude/err', updatedAt: at });
  assert.equal(validateAction({ action: 'ackError', provider: 'claude', key: 'claude/err', updatedAt: at - 1 }, snap), undefined);
  assert.equal(validateAction({ action: 'ackError', provider: 'claude', key: 'claude/acked', updatedAt: at }, snap), undefined);
  assert.equal(validateAction({ action: 'ackError', provider: 'claude', key: 'claude/live', updatedAt: at }, snap), undefined);

  // dismissChildren requires a verified settled or quiet descendant.
  assert.deepEqual(validateAction({ action: 'dismissChildren', provider: 'claude', key: 'claude/err' }, snap),
    { action: 'dismissChildren', provider: 'claude', key: 'claude/err' });
  assert.equal(validateAction({ action: 'dismissChildren', provider: 'claude', key: 'claude/live' }, snap), undefined);
});

test('panel projects focus, skipped/failed plan steps, and Codex apply_patch openFile targets', () => {
  const patchDetail = JSON.stringify({ command: '*** Begin Patch\n*** Update File: src/hook.cjs\n@@\n-a\n+b\n*** Add File: src/new.cjs\n+c\n*** End Patch' });
  const agyRow = {
    ...permission, key: 'agy/steps', provider: 'agy', status: 'working', action: undefined,
    focus: '  Investigating blank Claude sessions  ',
    plan: [
      { text: 'Step 1', status: 'completed' },
      { text: 'Step 2', status: 'in_progress' },
      { text: 'Step 3', status: 'skipped' },
      { text: 'Step 4', status: 'failed' },
    ],
  };
  const codexPatch = {
    ...permission, key: 'codex/patch', provider: 'codex', status: 'approval', action: undefined,
    preview: { tool: 'apply_patch', detail: patchDetail },
  };
  const snap = viewState({ sessions: [agyRow, codexPatch] });
  assert.equal(snap.sessions[0].focus, 'Investigating blank Claude sessions');
  assert.deepEqual(snap.sessions[0].plan.map(p => p.status), ['completed', 'in_progress', 'skipped', 'failed']);
  assert.deepEqual(validateAction({ action: 'openFile', provider: 'codex', key: 'codex/patch', file: 'src/hook.cjs' }, snap),
    { action: 'openFile', provider: 'codex', key: 'codex/patch', file: 'src/hook.cjs' });
  assert.deepEqual(validateAction({ action: 'openFile', provider: 'codex', key: 'codex/patch', file: 'src/new.cjs' }, snap),
    { action: 'openFile', provider: 'codex', key: 'codex/patch', file: 'src/new.cjs' });
  assert.equal(validateAction({ action: 'openFile', provider: 'codex', key: 'codex/patch', file: 'src/other.cjs' }, snap), undefined);
});

test('panel tracks local filters, provider-scoped inline handling, openRequestKey, revealSession, remote/scanError and bundled logo fallback', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  // viewState projects remote workspace flag and bounded scanError; validateAction accepts refresh and newSession.
  const remoteState = viewState({ isRemoteWorkspace: true, scanError: '  ' + 'x'.repeat(250) + '  ' });
  assert.equal(remoteState.isRemoteWorkspace, true);
  assert.equal(remoteState.scanError.length, 198);
  assert.equal(viewState({ isRemoteWorkspace: 'yes', scanError: 123 }).isRemoteWorkspace, false);
  assert.equal(viewState({ isRemoteWorkspace: 'yes', scanError: 123 }).scanError, '');
  assert.deepEqual(validateAction({ action: 'refresh', extra: 1 }, state), { action: 'refresh' });
  assert.deepEqual(validateAction({ action: 'newSession', extra: 1 }, state), { action: 'newSession' });

  // Filter tracking, provider-scoped canHandleRequests(provider), onFilterChange, isShowingRequest(key), revealSession(key).
  const subscriptions = new Map();
  const listen = (key, fn) => { subscriptions.set(key, fn); return { dispose() { subscriptions.delete(key); } }; };
  const posted = [], actions = [], filterEvents = [];
  const view = {
    visible: true,
    onDidDispose: fn => listen('dispose', fn),
    onDidChangeVisibility: fn => listen('visible', fn),
    webview: {
      cspSource: 'https://local.test',
      asWebviewUri: p => p,
      postMessage: m => { posted.push(m); return Promise.resolve(true); },
      onDidReceiveMessage: fn => listen('message', fn),
    },
  };
  const tmpExt = fs.mkdtempSync(path.join(os.tmpdir(), 'asm-panel-logo-'));
  try {
    fs.mkdirSync(path.join(tmpExt, 'media', 'icons'), { recursive: true });
    fs.writeFileSync(path.join(tmpExt, 'media', 'icons', 'claude.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const vscode = {
      Uri: { joinPath: (...parts) => parts.join('/') },
      extensions: { getExtension: () => undefined },
    };
    const panel = createPanel(vscode, tmpExt, a => actions.push(a), () => {}, f => filterEvents.push(f));
    panel.setState({ sessions: [permission] });
    panel.resolveWebviewView(view);
    assert.match(view.webview.html, /<img data-logo="claude" data-bundled src="[^"]*media\/icons\/claude\.png" alt="">/);
    assert.match(view.webview.html, /<img data-logo="agy" data-bundled src="[^"]*media\/icons\/agy\.png" alt="">/);

    const emit = (k, v) => subscriptions.get(k)?.(v);
    assert.equal(panel.isShowingRequest(permission.key), false);
    assert.equal(await panel.revealSession(permission.key), false);

    emit('message', { type: 'ready', view: 'sessions', lens: 'all', providerFilter: 'all', hasSearch: false });
    assert.equal(panel.canHandleRequests(), true);
    assert.equal(panel.canHandleRequests('claude'), true);
    assert.equal(panel.canHandleRequests('codex'), true);
    assert.equal(panel.canHandleRequests('unknown'), false);
    assert.equal(filterEvents.length, 0);

    // Open request key tracking (including viewport visibility)
    emit('message', { type: 'request', kind: 'approval', key: permission.key });
    assert.equal(panel.isShowingRequest(permission.key), true);
    assert.equal(panel.isShowingRequest('claude/other'), false);
    assert.equal(panel.isShowingRequest(''), false);
    emit('message', { type: 'request', kind: 'approval', key: permission.key, visible: false });
    assert.equal(panel.isShowingRequest(permission.key), false, 'off-screen open request must not suppress in-window toasts');
    emit('message', { type: 'request', kind: 'approval', key: permission.key, visible: true });
    assert.equal(panel.isShowingRequest(permission.key), true);

    // Switching providerFilter to codex hides claude inline requests and fires onFilterChange
    emit('message', { type: 'filter', lens: 'all', providerFilter: 'codex', hasSearch: false });
    assert.equal(panel.canHandleRequests(), true, 'no-arg canHandleRequests stays backward compatible');
    assert.equal(panel.canHandleRequests('codex'), true);
    assert.equal(panel.canHandleRequests('claude'), false);
    assert.equal(panel.isShowingRequest(permission.key), false, 'open request key cleared when provider becomes hidden');
    assert.deepEqual(filterEvents.at(-1), { lens: 'all', providerFilter: 'codex', hasSearch: false });

    // Working lens hides all providers from inline requests
    emit('message', { type: 'filter', lens: 'working', providerFilter: 'all', hasSearch: false });
    assert.equal(panel.canHandleRequests('claude'), false);
    assert.equal(panel.canHandleRequests('codex'), false);
    assert.deepEqual(filterEvents.at(-1), { lens: 'working', providerFilter: 'all', hasSearch: false });

    // Ephemeral search input MUST NOT hand active Claude requests back to chat
    emit('message', { type: 'filter', lens: 'all', providerFilter: 'all', hasSearch: true });
    assert.equal(panel.canHandleRequests('claude'), true);
    assert.deepEqual(filterEvents.at(-1), { lens: 'all', providerFilter: 'all', hasSearch: true });

    // Reset filter restores handling
    emit('message', { type: 'filter', lens: 'all', providerFilter: 'all', hasSearch: false });
    assert.equal(panel.canHandleRequests('claude'), true);

    // revealSession posts message when visible
    assert.equal(await panel.revealSession(permission.key), true);
    assert.deepEqual(posted.at(-1), { type: 'revealSession', key: permission.key });
    assert.equal(await panel.revealSession(''), false);

    // refresh and newSession actions pass through in sessions view, blocked in quota overview
    emit('message', { action: 'refresh' });
    emit('message', { action: 'newSession' });
    assert.deepEqual(actions, [{ action: 'refresh' }, { action: 'newSession' }]);
    emit('message', { type: 'view', view: 'quotas' });
    emit('message', { action: 'refresh' });
    assert.deepEqual(actions, [{ action: 'refresh' }, { action: 'newSession' }]);

    // cleanup resets filter & openRequestKey
    emit('message', { type: 'view', view: 'sessions' });
    emit('message', { type: 'filter', lens: 'working', providerFilter: 'codex', hasSearch: true });
    panel.dispose();
    assert.equal(panel.canHandleRequests(), false);
    assert.equal(panel.canHandleRequests('claude'), false);
    assert.equal(panel.isShowingRequest(permission.key), false);
  } finally {
    fs.rmSync(tmpExt, { recursive: true, force: true });
  }
});

test('panel projects interrupted flag, optional preview.cwd, view_file_outline/view_code_item, File/planFilePath and apply_patch Move to targets', () => {
  const movePatch = JSON.stringify({
    command: '*** Begin Patch\n*** Update File: src/old.ts\n*** Move to: src/new.ts\n@@\n-a\n+b\n*** End Patch',
  });
  const agyOutline = {
    ...permission, key: 'agy/outline', provider: 'agy', status: 'idle', interrupted: true, action: undefined,
    steps: [
      { tool: 'view_file_outline', target: 'src/outline.ts' },
      { tool: 'view_code_item', target: 'src/item.ts' },
    ],
  };
  const planPreview = {
    ...permission, key: 'claude/plan', provider: 'claude', status: 'approval', action: undefined,
    preview: { tool: 'ExitPlanMode', detail: JSON.stringify({ planFilePath: '/work/.claude/plans/p.md', File: '/work/extra.ts' }), cwd: '/work' },
  };
  const codexMove = {
    ...permission, key: 'codex/move', provider: 'codex', status: 'approval', action: undefined,
    preview: { tool: 'apply_patch', detail: movePatch },
  };
  const snap = viewState({ sessions: [agyOutline, planPreview, codexMove] });

  assert.equal(snap.sessions[0].interrupted, true);
  assert.equal(snap.sessions[1].interrupted, undefined);
  assert.equal(snap.sessions[1].preview.cwd, '/work');
  assert.deepEqual(Object.keys(snap.sessions[2].preview), ['tool', 'detail']);

  assert.deepEqual(validateAction({ action: 'openFile', provider: 'agy', key: 'agy/outline', file: 'src/outline.ts' }, snap),
    { action: 'openFile', provider: 'agy', key: 'agy/outline', file: 'src/outline.ts' });
  assert.deepEqual(validateAction({ action: 'openFile', provider: 'agy', key: 'agy/outline', file: 'src/item.ts' }, snap),
    { action: 'openFile', provider: 'agy', key: 'agy/outline', file: 'src/item.ts' });
  assert.deepEqual(validateAction({ action: 'openFile', provider: 'claude', key: 'claude/plan', file: '/work/.claude/plans/p.md' }, snap),
    { action: 'openFile', provider: 'claude', key: 'claude/plan', file: '/work/.claude/plans/p.md' });
  assert.deepEqual(validateAction({ action: 'openFile', provider: 'claude', key: 'claude/plan', file: '/work/extra.ts' }, snap),
    { action: 'openFile', provider: 'claude', key: 'claude/plan', file: '/work/extra.ts' });
  assert.deepEqual(validateAction({ action: 'openFile', provider: 'codex', key: 'codex/move', file: 'src/new.ts' }, snap),
    { action: 'openFile', provider: 'codex', key: 'codex/move', file: 'src/new.ts' });
});

test('a hidden view keeps its badge current without projecting or posting the list, and catches up once ready', () => {
  const { view, panel, emit, postMessages } = fakePanel();
  panel.resolveWebviewView(view);
  let reads = 0;
  const counted = sessions => ({ workspaceLabel: '작업', attentionCount: 2, unreadCount: 1,
    get sessions() { reads++; return sessions; } });
  panel.setState(counted([permission]));
  assert.equal(reads, 0, 'nothing reads the list while the view is not ready');
  assert.deepEqual(postMessages, []);
  assert.equal(view.badge.value, 3);
  assert.equal(view.description, '작업');
  // Without counts the badge still follows the rows, by the same rules as the view.
  const mixed = { sessions: [permission, { ...question, quiet: true },
    { ...permission, key: 'claude/err', status: 'error', errorAcked: true, action: undefined },
    { ...permission, key: 'claude/done', status: 'done', replyUnread: true, replyAt: 5, action: undefined }] };
  panel.setState(mixed);
  const projected = viewState(mixed);
  assert.equal(view.badge.value, projected.attentionCount + projected.unreadCount);
  assert.equal(view.badge.value, 2);
  // What is shown can still be asked about while hidden, with the same answer as the projection.
  assert.deepEqual([...panel.shownActionKeys()], projected.sessions.filter(row => row.action).map(row => row.key));
  panel.setState(counted([permission]));
  emit('message', { type: 'ready', view: 'sessions' });
  assert.ok(reads > 0);
  assert.equal(postMessages.filter(message => message.type === 'state').length, 1);
  assert.equal(postMessages.at(-1).sessions[0].key, permission.key);
});

test('each distinct state the view receives carries a higher revision; a resend of the same one does not', () => {
  const { view, panel, emit, postMessages } = fakePanel();
  panel.resolveWebviewView(view);
  emit('message', { type: 'ready', view: 'sessions' });
  const states = () => postMessages.filter(message => message.type === 'state');
  panel.setState({ sessions: [permission] }, 'sig-1');
  const first = states().at(-1).rev;
  assert.ok(Number.isSafeInteger(first) && first > 0);
  const count = states().length;
  panel.setState({ sessions: [permission] }, 'sig-1');
  assert.equal(states().length, count, 'an unchanged signature posts nothing new');
  panel.setState({ sessions: [permission, question] }, 'sig-2');
  assert.equal(states().length, count + 1);
  assert.equal(states().at(-1).rev, first + 1);
  assert.equal(states().at(-1).sessions.length, 2, 'the signature only names the change; the projection is still sent');
  // Hidden and shown again: the same content is sent again under the same revision.
  view.visible = false; emit('visible');
  view.visible = true; emit('visible');
  emit('message', { type: 'ready', view: 'sessions' });
  assert.equal(states().length, count + 2);
  assert.equal(states().at(-1).rev, first + 1);
  // Without a caller signature the panel compares its own projection.
  panel.setState({ sessions: [question] });
  assert.equal(states().at(-1).rev, first + 2);
  panel.setState({ sessions: [question], secret: 'not projected' });
  assert.equal(states().length, count + 3, 'a change outside the projection sends nothing');
  // Actions are validated against the latest state at once.
  const approve = { action: 'approve', provider: 'claude', key: permission.key, token: permission.action.token };
  emit('message', approve);
  assert.equal(states().at(-1).rev, first + 2);
  panel.setState({ sessions: [permission] });
  assert.equal(states().at(-1).rev, first + 3);
});

test('refreshLogos upgrades fallback badges to official vendor marks once extensions become available', () => {
  const subscriptions = new Map();
  const listen = (key, fn) => {
    subscriptions.set(key, fn);
    return { dispose() { subscriptions.delete(key); } };
  };
  const postMessages = [], visibility = [];
  let trusted = false;
  const view = {
    visible: true,
    onDidDispose: fn => listen('dispose', fn),
    onDidChangeVisibility: fn => listen('visible', fn),
    webview: {
      cspSource: 'https://local.test',
      asWebviewUri: p => p,
      postMessage: message => { postMessages.push(message); return Promise.resolve(true); },
      onDidReceiveMessage: fn => listen('message', fn),
    },
  };
  const vscode = {
    Uri: { joinPath: (...parts) => parts.join('/') },
    extensions: { getExtension: id => trusted ? { extensionUri: 'installed/' + id } : undefined },
  };
  const panel = createPanel(vscode, 'root', () => {}, value => visibility.push(value));
  panel.setState({ sessions: [permission] });
  panel.resolveWebviewView(view);
  assert.match(view.webview.html, /<img data-logo="claude" data-bundled src="root\/media\/icons\/claude\.png" alt="">/);
  assert.deepEqual(view.webview.options.localResourceRoots, ['root/media']);
  subscriptions.get('message')({ type: 'ready', view: 'sessions' });
  assert.equal(panel.isVisible(), true);
  // Unchanged extension set must not reload the webview.
  const beforeHtml = view.webview.html;
  assert.equal(panel.refreshLogos(), false);
  assert.equal(view.webview.html, beforeHtml);
  // Granting workspace trust exposes the vendor extensions and upgrades logos + localResourceRoots.
  trusted = true;
  assert.equal(panel.refreshLogos(), true);
  assert.equal(panel.isVisible(), false, 'panel waits for the reloaded webview to report ready');
  assert.equal(visibility.at(-1), false);
  assert.match(view.webview.html, /<img data-logo="claude" src="installed\/anthropic\.claude-code\/resources\/claude-logo\.png" data-fallback="root\/media\/icons\/claude\.png" alt="">/);
  assert.match(view.webview.html, /<img data-logo="codex" data-ink src="installed\/openai\.chatgpt\/resources\/blossom-black\.svg" data-fallback="installed\/openai\.chatgpt\/resources\/blossom\.dark\.png" alt="">/);
  assert.match(view.webview.html, /<img data-logo="agy" src="installed\/google\.google-antigravity\/img\/logo\.png" data-fallback="root\/media\/icons\/agy\.png" alt="">/);
  assert.equal(view.webview.options.localResourceRoots.length, 4);
  // Calling refreshLogos again with the same vendor extensions is a no-op.
  assert.equal(panel.refreshLogos(), false);
  // Once the reloaded webview reports ready, state is re-sent immediately.
  subscriptions.get('message')({ type: 'ready', view: 'sessions' });
  assert.equal(panel.isVisible(), true);
  assert.equal(postMessages.at(-1).type, 'state');
  panel.dispose();
});
