'use strict';
require('../media/i18n.js').setLocale('ko'); // These cases check the Korean text; i18n.test.cjs covers English.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createMetadataReader } = require('../src/metadata.cjs');

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "metadata-'"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  async function file(relative, data) {
    const full = path.join(home, relative);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, typeof data === 'string' ? data : JSON.stringify(data));
  }
  async function db(relative, sql) {
    const full = path.join(home, relative);
    await fs.mkdir(path.dirname(full), { recursive: true });
    execFileSync('/usr/bin/sqlite3', ['-batch', full, sql]);
  }
  return { home, file, db, read: createMetadataReader({ homeDir: home, env: {}, cacheMs: 20000 }) };
}
const row = (provider, sessionId, cwd = '/test/repo') => ({ provider, sessionId, cwd, key: provider + '/' + sessionId });

test('Codex uses explicit thread names, handles older schema, and sums only observed session token counts', async t => {
  const { read, db, file } = await fixture(t);
  await db('.codex/state_5.sqlite', "CREATE TABLE threads(id,title,name,tokens_used,preview); INSERT INTO threads VALUES('a','fallback','A',1625,'SENSITIVE'),('b','fallback',NULL,0,'SENSITIVE'),('other','SENSITIVE',NULL,99999,'SENSITIVE');");
  await db('.codex/state_4.sqlite', "CREATE TABLE threads(id,title); INSERT INTO threads VALUES('a','older');");
  await file('.codex/session_index.jsonl', '{"id":"a","thread_name":"stale"}\n{"id":"b","thread_name":"처음"}\n{"id":"b","thread_name":"변경"}\n{"id":"ghost","thread_name":"SENSITIVE"}\n{partial');
  const got = await read([row('codex','a'),row('codex','b'),row('codex',"a' OR 1=1")]);
  assert.deepEqual(got.sessions.get('codex/a'), { title: 'A', usage:'누적 1,625 토큰' });
  assert.deepEqual(got.sessions.get('codex/b'), { title: '변경', usage:'누적 0 토큰' });
  assert.equal(got.sessions.size, 2);
  assert.equal(got.providerUsage.codex, '2개 세션 · 1,625 토큰 누적');
});

test('Claude project index and live name join by session ID, preserve remembered title, include dated stats', async t => {
  const { read, file, home } = await fixture(t);
  await file('.claude/projects/-test-repo/sessions-index.json', { entries: [
    {sessionId:'a', firstPrompt:'SENSITIVE', summary:'간단 요약', messageCount:7},
    {sessionId:'b', firstPrompt:'SENSITIVE', summary:'요약', customTitle:'검토', messageCount:0},
    {sessionId:'c', firstPrompt:'SENSITIVE'}
  ] });
  await file('.claude/sessions/123.json', {sessionId:'a', name:'실시간\n제목', cwd:'/test/repo' });
  await file('.claude/sessions/234.json', {sessionId:'d', name:'곧 종료' });
  await file('.claude/sessions/567.json', {sessionId:'other', name:'SENSITIVE', nested:{messages:'SENSITIVE'} });
  await file('.claude/sessions/890.json', '{bad');
  await file('.claude/stats-cache.json', {lastComputedDate:'2026-08-30',totalMessages:1234});
  const rows = ['a','b','c','d'].map(id => row('claude',id));
  const found = await read(rows);
  assert.deepEqual(found.sessions.get('claude/a'), { title:'실시간 제목', usage:'메시지 7개' });
  assert.deepEqual(found.sessions.get('claude/b'), { title:'검토', usage:'메시지 0개' });
  assert.deepEqual(found.sessions.get('claude/d'), { title:'곧 종료' });
  assert.equal(found.sessions.has('claude/c'),false);
  assert.equal(found.sessions.has('claude/other'),false);
  assert.equal(found.providerUsage.claude,'2026-08-30 기준 · 누적 메시지 1,234개');
  await fs.unlink(path.join(home,'.claude/sessions/234.json'));
  assert.equal((await read(rows, {force:true})).sessions.get('claude/d').title,'곧 종료');
});

test('AGY looks up summaries across surfaces and labels steps as activity, with no double counting', async t => {
  const { read, db } = await fixture(t);
  const schema = 'CREATE TABLE conversation_summaries(conversation_id,title,step_count,preview,raw_summary);';
  await db('.gemini/antigravity/conversation_summaries.db',schema + "INSERT INTO conversation_summaries VALUES('a','첫 제목',12,'SENSITIVE','SENSITIVE');");
  await db('.gemini/antigravity-cli/conversation_summaries.db',schema + "INSERT INTO conversation_summaries VALUES('a','이전',500,'SENSITIVE','SENSITIVE'),('b','CLI 제목',4,'SENSITIVE','SENSITIVE');");
  const got = await read([row('agy','a'),row('agy','b'),row('agy','oops')]);
  assert.deepEqual(got.sessions.get('agy/a'),{title:'첫 제목',usage:'대화 12단계'});
  assert.deepEqual(got.sessions.get('agy/b'),{title:'CLI 제목',usage:'대화 4단계'});
  assert.equal(got.providerUsage.agy,'2개 세션 · 16단계 진행');
});

test('missing DBs and malformed indexes preserve availability of the monitor', async t => {
  const { read, file } = await fixture(t);
  await file('.codex/state_5.sqlite','not a database');
  await file('.codex/session_index.jsonl','{"id":"a","thread_name":"대화"}\nnot json');
  await file('.claude/stats-cache.json','{');
  const rows = [row('codex','a'),row('claude','b'),row('agy','c')];
  const result = await read(rows);
  assert.deepEqual(result.sessions.get('codex/a'),{title:'대화'});
  assert.deepEqual(result.providerUsage,{});
  assert.equal(result,await read(rows));
});

test('old Codex schemas expose titles without assuming a measured token count', async t => {
  const { read, db } = await fixture(t);
  await db('.codex/state_4.sqlite', "CREATE TABLE threads(id,title); INSERT INTO threads VALUES('a','이전 대화');");
  const result = await read([row('codex','a')]);
  assert.deepEqual(result.sessions.get('codex/a'), { title:'이전 대화' });
  assert.equal(result.providerUsage.codex,undefined);
});

