'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');
const { listen, ask, requestFor, hookResponse, noticeFor, describePreview, announce, createPreviews, clampWindow, activityNotice, activityWindows,
  reportActivity, findWindowForFolder, forgetDeparted, PROTOCOL } = require('../src/manual.cjs');
const { record, normalize } = require('../src/hook.cjs');

const payload = (extra = {}) => ({ session_id: 'fixture-123', hook_event_name: 'PermissionRequest',
  cwd: '/fixture/workspace', tool_name: 'Read', tool_input: { file_path: '/fixture/example.md' }, ...extra });
const key = 'claude/fixture-123';
const source = path.resolve(__dirname, '../src/hook.cjs');
const two = [{ question: '범위를 고르세요', header: '범위', options: [{ label: '검토' }, { label: '수정', description: '바로 고칩니다' }] },
  { question: '함께 확인할 항목', multiSelect: true, options: [{ label: '테스트' }, { label: '문서' }, { label: '로그' }] }];

function spawnHook(state, provider, event, input, entrypoint = 'claude-vscode') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [source, provider, event, state], {stdio:['pipe','pipe','pipe'],env:{...process.env,CLAUDE_CODE_ENTRYPOINT:entrypoint}});
    let stdout = '', stderr = '';
    child.once('error', reject);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.once('close', code => code !== 0 || stderr ? reject(new Error('Hook error: ' + code + stderr)) : resolve(stdout));
    child.stdin.end(JSON.stringify(input));
  });
}
const run = async (state, input, provider = 'claude', entrypoint = 'claude-vscode') => {
  const stdout = await spawnHook(state, provider, 'PermissionRequest', input, entrypoint);
  return stdout ? JSON.parse(stdout) : undefined;
};
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-test-'));
  const states = path.join(root, 'sessions');
  let visible = true;
  const server = await listen(states, {canAccept: () => visible, changed() {}, ...options});
  t.after(async () => { server.dispose(); await fs.rm(root,{recursive:true,force:true}); });
  async function action(id = key) {
    for (let i = 0; i < 200; i++) {
      const current = server.forSession(id);
      if (current) return current;
      await sleep(10);
    }
    throw new Error('Request was never shown');
  }
  const registry = path.join(root, 'approval-windows');
  const descriptor = async () => {
    const names = (await fs.readdir(registry)).filter(name => name.endsWith('.json'));
    assert.equal(names.length, 1);
    return JSON.parse(await fs.readFile(path.join(registry, names[0]), 'utf8'));
  };
  return { root, states, server, action, registry, descriptor, hide() { visible = false; server.deferAll(); } };
}
// A raw client: the hello, then `follow` once the window has proven itself.
function exchange(address, hello, follow, stopAfter = Infinity) {
  return new Promise(resolve => {
    const socket = net.createConnection(address);
    const lines = [];
    let buffer = '';
    const timer = setTimeout(() => socket.destroy(), 1500);
    socket.on('connect', () => socket.write(JSON.stringify(hello) + '\n'));
    socket.on('data', data => {
      buffer += data;
      for (let at; (at = buffer.indexOf('\n')) >= 0;) {
        lines.push(JSON.parse(buffer.slice(0, at)));
        buffer = buffer.slice(at + 1);
        if (lines.length === 1 && follow) socket.write(JSON.stringify(follow) + '\n');
        if (lines.length >= stopAfter) socket.destroy();
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => { clearTimeout(timer); resolve(lines); });
  });
}
// A window from another release, or one that never answers, in its own registry.
async function foreignWindow(t, states, { respond, extra = {}, silent = false } = {}) {
  const registry = path.join(path.dirname(states), 'approval-windows');
  await fs.mkdir(registry, {recursive:true, mode:0o700});
  const keys = crypto.generateKeyPairSync('ed25519');
  const sign = (...parts) => crypto.sign(null, Buffer.from(JSON.stringify(parts)), keys.privateKey).toString('base64');
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-foreign-'));
  const address = path.join(folder, 'ui.sock');
  const received = [], sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    if (silent) return;
    let nonce, buffer = '';
    socket.on('data', data => {
      buffer += data;
      for (let at; (at = buffer.indexOf('\n')) >= 0;) {
        const packet = JSON.parse(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        if (!nonce) { nonce = packet.nonce; socket.write(JSON.stringify({proof: sign('hello', nonce)}) + '\n'); continue; }
        received.push(packet);
        respond?.(socket, packet, decision => socket.write(JSON.stringify({decision, proof: sign('decision', nonce, decision)}) + '\n'));
      }
    });
  });
  await new Promise(resolve => server.listen(address, resolve));
  await fs.writeFile(path.join(registry, crypto.randomUUID() + '.json'), JSON.stringify({address, pid: process.pid,
    publicKey: keys.publicKey.export({type:'spki',format:'pem'}), ...extra}), {mode:0o600});
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    server.close();
    await fs.rm(folder, {recursive:true, force:true});
  });
  return { received };
}

test('independent Claude process accepts only the chosen request once', async t => {
  const f = await fixture(t);
  assert.equal(await run(f.states, payload(), 'claude', 'sdk-cli'), undefined);
  const answer = run(f.states, payload());
  const a = await f.action();
  assert.deepEqual(JSON.parse(a.detail), {file_path:'/fixture/example.md'});
  assert.equal(f.server.decide(key, 'obsolete', {action:'approve'}), false);
  assert.equal(f.server.decide('claude/else', a.token, {action:'approve'}), false);
  assert.equal(f.server.decide(key, a.token, {action:'answer',answers:[[0]]}), false);
  assert.equal(f.server.decide(key, a.token, {action:'approve'}), true);
  assert.equal(f.server.decide(key, a.token, {action:'approve'}), false);
  assert.deepEqual((await answer).hookSpecificOutput.decision, {behavior:'allow'});
  const files = (await fs.readdir(f.states)).filter(x => x.endsWith('.json'));
  const saved = await fs.readFile(path.join(f.states,files[0]),'utf8');
  assert.doesNotMatch(saved, /example\.md/);
  assert.equal(JSON.parse(saved).status, 'working', 'inline decision immediately resolves the snapshot out of approval');
  assert.equal(JSON.parse(saved).pending, undefined);
  assert.equal(f.server.previewFor(key), undefined, 'a decided request leaves no preview behind');
});

test('single-choice reply preserves tool input and returns exactly the selected answer', async t => {
  const f = await fixture(t);
  const q = {question:'범위를 고르세요', options:[{label:'검토'},{label:'수정'}]};
  const wait = run(f.states, payload({tool_name:'AskUserQuestion', tool_input:{questions:[q]}}));
  const a = await f.action();
  assert.equal(a.kind, 'question');
  assert.equal(f.server.decide(key,a.token,{action:'approve'}),false);
  assert.equal(f.server.decide(key,a.token,{action:'answer',answers:[[7]]}),false);
  assert.equal(f.server.decide(key,a.token,{action:'answer',index:1}),false, 'the earlier single-index form is refused');
  assert.equal(f.server.decide(key,a.token,{action:'answer',answers:[[1]]}),true);
  assert.deepEqual((await wait).hookSpecificOutput.decision.updatedInput,{questions:[q],answers:{'범위를 고르세요':'수정'}});
});

