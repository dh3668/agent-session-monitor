'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {createWorkspaceScope,arrangeSessions,markQuiet,triageRank,compareTriage,waitingElsewhere,QUIET_AFTER,WAIT_QUIET_AFTER} = require('../src/workspace-sessions.cjs');

const uri = (fsPath, scheme = 'file', authority = '') => ({uri:{fsPath,scheme,authority}});
const row = (id,cwd,status='recent',updatedAt=1,extra={}) => ({
  provider:'codex', key:'codex/'+id, cwd,status,updatedAt, ...extra,
});
const sub = (id,parent,cwd,status='recent',updatedAt=1,extra={}) =>
  row(id,cwd,status,updatedAt,{isSubagent:true,parentKey:'codex/'+parent,...extra});
const ids = rows => rows.map(r=>r.key.split('/').at(-1));

test('local multi-root membership respects full directory boundaries, lexical and physical aliases, and empty workspaces',async t=>{
  const home = await fs.mkdtemp(path.join(os.tmpdir(),'session-scope-'));
  t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const repo=path.join(home,'repo'), external=path.join(home,'repo-backup'), other=path.join(home,'second');
  const alias=path.join(home,'alias');
  await Promise.all([repo,other,external].map(dir=>fs.mkdir(dir)));
  await fs.symlink(repo,alias);
  await fs.symlink(external,path.join(repo,'external'));
  const scope = await createWorkspaceScope([uri(alias),uri(other),uri(external,'vscode-remote'),uri(external,'file','other-host')]);
  assert.deepEqual(new Set(scope.paths),new Set([alias,await fs.realpath(repo),other,await fs.realpath(other)]));
  const result = await scope.filter([
    row('a',repo), row('b',path.join(alias,'nested','removed')),row('c',other),row('d',external),
    row('e',path.join(alias,'external','not-on-disk')),row('unknown',''),row('relative','repo'),
  ]);
  assert.deepEqual(ids(result),['a','b','c']);
  assert.equal(result[0].cwd,alias);
  assert.equal(result[1].cwd,path.join(alias,'nested','removed'));
  for (const folders of [[], undefined, [uri(external,'vscode-remote')]])
    assert.deepEqual(await (await createWorkspaceScope(folders)).filter(result),[]);
});

test('folderless children inherit only from visible ancestors, blocked seeds stay blocked after native enrichment',async()=>{
  const scope=await createWorkspaceScope(['/project']);
  const root=row('root','/project');
  const direct=sub('child','root','');
  const nested=sub('nested','child','');
  const outside=sub('external','root','/project-2');
  const rootedElsewhere=row('foreign','/another');
  const unknown=sub('unknown','external','');
  const fixtures=[nested,unknown,root,direct,outside,rootedElsewhere,sub('orphan','missing',''),
    sub('cycle1','cycle2',''),sub('cycle2','cycle1',''),sub('bad','root','','recent',1,{provider:'claude'})];
  const first=await scope.filter(fixtures);
  assert.deepEqual(ids(first),['nested','root','child']);
  assert.ok(first.every(item=>item.cwd==='/project'));
  const result=await scope.filter([...first,{...outside,cwd:'/project',workspaceInherited:true},
    {...unknown,cwd:'/project',workspaceInherited:true},
    row('foreign','/project','recent',1,{workspaceInherited:true}),
    row('synthetic','/project','recent',1,{workspaceInherited:true}),
    sub('legitimate','foreign','/project/tools')]);
  assert.deepEqual(ids(result),['nested','root','child','legitimate']);
  const reparented=first.map(item=>item.key==='codex/child' ? {...item,parentKey:'codex/external'} : item);
  assert.deepEqual(ids(await scope.filter(reparented)),['root']);
});

test('recent order uses the latest family activity, attention order considers nested waits, pins are explicit',()=>{
  const old=row('old','/w','done',1), fresh=row('fresh','/w','working',5,{activityAt:20});
  const children=[sub('worker','old','/w','working',2),sub('nested','worker','/w','approval',10),sub('sibling','old','/w','done',3)];
  const rows=[fresh,...children,old,row('other','/w','done',8)];
  assert.deepEqual(ids(arrangeSessions(rows).sessions),['fresh','old','worker','nested','sibling','other']);
  assert.deepEqual(ids(arrangeSessions(rows,{sort:'attention'}).sessions),['old','worker','nested','sibling','fresh','other']);
  assert.deepEqual(ids(arrangeSessions(rows,{attentionOnly:true}).sessions),['old','worker','nested']);
  assert.equal(ids(arrangeSessions(rows,{pinnedKeys:['codex/other']}).sessions)[0],'other');
});

