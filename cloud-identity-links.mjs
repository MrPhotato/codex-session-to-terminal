import { orderedDesktopTurns } from './desktop-events.mjs';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const ZERO = '00000000-0000-0000-0000-000000000000';
const LINK_KEYS = ['frontendId', 'nativeId', 'verifiedClientMessageId', 'verification'];
const GENERIC_TITLE = /^\s*(?:ChatGPT|Codex|New chat|New thread|New conversation|Untitled|Untitled chat|新聊天|新对话|新会话|未命名|未命名聊天|未命名会话)\s*$/iu;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && value.length === 36 && UUID.test(value) && value !== ZERO
  ? value.toLowerCase() : null;
const title = value => typeof value === 'string' && value.length > 0 && value.length <= 512 &&
  /\S/u.test(value) && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) && !GENERIC_TITLE.test(value);
const keys = (value, expected) => object(value) && Object.keys(value).length === expected.length &&
  expected.every(key => Object.hasOwn(value, key));

function normalizedLinks(links) {
  if (!Array.isArray(links) || links.length > 128) return null;
  const frontends = new Map(), natives = new Map();
  for (const row of links) {
    if (!keys(row, LINK_KEYS) || row.verification !== 'observed-message-link') return null;
    const frontendId = id(row.frontendId), nativeId = id(row.nativeId), verifiedClientMessageId = id(row.verifiedClientMessageId);
    if (!frontendId || !nativeId || !verifiedClientMessageId || frontendId === nativeId) return null;
    const prior = frontends.get(frontendId);
    if (prior && (prior.nativeId !== nativeId || prior.verifiedClientMessageId !== verifiedClientMessageId) ||
        natives.has(nativeId) && natives.get(nativeId) !== frontendId) return null;
    if (!prior) frontends.set(frontendId, Object.freeze({ frontendId, nativeId, verifiedClientMessageId,
      verification: 'observed-message-link' }));
    natives.set(nativeId, frontendId);
  }
  return Object.freeze([...frontends.values()]);
}

// These are manually/research-checked candidates, never automatically discovered
// bindings. A shared client message ID proves message ancestry, not global fork
// uniqueness. Initial enrollment needs independent human/page verification;
// every use still requires fresh frontend and native message evidence.
export function parseCloudIdentityLinks(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 64 * 1024) return null;
  try {
    const value = JSON.parse(text);
    return keys(value, ['version', 'links']) && value.version === 1 ? normalizedLinks(value.links) : null;
  } catch { return null; }
}

export function findLinkedCloudCandidate(list, rawTitle, links) {
  const candidates = normalizedLinks(links);
  if (!candidates || !title(rawTitle) || !object(list)) return null;
  for (const key of ['threads', 'pinnedThreads']) {
    if (list[key] !== undefined && !Array.isArray(list[key])) return null;
  }
  const records = new Map(), conflicts = new Set(), frontends = new Set();
  for (const row of [...(list.pinnedThreads ?? []), ...(list.threads ?? [])]) {
    if (!object(row)) continue;
    const rowId = id(row.id);
    if (row.title === rawTitle) {
      if (!rowId) return null;
      if (row.kind === 'chatgpt') frontends.add(rowId);
      else if (row.kind !== 'codex' || row.hostId !== 'durable') return null;
    }
    if (!rowId) continue;
    const prior = records.get(rowId);
    if (prior && (prior.kind !== row.kind || prior.title !== row.title ||
        (prior.hostId ?? null) !== (row.hostId ?? null))) conflicts.add(rowId);
    else if (!prior) records.set(rowId, row);
  }
  if (frontends.size !== 1) return null;
  const frontendId = [...frontends][0];
  const link = candidates.find(row => row.frontendId === frontendId);
  if (!link || conflicts.has(frontendId) || conflicts.has(link.nativeId)) return null;
  const native = records.get(link.nativeId);
  return !native || native.kind === 'codex' && native.hostId === 'durable' ? link : null;
}

export function frontendMessageEvidence(read, frontendId, rawTitle) {
  const expectedId = id(frontendId), thread = read?.thread;
  if (!expectedId || !title(rawTitle) || thread?.kind !== 'chatgpt' || id(thread.id) !== expectedId ||
      thread.title !== rawTitle || read?.page?.order !== 'newest_first' || !Array.isArray(read.turns)) return null;
  const latest = read.turns[0];
  if (!Array.isArray(latest?.items)) return null;
  const users = latest.items.filter(item => item?.type === 'userMessage');
  if (users.length !== 1) return null;
  const clientMessageId = id(users[0].id);
  return clientMessageId ? Object.freeze({ frontendId: expectedId, clientMessageId }) : null;
}

