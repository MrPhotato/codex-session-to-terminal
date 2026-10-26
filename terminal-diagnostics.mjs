import { open, lstat, writeFile, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const FILE = 'terminal-status.json';
const phases = new Set(['starting','listing','matching','attaching','connected','viewing','closed','failed']);
const readers = new Set(['not-started','active','closing','released','cleanup-failed']);
const times = new Set(['createHome','createReader','listConversations','linkedRead','candidateRead','titleRecheck','discoverIdentity','attach']);
const integer = (n, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(n) && n >= 0 && n <= max;
const noop = Object.freeze({ update(){}, frame(){}, async close(){} });

// No transcript, title, session ID, endpoint, token, arguments or environment is
// accepted by this wire format. These observations cannot authorize a connection.
function clean(value) {
  if (!value || value.version !== 1 || !integer(value.pid, 2147483647) || !value.pid ||
      !['local','readonly'].includes(value.mode) || !phases.has(value.phase)) throw Error('INVALID_DIAGNOSTICS');
  const result = { version:1, pid:value.pid, mode:value.mode, phase:value.phase };
  for (const key of ['updatedAt','elapsedMs','firstScreenMs','frames','queries','queryErrors','cliPid','cols','rows']) {
    if (integer(value[key])) result[key] = value[key];
  }
  for (const key of ['identityVerified','bodyVisible','composerReady','readonlyBannerVisible','titleApplied','outputBackpressured','compact']) {
    if (typeof value[key] === 'boolean') result[key] = value[key];
  }
  if (readers.has(value.reader)) result.reader = value.reader;
  if (Number.isInteger(value.exitCode) && Math.abs(value.exitCode) <= 2147483647) result.exitCode = value.exitCode;
  if (typeof value.errorCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value.errorCode)) result.errorCode = value.errorCode;
  result.timingsMs = {};
  for (const [key, n] of Object.entries(value.timingsMs ?? {})) if (times.has(key) && integer(n)) result.timingsMs[key] = n;
  return result;
}

async function save(directory, value) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error('INVALID_DIAGNOSTICS_DIRECTORY');
  const temporary = join(directory, `.terminal-status-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(value) + '\n', { flag:'wx', mode:0o600 });
    await rename(temporary, join(directory, FILE));
  } finally { await unlink(temporary).catch(()=>{}); }
}

/** One bounded, coalesced snapshot per terminal; no listener, polling or server.
 * Writes happen only after state changes and at most once per second. Closing
 * flushes one final snapshot. Failed diagnostic IO never stops the terminal. */
export function createTerminalDiagnostics(directory, { mode='readonly', pid=process.pid,
  clock=()=>performance.now(), wallClock=Date.now, saveSnapshot=save, intervalMs=1000 } = {}) {
  if (!isAbsolute(directory ?? '') || !['local','readonly'].includes(mode)) return noop;
  const started=clock(); let state={version:1,pid,mode,phase:'starting',reader:'not-started',frames:0,queries:0,queryErrors:0,timingsMs:{}};
  let closed=false, dirty=false, writing, timer, lastWrite=-Infinity;
  const elapsed=()=>Math.max(0,Math.round(clock()-started));
  const flush=()=>{
    if (writing) return writing;
    if (!dirty) return Promise.resolve();
    dirty=false;lastWrite=clock();
    let value;
    try { value=clean({...state,updatedAt:wallClock(),elapsedMs:elapsed()}); } catch { return Promise.resolve(); }
    writing=Promise.resolve().then(()=>saveSnapshot(directory,value)).catch(()=>{}).finally(()=>{
      writing=undefined;
      if(dirty&&!closed)schedule();
    });
    return writing;
  };
  const schedule=()=>{
    dirty=true;
    if(!timer&&!writing) {
      timer=setTimeout(()=>{timer=undefined;void flush();},Math.max(0,intervalMs-(clock()-lastWrite)));
      timer.unref?.();
    }
  };
  const update=patch=>{
    if(closed)return;
    try { state=clean({...state,...patch,timingsMs:{...state.timingsMs,...patch?.timingsMs}});schedule(); } catch {}
  };
  const frame=value=>{
    if(closed)return;
    const banner=value.lines?.includes('Online Session Read Only for Terminal')===true;
    const ready=value.composerReady===true&&!value.compact&&!value.outputBackpressured;
    update({frames:state.frames+1,cols:value.cols,rows:value.rows,cliPid:value.cliPid,
      bodyVisible:value.bodyVisible===true,composerReady:value.composerReady===true,
      readonlyBannerVisible:banner,titleApplied:value.titleApplied===true,
      outputBackpressured:value.outputBackpressured===true,compact:value.compact===true,
      ...(ready&&state.firstScreenMs===undefined?{firstScreenMs:elapsed()}:{}),
      ...(ready?{phase:'viewing'}:{})});
  };
  const close=async patch=>{
    if(closed)return;
    update({phase:'closed',...patch});closed=true;clearTimeout(timer);timer=undefined;
    await writing;await flush();
  };
  schedule();return {update,frame,close};
}

export async function readTerminalDiagnostics(directory) {
  if(!isAbsolute(directory ?? ''))throw Error('INVALID_DIAGNOSTICS_DIRECTORY');
  const parent=await lstat(directory), path=join(directory,FILE), info=await lstat(path);
  if(!parent.isDirectory()||parent.isSymbolicLink()||!info.isFile()||info.isSymbolicLink()||info.size>8192)throw Error('INVALID_DIAGNOSTICS');
  const file=await open(path,'r');
  try {
    const bytes=Buffer.alloc(8193),{bytesRead}=await file.read(bytes,0,bytes.length,0);
    if(bytesRead>8192)throw Error('INVALID_DIAGNOSTICS');
    return clean(JSON.parse(bytes.subarray(0,bytesRead).toString('utf8')));
  } finally { await file.close(); }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try {
    if(process.argv.length!==4||process.argv[2]!=='--directory')throw Error('INVALID_ARGUMENTS');
    process.stdout.write(JSON.stringify(await readTerminalDiagnostics(process.argv[3]),null,2)+'\n');
  } catch { process.stderr.write('Cannot read terminal diagnostics. Use --directory <absolute terminal directory>.\n');process.exitCode=1; }
}