test('hide-completed is reversible and keeps unconfirmed, active, waiting, errored and orphan branches',()=>{
  const completed=[row('done','/w','done'),sub('d1','done','/w','done'),sub('d2','d1','/w','done')];
  const others=['working','approval','input','error','recent','stale','idle'].flatMap(status=>
    [row(status,'/w','done'),sub(status+'-child',status,'/w',status)]);
  const odd=[sub('loop1','loop2','/w','done'),sub('loop2','loop1','/w','done'),sub('orphan','missing','/w','done')];
  const rows=[...completed,...others,...odd];
  const visible=arrangeSessions(rows,{hideCompleted:true});
  assert.equal(visible.completedCount,1);
  assert.deepEqual(new Set(ids(visible.sessions)),new Set(ids([...others,...odd])));
  assert.equal(arrangeSessions(rows).sessions.length,rows.length);
  assert.equal(arrangeSessions([{...completed[0],status:'working'},...completed.slice(1)],{hideCompleted:true}).sessions.length,3);
});

test('manual request and answer recheck the present physical working directory, including changed symlinks', async t=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'session-request-path-'));
  t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const project=path.join(home,'project'), foreign=path.join(home,'other');
  const alias=path.join(home,'opened'), work=path.join(project,'active'), route=path.join(project,'route');
  await Promise.all([fs.mkdir(project),fs.mkdir(foreign)]);
  await Promise.all([fs.mkdir(work),fs.symlink(project,alias)]);
  const scope=await createWorkspaceScope([alias]);
  await fs.symlink(work,route);
  assert.equal(scope.containsExistingFolder(route),true);
  assert.equal(scope.containsExistingFolder(path.join(alias,'active')),true);
  await fs.unlink(route); await fs.symlink(foreign,route);
  assert.equal(scope.containsExistingFolder(route),false);
  assert.equal(scope.containsExistingFolder(path.join(project,'removed')),false);
  const file=path.join(project,'not-a-folder'); await fs.writeFile(file,'');
  assert.equal(scope.containsExistingFolder(file),false);
  assert.equal(scope.containsExistingFolder('relative'),false);
  const dangling=path.join(project,'dangling'); await fs.symlink(path.join(foreign,'missing'),dangling);
  assert.deepEqual(await scope.filter([row('escaped',path.join(dangling,'nested'))]),[]);
  await fs.unlink(alias); await fs.symlink(foreign,alias);
  assert.equal(scope.containsExistingFolder(alias),false);
  assert.equal(scope.containsExistingFolder(work),false);
});

test('individual hiding acknowledges one subtree, protects unresolved work and restores its parent on the next update',()=>{
  const {dismissalFor,undismissedSessions}=require('../src/workspace-sessions.cjs');
  const root=row('root','/w','done',1), child=sub('child','root','/w','done',3), nested=sub('nested','child','/w','done',5);
  const error=row('error','/w','error',2);
  const rows=[child,error,root,nested];
  assert.deepEqual(dismissalFor(rows,error.key),{cutoff:2});
  assert.deepEqual(dismissalFor(rows,root.key),{cutoff:5});
  assert.equal(dismissalFor(rows,'codex/missing'),undefined);
  const archived=key=>key===root.key ? 5 : undefined;
  assert.deepEqual(ids(undismissedSessions(rows,archived)),['error']);
  const resumed=[child,error,root,{...nested,status:'working',updatedAt:6}];
  assert.deepEqual(ids(undismissedSessions(resumed,archived)),ids(rows));
  const gotNew=[...rows,sub('new','root','/w','done',8)];
  assert.deepEqual(ids(undismissedSessions(gotNew,archived)),ids(gotNew));
  for (const status of ['working','approval','input','error']) {
    const protectedRows=[root,child,{...nested,status}];
    assert.equal(dismissalFor(protectedRows,root.key),undefined);
    assert.deepEqual(ids(undismissedSessions(protectedRows,archived)),ids(protectedRows));
  }
  assert.deepEqual(ids(undismissedSessions(rows,key=>key===child.key ? 5 : 0)),['error','root']);
});

