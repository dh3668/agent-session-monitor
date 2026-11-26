'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const hook = require('../src/hook.cjs');
const script = require.resolve('../src/hook.cjs');

function claude(name, fields = {}) {
  return hook.normalize('claude', name, {
    session_id: 'claude-1', hook_event_name: name, prompt_id: 'turn-1', cwd: '/repo', ...fields,
  });
}

function agy(name, fields = {}) {
  return hook.normalize('agy', name, {
    conversationId: 'agy-1', workspacePaths: ['/repo'], ...fields,
  });
}

function run(state, provider, name, input, { preload, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const args = preload ? ['--require', preload, script, provider, name, state] : [script, provider, name, state];
    const child = spawn(process.execPath, args, { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

async function tempState(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-hook-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('two parallel approvals survive unrelated tool results and delayed generic notifications', () => {
  const update = (row, event) => hook.advance(row, event, 5);
  const permission = command => claude('PermissionRequest', {
    tool_name: 'Bash', tool_input: { command, description: 'private input' },
  });
  const result = command => claude('PostToolUse', { tool_name: 'Bash', tool_input: { command } });
  let row = update(undefined, claude('UserPromptSubmit'));
  row = update(row, permission('first'));
  row = update(row, permission('second'));
  assert.equal(Object.keys(row.pending).length, 2);
  assert.equal(update(row, result('other')), row);
  assert.equal(update(row, claude('Notification', { notification_type: 'permission_prompt' })), row);
  row = update(row, result('first'));
  assert.equal(row.status, 'approval');
  row = update(row, result('second'));
  assert.equal(row.status, 'working');
  assert.equal(row.pending, undefined);
  assert.ok(row.updatedAt > 5);
});

test('Claude questions, MCP prompts and a generic permission notification have distinct states', () => {
  const question = { tool_name: 'AskUserQuestion', tool_input: { questions: ['private input'] } };
  let row = hook.advance(null, claude('PreToolUse', question), 10);
  assert.equal(row.status, 'input');
  row = hook.advance(row, claude('PostToolUseFailure', question), 12);
  assert.equal(row.status, 'working');
  row = hook.advance(row, claude('Notification', { notification_type: 'elicitation_dialog' }), 13);
  assert.equal(row.status, 'input');
  row = hook.advance(row, claude('Notification', { notification_type: 'elicitation_response' }), 14);
  assert.equal(row.status, 'working');
  row = hook.advance(row, claude('Notification', { notification_type: 'permission_prompt' }), 15);
  assert.equal(row.status, 'approval');
  assert.equal(hook.advance(row, claude('Stop'), 16).status, 'done');
  assert.equal(claude('Notification', { notification_type: 'idle_prompt' }), undefined);
});

test('turn boundaries, compact events, terminal statuses, and subagents', () => {
  let row = hook.advance(null, claude('UserPromptSubmit'), 10);
  const next = hook.advance(row, claude('UserPromptSubmit', { prompt_id: 'turn-2' }), 11);
  assert.equal(hook.advance(next, claude('Stop'), 12), next);
  assert.equal(hook.advance(next, claude('SessionStart', { source: 'compact' }), 12), next);
  assert.equal(claude('SubagentStop'), undefined);
  assert.equal(claude('Stop', { agent_id: 'child' }), undefined);
  row = hook.advance(row, claude('StopFailure'), 12);
  assert.equal(row.status, 'error');
  assert.equal(hook.advance(row, claude('SessionEnd'), 13), row);
  assert.equal(hook.advance(row, claude('PostToolUse'), 13), row);
});

test('Google workspace and explicit question/permission tools; only a fully idle Stop finishes', () => {
  let row = hook.advance(null, agy('PreInvocation'), 1);
  assert.equal(row.cwd, '/repo');
  const tool = { toolCall: { name: 'ask_question', args: { questions: ['private input'] } }, stepIdx: 2 };
  row = hook.advance(row, agy('PreToolUse', tool), 2);
  assert.equal(row.status, 'input');
  row = hook.advance(row, agy('PostToolUse', tool), 3);
  assert.equal(row.status, 'working');
  assert.equal(agy('PreToolUse', { toolCall: { name: 'run_command' } }), undefined);
  row = hook.advance(row, agy('PreToolUse', { toolCall: { name: 'ask_permission' }, stepIdx: 5 }), 4);
  assert.equal(row.status, 'approval');
  row = hook.advance(row, agy('Stop', { fullyIdle: false }), 5);
  assert.equal(row.status, 'approval');
  assert.equal(agy('Stop'), undefined);
  assert.equal(hook.advance(row, agy('Stop', { terminationReason: 'model_stop' }), 6).status, 'done');
  assert.equal(hook.advance(row, agy('Stop', { fullyIdle: true }), 6).status, 'done');
  assert.equal(hook.advance(row, agy('Stop', { terminationReason: 'error', error: 'private' }), 6).status, 'error');
});

test('a long-running turn refreshes its heartbeat without hashing unrelated tool arguments', () => {
  const first = hook.advance(null, claude('UserPromptSubmit'), 1000);
  const payload = { tool_name: 'Bash', get tool_input() { throw Error('unnecessary argument access'); } };
  const result = hook.normalize('claude', 'PostToolUse',
    Object.assign(Object.create(payload), { session_id: 'claude-1', cwd: '/repo', prompt_id: 'turn-1' }));
  assert.equal(hook.advance(first, result, 50999), first);
  assert.equal(hook.advance(first, result, 601000).updatedAt, 601000);
});

test('invalid IDs, unrecognized events, malformed paths and mismatched event names', () => {
  assert.equal(claude('Stop', { session_id: '../../outside' }), undefined);
  assert.equal(claude('Notification', { hook_event_name: 'Stop', notification_type: 'permission_prompt' }), undefined);
  assert.equal(claude('Bogus'), undefined);
  assert.equal(hook.normalize('__proto__', 'Stop', {}), undefined);
  assert.equal(agy('PreInvocation', { workspacePaths: ['relative', '/valid'] }).cwd, '/valid');
  assert.equal(claude('UserPromptSubmit', { cwd: 'relative' }).cwd, '');
});

test('separate hook processes serialize the same session and store only allowlisted metadata', async t => {
  const state = await tempState(t);
  const common = {
    session_id: 'codex-1', cwd: '/repo', turn_id: 'turn-1',
    transcript_path: '/private-transcript', last_assistant_message: 'private answer', prompt: 'private input',
  };
  const commands = Array.from({ length: 6 }, (_, i) => 'private command #' + i);
  const inputs = commands.map(command => ({ ...common, tool_name: 'Bash', tool_input: { command } }));
  const results = await Promise.all(inputs.map(input => run(state, 'codex', 'PermissionRequest', input)));
  for (const result of results) assert.deepEqual(result, { code: 0, stdout: '', stderr: '' });
  const files = await fs.readdir(state);
  assert.equal(files.length, 1);
  assert.match(files[0], /^[0-9a-f]{64}\.json$/);
  const filename = path.join(state, files[0]);
  const contents = await fs.readFile(filename, 'utf8');
  assert.doesNotMatch(contents, /private|Bash|tool_input|last_assistant|transcript|prompt/);
  assert.equal(Object.keys(JSON.parse(contents).pending).length, 6);
  if (process.platform !== 'win32') assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
  await Promise.all(inputs.map(input => run(state, 'codex', 'PostToolUse', input)));
  assert.equal(JSON.parse(await fs.readFile(filename, 'utf8')).status, 'working');
  assert.deepEqual(await run(state, 'codex', 'Stop', common), { code: 0, stdout: '{}\n', stderr: '' });
  assert.equal(JSON.parse(await fs.readFile(filename, 'utf8')).status, 'done');
});

test('CLI ignores malformed data and disk errors without exposing contents or affecting permission decisions', async t => {
  const state = await tempState(t);
  assert.deepEqual(await run(state, 'claude', 'PermissionRequest', '{private'), { code: 0, stdout: '', stderr: '' });
  assert.deepEqual(await fs.readdir(state), []);
  assert.deepEqual(await run(state, 'agy', 'PreToolUse', '{malformed'), {
    code: 0, stdout: '{"decision":"allow"}\n', stderr: '',
  });
  const file = path.join(state, 'existing-file');
  await fs.writeFile(file, 'fixture');
  assert.deepEqual(await run(file, 'codex', 'PermissionRequest', {
    session_id: 'codex-1', tool_name: 'Bash', tool_input: { command: 'private' },
  }), { code: 0, stdout: '', stderr: '' });
});

test('child lifecycle and child approvals keep their own row and never overwrite the parent', async t => {
  const state = await tempState(t);
  const { readSessions } = require('../src/model.cjs');
  for (const provider of ['claude','codex']) {
    const main = {session_id:'root',cwd:'/repo',prompt_id:'turn1'};
    const child = {...main,agent_id:'child1',agent_type:'Reviewer',last_assistant_message:'private answer',agent_transcript_path:'/private/path'};
    await run(state,provider,'PermissionRequest',{...main,tool_name:'Bash',tool_input:{command:'private command'}});
    await run(state,provider,'SubagentStart',child);
    const key = provider === 'claude' ? 'claude/root/child1' : 'codex/child1';
    let rows = await readSessions(state);
    assert.equal(rows.find(r=>r.key===key).status,'working');
    await run(state,provider,'PermissionRequest',{...child,tool_name:'Bash',tool_input:{command:'private command'}});
    rows = await readSessions(state);
    assert.equal(rows.find(r=>r.key===key).status,'approval');
    const response = await run(state,provider,'SubagentStop',child);
    assert.deepEqual(response,{code:0,stderr:'',stdout:provider==='codex'?'{}\n':''});
    rows = await readSessions(state);
    assert.equal(rows.find(r=>r.key===provider+'/root').status,'approval');
    const leaf = rows.find(r=>r.key===key);
    assert.equal(leaf.parentKey,provider+'/root');
    assert.equal(leaf.status,'done');
    assert.ok(leaf.completedAt);
    assert.equal(leaf.replyAt, undefined);
    assert.equal(leaf.title,'Reviewer');
    assert.equal(leaf.canOpen,provider!=='claude');
  }
  await run(state,'claude','SubagentStart',{session_id:'other-root',agent_id:'child1',agent_type:'Reviewer'});
  const rows = await readSessions(state);
  assert.equal(rows.length,5);
  assert.ok(rows.some(r=>r.key==='claude/other-root/child1' && r.status==='working'));
  for (const file of await fs.readdir(state)) {
    assert.doesNotMatch(await fs.readFile(path.join(state,file),'utf8'),/private|transcript|last_assistant|command/);
  }
});

test('the oldest outstanding request of the displayed kind owns waitSince across interleaved tools', () => {
  const tool = (name, number) => ({tool_name: name, tool_input: {n: number}});
  const approve = tool('Read', 0), first = tool('AskUserQuestion', 1), second = tool('AskUserQuestion', 2);
  let row = hook.advance(null, claude('UserPromptSubmit'), 100);
  row = hook.advance(row, claude('PermissionRequest', approve), 120);
  row = hook.advance(row, claude('PreToolUse', first), 140);
  row = hook.advance(row, claude('PreToolUse', second), 160);
  assert.deepEqual([row.status, row.waitSince, row.workSince], ['input', 140, 100]);
  assert.equal(hook.advance(row, claude('PermissionRequest', first), 170), row);
  assert.equal(hook.advance(row, claude('UserPromptSubmit'), 171), row);
  assert.equal(hook.advance(row, claude('Notification', {notification_type:'permission_prompt'}), 175), row);
  row = hook.advance(row, claude('PostToolUse', first), 180);
  assert.equal(row.waitSince, 160);
  row = hook.advance(row, claude('PostToolUse', second), 200);
  assert.deepEqual([row.status, row.waitSince], ['approval', 120]);
  row = hook.advance(row, claude('PostToolUse', approve), 220);
  assert.deepEqual([row.status, row.waitSince, row.workSince], ['working', undefined, 100]);
});

test('a question and a generic permission survive independently until their matching result', () => {
  const ask = {tool_name:'AskUserQuestion', tool_input:{id:1}};
  let row = hook.advance(null, claude('Notification', {notification_type:'permission_prompt'}), 30);
  row = hook.advance(row, claude('PreToolUse', ask), 40);
  assert.deepEqual([row.status, row.waitSince], ['input', 40]);
  row = hook.advance(row, claude('PostToolUse', ask), 50);
  assert.deepEqual([row.status, row.waitSince], ['approval', 30]);
  const permission = {tool_name:'Read', tool_input:{id:2}};
  row = hook.advance(row, claude('PermissionRequest', permission), 60);
  assert.equal(row.waitSince, 30);
  assert.equal(hook.advance(row, claude('PostToolUse', permission), 70).status, 'working');
});

test('only an observed successful root reply can advance replyAt, independent of heartbeat and settings', () => {
  let row = hook.advance(null, claude('SessionStart', {model:'claude-sonnet-4-6'}), 10);
  assert.deepEqual(row.execution, {model:'claude-sonnet-4-6', modelSource:'setting', modelAt:10});
  row = hook.advance(row, claude('UserPromptSubmit'), 20);
  row = hook.advance(row, claude('PostToolUse', {tool_name:'Read', effort:{level:'medium', tokenBudget:100}}), 600021);
  assert.deepEqual([row.replyAt, row.workSince, row.execution.effort, row.execution.effortAt], [undefined, 20, 'medium', 600021]);
  row = hook.advance(row, claude('Stop', {last_assistant_message:'private answer'}), 600030);
  assert.equal(row.replyAt, 600030);
  assert.equal(hook.advance(row, claude('Stop', {last_assistant_message:'private answer'}), 600040), row);
  const switched = hook.advance(row, claude('PostModelSwitch', {from_model:'unused', to_model:'claude-opus-4-7'}), 600050);
  assert.deepEqual([switched.status, switched.replyAt, switched.updatedAt, switched.execution.modelAt], ['done', 600030, 600030, 600050]);
  assert.doesNotMatch(JSON.stringify(switched), /private|tokenBudget|unused/);
  let next = hook.advance(switched, claude('UserPromptSubmit', {prompt_id:'turn-2'}), 600060);
  assert.equal(next.workSince, 600060);
  assert.equal(hook.advance(next, claude('UserPromptSubmit'), 600065), next);
  assert.equal(hook.advance(next, claude('Stop', {last_assistant_message:'old answer'}), 600070), next);
  next = hook.advance(next, claude('StopFailure', {prompt_id:'turn-2'}), 600080);
  assert.equal(next.replyAt, 600030);
  assert.equal(hook.advance(next, claude('Stop', {prompt_id:'turn-2', last_assistant_message:'late answer'}), 600090), next);
  const blank = hook.advance(null, claude('Stop', {last_assistant_message:' '}), 10);
  assert.deepEqual([blank.status, blank.replyAt], ['done', undefined]);
});

test('Codex canceled turns cannot announce a replay; child model and completion stay on the child', () => {
  const event = (name, more={}) => hook.normalize('codex',name,{session_id:'root',turn_id:'one',...more});
  const interrupted = hook.advance(null, event('Interrupt', {model:'gpt-6'}), 30);
  assert.equal(hook.advance(interrupted,event('Stop',{last_assistant_message:'late'}),40),interrupted);
  const next = hook.advance(interrupted,event('UserPromptSubmit',{turn_id:'two',model:'gpt-6.2'}),50);
  assert.deepEqual([next.status, next.execution.model, next.workSince], ['working', 'gpt-6.2', 50]);
  const child = {agent_id:'leaf',agent_type:'reviewer',model:'gpt-6-mini'};
  let leaf = hook.advance(null,event('SubagentStart',child),70);
  leaf = hook.advance(leaf,event('SubagentStop',{...child, turn_id:'child-turn'}),80);
  assert.deepEqual([leaf.completedAt,leaf.replyAt,leaf.execution.model,leaf.parentSessionId], [80,undefined,'gpt-6-mini','root']);
});

test('Antigravity reads canonical call variants, preserves waits and never infers effort from a model label', () => {
  let row = hook.advance(null, agy('PreInvocation', {modelName:'gemini-3.6-flash-medium', lastUserInput:'private'}), 50);
  assert.deepEqual(row.execution, {model:'gemini-3.6-flash-medium', modelAt:50, modelSource:'call', effort:'medium', effortAt:50, effortSource:'call'});
  const ask = {toolCall:{name:'ask_question'},stepIdx:10};
  row = hook.advance(row, agy('PreToolUse', ask), 60);
  row = hook.advance(row, agy('PreInvocation', {modelName:'gemini-3.6-flash-thinking'}), 70);
  assert.deepEqual([row.status,row.waitSince,row.workSince,row.execution.effort], ['input',60,50,undefined]);
  assert.equal(row.execution.modelAt,70);
  assert.equal(row.updatedAt,60);
  const ended = fields => hook.advance(row, agy('Stop', fields), 80);
  assert.equal(ended({fullyIdle:true, terminationReason:'model_stop'}).replyAt,80);
  assert.equal(ended({fullyIdle:false, terminationReason:'model_stop'}).replyAt,undefined);
  assert.equal(ended({fullyIdle:true}).replyAt,undefined);
  assert.equal(ended({fullyIdle:true, terminationReason:'error'}).replyAt,undefined);
  assert.deepEqual([ended({fullyIdle:true, terminationReason:'cancelled'}).status, ended({fullyIdle:true, terminationReason:'cancelled'}).replyAt], ['idle',undefined]);
  assert.equal(agy('PreInvocation',{modelName:'private user text'}).execution,undefined);
  assert.equal(claude('SessionStart',{model:'inherit'}).execution,undefined);
  assert.equal(claude('PostModelSwitch',{to_model:'claude-opus-4-6[1m]'}).execution.model,'claude-opus-4-6[1m]');
});

test('Antigravity stores bounded, distinct local roots and replaces the list when a session changes workspaces',()=>{
  const {toSession} = require('../src/model.cjs');
  const event = (name,attributes={}) => hook.normalize('agy',name,{conversationId:'multi', ...attributes});
  const folders=['relative','file:///invalid','/a','/b/./c','/a','/c\0bad'];
  let snapshot = hook.advance(undefined,event('SessionStart',{workspacePaths:folders}),1);
  assert.equal(snapshot.cwd,'/a');
  assert.deepEqual(toSession(snapshot,1).workspacePaths,['/a','/b/c']);
  snapshot=hook.advance(snapshot,event('PreInvocation'),2);
  assert.deepEqual(snapshot.workspacePaths,['/a','/b/c']);
  snapshot=hook.advance(snapshot,event('SessionStart',{workspacePaths:['/d']}),3);
  assert.equal(snapshot.status,'working'); assert.deepEqual(snapshot.workspacePaths,['/d']);
  snapshot=hook.advance(snapshot,event('SessionStart',{workspacePaths:[]}),4);
  assert.equal(snapshot.cwd,''); assert.deepEqual(snapshot.workspacePaths,[]);
  const {workspacePaths,...legacy}=snapshot; legacy.cwd='/old';
  assert.equal(toSession(legacy,5).cwd,'/old'); assert.equal(toSession(legacy,5).workspacePaths,undefined);
  const extras=Array.from({length:150},(_,i)=>'/'+i+'가'.repeat(400));
  const many=event('SessionStart',{workspacePaths:extras}).workspacePaths;
  assert.ok(many.length>1 && many.length<33);
  assert.ok(Buffer.byteLength(JSON.stringify(many))<16500);
  assert.ok(!('workspacePaths' in toSession({...snapshot,provider:'claude'},5)));
});

test('a display-only notice names exactly the row the monitor builds from the stored snapshot', async t => {
  const state = await tempState(t);
  const { readSessions } = require('../src/model.cjs');
  const { noticeFor } = require('../src/manual.cjs');
  const cases = [
    ['claude', 'PermissionRequest', {session_id:'root', agent_id:'leaf', cwd:'/repo', tool_name:'Bash', tool_input:{command:'ls'}}],
    ['claude', 'PreToolUse', {session_id:'solo', cwd:'/repo', tool_name:'AskUserQuestion', tool_input:{questions:[]}}],
    ['codex', 'PermissionRequest', {session_id:'root', agent_id:'leaf', cwd:'/repo', tool_name:'Bash', tool_input:{command:'ls'}}],
    ['codex', 'PreToolUse', {session_id:'solo', cwd:'/repo', tool_name:'request_user_input', tool_input:{questions:[]}}],
    ['agy', 'PreToolUse', {conversationId:'conv', workspacePaths:['/repo'], stepIdx:3, toolCall:{name:'ask_question', args:{q:1}}}],
  ];
  for (const [provider, name, input] of cases) {
    const event = hook.normalize(provider, name, input);
    await hook.record(state, event);
    const notice = noticeFor(provider, input, event);
    const row = (await readSessions(state)).find(r => r.key === notice.key);
    assert.ok(row, provider + ' ' + name + ' → ' + notice.key);
    assert.ok(['input', 'approval'].includes(row.status));
    assert.deepEqual(row.pendingRefs, [notice.ref], 'the notice correlates with its own outstanding request');
  }
});

test('a hook without an absolute state directory contacts nothing and keeps its output', async t => {
  const state = await tempState(t);
  const input = {conversationId:'conv', workspacePaths:['/repo'], stepIdx:3, toolCall:{name:'ask_permission', args:{}}};
  assert.deepEqual(await run('relative-state', 'agy', 'PreToolUse', input), {code:0, stdout:'{"decision":"allow"}\n', stderr:''});
  assert.deepEqual(await run(state, 'agy', 'PostToolUse', input), {code:0, stdout:'{}\n', stderr:''});
  assert.deepEqual(await run(state, 'codex', 'SubagentStop', {session_id:'root', agent_id:'leaf'}), {code:0, stdout:'{}\n', stderr:''});
});

// What every hook prints, by provider and event; most print nothing. Activity must never change it.
const PRINTED = [
  ['agy', 'SessionStart', {conversationId:'agy-1', workspacePaths:['/repo']}, '{}\n'],
  ['agy', 'PreInvocation', {conversationId:'agy-1', workspacePaths:['/repo'], lastUserInput:'Fix the test', modelName:'gemini-3.6-flash'}, '{}\n'],
  ['agy', 'PreToolUse', {conversationId:'agy-1', workspacePaths:['/repo'], stepIdx:3, toolCall:{name:'ask_permission', args:{path:'/repo/a'}}}, '{"decision":"allow"}\n'],
  ['agy', 'PreToolUse', {conversationId:'agy-1', workspacePaths:['/repo'], stepIdx:4, toolCall:{name:'ask_question', args:{}}}, '{"decision":"allow"}\n'],
  ['agy', 'PostToolUse', {conversationId:'agy-1', workspacePaths:['/repo'], stepIdx:4, toolCall:{name:'ask_question', args:{}}}, '{}\n'],
  ['agy', 'Stop', {conversationId:'agy-1', workspacePaths:['/repo'], fullyIdle:true, terminationReason:'model_stop'}, '{}\n'],
  ['codex', 'UserPromptSubmit', {session_id:'codex-1', cwd:'/repo', turn_id:'t1', prompt:'fix it'}, ''],
  ['codex', 'PostToolUse', {session_id:'codex-1', cwd:'/repo', turn_id:'t1', tool_name:'Bash', tool_input:{command:'ls'}}, ''],
  ['codex', 'PermissionRequest', {session_id:'codex-1', cwd:'/repo', turn_id:'t1', tool_name:'Bash', tool_input:{command:'rm x'}}, ''],
  ['codex', 'Stop', {session_id:'codex-1', cwd:'/repo', turn_id:'t1', last_assistant_message:'done'}, '{}\n'],
  ['codex', 'SubagentStop', {session_id:'codex-1', cwd:'/repo', agent_id:'leaf', last_assistant_message:'found it'}, '{}\n'],
  ['claude', 'UserPromptSubmit', {session_id:'claude-1', cwd:'/repo', prompt:'고쳐 줘'}, ''],
  ['claude', 'PostToolUse', {session_id:'claude-1', cwd:'/repo', tool_name:'Edit', tool_input:{file_path:'/repo/a.ts', old_string:'a', new_string:'b'}}, ''],
  ['claude', 'PostToolUseFailure', {session_id:'claude-1', cwd:'/repo', tool_name:'Bash', tool_input:{command:'false'}, error:'Exit code 1'}, ''],
  ['claude', 'PreToolUse', {session_id:'claude-1', cwd:'/repo', tool_name:'AskUserQuestion', tool_input:{questions:[]}}, ''],
  ['claude', 'Notification', {session_id:'claude-1', cwd:'/repo', notification_type:'permission_prompt'}, ''],
  ['claude', 'SubagentStop', {session_id:'claude-1', cwd:'/repo', agent_id:'leaf', agent_type:'Explore', last_assistant_message:'found it'}, ''],
  ['claude', 'StopFailure', {session_id:'claude-1', cwd:'/repo', last_assistant_message:'API Error: Rate limit reached'}, ''],
  ['claude', 'Stop', {session_id:'claude-1', cwd:'/repo', last_assistant_message:'고쳤습니다.'}, ''],
];
// A fixed environment: the Claude inline-request path is not what these tests are about.
function runQuiet(state, provider, name, input) {
  const env = {...process.env};
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, provider, name, state], {env});
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}
async function descriptorFor(state, fields) {
  const registry = path.join(path.dirname(state), 'approval-windows');
  await fs.mkdir(registry, {recursive:true, mode:0o700});
  const { publicKey } = require('node:crypto').generateKeyPairSync('ed25519');
  await fs.writeFile(path.join(registry, require('node:crypto').randomUUID() + '.json'), JSON.stringify({pid:process.pid,
    publicKey:publicKey.export({type:'spki', format:'pem'}), activity:true, ...fields}), {mode:0o600});
}

test('every provider and event prints exactly what it printed before, whatever the windows are doing', async t => {
  const { listen } = require('../src/manual.cjs');
  const net = require('node:net');
  const situations = {
    'no window': async () => {},
    'a window that wants activity': async state => {
      const server = await listen(state, {canAccept: () => false, canNotice: () => true, canActivity: () => true, wantsActivity: () => true, changed() {}});
      t.after(() => server.dispose());
    },
    'a stalled window': async state => {
      const address = path.join(path.dirname(state), 'stalled.sock');
      const sockets = new Set();
      const server = net.createServer(socket => { sockets.add(socket); socket.on('error', () => {}); });
      await new Promise(resolve => server.listen(address, resolve));
      t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
      await descriptorFor(state, {address});
    },
    // A live window whose socket file is gone, as after the temporary folder was cleaned.
    'a window whose socket is gone': state => descriptorFor(state, {address:path.join(path.dirname(state), 'gone', 'ui.sock')}),
  };
  for (const [situation, prepare] of Object.entries(situations)) {
    const root = await tempState(t);
    const state = path.join(root, 'sessions');
    await prepare(state);
    for (const [provider, name, input, printed] of PRINTED) {
      assert.deepEqual(await runQuiet(state, provider, name, {hook_event_name:name, ...input}), {code:0, stdout:printed, stderr:''},
        situation + ': ' + provider + ' ' + name);
    }
  }
});

test('a hook that is already slow skips the activity notice; a prompt one sends it', async t => {
  const { createHash } = require('node:crypto');
  const { listen } = require('../src/manual.cjs');
  const root = await tempState(t);
  const state = path.join(root, 'sessions');
  const server = await listen(state, {canAccept: () => false, canActivity: () => true, wantsActivity: () => true, changed() {}});
  t.after(() => server.dispose());
  await fs.mkdir(state, {recursive:true});
  // Another hook of the same session holds the snapshot lock for 1.6 s.
  const lock = path.join(state, createHash('sha256').update('claude:slow-1').digest('hex') + '.lock');
  await fs.mkdir(lock);
  const input = {session_id:'slow-1', cwd:'/repo', tool_name:'Bash', tool_input:{command:'make'}};
  const slow = runQuiet(state, 'claude', 'PostToolUse', input);
  setTimeout(() => fs.rmdir(lock).catch(() => {}), 1600);
  assert.deepEqual(await slow, {code:0, stdout:'', stderr:''});
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(server.activityFor('claude/slow-1'), undefined, 'past its budget the hook sent nothing');
  assert.deepEqual(await runQuiet(state, 'claude', 'PostToolUse', input), {code:0, stdout:'', stderr:''});
  for (let i = 0; i < 100 && !server.activityFor('claude/slow-1'); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(server.activityFor('claude/slow-1').activity.target, 'make');
});

test('StopFailure records only an allowlisted errorReason on disk and clears it on the next turn', async t => {
  const state = await tempState(t);
  let row = hook.advance(null, claude('UserPromptSubmit'), 10);
  row = hook.advance(row, claude('StopFailure', { error: 'rate_limit', error_details: 'SECRET token limit detail' }), 20);
  assert.equal(row.status, 'error');
  assert.equal(row.errorReason, 'rate_limit');
  assert.doesNotMatch(JSON.stringify(row), /SECRET/);
  // Heuristic classification from message still stores only the allowlisted enum.
  const inferred = hook.advance(null, claude('StopFailure', { last_assistant_message: "You've hit your limit · resets 5pm" }), 30);
  assert.equal(inferred.errorReason, 'rate_limit');
  assert.doesNotMatch(JSON.stringify(inferred), /resets 5pm/);
  // Arbitrary error strings are never persisted.
  const unknown = hook.advance(null, claude('StopFailure', { error: 'private_custom_error' }), 40);
  assert.equal(unknown.errorReason, undefined);
  // Antigravity max_steps_exceeded classifies cleanly.
  const maxSteps = hook.advance(null, agy('Stop', { terminationReason: 'max_steps_exceeded' }), 50);
  assert.deepEqual([maxSteps.status, maxSteps.errorReason], ['error', 'max_steps_exceeded']);
  // Next turn clears errorReason.
  const resumed = hook.advance(row, claude('UserPromptSubmit', { prompt_id: 'turn-2' }), 60);
  assert.deepEqual([resumed.status, resumed.errorReason], ['working', undefined]);
  // Verify on-disk snapshot contains only the enum, zero private detail.
  await hook.record(state, claude('StopFailure', { error: 'rate_limit', error_details: 'SECRET account detail' }));
  const files = await fs.readdir(state);
  const raw = await fs.readFile(path.join(state, files[0]), 'utf8');
  assert.equal(JSON.parse(raw).errorReason, 'rate_limit');
  assert.doesNotMatch(raw, /SECRET/);
});

test('blank SessionStart sessions stay unstarted and clean up on SessionEnd; PermissionDenied and AGY UPPER_SNAKE_CASE Stop work', async t => {
  const state = await tempState(t);
  const { readSessions } = require('../src/model.cjs');
  // Blank Claude SessionStart writes an unstarted snapshot (hidden by readSessions), and SessionEnd deletes it.
  await hook.record(state, claude('SessionStart', { session_id: 'blank-1', source: 'startup', model: 'claude-sonnet-4-6' }));
  assert.equal((await fs.readdir(state)).length, 1);
  assert.deepEqual(await readSessions(state), []);
  await hook.record(state, claude('SessionEnd', { session_id: 'blank-1' }));
  assert.deepEqual(await fs.readdir(state), []);
  // Codex SessionStart does not even create a blank file.
  await hook.record(state, hook.normalize('codex', 'SessionStart', { session_id: 'codex-blank', cwd: '/repo', source: 'startup' }));
  assert.deepEqual(await fs.readdir(state), []);
  // Claude PermissionDenied clears pending approval back to working.
  let row = hook.advance(null, claude('UserPromptSubmit'), 10);
  row = hook.advance(row, claude('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf x' } }), 20);
  assert.equal(row.status, 'approval');
  row = hook.advance(row, claude('PermissionDenied', { tool_name: 'Bash', tool_input: { command: 'rm -rf x' } }), 30);
  assert.equal(row.status, 'working');
  assert.equal(row.pending, undefined);
  // AGY official UPPER_SNAKE_CASE Stop reasons.
  const activeAgy = hook.advance(null, agy('PreInvocation'), 10);
  assert.deepEqual([hook.advance(activeAgy, agy('Stop', { fullyIdle: true, terminationReason: 'NO_TOOL_CALL' }), 20).status,
    hook.advance(activeAgy, agy('Stop', { fullyIdle: true, terminationReason: 'NO_TOOL_CALL' }), 20).replyAt], ['done', 20]);
  assert.deepEqual([hook.advance(activeAgy, agy('Stop', { terminationReason: 'TERMINAL_STEP_TYPE' }), 20).status,
    hook.advance(activeAgy, agy('Stop', { terminationReason: 'TERMINAL_STEP_TYPE' }), 20).replyAt], ['done', undefined]);
  assert.equal(hook.advance(activeAgy, agy('Stop', { fullyIdle: false, terminationReason: 'TERMINAL_STEP_TYPE' }), 20).status, 'working');
  assert.deepEqual([hook.advance(activeAgy, agy('Stop', { terminationReason: 'MAX_INVOCATIONS' }), 20).status,
    hook.advance(activeAgy, agy('Stop', { terminationReason: 'MAX_INVOCATIONS' }), 20).errorReason], ['error', 'max_steps_exceeded']);
  assert.deepEqual([hook.advance(activeAgy, agy('Stop', { terminationReason: 'MAX_TOKEN_BUDGET_EXCEEDED' }), 20).status,
    hook.advance(activeAgy, agy('Stop', { terminationReason: 'MAX_TOKEN_BUDGET_EXCEEDED' }), 20).errorReason], ['error', 'max_output_tokens']);
  assert.deepEqual([hook.advance(activeAgy, agy('Stop', { terminationReason: 'ERROR', error: 'Rate limit exceeded' }), 20).status,
    hook.advance(activeAgy, agy('Stop', { terminationReason: 'ERROR', error: 'Rate limit exceeded' }), 20).errorReason], ['error', 'rate_limit']);
  assert.equal(hook.advance(activeAgy, agy('Stop', { terminationReason: 'USER_CANCELED' }), 20).status, 'idle');
  // Codex write_stdin and request_permissions correlate via toolKey.
  const codexEv = (name, fields) => hook.normalize('codex', name, { session_id: 'cx1', cwd: '/repo', turn_id: 't1', ...fields });
  let cx = hook.advance(null, codexEv('PermissionRequest', { tool_name: 'write_stdin', tool_input: { session_id: 7, chars: 'y\n' } }), 10);
  assert.equal(cx.status, 'approval');
  cx = hook.advance(cx, codexEv('PostToolUse', { tool_name: 'write_stdin', tool_input: { session_id: 7, chars: 'y\n' } }), 20);
  assert.equal(cx.status, 'working');
  cx = hook.advance(cx, codexEv('PermissionRequest', { tool_name: 'request_permissions', tool_input: { reason: 'net', permissions: ['network'] } }), 30);
  assert.equal(cx.status, 'approval');
  cx = hook.advance(cx, codexEv('PostToolUse', { tool_name: 'request_permissions', tool_input: { reason: 'net', permissions: ['network'] } }), 40);
  assert.equal(cx.status, 'working');
});

test('AskUserQuestion and request_user_input correlate strictly by questions even when PostToolUse appends answers', () => {
  const questions = [{ question: 'Pick a mode', header: 'Mode', options: [{ label: 'Fast' }, { label: 'Safe' }] }];
  let row = hook.advance(null, claude('UserPromptSubmit'), 10);
  row = hook.advance(row, claude('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions } }), 20);
  assert.equal(row.status, 'input');
  // PostToolUse arrives with answers appended and object keys in different order.
  row = hook.advance(row, claude('PostToolUse', {
    tool_name: 'AskUserQuestion',
    tool_input: {
      answers: { 'Pick a mode': 'Fast' },
      questions: [{ options: [{ label: 'Fast' }, { label: 'Safe' }], header: 'Mode', question: 'Pick a mode' }],
    },
  }), 30);
  assert.equal(row.status, 'working');
  assert.equal(row.pending, undefined);

  const codexEv = (name, fields) => hook.normalize('codex', name, { session_id: 'cx-q', cwd: '/repo', turn_id: 't1', ...fields });
  let cx = hook.advance(null, codexEv('PreToolUse', { tool_name: 'request_user_input', tool_input: { questions } }), 10);
  assert.equal(cx.status, 'input');
  cx = hook.advance(cx, codexEv('PostToolUse', { tool_name: 'request_user_input', tool_input: { questions, answers: { 'Pick a mode': 'Safe' } } }), 20);
  assert.equal(cx.status, 'working');
  assert.equal(cx.pending, undefined);
});

test('stale session locks reclaim after 5s and lock release is ownership-safe', async t => {
  assert.equal(hook.STALE_LOCK_MS, 5000);
  const state = await tempState(t);
  const { createHash } = require('node:crypto');
  const lock = path.join(state, createHash('sha256').update('claude:stale-lock').digest('hex') + '.lock');
  await fs.mkdir(lock, { mode: 0o700 });
  const staleMarker = path.join(lock, 'dead-owner');
  await fs.writeFile(staleMarker, '');
  const old = new Date(Date.now() - 6000);
  await fs.utimes(staleMarker, old, old);
  await fs.utimes(lock, old, old);
  await hook.record(state, claude('UserPromptSubmit', { session_id: 'stale-lock' }));
  const files = await fs.readdir(state);
  assert.equal(files.filter(f => f.endsWith('.json')).length, 1);
  assert.equal(files.filter(f => f.endsWith('.lock')).length, 0);

  // Ownership safety: a slow process releasing an aged lease must never remove a new owner's lock.
  const ownerLock = path.join(state, 'ownership.lock');
  const leaseA = await hook.acquireLock(ownerLock);
  const past = new Date(Date.now() - 6000);
  await fs.utimes(leaseA.marker, past, past);
  await fs.utimes(ownerLock, past, past);
  const leaseB = await hook.acquireLock(ownerLock);
  await hook.releaseLock(leaseA);
  // Lock directory and leaseB's marker must still exist untouched.
  assert.ok((await fs.lstat(ownerLock)).isDirectory());
  assert.ok((await fs.lstat(leaseB.marker)).isFile());
  await hook.releaseLock(leaseB);
  await assert.rejects(fs.lstat(ownerLock), { code: 'ENOENT' });
});

test('post-Stop same-turn continuation allows a later wait (>= 1500ms) after done but blocks races, replays and post-error waits', () => {
  let row = hook.advance(null, claude('UserPromptSubmit'), 1000);
  row = hook.advance(row, claude('Stop', { last_assistant_message: 'first answer' }), 10000);
  assert.equal(row.status, 'done');
  const perm = claude('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm test' } });
  // Out-of-order wait within 1500ms of Stop is ignored.
  assert.equal(hook.advance(row, perm, 11499), row);
  // Same-turn UserPromptSubmit replay is always ignored even well after Stop.
  assert.equal(hook.advance(row, claude('UserPromptSubmit'), 20000), row);
  // Genuinely later wait (>= 1500ms) on the same turn resumes cleanly.
  const waiting = hook.advance(row, perm, 11500);
  assert.equal(waiting.status, 'approval');
  assert.equal(waiting.waitSince, 11500);
  const working = hook.advance(waiting, claude('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' } }), 12000);
  assert.equal(working.status, 'working');
  const doneAgain = hook.advance(working, claude('Stop', { last_assistant_message: 'second answer' }), 13000);
  assert.deepEqual([doneAgain.status, doneAgain.replyAt], ['done', 13000]);
  // After StopFailure (error), a same-turn wait stays blocked even after 1500ms.
  const errored = hook.advance(working, claude('StopFailure', { error: 'rate_limit' }), 14000);
  assert.equal(errored.status, 'error');
  assert.equal(hook.advance(errored, perm, 20000), errored);
});