test('several questions: one array per question, several labels joined in offered order, questions unchanged', async t => {
  const f = await fixture(t);
  const before = Date.now();
  const wait = run(f.states, payload({tool_name:'AskUserQuestion', tool_input:{questions:two, note:'kept'}}));
  const a = await f.action();
  assert.deepEqual(a.questions, [
    {question:'범위를 고르세요', header:'범위', multiSelect:false, choices:[{label:'검토',description:''},{label:'수정',description:'바로 고칩니다'}]},
    {question:'함께 확인할 항목', header:'', multiSelect:true, choices:[{label:'테스트',description:''},{label:'문서',description:''},{label:'로그',description:''}]}]);
  assert.equal(a.question, undefined);
  assert.equal(a.choices, undefined);
  assert.ok(a.expiresAt >= before + 45000 && a.expiresAt <= Date.now() + 45000, 'the default window is 45 s from acceptance');
  for (const answers of [[[0]], [[0], []], [[0, 1], [0]], [[2], [0]], [[0], [3]], [[0], [1, 1]], [['0'], [0]], [[0.5], [0]],
    [[-1], [0]], [0, 0], [[0], [0], [0]], 'x', undefined, null]) {
    assert.equal(f.server.decide(key, a.token, {action:'answer', answers}), false, JSON.stringify(answers));
  }
  assert.equal(f.server.decide(key, a.token, {action:'answer', answers:[[1], [2, 0]]}), true);
  assert.deepEqual((await wait).hookSpecificOutput.decision.updatedInput, {questions:two, note:'kept',
    answers:{'범위를 고르세요':'수정', '함께 확인할 항목':'테스트, 로그'}});
});

test('question requests are validated strictly and the request carries only the questions form', () => {
  const ask = (questions, extra = {}) => requestFor('claude', 'PermissionRequest',
    payload({tool_name:'AskUserQuestion', tool_input:{questions, ...extra}}));
  const option = label => ({label});
  const valid = ask(two);
  assert.equal(valid.kind, 'question');
  assert.equal(valid.version, PROTOCOL);
  assert.deepEqual(Object.keys(valid).sort(), ['cwd','detail','key','kind','provider','questions','tool','version']);
  assert.equal(ask(Array.from({length:4}, (_, i) => ({question:'q' + i, options:[option('a'),option('b')]}))).questions.length, 4);
  assert.ok(ask(two, {answers:{}}), 'an empty answers object is not a prior answer');
  for (const questions of [[], Array.from({length:5}, (_, i) => ({question:'q' + i, options:[option('a'),option('b')]})),
    [{question:'같음', options:[option('a'),option('b')]}, {question:'같음', options:[option('c'),option('d')]}],
    [{question:'q', options:[option('a'),option('a')]}], [{question:'q', options:[option('a')]}],
    [{question:'q', options:Array.from({length:7}, (_, i) => option('o' + i))}], [{question:'q', header:3, options:[option('a'),option('b')]}],
    [{question:'q', multiSelect:'yes', options:[option('a'),option('b')]}], [{question:'q', options:[option('a'),{label:'b',description:1}]}],
    [{question:'q', options:[option('a'),option(' ')]}], [{question:' ', options:[option('a'),option('b')]}], [{question:'q', options:'ab'}],
    [{question:'q', choices:[option('a'),option('b')]}], 'q', [null]]) {
    assert.equal(ask(questions), undefined, JSON.stringify(questions));
  }
  assert.equal(ask(two, {answers:{'범위를 고르세요':'검토'}}), undefined, 'an already answered question stays with Claude');
  assert.equal(ask(two, {answers:'검토'}), undefined);
});

test('hookResponse builds output only from a well-formed choice for the request it was made for', () => {
  const question = requestFor('claude', 'PermissionRequest', payload({tool_name:'AskUserQuestion', tool_input:{questions:two}}));
  const input = payload({tool_input:{questions:two}});
  for (const choice of [{action:'answer', answers:[[0]]}, {action:'answer', answers:[[0], [5]]}, {action:'answer', answers:[[0, 1], [0]]},
    {action:'answer', index:0}, {action:'approve'}, {action:'deny'}, {action:'defer'}, {answers:[[0], [0]]}, null, 'answer'])
    assert.equal(hookResponse(question, input, choice), undefined, JSON.stringify(choice));
  assert.equal(hookResponse(question, {}, {action:'answer', answers:[[0], [0]]}), undefined, 'no tool input, no answer');
  assert.deepEqual(hookResponse(question, input, {action:'answer', answers:[[0], [1]]}).hookSpecificOutput.decision.updatedInput.answers,
    {'범위를 고르세요':'검토', '함께 확인할 항목':'문서'});
  const approval = requestFor('claude', 'PermissionRequest', payload());
  assert.equal(hookResponse(approval, payload(), {action:'answer', answers:[[0]]}), undefined);
  assert.equal(hookResponse({kind:'question', questions:[{}]}, input, {action:'answer', answers:[[0]]}), undefined);
  assert.deepEqual(hookResponse(approval, payload(), {action:'deny'}).hookSpecificOutput.decision, {behavior:'deny'});
});

test('closing a panel or resolving the original tool does not answer a stale request', async t => {
  const f = await fixture(t);
  const wait = run(f.states,payload());
  await f.action(); f.hide();
  assert.equal(await wait, undefined);
  assert.equal(await run(f.states,payload()), undefined);
  const g = await fixture(t);
  const stale = run(g.states,payload());
  const a = await g.action();
  await record(g.states,normalize('claude','Stop',payload({hook_event_name:'Stop'})));
  g.server.decide(key,a.token,{action:'approve'});
  assert.equal(await stale, undefined);
});

test('deny and native handoff do not change future permission rules', async t => {
  const f = await fixture(t);
  for (const action of ['deny','defer']) {
    const native = run(f.states,payload()); const a = await f.action();
    f.server.decide(key,a.token,{action});
    const output = await native;
    assert.deepEqual(output?.hookSpecificOutput.decision,action === 'deny' ? {behavior:'deny'} : undefined);
  }
});

test('other providers, unsupported questions, modes and oversized details use native UI', () => {
  for (const id of ['agy','codex']) assert.equal(requestFor(id,'PermissionRequest',payload()),undefined);
  for (const extra of [{agent_id:'child'}, {tool_name:'ExitPlanMode'}, {tool_input:{text:'x'.repeat(11000)}},
    {tool_name:'AskUserQuestion', tool_input:{questions:[{multiSelect:true}]} }])
    assert.equal(requestFor('claude','PermissionRequest',payload(extra)),undefined);
  assert.equal(hookResponse(requestFor('claude','PermissionRequest',payload()),payload(),{action:'defer'}),undefined);
});

test('requests from a different workspace and same fingerprint in flight use the original human prompt', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'asm-scope-'));
  const states = path.join(root,'sessions');
  const server = await listen(states,{canAccept: cwd => cwd === '/fixture/workspace', changed() {}});
  t.after(async () => { server.dispose(); await fs.rm(root,{recursive:true,force:true}); });
  assert.equal(await run(states,payload({cwd:'/another/project'})),undefined);
  assert.equal(server.forSession(key),undefined);
  const first = run(states,payload());
  for(let i = 0; !server.forSession(key) && i < 150; i++) await sleep(10);
  assert.ok(server.forSession(key));
  const second = run(states,payload());
  assert.deepEqual(await Promise.all([first,second]), [undefined,undefined]);
  assert.equal(server.forSession(key),undefined);
});

test('a newer question takes priority and resolving it restores the original pending approval', async t => {
  const f = await fixture(t);
  const approval = run(f.states,payload({tool_use_id:'approval-1'}));
  const first = await f.action();
  const question = run(f.states,payload({tool_name:'AskUserQuestion',tool_use_id:'question-1',
    tool_input:{questions:[{question:'다음 작업?',options:[{label:'계속'},{label:'종료'}]}]}}));
  let next;
  for (let i=0; i<150; i++) {
    next=f.server.forSession(key);
    if (next?.kind==='question') break;
    await sleep(10);
  }
  assert.equal(next?.kind,'question');
  assert.equal(next.pendingCount,2);
  assert.equal(f.server.decide(key,next.token,{action:'defer'}),true);
  assert.equal(await question,undefined);
  assert.equal(f.server.forSession(key)?.token,first.token);
  f.server.decide(key,first.token,{action:'defer'});
  assert.equal(await approval,undefined);
});

