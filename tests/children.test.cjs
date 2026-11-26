'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createChildReader } = require('../src/children.cjs');

const timestamp = Date.UTC(2026,10,23,15);
const root = (provider,id,extra={}) => ({provider,key:provider+'/'+id,sessionId:id,status:'recent',cwd:'/project',updatedAt:timestamp,...extra});
async function fixture(t) {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(),'session-children-'));
  t.after(()=>fs.rm(homeDir,{recursive:true,force:true}));
  const db = async (name,sql) => {
    const location = path.join(homeDir,name);
    await fs.mkdir(path.dirname(location),{recursive:true});
    execFileSync('/usr/bin/sqlite3',[location],{input:sql});
  };
  return {db,homeDir,read:createChildReader({homeDir,env:{},now:()=>timestamp})};
}

test('Codex index attaches nested children exactly once, trusts live state, ignores unanchored agents and old children', async t => {
  const {db,read} = await fixture(t);
  const sec = timestamp/1000;
  await db('.codex/state_9.sqlite',`CREATE TABLE threads(id TEXT,cwd TEXT,updated_at INTEGER,agent_nickname TEXT,agent_role TEXT);
    CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT,status TEXT);
    INSERT INTO threads VALUES ('level1','/project',${sec},'Ada','reviewer'),('level2','/project',${sec},'Max','worker'),
      ('unrelated','/project',${sec},'Unrelated','worker'),('old','/project',0,'Old','worker');
    INSERT INTO thread_spawn_edges VALUES ('parent','level1','open'),('level1','level2','open'),('other','unrelated','open'),('parent','old','open');`);
  const liveChild = root('codex','level2',{isSubagent:true,parentKey:'codex/parent',status:'approval'});
  const result = await read([root('codex','parent'),liveChild]);
  const child=result.find(r=>r.sessionId==='level1'),nested=result.find(r=>r.sessionId==='level2');
  assert.equal(result.length,3);
  assert.equal(child.title,'Ada · reviewer');
  assert.equal(child.status,'recent');
  assert.equal(child.parentKey,'codex/parent');
  assert.equal(nested.status,'approval');
  assert.equal(nested.parentKey,'codex/level1');
  // A cache hit updates fresh hook state immediately.
  const cached=await read([root('codex','parent'),{...liveChild,status:'done'}]);
  assert.equal(cached.find(r=>r.sessionId==='level2').status,'done');
  const orphan = await read([liveChild],{force:true});
  assert.equal(orphan.length,3);
  assert.ok(orphan.some(r=>r.key==='codex/parent' && r.status==='recent'));
});

test('Antigravity reconciles native parent IDs with child hook rows, and keeps database-only idle distinct from completed', async t=>{
  const {db,read} = await fixture(t);
  const datetime = new Date(timestamp).toISOString();
  await db('.gemini/antigravity/conversation_summaries.db',`CREATE TABLE conversation_summaries(
      conversation_id TEXT, parent_conversation_id TEXT, agent_name TEXT, status TEXT, killed INTEGER,last_modified_time TEXT);
    INSERT INTO conversation_summaries VALUES ('root','','','CASCADE_RUN_STATUS_IDLE',0,'${datetime}'),
      ('child','root','Planner','CASCADE_RUN_STATUS_IDLE',0,'${datetime}'),
      ('nested','child','Task','CASCADE_RUN_STATUS_RUNNING',0,'${datetime}'),
      ('other','unrelated','Planner','CASCADE_RUN_STATUS_IDLE',1,'${datetime}');`);
  const indexed=await read([root('agy','root')]);
  assert.equal(indexed.length,3);
  const child = indexed.find(r=>r.sessionId==='child');
  assert.equal(child.status,'idle');
  assert.equal(child.title,'Planner');
  assert.equal(child.cwd,'/project');
  const nested=indexed.find(r=>r.sessionId==='nested');
  assert.equal(nested.parentKey,'agy/child');
  assert.equal(nested.status,'working');
  assert.equal(nested.cwd,'/project');
  const observed=await read([root('agy','child',{status:'done'})]);
  assert.equal(observed.find(r=>r.sessionId==='child').status,'done');
  assert.equal(observed.find(r=>r.sessionId==='child').isSubagent,true);
  assert.equal(observed.find(r=>r.sessionId==='nested').cwd,'/project');
  assert.ok(observed.some(r=>r.key==='agy/root' && !r.isSubagent));
});