test('Codex projects only the requested thread’s explicit model and reasoning effort, including partial settings', async t => {
  const {read,db} = await fixture(t);
  await db('.codex/state_9.sqlite',`CREATE TABLE threads(id,title,model,reasoning_effort);
    INSERT INTO threads VALUES ('one','', 'gpt-5.4','medium'),('two','','gpt-5.3-codex',NULL),
      ('three','','inherit','high'),('bad','','model\nprivate','invalid'),('number','',42,NULL),
      ('foreign','','other','high');`);
  const result = await read(['one','two','three','bad','number'].map(id => row('codex',id)));
  assert.deepEqual(result.sessions.get('codex/one'),{execution:{model:'gpt-5.4',modelSource:'setting',effort:'medium',effortSource:'setting'}});
  assert.deepEqual(result.sessions.get('codex/two'),{execution:{model:'gpt-5.3-codex',modelSource:'setting'}});
  assert.deepEqual(result.sessions.get('codex/three'),{execution:{effort:'high',effortSource:'setting'}});
  assert.equal(result.sessions.size,3);
});

test('Claude links an observed response model to its own root session without overriding live titles or leaking content', async t => {
  const {read,file} = await fixture(t);
  const id = 'abab2222-3333-4444-abcd-555566667777';
  const other = 'ffff2222-3333-4444-abcd-555566667777';
  const stamp = '2026-11-20T00:00:10.000Z';
  const response = (model,fields={}) => ({type:'assistant',sessionId:id,timestamp:stamp,
    message:{role:'assistant',model,content:'private words',effort:'max'},...fields});
  const records = [
    {type:'custom-title',sessionId:id,customTitle:'오래된 제목'}, response('claude-haiku-4-5'),
    response('claude-sonnet-4-6'), response('private-foreign',{sessionId:other}),
    response('private-sidechain',{isSidechain:true,agentId:'child'}), response('private-child',{agentId:'child'}),
    response('private-meta',{isMeta:true}), response('private-fake',{type:'user'}), response('<synthetic>'),
  ];
  await file('.claude/projects/-test-repo/'+id+'.jsonl',records.map(x => JSON.stringify(x)).join('\n'));
  await file('.claude/sessions/12.json',{sessionId:id,name:'현재 제목'});
  const native = (await read([row('claude',id)])).sessions.get('claude/'+id);
  assert.deepEqual(native,{title:'현재 제목',execution:{model:'claude-sonnet-4-6',modelSource:'response',modelAt:Date.parse(stamp)}});
});

test('recent discovery is workspace scoped, time bounded and capped independently per provider', async t => {
  const { createRecentReader } = require('../src/metadata.cjs');
  const { home, db, file } = await fixture(t);
  const now = Date.UTC(2026,10,24,12);
  const sec = now / 1000;
  const iso = new Date(now-1000).toISOString();
  await db('.codex/state_5.sqlite', `
    CREATE TABLE threads(id,cwd,title,name,updated_at,updated_at_ms,archived,source,thread_source,agent_path);
    INSERT INTO threads VALUES
      ('a','/test/repo','fallback','최근 제목',${sec},null,0,'vscode','user',null),
      ('b','/test/repo/sub','하위 폴더',null,${sec-2},null,0,'cli',null,null),
      ('c','/test/repo','셋',null,${sec-3},null,0,'vscode','user',null),
      ('d','/test/repo','넷',null,${sec-4},null,0,'vscode','user',null),
      ('e','/test/repo','오래된 다섯째',null,${sec-5},null,0,'vscode','user',null),
      ('sub','/test/repo','s',null,${sec},null,0,'vscode','user','child'),
      ('automation','/test/repo','s',null,${sec},null,0,'vscode','security_scan',null),
      ('exec','/test/repo','s',null,${sec},null,0,'exec',null,null),
      ('archived','/test/repo','s',null,${sec},null,1,'cli',null,null),
      ('different','/test/repo-other','s',null,${sec},null,0,'cli',null,null),
      ('unrelated','/test/other','s',null,${sec},null,0,'cli',null,null),
      ('old','/test/repo','s',null,${sec-86400*10},null,0,'cli',null,null);`);
  await db('.gemini/antigravity/conversation_summaries.db',`
    CREATE TABLE conversation_summaries(conversation_id,title,workspace_uris,last_modified_time,nesting_depth,parent_conversation_id);
    INSERT INTO conversation_summaries VALUES
      ('x','AGY 1','["file:///test/other","file:///test/repo/sub"]','${iso}',0,''),
      ('p','하위','["file:///test/repo"]','${iso}',1,'x'),
      ('n','잘못된 URI','not JSON','${iso}',0,''),
      ('z','다른 폴더','["file:///test/repo-other"]','${iso}',0,'');`);
  await file('.claude/projects/-test-repo/sessions-index.json',{originalPath:'/test/repo',entries:[
    {sessionId:'cat',projectPath:'/test/repo',modified:iso,summary:'Claude'},
    {sessionId:'hidden',projectPath:'/test/repo',modified:iso,summary:'s',isSidechain:true},
    {sessionId:'unsafe',projectPath:'/test/repo-other',modified:iso,firstPrompt:'unrelated'}
  ]});
  await file('.claude/sessions/12.json',{sessionId:'live',cwd:'/test/repo',name:'실시간',updatedAt:now,kind:'interactive'});
  await file('.claude/sessions/15.json',{sessionId:'auto',cwd:'/test/repo',name:'자동화',updatedAt:now,kind:'sdk'});
  const read = createRecentReader({homeDir:home,env:{},now:()=>now});
  assert.deepEqual(await read([]),[]);
  const rows = await read(['/test/repo']);
  assert.deepEqual(rows.filter(r=>r.provider==='codex').map(r=>r.sessionId),['a','b','c','d']);
  assert.deepEqual(rows.filter(r=>r.provider==='claude').map(r=>r.sessionId),['live','cat']);
  assert.deepEqual(rows.filter(r=>r.provider==='agy').map(r=>r.sessionId),['x']);
  assert.equal(rows.find(r=>r.sessionId==='x').cwd,'/test/repo/sub');
  assert.equal(rows.find(r=>r.sessionId==='a').title,'최근 제목');
  assert.ok(rows.every(r=>r.status==='recent' && r.key===r.provider+'/'+r.sessionId));
  assert.equal(await read(['/test/repo']),rows);
});