test('the inline window comes from the descriptor, is clamped on both ends and is rewritten in place', async t => {
  let seconds = 20;
  const f = await fixture(t, {windowMs: () => seconds * 1000});
  assert.equal((await f.descriptor()).windowMs, 20000);
  const before = Date.now();
  const wait = run(f.states, payload());
  const a = await f.action();
  assert.equal(a.window, 20000);
  assert.ok(a.expiresAt >= before + 20000 && a.expiresAt <= Date.now() + 20000);
  f.server.decide(key, a.token, {action:'defer'});
  assert.equal(await wait, undefined);
  for (const [value, expected] of [[1, 15000], [600, 540000], [NaN, 45000]]) {
    seconds = value;
    await f.server.updateWindow();
    assert.equal((await f.descriptor()).windowMs, expected);
  }
  assert.deepEqual((await fs.readdir(f.registry)).filter(name => !name.endsWith('.json')), [], 'no temporary descriptor is left behind');
  for (const [value, expected] of [[undefined, 45000], ['30000', 45000], [1000, 15000], [30000.4, 30000], [600000, 540000], [Infinity, 45000]])
    assert.equal(clampWindow(value), expected);
});

test('version skew: a window refuses an earlier hook, a hook refuses an earlier window, the chat answers', async t => {
  const f = await fixture(t);
  const { address } = await f.descriptor();
  const hello = () => ({nonce: crypto.randomUUID(), cwd: '/fixture/workspace'});
  const legacyQuestion = {key, provider:'claude', tool:'AskUserQuestion', cwd:'/fixture/workspace', detail:'{}', kind:'question', ref:'generic',
    question:'범위', choices:[{label:'검토'},{label:'수정'}]};
  const legacyApproval = {key, provider:'claude', tool:'Read', cwd:'/fixture/workspace', detail:'{}', kind:'approval', ref:'generic'};
  const current = {...legacyApproval, version:PROTOCOL, window:45000};
  for (const request of [legacyQuestion, legacyApproval, {...current, version:PROTOCOL + 1}, {...current, window:5000},
    {...current, kind:'plan'}, {...current, kind:'question', questions:[{question:'q', choices:[{label:'a'}]}]},
    {...current, cwd:'/elsewhere'}, {...current, ref:'../x'}, {...current, detail:'x'.repeat(10001)}]) {
    const lines = await exchange(address, hello(), {request});
    assert.equal(lines.length, 1, 'only the proof, never an acceptance: ' + JSON.stringify(request).slice(0, 80));
    assert.equal(f.server.forSession(key), undefined);
  }
  const accepted = await exchange(address, hello(), {request: current}, 2);
  assert.deepEqual(accepted[1], {accepted:true});

  // An earlier window answers in its own shape; the new hook prints nothing.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-skew-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const states = path.join(root, 'sessions');
  const old = await foreignWindow(t, states, {respond(socket, packet, decide) {
    socket.write(JSON.stringify({accepted:true}) + '\n');
    decide(packet.request.kind === 'question' ? {action:'answer', index:0} : {action:'allow'});
  }});
  assert.equal(await run(states, payload({tool_name:'AskUserQuestion', tool_input:{questions:two}})), undefined);
  assert.equal(await run(states, payload()), undefined);
  assert.equal(old.received[0].request.version, PROTOCOL);
  assert.equal(old.received[0].request.window, 45000, 'a descriptor without a window means the 45 s default');
  assert.equal(old.received[0].request.question, undefined);
});

test('an inline request that ends without a decision leaves its content for the waiting row', async t => {
  const f = await fixture(t);
  const wait = run(f.states, payload());
  const a = await f.action();
  assert.equal(f.server.previewFor(key), undefined, 'the action itself is shown while it is open');
  f.hide();
  assert.equal(await wait, undefined);
  for (let i = 0; i < 100 && !f.server.previewFor(key); i++) await sleep(10);
  assert.deepEqual(f.server.previewFor(key), {tool:'Read', detail:a.detail});
  const g = await fixture(t);
  const deferred = run(g.states, payload({tool_input:{file_path:'/fixture/other.md'}}));
  const b = await g.action();
  g.server.decide(key, b.token, {action:'defer'});
  assert.equal(await deferred, undefined);
  assert.equal(g.server.previewFor(key).detail, b.detail);
  assert.equal(g.server.previewFor(key, [b.ref]).detail, b.detail);
  assert.equal(g.server.previewFor(key, ['0'.repeat(64)]), undefined, 'a resolved request shows no stale content');
  g.server.prunePreviews(() => false, Date.now() + 1);
  assert.equal(g.server.previewFor(key), undefined);
});

test('display-only notices reach windows of that folder and never change what a hook prints', async t => {
  const workspace = '/fixture/workspace';
  const f = await fixture(t, {canAccept: () => false, canNotice: cwd => cwd === workspace});
  await fs.mkdir(f.states, {recursive:true});
  const before = new Set(await fs.readdir(f.root));
  const codex = {session_id:'codex-1', cwd:workspace, turn_id:'turn-1', tool_name:'Bash', tool_input:{command:'npm test'}};
  assert.equal(await spawnHook(f.states, 'codex', 'PermissionRequest', codex), '');
  assert.deepEqual(f.server.previewFor('codex/codex-1'), {tool:'Bash', detail:JSON.stringify({command:'npm test'}, null, 2)});
  assert.equal(await spawnHook(f.states, 'codex', 'PreToolUse', {...codex, session_id:'codex-2', tool_name:'request_user_input',
    tool_input:{questions:[{id:'a', question:'계속할까요?'}]}}), '');
  assert.match(f.server.previewFor('codex/codex-2').detail, /계속할까요/);
  assert.equal(await spawnHook(f.states, 'codex', 'Stop', {...codex, last_assistant_message:'done'}), '{}\n');
  const agy = {conversationId:'agy-1', workspacePaths:[workspace], stepIdx:4, toolCall:{name:'ask_permission', args:{path:'/fixture/x'}}};
  assert.equal(await spawnHook(f.states, 'agy', 'PreToolUse', agy), '{"decision":"allow"}\n');
  assert.deepEqual(f.server.previewFor('agy/agy-1'), {tool:'ask_permission', detail:JSON.stringify({path:'/fixture/x'}, null, 2)});
  // A subagent's request, a CLI request and a request no window would show inline all keep their row key.
  assert.equal(await spawnHook(f.states, 'claude', 'PermissionRequest', payload({agent_id:'helper-1', agent_type:'Reviewer'})), '');
  assert.equal(f.server.previewFor('claude/fixture-123/helper-1').tool, 'Read');
  assert.equal(await spawnHook(f.states, 'claude', 'PermissionRequest', payload({tool_name:'Write', tool_input:{file_path:'/fixture/a'}}), 'cli'), '');
  assert.equal(f.server.previewFor(key).tool, 'Write');
  assert.equal(await spawnHook(f.states, 'claude', 'PermissionRequest', payload({tool_name:'Edit', tool_input:{file_path:'/fixture/b'}})), '');
  assert.equal(f.server.previewFor(key).tool, 'Edit', 'unanswerable here, so shown as a preview');
  // Other folders and waits without request content send nothing; oversized input gets a bounded read-only preview.
  assert.equal(await spawnHook(f.states, 'codex', 'PermissionRequest', {...codex, session_id:'codex-3', cwd:'/fixture/other'}), '');
  assert.equal(await spawnHook(f.states, 'codex', 'PermissionRequest', {...codex, session_id:'codex-4', tool_input:{text:'x'.repeat(11000)}}), '');
  assert.equal(await spawnHook(f.states, 'claude', 'Notification', {session_id:'claude-n', cwd:workspace, notification_type:'permission_prompt'}), '');
  for (const id of ['codex/codex-3', 'claude/claude-n']) assert.equal(f.server.previewFor(id), undefined);
  const bigPreview = f.server.previewFor('codex/codex-4');
  assert.ok(bigPreview && Buffer.byteLength(bigPreview.detail) <= 10000);
  assert.ok(JSON.parse(bigPreview.detail)._truncated.totalBytes > 10000);
  // Request content stays in memory: snapshots hold none of it and nothing else was written.
  for (const name of await fs.readdir(f.states)) {
    assert.doesNotMatch(await fs.readFile(path.join(f.states, name), 'utf8'), /npm test|fixture\/x|계속할까요|Bash|ask_permission/);
  }
  assert.deepEqual(new Set(await fs.readdir(f.root)), before);
  assert.deepEqual((await fs.readdir(f.registry)).length, 1);
});

