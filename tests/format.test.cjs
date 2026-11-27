'use strict';
require('../media/i18n.js').setLocale('ko'); // These cases check the Korean text; i18n.test.cjs covers English.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sinceText, remainingText, resetInText, diffStats, percentLabel, byteSizeText, visible, visibleCommand, shellJoin, foldBlankRuns, lineChanges, modelName,
  quotaLabel, shortLimitLabel, representativeWindow, limitName, requestToken, dismissKey, requestOrder, toolKind, stepText, parseInput, previewQuestions, parseApplyPatch, inputTarget, requestBlocks, requestSummary,
  activePlanStep, errorLabel, depletedQuotaHint, workPhase, fileTargetOf, matchesFilter, subtitleFor } = require('../media/format.js');
const point = (...codes) => String.fromCodePoint(...codes);

test('model names read as a family and version for any Claude family, and stay raw when unknown', () => {
  const cases = {
    'claude-fable-5-2': 'Fable 5.2', 'claude-opus-5-5[1m]': 'Opus 5.5 (1M)', 'claude-sonnet-4-6': 'Sonnet 4.6',
    'claude-haiku-5-5': 'Haiku 5.5', 'claude-opus-4-20250514': 'Opus 4', 'claude-sonnet-4-5-20250929': 'Sonnet 4.5',
    'claude-3-5-sonnet-20241022': 'Sonnet 3.5', 'claude-3-opus-20240229': 'Opus 3', 'claude-mythos-5-2[1M]': 'Mythos 5.2 (1M)',
    'gpt-5.4': 'GPT-5.4', 'gpt-5.4-mini': 'GPT-5.4 mini', 'o4-mini': 'o4-mini', 'claude-next': 'claude-next',
  };
  for (const [id, shown] of Object.entries(cases)) assert.equal(modelName(id, {}, 'claude'), shown, id);
  assert.equal(modelName(undefined, {}, 'claude'), '');
  const called = { modelSource: 'call', effortSource: 'call', effort: 'medium' };
  assert.equal(modelName('gemini-3.6-flash-medium', called, 'agy'), 'Gemini 3.6 Flash');
  assert.equal(modelName('gemini-3.6-flash-medium', { ...called, effortSource: 'setting' }, 'agy'), 'gemini-3.6-flash-medium');
});

test('durations appear from the first whole minute and count down to zero', () => {
  const now = Date.UTC(2026, 10, 24, 12), minute = 60000;
  assert.equal(sinceText('for', now - 59000, now), '');
  assert.equal(sinceText('for', now - minute, now), '1분');
  assert.equal(sinceText('for', now - 59 * minute, now), '59분');
  assert.equal(sinceText('for', now - 60 * minute, now), '1시간');
  assert.equal(sinceText('for', now - 49 * 60 * minute, now), '2일');
  assert.equal(sinceText('ago', now - 4 * minute, now), '4분 전');
  for (const invalid of [undefined, 'x', now + minute]) assert.equal(sinceText('for', invalid, now), '');
  assert.equal(remainingText(now + 38000, now), '38초 남음');
  assert.equal(remainingText(now + 125000, now), '2분 5초 남음');
  assert.equal(remainingText(now - 1, now), '0초 남음');
  assert.equal(percentLabel(0.04), '<0.1');
  assert.equal(percentLabel(100 - 82.2), '17.8');
});

test('request text shows direction overrides and invisible characters instead of obeying them', () => {
  const shown = visible('rm -rf \u202e/tmp\u2066x\u200b\u200e\u061c\ufeff\u0007\r');
  assert.equal(shown, 'rm -rf \\u202e/tmp\\u2066x\\u200b\\u200e\\u061c\\ufeff\\u0007\\u000d');
  assert.equal(visible('a\tb\nc 한글 👩\u200d💻'), 'a\tb\nc 한글 👩\u200d💻');
  assert.equal(visible(12), '12');
});

test('nothing a reader cannot see survives in request text, except the joiners inside an emoji', () => {
  const hidden = {
    'tag characters': point(0xE0074, 0xE0068), 'soft hyphen': point(0xAD), 'zero width space': point(0x200B),
    'zero width non-joiner': point(0x200C), 'lone joiner': point(0x200D), 'invisible times': point(0x2062), 'mongolian vowel separator': point(0x180E),
    'hangul filler': point(0x3164), 'braille blank': point(0x2800), 'line separator': point(0x2028), 'paragraph separator': point(0x2029),
    'lone variation selector': point(0xFE0F), 'supplementary variation selector': point(0xE0100), 'byte order mark': point(0xFEFF),
    'right-to-left override': point(0x202E), 'isolate': point(0x2066), 'arabic letter mark': point(0x61C), 'bell': point(7), 'carriage return': point(13),
  };
  for (const [name, text] of Object.entries(hidden)) {
    const shown = visible('a' + text + 'b');
    assert.match(shown, /^a(?:\\u[0-9a-f]{4}|\\u\{[0-9a-f]+\})+b$/, name);
    assert.equal(/[^ -~]/.test(shown), false, name + ' leaves only printable ASCII');
  }
  assert.equal(visible('a' + point(0xE0074) + 'b'), 'a\\u{e0074}b', 'a character beyond the basic plane is written whole');
  const emoji = point(0x1F469, 0x200D, 0x1F4BB) + ' ' + point(0x2764, 0xFE0F) + ' ' + point(0x1F44D, 0x1F3FD);
  assert.equal(visible(emoji + ' 한글 tab\tline\nend'), emoji + ' 한글 tab\tline\nend');
  const plain = '취소', dressed = '취소' + point(0xE0020, 0xE0041);
  assert.notEqual(visible(plain), visible(dressed), 'two options that look alike do not read alike');
});

