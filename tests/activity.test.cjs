'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { activityFor, acceptedActivity, createActivity, stepTarget, patchFiles, planProgress, planItems,
  PROMPT_LIMIT, REPLY_LIMIT, TARGET_LIMIT, STEP_LIMIT, FILE_LIMIT, CHANGED_FILE_VIEW_LIMIT, PLAN_ITEM_LIMIT } = require('../src/activity.cjs');

const cwd = '/work/shop';
const char = code => String.fromCharCode(code);
// The escaped spelling a reader sees, built without writing an escape into this file.
const shown = code => char(92) + 'u' + code.toString(16).padStart(4, '0');
const step = (tool, tool_input, name = 'PostToolUse', provider = 'claude') => activityFor(provider, name, { tool_name: tool, tool_input }, cwd);

test('a step names its command, file, search or address in one short line', () => {
  assert.equal(stepTarget({ command: '\n\n  pnpm test -- --run\nrm -rf build', description: 'Run tests' }, cwd), 'pnpm test -- --run');
  assert.equal(stepTarget({ command: ['bash', '-lc', 'cd web && make\nmake install'] }, cwd), 'bash -lc cd web && make');
  assert.equal(stepTarget({ file_path: '/work/shop/checkout/retry.ts', old_string: 'a', new_string: 'b' }, cwd), 'checkout/retry.ts');
  assert.equal(stepTarget({ file_path: '/etc/hosts' }, cwd), '/etc/hosts', 'outside the folder the whole path is kept');
  assert.equal(stepTarget({ file_path: '/work/shop-backup/a.ts' }, cwd), '/work/shop-backup/a.ts', 'a sibling folder is not inside');
  assert.equal(stepTarget({ notebook_path: '/work/shop/nb/analysis.ipynb', new_source: 'x' }, cwd), 'nb/analysis.ipynb');
  assert.equal(stepTarget({ pattern: 'retryCount', path: '/work/shop/src' }, cwd), 'src');
  assert.equal(stepTarget({ pattern: 'retryCount', path: cwd }, cwd), 'retryCount', 'the folder itself says nothing; the search does');
  assert.equal(stepTarget({ pattern: '**/*.test.ts' }, cwd), '**/*.test.ts');
  assert.equal(stepTarget({ url: 'https://example.com/docs', prompt: 'Summarise' }, cwd), 'https://example.com/docs');
  assert.equal(stepTarget({ query: 'node net socket end callback' }, cwd), 'node net socket end callback');
  assert.equal(stepTarget({ description: 'Review the diff', prompt: 'Long instructions\nmore' }, cwd), 'Review the diff');
  assert.equal(stepTarget({ prompt: 'First line\nsecond line' }, cwd), 'First line');
  assert.equal(stepTarget({ title: 'An MCP issue', body: 'text' }, cwd), '', 'nothing recognisable, nothing shown');
  const deep = '/elsewhere/' + 'dir/'.repeat(80) + 'deep-file.ts';
  const kept = stepTarget({ file_path: deep }, cwd);
  assert.ok(kept.length <= TARGET_LIMIT && kept.startsWith('…') && kept.endsWith('/deep-file.ts'), 'a long path keeps its end');
  // A narrow row cuts text at its end: long paths outside the folder show their last segments, never a shared prefix.
  const scratch = (name, conversation) => stepTarget({ file_path: '/Users/dev/.gemini/antigravity/brain/' + conversation + '/scratch/' + name }, cwd);
  assert.equal(scratch('probe.py', 'c1'), '…/c1/scratch/probe.py');
  assert.equal(scratch('probe.py', '6f1d2c3b-aaaa-4bbb-8ccc-1234567890ab'), '…/scratch/probe.py', 'fewer segments when three are still long');
  assert.equal(scratch('a-much-longer-scratch-file-name.py', '6f1d2c3b-aaaa-4bbb-8ccc-1234567890ab'), '…/scratch/a-much-longer-scratch-file-name.py');
  assert.notEqual(scratch('one.py', 'c1'), scratch('two.py', 'c1'));
  assert.equal(stepTarget({ file_path: '/work/shop/' + 'nested/'.repeat(10) + 'inside.ts' }, cwd), 'nested/'.repeat(10) + 'inside.ts',
    'inside the folder a path stays relative and whole');
});