test('Codex prefers native rename metadata and suppresses bootstrap titles in both detail and discovery', async t => {
  const { createRecentReader } = require('../src/metadata.cjs');
  const { read, home, db, file } = await fixture(t);
  const time = Math.floor(Date.now()/1000);
  await db('.codex/state_5.sqlite', `CREATE TABLE threads(id,cwd,title,updated_at);
    INSERT INTO threads VALUES ('raw','/project','# AGENTS.md instructions for /project',${time}),
      ('good','/project','<environment_context>...',${time}),('real','/project','AGENTS.md 업데이트',${time});`);
  await file('.codex/session_index.jsonl', '{"id":"good","thread_name":"원래 제목"}');
  const records = await createRecentReader({homeDir:home,env:{}})(['/project']);
  assert.equal(records.find(r=>r.sessionId==='raw').title, undefined);
  const details = await read(records);
  assert.equal(details.sessions.has('codex/raw'),false);
  assert.equal(details.sessions.get('codex/good').title,'원래 제목');
  assert.equal(details.sessions.get('codex/real').title,'AGENTS.md 업데이트');
});

test('bounded Claude fallback only exposes native title, resolves worktree ID and omits first message', async t => {
  const { read, home, file } = await fixture(t);
  const id = 'babc3200-1234-42ad-a132-445566778899';
  const privateId = '11112222-3333-4444-abcd-555566667777';
  const lines = (id, title) => [
    JSON.stringify({type:'user',sessionId:id,cwd:'/test/repo',message:{content:'PRIVATE first message'}}),
    JSON.stringify({type:'assistant',sessionId:id,message:{content:'S'.repeat(90000)}}),
    ...(title ? [JSON.stringify({type:'ai-title',sessionId:id,aiTitle:'자동'}),
      JSON.stringify({type:'custom-title',sessionId:id,customTitle:title})] : []),
  ].join('\n')+'\n';
  await file('.claude/projects/-different-main/'+id+'.jsonl',lines(id,'검토 제목'));
  await file('.claude/projects/-test-repo/'+privateId+'.jsonl',lines(privateId));
  const details = await read([row('claude',id),row('claude',privateId)]);
  assert.equal(details.sessions.get('claude/'+id).title,'검토 제목');
  assert.equal(details.sessions.has('claude/'+privateId),false);
  const history = await require('../src/metadata.cjs').createRecentReader({homeDir:home,env:{}})(['/test/repo']);
  assert.equal(history.find(item=>item.sessionId===privateId)?.status,'recent');
  assert.equal(history.find(item=>item.sessionId===privateId)?.title,undefined);
});

test('checkpointed Antigravity WAL database is read without creating write sidecars', async t => {
  const { read, home, db } = await fixture(t);
  const file = '.gemini/antigravity/conversation_summaries.db';
  await db(file,"PRAGMA journal_mode=WAL; CREATE TABLE conversation_summaries(conversation_id,title,step_count); INSERT INTO conversation_summaries VALUES('a','로컬 제목',4); PRAGMA wal_checkpoint(TRUNCATE);");
  for (const suffix of ['-shm','-wal']) await fs.rm(path.join(home,file)+suffix,{force:true});
  assert.equal((await read([row('agy','a')])).sessions.get('agy/a').title,'로컬 제목');
  for (const suffix of ['-shm','-wal'])
    await assert.rejects(fs.access(path.join(home,file)+suffix),{code:'ENOENT'});
});

test('Claude finds nested folder histories by verified cwd and leaves slug-prefix siblings and symlink targets out', async t => {
  const {createRecentReader} = require('../src/metadata.cjs');
  const {home,file} = await fixture(t);
  const root = path.join(home,'repo'), nested = path.join(root,'packages','ui-kit'), sibling = root+'-sibling';
  const linked = path.join(root,'outside');
  await fs.mkdir(nested,{recursive:true});
  await fs.mkdir(sibling);
  await fs.symlink(sibling,linked);
  const slug = folder => folder.replace(/[^A-Za-z0-9-]/g,'-');
  const relative = folder => '.claude/projects/'+slug(folder)+'/';
  const uuid = n => '88882222-3333-4444-abcd-'+String(n).padStart(12,'0');
  const caption = (id,cwd) => JSON.stringify({type:'user',sessionId:id,cwd,message:{content:'private'}})+'\n';
  await file(relative(nested)+uuid(1)+'.jsonl',caption(uuid(1),nested));
  // These out-of-tree files claim an in-scope cwd. They must never qualify merely by a slug prefix.
  await file(relative(sibling)+uuid(2)+'.jsonl',caption(uuid(2),root));
  await file(relative(linked)+uuid(3)+'.jsonl',caption(uuid(3),root));
  const removed = path.join(root,'former-subdirectory');
  await file(relative(removed)+'sessions-index.json',{originalPath:removed,entries:[
    {sessionId:'indexed',modified:new Date().toISOString(),customTitle:'제목'},
    {sessionId:'foreign',projectPath:sibling,modified:new Date().toISOString(),customTitle:'outside'},
  ]});
  const rows = await createRecentReader({homeDir:home,env:{}})([root]);
  assert.deepEqual(rows.map(r=>r.sessionId).sort(),[uuid(1),'indexed'].sort());
  assert.equal(rows.find(r=>r.sessionId===uuid(1)).cwd,nested);
  assert.equal(rows.find(r=>r.sessionId==='indexed').cwd,removed);
});