export function matchesCloudMessageEvidence(state, nativeId, evidence) {
  const expectedId = id(nativeId), clientMessageId = id(evidence?.clientMessageId);
  if (!expectedId || !clientMessageId || !id(evidence?.frontendId) || id(state?.id) !== expectedId ||
      state.hostId !== 'durable' || state.turnHistory?.kind !== 'canonical') return false;
  const history = state.turnHistory.history;
  if (!object(history?.entitiesByKey) || !Array.isArray(history?.islands)) return false;
  const tail = history.islands.at(-1);
  if (!Array.isArray(tail?.entries) || tail.newerBoundary?.status !== 'exhausted') return false;
  const tailKey = tail.entries.at(-1)?.value;
  if (typeof tailKey !== 'string' || !Object.hasOwn(history.entitiesByKey, tailKey)) return false;
  const canonicalLatest = history.entitiesByKey[tailKey];
  let latest;
  try { latest = orderedDesktopTurns(state).at(-1); } catch { return false; }
  // Do not accept an older matching message, a disconnected history island, or
  // an optimistic turn appended after the authoritative current boundary.
  if (!latest || latest !== canonicalLatest || !Array.isArray(latest.items)) return false;
  const liveTurn = state.historyMode === 'legacy' &&
    (latest.status === 'inProgress' && state.threadRuntimeStatus?.type === 'active' ||
      ['completed', 'interrupted'].includes(latest.status) && state.threadRuntimeStatus?.type === 'idle') &&
    Number.isSafeInteger(latest.turnStartedAtMs) && latest.turnStartedAtMs > 0 &&
    id(latest.turnId) && object(latest.params) && latest.itemsPagination == null;
  if (!liveTurn && (latest.itemsPagination?.hasLoadedOldest !== true || latest.itemsPagination.evicted === true ||
      latest.itemsPagination.reconnect != null)) return false;
  const users = latest.items.filter(item => item?.type === 'userMessage');
  // Candidate provenance must not change message validation. Both a previously
  // checked link and a new discovery can receive live canonical turns, including
  // additional user input admitted into the same native turn after Continue.
  const ids = users.map(item => id(item.clientId));
  // Live/just-ended legacy turns (including interrupted ones) may lack
  // paginated-history fields and a root receipt. The latest
  // admitted ID must still match a fresh frontend read, and a supplied root ID
  // must agree with the first input. Incomplete paginated turns remain rejected.
  const rootId = latest.params?.clientUserMessageId;
  return users.length > 0 && latest.items[0] === users[0] && ids.every(Boolean) &&
    new Set(ids).size === ids.length && (id(rootId) === ids[0] || liveTurn && rootId == null) &&
    ids.at(-1) === clientMessageId &&
    !latest.items.some(item => item?.type === 'steeringUserMessage' && item.status === 'accepted');
}

export function cloudFrontends(list) {
  const records = new Map();
  for (const row of [...(list?.pinnedThreads ?? []), ...(list?.threads ?? [])]) {
    if (row?.kind !== 'chatgpt' || !id(row.id) || !title(row.title)) continue;
    const rowId = id(row.id);
    const prior = records.get(rowId);
    if (prior && prior.title !== row.title) return [];
    records.set(rowId, { id: rowId, title: row.title, kind: 'chatgpt' });
  }
  return [...records.values()];
}

function userTail(read, count = 2) {
  if (read?.page?.order !== 'newest_first' || !Array.isArray(read.turns)) return [];
  const users = read.turns.slice().reverse().flatMap(turn => turn.items ?? []).filter(item => item.type === 'userMessage');
  return users.slice(-count).map(item => {
    if (item.truncated || item.textTruncated || !Array.isArray(item.content) || item.content.length !== 1) return null;
    const part = item.content[0];
    return part.type === 'text' && typeof part.text === 'string' && part.text.length > 0 &&
      part.text.length < 4096 && !part.truncated ? part.text : null;
  });
}