test('Claude pins snapshot cwd to CLAUDE_PROJECT_DIR when payload cwd is inside it, keeping toolCwd in memory only', () => {
  const prev = process.env.CLAUDE_PROJECT_DIR;
  try {
    process.env.CLAUDE_PROJECT_DIR = '/repo';
    const sub = claude('PostToolUse', { cwd: '/repo/packages/app', tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } });
    assert.equal(sub.cwd, '/repo');
    assert.equal(sub.toolCwd, '/repo/packages/app');
    const snap = hook.advance(null, sub, 100);
    assert.equal(snap.cwd, '/repo');
    assert.equal(snap.toolCwd, undefined);
    // Exact root match needs no toolCwd override.
    const atRoot = claude('UserPromptSubmit', { cwd: '/repo' });
    assert.equal(atRoot.cwd, '/repo');
    assert.equal(atRoot.toolCwd, undefined);
    // Sibling prefix or unrelated synthetic paths are never polluted by CLAUDE_PROJECT_DIR.
    assert.equal(claude('UserPromptSubmit', { cwd: '/repo-sibling' }).cwd, '/repo-sibling');
    assert.equal(claude('UserPromptSubmit', { cwd: '/other/project' }).cwd, '/other/project');
    assert.equal(claude('UserPromptSubmit', { cwd: '/other/project' }).toolCwd, undefined);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prev;
  }
});

