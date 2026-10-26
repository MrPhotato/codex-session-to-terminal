import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { cloudCandidates, cloudCliLaunch, cloudTerminalError, parseCloudArguments, runCloudTerminal } from '../cst-cloud-terminal.mjs';
import { attachCloudWithPageRecovery } from '../cloud-owner-activation.mjs';
import { recentCloudCandidate } from '../cloud-recent-candidates.mjs';

const id = '11111111-2222-4333-8444-555555555555';
const options = {threadId:id,controlDirectory:resolve('control'),powershellPath:resolve('pwsh.exe'),backendPath:resolve('backend.exe'),cliPath:resolve('codex.exe')};
const home=resolve('control/cloud-test');
function fixture(extra={}) {
  const calls=[];
  const attachment={endpoint:'ws://127.0.0.1:33333/',token:'a'.repeat(64),state:{id,hostId:'durable',latestThreadSettings:{cwd:'/cloud/not-a-local-directory'}},manifest:{readonly:true,hostId:'durable',send:false,steer:false,queue:false,interrupt:false},close:async()=>calls.push('attachment.close')};
  const reader={listConversations:async()=>({threads:[{id,kind:'codex',hostId:'durable',title:'Online'}]}),readConversation:async(target,args)=>{calls.push({read:target,args});return {thread:{id:target,kind:'codex',hostId:'durable'},turns:[]};},close:async()=>calls.push('reader.close')};
  const dependencies={lease:()=>true,createHome:async()=>home,createReader:async()=>reader,writeDiagnostics:async()=>{},loadIdentityLinks:async()=>[],
    writeConnectionDiagnostics:async()=>{},
    createRecentStore:()=>({get:async()=>null,put:async()=>{},delete:async()=>{}}),
    chooseThread:async rows=>{calls.push({candidates:rows});return rows.find(row=>row.hostId==='durable').id;},
    createAttachment:async args=>{calls.push({attachment:args});return attachment;},
    createPresence:()=>({updateState(){},updateStatus(){},close:async()=>calls.push('presence.close')}),
    runView:async(launch,args)=>{calls.push({launch,viewArgs:args});return 0;},processEvents:new EventEmitter(),output:{write(){}},input:{},
    environment:{PATH:'system-path',API_KEY:'never-forward',CODEX_HOME:'not-inherited',TERM:'dumb'},...extra};
  return {calls,attachment,reader,dependencies};
}
test('cloud parser accepts explicit native identity or selection, never a control opt-in',()=>{
  const args=['--control-directory',options.controlDirectory,'--powershell-path',options.powershellPath,'--backend-path',options.backendPath];
  assert.equal(parseCloudArguments(args).threadId,undefined);
  assert.equal(parseCloudArguments([...args,'--thread',id]).threadId,id);
  for(const suffix of [['--interrupt','true'],['--host','local'],['--thread','bad'],['--thread',id,'--thread',id]]) assert.throws(()=>parseCloudArguments([...args,...suffix]));
});

test('missing cloud owner explains the Work/native connection boundary without exposing upstream text',()=>{
  const secret='private provider text';
  assert.match(cloudTerminalError({code:'NO_OWNER',message:secret},'zh-CN'), /当前 Work 页面未建立原生 Codex 连接.*Codex 视图.*NO_OWNER/);
  assert.match(cloudTerminalError({code:'NO_OWNER',message:secret},'en-SG'), /Work page has no native Codex connection.*Codex view.*NO_OWNER/);
  for(const code of ['NO_OWNER','REMOTE_ERROR',secret])assert.equal(cloudTerminalError({code,message:secret},'en-US').includes(secret),false);
});

test('slow discovery and a loading execution view have distinct localized errors without upstream text',()=>{
  for(const code of ['CLOUD_DISCOVERY_TIMEOUT','CLOUD_OWNER_NOT_READY'])for(const locale of ['en-US','zh-CN']){
    const text=cloudTerminalError({code,message:'private response'},locale);
    assert.ok(text.includes(code));assert.equal(text.includes('private response'),false);
  }
});

test('a timed-out discovery stops without a misleading picker and saves its reason',async()=>{
  const f=linkedFixture();f.dependencies.loadIdentityLinks=async()=>[];
  f.dependencies.discoverCandidate=async(_list,_frontend,_read,{onDiagnostic})=>{
    onDiagnostic({version:1,outcome:'timeout',candidates:15,scanned:12,elapsedMs:45000});
    throw Object.assign(new Error('private response'),{code:'CLOUD_DISCOVERY_TIMEOUT'});
  };
  const reports=[];f.dependencies.writeConnectionDiagnostics=async(_home,stage,value)=>reports.push({stage,value});
  await assert.rejects(runCloudTerminal({...options,threadId:undefined,titleContext:f.source},f.dependencies),{code:'CLOUD_DISCOVERY_TIMEOUT'});
  assert.equal(reports.length,1);assert.equal(reports[0].stage,'discovery');assert.equal(reports[0].value.outcome,'timeout');
  assert.equal(f.calls.some(x=>x.attachment||x.launch),false);
});

