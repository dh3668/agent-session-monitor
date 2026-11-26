'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {mergeExecution,createReceipts}=require('../src/inbox.cjs');

test('selects model and effort independently, checking field time and provenance',()=>{
  const native={model:'old',modelSource:'response',modelAt:10,effort:'high',effortSource:'setting'};
  assert.deepEqual(mergeExecution(native,{model:'new',modelSource:'call',modelAt:20}),{
    model:'new',modelSource:'call',modelAt:20,effort:'high',effortSource:'setting'});
  assert.deepEqual(mergeExecution(native,{model:'maybe',modelSource:'setting'}),native);
  assert.equal(mergeExecution({},{}),undefined);
});

test('Claude family settings preserve the concrete response and a dated model switch can supersede it', () => {
  const setting = (model, modelAt = 20) => ({ model, modelSource: 'setting', modelAt });
  for (const family of ['fable', 'opus', 'sonnet', 'haiku', 'mythos']) {
    const model = family === 'opus' ? 'claude-opus-5-5' : 'claude-' + family + '-5-2';
    for (const dates of [{ modelAt: 10 }, {}]) {
      const response = { model, modelSource: 'response', ...dates };
      for (const alias of [family, family.toUpperCase() + '[1M]', model]) {
        const merged = mergeExecution(response, { ...setting(alias), effort: 'low', effortSource: 'setting' }, 'claude');
        assert.deepEqual(merged, { ...response, effort: 'low', effortSource: 'setting' });
        assert.deepEqual(mergeExecution(setting(alias), response, 'claude'), response);
      }
      for (const next of [family === 'opus' ? 'fable' : 'opus', 'claude-' + family + '-5-6']) {
        assert.deepEqual(mergeExecution(response, setting(next), 'claude'), setting(next));
      }
    }
  }
  const response = { model: 'claude-fable-5-2', modelSource: 'response', modelAt: 30 };
  assert.deepEqual(mergeExecution(response, setting('opus'), 'claude'), response);
  assert.deepEqual(mergeExecution(response, setting('opus', 30), 'claude'), response);
});

test('only a specific observed parent reply advances the durable receipt',async()=>{
  const map=new Map();
  const storage={get:k=>map.get(k),update:async(k,v)=>map.set(k,v)};
  const inbox=createReceipts(storage,()=>{},()=>{});
  const row={key:'x',status:'done',replyAt:10};
  assert.equal(inbox.unread({...row,isSubagent:true}),false);
  assert.equal(inbox.unread({...row,status:'working'}),false);
  assert.equal(inbox.unread({...row,workSince:12}),false,'an empty later turn cannot revive an earlier reply');
  assert.equal(inbox.unread({...row,replyAt:undefined}),false);
  await inbox.mark(row,9); assert.ok(inbox.unread(row));
  await Promise.all([inbox.mark(row,10),inbox.mark({...row,replyAt:11},11)]);
  assert.equal(map.get('replySeen:x'),11);
  assert.ok(!createReceipts(storage,()=>{},()=>{}).unread(row));
});

test('Codex current thread settings win an undated settings tie; Claude start sidecars yield to the hook',()=>{
  const native={model:'from-db',modelSource:'setting'}, hook={model:'old-start',modelSource:'setting',modelAt:10};
  assert.equal(mergeExecution(native,hook,'codex').model,'from-db');
  assert.equal(mergeExecution(native,hook,'claude').model,'old-start');
});

test('error acknowledgment matches an exact failure timestamp and resets on a later failure',async()=>{
  const map=new Map();
  const storage={get:k=>map.get(k),update:async(k,v)=>map.set(k,v)};
  const inbox=createReceipts(storage,()=>{},()=>{});
  const failed={key:'claude/s1',status:'error',updatedAt:100};
  assert.equal(inbox.errorAcked(failed),false);
  assert.equal(inbox.errorAcked({...failed,status:'done'}),false);
  await inbox.ackError(failed,99);
  assert.equal(inbox.errorAcked(failed),false,'a stale stamp cannot acknowledge a newer error');
  await inbox.ackError(failed,100);
  assert.equal(inbox.errorAcked(failed),true);
  assert.equal(map.get('errorSeen:claude/s1'),100);
  assert.equal(inbox.errorAcked({...failed,updatedAt:101}),false,'a later failure alerts again');
  assert.equal(createReceipts(storage,()=>{},()=>{}).errorAcked(failed),true);
});

test('prune cleans stale replySeen and errorSeen entries while preserving active, recent and unrelated keys', async () => {
  const day = 86400000;
  const now = 30 * day;
  const map = new Map([
    ['sessionLayout.v1', { sort: 'priority' }],
    ['replySeen:claude/active', now - 20 * day],
    ['replySeen:claude/recent', now - 5 * day],
    ['replySeen:claude/stale', now - 15 * day],
    ['errorSeen:codex/stale-err', now - 15 * day],
    ['errorSeen:codex/active-err', now - 20 * day],
  ]);
  const storage = {
    keys: () => [...map.keys()],
    get: k => map.get(k),
    update: async (k, v) => { if (v === undefined) map.delete(k); else map.set(k, v); },
  };
  const inbox = createReceipts(storage, () => {}, () => {});
  const removed = await inbox.prune(new Set(['claude/active', 'codex/active-err']), 14 * day, now);
  assert.equal(removed, 2);
  assert.deepEqual([...map.keys()].sort(), [
    'errorSeen:codex/active-err',
    'replySeen:claude/active',
    'replySeen:claude/recent',
    'sessionLayout.v1',
  ]);
  // Storage without keys() is a safe no-op.
  const minimal = createReceipts({ get: () => undefined, update: async () => {} }, () => {}, () => {});
  assert.equal(await minimal.prune(['claude/active'], 14 * day, now), 0);
});