test('expanded shell tools, string args, call.id, ask_question and notify_user BlockedOnUser correlate accurately', () => {
  const codexEv = (name, fields) => hook.normalize('codex', name, { session_id: 'sh-1', cwd: '/repo', turn_id: 't1', ...fields });
  for (const [tool, reqInput, resInput] of [
    ['shell', { command: ['git', 'status'], workdir: '/repo' }, { command: ['git', 'status'] }],
    ['local_shell', { command: ['npm', 'test'], description: 'run' }, { command: ['npm', 'test'] }],
    ['unified_exec', { cmd: 'ls -la', justification: 'list' }, { cmd: 'ls -la' }],
    ['apply_patch', '*** Begin Patch\n*** Update File: a.ts\n*** End Patch', '*** Begin Patch\n*** Update File: a.ts\n*** End Patch'],
  ]) {
    let row = hook.advance(null, codexEv('PermissionRequest', { tool_name: tool, tool_input: reqInput }), 10);
    assert.equal(row.status, 'approval', tool);
    row = hook.advance(row, codexEv('PostToolUse', { tool_name: tool, tool_input: resInput }), 20);
    assert.equal(row.status, 'working', tool);
    assert.equal(row.pending, undefined, tool);
  }
  // AGY toolCall without stepIdx correlates via call.id, and ask_question correlates by questions even when answers appear.
  let row = hook.advance(null, agy('PreToolUse', { toolCall: { id: 'call-99', name: 'ask_permission', args: { command: 'rm a' } } }), 10);
  assert.equal(row.status, 'approval');
  row = hook.advance(row, agy('PostToolUse', { toolCall: { id: 'call-99', name: 'ask_permission', args: {} } }), 20);
  assert.equal(row.status, 'working');

  const questions = [{ question: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No' }] }];
  row = hook.advance(row, agy('PreToolUse', { toolCall: { name: 'ask_question', args: { questions } } }), 30);
  assert.equal(row.status, 'input');
  row = hook.advance(row, agy('PostToolUse', { toolCall: { name: 'ask_question', args: { questions, answers: { 'Proceed?': 'Yes' } } } }), 40);
  assert.equal(row.status, 'working');

  // AGY notify_user only enters input wait when BlockedOnUser === true.
  assert.equal(agy('PreToolUse', { stepIdx: 7, toolCall: { name: 'notify_user', args: { Message: 'FYI', BlockedOnUser: false } } }), undefined);
  assert.equal(agy('PreToolUse', { stepIdx: 7, toolCall: { name: 'notify_user', args: { Message: 'FYI' } } }), undefined);
  row = hook.advance(row, agy('PreToolUse', { stepIdx: 8, toolCall: { name: 'notify_user', args: { Message: 'Please review', BlockedOnUser: true } } }), 50);
  assert.equal(row.status, 'input');
  row = hook.advance(row, agy('PostToolUse', { stepIdx: 8, toolCall: { name: 'notify_user', args: { Message: 'Please review', BlockedOnUser: true } } }), 60);
  assert.equal(row.status, 'working');
});

test('hookExecution widens Gemini minimal/ultra, Claude SubagentStart/string effort, Codex reasoning_effort, StopFailure heuristics, and Codex child default/Interrupt', () => {
  assert.deepEqual(agy('PreInvocation', { modelName: 'gemini-3.5-pro-minimal' }).execution,
    { model: 'gemini-3.5-pro-minimal', modelSource: 'call', effort: 'minimal', effortSource: 'call' });
  assert.deepEqual(agy('PreInvocation', { modelName: 'gemini-4-pro-ultra' }).execution,
    { model: 'gemini-4-pro-ultra', modelSource: 'call', effort: 'ultra', effortSource: 'call' });

  const subStart = claude('SubagentStart', { agent_id: 'kid-1', agent_type: 'Explore', model: 'claude-haiku-4-5', effort: 'high' });
  assert.deepEqual(subStart.execution, { model: 'claude-haiku-4-5', modelSource: 'setting', effort: 'high', effortSource: 'setting' });
  assert.equal(claude('SessionStart', { effort: { level: 'max' } }).execution.effort, 'max');

  const codexEv = (name, fields) => hook.normalize('codex', name, { session_id: 'cx-exec', cwd: '/repo', turn_id: 't1', ...fields });
  assert.deepEqual(codexEv('UserPromptSubmit', { model: 'gpt-5.4', reasoning_effort: 'xhigh' }).execution,
    { model: 'gpt-5.4', modelSource: 'setting', effort: 'xhigh', effortSource: 'setting' });
  assert.equal(codexEv('UserPromptSubmit', { effort: { level: 'minimal' } }).execution.effort, 'minimal');
  assert.equal(codexEv('UserPromptSubmit', { effort: 'low' }).execution.effort, 'low');

  // StopFailure fallback heuristics for server_error and invalid_request.
  for (const details of ['overloaded_error', 'HTTP 529 overloaded', '503 Service Unavailable', '500 Internal Server Error']) {
    assert.equal(claude('StopFailure', { error_details: details }).errorReason, 'server_error', details);
  }
  for (const details of ['prompt is too long: 210000 tokens', 'maximum context length exceeded', 'too many tokens']) {
    assert.equal(claude('StopFailure', { error_details: details }).errorReason, 'invalid_request', details);
  }

  // Codex child label suppresses default role before joining and supports child Interrupt.
  const childStart = codexEv('SubagentStart', { agent_id: 'ada-1', agent_name: 'Ada', agent_type: 'default' });
  assert.equal(childStart.agentType, 'Ada');
  const childInt = codexEv('Interrupt', { agent_id: 'ada-1', agent_name: 'Ada', agent_type: 'default' });
  assert.equal(childInt.parentSessionId, 'cx-exec');
  assert.equal(childInt.action, 'end');
  assert.equal(childInt.status, 'idle');
  assert.equal(childInt.interrupted, true);
  let childSnap = hook.advance(null, childStart, 10);
  childSnap = hook.advance(childSnap, childInt, 20);
  assert.deepEqual([childSnap.status, childSnap.interrupted, childSnap.parentSessionId], ['idle', true, 'cx-exec']);
});

test('record reports PreInvocation restarts and AGY Stop safely tails PLANNER_RESPONSE from transcriptPath in memory only', async t => {
  const state = await tempState(t);
  let time = Date.now();
  t.mock.method(Date, 'now', () => time);
  const first = await hook.record(state, agy('PreInvocation', { lastUserInput: 'Turn 1' }));
  assert.deepEqual(first, { changed: true, restarted: true });
  const second = await hook.record(state, agy('PreInvocation', { lastUserInput: 'Turn 1' }));
  assert.deepEqual(second, { changed: false, restarted: false });
  time += 100;
  const forcedRestart = await hook.record(state, agy('PreInvocation', { lastUserInput: 'Turn 1', invocationNum: 1 }));
  assert.deepEqual(forcedRestart, { changed: true, restarted: true });
  await hook.record(state, agy('Stop', { fullyIdle: true, terminationReason: 'model_stop' }));
  const afterDone = await hook.record(state, agy('PreInvocation', { lastUserInput: 'Turn 1' }));
  assert.deepEqual(afterDone, { changed: true, restarted: true });

  // Bounded tail read of AGY transcriptPath.
  const dir = await tempState(t);
  const transcript = path.join(dir, 'transcript.jsonl');
  const pad = JSON.stringify({ type: 'GENERIC', content: 'x'.repeat(40000) });
  await fs.writeFile(transcript, [
    pad,
    JSON.stringify({ type: 'USER_INPUT', content: 'Fix bug' }),
    JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'Thinking...', tool_calls: [{ name: 'read_file' }] }),
    JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'Fixed the parity bug cleanly.' }),
    JSON.stringify({ type: 'GENERIC', content: 'done' }),
  ].join('\n') + '\n');
  assert.equal(await hook.readAgyTranscriptReply(transcript), 'Fixed the parity bug cleanly.');

  // Pending tool calls on latest PLANNER_RESPONSE yields empty string.
  const toolOnly = path.join(dir, 'tool-only.jsonl');
  await fs.writeFile(toolOnly, [
    JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'Old reply' }),
    JSON.stringify({ type: 'USER_INPUT', content: 'Next' }),
    JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'Running tool', tool_calls: [{ name: 'run_command' }] }),
  ].join('\n') + '\n');
  assert.equal(await hook.readAgyTranscriptReply(toolOnly), '');

  // Symlinks and relative paths are refused.
  const sym = path.join(dir, 'sym.jsonl');
  await fs.symlink(transcript, sym);
  assert.equal(await hook.readAgyTranscriptReply(sym), '');
  assert.equal(await hook.readAgyTranscriptReply('relative/transcript.jsonl'), '');
});

