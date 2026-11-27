'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const i18n = require('../media/i18n.js');
const format = require('../media/format.js');

const ROOT = path.resolve(__dirname, '..');
const KO = i18n.TABLES.ko;
const HANGUL = /[가-힣]/;
const sources = () => [
  ...fs.readdirSync(path.join(ROOT, 'src')).filter(name => name.endsWith('.cjs')).map(name => 'src/' + name),
  ...fs.readdirSync(path.join(ROOT, 'media')).filter(name => name.endsWith('.js') && name !== 'i18n.js').map(name => 'media/' + name),
];
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const LITERAL = String.raw`('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")`;
const decode = literal => literal[0] === '"' ? JSON.parse(literal)
  : JSON.parse('"' + literal.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"') + '"');
const placeholders = text => [...new Set(text.match(/\{\d+\}/g) || [])].sort();

// Every English text the extension shows, as written in its source.
function shownText() {
  const keys = new Map();
  const single = new RegExp(String.raw`\b(?:t|phrase)\(\s*` + LITERAL, 'g');
  const counted = new RegExp(String.raw`\btp\([^,()]+,\s*` + LITERAL + String.raw`\s*,\s*` + LITERAL, 'g');
  for (const rel of sources()) {
    const text = read(rel);
    for (const [, literal] of text.matchAll(single)) keys.set(decode(literal), rel);
    // Korean has one form for a count; it is looked up by the English plural.
    for (const [, , other] of text.matchAll(counted)) keys.set(decode(other), rel);
  }
  return keys;
}

test('the display language follows VS Code: Korean for any Korean locale, English for everything else', () => {
  for (const value of ['ko', 'KO', 'ko-KR', 'ko_kr']) assert.equal(i18n.setLocale(value), 'ko', value);
  for (const value of ['en', 'en-US', 'ja', 'zh-cn', 'kok', '', undefined, null]) assert.equal(i18n.setLocale(value), 'en', String(value));
  assert.equal(i18n.intlLocale(), 'en-US');
  i18n.setLocale('ko');
  assert.equal(i18n.intlLocale(), 'ko-KR');
  i18n.setLocale('en');
});

test('text fills its places once, and a count picks the English singular only for one', () => {
  i18n.setLocale('en');
  assert.equal(i18n.t('Resets {0} ({1})', 'in 2h', '{1}'), 'Resets in 2h ({1})');
  assert.equal(i18n.t('A sentence nobody translated.'), 'A sentence nobody translated.');
  assert.equal(i18n.tp(1, '{0} file', '{0} files'), '1 file');
  assert.equal(i18n.tp(0, '{0} file', '{0} files'), '0 files');
  assert.equal(i18n.tp(3, '{1}: {0} session', '{1}: {0} sessions', 'Codex'), 'Codex: 3 sessions');
  i18n.setLocale('ko');
  assert.equal(i18n.t('Resets {0} ({1})', '2시간 후', '14:00'), '2시간 후 (14:00) 초기화');
  assert.equal(i18n.tp(1, '{0} file', '{0} files'), '1개');
  assert.equal(i18n.tp(3, '{1}: {0} session', '{1}: {0} sessions', 'Codex'), 'Codex 세션 3개');
  i18n.setLocale('en');
});

test('every text the extension shows has a Korean translation with the same places, and none is left unused', () => {
  const shown = shownText();
  assert.ok(shown.size > 300, 'the scan finds the shown text');
  const missing = [...shown].filter(([key]) => !Object.hasOwn(KO, key)).map(([key, rel]) => rel + ': ' + key);
  assert.deepEqual(missing, []);
  const unused = Object.keys(KO).filter(key => !shown.has(key));
  assert.deepEqual(unused, []);
  for (const [key, value] of Object.entries(KO)) {
    assert.deepEqual(placeholders(value), placeholders(key), key);
    assert.equal(HANGUL.test(key), false, 'a key is English: ' + key);
    assert.ok(value.trim(), 'a translation is not empty: ' + key);
  }
});

test('no Korean is written into the code outside the dictionary, except patterns that read what agents write', () => {
  const allowed = [
    /사용량\|한도|한도\|사용량/, // hook.cjs and panel-views.js: an agent's reply that mentions a limit
    /로그인\.\*필요/, // quota-cache.cjs: a sign-in message from a record written before English messages
    /서브에이전트\|Subagent/, // extension.cjs: a default subagent title from either language
  ];
  const found = [];
  for (const rel of [...sources(), 'media/panel.css']) {
    read(rel).split('\n').forEach((line, at) => {
      if (HANGUL.test(line) && !allowed.some(pattern => pattern.test(line))) found.push(rel + ':' + (at + 1) + ' ' + line.trim());
    });
  }
  assert.deepEqual(found, []);
});

test('the manifest is English with a Korean translation of every entry', () => {
  const manifest = read('package.json');
  const en = JSON.parse(read('package.nls.json'));
  const ko = JSON.parse(read('package.nls.ko.json'));
  assert.equal(HANGUL.test(manifest), false);
  assert.deepEqual(Object.keys(ko).sort(), Object.keys(en).sort());
  const used = [...manifest.matchAll(/"%([^%"]+)%"/g)].map(match => match[1]);
  assert.ok(used.length >= 30);
  for (const key of used) {
    assert.ok(Object.hasOwn(en, key), 'package.nls.json has ' + key);
    assert.equal(HANGUL.test(en[key]), false, key);
    assert.ok(HANGUL.test(ko[key]) || /^[\x20-\x7e]+$/.test(ko[key]), key);
  }
  assert.deepEqual(Object.keys(en).filter(key => !used.includes(key)), []);
});

test('English reads naturally for times, statuses, requests, tools and limits', () => {
  i18n.setLocale('en');
  const now = Date.UTC(2026, 10, 25, 12, 0);
  assert.equal(format.sinceText('ago', now - 5 * 60000, now), '5m ago');
  assert.equal(format.sinceText('for', now - 3 * 3600000, now), '3h');
  assert.equal(format.remainingText(now + 65000, now), '1m 5s left');
  assert.equal(format.resetInText(now + 135 * 60000, now), 'in 2h 15m');
  assert.equal(format.resetInText(now + 30000, now), 'soon');
  assert.deepEqual(format.workPhase({ status: 'error', errorReason: 'rate_limit', errorAcked: true }), { kind: 'idle', label: 'Usage limit reached (acknowledged)' });
  assert.deepEqual(format.workPhase({ status: 'error', errorReason: 'billing_error' }), { kind: 'error', label: 'Stopped: check billing' });
  assert.deepEqual(format.workPhase({ status: 'working', activity: { tool: 'apply_patch' } }), { kind: 'edit', label: 'Editing code' });
  assert.equal(format.errorLabel('server_error'), 'Server error');
  assert.equal(format.stepText({ tool: 'Bash', target: 'npm test' }), 'Run command · npm test');
  assert.deepEqual(format.requestBlocks('{"command":"npm test"}', '/work'), [
    { kind: 'code', text: 'npm test', label: 'Command to run' },
    { kind: 'field', name: 'Working directory', value: '/work' },
  ]);
  assert.equal(format.inputTarget({ patch: '*** Begin Patch\n*** Add File: a/b.js\n*** Add File: c/d.js\n*** End Patch' }), 'a/b.js and 1 more');
  assert.equal(format.quotaLabel({ name: 'Opus', period: 10080 }), 'Opus · Weekly');
  assert.equal(format.quotaLabel({ name: '', period: 300 }), '5h');
  assert.equal(format.quotaLabel({ name: 'OAuth apps', period: 'weekly' }), 'OAuth apps · Weekly');
  assert.equal(format.shortLimitLabel({ name: 'Gemini Models', period: 300 }), 'Gemini 5h');
  assert.equal(format.subtitleFor({ status: 'working', activity: { tool: 'TaskUpdate', target: '#2' },
    plan: [{ text: 'Verify retries', status: 'in_progress' }] }), 'Plan · Verify retries');
  assert.equal(format.matchesFilter({ status: 'approval', provider: 'codex', title: 'x' }, 'approval needed'), true);
});

test('a tool keeps one label per language, so switching languages never shows a cached one', () => {
  i18n.setLocale('en');
  assert.equal(format.toolKind('Read').label, 'Read file');
  i18n.setLocale('ko');
  assert.equal(format.toolKind('Read').label, '파일 읽기');
  i18n.setLocale('en');
  assert.equal(format.toolKind('Read').label, 'Read file');
});