test('hostile tool input yields bounded, visible text and never throws', () => {
  const huge = 'x'.repeat(10 * 1024 * 1024);
  const started = Date.now();
  for (const input of [{ command: huge }, { command: ' '.repeat(5 * 1024 * 1024) + 'echo late' }, { file_path: huge },
    { command: [huge, huge] }, { prompt: 'y'.repeat(3 * 1024 * 1024) + '\nz' }]) {
    const target = stepTarget(input, cwd);
    assert.ok(target.length <= TARGET_LIMIT, 'bounded: ' + target.length);
  }
  assert.ok(Date.now() - started < 1000, 'bounded work on huge input');
  assert.ok(stepTarget({ command: huge }, cwd).endsWith('…'));
  for (const input of [null, undefined, 'ls', 42, ['ls'], { command: 7 }, { command: { run: 'ls' } }, { command: ['ls', 1] },
    { command: [] }, { file_path: ['a'] }, { path: { nested: { file_path: '/x' } } }, { command: '   \n\t ' },
    { command: Array.from({ length: 5000 }, () => 'a') }]) {
    assert.equal(typeof stepTarget(input, cwd), 'string', JSON.stringify(input)?.slice(0, 40));
  }
  assert.equal(stepTarget({ command: ['ls', 1], query: 'fallback' }, cwd), 'fallback', 'a mixed array is not a command');
  assert.equal(stepTarget({ command: '   ', file_path: '/work/shop/a.ts' }, cwd), 'a.ts', 'a blank command gives way to the next field');
  // Direction overrides and invisible characters read as escapes; tabs and other spaces become one space.
  const spoofed = stepTarget({ command: 'cat ' + char(0x202e) + 'txt.exe' + char(0x200b) + char(0xfeff) + '\tdone' + char(7) }, cwd);
  assert.equal(spoofed, 'cat ' + shown(0x202e) + 'txt.exe' + shown(0x200b) + shown(0xfeff) + ' done' + shown(7));
  for (const code of [0x202e, 0x200b, 0xfeff, 0x2066, 0x061c, 7]) assert.ok(!spoofed.includes(char(code)));
  // A cut never leaves half of a surrogate pair behind.
  const emoji = String.fromCodePoint(0x1f600);
  const cut = stepTarget({ command: 'a' + emoji.repeat(300) }, cwd);
  const last = cut.charCodeAt(cut.length - 2);
  assert.ok(!(last >= 0xd800 && last <= 0xdbff), 'no lone high surrogate before the mark');
  const tail = stepTarget({ file_path: '/x/' + emoji.repeat(150) + '.ts' }, cwd);
  const first = tail.charCodeAt(1);
  assert.ok(!(first >= 0xdc00 && first <= 0xdfff), 'no lone low surrogate after the mark');
});

test('a Codex patch is described by the files it names, never by its body', () => {
  const patch = ['*** Begin Patch', '*** Update File: src/retry.ts', '@@', '-const SECRET_OLD = 1;', '+const SECRET_NEW = 2;',
    '*** Add File: /work/shop/docs/retry.md', '+SECRET_DOC', '*** Delete File: src/legacy.ts', '*** Update File: src/retry.ts\r',
    '*** Move to: src/retry-policy.ts', '*** End Patch'].join('\n');
  assert.deepEqual(patchFiles(patch), ['src/retry-policy.ts', '/work/shop/docs/retry.md', 'src/legacy.ts']);
  const update = activityFor('codex', 'PostToolUse', { tool_name: 'apply_patch', tool_input: { command: patch } }, cwd);
  assert.deepEqual(update, { step: { tool: 'apply_patch', target: 'src/retry-policy.ts' },
    stepFile: '/work/shop/src/retry-policy.ts',
    files: ['/work/shop/src/retry-policy.ts', '/work/shop/docs/retry.md', '/work/shop/src/legacy.ts'] });
  assert.doesNotMatch(JSON.stringify(update), /SECRET|Begin Patch|@@/);
  assert.deepEqual(activityFor('codex', 'PostToolUse', { tool_name: 'apply_patch', tool_input: { command: 'not a patch' } }, cwd),
    { step: { tool: 'apply_patch', target: '' } }, 'an unreadable patch names nothing and shows nothing of itself');
  assert.equal(patchFiles(Array.from({ length: 100 }, (_, i) => '*** Add File: f' + i).join('\n')).length, 64);
  for (const value of [undefined, 3, ['*** Add File: a']]) assert.deepEqual(patchFiles(value), []);
});

test('plan progress comes from a whole to-do list; anything else gives none', () => {
  const todos = [{ content: 'a', status: 'completed', activeForm: 'A' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'pending' }];
  assert.deepEqual(planProgress('TodoWrite', { todos }), { done: 1, total: 3 });
  assert.deepEqual(planProgress('update_plan', { plan: [{ step: 'x', status: 'completed' }, { step: 'y', status: 'completed' }] }), { done: 2, total: 2 });
  assert.deepEqual(planProgress('TodoWrite', { todos: [] }), { done: 0, total: 0 }, 'a cleared list clears the progress');
  for (const [tool, input] of [['TodoWrite', { todos: [{ content: 'a' }] }], ['TodoWrite', { todos: 'all done' }], ['TodoWrite', null],
    ['TodoWrite', { todos: Array.from({ length: 501 }, () => ({ status: 'pending' })) }], ['Write', { todos }], ['TodoWrite', { plan: todos }],
    ['TodoWrite', { todos: [null] }]]) assert.equal(planProgress(tool, input), undefined, tool + ' ' + JSON.stringify(input)?.slice(0, 40));
  assert.deepEqual(step('TodoWrite', { todos }), {
    step: { tool: 'TodoWrite', target: '' },
    progress: { done: 1, total: 3 },
    plan: [{ text: 'a', status: 'completed' }, { text: 'b', status: 'in_progress' }, { text: 'c', status: 'pending' }],
  });
  // In-progress items prefer activeForm when provided, Codex update_plan uses step, and lists stay bounded.
  const activeTodos = [{ content: '테스트 실행', activeForm: '결제 테스트 실행 중', status: 'in_progress' }, { content: '정리', status: 'pending' }];
  assert.deepEqual(planItems('TodoWrite', { todos: activeTodos }), [
    { text: '결제 테스트 실행 중', status: 'in_progress' },
    { text: '정리', status: 'pending' },
  ]);
  assert.deepEqual(planItems('update_plan', { plan: [{ step: '스키마 확인', status: 'completed' }, { step: '마이그레이션', status: 'in_progress' }] }), [
    { text: '스키마 확인', status: 'completed' },
    { text: '마이그레이션', status: 'in_progress' },
  ]);
  const longPlan = Array.from({ length: 30 }, (_, i) => ({ content: '단계 ' + i, status: 'pending' }));
  assert.equal(planItems('TodoWrite', { todos: longPlan }).length, PLAN_ITEM_LIMIT);
});