test('only a reciprocally registered Git worktree discovers recent Claude records in its main checkout slug', async t => {
  const {createRecentReader} = require('../src/metadata.cjs');
  const {home,file} = await fixture(t);
  const root = path.join(home,'linked'), main = path.join(home,'main');
  const admin = path.join(main,'.git/worktrees/linked'), marker = path.join(root,'.git');
  await fs.mkdir(path.join(root,'src'),{recursive:true});
  await file('linked/.git','gitdir: '+admin+'\n');
  await file('main/.git/worktrees/linked/gitdir',marker+'\n');
  const slug = main.replace(/[^A-Za-z0-9-]/g,'-');
  const relative = '.claude/projects/'+slug+'/';
  const id = 'bbbb2222-3333-4444-abcd-555566667777';
  const outside = 'cccc2222-3333-4444-abcd-555566667777';
  const caption = (id,cwd) => JSON.stringify({type:'user',sessionId:id,cwd,message:{content:'private'}})+'\n';
  await file(relative+id+'.jsonl',caption(id,path.join(root,'src','pkg')));
  await file(relative+outside+'.jsonl',caption(outside,main));
  await file(relative+'sessions-index.json',{originalPath:main,entries:[
    {sessionId:'inside',projectPath:path.join(root,'src'),modified:new Date().toISOString(),customTitle:'색인'},
    {sessionId:'outside',modified:new Date().toISOString(),customTitle:'main'},
  ]});
  const read = createRecentReader({homeDir:home,env:{}});
  const list = await read([path.join(root,'src')]);
  assert.deepEqual(list.map(r=>r.sessionId).sort(),[id,'inside'].sort());
  await file('main/.git/worktrees/linked/gitdir',path.join(home,'different/.git')+'\n');
  assert.deepEqual(await read([root],{force:true}),[]);
});

test('Claude ignores blank standby PID tabs, suppresses derived slugs, scans mid-file titles, and invalidates metadata on edits', async t => {
  const { createRecentReader } = require('../src/metadata.cjs');
  const { read, home, file, db } = await fixture(t);
  const now = Date.UTC(2026, 10, 24, 12);
  const blankUuid = 'aaaaaaaa-1111-4222-8333-444444444444';
  const realUuid = 'bbbbbbbb-1111-4222-8333-444444444444';
  // Blank standby tab: idle + derived slug + no transcript file.
  await file('.claude/sessions/1001.json', { sessionId: blankUuid, cwd: '/test/repo', status: 'idle', kind: 'interactive', name: 'repo-ab', nameSource: 'derived', updatedAt: now });
  // Active real tab: derived slug in PID file, real ai-title buried in the middle of a large JSONL file (>256KB).
  await file('.claude/sessions/1002.json', { sessionId: realUuid, cwd: '/test/repo', status: 'idle', kind: 'interactive', name: 'repo-cd', nameSource: 'derived', updatedAt: now });
  const pad = JSON.stringify({ type: 'assistant', sessionId: realUuid, message: { role: 'assistant', content: 'P'.repeat(160000) } });
  const jsonl = [
    JSON.stringify({ type: 'user', sessionId: realUuid, cwd: '/test/repo', message: { content: 'Fix hooks' } }),
    pad,
    JSON.stringify({ type: 'ai-title', sessionId: realUuid, aiTitle: '중간 AI 제목' }),
    pad,
  ].join('\n') + '\n';
  const jsonlRel = '.claude/projects/-test-repo/' + realUuid + '.jsonl';
  await file(jsonlRel, jsonl);
  await file('.claude/projects/-test-repo/sessions-index.json', { originalPath: '/test/repo', entries: [
    { sessionId: 'empty-idx', projectPath: '/test/repo', modified: new Date(now).toISOString(), summary: '빈 세션', messageCount: 0 },
  ] });
  const recent = await createRecentReader({ homeDir: home, env: {}, now: () => now })(['/test/repo']);
  assert.deepEqual(recent.map(r => r.sessionId), [realUuid]);
  assert.equal(recent[0].title, '중간 AI 제목');
  let clock = Date.now();
  const timed = createMetadataReader({ homeDir: home, env: {}, cacheMs: 20000, now: () => clock });
  const first = await timed([row('claude', realUuid)]);
  assert.equal(first.sessions.get('claude/' + realUuid).title, '중간 AI 제목');
  // Appending a custom-title invalidates metadata without force:true once the short burst-reuse window passes.
  await fs.appendFile(path.join(home, jsonlRel), JSON.stringify({ type: 'custom-title', sessionId: realUuid, customTitle: '새 커스텀 제목' }) + '\n');
  assert.equal(await timed([row('claude', realUuid)]), first, 'a scan in the same burst reuses the answer');
  clock += 1600;
  const second = await timed([row('claude', realUuid)]);
  assert.equal(second.sessions.get('claude/' + realUuid).title, '새 커스텀 제목');
  // Updating AGY DB title also busts the metadata cache.
  const agyDb = '.gemini/antigravity/conversation_summaries.db';
  await db(agyDb, "CREATE TABLE conversation_summaries(conversation_id,title,step_count); INSERT INTO conversation_summaries VALUES('ag1','초기 제목',2);");
  assert.equal((await timed([row('agy', 'ag1')])).sessions.get('agy/ag1').title, '초기 제목', 'other rows are read at once');
  await db(agyDb, "UPDATE conversation_summaries SET title='변경된 제목' WHERE conversation_id='ag1';");
  clock += 1600;
  assert.equal((await timed([row('agy', 'ag1')])).sessions.get('agy/ag1').title, '변경된 제목');
});

test('Codex filters empty-preview threads, strips IDE setup preamble, and prefers newer session_index renames', async t => {
  const { createRecentReader } = require('../src/metadata.cjs');
  const { read, home, db, file } = await fixture(t);
  const now = Date.UTC(2026, 10, 24, 12);
  const sec = now / 1000;
  const ideTitle = '# Context from my IDE setup:\n## Active file: a.ts\n## My request for Codex:\n버그 고쳐줘';
  await db('.codex/state_5.sqlite', `CREATE TABLE threads(id,cwd,title,name,preview,updated_at,has_user_event);
    INSERT INTO threads VALUES
      ('empty','/project','','','',${sec},0),
      ('ide','/project','${ideTitle}',NULL,'${ideTitle}',${sec - 1},0),
      ('renamed','/project','fallback','이전 이름','hello',${sec - 2},0);`);
  await file('.codex/session_index.jsonl', JSON.stringify({ id: 'renamed', thread_name: '최신 이름', updated_at: new Date(now + 5000).toISOString() }) + '\n');
  const recent = await createRecentReader({ homeDir: home, env: {}, now: () => now })(['/project']);
  assert.deepEqual(recent.map(r => r.sessionId), ['ide', 'renamed']);
  assert.equal(recent.find(r => r.sessionId === 'ide').title, '버그 고쳐줘');
  const meta = await read([row('codex', 'ide'), row('codex', 'renamed')]);
  assert.equal(meta.sessions.get('codex/ide').title, '버그 고쳐줘');
  assert.equal(meta.sessions.get('codex/renamed').title, '최신 이름');
});