test('3-agent approval blind spots: AGY delayed soft waits, Claude ExitPlanMode PreToolUse, Codex request_permissions PreToolUse & array cmd', async t => {
  const opts = { homeDir: '/Users/dev', tmpDir: '/var/folders/tmp' };
  const agyOpt = (name, fields = {}, extraOpts = {}) => hook.normalize('agy', name, {
    conversationId: 'agy-soft', workspacePaths: ['/repo'], ...fields,
  }, { ...opts, ...extraOpts });

  // 1. Antigravity run_command delayed soft waits across BypassSandbox, WaitMsBeforeAsync, and permission presets.
  const bypassCmd = agyOpt('PreToolUse', {
    stepIdx: 10,
    toolCall: { name: 'run_command', args: { CommandLine: 'vercel deploy --yes', BypassSandbox: true, WaitMsBeforeAsync: 10000 } },
  });
  assert.deepEqual([bypassCmd.action, bypassCmd.status, bypassCmd.delayMs], ['soft_wait', 'approval', 16000]);

  const fastBypass = agyOpt('PreToolUse', {
    stepIdx: 11,
    toolCall: { name: 'run_command', args: { CommandLine: 'npm run dev', BypassSandbox: true, WaitMsBeforeAsync: 500 } },
  });
  assert.equal(fastBypass.delayMs, 9000);

  const sandboxedWithWait = agyOpt('PreToolUse', {
    stepIdx: 12,
    toolCall: { name: 'run_command', args: { CommandLine: 'git push', WaitMsBeforeAsync: 5000 } },
  });
  assert.deepEqual([sandboxedWithWait.action, sandboxedWithWait.delayMs], ['soft_wait', 13000]);

  // Sandboxed run_command without WaitMsBeforeAsync is ignored under Auto, caught under Request Review.
  const plainCmd = { stepIdx: 13, toolCall: { name: 'run_command', args: { CommandLine: 'echo hi' } } };
  assert.equal(agyOpt('PreToolUse', plainCmd), undefined);
  assert.equal(agyOpt('PreToolUse', plainCmd, { agyPreset: 'AGENT_PERMISSION_PRESET_REQUEST_REVIEW' }).delayMs, 16000);

  // Turbo mode skips all soft waits.
  assert.equal(agyOpt('PreToolUse', {
    stepIdx: 10, toolCall: { name: 'run_command', args: { CommandLine: 'vercel deploy', BypassSandbox: true, WaitMsBeforeAsync: 10000 } },
  }, { agyPreset: 'AGENT_PERMISSION_PRESET_TURBO' }), undefined);

  // 2. External file tools trigger 4s soft wait; workspace, /tmp, tmpdir (/private/var symlink), and ~/.gemini are ignored.
  for (const safePath of ['/repo/src/a.js', '/tmp/scratch.txt', '/private/tmp/scratch.txt',
    '/var/folders/tmp/x.txt', '/private/var/folders/tmp/x.txt', '/Users/dev/.gemini/antigravity/plan.md']) {
    assert.equal(agyOpt('PreToolUse', { stepIdx: 20, toolCall: { name: 'write_file', args: { Path: safePath } } }), undefined, safePath);
    assert.equal(agyOpt('PreToolUse', { stepIdx: 21, toolCall: { name: 'read_file', args: { Path: safePath } } }), undefined, safePath);
  }
  const extWrite = agyOpt('PreToolUse', { stepIdx: 22, toolCall: { name: 'write_file', args: { Path: '/etc/hosts', Content: 'secret' } } });
  assert.deepEqual([extWrite.action, extWrite.status, extWrite.delayMs], ['soft_wait', 'approval', 4000]);
  const extRead = agyOpt('PreToolUse', { stepIdx: 23, toolCall: { name: 'view_file', args: { AbsolutePath: '/Users/dev/.ssh/config' } } });
  assert.deepEqual([extRead.action, extRead.status, extRead.delayMs], ['soft_wait', 'approval', 4000]);
  // Under Request Review, even in-workspace writes get 4s soft wait while in-workspace reads do not.
  assert.equal(agyOpt('PreToolUse', { stepIdx: 24, toolCall: { name: 'edit_file', args: { Path: '/repo/a.js' } } },
    { agyPreset: 'AGENT_PERMISSION_PRESET_REQUEST_REVIEW' }).delayMs, 4000);
  assert.equal(agyOpt('PreToolUse', { stepIdx: 25, toolCall: { name: 'read_file', args: { Path: '/repo/a.js' } } },
    { agyPreset: 'AGENT_PERMISSION_PRESET_REQUEST_REVIEW' }), undefined);
  // read_url_content triggers 12s soft wait unless Turbo.
  assert.equal(agyOpt('PreToolUse', { stepIdx: 26, toolCall: { name: 'read_url_content', args: { Url: 'https://example.com' } } }).delayMs, 12000);
  assert.equal(agyOpt('PreToolUse', { stepIdx: 26, toolCall: { name: 'read_url_content', args: { Url: 'https://example.com' } } },
    { agyPreset: 'AGENT_PERMISSION_PRESET_TURBO' }), undefined);

  // 3. advance() keeps disk status 'working', stores zero private strings, isolates parallel calls, and clears on PostToolUse or PreInvocation.
  let row = hook.advance(null, agyOpt('PreInvocation'), 1000);
  row = hook.advance(row, bypassCmd, 2000);
  row = hook.advance(row, fastBypass, 2500);
  assert.equal(row.status, 'working');
  assert.equal(Object.keys(row.pendingSoft).length, 2);
  assert.deepEqual(row.pendingSoft[bypassCmd.key], { status: 'approval', after: 18000, since: 2000, stepIdx: 10 });
  assert.doesNotMatch(JSON.stringify(row), /vercel|npm run|hosts|secret/);
  // Resolving step 10 leaves step 11 intact; unrelated step leaves step 11 intact.
  row = hook.advance(row, agyOpt('PostToolUse', { stepIdx: 10, toolCall: { name: 'run_command' } }), 3000);
  assert.deepEqual(Object.keys(row.pendingSoft), [fastBypass.key]);
  assert.equal(hook.advance(row, agyOpt('PostToolUse', { stepIdx: 99, toolCall: { name: 'read_file' } }), 3100), row);
  // PreInvocation (e.g. user clicked "4 No" without PostToolUse) clears pendingSoft while preserving hard pending waits.
  const ask = { stepIdx: 30, toolCall: { name: 'ask_question', args: { questions: [] } } };
  row = hook.advance(row, agyOpt('PreToolUse', ask), 4000);
  assert.equal(row.status, 'input');
  assert.ok(row.pendingSoft[fastBypass.key]);
  row = hook.advance(row, agyOpt('PreInvocation'), 5000);
  assert.equal(row.status, 'input', 'explicit ask_question survives PreInvocation');
  assert.equal(row.pendingSoft, undefined, 'soft waits clear on next PreInvocation');

  // 4. readAgyPermissionPreset reads userSettings.permissionPreset safely and ignores missing/corrupt/symlinked files.
  const fakeHome = await tempState(t);
  assert.equal(await hook.readAgyPermissionPreset(fakeHome), '');
  const cfgDir = path.join(fakeHome, '.gemini', 'config');
  await fs.mkdir(cfgDir, { recursive: true });
  const cfgFile = path.join(cfgDir, 'config.json');
  await fs.writeFile(cfgFile, JSON.stringify({ userSettings: { permissionPreset: 'AGENT_PERMISSION_PRESET_TURBO' } }));
  assert.equal(await hook.readAgyPermissionPreset(fakeHome), 'AGENT_PERMISSION_PRESET_TURBO');
  await fs.writeFile(cfgFile, '{broken');
  assert.equal(await hook.readAgyPermissionPreset(fakeHome), '');

  // 5. Claude ExitPlanMode PreToolUse enters approval wait, deduplicates with PermissionRequest, and resolves even with extra fields.
  let cl = hook.advance(null, claude('UserPromptSubmit'), 10);
  const planPre = claude('PreToolUse', { tool_name: 'ExitPlanMode', tool_input: { plan: '# Plan', planFilePath: '/repo/plan.md' } });
  assert.deepEqual([planPre.action, planPre.status], ['wait', 'approval']);
  cl = hook.advance(cl, planPre, 20);
  assert.equal(cl.status, 'approval');
  const planPerm = claude('PermissionRequest', { tool_name: 'ExitPlanMode', tool_input: { plan: '# Plan', planFilePath: '/repo/plan.md', allowedPrompts: [] } });
  assert.equal(planPerm.key, planPre.key, 'ExitPlanMode PreToolUse and PermissionRequest correlate identically');
  assert.equal(hook.advance(cl, planPerm, 25), cl);
  cl = hook.advance(cl, claude('PostToolUse', { tool_name: 'ExitPlanMode', tool_input: { plan: '# Plan', planFilePath: '/repo/plan.md', approved: true } }), 30);
  assert.equal(cl.status, 'working');
  assert.equal(cl.pending, undefined);

  // 6. Codex request_permissions PreToolUse & array args.cmd correlation.
  const cxEv = (name, fields) => hook.normalize('codex', name, { session_id: 'cx-blind', cwd: '/repo', turn_id: 't1', ...fields });
  let cx = hook.advance(null, cxEv('PreToolUse', { tool_name: 'request_permissions', tool_input: { reason: 'deploy', permissions: { network: true } } }), 10);
  assert.equal(cx.status, 'approval');
  cx = hook.advance(cx, cxEv('PostToolUse', { tool_name: 'request_permissions', tool_input: { reason: 'deploy', permissions: { network: true } } }), 20);
  assert.equal(cx.status, 'working');
  cx = hook.advance(cx, cxEv('PermissionRequest', { tool_name: 'exec_command', tool_input: { cmd: ['git', 'push', 'origin'], justification: 'push' } }), 30);
  assert.equal(cx.status, 'approval');
  cx = hook.advance(cx, cxEv('PostToolUse', { tool_name: 'exec_command', tool_input: { cmd: ['git', 'push', 'origin'] } }), 40);
  assert.equal(cx.status, 'working');
  assert.equal(cx.pending, undefined);
});