test('each provider event says only what it carries; contents and results stay out', () => {
  assert.deepEqual(activityFor('claude', 'UserPromptSubmit', { prompt: '  결제 재시도 로직을 고쳐 줘\r\n두 번까지만  ' }, cwd),
    { prompt: '결제 재시도 로직을 고쳐 줘\n두 번까지만', restart: true });
  const ide = '# Context from my IDE setup:\n\n## Active file: src/a.ts\n\n## Open tabs:\n- a.ts: src/a.ts\n\n## My request for Codex:\n실패하는 테스트를 고쳐 줘\n';
  assert.deepEqual(activityFor('codex', 'UserPromptSubmit', { prompt: ide }, cwd), { prompt: '실패하는 테스트를 고쳐 줘', restart: true });
  assert.equal(activityFor('codex', 'UserPromptSubmit', { prompt: '## My request for Codex: is only text here' }, cwd).prompt,
    '## My request for Codex: is only text here', 'without the IDE preamble the prompt is kept whole');
  const long = activityFor('claude', 'UserPromptSubmit', { prompt: '가'.repeat(5000) }, cwd).prompt;
  assert.ok(long.length === PROMPT_LIMIT && long.endsWith('…'));
  for (const prompt of [undefined, '', '  \n ', 7, { text: 'x' }]) assert.equal(activityFor('claude', 'UserPromptSubmit', { prompt }, cwd), undefined);
  // Antigravity repeats its turn's request before every model call and reports tool steps via PostToolUse.
  assert.deepEqual(activityFor('agy', 'PreInvocation', { lastUserInput: 'Fix the failing unit test', modelName: 'gemini-3.6-flash' }, cwd),
    { prompt: 'Fix the failing unit test' });
  assert.equal(activityFor('claude', 'PreInvocation', { lastUserInput: 'x' }, cwd), undefined);
  assert.deepEqual(activityFor('agy', 'PostToolUse', { toolCall: { name: 'ask_question', args: {} } }, cwd),
    { step: { tool: 'ask_question', target: '' } });
  assert.deepEqual(activityFor('agy', 'PostToolUse', { toolCall: { name: 'run_command', args: { CommandLine: 'npm test' } }, error: 'Exit code 1' }, cwd),
    { step: { tool: 'run_command', target: 'npm test', failed: true } });
  assert.deepEqual(activityFor('agy', 'Stop', { fullyIdle: true, terminationReason: 'model_stop', last_assistant_message: 'x' }, cwd), { finished: true });
  assert.equal(activityFor('agy', 'Stop', { fullyIdle: false, terminationReason: 'model_stop' }, cwd), undefined);
  assert.deepEqual(activityFor('agy', 'Stop', { fullyIdle: true, terminationReason: 'ERROR', error: 'Quota exceeded' }, cwd),
    { reply: 'Quota exceeded' });
  // A tool step: written files count only when the call succeeded.
  assert.deepEqual(step('Write', { file_path: '/work/shop/a.ts', content: 'SECRET FILE BODY' }),
    { step: { tool: 'Write', target: 'a.ts' }, stepFile: '/work/shop/a.ts', files: ['/work/shop/a.ts'] });
  assert.deepEqual(step('Edit', { file_path: 'relative/b.ts', old_string: 'SECRET', new_string: 'SECRET2' }, 'PostToolUseFailure'),
    { step: { tool: 'Edit', target: 'relative/b.ts', failed: true }, stepFile: '/work/shop/relative/b.ts' });
  assert.deepEqual(step('MultiEdit', { file_path: '/work/shop/c.ts', edits: [{ old_string: 'SECRET', new_string: 'x' }] }).files, ['/work/shop/c.ts']);
  assert.deepEqual(step('NotebookEdit', { notebook_path: 'nb.ipynb', new_source: 'SECRET' }).files, ['/work/shop/nb.ipynb']);
  assert.equal(step('Read', { file_path: '/work/shop/a.ts' }).files, undefined, 'reading changes nothing');
  const withResult = activityFor('claude', 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'cat .env' },
    tool_response: { stdout: 'SECRET=1' } }, cwd);
  assert.deepEqual(withResult, { step: { tool: 'Bash', target: 'cat .env' } });
  for (const tool of [undefined, '', '../x', 'a b', 'x'.repeat(161)]) assert.equal(step(tool, { command: 'ls' }), undefined, String(tool));
  for (const payload of [null, 'x', ['x']]) assert.equal(activityFor('claude', 'PostToolUse', payload, cwd), undefined);
  // A finished turn's answer, a subagent's answer and the error that ended a turn.
  assert.deepEqual(activityFor('claude', 'Stop', { last_assistant_message: '고쳤습니다.\n\n세부 사항' }, cwd), { reply: '고쳤습니다.\n\n세부 사항' });
  assert.deepEqual(activityFor('codex', 'SubagentStop', { last_assistant_message: 'Found 3 issues' }, cwd), { reply: 'Found 3 issues' });
  assert.deepEqual(activityFor('claude', 'StopFailure', { last_assistant_message: 'API Error: Rate limit reached' }, cwd),
    { reply: 'API Error: Rate limit reached' });
  assert.deepEqual(activityFor('claude', 'StopFailure', { error: 'rate_limit', error_details: "You've hit your limit · resets 5pm" }, cwd),
    { reply: "You've hit your limit · resets 5pm" });
  assert.deepEqual(activityFor('claude', 'StopFailure', { last_assistant_message: '   ', error_details: 'Quota exhausted' }, cwd),
    { reply: 'Quota exhausted' });
  assert.equal(activityFor('codex', 'Stop', { last_assistant_message: null }, cwd), undefined);
  assert.equal(activityFor('claude', 'Stop', { last_assistant_message: 'r'.repeat(5000) }, cwd).reply.length, REPLY_LIMIT);
  for (const name of ['SessionStart', 'SubagentStart', 'Notification', 'SessionEnd', 'PreToolUse', 'PermissionRequest', 'Interrupt']) {
    assert.equal(activityFor('claude', name, { prompt: 'x', tool_name: 'Bash', tool_input: { command: 'ls' }, last_assistant_message: 'x' }, cwd), undefined, name);
  }
});

