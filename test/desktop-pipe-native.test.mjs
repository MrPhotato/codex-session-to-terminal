import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

test('compiled Windows pipe transport validates peers and preserves binary output', {skip:process.platform!=='win32',timeout:90000}, async t => {
  const directory=await mkdtemp(join(tmpdir(),'cst-native-pipe-'));
  t.after(()=>{assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert(directory.includes('cst-native-pipe-'));return rm(directory,{recursive:true,force:true});});
  const located=spawnSync('where.exe',['pwsh.exe'],{windowsHide:true,encoding:'utf8'}).stdout?.trim().split(/\r?\n/)??[];
  const powershell=[process.env.CST_TEST_POWERSHELL,...located,join(homedir(),'.cache','codex-runtimes','codex-primary-runtime','dependencies','native','powershell','pwsh.exe')].find(p=>p&&existsSync(p));
  assert(powershell);
  const root=fileURLToPath(new URL('../',import.meta.url));
  const build=spawnSync(powershell,['-NoProfile','-File',join(root,'Build-Pipe.ps1'),'-OutputDirectory',directory],{windowsHide:true,encoding:'utf8',timeout:15000});
  assert.equal(build.status,0,build.stdout+build.stderr);
  const helper=join(directory,'Desktop-Pipe.exe');
  assert.deepEqual(JSON.parse(spawnSync(helper,['--check'],{windowsHide:true,encoding:'utf8'}).stdout),{version:1,ready:true});
  await t.test('invalid names cannot open arbitrary pipes or interpret commands',()=>{
    for(const name of ['unrelated-pipe','codex-app-tools-invalid','codex-ipc\n','codex-ipc; Write-Output BAD']){
      const result=spawnSync(helper,['--pipe',name],{windowsHide:true,encoding:'utf8',timeout:3000});
      assert.equal(result.status,1);assert.equal(result.stdout,'');assert.doesNotMatch(result.stderr,/CST_PIPE_VERIFIED/);
    }
  });
  await t.test('a same-user impostor pipe receives no traffic and no readiness marker',async t=>{
    const name='codex-app-tools-'+randomUUID(), sockets=new Set();let received=0,connected=false;
    const server=createServer(socket=>{connected=true;sockets.add(socket);socket.on('data',bytes=>{received+=bytes.length;});socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));});
    t.after(()=>{for(const socket of sockets)socket.destroy();server.close();});
    server.listen('\\\\.\\pipe\\'+name);await once(server,'listening');
    const child=spawn(helper,['--pipe',name],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let output='',diagnostic=''; child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>diagnostic+=b);
    child.stdin.on('error',()=>{});child.stdin.write('must never reach an unverified server');
    const timer=setTimeout(()=>child.kill(),10000); const [code]=await once(child,'close');clearTimeout(timer);
    assert.equal(connected,true,'The fixture must accept a connection; a connect timeout does not test peer verification.');
    assert.equal(code,1);assert.equal(output,'');assert.equal(received,0);assert.doesNotMatch(diagnostic,/CST_PIPE_VERIFIED/);
  });
  await t.test('the exact native copy routine survives Windows stdout backpressure',async()=>{
    const fixture=join(directory,'CopyFixture.cs'), exe=join(directory,'CopyFixture.exe');
    await writeFile(fixture,'public static class CopyFixture { public static void Main() { CstDesktopPipe.Program.CopyToStdout(System.Console.OpenStandardInput()).GetAwaiter().GetResult(); } }');
    const compiler=join(process.env.WINDIR,'Microsoft.NET','Framework64','v4.0.30319','csc.exe');
    const compile=spawnSync(compiler,['/nologo','/target:exe','/platform:x64','/optimize+','/main:CopyFixture','/out:'+exe,join(root,'Desktop-Pipe.cs'),join(root,'Desktop-Navigation.cs'),fixture],{windowsHide:true,encoding:'utf8',timeout:10000});
    assert.equal(compile.status,0,compile.stdout+compile.stderr);
    const payload=Buffer.allocUnsafe(14*1024*1024+81919);for(let i=0;i<payload.length;i++)payload[i]=i%251;
    const expected=createHash('sha256').update(payload).digest('hex'), hash=createHash('sha256');
    const child=spawn(exe,[],{windowsHide:true,stdio:['pipe','pipe','pipe']});let count=0,chunks=0,diagnostics='',resume;
    child.stderr.on('data',b=>diagnostics+=b);
    child.stdout.on('data',bytes=>{count+=bytes.length;hash.update(bytes);if(++chunks%4===0){child.stdout.pause();resume=setTimeout(()=>child.stdout.resume(),20);}});
    const timer=setTimeout(()=>child.kill(),30000);child.stdin.end(payload);
    const [code]=await once(child,'close');clearTimeout(timer);clearTimeout(resume);
    assert.equal(code,0,diagnostics);assert.equal(diagnostics,'');assert.equal(count,payload.length);assert.equal(hash.digest('hex'),expected);
  });
});
