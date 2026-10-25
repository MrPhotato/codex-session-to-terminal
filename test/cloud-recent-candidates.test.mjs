import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloudCandidateDirectoryDigest, recentCloudCandidate, createRecentCloudStore, tryRecentCloudCandidate } from '../cloud-recent-candidates.mjs';
const frontendId='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',nativeId='11111111-2222-4333-8444-555555555555';
const clientMessageId='22222222-3333-4444-8555-666666666666',otherId='99999999-8888-4777-8666-555555555555';
const now=1000000;
const frontend={id:frontendId,kind:'chatgpt',title:'A cloud conversation'};
const native={id:nativeId,kind:'codex',hostId:'durable',title:null,status:'active',updatedAt:200};
const other={...native,id:otherId,status:'idle',updatedAt:100};
const list=()=>({threads:[frontend,native,other],pinnedThreads:[]});
const evidence={frontendId,clientMessageId};
const record=()=>recentCloudCandidate(list(),frontendId,nativeId,evidence,now);
const read=async id=>id===frontendId?{thread:frontend,page:{order:'newest_first'},turns:[{items:[{type:'userMessage',id:clientMessageId}]}]}:{thread:native};

test('directory digest ignores ordering and current output updates, rejects changed or active competitors',()=>{
  const digest=record().directoryDigest;
  const reordered=list();reordered.threads.reverse();reordered.pinnedThreads.push(frontend);
  assert.equal(cloudCandidateDirectoryDigest(reordered,frontendId,nativeId),digest);
  const progressing=list();progressing.threads[1]={...native,updatedAt:999};
  assert.equal(cloudCandidateDirectoryDigest(progressing,frontendId,nativeId),digest);
  for(const change of [l=>l.threads.push({...other,id:clientMessageId}),l=>l.threads.pop(),
    l=>l.threads[2]={...other,updatedAt:101},l=>l.threads[0]={...frontend,title:'Renamed'},
    l=>l.threads[2]={...other,status:'active'},l=>l.threads[2]={...other,updatedAt:undefined},
    l=>l.threads.push({...other,title:'Conflicting duplicate'}),l=>l.threads[1]={...native,hostId:'local'}]){
    const value=list();change(value);assert.notEqual(cloudCandidateDirectoryDigest(value,frontendId,nativeId),digest);
  }
});

test('recent path reads just the two identities and still requires a native snapshot proof',async()=>{
  const calls=[];let proofs=0;
  const result=await tryRecentCloudCandidate(list(),frontend,async(id,args)=>{calls.push(id);return read(id,args);},record(),
    async(id,ev,signal)=>{proofs++;assert.equal(id,nativeId);assert.deepEqual(ev,evidence);assert.equal(signal.aborted,false);return true;},{now:()=>now});
  assert.equal(result.native.thread.id,nativeId);assert.equal(proofs,1);assert.deepEqual(calls,[frontendId,nativeId]);
  assert.equal(await tryRecentCloudCandidate(list(),frontend,read,record(),async()=>false,{now:()=>now}),null);
});

test('stale receipts, changed directory, expiration, unknown fields and failed reads cannot bypass discovery',async()=>{
  for(const mode of ['message','directory','expired','future','polluted','failed','wrong-native']){
    const value=list(),memo=record();let proofs=0;
    if(mode==='directory')value.threads.push({...other,id:clientMessageId});
    if(mode==='expired')memo.savedAt=now-300000;
    if(mode==='future')memo.savedAt=now+1;
    if(mode==='polluted')memo.body='unwanted';
    const reader=async id=>{
      if(mode==='failed')throw Error('unavailable');
      const result=structuredClone(await read(id));
      if(mode==='message'&&id===frontendId)result.turns[0].items[0].id=otherId;
      if(mode==='wrong-native'&&id===nativeId)result.thread.hostId='local';
      return result;
    };
    assert.equal(await tryRecentCloudCandidate(value,frontend,reader,memo,async()=>{proofs++;return true;},{now:()=>now}),null,mode);
    assert.equal(proofs,0,mode);
  }
});

test('cancellation and deadlines suppress late verification and abort a running probe',async()=>{
  let resolveRead,proofs=0;
  assert.equal(await tryRecentCloudCandidate(list(),frontend,id=>id===frontendId?new Promise(r=>{resolveRead=r;}):read(id),record(),async()=>{proofs++;return true;},{now:()=>now,timeoutMs:10}),null);
  resolveRead(await read(frontendId));await new Promise(r=>setImmediate(r));assert.equal(proofs,0);
  let probeSignal;
  assert.equal(await tryRecentCloudCandidate(list(),frontend,read,record(),async(_id,_ev,signal)=>{
    probeSignal=signal;return new Promise(resolve=>signal.addEventListener('abort',()=>resolve(false),{once:true}));
  },{now:()=>now,timeoutMs:10}),null);
  assert.equal(probeSignal.aborted,true);
});

test('run-local store is bounded, expires without renewal and stores neither titles nor message bodies',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'cst-recent-'));let clock=now;
  try{
    const store=createRecentCloudStore(directory,{now:()=>clock});
    await store.put(record());assert.deepEqual(await store.get(frontendId),record());
    const text=await readFile(join(directory,'cloud-recent-candidates.json'),'utf8');
    assert.equal(text.includes(frontend.title),false);assert.equal(text.includes('content'),false);
    clock+=299999;assert.ok(await store.get(frontendId));clock++;assert.equal(await store.get(frontendId),undefined);
    clock=now;await store.put(record());await store.delete(frontendId);assert.equal(await store.get(frontendId),undefined);
    for(const value of ['{','x'.repeat(32769),JSON.stringify({version:1,entries:[record(),record()]})]){
      await writeFile(join(directory,'cloud-recent-candidates.json'),value);assert.equal(await store.get(frontendId),undefined);
    }
    const broken=createRecentCloudStore(join(directory,'absent'));await broken.put(record());assert.equal(await broken.get(frontendId),undefined);
  }finally{await rm(directory,{recursive:true,force:true});}
});