test('a window accepts only one well-formed piece of activity at a time', () => {
  assert.deepEqual(acceptedActivity({ prompt: ' 요청 ', restart: true }), { prompt: '요청', restart: true });
  assert.deepEqual(acceptedActivity({ prompt: '요청', restart: 'yes' }), { prompt: '요청', restart: false });
  assert.deepEqual(acceptedActivity({ reply: '답' }), { reply: '답' });
  assert.deepEqual(acceptedActivity({ step: { tool: 'Bash', target: 'ls', failed: true }, progress: { done: 1, total: 2 },
    plan: [{ text: '테스트 실행', status: 'in_progress' }], files: ['/w/a'] }),
    { step: { tool: 'Bash', target: 'ls', failed: true }, progress: { done: 1, total: 2 },
      plan: [{ text: '테스트 실행', status: 'in_progress' }], files: ['/w/a'] });
  assert.deepEqual(acceptedActivity({ step: { tool: 'Bash' } }), { step: { tool: 'Bash', target: '' }, files: [] });
  assert.equal(acceptedActivity({ prompt: 'p'.repeat(10000) }).prompt.length, PROMPT_LIMIT, 'a longer piece from another release is cut, not refused');
  const hidden = acceptedActivity({ reply: 'ok' + char(0x202e) + 'x' }).reply;
  assert.equal(hidden, 'ok' + shown(0x202e) + 'x');
  for (const update of [null, [], {}, { prompt: 'a', reply: 'b' }, { prompt: 'a', step: { tool: 'Bash' } }, { prompt: '   ' }, { prompt: 3 },
    { reply: { text: 'x' } }, { step: 'Bash' }, { step: { tool: 'a b' } }, { step: { tool: 'Bash', target: 3 } },
    { step: { tool: 'Bash', failed: 'yes' } },
    { step: { tool: 'Bash' }, plan: 'bad' }, { step: { tool: 'Bash' }, plan: [{ text: 'x', status: 'unknown' }] },
    { step: { tool: 'Bash' }, plan: Array.from({ length: PLAN_ITEM_LIMIT + 1 }, () => ({ text: 'x', status: 'pending' })) },
    { step: { tool: 'Bash' }, progress: { done: 3, total: 2 } }, { step: { tool: 'Bash' }, progress: { done: -1, total: 2 } },
    { step: { tool: 'Bash' }, progress: { done: 1, total: 501 } }, { step: { tool: 'Bash' }, progress: { done: 0.5, total: 2 } },
    { step: { tool: 'Bash' }, progress: 'half' }, { step: { tool: 'Bash' }, files: '/w/a' }, { step: { tool: 'Bash' }, files: ['relative'] },
    { step: { tool: 'Bash' }, files: [3] }, { step: { tool: 'Bash' }, files: ['/w/' + char(0)] },
    { step: { tool: 'Bash' }, files: Array.from({ length: 65 }, (_, i) => '/w/' + i) }]) {
    assert.equal(acceptedActivity(update), undefined, JSON.stringify(update)?.slice(0, 80));
  }
});

test('a turn runs from its request through steps, progress and changed files to its reply; the next request starts over', () => {
  let now = 1000;
  const store = createActivity({ now: () => now });
  const key = 'claude/s1';
  assert.equal(store.get(key), undefined);
  assert.equal(store.record(key, { prompt: '결제 재시도 로직을 고쳐 줘', restart: true }), true);
  now += 10; store.record(key, { step: { tool: 'Read', target: 'checkout/retry.ts' }, files: [] });
  now += 10; store.record(key, { step: { tool: 'Edit', target: 'checkout/retry.ts' }, files: ['/w/checkout/retry.ts'] });
  now += 10; store.record(key, { step: { tool: 'Edit', target: 'checkout/retry.ts' }, files: ['/w/checkout/retry.ts'] });
  now += 10; store.record(key, { step: { tool: 'apply_patch', target: 'a.ts' }, files: ['/w/a.ts', '/w/b.ts'] });
  now += 10; store.record(key, { step: { tool: 'TodoWrite', target: '' }, progress: { done: 2, total: 5 }, files: [] });
  let view = store.get(key);
  assert.equal(view.prompt, '결제 재시도 로직을 고쳐 줘');
  assert.deepEqual(view.activity, { tool: 'TodoWrite', target: '', at: 1050 });
  assert.deepEqual(view.steps.map(entry => [entry.tool, entry.at]), [['TodoWrite', 1050], ['apply_patch', 1040], ['Edit', 1030], ['Edit', 1020], ['Read', 1010]],
    'newest first');
  assert.deepEqual(view.progress, { done: 2, total: 5 });
  assert.equal(view.changed, 3, 'distinct files only');
  assert.equal(view.reply, undefined);
  now += 10; assert.equal(store.record(key, { reply: '재시도를 세 번으로 제한했습니다.' }), true);
  assert.equal(store.record(key, { reply: '재시도를 세 번으로 제한했습니다.' }), false, 'the same reply changes nothing');
  assert.equal(store.get(key).reply, '재시도를 세 번으로 제한했습니다.');
  // The next request clears the turn's steps, progress and files and keeps the last reply until a new one.
  now += 10; store.record(key, { prompt: '테스트도 추가해 줘', restart: true });
  view = store.get(key);
  assert.deepEqual(view, { prompt: '테스트도 추가해 줘', reply: '재시도를 세 번으로 제한했습니다.' });
  now += 10; store.record(key, { step: { tool: 'TodoWrite', target: '' }, progress: { done: 0, total: 3 }, files: [] });
  now += 10; store.record(key, { step: { tool: 'TodoWrite', target: '' }, progress: { done: 0, total: 0 }, files: [] });
  assert.equal(store.get(key).progress, undefined, 'a cleared plan shows no progress');
  now += 10; store.record(key, { reply: '테스트를 추가했습니다.' });
  assert.equal(store.get(key).reply, '테스트를 추가했습니다.');
  // The same request again is a new turn when it was submitted, but not when it is only repeated.
  store.record(key, { step: { tool: 'Bash', target: 'ls' }, files: [] });
  const before = store.get(key).steps.length;
  assert.equal(store.record(key, { prompt: '테스트도 추가해 줘' }), false);
  assert.equal(store.get(key).steps.length, before);
  assert.equal(store.record(key, { prompt: '테스트도 추가해 줘', restart: true }), true);
  assert.equal(store.get(key).steps, undefined);
  assert.equal(store.record(key, { prompt: 'Another request' }), true, 'a different repeated request starts a turn');
  // What a caller receives is a copy.
  store.record(key, { step: { tool: 'Bash', target: 'ls' }, files: [] });
  store.get(key).steps[0].target = 'changed';
  store.get(key).activity.tool = 'changed';
  assert.deepEqual(store.get(key).activity, { tool: 'Bash', target: 'ls', at: now });
});

