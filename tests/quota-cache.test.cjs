'use strict';
require('../media/i18n.js').setLocale('ko'); // These cases check the Korean text; i18n.test.cjs covers English.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createQuotaCache, AUTO_INTERVAL, MANUAL_INTERVAL } = require('../src/quota-cache.cjs');
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'asm-quotas-'));
  t.after(() => fs.rm(directory,{recursive:true,force:true}));
  return directory;
}
test('two windows share one account request, private normalized snapshot, and five-minute budget', async t => {
  const dir = await fixture(t);
  let time = Date.now(), calls = 0;
  const reader = async () => {
    calls++;
    return {status:'ready',plan:'Max', email:'unused', windows:[{name:'',period:10080,percent:0,kind:'remaining',resetsAt:time+10000,secret:'unused'}]};
  };
  const a = createQuotaCache(dir,reader,{now:()=>time});
  const b = createQuotaCache(dir,reader,{now:()=>time});
  await Promise.all([a.update('claude'),a.update('claude'),b.update('claude')]);
  await b.update('claude');
  assert.equal(calls,1);
  assert.equal(b.entries.claude.windows[0].percent,0);
  const file = path.join(dir,'claude.json');
  assert.equal((await fs.stat(file)).mode & 0o777,0o600);
  assert.doesNotMatch(await fs.readFile(file,'utf8'),/secret|email|unused/);
  time += 11000;
  await b.update('claude');
  assert.equal(b.entries.claude.status,'stale');
  await a.update('claude',{manual:true});
  assert.equal(calls,1);
  time += MANUAL_INTERVAL;
  await a.update('claude',{manual:true});
  assert.equal(calls,2);
  time += AUTO_INTERVAL - 1;
  await a.update('claude');
  assert.equal(calls,2);
  time++;
  await b.update('claude');
  assert.equal(calls,3);
});
test('refresh preserves a dated previous result on failure and retries on the next interval', async t => {
  const dir = await fixture(t);
  let time = Date.now(), calls = 0;
  const cache = createQuotaCache(dir, async () => ++calls === 1 ? {status:'ready', windows:[{name:'Opus',period:10080,kind:'used',percent:42}]} :
    {status:'unavailable',message:'일시적으로 연결할 수 없습니다.'}, {now:()=>time});
  await cache.update('codex'); const stamp = time;
  time += AUTO_INTERVAL;
  await cache.update('codex');
  assert.deepEqual(cache.entries.codex,{status:'stale', windows:[{name:'Opus',period:10080,kind:'used',percent:42}],updatedAt:stamp,message:'일시적으로 연결할 수 없습니다.'});
  time += 86400001;
  await cache.update('codex');
  assert.equal(cache.entries.codex.status,'unavailable');
  assert.equal(calls,3);
});
test('a cache written before windows were language-neutral still shows its last reading', async t => {
  const dir = await fixture(t);
  const time = Date.now();
  await fs.writeFile(path.join(dir, 'claude.json'), JSON.stringify({attempt:time, success:{status:'ready', updatedAt:time,
    windows:[{label:'주간',kind:'used',percent:40}]}}));
  const cache = createQuotaCache(dir, async () => { throw new Error('not due yet'); }, {now:()=>time});
  await cache.update('claude');
  assert.deepEqual(cache.entries.claude.windows, [{name:'',period:'주간',kind:'used',percent:40}]);
});
test('first lookup without account data never shows a zero balance', async t => {
  const dir = await fixture(t);
  const cache = createQuotaCache(dir,async () => ({status:'ready',windows:[{label:'잘못된 값',kind:'used',percent:'0'}]}));
  await cache.update('agy'); await cache.update('../other');
  assert.equal(cache.entries.agy.status,'unavailable');
  assert.deepEqual(cache.entries.agy.windows,[]);
  assert.deepEqual(await fs.readdir(dir),['agy.json']);
});

test('sign-out clears cached limits in English and Korean, while transient English connection errors keep stale readings', async t => {
  const dir = await fixture(t);
  let time = Date.now();
  const ready = { status: 'ready', windows: [{ name: '', period: 300, kind: 'used', percent: 25 }] };

  // 1. Transient English connection error preserves previous reading as stale.
  let step = 0;
  const transient = createQuotaCache(dir, async () => ++step === 1
    ? ready
    : { status: 'unavailable', windows: [], message: 'Could not get subscription usage. Check your sign-in and connection.' }, { now: () => time });
  await transient.update('claude');
  time += AUTO_INTERVAL;
  await transient.update('claude');
  assert.equal(transient.entries.claude.status, 'stale');
  assert.equal(transient.entries.claude.windows.length, 1);

  // 2. Explicit signedOut flag clears cached reading immediately.
  const signedOut = createQuotaCache(dir, async () => ({
    status: 'unavailable', windows: [], signedOut: true,
    message: 'Could not read subscription limits. Check that you are signed in to the tool.',
  }), { now: () => time });
  time += AUTO_INTERVAL;
  await signedOut.update('claude');
  assert.equal(signedOut.entries.claude.status, 'unavailable');
  assert.deepEqual(signedOut.entries.claude.windows, []);

  // 3. English sign-in error text also clears cached reading without needing signedOut: true.
  let codexStep = 0;
  const byMessage = createQuotaCache(dir, async () => ++codexStep === 1
    ? ready
    : { status: 'unavailable', windows: [], message: 'Sign-in required' }, { now: () => time });
  await byMessage.update('codex');
  assert.equal(byMessage.entries.codex.status, 'ready');
  time += AUTO_INTERVAL;
  await byMessage.update('codex');
  assert.equal(byMessage.entries.codex.status, 'unavailable');
  assert.deepEqual(byMessage.entries.codex.windows, []);
});