test('observed Claude child with no parent hook produces a parent row even without provider databases', async t=>{
  const {read} = await fixture(t);
  const {createWorkspaceScope} = require('../src/workspace-sessions.cjs');
  const child=root('claude','agent1',{key:'claude/root/agent1',isSubagent:true,canOpen:false,parentKey:'claude/root',title:'Explore',status:'working'});
  const result=await read([child]);
  assert.equal(result.length,2);
  assert.ok(result.includes(child));
  // Concrete non-inherited child cwd lets scope.filter verify and keep the synthesized parent (enabling viaParent).
  assert.deepEqual(result.find(r=>r.key==='claude/root'),root('claude','root'));
  const scope = await createWorkspaceScope(['/project']);
  const scoped = await scope.filter(result);
  assert.deepEqual(scoped.map(r=>r.key).sort(),['claude/root','claude/root/agent1']);
  // A child without a concrete cwd (or with workspaceInherited:true) still marks its synthesized parent inherited.
  const inheritedChild=root('claude','agent2',{key:'claude/root2/agent2',isSubagent:true,canOpen:false,parentKey:'claude/root2',workspaceInherited:true,status:'working'});
  const inheritedRes=await read([inheritedChild],{force:true});
  assert.equal(inheritedRes.find(r=>r.key==='claude/root2').workspaceInherited,true);
  assert.deepEqual(await scope.filter(inheritedRes),[]);
  assert.deepEqual(await read([]),[]);
});

test('Antigravity indexes running children with Go zero time and preserves their observed waits until killed', async t => {
  const { db, read } = await fixture(t);
  const file = '.gemini/antigravity/conversation_summaries.db';
  const zero = '0001-01-01 00:00:00+00:00';
  const iso = ms => new Date(ms).toISOString();
  const week = 7 * 86400000;
  await db(file, `CREATE TABLE conversation_summaries(conversation_id,parent_conversation_id,status,killed,last_modified_time);
    INSERT INTO conversation_summaries VALUES
    ('parent','','',0,'${iso(timestamp - 30000)}'),('child','parent','CASCADE_RUN_STATUS_RUNNING',0,'${zero}'),
    ('nested','child','CASCADE_RUN_STATUS_RUNNING',0,'${zero}'),
    ('old-parent','','',0,'${iso(timestamp - 2 * week)}'),('old-clock','old-parent','CASCADE_RUN_STATUS_IDLE',0,'${zero}'),
    ('future-parent','','',0,'${iso(timestamp + week)}'),('future-clock','future-parent','CASCADE_RUN_STATUS_RUNNING',0,NULL);`);
  const parents = ['parent', 'old-parent', 'future-parent'].map(id => root('agy', id));
  const indexed = await read(parents);
  const child = indexed.find(r => r.key === 'agy/child');
  assert.deepEqual([child.parentKey, child.status, child.updatedAt], ['agy/parent', 'working', timestamp - 30000]);
  assert.equal(indexed.find(r => r.key === 'agy/nested').updatedAt, timestamp);
  assert.equal(indexed.find(r => r.key === 'agy/old-clock').updatedAt, timestamp - week);
  assert.equal(indexed.find(r => r.key === 'agy/future-clock').updatedAt, timestamp + 60000);
  const fields = { pendingEntries: [{ ref: 'hard', status: 'approval', since: timestamp }], pendingRefs: ['hard'],
    pendingSoftEntries: [{ ref: 'soft', status: 'approval', since: timestamp, after: timestamp + 5000 }],
    softPendingRefs: ['soft'], nextSoftWaitAt: timestamp + 5000, waitSince: timestamp, workSince: timestamp - 3000,
    activityAt: timestamp, interrupted: true, liveTurnConfirmed: true };
  const observed = root('agy', 'child', { status: 'approval', ...fields });
  const attached = (await read([observed])).find(r => r.key === observed.key);
  assert.equal(attached.parentKey, 'agy/parent');
  assert.equal(attached.status, 'approval');
  for (const [key, value] of Object.entries(fields)) assert.deepEqual(attached[key], value, key);

  await db(file, `UPDATE conversation_summaries SET killed=1,status='CASCADE_RUN_STATUS_IDLE',
    last_modified_time='${iso(timestamp - 1000)}' WHERE conversation_id='child'`);
  for (const status of ['working', 'approval']) {
    const killed = (await read([{ ...observed, status }], { force: true })).find(r => r.key === observed.key);
    assert.deepEqual([killed.status, killed.updatedAt], ['idle', timestamp - 1000]);
    for (const key of Object.keys(fields)) assert.equal(killed[key], undefined, key);
  }
});