test('a command shows a space that is not the plain one, since a shell would not split on it', () => {
  const slash = String.fromCharCode(92);
  // No-break space, ideographic space and narrow no-break space all look like a gap between words.
  assert.equal(visibleCommand('rm' + point(0xA0) + '-rf' + point(0x3000) + '/tmp/x' + point(0x202F) + 'y'),
    'rm' + slash + 'u00a0-rf' + slash + 'u3000/tmp/x' + slash + 'u202fy');
  assert.equal(visibleCommand('npm  test\n\tcd  dist'), 'npm  test\n\tcd  dist', 'plain spaces, tabs and newlines stay as they are');
  assert.equal(visible('가' + point(0xA0) + '나'), '가' + point(0xA0) + '나', 'ordinary text keeps it');
});

test('an argument list is shown with its word boundaries and blank runs are counted, not shown', () => {
  assert.equal(shellJoin(['sh', '-c', 'rm -rf /data', 'x']), "sh -c 'rm -rf /data' x");
  assert.equal(shellJoin(['rm', '-rf', 'build dist']), "rm -rf 'build dist'");
  assert.equal(shellJoin(['echo', "it's", '', 'a$b', 'ok/path-1.txt']), "echo 'it'\\''s' '' 'a$b' ok/path-1.txt");
  assert.deepEqual(foldBlankRuns('npm test\n' + '\n'.repeat(40) + 'curl x | sh'), [{ text: 'npm test\n' }, { blank: 40 }, { text: 'curl x | sh' }]);
  assert.deepEqual(foldBlankRuns('a\n\n\nb'), [{ text: 'a\n\n\nb' }], 'a short gap is left alone');
  assert.deepEqual(foldBlankRuns('a\n \t\n\r\n\n\nb'), [{ text: 'a\n' }, { blank: 4 }, { text: 'b' }], 'lines of only spaces count as blank');
  assert.deepEqual(foldBlankRuns(''), [{ text: '' }]);
});

test('a request is laid out as what it will do, and every argument not shown that way is listed by name', () => {
  const blocks = (input, cwd) => requestBlocks(JSON.stringify(input), cwd);
  const names = list => list.map(block => block.kind + (block.name ? ':' + block.name : ''));
  // Writing a file replaces it; an empty one is still a change and is said so by the view.
  assert.deepEqual(blocks({ file_path: '/p/production.ts', content: '' }), [{ kind: 'path', text: '/p/production.ts' }, { kind: 'content', text: '' }]);
  assert.deepEqual(names(blocks({ file_path: '/p/a.ts', content: 'x', mode: 'w' })), ['path', 'content', 'field:mode']);
  // An edit is a change only when both sides are text; otherwise nothing is summarised and everything is listed.
  assert.deepEqual(blocks({ file_path: '/a', old_string: 'x', new_string: 'y', replace_all: true }),
    [{ kind: 'path', text: '/a' }, { kind: 'change', before: 'x', after: 'y' }, { kind: 'field', name: 'replace_all', value: 'true' }]);
  assert.deepEqual(blocks({ path: '/etc/hosts', old_string: { regex: '.*' }, new_string: '0.0.0.0 bank.example' }), [
    { kind: 'field', name: 'path', value: '/etc/hosts' }, { kind: 'field', name: 'old_string', value: '{"regex":".*"}' },
    { kind: 'field', name: 'new_string', value: '0.0.0.0 bank.example' }]);
  assert.deepEqual(names(blocks({ file_path: '/a', edits: [{ old_string: 'a', new_string: 'b', replace_all: 'true' }, { old_string: 'c', new_string: 'd', extra: 1 }] })),
    ['path', 'change', 'field:edits[0].replace_all', 'change', 'field:edits[1].extra']);
  assert.deepEqual(names(blocks({ file_path: '/a', edits: [{ old_string: 'a', new_string: 7 }] })), ['field:file_path', 'field:edits']);
  // A command: the description is a note only when it is text, an argument list keeps its boundaries, the rest is listed.
  assert.deepEqual(blocks({ command: ['sh', '-c', 'rm -rf /data', 'x'], description: { a: 1 } }, '/w'), [
    { kind: 'code', text: "sh -c 'rm -rf /data' x", label: '실행할 명령' }, { kind: 'field', name: 'description', value: '{"a":1}' },
    { kind: 'field', name: '실행 위치', value: '/w' }]);
  assert.deepEqual(names(blocks({ command: 'ls', description: '목록', timeout: 5, run_in_background: false, dangerouslyDisableSandbox: true })),
    ['note', 'code', 'field:timeout', 'field:run_in_background', 'field:dangerouslyDisableSandbox']);
  assert.deepEqual(names(blocks({ command: [], file_path: '/a', content: 'x' })), ['path', 'content', 'field:command']);
  assert.deepEqual(names(blocks({ prompt: 'line one\nline two', subagent_type: 'Explore' })), ['long:prompt', 'field:subagent_type']);
  // Every key of the input is accounted for by exactly one block.
  const input = { file_path: '/a', old_string: 'x', new_string: 'y', replace_all: false, note: null, nested: { deep: [1] } };
  const laid = blocks(input);
  for (const key of ['replace_all', 'note', 'nested']) assert.equal(laid.filter(block => block.name === key).length, 1, key);
  assert.deepEqual(requestBlocks('not json', '/w'), [{ kind: 'code', text: 'not json', label: '요청 내용 전체' }, { kind: 'field', name: '실행 위치', value: '/w' }]);
  assert.deepEqual(requestBlocks('', undefined), []);
});

test('a read-only request is identified by what it asks, and closing one is remembered for that wait', () => {
  const row = (detail, waitSince = 5) => ({ status: 'approval', key: 'codex/a', waitSince, preview: { tool: 'shell', detail } });
  assert.notEqual(requestToken(row('x')), requestToken(row('y')));
  assert.equal(requestToken(row('x')), requestToken(row('x')));
  const answerable = { status: 'approval', key: 'claude/s', waitSince: 9, action: { token: 't' } };
  const expired = { ...answerable, action: undefined, preview: { tool: 'Bash', detail: '{}' } };
  assert.notEqual(requestToken(answerable), requestToken(expired));
  assert.equal(dismissKey(answerable), dismissKey(expired), 'the same wait stays closed when it turns read-only');
  assert.notEqual(dismissKey(answerable), dismissKey({ ...answerable, waitSince: 10 }));
});