test('notices are built from the hook event and a window ignores a malformed one', async t => {
  const event = (provider, name, input) => normalize(provider, name, input);
  const claudeChild = {session_id:'root-1', agent_id:'leaf-1', cwd:'/w', tool_name:'Bash', tool_input:{command:'ls'}};
  assert.equal(noticeFor('claude', claudeChild, event('claude', 'PermissionRequest', claudeChild)).key, 'claude/root-1/leaf-1');
  const codexChild = {...claudeChild, session_id:'root-2'};
  assert.equal(noticeFor('codex', codexChild, event('codex', 'PermissionRequest', codexChild)).key, 'codex/leaf-1');
  const bidi = String.fromCharCode(0x202e);
  const escaped = noticeFor('codex', {...codexChild, tool_input:{command:'ls' + bidi}}, event('codex', 'PermissionRequest', codexChild));
  assert.ok(!escaped.detail.includes(bidi) && escaped.detail.includes('\\u202e'));
  const noCwd = {...codexChild, cwd:'relative'};
  assert.equal(noticeFor('codex', noCwd, event('codex', 'PermissionRequest', noCwd)), undefined);
  assert.equal(noticeFor('codex', {...codexChild, tool_name:'../x'}, event('codex', 'PermissionRequest', codexChild)), undefined);
  assert.equal(noticeFor('codex', codexChild, event('codex', 'UserPromptSubmit', codexChild)), undefined);

  const f = await fixture(t, {canAccept: () => false, canNotice: cwd => cwd === '/fixture/workspace'});
  const { address } = await f.descriptor();
  const hello = () => ({nonce: crypto.randomUUID(), cwd:'/fixture/workspace', purpose:'notice'});
  const valid = {version:PROTOCOL, key:'codex/n-1', provider:'codex', tool:'Bash', cwd:'/fixture/workspace', detail:'{}', ref:'generic'};
  for (const notice of [{...valid, version:1}, {...valid, key:'codex/a/b'}, {...valid, key:'claude/n-1'}, {...valid, cwd:'/elsewhere'},
    {...valid, tool:'x y'}, {...valid, detail:'x'.repeat(10001)}, {...valid, ref:undefined}, {...valid, provider:'other', key:'other/n-1'}]) {
    await exchange(address, hello(), {notice});
    assert.equal(f.server.previewFor(notice.key), undefined, JSON.stringify(notice).slice(0, 80));
  }
  assert.deepEqual(await exchange(address, {...hello(), cwd:'/elsewhere'}), [], 'another folder gets no proof');
  assert.deepEqual(await exchange(address, {nonce:crypto.randomUUID(), cwd:'/fixture/workspace'}), [],
    'a request needs a window that can answer it, not one that only shows notices');
  await exchange(address, hello(), {notice:valid});
  assert.equal(f.server.previewFor('codex/n-1').tool, 'Bash');
  assert.equal(f.server.forSession('codex/n-1'), undefined, 'a notice is never an answerable request');
});

test('a stalled window delays a notifying hook by a few hundred milliseconds at most', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-stall-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const states = path.join(root, 'sessions');
  await foreignWindow(t, states, {silent:true});
  await foreignWindow(t, states, {silent:true});
  const notice = {version:PROTOCOL, key:'codex/s-1', provider:'codex', tool:'Bash', cwd:'/fixture/workspace', detail:'{}', ref:'generic'};
  const started = Date.now();
  await announce(states, notice);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 250 && elapsed < 900, 'both windows are tried in parallel within the cut-off: ' + elapsed);
  await assert.doesNotReject(announce(path.join(root, 'missing', 'sessions'), notice));
});

test('previews are bounded, expire and keep only the newest content per request', () => {
  let now = 1000;
  const previews = createPreviews({limit:3, ttl:100, now:() => now});
  for (const ref of ['a', 'b', 'c', 'd']) previews.remember({key:'codex/x', ref, tool:'T' + ref, detail:ref, cwd:'/w'});
  assert.deepEqual(previews.get('codex/x'), {tool:'Td', detail:'d'});
  assert.equal(previews.get('codex/x', ['a']), undefined, 'the oldest entry made room');
  assert.equal(previews.get('codex/x', ['b']).detail, 'b');
  previews.remember({key:'codex/x', ref:'b', tool:'Tb', detail:'b2', cwd:'/w'});
  assert.equal(previews.get('codex/x', ['b']).detail, 'b2');
  assert.equal(previews.get('codex/x', []).detail, 'b2', 'no known refs means the newest entry');
  now += 100;
  assert.equal(previews.get('codex/x'), undefined, 'entries expire');
  previews.remember({key:'codex/y', ref:'a', tool:'T', detail:'old', cwd:'/w'});
  now += 10;
  previews.remember({key:'codex/z', ref:'a', tool:'T', detail:'new', cwd:'/w'});
  previews.prune(() => false, now);
  assert.equal(previews.get('codex/y'), undefined);
  assert.equal(previews.get('codex/z').detail, 'new', 'newer than the scan that judged it');
  previews.prune(key => key === 'codex/z', now + 1);
  assert.equal(previews.get('codex/z').detail, 'new');
});

// A window that records each hello and what follows it, advertising activity as told.
// Without `prove` it never answers, like a window whose extension host is stalled.
async function fakeWindow(t, states, { activity, prove = true } = {}) {
  const registry = path.join(path.dirname(states), 'approval-windows');
  await fs.mkdir(registry, {recursive:true, mode:0o700});
  const keys = crypto.generateKeyPairSync('ed25519');
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-fake-'));
  const address = path.join(folder, 'ui.sock');
  const hellos = [], packets = [], sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let buffer = '', proven = false;
    socket.on('data', data => {
      buffer += data;
      for (let at; (at = buffer.indexOf('\n')) >= 0;) {
        const packet = JSON.parse(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        if (proven) { packets.push(packet); continue; }
        hellos.push(packet);
        if (!prove) continue;
        proven = true;
        const proof = crypto.sign(null, Buffer.from(JSON.stringify(['hello', packet.nonce])), keys.privateKey).toString('base64');
        socket.write(JSON.stringify({proof}) + '\n');
      }
    });
  });
  await new Promise(resolve => server.listen(address, resolve));
  await fs.writeFile(path.join(registry, crypto.randomUUID() + '.json'), JSON.stringify({address, pid: process.pid,
    publicKey: keys.publicKey.export({type:'spki', format:'pem'}), ...(activity !== undefined && {activity})}), {mode:0o600});
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    server.close();
    await fs.rm(folder, {recursive:true, force:true});
  });
  return { hellos, packets };
}
async function until(check, label) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await sleep(10);
  }
  throw new Error('Timed out: ' + label);
}
const workspace = '/fixture/workspace';