test('an empty Claude orphan cwd yields to the parent project directory during sidecar discovery', async t => {
  const { homeDir, read } = await fixture(t);
  for (const [slug, agent] of [['-a-decoy', 'unrelated'], ['-project', 'correct']]) {
    const dir = path.join(homeDir, '.claude/projects', slug, 'parent/subagents');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'agent-' + agent + '.jsonl');
    await fs.writeFile(file, '');
    await fs.utimes(file, new Date(timestamp), new Date(timestamp));
  }
  const orphan = root('claude', 'orphan', { key: 'claude/parent/orphan', parentKey: 'claude/parent', isSubagent: true, cwd: '' });
  const rows = await read([orphan, root('claude', 'parent')]);
  assert.ok(rows.some(r => r.key === 'claude/parent/correct'));
  assert.ok(!rows.some(r => r.sessionId === 'unrelated'));
});

test('Claude native file names recover prior agents and nested sidecar IDs without exposing transcript or private metadata',async t=>{
  const {homeDir} = await fixture(t);
  let clock = timestamp;
  const read = createChildReader({homeDir,env:{},now:()=>clock});
  const folder = path.join(homeDir,'.claude','projects','-worktree-main','root','subagents');
  const unrelated = path.join(homeDir,'.claude','projects','-project','untracked-root','subagents');
  await Promise.all([fs.mkdir(folder,{recursive:true}),fs.mkdir(unrelated,{recursive:true})]);
  const write = async (where,name,body,time=timestamp) => {
    const file=path.join(where,name);
    await fs.writeFile(file,body);
    await fs.utimes(file,new Date(time),new Date(time));
  };
  await Promise.all([
    write(folder,'agent-worker.meta.json',JSON.stringify({agentType:'Worker',description:'API 정리',prompt:'private prompt',finished:true})),
    write(folder,'agent-worker.jsonl','private transcript'),
    write(folder,'agent-nested.meta.json',JSON.stringify({agentType:'Reviewer',parentAgentId:'worker',model:'claude-sonnet-4-6',requestShape:{prompt:'private text'}})),
    write(folder,'agent-no-meta.jsonl','private transcript'),
    write(folder,'agent-old.jsonl','old private transcript',0),
    write(unrelated,'agent-unrelated.meta.json','{}'),
  ]);
  const liveChild=root('claude','nested',{key:'claude/root/nested',parentKey:'claude/root',isSubagent:true,status:'done',title:'Reviewer'});
  const parent = root('claude','root',{title:'내 프로젝트'});
  const found = await read([parent,liveChild]);
  assert.equal(found.length,4);
  const nested=found.find(r=>r.sessionId==='nested');
  assert.equal(nested.parentKey,'claude/root/worker');
  assert.equal(nested.status,'done');
  assert.equal(nested.canOpen,false);
  assert.equal(found.find(r=>r.sessionId==='worker').title,'Worker · API 정리');
  assert.equal(found.find(r=>r.sessionId==='worker').status,'recent');
  assert.equal(found.find(r=>r.sessionId==='no-meta').parentKey,'claude/root');
  assert.doesNotMatch(JSON.stringify(found),/private|unrelated|\.jsonl|meta\.json/);
  assert.equal(found.find(r=>r.key==='claude/root'),parent);
  await write(folder,'agent-new.meta.json',JSON.stringify({agentType:'New worker'}));
  clock += 30000;
  const cached = await read([parent,{...liveChild,status:'approval'}]);
  assert.equal(cached.length,4);
  assert.equal(cached.find(r=>r.key===liveChild.key).status,'approval');
  const fresh = await read([parent,liveChild],{force:true});
  assert.equal(fresh.length,5);
  assert.equal(fresh.find(r=>r.sessionId==='new').title,'New worker');
});