test('activity is bounded in steps, files, sessions and age, and goes when its session leaves the list', () => {
  let now = 0;
  const store = createActivity({ limit: 3, ttl: 1000, now: () => now });
  for (let i = 0; i < STEP_LIMIT + 4; i++) store.record('codex/a', { step: { tool: 'Bash', target: 'step ' + i }, files: [] });
  const steps = store.get('codex/a').steps;
  assert.equal(steps.length, STEP_LIMIT);
  assert.equal(steps[0].target, 'step ' + (STEP_LIMIT + 3));
  const many = Array.from({ length: FILE_LIMIT + 30 }, (_, i) => '/w/file-' + i);
  for (let i = 0; i < many.length; i += 64) store.record('codex/a', { step: { tool: 'apply_patch', target: '' }, files: many.slice(i, i + 64) });
  assert.equal(store.get('codex/a').changed, FILE_LIMIT);
  // The least recently active session makes room.
  now = 10; store.record('codex/b', { prompt: 'b', restart: true });
  now = 20; store.record('codex/c', { prompt: 'c', restart: true });
  now = 30; store.record('codex/a', { reply: 'still here' });
  now = 40; store.record('codex/d', { prompt: 'd', restart: true });
  assert.equal(store.get('codex/b'), undefined);
  assert.deepEqual(['codex/a', 'codex/c', 'codex/d'].map(key => Boolean(store.get(key))), [true, true, true]);
  assert.equal(store.size, 3);
  // Old activity expires.
  now = 1025; assert.equal(store.get('codex/c'), undefined);
  assert.ok(store.get('codex/a'));
  now = 1035; store.record('codex/e', { prompt: 'e', restart: true });
  assert.equal(store.size, 2, 'expired sessions are dropped on the next update');
  // A scan keeps listed sessions and those it may not have read yet.
  store.prune(key => key === 'codex/e', 1036);
  assert.deepEqual([store.get('codex/d'), Boolean(store.get('codex/e'))], [undefined, true]);
  now = 1040; store.record('codex/f', { prompt: 'f', restart: true });
  store.prune(() => false, 1040);
  assert.ok(store.get('codex/f'), 'updated at or after the scan began');
  store.prune(() => false, 1041);
  assert.equal(store.get('codex/f'), undefined);
  store.record('codex/g', { prompt: 'g', restart: true });
  store.clear();
  assert.equal(store.size, 0);
});

test('changedFiles keeps relative display paths newest first, bounded and cleared on restart', () => {
  let now = 500;
  const store = createActivity({ now: () => now });
  store.record('claude/files', { prompt: '리팩터링', restart: true }, '/w');
  store.record('claude/files', { step: { tool: 'Edit', target: 'src/a.ts' }, files: ['/w/src/a.ts'] }, '/w');
  store.record('claude/files', { step: { tool: 'Write', target: 'src/b.ts' }, files: ['/w/src/b.ts'] }, '/w');
  store.record('claude/files', { step: { tool: 'Edit', target: 'src/a.ts' }, files: ['/w/src/a.ts'] }, '/w');
  assert.deepEqual(store.get('claude/files').changedFiles, ['src/a.ts', 'src/b.ts']);
  assert.equal(store.get('claude/files').changed, 2);
  for (let i = 0; i < CHANGED_FILE_VIEW_LIMIT + 5; i++) {
    store.record('claude/files', { step: { tool: 'Edit', target: 'f' + i }, files: ['/w/f' + i + '.ts'] }, '/w');
  }
  assert.equal(store.get('claude/files').changedFiles.length, CHANGED_FILE_VIEW_LIMIT);
  store.record('claude/files', { prompt: '새 작업', restart: true }, '/w');
  assert.equal(store.get('claude/files').changedFiles, undefined);
});