test('an edit is shown as the lines that change, in order, including a large one', () => {
  const marks = (a, b) => lineChanges(a.split('\n'), b.split('\n')).map(([kind, text]) => ({ same: ' ', removed: '-', added: '+' })[kind] + text);
  assert.deepEqual(marks('a\nb\nc\nd', 'a\nB\nc\nd\ne'), [' a', '-b', '+B', ' c', ' d', '+e']);
  assert.deepEqual(marks('x', 'x'), [' x']);
  assert.deepEqual(marks('if (a) {\n  throw 1;\n}\nawait s(1);', 'if (a) {\n  log();\n  throw 2;\n}\nawait s(2);'),
    [' if (a) {', '-  throw 1;', '+  log();', '+  throw 2;', ' }', '-await s(1);', '+await s(2);']);
  assert.deepEqual(lineChanges([], ['new']), [['added', 'new']]);
  const before = Array.from({ length: 400 }, (_, i) => 'line ' + i), after = [...before];
  after[200] = 'changed';
  const ops = lineChanges(before, after);
  assert.deepEqual(ops.filter(([kind]) => kind !== 'same'), [['removed', 'line 200'], ['added', 'changed']]);
  assert.equal(ops.filter(([kind]) => kind !== 'removed').map(([, text]) => text).join('\n'), after.join('\n'));
});

test('the limit shown for a subscription is the account-wide one that runs out first', () => {
  const used = (name, period, percent) => ({ name, period, kind: 'used', percent });
  const left = (name, period, percent) => ({ name, period, kind: 'remaining', percent });
  const shown = (id, windows) => quotaLabel(representativeWindow(id, windows));
  assert.equal(shown('claude', [used('', 300, 32), used('', 10080, 61), used('Opus', 10080, 93)]), '주간');
  assert.equal(shown('claude', [used('', 300, 70), used('', 10080, 61)]), '5시간');
  assert.equal(shown('codex', [used('', 10080, 40), used('', 300, 40)]), '5시간', 'a tie goes to the shorter window');
  assert.equal(shown('claude', [used('Opus', 10080, 93)]), 'Opus · 주간', 'a model limit stands in when nothing else exists');
  assert.equal(shown('agy', [left('Claude and GPT models', 300, 7), left('Gemini Models', 300, 82.2)]), 'Gemini Models · 5시간');
  assert.equal(shown('claude', [used('', 'session', 20), used('', 10080, 20)]), '세션', 'a session is a five-hour window');
  assert.equal(representativeWindow('agy', []), undefined);
});

test('a limit named beside another is called by its model, and one that is only a period keeps it', () => {
  assert.equal(limitName({ name: 'Opus', period: 10080 }), 'Opus');
  assert.equal(limitName({ name: 'Sonnet', period: 10080 }), 'Sonnet');
  assert.equal(limitName({ name: 'Claude and GPT models', period: 300 }), 'Claude/GPT');
  assert.equal(limitName({ name: 'Gemini Models', period: 300 }), 'Gemini');
  assert.equal(limitName({ name: '', period: 10080 }), '주간');
  assert.equal(limitName({ name: '', period: 300 }), '5시간');
  assert.equal(shortLimitLabel({ name: 'Gemini Models', period: 300 }), 'Gemini 5시간');
  assert.equal(shortLimitLabel({ name: 'Gemini 3 Pro', period: 300 }), 'Gemini 3 Pro · 5시간');
  assert.equal(quotaLabel({ name: 'OAuth apps', period: 10080 }), 'OAuth 앱 · 주간');
  assert.equal(quotaLabel({ name: '', period: 'Opus 주간' }), 'Opus 주간', 'a cached label from before keeps its words');
  assert.equal(quotaLabel({ name: 'Spark', period: 60 }), 'Spark · 1시간');
  assert.equal(quotaLabel({ name: '', period: 2880 }), '2일');
});

test('the request opened first is a question before an approval, then the longest wait; rows with nothing to show are skipped', () => {
  const row = (key, status, waitSince, extra) => ({ key, status, waitSince, updatedAt: waitSince, ...extra });
  const action = token => ({ action: { token } });
  const rows = [
    row('codex/a', 'approval', 100, { preview: { tool: 'shell', detail: '{}' } }),
    row('claude/b', 'approval', 50, action('t-b')),
    row('agy/c', 'input', 10),
    row('claude/d', 'input', 300, action('t-d')),
    row('claude/e', 'input', 200, action('t-e')),
    row('claude/f', 'done', 1, { ...action('t-f'), preview: { tool: 'x' } }),
  ];
  const tokens = requestOrder(rows).map(requestToken);
  assert.deepEqual(tokens.slice(0, 3), ['t-e', 't-d', 't-b']);
  assert.match(tokens[3], /^preview:codex\/a:100:[0-9a-z]+$/);
  assert.equal(requestToken(rows[2]), undefined);
  assert.equal(requestToken(rows[5]), undefined, 'a finished row has no request even if stale fields remain');

  // An actionable inline approval (with countdown) must open before an older read-only preview question,
  // and among timed inline requests the soonest deadline opens first.
  const mixed = [
    row('agy/q-old', 'input', 10, { preview: { tool: 'ask_question', detail: '{"questions":[{"question":"선택?","options":["A","B"]}]}' } }),
    row('claude/q-later', 'input', 100, { action: { token: 't-later', expiresAt: 50000 } }),
    row('claude/a-urgent', 'approval', 200, { action: { token: 't-urgent', expiresAt: 10000 } }),
  ];
  assert.deepEqual(requestOrder(mixed).map(r => r.key), ['claude/a-urgent', 'claude/q-later', 'agy/q-old']);
});