test('Claude reports the exact child’s response model and sidecar effort independently, keeping hook actions during enrichment',async t=>{
  const {homeDir,read} = await fixture(t);
  const folder = path.join(homeDir,'.claude','projects','-project','root','subagents');
  await fs.mkdir(folder,{recursive:true});
  const write = async (file,content) => {
    const target = path.join(folder,file);
    await fs.writeFile(target,content);
    await fs.utimes(target,new Date(timestamp),new Date(timestamp));
  };
  const response = (id,model,overrides={}) => ({type:'assistant',sessionId:'root',agentId:id,isSidechain:true,
    timestamp:new Date(timestamp-60000).toISOString(),message:{role:'assistant',model,content:'private'},...overrides});
  await Promise.all([
    write('agent-first.meta.json',JSON.stringify({agentType:'Worker',model:'sonnet',effort:'medium',prompt:'private'})),
    write('agent-first.jsonl',[response('first','claude-sonnet-4-6'),response('first','wrong-root',{sessionId:'wrong'}),
      response('nested','wrong-child'),response('first','wrong-role',{type:'user'}),response('first','<synthetic>')]
      .map(x=>JSON.stringify(x)).join('\n')),
    write('agent-nested.meta.json',JSON.stringify({parentAgentId:'first',model:'claude-haiku-4-5',effort:'low'})),
    write('agent-unset.meta.json',JSON.stringify({model:'inherit',requestShape:{model:'nested-private',effort:'high'}})),
  ]);
  const hookExec = {model:'opus',modelSource:'setting'};
  const hooked = root('claude','first',{key:'claude/root/first',isSubagent:true,parentKey:'claude/root',
    status:'input',waitSince:timestamp-40000,workSince:timestamp-45000,replyAt:timestamp-50000,completedAt:timestamp-60000,execution:hookExec});
  const rows = await read([root('claude','root'),hooked]);
  const first = rows.find(r=>r.sessionId==='first'), nested=rows.find(r=>r.sessionId==='nested');
  assert.deepEqual(first.nativeExecution,{model:'claude-sonnet-4-6',modelSource:'response',modelAt:timestamp-60000,
    effort:'medium',effortSource:'setting'});
  assert.equal(first.execution,hookExec);
  for (const key of ['status','waitSince','workSince','completedAt']) assert.equal(first[key],hooked[key]);
  assert.equal(first.replyAt, undefined, 'subagents never carry root replyAt');
  assert.deepEqual(nested.nativeExecution,{model:'claude-haiku-4-5',modelSource:'setting',effort:'low',effortSource:'setting'});
  assert.equal(nested.parentKey,'claude/root/first');
  assert.equal(rows.find(r=>r.sessionId==='unset').nativeExecution,undefined);
  assert.doesNotMatch(JSON.stringify(rows),/private|wrong-root|wrong-child|requestShape/);
});

test('nested Codex settings are read per child without inheriting from a known parent or sibling',async t=>{
  const {db,read} = await fixture(t);
  const sec = timestamp/1000;
  await db('.codex/state_5.sqlite',`CREATE TABLE threads(id,cwd,updated_at,model,reasoning_effort);
    CREATE TABLE thread_spawn_edges(parent_thread_id,child_thread_id);
    INSERT INTO threads VALUES ('root','/project',${sec},'gpt-5.4','high'),('one','/project',${sec},'gpt-5.3-codex','medium'),
      ('two','/project',${sec},NULL,'low'),('three','/project',${sec},NULL,NULL);
    INSERT INTO thread_spawn_edges VALUES ('root','one'),('one','two'),('root','three');`);
  const rows=await read([root('codex','root')]);
  assert.deepEqual(rows.find(r=>r.sessionId==='one').nativeExecution,
    {model:'gpt-5.3-codex',modelSource:'setting',effort:'medium',effortSource:'setting'});
  assert.deepEqual(rows.find(r=>r.sessionId==='two').nativeExecution,{effort:'low',effortSource:'setting'});
  assert.equal(rows.find(r=>r.sessionId==='three').nativeExecution,undefined);
});

