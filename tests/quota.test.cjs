'use strict';
require('../media/i18n.js').setLocale('ko'); // These cases check the Korean text; i18n.test.cjs covers English.

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {createQuotaReader} = require('../src/quota.cjs');

const updatedAt = Date.UTC(2026, 9, 1);
const reset = '2026-10-02T00:00:00Z';
const resetsAt = Date.parse(reset);

async function fixture(t, provider, script, extra = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'account quota-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const executable = path.join(dir, provider);
  await fs.writeFile(executable, '#!' + process.execPath + '\n' + script, {mode: 0o700});
  return createQuotaReader({[provider + 'Path']: executable, homeDir: dir, env: {PATH: ''},
    now: () => updatedAt, ...extra});
}

const protocol = `
  const assert = require('node:assert/strict');
  const rl = require('node:readline').createInterface({input: process.stdin});
  const send = data => process.stdout.write(JSON.stringify(data) + '\\n');
  const argv = process.argv.slice(2);
`;

function claudeScript(quota) {
  return protocol + `
    assert.deepEqual(argv, ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--verbose', '--safe-mode', '--no-session-persistence', '--tools', '']);
    let count = 0;
    rl.on('line', line => {
      const packet = JSON.parse(line);
      assert.equal(packet.type, 'control_request');
      if (++count === 1) assert.deepEqual(packet.request, {subtype:'initialize',hooks:{},sdkMcpServers:[]});
      else assert.deepEqual(packet.request, {subtype:'get_usage', skip_behaviors:true});
      send({type:'control_response', response:{subtype:'success', request_id:packet.request_id,
        response:count === 1 ? {} : ` + JSON.stringify(quota) + ` }});
    });
  `;
}

test('Claude requests account windows through control messages without a user turn or a transcript scan', async t => {
  const read = await fixture(t, 'claude', claudeScript({subscription_type: 'max', rate_limits_available: true,
    session: {total_cost_usd: 100, usage: {output_tokens: 920}}, rate_limits: {
      five_hour: {utilization: 0, resets_at: reset}, seven_day: {utilization: 75, resets_at: null},
      seven_day_sonnet: {utilization: null}, seven_day_opus: {utilization: 97},
      model_scoped: [{display_name: 'Opus', utilization: 97}, {display_name: 'Fable', utilization: 1.5}],
      extra_usage: {utilization: 20, used_credits: 20},
    }}));
  assert.deepEqual(await read('claude'), {status: 'ready', updatedAt, plan: 'Max', windows: [
    {name:'',period:300,percent:0,kind:'used',resetsAt}, {name:'',period:10080,percent:75,kind:'used'},
    {name:'Opus',period:10080,percent:97,kind:'used'}, {name:'Fable',period:10080,percent:1.5,kind:'used'},
  ]});
});

test('Claude API-key-only sessions do not produce synthetic account percentages', async t => {
  const read = await fixture(t, 'claude', claudeScript({rate_limits_available: false, rate_limits: null,
    session: {usage: {input_tokens: 200}}}));
  const result = await read('claude');
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.windows, []);
  assert.equal(result.signedOut, true);
});

test('diagnostic lines a client prints on stdout between protocol messages do not abort the quota read', async t => {
  const read = await fixture(t, 'claude', protocol + `
    process.stdout.write('Warning: a newer version is available\\n');
    let count = 0;
    rl.on('line', line => {
      const packet = JSON.parse(line);
      process.stdout.write('[debug] received ' + packet.request_id + '\\n');
      send({type:'control_response', response:{subtype:'success', request_id:packet.request_id,
        response:++count === 1 ? {} : {subscription_type:'pro', rate_limits:{five_hour:{utilization:12}}}}});
    });
  `);
  assert.deepEqual(await read('claude'), {status: 'ready', updatedAt, plan: 'Pro', windows: [
    {name:'',period:300,percent:12,kind:'used'},
  ]});
});