test('background subagent survives parent prompt changes and PostToolUseFailure is_interrupt ends turn cleanly', async t => {
  // 1. Background subagent started during parent turn-1 keeps tracking approvals, activity, and completion after parent switches to turn-2.
  const childStart = hook.normalize('claude', 'SubagentStart', { session_id: 'root', agent_id: 'bg-1', agent_type: 'Research', cwd: '/repo', prompt_id: 'turn-1' });
  assert.equal(childStart.turn, '');
  let sub = hook.advance(null, childStart, 100);
  assert.equal(sub.status, 'working');
  assert.equal(sub.turn, undefined);
  // Simulate an older on-disk child snapshot that already stored turn-1.
  sub = { ...sub, turn: 'turn-1' };
  const childPerm = hook.normalize('claude', 'PermissionRequest', {
    session_id: 'root', agent_id: 'bg-1', cwd: '/repo', prompt_id: 'turn-2',
    tool_name: 'Bash', tool_input: { command: 'npm test' },
  });
  assert.equal(childPerm.turn, '');
  sub = hook.advance(sub, childPerm, 200);
  assert.equal(sub.status, 'approval');
  assert.equal(sub.waitSince, 200);
  assert.equal(sub.turn, undefined);
  sub = hook.advance(sub, hook.normalize('claude', 'PostToolUse', {
    session_id: 'root', agent_id: 'bg-1', cwd: '/repo', prompt_id: 'turn-3',
    tool_name: 'Bash', tool_input: { command: 'npm test' },
  }), 300);
  assert.equal(sub.status, 'working');
  assert.equal(sub.pending, undefined);

  // 2. PostToolUseFailure with is_interrupt: true ends the interrupted turn as idle (not stuck working) and clears pending waits.
  let main = hook.advance(null, claude('UserPromptSubmit', { prompt_id: 't1' }), 10);
  main = hook.advance(main, claude('PermissionRequest', { prompt_id: 't1', tool_name: 'Bash', tool_input: { command: 'sleep 10' } }), 20);
  assert.equal(main.status, 'approval');
  main = hook.advance(main, claude('PostToolUseFailure', { prompt_id: 't1', tool_name: 'Bash', tool_input: { command: 'sleep 10' }, is_interrupt: true }), 30);
  assert.deepEqual([main.status, main.interrupted, main.pending], ['idle', true, undefined]);
  // Next user prompt resumes cleanly.
  main = hook.advance(main, claude('UserPromptSubmit', { prompt_id: 't2' }), 40);
  assert.deepEqual([main.status, main.interrupted], ['working', undefined]);

  // 3. record() reports recordedWait=false when advance() ignores a stale same-turn wait, preventing stuck inline requests.
  const state = await tempState(t);
  await hook.record(state, claude('UserPromptSubmit', { prompt_id: 't-done' }));
  await hook.record(state, claude('Stop', { prompt_id: 't-done', last_assistant_message: 'done' }));
  const stale = await hook.record(state, claude('PermissionRequest', { prompt_id: 't-done', tool_name: 'Bash', tool_input: { command: 'echo hi' } }));
  assert.equal(stale.recordedWait, false);
});