test('a hook connects to no window unless one asked for activity, and its output stays the same', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-want-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const states = path.join(root, 'sessions');
  const off = await fakeWindow(t, states, {activity:false});
  const earlier = await fakeWindow(t, states, {});
  const base = {session_id:'want-1', cwd:workspace};
  const events = [
    ['claude', 'UserPromptSubmit', {...base, prompt:'결제 재시도 로직을 고쳐 줘'}, ''],
    ['claude', 'PostToolUse', {...base, tool_name:'Bash', tool_input:{command:'pnpm test'}}, ''],
    ['codex', 'PostToolUse', {...base, turn_id:'t1', tool_name:'apply_patch', tool_input:{command:'*** Begin Patch\n*** Update File: a.ts\n*** End Patch'}}, ''],
    ['codex', 'Stop', {...base, turn_id:'t1', last_assistant_message:'done'}, '{}\n'],
    ['claude', 'Stop', {...base, last_assistant_message:'고쳤습니다.'}, ''],
    ['agy', 'PreInvocation', {conversationId:'agy-1', workspacePaths:[workspace], lastUserInput:'Fix the test'}, '{}\n'],
  ];
  for (const [provider, name, input, printed] of events) assert.equal(await spawnHook(states, provider, name, input), printed, provider + ' ' + name);
  assert.equal(off.hellos.length + earlier.hellos.length, 0, 'neither a window that declined nor one from an earlier release is contacted');
  const on = await fakeWindow(t, states, {activity:true});
  for (const [provider, name, input, printed] of events) assert.equal(await spawnHook(states, provider, name, input), printed, provider + ' ' + name);
  await until(() => on.packets.length === events.length, 'every event reached the window that asked');
  assert.equal(off.hellos.length + earlier.hellos.length, 0);
  assert.ok(on.hellos.every(hello => hello.purpose === 'activity' && hello.cwd === workspace));
  assert.deepEqual(on.packets.map(({activity}) => [activity.key, Object.keys(activity).filter(field =>
    ['prompt', 'step', 'reply'].includes(field))[0]]), [['claude/want-1', 'prompt'], ['claude/want-1', 'step'], ['codex/want-1', 'step'],
    ['codex/want-1', 'reply'], ['claude/want-1', 'reply'], ['agy/agy-1', 'prompt']]);
  assert.deepEqual(on.packets[2].activity, {version:PROTOCOL, key:'codex/want-1', provider:'codex', cwd:workspace, turn:'t1',
    step:{tool:'apply_patch', target:'a.ts'}, stepFile:workspace + '/a.ts', files:[workspace + '/a.ts']});
  assert.ok(on.packets.every(({activity}) => activity.version === PROTOCOL && activity.cwd === workspace));
});

test('a window keeps activity only for its own folder while the feature is on, and never as a request or preview', async t => {
  let on = true;
  const f = await fixture(t, {canAccept: () => true, canActivity: cwd => on && cwd === workspace, wantsActivity: () => on});
  const { address } = await f.descriptor();
  const hello = (cwd = workspace) => ({nonce: crypto.randomUUID(), cwd, purpose:'activity'});
  const valid = {version:PROTOCOL, key:'codex/a-1', provider:'codex', cwd:workspace, step:{tool:'Bash', target:'npm test'}};
  for (const notice of [{...valid, version:1}, {...valid, key:'claude/a-1'}, {...valid, key:'codex/a/b'}, {...valid, key:'codex/../x'},
    {...valid, cwd:'/elsewhere'}, {...valid, provider:'other', key:'other/a-1'}, {...valid, step:{tool:'a b'}},
    {...valid, prompt:'two kinds at once'}, {...valid, step:undefined}, {...valid, files:['relative.ts']}, 'text', null]) {
    await exchange(address, hello(), {activity: notice});
    assert.equal(f.server.activityFor('codex/a-1'), undefined, JSON.stringify(notice)?.slice(0, 80));
  }
  assert.deepEqual(await exchange(address, hello('/elsewhere'), {activity:{...valid, cwd:'/elsewhere'}}), [], 'another folder gets no proof');
  await exchange(address, hello(), {activity: valid});
  assert.deepEqual(f.server.activityFor('codex/a-1').steps.map(({tool, target}) => [tool, target]), [['Bash', 'npm test']]);
  assert.equal(f.server.previewFor('codex/a-1'), undefined, 'activity is not a request preview');
  // A request sent over an activity handshake is not a request.
  const request = {version:PROTOCOL, key, provider:'claude', tool:'Read', cwd:workspace, detail:'{}', kind:'approval', ref:'generic', window:45000};
  assert.equal((await exchange(address, hello(), {request}, 2)).length, 1, 'only the proof, never an acceptance');
  assert.equal(f.server.forSession(key), undefined);
  await exchange(address, hello(), {activity:{...valid, key:'codex/a-2'}});
  f.server.forgetActivity(['codex/a-1']);
  assert.deepEqual([f.server.activityFor('codex/a-1'), Boolean(f.server.activityFor('codex/a-2'))], [undefined, true], 'a hidden session only');
  await exchange(address, hello(), {activity: valid});
  on = false;
  assert.deepEqual(await exchange(address, hello(), {activity: valid}), [], 'with the feature off nothing is accepted');
  f.server.clearActivity();
  assert.equal(f.server.activityFor('codex/a-1'), undefined);
});

test('the descriptor says whether a window wants activity and is rewritten when that changes', async t => {
  let wanted = false;
  const f = await fixture(t, {wantsActivity: () => wanted});
  assert.equal((await f.descriptor()).activity, false);
  wanted = true;
  await f.server.updateWindow();
  assert.equal((await f.descriptor()).activity, true);
  assert.equal((await activityWindows(f.states)).length, 1);
  const g = await fixture(t, {wantsActivity: () => { throw new Error('settings unavailable'); }});
  assert.equal((await g.descriptor()).activity, false, 'a failing check asks for nothing');
  assert.equal((await fixture(t)).server.activityFor('codex/x'), undefined);
});

test('a window that starts removes descriptors of windows that are gone, and nothing else', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-gone-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const states = path.join(root, 'sessions'), registry = path.join(root, 'approval-windows');
  await fs.mkdir(registry, {recursive:true, mode:0o700});
  const child = spawn(process.execPath, ['-e', '']);
  const { pid } = child;
  await new Promise(resolve => child.once('exit', resolve));
  const file = (name, body) => fs.writeFile(path.join(registry, name), body, {mode:0o600}).then(() => path.join(registry, name));
  const gone = await file(crypto.randomUUID() + '.json', JSON.stringify({address:'/nowhere/ui.sock', pid, publicKey:'k'}));
  const live = await file(crypto.randomUUID() + '.json', JSON.stringify({address:'/nowhere/ui.sock', pid:process.pid, publicKey:'k'}));
  const unreadable = await file(crypto.randomUUID() + '.json', '{');
  const unrelated = await file('notes.txt', JSON.stringify({pid}));
  const server = await listen(states, {canAccept: () => false, changed() {}});
  t.after(() => server.dispose());
  for (let i = 0; i < 200 && await fs.stat(gone).then(() => true, () => false); i++) await sleep(10);
  await assert.rejects(fs.stat(gone), {code:'ENOENT'});
  for (const kept of [live, unreadable, unrelated]) await fs.stat(kept);
});

test('a stalled window costs an activity notice at most its short cut-off, and nothing is sent before a window proves itself', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-quiet-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const states = path.join(root, 'sessions');
  const quiet = [await fakeWindow(t, states, {activity:true, prove:false}), await fakeWindow(t, states, {activity:true, prove:false})];
  await fakeWindow(t, states, {activity:false});
  const targets = await activityWindows(states);
  assert.equal(targets.length, 2);
  const notice = {version:PROTOCOL, key:'codex/s-1', provider:'codex', cwd:workspace, step:{tool:'Bash', target:'ls'}};
  const started = Date.now();
  await reportActivity(targets, notice);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 100 && elapsed < 400, 'both windows are tried in parallel within the cut-off: ' + elapsed);
  assert.deepEqual(quiet.map(window => window.packets.length), [0, 0]);
  await assert.doesNotReject(reportActivity(targets, undefined));
  await assert.doesNotReject(reportActivity([{address:path.join(root, 'missing.sock'), publicKey:'x', pid:process.pid}], notice));
  assert.deepEqual(await activityWindows(path.join(root, 'missing', 'sessions')), []);
});