test('a step reads as what it does and to what; an unknown tool keeps its own name', () => {
  assert.deepEqual(toolKind('Bash'), { kind: 'command', label: '명령 실행' });
  assert.deepEqual(toolKind('apply_patch'), { kind: 'patch', label: '파일 수정' });
  assert.deepEqual(toolKind('mcp__github__create_issue'), { kind: 'other', label: 'github · create_issue' });
  assert.deepEqual(toolKind('frobnicate'), { kind: 'other', label: 'frobnicate' });
  for (const odd of [undefined, null, 7, {}]) assert.deepEqual(toolKind(odd), { kind: 'other', label: '' });
  assert.equal(stepText({ tool: 'Edit', target: ' src/a.ts\n' }), '파일 수정 · src/a.ts');
  assert.equal(stepText({ tool: 'Read' }), '파일 읽기');
  assert.equal(stepText({ tool: '', target: 'x' }), 'x');
  assert.equal(stepText(undefined), '');
});

test('the telling argument of a call is its command, file, pattern or query, on one line', () => {
  assert.equal(inputTarget({ command: 'pnpm test\n&& echo done', description: 'run' }), 'pnpm test');
  assert.equal(inputTarget({ command: ['bash', '-lc', 'npm test'] }), "bash -lc 'npm test'", 'an argument list keeps its word boundaries');
  assert.equal(inputTarget({ command: [], query: 'q' }), 'q');
  assert.equal(inputTarget({ file_path: '/Users/dev/work/shop/src/checkout/retry.ts', old_string: 'a' }), 'checkout/retry.ts');
  assert.equal(inputTarget({ path: 'C:\\repo\\src\\a.ts' }), 'src/a.ts');
  assert.equal(inputTarget({ pattern: 'retry(' }), 'retry(');
  assert.equal(inputTarget({ command: ['bash', 7] , query: 'q' }), 'q', 'a malformed command falls through to the next field');
  for (const empty of [undefined, {}, { command: '   ' }, { n: 1 }]) assert.equal(inputTarget(empty), '');
  assert.deepEqual(parseInput('{"a":1}'), { a: 1 });
  for (const invalid of ['[1]', '"x"', 'null', '{', '']) assert.equal(parseInput(invalid), undefined);
});

test('the second line of a row says what is asked, what is being done, or what was answered', () => {
  const approval = { status: 'approval', action: { kind: 'approval', tool: 'Bash', detail: JSON.stringify({ command: 'pnpm test --filter x' }) },
    activity: { tool: 'Read', target: 'a.ts' }, prompt: '테스트 돌려 줘' };
  assert.equal(requestSummary(approval), '명령 실행 · pnpm test --filter x');
  assert.equal(subtitleFor(approval), '명령 실행 · pnpm test --filter x');
  const question = { status: 'input', action: { kind: 'question', questions: [{ question: '탭 순서를\n어떻게 둘까요?' }, { question: '둘째' }] } };
  assert.equal(subtitleFor(question), '탭 순서를 어떻게 둘까요?');
  const preview = { status: 'approval', preview: { tool: 'shell', detail: 'not json' } };
  assert.equal(subtitleFor(preview), '명령 실행', 'an unreadable request still names its tool');
  assert.equal(subtitleFor({ status: 'input', activity: { tool: 'Grep', target: 'x' } }), '검색 · x', 'a request without content falls back to the last step');
  assert.equal(subtitleFor({ status: 'working', activity: { tool: 'Edit', target: 'a.ts' }, prompt: 'p' }), '파일 수정 · a.ts');
  assert.equal(subtitleFor({ status: 'working', prompt: ' 결제  재시도\n고쳐 줘 ' }), '결제 재시도 고쳐 줘');
  assert.equal(subtitleFor({ status: 'working' }), '');
  assert.equal(subtitleFor({ status: 'done', reply: '끝났습니다', activity: { tool: 'Bash', target: 'x' } }), '끝났습니다');
  assert.equal(subtitleFor({ status: 'error', reply: '실패' }), '실패');
  for (const status of ['recent', 'idle', 'stale']) assert.equal(subtitleFor({ status, reply: 'x', prompt: 'y' }), '');
  assert.equal(requestSummary({ status: 'working' }), '');
});