test('Codex sends only initialization and an account rate limit read, preserves distinct model windows', async t => {
  const primary = {usedPercent: 10, windowDurationMins: 300, resetsAt: resetsAt / 1000};
  const codex = {limitId:'codex', planType:'prolite', primary,
    secondary:{usedPercent:100,windowDurationMins:10080,resetsAt:null}};
  const reply = {rateLimits:codex, rateLimitsByLimitId:{codex,
    spark:{limitName:'Spark', primary:{usedPercent:50,windowDurationMins:60}},
    empty:{primary:{usedPercent:null},secondary:{windowDurationMins:300}},
  }};
  const read = await fixture(t, 'codex', protocol + `
    assert.deepEqual(argv, ['app-server', '--listen', 'stdio://']);
    let count = 0;
    rl.on('line', line => {
      const packet = JSON.parse(line);
      if (++count === 1) {
        assert.equal(packet.method,'initialize');
        send({id:packet.id,result:{userAgent:'example'}});
      } else if (count === 2) assert.deepEqual(packet,{method:'initialized'});
      else {
        assert.deepEqual(packet,{id:2,method:'account/rateLimits/read',params:{}});
        send({method:'account/updated',params:{ignore:'private'}});
        send({id:2,result:` + JSON.stringify(reply) + `});
      }
    });
  `);
  assert.deepEqual(await read('codex'), {status:'ready',plan:'Pro Lite',updatedAt,windows:[
    {name:'',period:300,percent:10,kind:'used',resetsAt},{name:'',period:10080,percent:100,kind:'used'},
    {name:'Spark',period:60,percent:50,kind:'used'},
  ]});
});

function agyScript(version, result) {
  return `
    const assert = require('node:assert/strict');
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--version') {
      console.log(` + JSON.stringify(version) + `);
    } else {
      assert.deepEqual(args, ['-p', '/usage', '--output-format', 'json']);
      console.log(` + JSON.stringify(JSON.stringify(result)) + `);
    }
  `;
}

test('AGY returns account quota remaining per model group and skips missing and malformed fractions', async t => {
  const data = {status:'SUCCESS', num_turns:0, usage:{total_tokens:0}, command:{name:'usage',data:{
    groups:[{name:'Gemini Models',buckets:[{id:'g',window:'weekly',remaining_fraction:0.875,reset_time:reset},
      {id:'hidden',window:'daily',remaining_fraction:null},
      {id:'burst',window:'burst',name:'Five Hour Limit Remaining',remaining_fraction:1}]},
      {name:'Claude and GPT models',buckets:[{id:'p',window:'daily',remaining_fraction:0},
        {id:'bad',window:'monthly',remaining_fraction:1.5}]}]}}};
  const read = await fixture(t, 'agy', agyScript('1.1.11', data));
  assert.deepEqual(await read('agy'), {status:'ready',updatedAt,windows:[
    {name:'Gemini Models',period:'weekly',percent:87.5,kind:'remaining',resetsAt},
    {name:'Gemini Models',period:300,percent:100,kind:'remaining'},
    {name:'Claude and GPT models',period:'daily',percent:0,kind:'remaining'},
  ]});
});

test('AGY on an old or unidentified version never submits the print argument', async t => {
  for (const version of ['1.1.10', '1.1.10-rc.1', 'development build']) {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-guard-'));
    t.after(() => fs.rm(temp, {recursive:true,force:true}));
    const marker = path.join(temp, 'print-submitted');
    const read = await fixture(t, 'agy', agyScript(version, {}) +
      '\nif (!process.argv.includes("--version")) require("fs").writeFileSync(' + JSON.stringify(marker) + ', "1");');
    const result = await read('agy');
    assert.equal(result.status, 'unavailable');
    assert.match(result.message, /1\.1\.11/);
    await assert.rejects(fs.access(marker), {code:'ENOENT'});
  }
  const okData = {status:'SUCCESS', num_turns:0, command:{name:'usage', data:{
    groups:[{name:'Gemini Models', buckets:[{id:'g', window:'weekly', remaining_fraction:0.5}]}]}}};
  for (const version of ['1.12.0-rc.1', 'Antigravity CLI v1.2.0+build.42']) {
    const read = await fixture(t, 'agy', agyScript(version, okData));
    const result = await read('agy');
    assert.equal(result.status, 'ready', version);
    assert.equal(result.windows[0].percent, 50);
  }
});

