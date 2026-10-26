import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createTerminalDiagnostics, readTerminalDiagnostics } from '../terminal-diagnostics.mjs';

test('snapshot accepts observations but never content, identity or credentials',async()=>{
  const snapshots=[];let time=10;
  const observer=createTerminalDiagnostics(resolve('diagnostics'),{clock:()=>time,wallClock:()=>123,
    saveSnapshot:async(_directory,value)=>snapshots.push(value)});
  observer.update({phase:'connected',identityVerified:true,title:'SECRET',threadId:'SECRET',token:'SECRET',
    timingsMs:{attach:12,SECRET:100},errorCode:'SECRET RESPONSE WITH SPACES'});
  time=60;
  observer.frame({lines:['SECRET transcript','Online Session Read Only for Terminal'],cols:100,rows:30,cliPid:1234,
    composerReady:true,bodyVisible:true,titleApplied:true});
  await observer.close();
  assert.equal(JSON.stringify(snapshots).includes('SECRET'),false);
  const final=snapshots.at(-1);
  assert.equal(final.firstScreenMs,50);assert.equal(final.updatedAt,123);
  assert.equal(final.phase,'closed');assert.equal(final.readonlyBannerVisible,true);
  assert.deepEqual(final.timingsMs,{attach:12});
});

test('loading, backpressure and compact screens cannot claim the first rendered screen',async()=>{
  let final,time=0;
  const observer=createTerminalDiagnostics(resolve('diagnostics'),{clock:()=>time,saveSnapshot:async(_directory,value)=>{final=value;}});
  observer.frame({composerReady:false});time=10;
  observer.frame({composerReady:true,compact:true});time=20;
  observer.frame({composerReady:true,outputBackpressured:true});
  await observer.close();assert.equal(final.firstScreenMs,undefined);
});

test('writes coalesce while one save is pending and closing flushes the final state',async()=>{
  const snapshots=[];let release;
  const observer=createTerminalDiagnostics(resolve('diagnostics'),{saveSnapshot:async(_directory,value)=>{
    snapshots.push(value);if(snapshots.length===1)await new Promise(resolve=>{release=resolve;});
  }});
  while(!release)await new Promise(r=>setTimeout(r,2));
  for(let n=0;n<100;n++)observer.update({queries:n});
  assert.equal(snapshots.length,1);
  const closing=observer.close({phase:'failed',errorCode:'NO_OWNER'});release();await closing;
  assert.equal(snapshots.length,2);assert.equal(snapshots[1].queries,99);assert.equal(snapshots[1].phase,'failed');
  observer.update({phase:'viewing'});await observer.close();assert.equal(snapshots.length,2);
});

test('diagnostic I/O failure does not reject terminal cleanup',async()=>{
  const observer=createTerminalDiagnostics(resolve('diagnostics'),{saveSnapshot:async()=>{throw Error('disk unavailable');}});
  observer.update({phase:'viewing'});await observer.close();
  await createTerminalDiagnostics('relative').close();
});

test('bounded readback sanitizes the file and rejects malformed or oversized snapshots',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'cst-diagnostic-test-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const observer=createTerminalDiagnostics(directory);observer.update({phase:'viewing',identityVerified:true});await observer.close();
  assert.equal((await readTerminalDiagnostics(directory)).phase,'closed');
  for(const content of ['not json','x'.repeat(8193),JSON.stringify({version:1,pid:0,mode:'local',phase:'viewing'})]) {
    await writeFile(join(directory,'terminal-status.json'),content);
    await assert.rejects(readTerminalDiagnostics(directory));
  }
  await writeFile(join(directory,'terminal-status.json'),JSON.stringify({version:1,pid:1,mode:'local',phase:'viewing',title:'SECRET'}));
  assert.equal(JSON.stringify(await readTerminalDiagnostics(directory)).includes('SECRET'),false);
});