test('Claude transcript records numeric interruptedAt for user-rejected tool calls without leaking text', async t => {
  const { read, file } = await fixture(t);
  const id = '12345678-1111-4222-8333-444455556666';
  const t1 = '2026-11-24T12:00:00.000Z';
  const t2 = '2026-11-24T12:05:00.000Z';
  await file('.claude/projects/-test-repo/' + id + '.jsonl', [
    JSON.stringify({ type: 'user', sessionId: id, cwd: '/test/repo', timestamp: t1,
      message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use] SECRET_TEXT' }] } }),
    JSON.stringify({ type: 'user', sessionId: id, cwd: '/test/repo', timestamp: t2,
      message: { role: 'user', content: [{ type: 'tool_result', content: "The user doesn't want to proceed with this tool use. SECRET_TOOL" }] } }),
  ].join('\n') + '\n');
  const meta = await read([row('claude', id)]);
  const entry = meta.sessions.get('claude/' + id);
  assert.equal(entry.interruptedAt, Date.parse(t2));
  assert.doesNotMatch(JSON.stringify(entry), /SECRET|interrupted by user|proceed/);
});

test('metadata reader avoids re-querying unchanged fingerprints up to safety TTL and resolves git worktrees via mainCheckout', async t => {
  const { home, file, db } = await fixture(t);
  let clock = Date.UTC(2026, 10, 24, 12);
  const read = createMetadataReader({ homeDir: home, env: {}, cacheMs: 12000, now: () => clock });
  await db('.gemini/antigravity/conversation_summaries.db',
    "CREATE TABLE conversation_summaries(conversation_id,title,step_count); INSERT INTO conversation_summaries VALUES('a','Title 1',2);");
  const rows = [row('agy', 'a')];
  const first = await read(rows);
  assert.equal(first.sessions.get('agy/a').title, 'Title 1');
  // 60s later (> 12s cacheMs, < 5m safety TTL) with unchanged DB fingerprint: returns exact cached reference.
  clock += 60000;
  const second = await read(rows);
  assert.equal(second, first);
  // Past 5m safety TTL: refreshes.
  clock += 5 * 60000;
  const third = await read(rows);
  assert.notEqual(third, first);

  // Linked worktree resolves caption directly via main checkout slug.
  const main = path.join(home, 'main-repo');
  const linked = path.join(home, 'linked-wt');
  const admin = path.join(main, '.git', 'worktrees', 'linked');
  await Promise.all([fs.mkdir(admin, { recursive: true }), fs.mkdir(linked, { recursive: true })]);
  await fs.writeFile(path.join(linked, '.git'), 'gitdir: ' + admin + '\n');
  await fs.writeFile(path.join(admin, 'gitdir'), path.join(linked, '.git') + '\n');
  const wtId = 'dddd1111-2222-4333-8444-555566667777';
  const mainSlug = main.replace(/[^A-Za-z0-9-]/g, '-');
  await file('.claude/projects/' + mainSlug + '/' + wtId + '.jsonl',
    JSON.stringify({ type: 'custom-title', sessionId: wtId, customTitle: 'Worktree Title' }) + '\n');
  const wtMeta = await read([row('claude', wtId, linked)]);
  assert.equal(wtMeta.sessions.get('claude/' + wtId)?.title, 'Worktree Title');
});

test('Claude turnInterruptedAt, worktree sessions-index, long Codex IDE preamble extraction, codex_vscode source, and AGY schema without step_count', async t => {
  const { createRecentReader } = require('../src/metadata.cjs');
  const { read, home, file, db } = await fixture(t);
  const now = Date.UTC(2026, 10, 24, 12);
  const sec = now / 1000;

  // 1. Claude turnInterruptedAt set on [Request interrupted by user] with no following assistant, cleared once assistant replies.
  const idInt = '11111111-1111-4222-8333-444444444441';
  const idResumed = '11111111-1111-4222-8333-444444444442';
  const idToolReject = '11111111-1111-4222-8333-444444444443';
  const t1 = '2026-11-24T12:00:00.000Z';
  const t2 = '2026-11-24T12:01:00.000Z';
  await file('.claude/projects/-test-repo/' + idInt + '.jsonl', [
    JSON.stringify({ type: 'user', sessionId: idInt, cwd: '/test/repo', timestamp: t1,
      message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user] SECRET_ESC' }] } }),
  ].join('\n') + '\n');
  await file('.claude/projects/-test-repo/' + idResumed + '.jsonl', [
    JSON.stringify({ type: 'user', sessionId: idResumed, cwd: '/test/repo', timestamp: t1,
      message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }),
    JSON.stringify({ type: 'assistant', sessionId: idResumed, timestamp: t2,
      message: { role: 'assistant', model: 'claude-sonnet-4-6', content: 'Continuing' } }),
  ].join('\n') + '\n');
  await file('.claude/projects/-test-repo/' + idToolReject + '.jsonl', [
    JSON.stringify({ type: 'user', sessionId: idToolReject, cwd: '/test/repo', timestamp: t1,
      message: { role: 'user', content: [{ type: 'tool_result', content: "The user doesn't want to proceed with this tool use." }] } }),
  ].join('\n') + '\n');
  const intMeta = await read([row('claude', idInt), row('claude', idResumed), row('claude', idToolReject)], { force: true });
  assert.equal(intMeta.sessions.get('claude/' + idInt).turnInterruptedAt, Date.parse(t1));
  assert.equal(intMeta.sessions.get('claude/' + idInt).interruptedAt, Date.parse(t1));
  assert.doesNotMatch(JSON.stringify(intMeta.sessions.get('claude/' + idInt)), /SECRET/);
  assert.equal(intMeta.sessions.get('claude/' + idResumed).turnInterruptedAt, undefined);
  assert.equal(intMeta.sessions.get('claude/' + idResumed).interruptedAt, Date.parse(t1));
  assert.equal(intMeta.sessions.get('claude/' + idToolReject).turnInterruptedAt, undefined);
  assert.equal(intMeta.sessions.get('claude/' + idToolReject).interruptedAt, Date.parse(t1));

  // 2. collectClaude scans sessions-index.json from linked worktree's verified mainCheckout slug.
  const main = path.join(home, 'main-idx');
  const linked = path.join(home, 'linked-idx');
  const admin = path.join(main, '.git', 'worktrees', 'linked');
  await Promise.all([fs.mkdir(admin, { recursive: true }), fs.mkdir(linked, { recursive: true })]);
  await fs.writeFile(path.join(linked, '.git'), 'gitdir: ' + admin + '\n');
  await fs.writeFile(path.join(admin, 'gitdir'), path.join(linked, '.git') + '\n');
  const mainSlug = main.replace(/[^A-Za-z0-9-]/g, '-');
  await file('.claude/projects/' + mainSlug + '/sessions-index.json', { entries: [
    { sessionId: 'wt-idx-1', customTitle: '워크트리 색인 제목', messageCount: 9 },
  ] });
  const wtIdxMeta = await read([row('claude', 'wt-idx-1', linked)], { force: true });
  assert.deepEqual(wtIdxMeta.sessions.get('claude/wt-idx-1'), { title: '워크트리 색인 제목', usage: '메시지 9개' });

  // 3. Long Codex IDE setup header (>300 chars) extracts title past marker inside SQLite; codex_vscode/codex-vscode sources discovered.
  const longPreamble = '# Context from my IDE setup:\n## Active file: ' + '/very/long/path/'.repeat(20) + 'index.ts\n\n## My request for Codex:\n긴 헤더 뒤의 진짜 요청';
  await db('.codex/state_5.sqlite', `CREATE TABLE threads(id,cwd,title,name,preview,updated_at,source);
    INSERT INTO threads VALUES
      ('long1','/project','${longPreamble}',NULL,'preview',${sec},'codex_vscode'),
      ('long2','/project','${longPreamble}',NULL,'preview',${sec - 1},'codex-vscode'),
      ('custom','/project','완료된 대화',NULL,'preview',${sec - 2},'{"custom":"chatgpt"}');`);
  const recentCx = await createRecentReader({ homeDir: home, env: {}, now: () => now })(['/project']);
  assert.deepEqual(recentCx.map(r => [r.sessionId, r.title]), [
    ['long1', '긴 헤더 뒤의 진짜 요청'],
    ['long2', '긴 헤더 뒤의 진짜 요청'],
    ['custom', '완료된 대화'],
  ]);
  const metaCx = await read([row('codex', 'long1', '/project')], { force: true });
  assert.equal(metaCx.sessions.get('codex/long1').title, '긴 헤더 뒤의 진짜 요청');

  // 4. AGY conversation_summaries without step_count column still reads title.
  await db('.gemini/antigravity/conversation_summaries.db',
    "CREATE TABLE conversation_summaries(conversation_id,title); INSERT INTO conversation_summaries VALUES('nostep','제목만 있는 대화');");
  const agyMeta = await read([row('agy', 'nostep')], { force: true });
  assert.deepEqual(agyMeta.sessions.get('agy/nostep'), { title: '제목만 있는 대화' });
});

test('AGY merges title, step_count, and workspace_uris field-by-field across DBs while keeping 0-step and same-name folders distinct', async t => {
  const { createRecentReader } = require('../src/metadata.cjs');
  const { read, home, db } = await fixture(t);
  const now = Date.UTC(2026, 10, 26, 12);
  const iso = new Date(now - 5000).toISOString();
  const zeroTime = '0001-01-01T00:00:00Z';
  const schema = 'CREATE TABLE conversation_summaries(conversation_id,title,step_count,workspace_uris,last_modified_time,last_user_input_time,source);';

  // App DB has empty placeholder rows (title='', step_count=0) for overlapping CLI IDs, plus a genuinely 0-step new conversation.
  await db('.gemini/antigravity/conversation_summaries.db', schema + `
    INSERT INTO conversation_summaries VALUES
      ('f3e373',' ',0,'["file:///work/alpha"]','${zeroTime}','${zeroTime}','CORTEX_TRAJECTORY_SOURCE_CLI'),
      ('partial','',8,'["file:///work/alpha"]','${iso}','${iso}',''),
      ('fresh0','새 빈 대화',0,'["file:///work/alpha"]','${iso}','${iso}',''),
      ('same-a','동명 대화',3,'["file:///work/alpha"]','${iso}','${iso}',''),
      ('same-b','동명 대화',9,'["file:///work/beta"]','${iso}','${iso}','');
  `);
  await db('.gemini/antigravity-cli/conversation_summaries.db', schema + `
    INSERT INTO conversation_summaries VALUES
      ('f3e373','CLI 실제 제목',6,'["file:///work/alpha"]','${iso}','${iso}','CORTEX_TRAJECTORY_SOURCE_CLI'),
      ('partial','CLI 복구 제목',5,'["file:///work/alpha"]','${iso}','${iso}','');
  `);

  const meta = await read([
    row('agy', 'f3e373', '/work/alpha'),
    row('agy', 'partial', '/work/alpha'),
    row('agy', 'fresh0', '/work/alpha'),
    row('agy', 'same-a', '/work/alpha'),
    row('agy', 'same-b', '/work/beta'),
  ], { force: true });

  assert.equal(meta.sessions.get('agy/f3e373').title, 'CLI 실제 제목');
  assert.equal(meta.sessions.get('agy/f3e373').usage, '대화 6단계');
  assert.equal(meta.sessions.get('agy/f3e373').agySource, 'CORTEX_TRAJECTORY_SOURCE_CLI');
  assert.equal(meta.sessions.get('agy/partial').title, 'CLI 복구 제목');
  assert.equal(meta.sessions.get('agy/partial').usage, '대화 8단계', 'higher-priority positive step count wins');
  assert.equal(meta.sessions.get('agy/fresh0').usage, '대화 0단계', 'genuinely 0-step conversation stays 0');
  assert.equal(meta.sessions.get('agy/same-a').usage, '대화 3단계');
  assert.equal(meta.sessions.get('agy/same-b').usage, '대화 9단계');
  assert.equal(meta.providerUsage.agy, '5개 세션 · 26단계 진행');

  // recentAgy merges title + valid timestamp across surfaces and scopes strictly by folder.
  const recentReader = createRecentReader({ homeDir: home, env: {}, now: () => now });
  const alphaRecent = await recentReader(['/work/alpha']);
  assert.deepEqual(alphaRecent.map(r => r.sessionId).sort(), ['f3e373', 'fresh0', 'partial', 'same-a']);
  assert.equal(alphaRecent.find(r => r.sessionId === 'f3e373').title, 'CLI 실제 제목');
  assert.equal(alphaRecent.find(r => r.sessionId === 'partial').title, 'CLI 복구 제목');
  const betaRecent = await recentReader(['/work/beta']);
  assert.deepEqual(betaRecent.map(r => r.sessionId), ['same-b']);
  assert.equal(betaRecent[0].cwd, '/work/beta');
});

test('Antigravity merges workspace-only IDs across schemas and pages past newer rows with no user input', async t => {
  const { createRecentReader } = require('../src/metadata.cjs');
  const { home, db } = await fixture(t);
  const now = Date.UTC(2026, 10, 26, 12), iso = new Date(now).toISOString();
  const app = '.gemini/antigravity/conversation_summaries.db';
  await db(app, `CREATE TABLE conversation_summaries(conversation_id,title,workspace_uris,last_modified_time,last_user_input_time);
    WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<201)
    INSERT INTO conversation_summaries SELECT printf('p%03d',n),'','["file:///work/repo"]','${iso}',NULL FROM seq;
    INSERT INTO conversation_summaries VALUES ('z-real','older valid','["file:///work/repo"]','${new Date(now-5000).toISOString()}','${iso}'),
    ('split',NULL,'["file:///work/repo"]',NULL,NULL),('outside',NULL,'["file:///work/elsewhere"]',NULL,NULL)`);
  await db('.gemini/antigravity-cli/conversation_summaries.db', `CREATE TABLE conversation_summaries(conversation_id,title,last_modified_time,last_user_input_time);
    INSERT INTO conversation_summaries VALUES ('split','from CLI','${iso}','${iso}'),('outside','outside','${iso}','${iso}')`);
  const reader = createRecentReader({ homeDir: home, env: {}, now: () => now });
  const rows = await reader(['/work/repo']);
  assert.deepEqual(rows.map(row => [row.sessionId, row.title, row.cwd]), [
    ['split', 'from CLI', '/work/repo'], ['z-real', 'older valid', '/work/repo'],
  ]);
});

// A sqlite3 stand-in that records each call's target and SQL, then runs the real binary.
async function loggingSqlite(t, before = '') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-sqlite-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'calls.log'), script = path.join(dir, 'sqlite3');
  await fs.writeFile(script, '#!/bin/sh\nprintf \'%s\\t%s\\n\' "$9" "${10}" >> \'' + log + '\'\n' + before + 'exec /usr/bin/sqlite3 "$@"\n', { mode: 0o755 });
  const calls = async () => (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean)
    .map(line => { const [target, sql] = line.split('\t'); return { target, sql }; });
  return { dir, script, calls };
}