test('view sources carry no raw direction or invisible characters', () => {
  const hidden = /[\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u;
  for (const folder of ['media', 'src']) {
    const directory = path.join(__dirname, '..', folder);
    for (const name of fs.readdirSync(directory)) {
      if (!/\.(?:c?js|css)$/.test(name)) continue;
      assert.equal(hidden.test(fs.readFileSync(path.join(directory, name), 'utf8')), false, folder + '/' + name);
    }
  }
});

test('diff stats, reset countdown, work phase, plan subtitle, openable file target and instant search matching', () => {
  const now = Date.UTC(2026, 10, 24, 12, 0);
  assert.deepEqual(diffStats('a\nb\nc', 'a\nB\nc\nd'), { added: 2, removed: 1 });
  assert.deepEqual(diffStats('same', 'same'), { added: 0, removed: 0 });
  assert.equal(resetInText(now + 135 * 60000, now), '2시간 15분 후');
  assert.equal(resetInText(now + 42 * 60000, now), '42분 후');
  assert.equal(resetInText(now + 26 * 3600000, now), '1일 2시간 후');
  assert.equal(resetInText(now - 1000, now), '');

  const planned = {
    status: 'working', provider: 'claude', title: '결제 오류 수정',
    activity: { tool: 'TodoWrite', target: '' },
    plan: [{ text: '원인 재현', status: 'completed' }, { text: '재시도 백오프 구현 중', status: 'in_progress' }],
    changedFiles: ['src/checkout/retry.ts'],
    execution: { model: 'claude-sonnet-4-6', effort: 'high' },
  };
  assert.equal(activePlanStep(planned), '재시도 백오프 구현 중');
  assert.equal(subtitleFor(planned), '계획 · 재시도 백오프 구현 중');
  assert.deepEqual(workPhase(planned), { kind: 'plan', label: '작업 계획 정리 중' });
  assert.deepEqual(workPhase({ status: 'working', activity: { tool: 'Edit', target: 'a.ts' } }), { kind: 'edit', label: '코드 수정 중' });
  assert.deepEqual(workPhase({ status: 'working', activity: { tool: 'Bash', target: 'npm test', failed: true } }), { kind: 'error', label: '직전 단계 실패 · 복구 중' });
  assert.deepEqual(workPhase({ status: 'done', replyUnread: true }), { kind: 'done', label: '새 응답 도착' });

  assert.equal(fileTargetOf({ tool: 'Edit', target: 'src/retry.ts' }), 'src/retry.ts');
  assert.equal(fileTargetOf({ tool: 'Bash', target: 'pnpm test' }), '');
  assert.equal(fileTargetOf({ tool: 'Read', target: '…/very/long/path.ts' }), '');

  assert.equal(matchesFilter(planned, '결제 retry.ts'), true);
  assert.equal(matchesFilter(planned, 'sonnet high'), true);
  assert.equal(matchesFilter(planned, '백오프'), true);
  assert.equal(matchesFilter(planned, '존재하지않는단어'), false);

  assert.equal(errorLabel('rate_limit'), '한도 도달');
  assert.equal(errorLabel('authentication_failed'), '인증 필요');
  assert.equal(errorLabel('unknown'), '오류');
  assert.deepEqual(workPhase({ status: 'error', errorReason: 'rate_limit' }), { kind: 'error', label: '사용 한도 도달' });
  assert.deepEqual(workPhase({ status: 'error', errorReason: 'rate_limit', errorAcked: true }), { kind: 'idle', label: '사용 한도 도달 (확인됨)' });
  assert.deepEqual(workPhase({ status: 'working', quiet: true, isSubagent: true }), { kind: 'quiet', label: '신호 없음 · 종료 추정' });
  assert.equal(matchesFilter({ status: 'error', provider: 'claude', title: '작업', errorReason: 'rate_limit' }, '한도'), true);
  const depleted = depletedQuotaHint({
    status: 'ready',
    windows: [
      { name: '', period: 10080, kind: 'used', percent: 70, resetsAt: now + 86400000 },
      { name: '', period: 300, kind: 'used', percent: 100, resetsAt: now + 90 * 60000 },
    ],
  }, now);
  assert.deepEqual(depleted, { label: '5시간', resetsAt: now + 90 * 60000, resetIn: '1시간 30분 후' });
  assert.equal(depletedQuotaHint({ status: 'ready', windows: [{ name: '', period: 300, kind: 'used', percent: 50 }] }, now), undefined);

  // Antigravity update_steps / update_focus, Claude TaskCreate / Skill, Codex apply_patch & tool kinds.
  assert.deepEqual(toolKind('update_steps'), { kind: 'plan', label: '계획 정리' });
  assert.deepEqual(toolKind('update_focus'), { kind: 'focus', label: '진행' });
  assert.deepEqual(toolKind('Skill'), { kind: 'skill', label: '스킬 실행' });
  assert.deepEqual(toolKind('invoke_subagent'), { kind: 'agent', label: '하위 작업' });
  assert.deepEqual(toolKind('write_stdin'), { kind: 'command', label: '명령 실행' });
  assert.deepEqual(toolKind('request_permissions'), { kind: 'permission', label: '권한 요청' });
  assert.equal(subtitleFor({ status: 'working', activity: { tool: 'update_focus', target: 'Investigating blank tabs' } }), 'Investigating blank tabs');
  assert.equal(subtitleFor({ status: 'working', focus: 'Running audits' }), 'Running audits');
  assert.equal(matchesFilter({ status: 'working', provider: 'agy', title: 'AGY', focus: 'Investigating blank tabs' }, 'blank'), true);
  const patchPayload = '*** Begin Patch\n*** Update File: src/hook.cjs\n@@\n-old\n+new\n*** End Patch';
  assert.equal(inputTarget({ command: patchPayload }), 'src/hook.cjs');
  assert.deepEqual(requestBlocks(JSON.stringify({ command: patchPayload })), [
    { kind: 'path', text: 'src/hook.cjs', file: 'src/hook.cjs', stats: { added: 1, removed: 1 } },
    { kind: 'patch', lines: [['hunk', '@@'], ['removed', 'old'], ['added', 'new']], raw: '*** Update File: src/hook.cjs\n@@\n-old\n+new' },
  ]);
});

test('truncated request metadata emits a dedicated top block instead of a raw field and formats byte sizes', () => {
  assert.equal(byteSizeText(0), '0B');
  assert.equal(byteSizeText(512), '512B');
  assert.equal(byteSizeText(1536), '1.5KB');
  assert.equal(byteSizeText(10240), '10KB');
  assert.equal(byteSizeText(24576), '24KB');
  assert.equal(byteSizeText(1572864), '1.5MB');

  const truncatedPayload = JSON.stringify({
    _truncated: { totalBytes: 24576, shownBytes: 10240 },
    command: 'pnpm test --filter checkout',
    description: '큰 출력 테스트',
  });
  const blocks = requestBlocks(truncatedPayload, '/work/app');
  assert.deepEqual(blocks[0], { kind: 'truncated', totalBytes: 24576, shownBytes: 10240 });
  assert.equal(blocks.some(b => b.kind === 'field' && b.name === '_truncated'), false);
  assert.deepEqual(blocks.slice(1), [
    { kind: 'note', text: '큰 출력 테스트' },
    { kind: 'code', text: 'pnpm test --filter checkout', label: '실행할 명령' },
    { kind: 'field', name: '실행 위치', value: '/work/app' },
  ]);

  // Malformed _truncated is not silently dropped.
  const odd = requestBlocks(JSON.stringify({ _truncated: 'yes', command: 'ls' }));
  assert.equal(odd.some(b => b.kind === 'truncated'), false);
  assert.equal(odd.some(b => b.kind === 'field' && b.name === '_truncated' && b.value === 'yes'), true);
});

test('provider parity: Bedrock/Vertex/alias Claude, Codex/OpenAI, and Gemini model names format cleanly', () => {
  const cases = {
    'us.anthropic.claude-sonnet-4-5-20250929-v1:0': 'Sonnet 4.5',
    'global.anthropic.claude-opus-4-6-v1:0[1m]': 'Opus 4.6 (1M)',
    'eu.anthropic.claude-3-5-sonnet-20241022-v2:0': 'Sonnet 3.5',
    'anthropic.claude-3-opus-20240229-v1:0': 'Opus 3',
    'anthropic/claude-sonnet-4-6': 'Sonnet 4.6',
    'claude-sonnet-4-5@20250929': 'Sonnet 4.5',
    'claude-opus-4-6-v1': 'Opus 4.6',
    opus: 'Opus',
    'sonnet[1m]': 'Sonnet (1M)',
    haiku: 'Haiku',
    fable: 'Fable',
    'fable[1m]': 'Fable (1M)',
    mythos: 'Mythos',
    opusplan: 'Opus Plan',
    'claude-opus-5-5-latest': 'Opus 5.5',
    'claude-sonnet-4-6-thinking': 'Sonnet 4.6',
    'claude-opus-4-6-fast': 'Opus 4.6',
    'gpt-6.2-astra': 'GPT-6.2 Astra',
    'gpt-6.3-nova': 'GPT-6.3 Nova',
    'gpt-5.3-codex-spark': 'GPT-5.3 Codex Spark',
    'gpt-5.3-codex': 'GPT-5.3 Codex',
    'gpt-5.1-codex-mini': 'GPT-5.1 Codex mini',
    'gpt-5.4-pro': 'GPT-5.4 Pro',
    'gpt-5.3-codex-2026-02-01': 'GPT-5.3 Codex',
    'gpt-4-turbo-2024-04-09': 'GPT-4 Turbo',
    'gpt-5.4': 'GPT-5.4',
    'gpt-5.4-mini': 'GPT-5.4 mini',
    'o4-mini': 'o4-mini',
    'o4-mini-2025-04-16': 'o4-mini',
    'gemini-3.6-flash': 'Gemini 3.6 Flash',
    'gemini-4-pro': 'Gemini 4 Pro',
    'gemini-3.6-flash-thinking': 'Gemini 3.6 Flash Thinking',
  };
  for (const [id, expected] of Object.entries(cases)) assert.equal(modelName(id, {}, 'claude'), expected, id);
  assert.equal(modelName('gemini-3.6-flash-MEDIUM', { modelSource: 'call', effortSource: 'call', effort: 'medium' }, 'agy'), 'Gemini 3.6 Flash');
  assert.equal(modelName('gemini-3.6-flash-high', { modelSource: 'call', effortSource: 'setting', effort: 'high' }, 'agy'), 'gemini-3.6-flash-high');
});

test('provider parity: unified read-only questions, apply_patch diffs, ExitPlanMode, NotebookEdit, permissions and AGY PascalCase edits', () => {
  // Unified question preview across Antigravity, Codex, and Claude.
  const agyQ = { questions: [{ question: '배포 대상을 고르세요', options: ['스테이징', '프로덕션'], is_multi_select: true }] };
  assert.deepEqual(previewQuestions(agyQ), [{
    question: '배포 대상을 고르세요', header: '', multiSelect: true, isOther: false,
    choices: [{ label: '스테이징', description: '' }, { label: '프로덕션', description: '' }],
  }]);
  assert.equal(requestSummary({ preview: { tool: 'ask_question', detail: JSON.stringify(agyQ) } }), '배포 대상을 고르세요');

  const codexQ = { questions: [
    { id: 'q1', header: '인증', question: '어떤 인증 방식을 쓸까요?', options: [{ label: 'OAuth', description: '권장' }], isOther: true },
    { id: 'q2', header: '호스트', question: 'API 주소를 입력하세요' },
  ] };
  const codexParsed = previewQuestions(codexQ);
  assert.equal(codexParsed.length, 2);
  assert.equal(codexParsed[0].header, '인증');
  assert.equal(codexParsed[0].isOther, true);
  assert.deepEqual(codexParsed[1].choices, []);
  assert.equal(requestSummary({ preview: { tool: 'request_user_input', detail: JSON.stringify(codexQ) } }), '어떤 인증 방식을 쓸까요?');
  assert.equal(requestBlocks(JSON.stringify(codexQ))[0].kind, 'questions');
  assert.equal(previewQuestions({ questions: [{ question: '' }] }), undefined);

  // Multi-file apply_patch with Move to, Add, Delete, hunk headers and fallback on unparseable input.
  const multiPatch = [
    '*** Begin Patch',
    '*** Update File: src/old/retry.ts',
    '*** Move to: src/checkout/retry.ts',
    '@@ export function retry()',
    ' const max = 3;',
    '-return 1;',
    '+return max;',
    '*** Add File: src/checkout/backoff.ts',
    '+export const backoff = 200;',
    '*** Delete File: src/old/legacy.ts',
    '*** End Patch',
  ].join('\n');
  assert.equal(inputTarget({ command: multiPatch }), 'old/retry.ts 외 2개');
  const sections = parseApplyPatch(multiPatch);
  assert.equal(sections.length, 3);
  assert.equal(sections[0].moveTo, 'src/checkout/retry.ts');
  assert.deepEqual(sections[0].stats, { added: 1, removed: 1 });
  assert.equal(sections[1].op, 'add');
  assert.equal(sections[2].op, 'delete');
  const patchBlocks = requestBlocks(JSON.stringify({ command: multiPatch }));
  assert.deepEqual(patchBlocks[0], { kind: 'path', text: 'src/old/retry.ts → src/checkout/retry.ts', file: 'src/checkout/retry.ts', stats: { added: 1, removed: 1 } });
  assert.equal(patchBlocks[1].kind, 'patch');
  const brokenPatch = '*** Begin Patch\nnot a valid file header\n*** End Patch';
  assert.deepEqual(requestBlocks(JSON.stringify({ command: brokenPatch })), [{ kind: 'code', text: brokenPatch, label: '패치 내용' }]);

  // Claude ExitPlanMode & NotebookEdit.
  const exitPlan = {
    plan: '\n# 결제 백오프 개선 계획\n1. 재시도 제한 추가',
    planFilePath: '/work/.claude/plans/retry.md',
    allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }],
  };
  assert.equal(inputTarget(exitPlan), '결제 백오프 개선 계획');
  assert.deepEqual(requestBlocks(JSON.stringify(exitPlan)), [
    { kind: 'path', text: '/work/.claude/plans/retry.md' },
    { kind: 'code', text: exitPlan.plan, label: '실행 계획' },
    { kind: 'field', name: '허용 요청', value: 'Bash · run tests' },
  ]);
  assert.equal(inputTarget({ planFilePath: '/work/.claude/plans/retry.md' }), 'plans/retry.md');
  assert.equal(inputTarget({ Message: '디자인 확인 부탁드립니다' }), '디자인 확인 부탁드립니다');
  assert.equal(inputTarget({ chars: 'yes\n' }), 'yes');
  const nb = requestBlocks(JSON.stringify({ notebook_path: '/work/a.ipynb', new_source: 'x = 1', cell_type: 'code' }));
  assert.deepEqual(nb, [
    { kind: 'path', text: '/work/a.ipynb' },
    { kind: 'code', text: 'x = 1', label: '새 셀 내용' },
    { kind: 'field', name: 'cell_type', value: 'code' },
  ]);

  // Codex command justification + duplicate workdir deduplication + request_permissions flattening.
  const codexCmd = requestBlocks(JSON.stringify({ cmd: 'pytest', justification: '회귀 테스트 확인', workdir: '/repo' }), '/repo');
  assert.deepEqual(codexCmd, [
    { kind: 'note', text: '회귀 테스트 확인' },
    { kind: 'code', text: 'pytest', label: '실행할 명령' },
    { kind: 'field', name: 'workdir', value: '/repo' },
  ]);
  const codexCmdDiffCwd = requestBlocks(JSON.stringify({ cmd: 'pytest', workdir: '/repo/sub' }), '/repo');
  assert.equal(codexCmdDiffCwd.some(b => b.name === '실행 위치' && b.value === '/repo'), true);

  const perms = requestBlocks(JSON.stringify({
    reason: '패키지 설치를 위해 쓰기 및 네트워크 권한 필요',
    permissions: { file_system: { write: ['/repo/dist'] }, network: { enabled: true } },
  }));
  assert.deepEqual(perms, [
    { kind: 'note', text: '패키지 설치를 위해 쓰기 및 네트워크 권한 필요' },
    { kind: 'field', name: '파일 시스템 · 쓰기', value: '/repo/dist' },
    { kind: 'field', name: '네트워크 · 허용', value: '예' },
  ]);

  // Antigravity PascalCase edits/writes & Description/toolSummary notes.
  assert.deepEqual(requestBlocks(JSON.stringify({ Path: '/repo/a.js', Target: 'a', Replacement: 'b', Description: '변수명 정리' })), [
    { kind: 'note', text: '변수명 정리' },
    { kind: 'path', text: '/repo/a.js' },
    { kind: 'change', before: 'a', after: 'b' },
  ]);
  assert.deepEqual(requestBlocks(JSON.stringify({ TargetFile: '/repo/b.js', TargetContent: 'old', ReplacementContent: 'new' })), [
    { kind: 'path', text: '/repo/b.js' },
    { kind: 'change', before: 'old', after: 'new' },
  ]);
  assert.deepEqual(requestBlocks(JSON.stringify({ TargetFile: '/repo/c.js', CodeContent: 'export default 1;', toolSummary: '새 모듈 작성' })), [
    { kind: 'note', text: '새 모듈 작성' },
    { kind: 'path', text: '/repo/c.js' },
    { kind: 'content', text: 'export default 1;' },
  ]);
});