test('activity notices are built from the normalized hook event and keep each subagent on its own row', () => {
  const claudeChild = {session_id:'root-1', agent_id:'leaf-1', cwd:'/w', tool_name:'Bash', tool_input:{command:'ls'}};
  assert.equal(activityNotice('claude', 'PostToolUse', claudeChild, normalize('claude', 'PostToolUse', claudeChild)).key, 'claude/root-1/leaf-1');
  const codexChild = {...claudeChild, session_id:'root-2'};
  assert.equal(activityNotice('codex', 'PostToolUse', codexChild, normalize('codex', 'PostToolUse', codexChild)).key, 'codex/leaf-1');
  const stop = {session_id:'root-3', agent_id:'leaf-3', agent_type:'Explore', cwd:'/w', last_assistant_message:'Found 3 issues'};
  assert.deepEqual(activityNotice('claude', 'SubagentStop', stop, normalize('claude', 'SubagentStop', stop)),
    {version:PROTOCOL, key:'claude/root-3/leaf-3', provider:'claude', cwd:'/w', reply:'Found 3 issues'});
  for (const cwd of ['relative', '/w' + String.fromCharCode(0x202e)]) {
    const input = {...claudeChild, cwd};
    assert.equal(activityNotice('claude', 'PostToolUse', input, {...normalize('claude', 'PostToolUse', claudeChild), cwd}), undefined, cwd);
  }
  assert.equal(activityNotice('claude', 'PostToolUse', claudeChild, undefined), undefined);
  assert.equal(activityNotice('other', 'PostToolUse', claudeChild, normalize('claude', 'PostToolUse', claudeChild)), undefined);
  const hostile = {session_id:'root-1', cwd:'/w', tool_name:'Bash', get tool_input() { throw new Error('unreadable'); }};
  assert.equal(activityNotice('claude', 'PostToolUse', hostile, normalize('claude', 'PostToolUse', {session_id:'root-1', cwd:'/w'})), undefined,
    'an input that cannot be read sends nothing rather than failing the hook');
});

test('a turn reported by real hooks reaches its row step by step, and none of it is written anywhere', async t => {
  let changes = 0;
  const f = await fixture(t, {canAccept: () => false, canActivity: cwd => cwd === workspace, wantsActivity: () => true,
    activityChanged() { changes++; }});
  await fs.mkdir(f.states, {recursive:true});
  const before = new Set(await fs.readdir(f.root));
  const turn = {session_id:'turn-1', cwd:workspace};
  const id = 'claude/turn-1';
  const steps = () => f.server.activityFor(id)?.steps?.length || 0;
  const hook = (name, extra) => spawnHook(f.states, 'claude', name, {...turn, hook_event_name:name, ...extra});
  assert.equal(await hook('UserPromptSubmit', {prompt:'결제 재시도 로직을 고쳐 줘 PRIVATE-PROMPT'}), '');
  await until(() => f.server.activityFor(id)?.prompt, 'prompt');
  const calls = [['PostToolUse', {tool_name:'Bash', tool_input:{command:'pnpm test PRIVATE-COMMAND'}, tool_response:{stdout:'PRIVATE-OUTPUT'}}],
    ['PostToolUse', {tool_name:'Edit', tool_input:{file_path:workspace + '/checkout/retry.ts', old_string:'PRIVATE-OLD', new_string:'PRIVATE-NEW'}}],
    ['PostToolUseFailure', {tool_name:'Write', tool_input:{file_path:workspace + '/never.ts', content:'PRIVATE-BODY'}, error:'denied'}],
    ['PostToolUse', {tool_name:'TodoWrite', tool_input:{todos:[{content:'a', status:'completed'}, {content:'b', status:'in_progress'}]}}]];
  for (const [at, [name, extra]] of calls.entries()) {
    assert.equal(await hook(name, extra), '');
    await until(() => steps() === at + 1, 'step ' + at);
  }
  assert.equal(await hook('Stop', {last_assistant_message:'재시도를 세 번으로 제한했습니다. PRIVATE-REPLY'}), '');
  await until(() => f.server.activityFor(id)?.reply, 'reply');
  const view = f.server.activityFor(id);
  assert.equal(view.prompt, '결제 재시도 로직을 고쳐 줘 PRIVATE-PROMPT');
  assert.deepEqual(view.steps.map(({tool, target}) => [tool, target]), [['TodoWrite', ''], ['Write', 'never.ts'],
    ['Edit', 'checkout/retry.ts'], ['Bash', 'pnpm test PRIVATE-COMMAND']]);
  assert.deepEqual([view.activity.tool, view.progress, view.changed], ['TodoWrite', {done:1, total:2}, 1], 'a failed write changed nothing');
  assert.ok(changes >= 6);
  // A subagent's steps belong to its own row; the next request starts the turn over.
  assert.equal(await spawnHook(f.states, 'claude', 'PostToolUse', {...turn, agent_id:'helper-1', tool_name:'Grep',
    tool_input:{pattern:'retryCount'}}), '');
  await until(() => f.server.activityFor('claude/turn-1/helper-1'), 'subagent step');
  assert.equal(f.server.activityFor('claude/turn-1/helper-1').activity.target, 'retryCount');
  assert.equal(steps(), 4);
  assert.equal(await hook('UserPromptSubmit', {prompt:'테스트도 추가해 줘'}), '');
  await until(() => f.server.activityFor(id).prompt === '테스트도 추가해 줘', 'next prompt');
  assert.deepEqual(f.server.activityFor(id), {prompt:'테스트도 추가해 줘', reply:'재시도를 세 번으로 제한했습니다. PRIVATE-REPLY'});
  // Snapshots hold none of it, and nothing else was written.
  for (const name of await fs.readdir(f.states)) {
    assert.doesNotMatch(await fs.readFile(path.join(f.states, name), 'utf8'), /PRIVATE|pnpm|retry|TodoWrite|Grep/);
  }
  assert.deepEqual(new Set(await fs.readdir(f.root)), before);
  assert.equal((await fs.readdir(f.registry)).length, 1);
  assert.doesNotMatch(await fs.readFile(path.join(f.registry, (await fs.readdir(f.registry))[0]), 'utf8'), /PRIVATE|retry/);
});

test('activity turned off between a hook’s handshake and its notice is not kept', async t => {
  let checks = 0;
  const f = await fixture(t, {canActivity: () => checks++ === 0, wantsActivity: () => true});
  const { address } = await f.descriptor();
  const notice = {version:PROTOCOL, key:'codex/race-1', provider:'codex', cwd:workspace, reply:'late'};
  assert.equal((await exchange(address, {nonce:crypto.randomUUID(), cwd:workspace, purpose:'activity'}, {activity:notice})).length, 1, 'proved itself');
  assert.equal(checks, 2, 'asked again when the notice arrived');
  assert.equal(f.server.activityFor('codex/race-1'), undefined);
});