test('Claude subagent approval deduplicates parent generic permission_prompt while preserving genuine dual approvals', async t => {
  const state = await tempState(t);
  const { readSessions } = require('../src/model.cjs');
  const root = { session_id: 'parent-1', cwd: '/repo', prompt_id: 't1' };
  const child = { ...root, agent_id: 'sub-1', agent_type: 'Worker' };

  // 1. Subagent requests Write approval, then delayed generic Notification arrives on parent -> count stays 1.
  await hook.record(state, hook.normalize('claude', 'UserPromptSubmit', root));
  await hook.record(state, hook.normalize('claude', 'SubagentStart', child));
  await hook.record(state, hook.normalize('claude', 'PermissionRequest', {
    ...child, tool_name: 'Write', tool_input: { file_path: '/repo/sub.txt', content: 'hi' },
  }));
  const delayed = await hook.record(state, hook.normalize('claude', 'Notification', {
    ...root, notification_type: 'permission_prompt',
  }));
  assert.equal(delayed.recordedWait, false);
  let rows = await readSessions(state);
  assert.equal(rows.find(r => r.key === 'claude/parent-1').status, 'working');
  assert.equal(rows.find(r => r.key === 'claude/parent-1/sub-1').status, 'approval');

  // 2. Genuine separate approval on parent (specific PermissionRequest) -> BOTH parent and child stay approval (count = 2).
  await hook.record(state, hook.normalize('claude', 'PermissionRequest', {
    ...root, tool_name: 'Bash', tool_input: { command: 'npm test' },
  }));
  rows = await readSessions(state);
  assert.equal(rows.find(r => r.key === 'claude/parent-1').status, 'approval');
  assert.equal(rows.find(r => r.key === 'claude/parent-1/sub-1').status, 'approval');

  // 3. Resolving child leaves parent's real approval intact.
  await hook.record(state, hook.normalize('claude', 'PostToolUse', {
    ...child, tool_name: 'Write', tool_input: { file_path: '/repo/sub.txt', content: 'hi' },
  }));
  rows = await readSessions(state);
  assert.equal(rows.find(r => r.key === 'claude/parent-1').status, 'approval');
  assert.equal(rows.find(r => r.key === 'claude/parent-1/sub-1').status, 'working');

  // 4. Race order: generic Notification lands on parent BEFORE child PermissionRequest -> child clears parent's generic wait.
  const root2 = { session_id: 'parent-2', cwd: '/repo', prompt_id: 't1' };
  const child2 = { ...root2, agent_id: 'sub-2', agent_type: 'Helper' };
  await hook.record(state, hook.normalize('claude', 'UserPromptSubmit', root2));
  await hook.record(state, hook.normalize('claude', 'Notification', { ...root2, notification_type: 'permission_prompt' }));
  rows = await readSessions(state);
  assert.equal(rows.find(r => r.key === 'claude/parent-2').status, 'approval');
  await hook.record(state, hook.normalize('claude', 'PermissionRequest', {
    ...child2, tool_name: 'Write', tool_input: { file_path: '/repo/race.txt', content: 'x' },
  }));
  rows = await readSessions(state);
  assert.equal(rows.find(r => r.key === 'claude/parent-2').status, 'working');
  assert.equal(rows.find(r => r.key === 'claude/parent-2/sub-2').status, 'approval');

  // 5. Cross-session isolation: an unrelated session's generic permission_prompt still works normally.
  const other = { session_id: 'other-session', cwd: '/repo', prompt_id: 't1' };
  await hook.record(state, hook.normalize('claude', 'UserPromptSubmit', other));
  const otherNotif = await hook.record(state, hook.normalize('claude', 'Notification', { ...other, notification_type: 'permission_prompt' }));
  assert.equal(otherNotif.recordedWait, true);
  rows = await readSessions(state);
  assert.equal(rows.find(r => r.key === 'claude/other-session').status, 'approval');
});

