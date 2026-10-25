import { createHash, randomUUID } from 'node:crypto';
import { open, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { frontendMessageEvidence } from './cloud-identity-links.mjs';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const validId = value => typeof value === 'string' && UUID.test(value) && value !== '00000000-0000-0000-0000-000000000000';
const TTL = 5 * 60 * 1000;
const fields = ['frontendId', 'nativeId', 'clientMessageId', 'directoryDigest', 'savedAt'];
function validRecord(row, now) {
  return row && Object.keys(row).length === fields.length && fields.every(key => Object.hasOwn(row,key)) &&
    ['frontendId','nativeId','clientMessageId'].every(key=>validId(row[key])) && row.frontendId !== row.nativeId &&
    /^[a-f0-9]{64}$/.test(row.directoryDigest) && Number.isSafeInteger(row.savedAt) &&
    row.savedAt > 0 && row.savedAt <= now && now - row.savedAt < TTL;
}

// A recent successful candidate is not a permanent identity binding. Require a
// fresh directory with the same competing candidates and idle revision stamps.
// Any active competitor or unavailable metadata disables this optimization.
export function cloudCandidateDirectoryDigest(list, frontendId, nativeId) {
  if (!validId(frontendId) || !validId(nativeId) || !Array.isArray(list?.threads) ||
      (list.pinnedThreads !== undefined && !Array.isArray(list.pinnedThreads))) return null;
  const rows = new Map(); let foundFrontend = false, foundNative = false;
  for (const row of [...(list.pinnedThreads ?? []), ...list.threads]) {
    if (row?.kind !== 'chatgpt' && !(row?.kind === 'codex' && row.hostId === 'durable')) continue;
    if (!validId(row.id) || !(row.title == null || typeof row.title === 'string' && row.title.length <= 512)) return null;
    if (row.id === frontendId) { if (row.kind !== 'chatgpt') return null; foundFrontend = true; }
    if (row.id === nativeId) { if (row.kind !== 'codex') return null; foundNative = true; }
    const value = [row.id,row.kind,row.title ?? null];
    if (row.kind === 'codex' && row.id !== nativeId) {
      if (row.status !== 'idle' || !Number.isFinite(row.updatedAt) || row.updatedAt <= 0) return null;
      value.push(row.updatedAt);
    }
    const encoded = JSON.stringify(value);
    if (rows.has(row.id) && rows.get(row.id) !== encoded) return null;
    rows.set(row.id,encoded);
  }
  if (!foundFrontend || !foundNative || rows.size > 128) return null;
  return createHash('sha256').update(JSON.stringify([...rows.values()].sort())).digest('hex');
}

export function recentCloudCandidate(list, frontendId, nativeId, evidence, now = Date.now()) {
  const directoryDigest = cloudCandidateDirectoryDigest(list,frontendId,nativeId);
  const row = { frontendId,nativeId,clientMessageId:evidence?.clientMessageId,directoryDigest,savedAt:now };
  return evidence?.frontendId === frontendId && validRecord(row,now) ? row : null;
}

// Stored only inside this tray run. Atomic replacement can lose a concurrent
// optimization entry, but can never create a partial file or grant authority.
export function createRecentCloudStore(directory, { now = Date.now } = {}) {
  const file = join(directory,'cloud-recent-candidates.json');
  const read = async () => {
    let handle;
    try {
      handle = await open(file,'r');
      const buffer = Buffer.alloc(32769), {bytesRead} = await handle.read(buffer,0,buffer.length,0);
      if (bytesRead > 32768) return [];
      const data = JSON.parse(buffer.subarray(0,bytesRead).toString('utf8'));
      if (!data || Object.keys(data).length !== 2 || data.version !== 1 || !Array.isArray(data.entries) || data.entries.length > 64) return [];
      const entries = data.entries.filter(row=>validRecord(row,now()));
      if (new Set(entries.map(row=>row.frontendId)).size !== entries.length) return [];
      return entries;
    } catch { return []; } finally { await handle?.close().catch(()=>{}); }
  };
  const update = async (frontendId,row) => {
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
      if (!validId(frontendId)) return;
      const entries = (await read()).filter(item=>item.frontendId !== frontendId);
      if (row && validRecord(row,now())) entries.push(row);
      entries.sort((a,b)=>b.savedAt-a.savedAt);
      await writeFile(temporary,JSON.stringify({version:1,entries:entries.slice(0,64)}),{flag:'wx',mode:0o600});
      await rename(temporary,file);
    } catch { /* Optimization storage never blocks a connection. */ }
    finally { await unlink(temporary).catch(()=>{}); }
  };
  return { get:async frontendId=>(await read()).find(row=>row.frontendId===frontendId),
    put:row=>row ? update(row.frontendId,row) : Promise.resolve(), delete:frontendId=>update(frontendId) };
}

export async function tryRecentCloudCandidate(list, frontend, read, record, verify,
  { signal, now = Date.now, timeoutMs = 6000 } = {}) {
  if (!validRecord(record,now()) || record.frontendId !== frontend.id ||
      cloudCandidateDirectoryDigest(list,frontend.id,record.nativeId) !== record.directoryDigest || signal?.aborted) return null;
  const controller = new AbortController(), abort=()=>controller.abort();
  signal?.addEventListener('abort',abort,{once:true});
  let timer;
  const stopped = new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(null);},timeoutMs);
    controller.signal.addEventListener('abort',()=>resolve(null),{once:true});});
  const operation = async () => {
    const [source,native] = await Promise.all([
      read(frontend.id,{turnLimit:1,maxOutputCharsPerItem:1}),
      read(record.nativeId,{hostId:'durable',turnLimit:1,maxOutputCharsPerItem:1}),
    ]);
    const evidence = frontendMessageEvidence(source,frontend.id,frontend.title);
    if (controller.signal.aborted || evidence?.clientMessageId !== record.clientMessageId ||
        native.thread?.id !== record.nativeId || native.thread.kind !== 'codex' || native.thread.hostId !== 'durable') return null;
    if (!await verify(record.nativeId,evidence,controller.signal) || controller.signal.aborted) return null;
    return {native,evidence:{...evidence,discovered:true},title:frontend.title};
  };
  try { return await Promise.race([operation(),stopped]); } catch { return null; }
  finally { clearTimeout(timer);controller.abort();signal?.removeEventListener('abort',abort); }
}