test('AGY rejects conversation output and does not expose stdout or stderr on errors', async t => {
  const payload = {num_turns:1,usage:{total_tokens:50},response:'sensitive-model-result'};
  for (const script of [agyScript('1.5.16', payload), 'console.error("private-diagnostic"); process.exit(1)']) {
    const read = await fixture(t, 'agy', script);
    const result = await read('agy');
    assert.equal(result.status, 'unavailable');
    assert.deepEqual(result.windows, []);
    assert.doesNotMatch(JSON.stringify(result), /private|sensitive/);
  }
});

test('quota client timeouts return without leaving the caller waiting', async t => {
  const read = await fixture(t, 'codex', 'setInterval(() => {}, 2000)', {timeoutMs:80});
  const result = await read('codex');
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.windows, []);
});

test('binary resolves newest nvm bin, prepends binDir to PATH for env-node CLIs, normalizes new plan names and codex planType fallback', async t => {
  // 1. Discover newest nvm semver dir and prepend its bin dir to PATH so `#!/usr/bin/env node` resolves sibling node.
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-nvm-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const oldBin = path.join(home, '.nvm', 'versions', 'node', 'v20.10.0', 'bin');
  const newBin = path.join(home, '.nvm', 'versions', 'node', 'v22.5.0', 'bin');
  await Promise.all([fs.mkdir(oldBin, { recursive: true }), fs.mkdir(newBin, { recursive: true })]);
  await fs.symlink(process.execPath, path.join(newBin, 'node'));
  // Codex reply where rateLimitsByLimitId.codex omits planType, falling back to data.rateLimits.planType.
  const reply = {
    rateLimits: { planType: 'ultra', primary: { usedPercent: 20, windowDurationMins: 300 } },
    rateLimitsByLimitId: { codex: { limitId: 'codex', primary: { usedPercent: 20, windowDurationMins: 300 } } },
  };
  await fs.writeFile(path.join(oldBin, 'codex'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  await fs.writeFile(path.join(newBin, 'codex'), '#!/usr/bin/env node\n' + protocol + `
    assert.ok((process.env.PATH || '').split(require('node:path').delimiter)[0] === ${JSON.stringify(newBin)});
    let count = 0;
    rl.on('line', line => {
      const packet = JSON.parse(line);
      if (++count === 1) send({ id: packet.id, result: { userAgent: 'nvm-test' } });
      else if (count === 3) send({ id: 2, result: ${JSON.stringify(reply)} });
    });
  `, { mode: 0o700 });
  const readNvm = createQuotaReader({ homeDir: home, env: { PATH: '' }, now: () => updatedAt });
  const codexRes = await readNvm('codex');
  assert.equal(codexRes.status, 'ready');
  assert.equal(codexRes.plan, 'Ultra');
  assert.equal(codexRes.windows[0].percent, 20);

  // 2. Plan tier normalization for Google AI Ultra / Pro and Claude Max 5x / 20x.
  for (const [tier, expected] of [['google_ai_ultra', 'AI Ultra'], ['google_ai_pro', 'AI Pro']]) {
    const readAgy = await fixture(t, 'agy', agyScript('1.2.0', {
      status: 'SUCCESS', num_turns: 0, command: { name: 'usage', data: {
        plan_tier: tier, groups: [{ name: 'Gemini', buckets: [{ window: 'weekly', remaining_fraction: 0.9 }] }],
      } },
    }));
    assert.equal((await readAgy('agy')).plan, expected, tier);
  }
  for (const [subType, expected] of [['max_5x', 'Max 5x'], ['max_20x', 'Max 20x']]) {
    const readClaude = await fixture(t, 'claude', claudeScript({
      subscription_type: subType, rate_limits_available: true, rate_limits: { five_hour: { utilization: 10 } },
    }));
    assert.equal((await readClaude('claude')).plan, expected, subType);
  }
});