test('priority crosses providers and promotes a nested request without duplicating it',()=>{
  const agent = (provider,id,status,updatedAt,extra) => row(id,'/p',status,updatedAt,{provider,key:provider+'/'+id,...extra});
  const roots=[agent('claude','a','working',1000,{workSince:40}), agent('codex','b','done',50,{replyAt:50,replyUnread:true}),
    agent('agy','c','input',300,{waitSince:20}),agent('codex','d','approval',290,{waitSince:10}),
    agent('claude','e','error',20),agent('codex','f','done',25,{replyAt:25,replyUnread:true}),
    agent('codex','g','working',2200,{workSince:30}),agent('codex','h','done',400)];
  const child=agent('claude','child','input',100,{isSubagent:true,parentKey:'claude/a',waitSince:15});
  const layout = {sort:'priority',hideCompleted:true,pinnedKeys:['codex/g','codex/h']};
  const list=arrangeSessions([...roots,child],layout);
  assert.deepEqual(ids(list.sessions),['a','child','c','d','e','b','f','g']);
  assert.equal(list.sessions[0].priorityTargetKey,child.key);
  assert.equal(list.completedCount,1);
  assert.deepEqual(ids(arrangeSessions([...roots,child],{...layout,attentionOnly:true}).sessions),['a','child','c','d','e','b','f']);
  const running=[agent('agy','newer-work','working',50,{workSince:50}),agent('codex','older-work','working',9999,{workSince:30})];
  assert.deepEqual(ids(arrangeSessions(running,layout).sessions),['newer-work','older-work']);
  assert.deepEqual(ids(arrangeSessions(running,{...layout,pinnedKeys:['codex/older-work']}).sessions),['older-work','newer-work']);
});

test('a working family without a signal for a while is quiet; an active subagent keeps its parent live',()=>{
  const now=100*60000, old=now-QUIET_AFTER, recent=now-60000;
  const rows=[row('ghost','/w','working',old,{workSince:old-5}), row('busy','/w','working',old,{activityAt:recent}),
    row('parent','/w','working',old), sub('helper','parent','/w','done',recent), row('chain','/w','working',old),
    sub('mid','chain','/w','working',old), sub('leaf','mid','/w','working',recent),
    row('loop','/w','working',old), sub('loop-a','loop-b','/w','working',old), sub('loop-b','loop-a','/w','working',old),
    sub('foreign','ghost','/w','working',recent,{provider:'claude',key:'claude/foreign'}),
    row('fresh','/w','working',now-QUIET_AFTER+1), row('waiting','/w','approval',old), row('done','/w','done',old)];
  const marked=markQuiet(rows,now);
  const quiet=new Map(marked.filter(r=>r.quiet).map(r=>[r.key.split('/').at(-1),r.signalAt]));
  assert.deepEqual([...quiet.keys()].sort(),['ghost','loop','loop-a','loop-b']);
  assert.equal(quiet.get('ghost'),old,'another provider\'s row is not a descendant');
  for (const id of ['waiting','done','busy','fresh','chain','mid','leaf','parent']) {
    const original=rows.find(r=>r.key.endsWith('/'+id));
    assert.equal(marked.find(r=>r.key===original.key),original,id+' passes through unchanged');
  }
  assert.equal(markQuiet(rows,now,QUIET_AFTER*2).filter(r=>r.quiet).length,0);
});

test('quiet work ranks after live work and before everything else, newest signal first',()=>{
  const live=row('live','/w','working',1,{workSince:5}), quiet=row('quiet','/w','working',1,{quiet:true,signalAt:30});
  const older=row('older','/w','working',1,{quiet:true,signalAt:10}), done=row('done','/w','done',50,{replyAt:50});
  const unread=row('unread','/w','done',40,{replyAt:40,replyUnread:true}), asking=row('asking','/w','input',1);
  assert.deepEqual([asking,unread,live,quiet,done].map(triageRank),[0,3,4,5,6]);
  assert.deepEqual(ids([done,older,quiet,live,unread,asking].sort(compareTriage)),['asking','unread','live','quiet','older','done']);
  const layout={sort:'priority',pinnedKeys:['codex/older']};
  assert.deepEqual(ids(arrangeSessions([done,older,quiet,live],layout).sessions),['live','older','quiet','done'],'a pin orders within the quiet group');
  // A finished parent with a quiet child sorts with quiet work, without promoting the child.
  const parent=row('parent','/w','done',1), child=sub('child','parent','/w','working',1,{quiet:true,signalAt:20});
  const list=arrangeSessions([parent,child,live,done],{sort:'priority'}).sessions;
  assert.deepEqual(ids(list),['live','parent','child','done']);
  assert.equal(list[1].priorityTargetKey,undefined);
});