test('provider parity: tool kinds, #N plan subtitle, quota helpers and interrupted workPhase', () => {
  assert.deepEqual(toolKind('ask_permission'), { kind: 'permission', label: '권한 요청' });
  assert.deepEqual(toolKind('SendMessage'), { kind: 'agent', label: '하위 작업' });
  assert.deepEqual(toolKind('TeamCreate'), { kind: 'agent', label: '하위 작업' });
  assert.deepEqual(toolKind('TeamDelete'), { kind: 'agent', label: '하위 작업' });
  assert.deepEqual(toolKind('LSP'), { kind: 'search', label: '검색' });
  assert.deepEqual(toolKind('ListMcpResourcesTool'), { kind: 'search', label: '검색' });
  assert.deepEqual(toolKind('ReadMcpResourceTool'), { kind: 'read', label: '파일 읽기' });
  assert.deepEqual(toolKind('CronCreate'), { kind: 'plan', label: '계획 정리' });
  assert.deepEqual(toolKind('schedule'), { kind: 'plan', label: '계획 정리' });
  assert.deepEqual(toolKind('command_status'), { kind: 'command', label: '명령 실행' });
  assert.deepEqual(toolKind('send_command_input'), { kind: 'command', label: '명령 실행' });
  assert.deepEqual(toolKind('read_terminal'), { kind: 'command', label: '명령 실행' });
  assert.deepEqual(toolKind('manage_task'), { kind: 'command', label: '명령 실행' });

  // #N plan target falls back to active plan step.
  assert.equal(subtitleFor({
    status: 'working',
    activity: { tool: 'TaskUpdate', target: '#3' },
    plan: [{ text: '백오프 검증', status: 'in_progress' }],
  }), '계획 · 백오프 검증');

  // AGY quota helpers: representativeWindow, depletedQuotaHint 5h vs weekly tie-break, limitName.
  const now = Date.UTC(2026, 10, 25, 12, 0);
  assert.equal(quotaLabel(representativeWindow('agy', [
    { name: 'Claude and GPT models', period: 300, kind: 'remaining', percent: 5 },
    { name: 'Gemini 3 Pro', period: 300, kind: 'remaining', percent: 72 },
  ])), 'Gemini 3 Pro · 5시간');
  assert.equal(depletedQuotaHint({
    status: 'ready',
    windows: [
      { name: 'Gemini Models', period: 'weekly', kind: 'remaining', percent: 0, resetsAt: now + 86400000 },
      { name: 'Gemini Models', period: 300, kind: 'remaining', percent: 0, resetsAt: now + 3600000 },
    ],
  }, now).label, 'Gemini Models · 5시간');
  assert.equal(limitName({ name: 'Spark', period: 'primary' }), 'Spark');
  assert.equal(limitName({ name: 'Codex', period: 'secondary' }), 'Codex');
  assert.equal(limitName({ name: '', period: 'primary' }), '기본 구간');

  // Interrupted idle phase.
  assert.deepEqual(workPhase({ status: 'idle', interrupted: true }), { kind: 'idle', label: '중단됨' });
  assert.deepEqual(workPhase({ status: 'idle' }), { kind: 'idle', label: '이전 대화' });

  // Antigravity run_command, read_file, read_url_content and Codex array cmd formatting.
  const agyCmd = requestBlocks(JSON.stringify({
    CommandLine: 'cd app && vercel deploy --yes',
    BypassSandbox: true,
    WaitMsBeforeAsync: 10000,
    toolSummary: 'Deploy Vercel Preview',
  }), '/repo');
  assert.deepEqual(agyCmd, [
    { kind: 'note', text: 'Deploy Vercel Preview' },
    { kind: 'code', text: 'cd app && vercel deploy --yes', label: '실행할 명령' },
    { kind: 'field', name: 'BypassSandbox', value: 'true' },
    { kind: 'field', name: 'WaitMsBeforeAsync', value: '10000' },
    { kind: 'field', name: '실행 위치', value: '/repo' },
  ]);
  assert.deepEqual(requestBlocks(JSON.stringify({ Path: '/etc/hosts', StartLine: 1 })), [
    { kind: 'path', text: '/etc/hosts' },
    { kind: 'field', name: 'StartLine', value: '1' },
  ]);
  assert.equal(requestSummary({ preview: { tool: 'read_url_content', detail: JSON.stringify({ Url: 'https://example.com/docs' }) } }),
    '웹 조회 · https://example.com/docs');
  assert.equal(inputTarget({ cmd: ['git', 'push', 'origin main'] }), "git push 'origin main'");
  assert.deepEqual(requestBlocks(JSON.stringify({ cmd: ['git', 'push', 'origin main'], justification: '배포 푸시' })), [
    { kind: 'note', text: '배포 푸시' },
    { kind: 'code', text: "git push 'origin main'", label: '실행할 명령' },
  ]);
});