test('a reply pushed out of the 32KB tail by a large tool result still names the latest model and turn state', async t => {
  const { claudeChildResponse } = require('../src/metadata.cjs');
  const { read, file, home } = await fixture(t);
  const at = minute => '2026-11-24T12:' + String(minute).padStart(2, '0') + ':00.000Z';
  const reply = (id, model, minute, extra = {}) => JSON.stringify({ type: 'assistant', sessionId: id, timestamp: at(minute),
    message: { role: 'assistant', model, content: 'private' }, ...extra });
  const user = (id, text, minute, extra = {}) => JSON.stringify({ type: 'user', sessionId: id, cwd: '/test/repo', timestamp: at(minute),
    message: { role: 'user', content: [{ type: 'text', text }] }, ...extra });
  const dump = (id, extra = {}) => JSON.stringify({ type: 'user', sessionId: id, timestamp: at(30),
    message: { role: 'user', content: [{ type: 'tool_result', content: 'X'.repeat(120000) }] }, ...extra });
  const pad = id => user(id, 'P'.repeat(40000), 2);

  // An interruption in the head was answered by a reply the tail no longer holds.
  const answered = '21111111-1111-4222-8333-444444444441';
  await file('.claude/projects/-test-repo/' + answered + '.jsonl', [
    user(answered, 'start', 0), reply(answered, 'claude-haiku-4-5', 0), user(answered, '[Request interrupted by user]', 1),
    pad(answered), reply(answered, 'claude-opus-4-1', 3), dump(answered),
  ].join('\n') + '\n');
  // The newest record before the dump is an interruption: that turn stays interrupted.
  const stopped = '21111111-1111-4222-8333-444444444442';
  await file('.claude/projects/-test-repo/' + stopped + '.jsonl', [
    user(stopped, 'start', 0), reply(stopped, 'claude-haiku-4-5', 0), pad(stopped),
    reply(stopped, 'claude-sonnet-4-6', 3), user(stopped, '[Request interrupted by user] SECRET', 4), dump(stopped),
  ].join('\n') + '\n');
  const meta = await read([row('claude', answered), row('claude', stopped)]);
  const first = meta.sessions.get('claude/' + answered), second = meta.sessions.get('claude/' + stopped);
  assert.equal(first.execution.model, 'claude-opus-4-1', 'not the outdated head model');
  assert.equal(first.execution.modelAt, Date.parse(at(3)));
  assert.equal(first.turnInterruptedAt, undefined, 'the later reply answered the interruption');
  assert.equal(first.interruptedAt, Date.parse(at(1)));
  assert.equal(second.execution.model, 'claude-sonnet-4-6');
  assert.equal(second.turnInterruptedAt, Date.parse(at(4)));
  assert.doesNotMatch(JSON.stringify([...meta.sessions.values()]), /SECRET|private|XXXX/);

  // A subagent transcript recovers its own latest response the same way.
  const root = '31111111-1111-4222-8333-444444444441';
  const child = path.join(home, 'child.jsonl');
  await fs.writeFile(child, [
    reply(root, 'claude-haiku-4-5', 0, { agentId: 'a1', isSidechain: true }),
    reply(root, 'claude-sonnet-4-6', 3, { agentId: 'a1', isSidechain: true }),
    dump(root, { agentId: 'a1', isSidechain: true }),
  ].join('\n') + '\n');
  assert.equal((await claudeChildResponse(child, root, 'a1'))?.model, 'claude-sonnet-4-6');
  assert.equal(await claudeChildResponse(child, root, 'other'), undefined);
});