test('requests waiting outside the scope are grouped per folder, most first, and children use their parent\'s folder',()=>{
  const inScope=new Set(['codex/here']);
  const rows=[row('here','/w','approval',1), row('a1','/api','approval',5,{waitSince:5}), row('a2','/api','input',6,{waitSince:3}),
    row('a3','/api','approval',7,{waitSince:7}), row('b1','/web','input',2,{waitSince:2}), row('c1','/zzz','approval',9,{waitSince:9}),
    row('idle','/api','working',1), row('stale','/api','stale',1), sub('kid','b1','','approval',4,{waitSince:4}), sub('orphan','missing','','input',4),
    ...Array.from({length:9},(_,i)=>row('many'+i,'/f'+i,'approval',20+i,{waitSince:20+i}))];
  const {waiting,folders}=waitingElsewhere(rows,key=>inScope.has(key));
  assert.deepEqual(folders.slice(0,3),[{cwd:'/api',folder:'api',input:1,approval:2},{cwd:'/web',folder:'web',input:1,approval:1},
    {cwd:'/zzz',folder:'zzz',input:0,approval:1}],'most waiting first');
  assert.equal(folders.length,8);
  assert.equal(folders.at(-1).cwd,'/f4','equal counts: the longest wait first');
  assert.equal(waiting.find(r=>r.key==='codex/kid').cwd,'/web');
  assert.ok(!waiting.some(r=>['codex/here','codex/idle','codex/stale','codex/orphan'].includes(r.key)));
  assert.deepEqual(waitingElsewhere([],()=>false),{waiting:[],folders:[]});
});

test('quiet subagents, abandoned children under errored parents, and acknowledged errors do not block dismissal or bulk cleanup',()=>{
  const {dismissalFor,dismissableChildren,undismissedSessions}=require('../src/workspace-sessions.cjs');
  const now=100*60000;
  // A subagent whose last signal preceded its parent's error becomes quiet immediately.
  const erroredParent=row('err','/w','error',now-2*60000);
  const abandoned=sub('webfetch','err','/w','working',now-4*60000);
  const stillLive=sub('live-bg','err','/w','working',now-1*60000);
  const marked=markQuiet([erroredParent,abandoned,stillLive],now);
  assert.equal(marked.find(r=>r.key===abandoned.key).quiet,true);
  assert.equal(marked.find(r=>r.key===stillLive.key).quiet,undefined,'a child active after the parent error stays live');

  // When only quiet or completed children remain under an errored parent, the parent can be dismissed immediately.
  const doneChild=sub('done-kid','err','/w','done',now-3*60000);
  const onlyQuiet=markQuiet([erroredParent,abandoned,doneChild],now);
  assert.deepEqual(dismissalFor(onlyQuiet,erroredParent.key),{cutoff:erroredParent.updatedAt});
  assert.deepEqual(dismissalFor(onlyQuiet,abandoned.key),{cutoff:abandoned.updatedAt},'a quiet row can be dismissed directly');
  assert.deepEqual(undismissedSessions(onlyQuiet,key=>key===erroredParent.key ? erroredParent.updatedAt : undefined),[]);

  // Quiet children do not keep a completed parent from hiding under hideCompleted.
  const finishedParent=row('fin','/w','done',now-5*60000);
  const oldQuietChild=sub('stale-kid','fin','/w','working',now-QUIET_AFTER-1000);
  const finMarked=markQuiet([finishedParent,oldQuietChild],now);
  assert.equal(arrangeSessions(finMarked,{hideCompleted:true}).completedCount,1);
  assert.deepEqual(arrangeSessions(finMarked,{hideCompleted:true}).sessions,[]);

  // Acknowledged errors leave attention rank and attentionOnly.
  const acked=row('acked','/w','error',now-1000,{errorAcked:true});
  assert.equal(triageRank(acked),6);
  assert.deepEqual(arrangeSessions([acked],{attentionOnly:true}).sessions,[]);

  // dismissableChildren targets only settled/quiet branches and protects live/waiting/unacked-error children.
  const busyParent=row('p','/w','working',now);
  const liveKid=sub('k-live','p','/w','working',now-1000);
  const waitKid=sub('k-wait','p','/w','approval',now-1000);
  const errKid=sub('k-err','p','/w','error',now-1000);
  const ackedErrKid=sub('k-acked','p','/w','error',now-1000,{errorAcked:true});
  const quietKid=sub('k-quiet','p','/w','working',now-QUIET_AFTER-1000,{quiet:true,signalAt:now-QUIET_AFTER-1000});
  const doneBranch=sub('k-done','p','/w','done',now-2000);
  const doneLeaf=sub('k-done-leaf','k-done','/w','done',now-3000);
  const mixedParentKid=sub('k-mixed','p','/w','done',now-2000);
  const mixedLiveLeaf=sub('k-mixed-live','k-mixed','/w','working',now-1000);
  const mixedDoneLeaf=sub('k-mixed-done','k-mixed','/w','done',now-2000);
  const all=[busyParent,liveKid,waitKid,errKid,ackedErrKid,quietKid,doneBranch,doneLeaf,mixedParentKid,mixedLiveLeaf,mixedDoneLeaf];
  const targets=dismissableChildren(all,busyParent.key);
  assert.deepEqual(targets.map(t=>t.key).sort(),['codex/k-acked','codex/k-done','codex/k-mixed-done','codex/k-quiet']);
  assert.deepEqual(targets.find(t=>t.key==='codex/k-done').hiddenKeys.sort(),['codex/k-done','codex/k-done-leaf']);
});

