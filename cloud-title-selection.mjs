const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const EMPTY_UUID = '00000000-0000-0000-0000-000000000000';
const UNSAFE_TITLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const GENERIC_TITLE = /^\s*(?:ChatGPT|Codex|New chat|New thread|New conversation|Untitled|Untitled chat|新聊天|新对话|新会话|未命名|未命名聊天|未命名会话)\s*$/iu;

function nativeId(value) {
  return typeof value === 'string' && value.length === 36 && UUID.test(value) && value !== EMPTY_UUID
    ? value.toLowerCase() : null;
}

function usableTitle(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 &&
    /\S/u.test(value) && !UNSAFE_TITLE.test(value) && !GENERIC_TITLE.test(value);
}

/** Return a native durable ID suggested by an exact raw UI title, or null.
 * This is a read-only selection heuristic within the supplied directory, not
 * proof of a frontend/native identity mapping or global title uniqueness.
 * Never pass cleaned/truncated display titles to this function.
 */
export function matchCloudThreadByTitle(list, rawTitle) {
  if (!usableTitle(rawTitle) || !list || typeof list !== 'object' || Array.isArray(list)) return null;
  for (const key of ['threads', 'pinnedThreads']) {
    if (list[key] !== undefined && !Array.isArray(list[key])) return null;
  }
  const records = new Map(), conflicts = new Set(), matchingIds = new Set();
  for (const row of [...(list.pinnedThreads ?? []), ...(list.threads ?? [])]) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const id = nativeId(row.id);
    if (row.title === rawTitle) {
      if (!id) return null;
      matchingIds.add(id);
    }
    if (!id) continue;
    const prior = records.get(id);
    if (prior && (prior.title !== row.title || prior.kind !== row.kind ||
        (prior.hostId ?? null) !== (row.hostId ?? null))) conflicts.add(id);
    else if (!prior) records.set(id, row);
  }

  let frontendId = null, durableId = null;
  for (const id of matchingIds) {
    if (conflicts.has(id)) return null;
    const row = records.get(id);
    if (row.kind === 'chatgpt') {
      if (frontendId) return null;
      frontendId = id;
    } else if (row.kind === 'codex' && row.hostId === 'durable') {
      if (durableId) return null;
      durableId = id;
    } else {
      // A local/other-host native chat or an unknown kind makes this title
      // ambiguous even if a durable candidate also exists.
      return null;
    }
  }
  return frontendId && durableId ? durableId : null;
}

/** Recheck the selected native thread and raw title using readConversation.
 * This confirms the candidate has not changed; it does not establish that the
 * observed frontend page and this native thread have the same identity.
 */
export function matchesCloudTitleRead(readResult, threadId, rawTitle) {
  const id = nativeId(threadId), thread = readResult?.thread;
  return id !== null && usableTitle(rawTitle) && thread?.kind === 'codex' &&
    thread.hostId === 'durable' && nativeId(thread.id) === id && thread.title === rawTitle;
}