test('an immutable read raced by a writer is repeated once as a normal read-only query', async t => {
  const { query } = require('../src/metadata.cjs');
  const { home, db } = await fixture(t);
  await db('state.db', "CREATE TABLE t(v); INSERT INTO t VALUES(7);");
  const dbFile = path.join(home, 'state.db');
  // The writer appears while the first (immutable) read runs.
  const sqlite = await loggingSqlite(t, ": > '" + dbFile.replaceAll("'", "'\\''") + "-wal'\n");
  assert.deepEqual(await query(dbFile, 'SELECT v FROM t', sqlite.script), [{ v: 7 }]);
  const targets = (await sqlite.calls()).map(call => call.target);
  assert.equal(targets.length, 2);
  assert.match(targets[0], /^file:.*\?immutable=1$/);
  assert.equal(targets[1], dbFile);
});

test('table columns follow the main database file, not WAL activity, until invalidated', async t => {
  const { tableColumns, invalidateTableColumns } = require('../src/metadata.cjs');
  const { home, db } = await fixture(t);
  await db('cols.db', 'CREATE TABLE threads(id,title);');
  const dbFile = path.join(home, 'cols.db');
  const sqlite = await loggingSqlite(t);
  const pragmaCalls = async () => (await sqlite.calls()).filter(call => /pragma_table_info/.test(call.sql)).length;
  assert.deepEqual([...await tableColumns(dbFile, 'threads', sqlite.script)], ['id', 'title']);
  // A writer's sidecars change with every append; the schema did not.
  await fs.writeFile(dbFile + '-wal', 'wal bytes');
  await fs.writeFile(dbFile + '-shm', 'shm bytes');
  assert.deepEqual([...await tableColumns(dbFile, 'threads', sqlite.script)], ['id', 'title']);
  assert.equal(await pragmaCalls(), 1);
  invalidateTableColumns(dbFile);
  await tableColumns(dbFile, 'threads', sqlite.script);
  assert.equal(await pragmaCalls(), 2);
});