test('Antigravity workspace URIs keep foreign and remote-only branches out and locate a missing parent independently',async t=>{
  const {db,read} = await fixture(t);
  const {createWorkspaceScope}=require('../src/workspace-sessions.cjs');
  const time=new Date(timestamp).toISOString();
  await db('.gemini/antigravity/conversation_summaries.db',`CREATE TABLE conversation_summaries(
    conversation_id TEXT,parent_conversation_id TEXT,workspace_uris TEXT,last_modified_time TEXT);
    INSERT INTO conversation_summaries VALUES
      ('root','','["file:///project"]','${time}'),('child','root','["file:///other"]','${time}'),
      ('nested','child','[]','${time}'),('many','root','["file:///other","file:///project/secondary"]','${time}'),
      ('remote','root','["vscode-remote://server/path"]','${time}'),('inherited','root','[]','${time}'),
      ('otherroot','','["file:///other"]','${time}'),('local','otherroot','["file:///project"]','${time}');`);
  const scope=await createWorkspaceScope(['/project']);
  const detached=await read([root('agy','local')]);
  assert.equal(detached.find(r=>r.key==='agy/otherroot').cwd,'/other');
  assert.deepEqual((await scope.filter(detached)).map(r=>r.key),['agy/local']);
  const rows=await scope.filter(await read([root('agy','root')]));
  assert.deepEqual(new Set(rows.map(r=>r.key)),new Set(['agy/root','agy/many','agy/inherited']));
  assert.equal(rows.find(r=>r.key==='agy/many').cwd,'/project/secondary');
});

test('an indexed child keeps the open requests its hook reported, so a waiting row shows its own request', async t => {
  const {db,homeDir,read} = await fixture(t);
  const sec = timestamp/1000;
  await db('.codex/state_9.sqlite',`CREATE TABLE threads(id TEXT,cwd TEXT,updated_at INTEGER,agent_nickname TEXT,agent_role TEXT);
    CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT,status TEXT);
    INSERT INTO threads VALUES ('helper','/project',${sec},'Ada','reviewer');
    INSERT INTO thread_spawn_edges VALUES ('parent','helper','open');`);
  const refs = ['a'.repeat(64), 'generic'];
  const waiting = root('codex','helper',{isSubagent:true,parentKey:'codex/parent',status:'approval',waitSince:timestamp-5000,pendingRefs:refs});
  const codex = (await read([root('codex','parent'),waiting])).find(r=>r.key==='codex/helper');
  assert.deepEqual([codex.status,codex.title,codex.pendingRefs],['approval','Ada · reviewer',refs]);
  const folder = path.join(homeDir,'.claude','projects','-project','root','subagents');
  await fs.mkdir(folder,{recursive:true});
  const meta = path.join(folder,'agent-asker.meta.json');
  await fs.writeFile(meta,JSON.stringify({agentType:'Explore'}));
  await fs.utimes(meta,new Date(timestamp),new Date(timestamp));
  const asking = root('claude','asker',{key:'claude/root/asker',isSubagent:true,parentKey:'claude/root',canOpen:false,
    status:'input',waitSince:timestamp-3000,pendingRefs:['b'.repeat(64)]});
  const claude = (await read([root('claude','root'),asking],{force:true})).find(r=>r.key==='claude/root/asker');
  assert.deepEqual([claude.status,claude.pendingRefs],['input',['b'.repeat(64)]]);
  const idle = (await read([root('codex','parent'),{...waiting,status:'working',waitSince:undefined,pendingRefs:undefined}],{force:true}))
    .find(r=>r.key==='codex/helper');
  assert.equal(idle.pendingRefs,undefined,'nothing is invented for a child that waits for nothing');
});