test('Codex apply_patch and shell PermissionRequest persist only opaque target hashes with zero raw paths or commands', async t => {
  const state = await tempState(t);
  const patchA = '*** Begin Patch\n*** Add File: secret-qa-marker.txt\n+sensitive diff\n*** End Patch';
  const patchB = '*** Begin Patch\n*** Update File: other/second.txt\n*** Move to: other/renamed.txt\n@@\n-a\n+b\n*** End Patch';
  const common = { session_id: 'cx-patch', cwd: '/repo/work', turn_id: 'turn-7' };
  await hook.record(state, hook.normalize('codex', 'PermissionRequest', { ...common, tool_name: 'apply_patch', tool_input: { command: patchA } }));
  await hook.record(state, hook.normalize('codex', 'PermissionRequest', { ...common, tool_name: 'apply_patch', tool_input: { command: patchB } }));
  await hook.record(state, hook.normalize('codex', 'PermissionRequest', { ...common, tool_name: 'Bash', tool_input: { command: 'secret-shell-cmd --flag' } }));
  const files = await fs.readdir(state);
  assert.equal(files.length, 1);
  const raw = await fs.readFile(path.join(state, files[0]), 'utf8');
  assert.doesNotMatch(raw, /secret|qa-marker|sensitive|renamed|flag|Begin Patch/);
  const snap = JSON.parse(raw);
  const targets = Object.values(snap.pendingTargets || {});
  assert.equal(targets.length, 3);
  assert.equal(targets.filter(v => /^fc:[a-f0-9]{64}$/.test(v)).length, 2);
  assert.equal(targets.filter(v => /^cmd:[a-f0-9]{64}$/.test(v)).length, 1);
});