test('Antigravity discovery selects only the newest scoped conversations instead of paging all history', async t => {
  const { createRecentReader } = require('../src/metadata.cjs');
  const { home, db } = await fixture(t);
  const now = Date.UTC(2026, 10, 26, 12);
  const old = new Date(now - 30 * 86400000).toISOString();
  await db('.gemini/antigravity/conversation_summaries.db', `CREATE TABLE conversation_summaries(conversation_id,title,workspace_uris,last_modified_time,last_user_input_time);
    WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<700)
    INSERT INTO conversation_summaries SELECT printf('old%04d',n),'old','["file:///work/repo"]',
      strftime('%Y-%m-%dT%H:%M:%SZ', '${old}', '-' || n || ' minutes'),'${old}' FROM seq;
    INSERT INTO conversation_summaries VALUES ('fresh','new work','["file:///work/repo"]','${new Date(now - 1000).toISOString()}','${new Date(now - 1000).toISOString()}');`);
  const sqlite = await loggingSqlite(t);
  const rows = await createRecentReader({ homeDir: home, env: {}, now: () => now, sqlitePath: sqlite.script })(['/work/repo']);
  assert.deepEqual(rows.map(r => r.sessionId), ['fresh']);
  const sql = (await sqlite.calls()).map(call => call.sql).join('\n');
  assert.match(sql, /LIMIT 600/);
  assert.match(sql, /'old0599'/, 'the newest 600 candidates are read');
  assert.doesNotMatch(sql, /'old0700'/, 'the long tail of old conversations is never fetched');
});

test('a burst of scans reuses metadata and recent lists briefly unless forced, the rows change, or caching is off', async t => {
  const { createRecentReader } = require('../src/metadata.cjs');
  const { home, db } = await fixture(t);
  const agyDb = '.gemini/antigravity/conversation_summaries.db';
  await db(agyDb, "CREATE TABLE conversation_summaries(conversation_id,title,workspace_uris,last_modified_time,last_user_input_time); " +
    `INSERT INTO conversation_summaries VALUES('b1','처음','["file:///work/repo"]','${new Date().toISOString()}','${new Date().toISOString()}');`);
  let clock = Date.now();
  const read = createMetadataReader({ homeDir: home, env: {}, now: () => clock });
  const recent = createRecentReader({ homeDir: home, env: {}, now: () => clock });
  const rows = [row('agy', 'b1', '/work/repo')];
  const first = await read(rows);
  const firstRecent = await recent(['/work/repo']);
  await db(agyDb, "UPDATE conversation_summaries SET title='바뀜' WHERE conversation_id='b1';");
  clock += 1000;
  assert.equal(await read(rows), first);
  assert.equal(await recent(['/work/repo']), firstRecent);
  assert.equal((await read(rows, { force: true })).sessions.get('agy/b1').title, '바뀜');
  assert.equal((await recent(['/work/repo'], { force: true }))[0].title, '바뀜');
  await db(agyDb, "UPDATE conversation_summaries SET title='세 번째' WHERE conversation_id='b1';");
  const wider = await read([...rows, row('agy', 'b2', '/work/repo')]);
  assert.equal(wider.sessions.get('agy/b1').title, '세 번째', 'a different set of rows is read at once');
  const uncached = createMetadataReader({ homeDir: home, env: {}, cacheMs: 0, now: () => clock });
  await uncached(rows);
  await db(agyDb, "UPDATE conversation_summaries SET title='네 번째' WHERE conversation_id='b1';");
  assert.equal((await uncached(rows)).sessions.get('agy/b1').title, '네 번째');
});

test('sqlite3 resolves to an executable binary with explicit paths still honored', () => {
  const { defaultSqlitePath } = require('../src/metadata.cjs');
  const resolved = defaultSqlitePath();
  assert.ok(resolved === 'sqlite3' || path.isAbsolute(resolved));
  if (process.platform === 'darwin') assert.equal(resolved, '/usr/bin/sqlite3');
});