test('files written outside the workspace stay out of its changed-file footprint and chips', () => {
  const store = createActivity({ now: () => 1000 });
  const scratch = '/Users/dev/.gemini/antigravity/brain/c1/scratch/probe.py';
  store.record('agy/s', { prompt: '조사', restart: true }, '/w/app', '/w');
  store.record('agy/s', { step: { tool: 'write_to_file', target: scratch }, stepFile: scratch, files: [scratch] }, '/w/app', '/w');
  store.record('agy/s', { step: { tool: 'write_to_file', target: 'src/a.ts' }, stepFile: '/w/app/src/a.ts', files: ['/w/app/src/a.ts'] }, '/w/app', '/w');
  const view = store.get('agy/s');
  assert.deepEqual(view.changedFiles, ['app/src/a.ts']);
  assert.equal(view.changed, 1);
  assert.equal(view.steps[1].target, '…/c1/scratch/probe.py', 'the step still says which file it wrote');
  // Without a known folder every file counts, as before.
  const loose = createActivity({ now: () => 1000 });
  loose.record('agy/t', { step: { tool: 'write_to_file', target: 'x' }, files: [scratch] });
  assert.equal(loose.get('agy/t').changed, 1);
});

test('Antigravity update_steps, update_focus and file writers track live progress in memory', () => {
  let now = 1000;
  const store = createActivity({ now: () => now });
  const stepsEvent = activityFor('agy', 'PostToolUse', {
    toolCall: {
      name: 'update_steps',
      args: {
        steps: [
          { title: 'Investigate empty sessions', status: 'done' },
          { title: 'Fix SessionStart handling', status: 'in_progress' },
          { title: 'Skip optional migration', status: 'skipped' },
          { title: 'Verify hooks', status: 'failed' },
          { title: 'Package VSIX', status: 'pending' },
        ],
      },
    },
  }, cwd);
  assert.deepEqual(stepsEvent.progress, { done: 1, total: 5 });
  assert.deepEqual(stepsEvent.plan, [
    { text: 'Investigate empty sessions', status: 'completed' },
    { text: 'Fix SessionStart handling', status: 'in_progress' },
    { text: 'Skip optional migration', status: 'skipped' },
    { text: 'Verify hooks', status: 'failed' },
    { text: 'Package VSIX', status: 'pending' },
  ]);
  const focusEvent = activityFor('agy', 'PostToolUse', {
    toolCall: { name: 'update_focus', args: { focus: 'Inspecting Claude blank tabs' } },
  }, cwd);
  assert.deepEqual(focusEvent, { step: { tool: 'update_focus', target: 'Inspecting Claude blank tabs' }, focus: 'Inspecting Claude blank tabs' });
  const editEvent = activityFor('agy', 'PostToolUse', {
    toolCall: { name: 'edit_file', args: { Path: '/work/shop/src/hook.cjs', Target: 'SECRET', Replacement: 'SECRET2' } },
  }, cwd);
  assert.deepEqual(editEvent, { step: { tool: 'edit_file', target: 'src/hook.cjs' }, stepFile: '/work/shop/src/hook.cjs', files: ['/work/shop/src/hook.cjs'] });
  assert.doesNotMatch(JSON.stringify(editEvent), /SECRET/);

  store.record('agy/a1', acceptedActivity(stepsEvent), cwd);
  now += 10;
  store.record('agy/a1', acceptedActivity(focusEvent), cwd);
  now += 10;
  store.record('agy/a1', acceptedActivity(editEvent), cwd);
  const view = store.get('agy/a1');
  assert.equal(view.focus, 'Inspecting Claude blank tabs', 'focus persists across subsequent tool steps');
  assert.deepEqual(view.progress, { done: 1, total: 5 });
  assert.deepEqual(view.changedFiles, ['src/hook.cjs']);
  now += 10;
  store.record('agy/a1', { reply: 'Done' }, cwd);
  assert.equal(store.get('agy/a1').focus, undefined, 'reply clears transient focus');
});

test('Claude incremental TaskCreate/TaskUpdate/TaskList and Codex cmd/apply_patch/spawn_agent sync cleanly', () => {
  let now = 2000;
  const store = createActivity({ now: () => now });
  const c1 = activityFor('claude', 'PostToolUse', {
    tool_name: 'TaskCreate', tool_input: { subject: '원인 분석', activeForm: '원인 분석 중' }, tool_response: { task: { id: '1' } },
  }, cwd);
  const c2 = activityFor('claude', 'PostToolUse', {
    tool_name: 'TaskCreate', tool_input: { subject: '테스트 작성' }, tool_response: 'Task #2 created',
  }, cwd);
  const u1 = activityFor('claude', 'PostToolUse', {
    tool_name: 'TaskUpdate', tool_input: { taskId: '1', status: 'in_progress' },
  }, cwd);
  const u2 = activityFor('claude', 'PostToolUse', {
    tool_name: 'TaskUpdate', tool_input: { taskId: '1', status: 'completed' },
  }, cwd);
  for (const ev of [c1, c2, u1]) { now += 10; store.record('claude/t1', acceptedActivity(ev), cwd); }
  assert.deepEqual(store.get('claude/t1').progress, { done: 0, total: 2 });
  assert.deepEqual(store.get('claude/t1').plan, [
    { text: '원인 분석 중', status: 'in_progress' },
    { text: '테스트 작성', status: 'pending' },
  ]);
  now += 10;
  store.record('claude/t1', acceptedActivity(u2), cwd);
  assert.deepEqual(store.get('claude/t1').progress, { done: 1, total: 2 });
  assert.deepEqual(store.get('claude/t1').plan[0], { text: '원인 분석', status: 'completed' });
  const list = activityFor('claude', 'PostToolUse', {
    tool_name: 'TaskList', tool_input: {}, tool_response: { tasks: [{ id: '1', subject: '원인 분석', status: 'completed' }, { id: '2', subject: '테스트 작성', status: 'deleted' }] },
  }, cwd);
  assert.deepEqual(list.progress, { done: 1, total: 1 });
  assert.equal(stepTarget({ skill: 'run-workflow' }, cwd), 'run-workflow');
  assert.equal(stepTarget({ cmd: 'git status' }, cwd), 'git status');
  assert.equal(stepTarget({ task_name: 'audit_hooks', message: 'Check hooks' }, cwd), 'audit_hooks');
  const patchByInput = activityFor('codex', 'PostToolUse', {
    tool_name: 'apply_patch', tool_input: { input: '*** Begin Patch\n*** Update File: src/a.cjs\n@@\n-SECRET\n+PUBLIC\n*** End Patch' },
  }, cwd);
  assert.deepEqual(patchByInput, { step: { tool: 'apply_patch', target: 'src/a.cjs' }, stepFile: '/work/shop/src/a.cjs', files: ['/work/shop/src/a.cjs'] });
});