test('Antigravity extracts subagent Role from raw_summary wire path 17->8->2 without exposing preview or invalid blobs', async t => {
  const {db,homeDir} = await fixture(t);
  let clock = timestamp;
  const read = createChildReader({homeDir,env:{},now:()=>clock});
  const varint = n => {
    const out = [];
    while (n >= 0x80) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
    out.push(n);
    return Buffer.from(out);
  };
  const fieldBytes = (num, buf) => Buffer.concat([varint((num << 3) | 2), varint(buf.length), buf]);
  const roleBlob = (role, otherPrompt) => Buffer.concat([
    fieldBytes(1, Buffer.from(otherPrompt || 'PRIVATE_PROMPT_SECRET')),
    fieldBytes(17, Buffer.concat([
      fieldBytes(1, Buffer.from('PRIVATE_INNER')),
      fieldBytes(8, Buffer.concat([
        fieldBytes(1, Buffer.from('self')),
        fieldBytes(2, Buffer.from(role)),
      ])),
    ])),
  ]).toString('hex');
  const dt = new Date(timestamp).toISOString();
  await db('.gemini/antigravity/conversation_summaries.db', `CREATE TABLE conversation_summaries(
      conversation_id TEXT, parent_conversation_id TEXT, agent_name TEXT, title TEXT, preview TEXT, raw_summary BLOB, status TEXT, killed INTEGER, last_modified_time TEXT);
    INSERT INTO conversation_summaries VALUES
      ('root','','','Main','PRIVATE_PREVIEW',NULL,'CASCADE_RUN_STATUS_RUNNING',0,'${dt}'),
      ('c1','root','self','','PRIVATE_PREVIEW',X'${roleBlob('Claude Provider Auditor')}','CASCADE_RUN_STATUS_RUNNING',0,'${dt}'),
      ('c2','root','self','Fallback Title','PRIVATE_PREVIEW',X'deadbeef','CASCADE_RUN_STATUS_RUNNING',0,'${dt}'),
      ('c3','root','self','','PRIVATE_PREVIEW',NULL,'CASCADE_RUN_STATUS_RUNNING',0,'${dt}');`);
  const hooked = root('agy', 'c1', { isSubagent: true, parentKey: 'agy/root', status: 'working', title: 'self' });
  const rows = await read([root('agy', 'root'), hooked]);
  assert.equal(rows.find(r => r.sessionId === 'c1').title, 'Claude Provider Auditor');
  assert.equal(rows.find(r => r.sessionId === 'c2').title, 'Fallback Title');
  assert.equal(rows.find(r => r.sessionId === 'c3').title, 'self');
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE/);
  // When c3's raw_summary lands later, an active generic-role child refreshes past the 2s cooldown.
  await db('.gemini/antigravity/conversation_summaries.db',
    `UPDATE conversation_summaries SET raw_summary=X'${roleBlob('Codex Provider Auditor')}' WHERE conversation_id='c3';`);
  clock += 3000;
  const updated = await read([root('agy', 'root'), root('agy', 'c3', { isSubagent: true, parentKey: 'agy/root', status: 'working', title: 'self' })]);
  assert.equal(updated.find(r => r.sessionId === 'c3').title, 'Codex Provider Auditor');
});

test('Codex subagent agent_path names the task and suppresses generic default role', async t => {
  const {db,read} = await fixture(t);
  const sec = timestamp / 1000;
  await db('.codex/state_9.sqlite', `CREATE TABLE threads(id TEXT,cwd TEXT,updated_at INTEGER,agent_nickname TEXT,agent_role TEXT,agent_path TEXT);
    CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT,status TEXT);
    INSERT INTO threads VALUES
      ('c1','/project',${sec},'Ada','default','/root/audit_hooks'),
      ('c2','/project',${sec},NULL,'default','/root/parent/verify_ui'),
      ('c3','/project',${sec},NULL,'default',NULL);
    INSERT INTO thread_spawn_edges VALUES ('root','c1','open'),('root','c2','open'),('root','c3','open');`);
  const rows = await read([root('codex', 'root')]);
  assert.equal(rows.find(r => r.sessionId === 'c1').title, 'audit_hooks · Ada');
  assert.equal(rows.find(r => r.sessionId === 'c2').title, 'parent/verify_ui');
  assert.doesNotMatch(rows.find(r => r.sessionId === 'c3').title, /\bdefault\b/i);
});