test('explicit model switches refresh only modelAt and hook validation matches snapshot enrichment', () => {
  const { mergeExecution } = require('../src/inbox.cjs');
  for (const model of ['unknown', 'UnKnOwN', 'auto', 'inherit']) {
    assert.equal(claude('SessionStart', { model }).execution, undefined);
  }
  for (const size of ['1m', '1M']) {
    const model = 'claude-opus-5-5[' + size + ']';
    const initial = hook.advance(null, claude('SessionStart', { model, effort: 'high' }), 10);
    const start = hook.advance(initial, claude('SessionStart', { model }), 20);
    assert.equal(start.execution.modelAt, 10);
    const switched = hook.advance(start, claude('PostModelSwitch', { to_model: model, effort: 'high' }), 30);
    assert.equal(switched.execution.modelAt, 30);
    assert.equal(switched.execution.effortAt, 10);
    assert.equal(switched.updatedAt, initial.updatedAt);
    const native = { model: 'claude-fable-5-2', modelSource: 'response', modelAt: 25 };
    assert.equal(mergeExecution(native, switched.execution, 'claude').model, model);
  }
});

test('a first Antigravity invocation starts a fresh work interval and clears both kinds of wait', () => {
  for (const nextTurn of ['one', 'two']) {
    let snap = hook.advance(null, agy('PreInvocation', { turn_id: 'one' }), 10);
    snap = hook.advance(snap, agy('PreToolUse', { stepIdx: 1, toolCall: { name: 'ask_permission' } }), 20);
    snap = hook.advance(snap, agy('PreToolUse', { stepIdx: 2,
      toolCall: { name: 'read_file', args: { Path: '/etc/hosts' } } }), 30);
    assert.ok(snap.pending && snap.pendingSoft);
    const next = hook.advance(snap, agy('PreInvocation', { invocationNum: 1, turn_id: nextTurn }), 40);
    assert.deepEqual([next.status, next.workSince, next.turn], ['working', 40, nextTurn]);
    for (const field of ['pending', 'pendingSoft', 'pendingAt', 'waitSince']) assert.equal(next[field], undefined);
    if (nextTurn === 'two') assert.equal(hook.advance(next, agy('Stop', { turn_id: 'one', fullyIdle: true }), 50), next);
  }
});

test('a lock directory reclaimed between mkdir and marker creation is acquired on retry', async t => {
  const state = await tempState(t), lock = path.join(state, 'race.lock');
  const write = fs.writeFile;
  let markers = 0;
  t.mock.method(fs, 'writeFile', async (file, ...args) => {
    if (path.dirname(file) === lock && ++markers === 1) await fs.rmdir(lock);
    return write(file, ...args);
  });
  const lease = await hook.acquireLock(lock);
  assert.equal(markers, 2);
  assert.ok((await fs.stat(lease.marker)).isFile());
  await hook.releaseLock(lease);
  assert.deepEqual(await fs.readdir(state), []);
});

test('a child approval committed while the parent is acquiring its lock suppresses the generic reminder', async t => {
  const state = await tempState(t), root = { session_id: 'parent', cwd: '/repo' };
  const { createHash } = require('node:crypto');
  const filename = key => path.join(state, createHash('sha256').update('claude:' + key).digest('hex'));
  const child = hook.normalize('claude', 'PermissionRequest', { ...root, agent_id: 'child', tool_name: 'Read', tool_input: {} });
  const reminder = hook.normalize('claude', 'Notification', { ...root, notification_type: 'permission_prompt' });
  await hook.record(state, hook.normalize('claude', 'UserPromptSubmit', root));
  const mkdir = fs.mkdir;
  let interleaved = false;
  t.mock.method(fs, 'mkdir', async (dir, ...args) => {
    if (dir === filename('parent') + '.lock' && !interleaved) {
      interleaved = true;
      await hook.record(state, child);
      const skew = new Date(Date.now() - 16000);
      await fs.utimes(filename('parent/child') + '.json', skew, skew);
    }
    return mkdir(dir, ...args);
  });
  const result = await hook.record(state, reminder);
  assert.equal(result.recordedWait, false);
  assert.equal(JSON.parse(await fs.readFile(filename('parent') + '.json')).status, 'working');
  assert.equal(JSON.parse(await fs.readFile(filename('parent/child') + '.json')).status, 'approval');
});

test('hook CLI announces recorded waits once and checks activity only for regular descriptors', async t => {
  const dir = await tempState(t), state = path.join(dir, 'sessions'), preload = path.join(dir, 'window.cjs');
  const manual = JSON.stringify(require.resolve('../src/manual.cjs'));
  await fs.writeFile(preload, `
    const manual = require(${manual});
    manual.announce = async () => process.stderr.write('notice');
    manual.activityWindows = async () => { process.stderr.write('activity'); return []; };
  `);
  const options = { preload, env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: '', HOME: dir } };
  const command = { conversationId: 'soft', workspacePaths: ['/repo'], stepIdx: 1,
    toolCall: { name: 'run_command', args: { CommandLine: 'private command', BypassSandbox: true } } };
  assert.equal((await run(state, 'agy', 'PreToolUse', command, options)).stderr, 'notice');
  assert.equal((await run(state, 'agy', 'PreToolUse', command, options)).stderr, '');
  const fields = { session_id: 'main', prompt_id: 'turn', cwd: '/repo' };
  await hook.record(state, hook.normalize('claude', 'StopFailure', fields));
  assert.equal((await run(state, 'claude', 'PermissionRequest', { ...fields, tool_name: 'Read', tool_input: {} }, options)).stderr, '');
  const registry = path.join(dir, 'approval-windows'), descriptor = path.join(registry, '1'.repeat(36) + '.json');
  await fs.mkdir(registry);
  const target = path.join(dir, 'settings.json');
  await fs.writeFile(target, '{"activity":true}');
  await fs.symlink(target, descriptor);
  assert.equal((await run(state, 'claude', 'PostToolUse', fields, options)).stderr, '');
  await fs.unlink(descriptor);
  await fs.copyFile(target, descriptor);
  assert.equal((await run(state, 'claude', 'PostToolUse', fields, options)).stderr, 'activity');
});

test('inline Claude decisions require a committed resolution of the original wait under the session lock', async t => {
  const dir = await tempState(t), preload = path.join(dir, 'inline.cjs');
  const fields = { session_id: 'main', cwd: '/repo', prompt_id: 'turn', tool_name: 'Read', tool_input: { file_path: 'private-path' } };
  await fs.writeFile(preload, `
    const fs = require('node:fs/promises');
    const manual = require(${JSON.stringify(require.resolve('../src/manual.cjs'))});
    manual.ask = async state => {
      if (process.env.TEST_DECISION === 'retry') {
        const mkdir = fs.mkdir;
        fs.mkdir = async (dir, ...args) => {
          if (dir.endsWith('.lock')) {
            fs.mkdir = mkdir;
            const hook = require(process.argv[1]), fields = ${JSON.stringify(fields)};
            await hook.record(state, hook.normalize('claude', 'PostToolUse', fields));
            await new Promise(resolve => setTimeout(resolve, 5));
            await hook.record(state, hook.normalize('claude', 'PermissionRequest', fields));
          }
          return mkdir(dir, ...args);
        };
      } else if (process.env.TEST_DECISION === 'failed-write') {
        fs.rename = async () => { throw new Error('simulated commit failure'); };
      }
      return { accepted: true, choice: { action: 'approve' } };
    };
  `);
  for (const mode of ['approved', 'retry', 'failed-write']) {
    const state = path.join(dir, mode);
    const env = { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'claude-vscode', TEST_DECISION: mode };
    const { stdout, stderr, code } = await run(state, 'claude', 'PermissionRequest',
      { ...fields, hook_event_name: 'PermissionRequest' }, { preload, env });
    assert.deepEqual([code, stderr], [0, '']);
    const files = await fs.readdir(state);
    assert.equal(files.length, 1);
    const contents = await fs.readFile(path.join(state, files[0]), 'utf8');
    assert.doesNotMatch(contents, /private-path/);
    if (mode === 'approved') {
      assert.deepEqual(JSON.parse(stdout).hookSpecificOutput.decision, { behavior: 'allow' });
      assert.equal(JSON.parse(contents).status, 'working');
    } else {
      assert.equal(stdout, '', mode);
      assert.equal(JSON.parse(contents).status, 'approval', mode);
    }
  }
});