test('turn isolation drops late steps, replies and prompts from prior or mismatched turns', () => {
  let now = 1000;
  const store = createActivity({ now: () => now });
  const key = 'claude/turns';
  assert.equal(acceptedActivity({ prompt: 'first', restart: true, turn: 't1' }).turn, 't1');
  assert.equal(acceptedActivity({ prompt: 'bad', restart: true, turn: '../bad' }), undefined);

  assert.equal(store.record(key, { prompt: 'turn 1', restart: true, turn: 't1' }), true);
  now += 10;
  assert.equal(store.record(key, { step: { tool: 'Bash', target: 'ls' }, turn: 't1', files: [] }), true);
  now += 10;
  assert.equal(store.record(key, { prompt: 'turn 2', restart: true, turn: 't2' }), true);
  now += 10;
  // Late step and reply from t1 must be dropped.
  assert.equal(store.record(key, { step: { tool: 'Read', target: 'old.ts' }, turn: 't1', files: [] }), false);
  assert.equal(store.record(key, { reply: 'late reply from t1', turn: 't1' }), false);
  assert.equal(store.record(key, { prompt: 'replayed t1', restart: true, turn: 't1' }), false);
  // Mismatched turn t3 is also dropped while t2 is active.
  assert.equal(store.record(key, { step: { tool: 'Read', target: 'other.ts' }, turn: 't3', files: [] }), false);
  assert.equal(store.get(key).steps, undefined);
  assert.equal(store.get(key).reply, undefined);
  // Current turn t2 updates cleanly.
  assert.equal(store.record(key, { step: { tool: 'Edit', target: 'new.ts' }, turn: 't2', files: ['/w/new.ts'] }), true);
  assert.equal(store.record(key, { reply: 'reply from t2', turn: 't2' }), true);
  assert.equal(store.get(key).steps.length, 1);
  assert.equal(store.get(key).reply, 'reply from t2');
});

test('Claude TaskList preserves task map so subsequent TaskUpdate and TaskCreate continue seamlessly', () => {
  let now = 1000;
  const store = createActivity({ now: () => now });
  const key = 'claude/tasks';
  const list = activityFor('claude', 'PostToolUse', {
    tool_name: 'TaskList',
    tool_input: {},
    tool_response: {
      tasks: [
        { id: '1', subject: 'Inspect hooks', status: 'completed' },
        { id: '2', subject: 'Fix TaskList', activeForm: 'Fixing TaskList', status: 'in_progress' },
        { id: '3', subject: 'Old task', status: 'deleted' },
      ],
    },
  }, cwd);
  assert.equal(list.tasks.length, 2);
  const validated = acceptedActivity(list);
  assert.equal(validated.tasks.length, 2);
  assert.equal(acceptedActivity({ step: { tool: 'TaskList' }, tasks: [{ id: '../bad', subject: 'x', status: 'pending' }] }), undefined);

  store.record(key, validated, cwd);
  assert.deepEqual(store.get(key).progress, { done: 1, total: 2 });
  assert.deepEqual(store.get(key).plan, [
    { text: 'Inspect hooks', status: 'completed' },
    { text: 'Fixing TaskList', status: 'in_progress' },
  ]);

  now += 10;
  const update = acceptedActivity(activityFor('claude', 'PostToolUse', {
    tool_name: 'TaskUpdate', tool_input: { taskId: '2', status: 'completed' },
  }, cwd));
  store.record(key, update, cwd);
  assert.deepEqual(store.get(key).progress, { done: 2, total: 2 });
  assert.deepEqual(store.get(key).plan[1], { text: 'Fix TaskList', status: 'completed' });

  // A subsequent TaskCreate without explicit id allocates id '3' without colliding with '1' or '2'.
  now += 10;
  const create = acceptedActivity(activityFor('claude', 'PostToolUse', {
    tool_name: 'TaskCreate', tool_input: { subject: 'Run tests' },
  }, cwd));
  store.record(key, create, cwd);
  assert.deepEqual(store.get(key).progress, { done: 2, total: 3 });
});