test('selection after a long picker wait renews the source by a live page check before recovery',async()=>{
  for(const samePage of [true,false]){
    const f=linkedFixture();let time=100010,discoveries=0;
    f.dependencies.now=()=>time;f.dependencies.loadIdentityLinks=async()=>[];
    f.dependencies.discoverCandidate=async()=>++discoveries===1?null:{native:f.native,evidence:{frontendId,clientMessageId:linkedMessageId},title:'Online'};
    f.dependencies.chooseThread=async()=>{time+=60000;return frontendId;};
    f.dependencies.recheckTitleContext=async(context,{refreshAge})=>{
      assert.equal(refreshAge,true);assert.equal(context.capturedAt,100000);return samePage;
    };
    f.dependencies.attachWithRecovery=async args=>{assert.equal(args.plan.context.capturedAt,160010);return args.connect();};
    if(samePage)assert.equal(await runCloudTerminal({...options,threadId:undefined,titleContext:f.source},f.dependencies),0);
    else await assert.rejects(runCloudTerminal({...options,threadId:undefined,titleContext:f.source},f.dependencies),{code:'CLOUD_PAGE_CHANGED'});
  }
});

test('recovery diagnostics are saved before viewing or reporting a connection failure',async()=>{
  for(const fails of [false,true]){
    const f=fixture(),events=[];
    f.dependencies.attachWithRecovery=async args=>{
      args.onDiagnostic({version:1,navigated:true,attempts:[{elapsedMs:20000,result:'no-owner'}],outcome:fails?'owner-not-ready':'connected'});
      if(fails)throw Object.assign(new Error('private upstream response'),{code:'CLOUD_OWNER_NOT_READY'});
      return args.connect();
    };
    f.dependencies.writeConnectionDiagnostics=async(_home,stage,value)=>{events.push(stage);assert.equal(JSON.stringify(value).includes('private'),false);};
    f.dependencies.runView=async()=>{assert.deepEqual(events,['recovery']);return 0;};
    if(fails)await assert.rejects(runCloudTerminal(options,f.dependencies),{code:'CLOUD_OWNER_NOT_READY'});
    else assert.equal(await runCloudTerminal(options,f.dependencies),0);
    assert.deepEqual(events,['recovery']);
  }
});
test('catalog retains exact durable identities, deduplicates, and strips terminal controls',()=>{
  const rows=cloudCandidates({pinnedThreads:[{id,kind:'codex',hostId:'durable',title:'\x1b[31mCloud\x1b[0m\r\n'}],threads:[{id,kind:'codex',hostId:'durable',title:'duplicate'}, {id:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',kind:'chatgpt',hostId:'durable'}, {id:'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee',kind:'codex',hostId:'local'}]});
  assert.deepEqual(rows,[{id,title:'Cloud',hostId:'durable'}]);
});
test('cloud CLI uses isolated local home and environment with original binary and readonly manifest',()=>{
  const f=fixture();const launch=cloudCliLaunch(options,f.attachment,home,f.dependencies.environment);
  assert.equal(launch.executable,options.cliPath);assert.equal(launch.options.cwd,home);
  assert.equal(launch.options.env.CODEX_HOME,home);assert.equal(launch.options.env.API_KEY,undefined);
  assert.equal(launch.options.env.TERM,'xterm-256color');assert.equal(launch.options.env.CST_CLOUD_READ_TOKEN,f.attachment.token);
  assert.ok(launch.args.includes('tui.fullscreen_transcript=true'));assert.ok(!launch.args.includes('--no-alt-screen'));
  assert.ok(launch.args.includes('tui.terminal_title=["thread-name"]'));
  assert.ok(!launch.args.includes('tui.terminal_title=[]'));
  assert.ok(!launch.args.join(' ').includes(f.attachment.token));
  for(const key of ['send','steer','queue','interrupt'])assert.throws(()=>cloudCliLaunch(options,{...f.attachment,manifest:{...f.attachment.manifest,[key]:true}},home),{code:'READ_ONLY_REQUIRED'});
});
test('selection then authoritative durable read precedes readonly attachment and closes owned resources',async()=>{
  const f=fixture();assert.equal(await runCloudTerminal({...options,threadId:undefined},f.dependencies),0);
  const read=f.calls.find(x=>x.read);assert.equal(read.args.hostId,'durable');
  const attach=f.calls.find(x=>x.attachment).attachment;assert.equal(attach.persistedThread,true);
  assert.equal(Object.hasOwn(attach,'allowInterrupt'),false);assert.equal(Object.hasOwn(attach,'interruptControl'),false);
  assert.deepEqual(f.calls.slice(-3),['attachment.close','reader.close','presence.close']);
});
test('a mismatched/local read never opens an attachment or CLI',async()=>{
  const f=fixture();f.reader.readConversation=async()=>({thread:{id,kind:'codex',hostId:'local'}});
  await assert.rejects(runCloudTerminal(options,f.dependencies),{code:'NOT_CLOUD_SESSION'});
  assert.equal(f.calls.some(x=>x.attachment||x.launch),false);assert.ok(f.calls.includes('reader.close'));
});
test('cancellation while attachment opens cleans the late result and cannot start a viewer',async()=>{
  let finish;const controller=new AbortController();
  const f=fixture({signal:controller.signal,createAttachment:()=>new Promise(r=>{finish=r;})});
  const running=runCloudTerminal(options,f.dependencies);
  while(!finish)await new Promise(r=>setImmediate(r));
  controller.abort();await assert.rejects(running,{code:'ABORTED'});
  finish(f.attachment);await new Promise(r=>setImmediate(r));
  assert.equal(f.calls.some(x=>x.launch),false);assert.ok(f.calls.includes('attachment.close'));
});
test('viewer failure revokes attachment and never sends cloud interruption',async()=>{
  const f=fixture({runView:async()=>{throw new Error('display failed');}});
  await assert.rejects(runCloudTerminal(options,f.dependencies),/display failed/);
  assert.deepEqual(f.calls.slice(-3),['attachment.close','reader.close','presence.close']);
  assert.equal(f.dependencies.processEvents.listenerCount('SIGINT'),0);
});

test('cancellation waits for viewer cleanup before releasing resources or returning',async()=>{
  const controller=new AbortController();let started,finishCleanup;
  const entered=new Promise(resolve=>{started=resolve;});
  const f=fixture({signal:controller.signal,runView:async(_launch,{signal})=>{
    started();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
    await new Promise(resolve=>{finishCleanup=resolve;});f.calls.push('view.cleaned');return 130;
  }});
  let settled=false;const running=runCloudTerminal(options,f.dependencies).finally(()=>{settled=true;});
  await entered;controller.abort();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(settled,false);assert.equal(f.calls.includes('attachment.close'),false);
  finishCleanup();await assert.rejects(running,{code:'ABORTED'});
  assert.deepEqual(f.calls.slice(-4),['view.cleaned','attachment.close','reader.close','presence.close']);
});

test('cloud toolbar binds only the selected durable ID and does not navigate at startup',async()=>{
  let opened=0,closed=0;
  const f=fixture({createButtonAction:args=>{
    assert.equal(args.threadId,id);assert.equal(args.hostId,'durable');
    return {open:async()=>{opened++;return {navigated:true,nativeExecutionView:true};},close:async()=>{closed++;}};
  },runView:async(_launch,settings)=>{assert.equal(opened,0);await settings.onOpenDesktop();return 0;}});
  assert.equal(await runCloudTerminal(options,f.dependencies),0);assert.equal(opened,1);assert.equal(closed,1);
});

const titleContext={version:1,status:'ready',pid:123,window:456,started:'639000000000000001',
  documentRuntimeId:'42,7,9',title:'Online',capturedAt:Date.now()};
const frontendId='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const titleList={threads:[{id,kind:'codex',hostId:'durable',title:'Online'},
  {id:frontendId,kind:'chatgpt',title:'Online'}]};

const linkedMessageId='cccccccc-1111-4111-8111-111111111111';
const laterMessageId='dddddddd-2222-4222-8222-222222222222';
function linkedFixture() {
  const f=fixture({chooseThread:()=>assert.fail('a verified linked candidate must not ask'),
    recheckTitleContext:async()=>true,
    loadIdentityLinks:async()=>[{frontendId,nativeId:id,verifiedClientMessageId:linkedMessageId,verification:'observed-message-link'}]});
  f.source={...titleContext,lastInputTick:50,capturedAt:100000};
  f.frontend={thread:{id:frontendId,kind:'chatgpt',title:'Online'},page:{order:'newest_first'},
    turns:[{id:linkedMessageId,items:[{type:'userMessage',id:linkedMessageId,content:[]}]}]};
  f.native={thread:{id,kind:'codex',hostId:'durable',title:null}};
  f.reader.listConversations=async()=>({threads:[f.frontend.thread,f.native.thread]});
  f.reader.readConversation=async(target,args)=>{
    f.calls.push({read:target,args});
    assert.ok(target===frontendId||target===id,'read only the linked identities');
    return structuredClone(target===frontendId?f.frontend:f.native);
  };
  f.attachment.state.turnHistory={kind:'canonical',history:{
    islands:[{entries:[{value:'latest'}],olderBoundary:{status:'available'},newerBoundary:{status:'exhausted'}}],
    entitiesByKey:{latest:{turnId:'native-latest',status:'completed',params:{clientUserMessageId:linkedMessageId},
      itemsPagination:{hasLoadedOldest:true},items:[{type:'userMessage',id:'native-user',clientId:linkedMessageId,content:[]}]}}}};
  f.dependencies.now=()=>100010;
  return f;
}

test('a warm linked session verifies current message identity before display even when native title is null',async()=>{
  const f=linkedFixture();let evidenceChecked=false;
  f.dependencies.attachWithRecovery=async args=>{
    assert.equal(args.plan.threadId,id);assert.equal(args.plan.nativeTitle,null);
    assert.equal(args.plan.linkedEvidence.frontendId,frontendId);
    assert.equal(args.plan.linkedEvidence.clientMessageId,linkedMessageId);
    const attachment=await args.connect();evidenceChecked=true;return attachment;
  };
  f.dependencies.runView=async launch=>{assert.equal(evidenceChecked,true);assert.equal(launch.args.at(-1),id);f.calls.push('linked.view');return 0;};
  assert.equal(await runCloudTerminal({...options,threadId:undefined,titleContext:f.source},f.dependencies),0);
  assert.deepEqual(f.calls.filter(call=>call.read).map(call=>call.read),[frontendId,id]);
  assert.equal(f.calls.filter(call=>call.attachment).length,1);
  assert.ok(f.calls.includes('linked.view'));
});

test('a previously linked cloud session accepts current completed/live receipts after Continue',async()=>{
  for(const status of ['completed','inProgress']) for(const continuation of [false,true]) {
    const f=linkedFixture(),state=f.attachment.state,turn=state.turnHistory.history.entitiesByKey.latest;
    state.historyMode='legacy';state.threadRuntimeStatus={type:status==='completed'?'idle':'active'};
    turn.turnId='eeeeeeee-3333-4333-8333-333333333333';turn.turnStartedAtMs=1792739849168;
    turn.status=status;turn.params={};delete turn.itemsPagination;
    if(continuation){
      turn.items.push({type:'userMessage',clientId:laterMessageId});
      f.frontend.turns[0].items[0].id=laterMessageId;
    }
    assert.equal(await runCloudTerminal({...options,threadId:undefined,titleContext:f.source},f.dependencies),0);
    assert.equal(f.calls.filter(call=>call.launch).length,1);
    assert.deepEqual(f.calls.filter(call=>call.read).map(call=>call.read),[frontendId,id]);
  }
});

test('linked frontend and native reads overlap but no viewer opens before both pass',async()=>{
  const f=linkedFixture();let resolveFrontend,resolveNative;
  f.reader.readConversation=(target)=>new Promise(resolve=>{
    if(target===frontendId)resolveFrontend=()=>resolve(f.frontend);
    else resolveNative=()=>resolve(f.native);
  });
  const running=runCloudTerminal({...options,threadId:undefined,titleContext:f.source},f.dependencies);
  while(!resolveFrontend||!resolveNative)await new Promise(resolve=>setImmediate(resolve));
  resolveNative();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.calls.some(call=>call.attachment||call.launch),false);
  resolveFrontend();assert.equal(await running,0);
  assert.equal(f.calls.filter(call=>call.launch).length,1);
});

test('cached identity is only a hint: mismatched or incomplete native evidence closes without displaying',async()=>{
  const mutations=[
    state=>{state.turnHistory.history.entitiesByKey.latest.params.clientUserMessageId=laterMessageId;},
    state=>{state.turnHistory.history.entitiesByKey.latest.items[0].clientId=laterMessageId;},
    state=>{state.turnHistory.history.entitiesByKey.latest.itemsPagination.hasLoadedOldest=false;},
    state=>{state.turnHistory.history.islands[0].newerBoundary.status='unknown';},
    state=>{state.turnHistory.history.entitiesByKey.latest.items.push({type:'userMessage',id:'other-user',clientId:linkedMessageId,content:[]});},
  ];
  for(const mutate of mutations){
    const f=linkedFixture();mutate(f.attachment.state);const updates=[];
    f.dependencies.createPresence=()=>({updateState:state=>updates.push(state),updateStatus:status=>updates.push(status),close:async()=>f.calls.push('presence.close')});
    f.dependencies.createAttachment=async args=>{
      f.calls.push({attachment:args});args.onState(f.attachment.state);args.onStatus({ready:true});return f.attachment;
    };
    await assert.rejects(runCloudTerminal({...options,threadId:undefined,titleContext:f.source},f.dependencies),{code:'CLOUD_IDENTITY_UNCONFIRMED'});
    assert.equal(f.calls.some(call=>call.launch),false);
    assert.equal(f.calls.filter(call=>call==='attachment.close').length,1);
    assert.deepEqual(updates,[],'an unverified candidate must not leak into session presence');
    assert.ok(f.calls.includes('reader.close'));assert.ok(f.calls.includes('presence.close'));
  }
});

test('a stale frontend hint cannot attach, navigate, or silently fall back to another session',async()=>{
  for(const mutate of [
    read=>{read.thread.id=laterMessageId;},
    read=>{read.thread.title='Other page';},
    read=>{read.page.order='oldest_first';},
    read=>{read.turns[0].items=[];},
    read=>{read.turns[0].items.push({type:'userMessage',id:laterMessageId,content:[]});},
  ]){
    const f=linkedFixture();mutate(f.frontend);
    // Keep the directory's observed candidate stable while its authoritative
    // read changes; a cached link alone cannot authorize selecting its native ID.
    f.reader.listConversations=async()=>({threads:[{id:frontendId,kind:'chatgpt',title:'Online'},f.native.thread]});
    let recoveryCalled=false;f.dependencies.attachWithRecovery=async()=>{recoveryCalled=true;assert.fail('must not recover a stale frontend');};
    await assert.rejects(runCloudTerminal({...options,threadId:undefined,titleContext:f.source},f.dependencies),{code:'CLOUD_IDENTITY_UNCONFIRMED'});
    assert.equal(recoveryCalled,false);assert.equal(f.calls.some(call=>call.attachment||call.launch),false);
  }
});

test('a linked cold session with an untitled native page connects and returns before display',async()=>{
  const f=linkedFixture();let attempts=0,readers=0;let current=structuredClone(f.source);const events=[];
  const navigator={readConversation:f.reader.readConversation,
    navigateConversation:async target=>{assert.equal(target,id);events.push('navigate');current={...current,title:'ChatGPT',documentRuntimeId:'42,8,10'};return {navigated:true};},
    close:async()=>events.push('navigator.close')};
  f.dependencies.createReader=async args=>{
    if(++readers===1)return f.reader;
    assert.deepEqual(args.navigateTargets,[id]);return navigator;
  };
  f.dependencies.createAttachment=async()=>{
    if(++attempts===1)throw Object.assign(new Error('missing'),{code:'NO_OWNER'});
    return f.attachment;
  };
  f.dependencies.attachWithRecovery=args=>attachCloudWithPageRecovery(args,{
    now:()=>100010,pause:async()=>{},readContext:async()=>structuredClone(current),
    restorePage:async actual=>{assert.deepEqual(actual,current);events.push('back');return {dispatched:true};},
  });
  f.dependencies.runView=async()=>{events.push('view');return 0;};
  assert.equal(await runCloudTerminal({...options,threadId:undefined,titleContext:f.source},f.dependencies),0);
  assert.equal(attempts,2);assert.equal(readers,2);
  assert.deepEqual(f.calls.filter(call=>call.read).map(call=>call.read),[frontendId,id,id,frontendId]);
  assert.deepEqual(events,['navigate','back','navigator.close','view']);
});

test('unique current cloud title bypasses picker after authoritative read and source recheck',async()=>{
  const f=fixture({chooseThread:()=>assert.fail('matching title must not ask'),recheckTitleContext:async()=>true});
  f.reader.listConversations=async()=>titleList;
  f.reader.readConversation=async()=>({thread:{id,kind:'codex',hostId:'durable',title:'Online'}});
  assert.equal(await runCloudTerminal({...options,threadId:undefined,titleContext},f.dependencies),0);
  assert.equal(f.calls.find(x=>x.attachment).attachment.threadId,id);
});

test('cold shortcut recovers callback-first NO_OWNER without aborting the terminal and returns before display',async()=>{
  let attempts=0,readers=0;const events=[];
  const source={...titleContext,lastInputTick:50,capturedAt:100000};
  const f=fixture({now:()=>100010,recheckTitleContext:async()=>true,
    attachWithRecovery:args=>attachCloudWithPageRecovery(args,{
      now:()=>100010,pause:async()=>{},readContext:async()=>source,
      restorePage:async()=>{events.push('back');return {dispatched:true};},
    }),runView:async()=>{events.push('view');return 0;}});
  f.reader.listConversations=async()=>titleList;
  f.reader.readConversation=async()=>({thread:{id,kind:'codex',hostId:'durable',title:'Online'}});
  const navigator={readConversation:f.reader.readConversation,
    navigateConversation:async target=>{assert.equal(target,id);events.push('navigate');return {navigated:true};},
    close:async()=>events.push('navigator.close')};
  f.dependencies.createReader=async args=>{
    if(++readers===1)return f.reader;
    assert.deepEqual(args.navigateTargets,[id]);return navigator;
  };
  f.dependencies.createAttachment=async args=>{
    assert.equal(args.signal.aborted,false);
    if(++attempts===1){args.onError(Object.assign(new Error('missing'),{code:'NO_OWNER'}));throw Object.assign(new Error('closed'),{code:'ABORTED'});}
    return f.attachment;
  };
  assert.equal(await runCloudTerminal({...options,threadId:undefined,titleContext:source},f.dependencies),0);
  assert.equal(attempts,2);assert.equal(readers,2);
  assert.deepEqual(events,['navigate','back','navigator.close','view']);
  assert.equal(f.calls.filter(call=>call==='reader.close').length,1);
});

test('explicit or manual selection with no source context never guesses a return page',async()=>{
  for(const selected of [options,{...options,threadId:undefined}]){
    let reads=0;
    const f=fixture({createAttachment:async()=>{throw Object.assign(new Error('missing'),{code:'NO_OWNER'});}});
    f.dependencies.createReader=async args=>{reads++;assert.equal(args.navigateTargets,undefined);return f.reader;};
    await assert.rejects(runCloudTerminal(selected,f.dependencies),{code:'NO_OWNER'});
    assert.equal(reads,1);
  }
});

test('ambiguous title, changed native title, or changed source page use manual selection',async()=>{
  for(const reason of ['duplicate','rename','source-changed','source-timeout']) {
    let chosen=0;
    const f=fixture({chooseThread:async()=>{chosen++;return id;},recheckTitleContext:async()=>{
      if(reason==='source-timeout')throw new Error('timeout');return reason!=='source-changed';
    }});
    f.reader.listConversations=async()=>reason==='duplicate'?{threads:[...titleList.threads,
      {id:'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee',kind:'codex',hostId:'durable',title:'Online'}]}:titleList;
    f.reader.readConversation=async()=>({thread:{id,kind:'codex',hostId:'durable',title:reason==='rename'?'Changed':'Online'}});
    assert.equal(await runCloudTerminal({...options,threadId:undefined,titleContext},f.dependencies),0);
    assert.equal(chosen,1,reason);
  }
});

test('explicit thread and tray menu do not consult window title',async()=>{
  const f=fixture({recheckTitleContext:()=>assert.fail('must not read UI')});
  assert.equal(await runCloudTerminal(options,f.dependencies),0);
  const menu=fixture({recheckTitleContext:()=>assert.fail('must not read UI')});
  assert.equal(await runCloudTerminal({...options,threadId:undefined},menu.dependencies),0);
});

test('title diagnostics identify recheck fallback with timings and no session content',async()=>{
  let clock=100000;const snapshots=[];
  const f=fixture({now:()=>clock,createHome:async()=>{clock+=3;return home;},
    writeDiagnostics:async(directory,value)=>{assert.equal(directory,home);snapshots.push(structuredClone(value));},
    recheckTitleContext:async(_context,{onDiagnostic})=>{clock+=30;onDiagnostic({reason:'expired',elapsedMs:30,title:'private title',token:'private token'});return false;},
    chooseThread:async()=>{assert.equal(snapshots.length,1,'diagnosis must exist while picker is visible');return id;}});
  f.dependencies.createReader=async()=>{clock+=4;return f.reader;};
  f.reader.listConversations=async()=>{clock+=10;return titleList;};
  f.reader.readConversation=async()=>{clock+=20;return {thread:{id,kind:'codex',hostId:'durable',title:'Online'}};};
  assert.equal(await runCloudTerminal({...options,threadId:undefined,titleContext:{...titleContext,capturedAt:68000}},f.dependencies),0);
  assert.deepEqual(snapshots,[{version:1,titleContextPresent:true,explicitThread:false,contextAgeAtStartMs:32000,
    timingsMs:{createHome:3,createReader:4,listConversations:10,candidateRead:20,titleRecheck:30},
    candidateFound:true,readMatches:true,recheckPassed:false,recheckDetail:{reason:'expired',elapsedMs:30},contextAgeAtRecheckMs:32037,
    failedStage:null,outcome:'manual-selection',elapsedMs:67}]);
  const text=JSON.stringify(snapshots);
  for(const secret of [id,frontendId,titleContext.title,titleContext.started,titleContext.documentRuntimeId,'never-forward',f.attachment.token])assert.equal(text.includes(secret),false);
});

test('diagnostics distinguish a thrown recheck and cannot block manual selection',async()=>{
  let writes=0,chosen=0;
  const f=fixture({recheckTitleContext:async()=>{throw new Error('private provider response');},
    writeDiagnostics:async(_directory,value)=>{writes++;assert.equal(value.failedStage,'titleRecheck');
      assert.equal(value.recheckPassed,null);assert.equal(value.outcome,'manual-selection');
      assert.equal(JSON.stringify(value).includes('private provider response'),false);throw new Error('unwritable diagnostics');},
    chooseThread:async()=>{chosen++;return id;}});
  f.reader.listConversations=async()=>titleList;
  f.reader.readConversation=async()=>({thread:{id,kind:'codex',hostId:'durable',title:'Online'}});
  assert.equal(await runCloudTerminal({...options,threadId:undefined,titleContext},f.dependencies),0);
  assert.equal(writes,1);assert.equal(chosen,1);
});

test('diagnostics preserve missing-context and list failure as separate outcomes',async()=>{
  const snapshots=[];
  const f=fixture({writeDiagnostics:async(_directory,value)=>snapshots.push(structuredClone(value))});
  assert.equal(await runCloudTerminal({...options,threadId:undefined},f.dependencies),0);
  assert.equal(snapshots[0].titleContextPresent,false);assert.equal(snapshots[0].candidateFound,false);
  assert.equal(snapshots[0].readMatches,null);assert.equal(snapshots[0].outcome,'manual-selection');
  snapshots.length=0;f.reader.listConversations=async()=>{throw new Error('list failed');};
  await assert.rejects(runCloudTerminal({...options,threadId:undefined,titleContext},f.dependencies),/list failed/);
  assert.equal(snapshots.length,1);assert.equal(snapshots[0].failedStage,'listConversations');
  assert.equal(snapshots[0].outcome,'selection-failed');
});

test('discovered untitled chat verifies native IDs before showing a frontend display title', async()=>{
  const f=linkedFixture(); f.dependencies.loadIdentityLinks=async()=>[];
  f.dependencies.discoverCandidate=async()=>({native:f.native,evidence:{frontendId,clientMessageId:linkedMessageId,discovered:true},title:'Online'});
  f.dependencies.attachWithRecovery=async args=>{assert.equal(args.plan.linkedEvidence.discovered,true);return args.connect();};
  f.dependencies.runView=async(_launch,args)=>{assert.equal(args.displayTitle,'Online');return 0;};
  assert.equal(await runCloudTerminal({...options,threadId:undefined,titleContext:f.source},f.dependencies),0);
  f.attachment.state.turnHistory.history.entitiesByKey.latest.items[0].clientId=laterMessageId;
  f.dependencies.runView=()=>assert.fail('mismatched discovered history must not display');
  await assert.rejects(runCloudTerminal({...options,threadId:undefined,titleContext:f.source},f.dependencies),{code:'CLOUD_IDENTITY_UNCONFIRMED'});
});

test('missing title offers frontend names and manual frontend choice uses the same ID verification',async()=>{
  const f=linkedFixture(); f.dependencies.loadIdentityLinks=async()=>[];
  f.dependencies.chooseThread=async rows=>{assert.equal(rows[0].title,'Online');assert.equal(rows[0].kind,'chatgpt');return frontendId;};
  f.dependencies.discoverCandidate=async()=>({native:f.native,evidence:{frontendId,clientMessageId:linkedMessageId,discovered:true},title:'Online'});
  f.dependencies.attachWithRecovery=async args=>{assert.equal(args.plan,undefined);return args.connect();};
  assert.equal(await runCloudTerminal({...options,threadId:undefined},f.dependencies),0);
});

test('successful full discovery enrolls only after native proof; repeat opens skip broad discovery',async()=>{
  let stored,scans=0;
  const store={get:async()=>stored,put:async row=>{stored=row;},delete:async()=>{stored=undefined;}};
  const make=()=>{
    const f=linkedFixture();f.dependencies.loadIdentityLinks=async()=>[];
    f.dependencies.createRecentStore=()=>store;
    f.dependencies.discoverCandidate=async()=>{scans++;return {native:f.native,evidence:{frontendId,clientMessageId:linkedMessageId,discovered:true},title:'Online'};};
    return f;
  };
  const cold=make();assert.equal(await runCloudTerminal({...options,threadId:undefined,titleContext:cold.source},cold.dependencies),0);
  assert.equal(scans,1);assert.ok(stored);const savedAt=stored.savedAt;
  const warm=make();assert.equal(await runCloudTerminal({...options,threadId:undefined,titleContext:warm.source},warm.dependencies),0);
  assert.equal(scans,1);assert.equal(stored.savedAt,savedAt,'cache hits never extend the initial scan lifetime');
  assert.equal(warm.calls.filter(call=>call.attachment).length,2,'preflight proof then display attachment');
  const wrong=make();stored=undefined;wrong.attachment.state.turnHistory.history.entitiesByKey.latest.items[0].clientId=laterMessageId;
  await assert.rejects(runCloudTerminal({...options,threadId:undefined,titleContext:wrong.source},wrong.dependencies),{code:'CLOUD_IDENTITY_UNCONFIRMED'});
  assert.equal(stored,undefined);
});

test('a rejected recent probe falls back without navigating or publishing the rejected history',async()=>{
  const f=linkedFixture();f.dependencies.loadIdentityLinks=async()=>[];
  const list=await f.reader.listConversations();let scans=0,deletes=0,attempts=0;
  const memo=recentCloudCandidate(list,frontendId,id,{frontendId,clientMessageId:linkedMessageId},100000);
  f.dependencies.createRecentStore=()=>({get:async()=>memo,put:async()=>{},delete:async()=>{deletes++;}});
  f.dependencies.discoverCandidate=async()=>{scans++;return {native:f.native,evidence:{frontendId,clientMessageId:linkedMessageId,discovered:true},title:'Online'};};
  f.dependencies.createAttachment=async()=>{
    attempts++;if(attempts===1)throw Object.assign(Error('no owner'),{code:'NO_OWNER'});return f.attachment;
  };
  assert.equal(await runCloudTerminal({...options,threadId:undefined,titleContext:f.source},f.dependencies),0);
  assert.equal(scans,1);assert.equal(deletes,1);assert.equal(attempts,2);
});

test('a receipt changing after a recent probe closes the attempt then performs fresh discovery once',async()=>{
  const f=linkedFixture();f.dependencies.loadIdentityLinks=async()=>[];
  const list=await f.reader.listConversations();let memo=recentCloudCandidate(list,frontendId,id,{frontendId,clientMessageId:linkedMessageId},100000);
  let attempts=0,scans=0;
  f.dependencies.createRecentStore=()=>({get:async()=>memo,put:async()=>{},delete:async()=>{memo=null;}});
  f.dependencies.discoverCandidate=async()=>{scans++;assert.ok(f.calls.includes('reader.close'));return {native:f.native,evidence:{frontendId,clientMessageId:linkedMessageId,discovered:true},title:'Online'};};
  f.dependencies.createAttachment=async()=>{
    attempts++;const state=structuredClone(f.attachment.state);
    if(attempts===2)state.turnHistory.history.entitiesByKey.latest.items[0].clientId=laterMessageId;
    return {...f.attachment,state};
  };
  assert.equal(await runCloudTerminal({...options,threadId:undefined,titleContext:f.source},f.dependencies),0);
  assert.equal(scans,1);assert.equal(attempts,3);assert.equal(f.calls.filter(call=>call.launch).length,1);
});

test('a local chat sharing the frontend title cannot trigger automatic cloud discovery', async()=>{
  const f=linkedFixture(); f.dependencies.loadIdentityLinks=async()=>[];
  const list=await f.reader.listConversations();
  f.reader.listConversations=async()=>({...list,threads:[...list.threads,{id:laterMessageId,kind:'codex',hostId:'local',title:'Online'}]});
  f.dependencies.discoverCandidate=()=>assert.fail('must not infer cloud from an ambiguous page title');
  let choices=0; f.dependencies.chooseThread=async()=>{choices++;return id;};
  assert.equal(await runCloudTerminal({...options,threadId:undefined,titleContext:f.source},f.dependencies),0);
  assert.equal(choices,1);
});