// Text is used only to nominate a candidate for read-only ID verification.
// Never cache this suggestion or display its history before the native
// snapshot confirms the latest frontend client message ID. Scan every listed
// candidate; a failed read or a duplicate leaves the association unresolved.
export async function discoverCloudCandidate(list, frontend, read, { signal, timeoutMs = 45000, onDiagnostic = () => {} } = {}) {
  const startedAt = performance.now();
  const diagnostics = { version: 1, outcome: 'pending', candidates: 0, scanned: 0, matches: 0 };
  const controller = new AbortController();
  const cancelled = () => controller.abort();
  signal?.addEventListener('abort', cancelled, { once: true });
  let timer;
  const stopped = new Promise((_, reject) => {
    const abort = () => reject(Object.assign(new Error('CLOUD_DISCOVERY_TIMEOUT'), {
      code: signal?.aborted ? 'ABORTED' : 'CLOUD_DISCOVERY_TIMEOUT' }));
    controller.signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => controller.abort(), timeoutMs);
    if (signal?.aborted) controller.abort();
  });
  const operation = async () => {
    if (controller.signal.aborted) return null;
    // Most summaries expose one user message per turn. Read only the two turns
    // needed for nomination; retain the previous four-turn bound for summaries
    // that contain intermediate turns with no user input.
    const readTail = async (threadId, options = {}, expectedTail) => {
      let result = await read(threadId, { ...options, turnLimit: 2, maxOutputCharsPerItem: 4096 });
      const recent = userTail(result, expectedTail?.length ?? 4);
      // Older turns cannot repair an already different (or truncated) latest
      // user input. Exhausted histories cannot provide an older input either.
      const mayMatch = !expectedTail || recent.length === 0 || recent.at(-1) === expectedTail.at(-1);
      const needsOlder = expectedTail ? recent.length < expectedTail.length :
        recent.length < 2 || recent.every(Boolean) && recent.join('').length < 24;
      if (needsOlder && mayMatch && result.page?.hasMore !== false && !controller.signal.aborted) {
        result = await read(threadId, { ...options, turnLimit: 4, maxOutputCharsPerItem: 4096 });
      }
      return result;
    };
    const source = await readTail(frontend.id);
    const evidence = frontendMessageEvidence(source, frontend.id, frontend.title);
    let tail = userTail(source, 4);
    // Short replies are common. Keep the smallest suffix of 2–4 complete
    // inputs with enough text to nominate a candidate; native receipt proof is
    // still mandatory before showing anything from that candidate.
    while (tail.length > 2 && tail.slice(1).every(Boolean) && tail.slice(1).join('').length >= 24) tail = tail.slice(1);
    if (!evidence || tail.length < 2 || tail.some(value => !value) || tail.join('').length < 24) {
      diagnostics.outcome = 'invalid-source'; return null;
    }
    const natives = new Map();
    for (const row of [...(list.pinnedThreads ?? []), ...(list.threads ?? [])]) {
      if (row?.kind !== 'codex' || row.hostId !== 'durable' || !id(row.id)) continue;
      natives.set(row.id, row);
    }
    diagnostics.candidates = natives.size;
    if (natives.size > 64) { diagnostics.outcome = 'too-many-candidates'; return null; }
    const rows = [...natives.values()], matches = [];
    let next = 0, invalid = false;
    const scan = async () => {
     while (next < rows.length && !controller.signal.aborted && !invalid) {
      const row = rows[next++];
      const native = await readTail(row.id, { hostId: 'durable' }, tail);
      if (controller.signal.aborted) return;
      diagnostics.scanned++;
      if (native.thread?.id !== row.id || native.thread.kind !== 'codex' || native.thread.hostId !== 'durable') { invalid = true; return; }
      const other = userTail(native, tail.length);
      if (other.length === tail.length && tail.every((value, index) => value === other[index])) {
        matches.push({ native, evidence: { ...evidence, discovered: true }, title: frontend.title });
        diagnostics.matches = matches.length;
      }
     }
    };
    // Share one official reader process. Eight bounded queries overlap cloud
    // waits while leaving headroom under the reader's 16-request limit.
    // Every listed candidate still participates in the uniqueness check.
    await Promise.all(Array.from({ length: Math.min(8, rows.length) }, scan));
    if (invalid || matches.length !== 1 || controller.signal.aborted) {
      diagnostics.outcome = invalid ? 'invalid-candidate' : matches.length > 1 ? 'ambiguous' : 'no-match'; return null;
    }
    const match = matches[0];
    const fresh = await read(frontend.id, { turnLimit: 1, maxOutputCharsPerItem: 1 });
    const confirmed = frontendMessageEvidence(fresh, frontend.id, frontend.title)?.clientMessageId === evidence.clientMessageId;
    diagnostics.outcome = confirmed ? 'matched' : 'source-changed';
    return confirmed ? match : null;
  };
  try { return await Promise.race([operation(), stopped]); }
  catch (error) {
    if (controller.signal.aborted) {
      diagnostics.outcome = signal?.aborted ? 'aborted' : 'timeout'; throw error;
    }
    diagnostics.outcome = 'read-failed'; return null;
  }
  finally {
    controller.abort(); clearTimeout(timer); signal?.removeEventListener('abort', cancelled);
    try { onDiagnostic({ ...diagnostics, elapsedMs: Math.round(performance.now() - startedAt) }); } catch {}
  }
}