test('hideCompleted never hides a completed parent whose quiet child has a waiting, live, or unread grandchild', () => {
  const now = 100 * 60000;
  for (const grandchild of [
    sub('gc-approve', 'quiet-mid', '/w', 'approval', now),
    sub('gc-input', 'quiet-mid', '/w', 'input', now),
    sub('gc-live', 'quiet-mid', '/w', 'working', now),
    sub('gc-error', 'quiet-mid', '/w', 'error', now),
    sub('gc-unread', 'quiet-mid', '/w', 'done', now, { replyAt: now, replyUnread: true }),
  ]) {
    const parent = row('done-root', '/w', 'done', now - 20 * 60000);
    const mid = sub('quiet-mid', 'done-root', '/w', 'working', now - 20 * 60000, { quiet: true, signalAt: now - 20 * 60000 });
    const arranged = arrangeSessions([parent, mid, grandchild], { hideCompleted: true });
    assert.equal(arranged.completedCount, 0, grandchild.key);
    assert.equal(arranged.sessions.length, 3, grandchild.key);
  }
});

test('abandoned waits age into quiet after WAIT_QUIET_AFTER (or on interruption) without trapping attention', () => {
  const { dismissalFor } = require('../src/workspace-sessions.cjs');
  const now = 10 * 3600000;
  const freshWait = row('fresh-wait', '/w', 'approval', now - 30 * 60000);
  const oldWait = row('old-wait', '/w', 'approval', now - WAIT_QUIET_AFTER);
  const oldInput = row('old-input', '/w', 'input', now - WAIT_QUIET_AFTER - 1000);
  const interrupted = row('rejected', '/w', 'approval', now - 60000, { interruptedAt: now - 30000 });
  const marked = markQuiet([freshWait, oldWait, oldInput, interrupted], now);
  const byId = id => marked.find(r => r.key === 'codex/' + id);
  assert.equal(byId('fresh-wait').quiet, undefined);
  assert.equal(byId('old-wait').quiet, true);
  assert.equal(byId('old-input').quiet, true);
  assert.equal(byId('rejected').quiet, true);
  assert.equal(triageRank(byId('fresh-wait')), 1);
  assert.equal(triageRank(byId('old-wait')), 5);
  assert.equal(triageRank(byId('old-input')), 5);
  assert.equal(triageRank(byId('rejected')), 5);
  assert.deepEqual(dismissalFor(marked, 'codex/old-wait'), { cutoff: oldWait.updatedAt });
  assert.deepEqual(arrangeSessions(marked, { attentionOnly: true }).sessions.map(r => r.key), ['codex/fresh-wait']);
});