test('oversized inputs produce bounded read-only previews with preserved key fields, surrogate safety and bidi escapes', () => {
  const bidi = String.fromCharCode(0x202e);
  const emoji = String.fromCodePoint(0x1f600);
  const large = {
    file_path: '/repo/src/big.ts',
    description: 'Write large file ' + bidi,
    content: emoji.repeat(4000),
    old_string: 'x'.repeat(8000),
  };
  assert.equal(requestFor('claude', 'PermissionRequest', payload({ tool_name: 'Write', tool_input: large })), undefined,
    'inline approvals never accept truncated requests');
  const event = normalize('claude', 'PermissionRequest', payload({ tool_name: 'Write', tool_input: large }));
  const notice = noticeFor('claude', payload({ tool_name: 'Write', tool_input: large }), event);
  assert.ok(notice);
  assert.ok(Buffer.byteLength(notice.detail) <= 10000);
  assert.ok(!notice.detail.includes(bidi) && notice.detail.includes('\\u202e'));
  // Ensure no lone surrogate exists anywhere in the truncated JSON.
  for (let i = 0; i < notice.detail.length; i++) {
    const code = notice.detail.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = notice.detail.charCodeAt(i + 1);
      assert.ok(next >= 0xdc00 && next <= 0xdfff, 'no lone high surrogate');
      i++;
    } else {
      assert.ok(!(code >= 0xdc00 && code <= 0xdfff), 'no lone low surrogate');
    }
  }
  const parsed = JSON.parse(notice.detail);
  assert.equal(parsed.file_path, '/repo/src/big.ts');
  assert.ok(parsed._truncated.totalBytes > 10000);
  assert.equal(parsed._truncated.shownBytes, Buffer.byteLength(notice.detail));
  assert.ok(describePreview('a'.repeat(12000)).includes('_truncated'));
});

test('activityNotice carries turn and resolves files against toolCwd while keeping canonical project cwd', () => {
  const input = { session_id: 's1', prompt_id: 'turn-9', cwd: '/repo/packages/app', tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } };
  const event = { ...normalize('claude', 'PostToolUse', input), cwd: '/repo', toolCwd: '/repo/packages/app' };
  const notice = activityNotice('claude', 'PostToolUse', input, event);
  assert.equal(notice.cwd, '/repo');
  assert.equal(notice.turn, 'turn-9');
  assert.equal(notice.stepFile, '/repo/packages/app/src/a.ts');
  assert.deepEqual(notice.files, ['/repo/packages/app/src/a.ts']);

  // activityNotice forwards restart and transcriptReply options for Antigravity.
  const agyPre = { conversationId: 'ag-1', workspacePaths: ['/repo'], lastUserInput: 'Retry build' };
  const agyPreNotice = activityNotice('agy', 'PreInvocation', agyPre, normalize('agy', 'PreInvocation', agyPre), { restart: true });
  assert.equal(agyPreNotice.prompt, 'Retry build');
  assert.equal(agyPreNotice.restart, true);
  const agyStop = { conversationId: 'ag-1', workspacePaths: ['/repo'], fullyIdle: true, terminationReason: 'model_stop' };
  const agyStopNotice = activityNotice('agy', 'Stop', agyStop, normalize('agy', 'Stop', agyStop), { transcriptReply: 'Build passed.' });
  assert.equal(agyStopNotice.reply, 'Build passed.');

  // describePreview prioritizes new parity keys ahead of huge filler fields.
  const big = {
    fillerA: 'a'.repeat(5000),
    fillerB: 'b'.repeat(5000),
    questions: [{ question: 'Ship now?' }],
    planFilePath: '/repo/plan.md',
    permissions: ['network'],
    justification: 'Fetch deps',
    toolSummary: 'Run install',
    Message: 'Review this change',
  };
  const preview = JSON.parse(describePreview(big));
  assert.deepEqual(preview.questions, [{ question: 'Ship now?' }]);
  assert.equal(preview.planFilePath, '/repo/plan.md');
  assert.deepEqual(preview.permissions, ['network']);
  assert.equal(preview.justification, 'Fetch deps');
  assert.equal(preview.toolSummary, 'Run install');
  assert.equal(preview.Message, 'Review this change');
});

test('AGY Stop recovers transcript reply in memory and subsequent PreInvocation restarts cleanly without writing text to snapshots', async t => {
  const f = await fixture(t, { canAccept: () => false, canActivity: cwd => cwd === workspace, wantsActivity: () => true });
  await fs.mkdir(f.states, { recursive: true });
  const transcript = path.join(f.root, 'agy-transcript.jsonl');
  await fs.writeFile(transcript, [
    JSON.stringify({ type: 'USER_INPUT', content: 'Run tests' }),
    JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'SECRET_AGY_REPLY All 42 tests passed.' }),
  ].join('\n') + '\n');
  const base = { conversationId: 'agy-e2e', workspacePaths: [workspace] };
  assert.equal(await spawnHook(f.states, 'agy', 'PreInvocation', { ...base, lastUserInput: 'Run tests' }), '{}\n');
  await until(() => f.server.activityFor('agy/agy-e2e')?.prompt === 'Run tests', 'initial agy prompt');
  assert.equal(await spawnHook(f.states, 'agy', 'PostToolUse', { ...base, stepIdx: 1, toolCall: { name: 'run_command', args: { CommandLine: 'npm test' } } }), '{}\n');
  await until(() => f.server.activityFor('agy/agy-e2e')?.steps?.length === 1, 'agy step');
  assert.equal(await spawnHook(f.states, 'agy', 'Stop', { ...base, fullyIdle: true, terminationReason: 'model_stop', transcriptPath: transcript }), '{}\n');
  await until(() => f.server.activityFor('agy/agy-e2e')?.reply === 'SECRET_AGY_REPLY All 42 tests passed.', 'agy transcript reply');
  // Next turn with the exact same prompt restarts and clears previous steps because previous status was done.
  assert.equal(await spawnHook(f.states, 'agy', 'PreInvocation', { ...base, lastUserInput: 'Run tests' }), '{}\n');
  await until(() => f.server.activityFor('agy/agy-e2e')?.steps === undefined, 'agy restart clears prior steps');
  for (const name of await fs.readdir(f.states)) {
    assert.doesNotMatch(await fs.readFile(path.join(f.states, name), 'utf8'), /SECRET_AGY_REPLY|npm test|Run tests/);
  }
});

test('findWindowForFolder matches live descriptors by directory boundary and forgetDeparted removes dead asm-ui dirs', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-meta-win-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const states = path.join(root, 'sessions');
  const registry = path.join(root, 'approval-windows');
  await fs.mkdir(registry, { recursive: true, mode: 0o700 });
  const writeDesc = obj => fs.writeFile(path.join(registry, crypto.randomUUID() + '.json'), JSON.stringify(obj), { mode: 0o600 });

  const repoUri = 'vscode://local-tools.agent-session-monitor/focus?windowId=1';
  const appUri = 'vscode-insiders://local-tools.agent-session-monitor/focus?windowId=2';
  await writeDesc({
    address: '/tmp/asm-ui-live/ui.sock', pid: process.pid, publicKey: 'k',
    workspaceFolders: ['/work/repo'], windowUri: repoUri,
  });
  await writeDesc({
    address: '/tmp/asm-ui-nested/ui.sock', pid: process.pid, publicKey: 'k',
    workspaceFolders: ['/work/repo/packages/app'], windowUri: appUri,
  });
  assert.deepEqual(await findWindowForFolder(states, '/work/repo/src'), { windowUri: repoUri, workspaceRoot: '/work/repo' });
  assert.deepEqual(await findWindowForFolder(states, '/work/repo/packages/app/src'),
    { windowUri: appUri, workspaceRoot: '/work/repo/packages/app' }, 'prefers most specific root');
  assert.equal(await findWindowForFolder(states, '/work/repo-sibling'), undefined, 'respects directory boundaries');
  assert.equal(await findWindowForFolder(states, 'relative'), undefined);
  // A link in any other scheme is never offered, and a deeper window without a usable link
  // does not displace one that can be focused.
  await writeDesc({
    address: '/tmp/asm-ui-deeper/ui.sock', pid: process.pid, publicKey: 'k',
    workspaceFolders: ['/work/repo/packages/app/src'], windowUri: 'javascript://x/alert(1)',
  });
  await writeDesc({
    address: '/tmp/asm-ui-file/ui.sock', pid: process.pid, publicKey: 'k',
    workspaceFolders: ['/work/other'], windowUri: 'file:///work/other',
  });
  assert.deepEqual(await findWindowForFolder(states, '/work/repo/packages/app/src/index'),
    { windowUri: appUri, workspaceRoot: '/work/repo/packages/app' });
  assert.deepEqual(await findWindowForFolder(states, '/work/other/a'), { windowUri: undefined, workspaceRoot: '/work/other' });

  // Spawn and exit a short-lived process to get a guaranteed dead PID for forgetDeparted.
  const child = spawn(process.execPath, ['-e', '']);
  const deadPid = child.pid;
  await new Promise(resolve => child.once('exit', resolve));
  const deadSockDir = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-ui-'));
  const deadSock = path.join(deadSockDir, 'ui.sock');
  await fs.writeFile(deadSock, '');
  const unrelatedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-keep-'));
  t.after(() => fs.rm(unrelatedDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(unrelatedDir, 'ui.sock'), '');

  await writeDesc({ address: deadSock, pid: deadPid, publicKey: 'k' });
  await writeDesc({ address: path.join(unrelatedDir, 'ui.sock'), pid: deadPid, publicKey: 'k' });
  await forgetDeparted(registry);
  await assert.rejects(fs.stat(deadSockDir), { code: 'ENOENT' }, 'owned asm-ui-* socket directory is cleaned up');
  await fs.stat(unrelatedDir);
});