test('search matches filenames, relative paths, and rename before/after paths shown inside active approval or preview cards', () => {
  const renamePatch = [
    '*** Begin Patch',
    '*** Add File: qa-marker.txt',
    '+ok',
    '*** Update File: src/legacy/old-name.ts',
    '*** Move to: src/core/new-name.ts',
    '@@',
    '-old',
    '+new',
    '*** End Patch',
  ].join('\n');
  const codexPreviewRow = {
    provider: 'codex', status: 'approval', title: '패치 테스트',
    preview: { tool: 'apply_patch', detail: JSON.stringify({ command: renamePatch }) },
  };
  assert.equal(matchesFilter(codexPreviewRow, 'qa-marker.txt'), true, 'filename in preview patch');
  assert.equal(matchesFilter(codexPreviewRow, 'src/legacy/old-name.ts'), true, 'relative before-rename path');
  assert.equal(matchesFilter(codexPreviewRow, 'old-name.ts'), true, 'basename before rename');
  assert.equal(matchesFilter(codexPreviewRow, 'src/core/new-name.ts'), true, 'relative after-rename path');
  assert.equal(matchesFilter(codexPreviewRow, 'new-name.ts'), true, 'basename after rename');
  // Once preview clears and file was not recorded in changedFiles, search no longer matches it.
  assert.equal(matchesFilter({ ...codexPreviewRow, status: 'working', preview: undefined }, 'qa-marker.txt'), false);

  // Inline Claude approval card and Codex request_permissions paths are also searchable.
  const claudeActionRow = {
    provider: 'claude', status: 'approval', title: '파일 작성',
    action: { kind: 'approval', token: 't1', tool: 'Write', detail: JSON.stringify({ file_path: '/repo/docs/guide-note.md', content: 'x' }) },
  };
  assert.equal(matchesFilter(claudeActionRow, 'guide-note.md'), true);
  assert.equal(matchesFilter(claudeActionRow, 'docs/guide-note.md'), true);

  const permRow = {
    provider: 'codex', status: 'approval', title: '권한 요청',
    preview: { tool: 'request_permissions', detail: JSON.stringify({ permissions: { file_system: { write: ['/repo/build/output.bin'] } } }) },
  };
  assert.equal(matchesFilter(permRow, 'output.bin'), true);
});