test('file paths deduplicate by canonical absolute path across cd changes and resolve back accurately', () => {
  let now = 1000;
  const store = createActivity({ now: () => now });
  const key = 'claude/cd';
  const editRoot = acceptedActivity(activityFor('claude', 'PostToolUse', {
    tool_name: 'Edit', tool_input: { file_path: '/repo/package.json' },
  }, '/repo'));
  store.record(key, editRoot, '/repo', '/repo');
  now += 10;
  // After cd into /repo/packages/app, editing the same /repo/package.json and reading relative src/index.ts.
  const editAfterCd = acceptedActivity(activityFor('claude', 'PostToolUse', {
    tool_name: 'Edit', tool_input: { file_path: '../../package.json' },
  }, '/repo/packages/app'));
  store.record(key, editAfterCd, '/repo/packages/app', '/repo');
  now += 10;
  const readSub = acceptedActivity(activityFor('claude', 'PostToolUse', {
    tool_name: 'Read', tool_input: { file_path: 'src/index.ts' },
  }, '/repo/packages/app'));
  store.record(key, readSub, '/repo/packages/app', '/repo');

  const view = store.get(key);
  assert.deepEqual(view.changedFiles, ['package.json']);
  assert.equal(view.changed, 1);
  assert.equal(view.steps[0].target, 'packages/app/src/index.ts');
  assert.equal(store.resolveFile(key, 'package.json'), '/repo/package.json');
  assert.equal(store.resolveFile(key, 'packages/app/src/index.ts'), '/repo/packages/app/src/index.ts');
  assert.equal(store.resolveFile(key, 'missing.ts'), undefined);
});

test('parity targets (questions, filePath/File/Message/summary/chars, outline tools), TaskCreate blocks, TaskUpdate enrichment, and AGY restart/finished', () => {
  assert.equal(stepTarget({ questions: [{ question: '어떤 방식으로 진행할까요?' }] }, cwd), '어떤 방식으로 진행할까요?');
  assert.equal(stepTarget({ filePath: '/work/shop/src/a.cjs' }, cwd), 'src/a.cjs');
  assert.equal(stepTarget({ File: '/work/shop/src/b.cjs' }, cwd), 'src/b.cjs');
  assert.equal(stepTarget({ Message: 'Please approve deployment' }, cwd), 'Please approve deployment');
  assert.equal(stepTarget({ summary: 'Summarize diff' }, cwd), 'Summarize diff');
  assert.equal(stepTarget({ session_id: 4, chars: 'yes\n' }, cwd), 'yes');
  assert.equal(activityFor('agy', 'PostToolUse', { toolCall: { name: 'view_file_outline', args: { AbsolutePath: '/work/shop/src/hook.cjs' } } }, cwd).stepFile, '/work/shop/src/hook.cjs');
  assert.equal(activityFor('agy', 'PostToolUse', { toolCall: { name: 'view_code_item', args: { File: '/work/shop/src/hook.cjs' } } }, cwd).stepFile, '/work/shop/src/hook.cjs');

  // TaskCreate parses Task #N from array-of-text-blocks response; TaskUpdate enriches #N with activeForm/subject.
  let now = 1000;
  const store = createActivity({ now: () => now });
  const cBlock = activityFor('claude', 'PostToolUse', {
    tool_name: 'TaskCreate',
    tool_input: { subject: '린트 확인', activeForm: '린트 확인 중' },
    tool_response: [{ type: 'text', text: 'Created Task #7 successfully' }],
  }, cwd);
  assert.equal(cBlock.taskOp.id, '7');
  store.record('claude/tu', acceptedActivity(cBlock), cwd);
  now += 10;
  const uBlock = activityFor('claude', 'PostToolUse', {
    tool_name: 'TaskUpdate',
    tool_input: { taskId: '7', status: 'in_progress' },
  }, cwd);
  assert.equal(uBlock.step.target, '#7');
  store.record('claude/tu', acceptedActivity(uBlock), cwd);
  assert.equal(store.get('claude/tu').steps[0].target, '린트 확인 중');

  // AGY PreInvocation restart option & invocationNum: 1, plus Stop reply & finished clearing stale error/focus.
  assert.deepEqual(activityFor('agy', 'PreInvocation', { lastUserInput: 'Retry' }, cwd, { restart: true }), { prompt: 'Retry', restart: true });
  assert.deepEqual(activityFor('agy', 'PreInvocation', { lastUserInput: 'Retry', invocationNum: 1 }, cwd), { prompt: 'Retry', restart: true });
  assert.deepEqual(activityFor('agy', 'Stop', { fullyIdle: true, lastAssistantMessage: 'All green' }, cwd), { reply: 'All green' });
  assert.deepEqual(activityFor('agy', 'Stop', { fullyIdle: true }, cwd, { transcriptReply: 'From transcript' }), { reply: 'From transcript' });
  assert.deepEqual(acceptedActivity({ finished: true }), { finished: true });
  assert.equal(acceptedActivity({ finished: false }), undefined);
  assert.equal(acceptedActivity({ finished: true, reply: 'both' }), undefined);

  assert.equal(store.record('agy/ghost', { finished: true }), false);
  assert.equal(store.get('agy/ghost'), undefined);
  store.record('agy/s1', { prompt: 'Turn 1', restart: true });
  store.record('agy/s1', { step: { tool: 'update_focus', target: 'Checking' }, focus: 'Checking', files: [] });
  store.record('agy/s1', { reply: 'Turn 1 error' });
  store.record('agy/s1', { prompt: 'Turn 1', restart: true });
  store.record('agy/s1', { step: { tool: 'update_focus', target: 'Retrying' }, focus: 'Retrying', files: [] });
  assert.equal(store.get('agy/s1').reply, 'Turn 1 error');
  assert.equal(store.record('agy/s1', { finished: true }), true);
  assert.equal(store.get('agy/s1').reply, undefined);
  assert.equal(store.get('agy/s1').focus, undefined);
  assert.equal(store.record('agy/s1', { finished: true }), false);
});