test('waiting descendants of failed or interrupted parents quiet immediately until a new child signal', () => {
  const { dismissalFor } = require('../src/workspace-sessions.cjs');
  const now = 200000;
  for (const parent of [row('p', '/w', 'error', now - 1000), row('p', '/w', 'idle', now - 1000, { interrupted: true })]) {
    for (const kind of ['approval', 'input']) {
      const child = sub('child', 'p', '/w', kind, now - 2000);
      const nested = sub('nested', 'child', '/w', kind, now - 1500);
      const quiet = markQuiet([parent, child, nested], now);
      assert.equal(quiet[1].quiet, true);
      assert.equal(quiet[2].quiet, true);
      assert.deepEqual(dismissalFor(quiet, parent.key), { cutoff: parent.updatedAt });
      const active = markQuiet([parent, child, { ...nested, activityAt: now }], now);
      assert.equal(active[1].quiet, undefined);
      assert.equal(active[2].quiet, undefined);
      assert.equal(dismissalFor(active, parent.key), undefined);
    }
  }
});

test('working sessions quiet immediately on turnInterruptedAt and children quiet under interrupted idle parents', () => {
  const now = 100 * 60000;
  const turnInterrupted = row('claude-esc', '/w', 'working', now - 20000, { provider: 'claude', key: 'claude/claude-esc', turnInterruptedAt: now - 10000 });
  const resumed = row('claude-resumed', '/w', 'working', now - 5000, { provider: 'claude', key: 'claude/claude-resumed', turnInterruptedAt: now - 10000 });
  const intParent = row('cx-int', '/w', 'idle', now - 10000, { interrupted: true });
  const abandonedKid = sub('cx-kid-old', 'cx-int', '/w', 'working', now - 20000);
  const newerKid = sub('cx-kid-new', 'cx-int', '/w', 'working', now - 5000);
  const plainIdleParent = row('cx-idle', '/w', 'idle', now - 10000);
  const plainIdleKid = sub('cx-idle-kid', 'cx-idle', '/w', 'working', now - 20000);

  const marked = markQuiet([turnInterrupted, resumed, intParent, abandonedKid, newerKid, plainIdleParent, plainIdleKid], now);
  const byKey = key => marked.find(r => r.key === key);
  assert.equal(byKey('claude/claude-esc').quiet, true);
  assert.equal(byKey('claude/claude-resumed').quiet, undefined);
  assert.equal(byKey('codex/cx-kid-old').quiet, true);
  assert.equal(byKey('codex/cx-kid-new').quiet, undefined);
  assert.equal(byKey('codex/cx-idle-kid').quiet, undefined);

  // Transcript file mtime (`activityAt` > `interruptedAt` / `turnInterruptedAt`) must NOT prevent immediate quiet on ESC or rejected approval.
  const escWithNewerMtime = row('claude-esc-mtime', '/w', 'working', now - 20000, {
    provider: 'claude', key: 'claude/esc-mtime', activityAt: now - 9950, turnInterruptedAt: now - 10000,
  });
  const rejectWithNewerMtime = row('claude-rej-mtime', '/w', 'approval', now - 20000, {
    provider: 'claude', key: 'claude/rej-mtime', activityAt: now - 9950, interruptedAt: now - 10000,
  });
  // A genuine newer hookActivityAt after interruption DOES keep the session live.
  const resumedHook = row('claude-resumed-hook', '/w', 'working', now - 20000, {
    provider: 'claude', key: 'claude/resumed-hook', hookActivityAt: now - 5000, activityAt: now - 5000, turnInterruptedAt: now - 10000,
  });
  const checked = markQuiet([escWithNewerMtime, rejectWithNewerMtime, resumedHook], now);
  assert.equal(checked.find(r => r.key === 'claude/esc-mtime').quiet, true);
  assert.equal(checked.find(r => r.key === 'claude/rej-mtime').quiet, true);
  assert.equal(checked.find(r => r.key === 'claude/resumed-hook').quiet, undefined);
});