test('Antigravity preserves 50+ subagents even when combined raw_summary blobs far exceed 1MiB maxBuffer', async t => {
  const { db, read } = await fixture(t);
  const varint = n => {
    const out = [];
    while (n >= 0x80) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
    out.push(n);
    return Buffer.from(out);
  };
  const fieldBytes = (num, buf) => Buffer.concat([varint((num << 3) | 2), varint(buf.length), buf]);
  const bigRoleBlob = (role, padSize) => Buffer.concat([
    fieldBytes(1, Buffer.alloc(padSize, 0x41)),
    fieldBytes(17, fieldBytes(8, fieldBytes(2, Buffer.from(role)))),
  ]).toString('hex');
  const dt = new Date(timestamp).toISOString();
  // 50 children * 28KB raw_summary = 1.4MB raw = 2.8MB hex (nearly 3x 1MiB maxBuffer).
  const values = [`('root','','','Main',NULL,'CASCADE_RUN_STATUS_RUNNING',0,'${dt}')`];
  for (let i = 0; i < 50; i++) {
    values.push(`('sub-${i}','root','self','',X'${bigRoleBlob('Worker ' + i, 28000)}','CASCADE_RUN_STATUS_RUNNING',0,'${dt}')`);
  }
  await db('.gemini/antigravity/conversation_summaries.db', `CREATE TABLE conversation_summaries(
      conversation_id TEXT, parent_conversation_id TEXT, agent_name TEXT, title TEXT, raw_summary BLOB, status TEXT, killed INTEGER, last_modified_time TEXT);
    INSERT INTO conversation_summaries VALUES ${values.join(',')};`);
  const rows = await read([root('agy', 'root')]);
  assert.equal(rows.length, 51);
  assert.equal(rows.find(r => r.sessionId === 'sub-0').title, 'Worker 0');
  assert.equal(rows.find(r => r.sessionId === 'sub-49').title, 'Worker 49');

  // Even a single batch of 8 with 96KB blobs each (1.5MB hex > 1MiB) falls back cleanly and keeps every role.
  const huge = [`('root2','','','Main 2',NULL,'CASCADE_RUN_STATUS_RUNNING',0,'${dt}')`];
  for (let i = 0; i < 8; i++) {
    huge.push(`('big-${i}','root2','self','',X'${bigRoleBlob('Heavy ' + i, 96000)}','CASCADE_RUN_STATUS_RUNNING',0,'${dt}')`);
  }
  await db('.gemini/antigravity/conversation_summaries.db', `INSERT INTO conversation_summaries VALUES ${huge.join(',')};`);
  const bigRows = await read([root('agy', 'root2')], { force: true });
  assert.equal(bigRows.length, 9);
  assert.equal(bigRows.find(r => r.sessionId === 'big-7').title, 'Heavy 7');
});

test('Claude child index resolves linked git worktrees via main checkout slug before scanning unrelated folders', async t => {
  const { homeDir, read } = await fixture(t);
  const main = path.join(homeDir, 'main-repo');
  const linked = path.join(homeDir, 'linked-wt');
  const admin = path.join(main, '.git', 'worktrees', 'linked');
  await Promise.all([fs.mkdir(admin, { recursive: true }), fs.mkdir(linked, { recursive: true })]);
  await fs.writeFile(path.join(linked, '.git'), 'gitdir: ' + admin + '\n');
  await fs.writeFile(path.join(admin, 'gitdir'), path.join(linked, '.git') + '\n');
  const mainSlug = main.replace(/[^A-Za-z0-9-]/g, '-');
  const subDir = path.join(homeDir, '.claude', 'projects', mainSlug, 'wt-parent', 'subagents');
  await fs.mkdir(subDir, { recursive: true });
  const meta = path.join(subDir, 'agent-wtchild.meta.json');
  await fs.writeFile(meta, JSON.stringify({ agentType: 'Worktree Worker' }));
  await fs.utimes(meta, new Date(timestamp), new Date(timestamp));
  const rows = await read([root('claude', 'wt-parent', { cwd: linked })]);
  assert.equal(rows.find(r => r.sessionId === 'wtchild')?.title, 'Worktree Worker');
});