test('AGY soft_wait, Claude ExitPlanMode PreToolUse and Codex request_permissions PreToolUse announce previews in RAM without disk leaks', async t => {
  const f = await fixture(t, { canAccept: () => false, canNotice: cwd => cwd === workspace });
  await fs.mkdir(f.states, { recursive: true });
  const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-agy-home-'));
  t.after(() => fs.rm(fakeHome, { recursive: true, force: true }));
  const spawnWithHome = (provider, event, input) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [source, provider, event, f.states], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: fakeHome, CLAUDE_CODE_ENTRYPOINT: 'cli' },
    });
    let stdout = '', stderr = '';
    child.once('error', reject);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.once('close', code => code !== 0 || stderr ? reject(new Error('Hook error: ' + code + stderr)) : resolve(stdout));
    child.stdin.end(JSON.stringify(input));
  });

  // 1. AGY run_command(BypassSandbox: true) keeps {"decision":"allow"}, records pendingSoft (no command text), and sends preview in RAM.
  const deployInput = {
    conversationId: 'agy-deploy', workspacePaths: [workspace], stepIdx: 42,
    toolCall: { name: 'run_command', args: {
      CommandLine: 'vercel deploy --yes PRIVATE_SECRET_TOKEN',
      BypassSandbox: true, WaitMsBeforeAsync: 10000, toolSummary: 'Deploy Vercel Preview',
    } },
  };
  assert.equal(await spawnWithHome('agy', 'PreToolUse', deployInput), '{"decision":"allow"}\n');
  const preview = f.server.previewFor('agy/agy-deploy');
  assert.equal(preview?.tool, 'run_command');
  assert.match(preview?.detail || '', /Deploy Vercel Preview/);
  assert.match(preview?.detail || '', /vercel deploy/);
  // Verify noticeFor accepts soft_wait directly.
  const softEv = normalize('agy', 'PreToolUse', deployInput, { homeDir: fakeHome });
  assert.equal(softEv.action, 'soft_wait');
  assert.equal(noticeFor('agy', deployInput, softEv)?.ref, softEv.key);

  // 2. Under Turbo mode, AGY run_command creates no pendingSoft and sends no preview.
  await fs.mkdir(path.join(fakeHome, '.gemini', 'config'), { recursive: true });
  await fs.writeFile(path.join(fakeHome, '.gemini', 'config', 'config.json'),
    JSON.stringify({ userSettings: { permissionPreset: 'AGENT_PERMISSION_PRESET_TURBO' } }));
  assert.equal(await spawnWithHome('agy', 'PreToolUse', { ...deployInput, conversationId: 'agy-turbo' }), '{"decision":"allow"}\n');
  assert.equal(f.server.previewFor('agy/agy-turbo'), undefined);

  // 3. Claude ExitPlanMode PreToolUse and Codex request_permissions PreToolUse deliver previews cleanly.
  assert.equal(await spawnWithHome('claude', 'PreToolUse', {
    session_id: 'plan-1', cwd: workspace, tool_name: 'ExitPlanMode', tool_input: { plan: '# Secret Plan Body' },
  }), '');
  assert.equal(f.server.previewFor('claude/plan-1')?.tool, 'ExitPlanMode');
  assert.equal(await spawnWithHome('codex', 'PreToolUse', {
    session_id: 'perm-1', cwd: workspace, turn_id: 't1', tool_name: 'request_permissions',
    tool_input: { reason: 'Network access', permissions: { network: { enabled: true } } },
  }), '');
  assert.equal(f.server.previewFor('codex/perm-1')?.tool, 'request_permissions');

  // Disk snapshots contain zero private strings.
  for (const name of await fs.readdir(f.states)) {
    const raw = await fs.readFile(path.join(f.states, name), 'utf8');
    assert.doesNotMatch(raw, /PRIVATE_SECRET_TOKEN|vercel deploy|Secret Plan Body|Network access/);
  }
});

test('unshown or unrecorded inline requests hand back immediately instead of trapping the hook', async t => {
  const workspace = '/fixture/workspace';
  const f = await fixture(t, { canAccept: (cwd, _provider, req) => cwd === workspace && req?.key !== 'claude/masked' });
  const masked = requestFor('claude', 'PermissionRequest', {
    session_id: 'masked', cwd: workspace, hook_event_name: 'PermissionRequest',
    tool_name: 'Bash', tool_input: { command: 'ls' },
  });
  masked.ref = 'refmasked';
  assert.deepEqual(await ask(f.states, masked), { accepted: false }, 'canAccept can refuse a request masked by an existing input wait');

  // An accepted request that does not appear in shownActionKeys by the time a later scan completes is deferred immediately.
  const stuck = requestFor('claude', 'PermissionRequest', {
    session_id: 'stuck-1', cwd: workspace, hook_event_name: 'PermissionRequest',
    tool_name: 'Bash', tool_input: { command: 'echo ok' },
  });
  stuck.ref = 'refstuck';
  const asking = ask(f.states, stuck);
  await f.action('claude/stuck-1');
  f.server.deferUnshown(new Set(), Date.now() + 10);
  const reply = await asking;
  assert.deepEqual(reply, { accepted: true, choice: undefined });
  assert.equal(f.server.forSession('claude/stuck-1'), undefined);

  // A real hook whose wait was ignored by advance() (e.g. stale same-turn wait after Stop) returns immediately without blocking.
  const turn = { session_id: 'done-fast', cwd: workspace, prompt_id: 't1' };
  await spawnHook(f.states, 'claude', 'UserPromptSubmit', { ...turn, hook_event_name: 'UserPromptSubmit' });
  await spawnHook(f.states, 'claude', 'Stop', { ...turn, hook_event_name: 'Stop', last_assistant_message: 'ok' });
  const started = Date.now();
  const out = await spawnHook(f.states, 'claude', 'PermissionRequest', {
    ...turn, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'echo late' },
  });
  assert.equal(out, '');
  assert.ok(Date.now() - started < 5000, 'ignored wait must not trap hook for inline window');
  assert.equal(f.server.forSession('claude/done-fast'), undefined);
});