test('Claude skips internal sidecars, keys cache by root/id and refreshes missing child model; Codex falls back to title; AGY honors killed and maps replyAt to completedAt', async t => {
  const { homeDir, db } = await fixture(t);
  let clock = timestamp;
  const read = createChildReader({ homeDir, env: {}, now: () => clock });

  // 1. Claude skips acompact/aprompt_suggestion, avoids root/id collision, and refreshes past 2s when active child lacks model.
  const subA = path.join(homeDir, '.claude', 'projects', '-project', 'rootA', 'subagents');
  const subB = path.join(homeDir, '.claude', 'projects', '-project', 'rootB', 'subagents');
  await Promise.all([fs.mkdir(subA, { recursive: true }), fs.mkdir(subB, { recursive: true })]);
  const writeTimed = async (dir, name, content) => {
    const f = path.join(dir, name);
    await fs.writeFile(f, content);
    await fs.utimes(f, new Date(clock), new Date(clock));
  };
  await Promise.all([
    writeTimed(subA, 'agent-acompact-123.jsonl', '{}'),
    writeTimed(subA, 'agent-aprompt_suggestion-abc.meta.json', JSON.stringify({ agentType: 'Internal' })),
    writeTimed(subA, 'agent-shared.meta.json', JSON.stringify({ agentType: 'WorkerA', model: 'claude-sonnet-4-6' })),
    writeTimed(subB, 'agent-shared.meta.json', JSON.stringify({ agentType: 'WorkerB' })),
  ]);
  const activeB = root('claude', 'shared', { key: 'claude/rootB/shared', isSubagent: true, parentKey: 'claude/rootB', status: 'working' });
  const firstPass = await read([root('claude', 'rootA'), root('claude', 'rootB'), activeB]);
  assert.ok(!firstPass.some(r => /acompact|aprompt_suggestion/i.test(r.sessionId)));
  assert.equal(firstPass.find(r => r.key === 'claude/rootA/shared').nativeExecution?.model, 'claude-sonnet-4-6');
  assert.equal(firstPass.find(r => r.key === 'claude/rootB/shared').nativeExecution, undefined);
  // Response JSONL lands for rootB/shared after 3s -> cache refreshes because rootB/shared is active without a model.
  clock += 3000;
  await writeTimed(subB, 'agent-shared.jsonl', JSON.stringify({
    type: 'assistant', sessionId: 'rootB', agentId: 'shared', isSidechain: true,
    timestamp: new Date(clock).toISOString(), message: { role: 'assistant', model: 'claude-haiku-4-5', content: 'ok' },
  }) + '\n');
  const secondPass = await read([root('claude', 'rootA'), root('claude', 'rootB'), activeB]);
  assert.equal(secondPass.find(r => r.key === 'claude/rootB/shared').nativeExecution?.model, 'claude-haiku-4-5');

  // 2. Codex falls back to name/title (stripped via codexTitle) when agent_path, nickname and meaningful role are empty.
  const sec = Math.floor(clock / 1000);
  await db('.codex/state_9.sqlite', `CREATE TABLE threads(id TEXT,cwd TEXT,updated_at INTEGER,agent_nickname TEXT,agent_role TEXT,agent_path TEXT,name TEXT,title TEXT);
    CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT,status TEXT);
    INSERT INTO threads VALUES
      ('cx-titled','/project',${sec},NULL,'default',NULL,NULL,'Inspect auth middleware'),
      ('cx-named','/project',${sec},NULL,'default',NULL,'Named Worker','ignored'),
      ('cx-boot','/project',${sec},NULL,'default',NULL,NULL,'# AGENTS.md instructions for /project');
    INSERT INTO thread_spawn_edges VALUES ('cx-root','cx-titled','open'),('cx-root','cx-named','open'),('cx-root','cx-boot','open');`);
  const cxRows = await read([root('codex', 'cx-root')], { force: true });
  assert.equal(cxRows.find(r => r.sessionId === 'cx-titled').title, 'Inspect auth middleware');
  assert.equal(cxRows.find(r => r.sessionId === 'cx-named').title, 'Named Worker');
  assert.match(cxRows.find(r => r.sessionId === 'cx-boot').title, /^서브에이전트 · /);

  // 3. AGY killed child stays idle even if hook snapshot stuck on working, and replyAt maps to completedAt on subagents.
  const dt = new Date(clock).toISOString();
  await db('.gemini/antigravity/conversation_summaries.db', `CREATE TABLE conversation_summaries(
      conversation_id TEXT, parent_conversation_id TEXT, agent_name TEXT, status TEXT, killed INTEGER, last_modified_time TEXT);
    INSERT INTO conversation_summaries VALUES
      ('ag-root','','','CASCADE_RUN_STATUS_RUNNING',0,'${dt}'),
      ('ag-killed','ag-root','Worker','CASCADE_RUN_STATUS_IDLE',1,'${dt}'),
      ('ag-done','ag-root','Auditor','CASCADE_RUN_STATUS_IDLE',0,'${dt}');`);
  const stuckHook = root('agy', 'ag-killed', { status: 'working' });
  const doneHook = root('agy', 'ag-done', { status: 'done', replyAt: clock - 1000 });
  const agRows = await read([root('agy', 'ag-root'), stuckHook, doneHook], { force: true });
  assert.equal(agRows.find(r => r.sessionId === 'ag-killed').status, 'idle');
  const agDone = agRows.find(r => r.sessionId === 'ag-done');
  assert.equal(agDone.isSubagent, true);
  assert.equal(agDone.completedAt, clock - 1000);
  assert.equal(agDone.replyAt, undefined);
});
