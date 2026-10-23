import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCloudIdentityLinks, findLinkedCloudCandidate, frontendMessageEvidence,
  matchesCloudMessageEvidence } from '../cloud-identity-links.mjs';

const frontendId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const nativeId = '11111111-2222-4333-8444-555555555555';
const clientMessageId = '22222222-3333-4444-8555-666666666666';
const otherId = '99999999-8888-4777-8666-555555555555';
const rawTitle = 'A cloud conversation';
const link = (change = {}) => ({ frontendId, nativeId, verifiedClientMessageId: clientMessageId,
  verification: 'observed-message-link', ...change });
const encode = links => JSON.stringify({ version: 1, links });
const frontend = (change = {}) => ({ id: frontendId, kind: 'chatgpt', title: rawTitle, ...change });
const native = (change = {}) => ({ id: nativeId, kind: 'codex', hostId: 'durable', title: null, ...change });
const directory = (extra = []) => ({ threads: [frontend(), native(), ...extra], pinnedThreads: [] });
function frontendRead() {
  return { thread: frontend(), page: { order: 'newest_first' }, turns: [{ items: [
    { type: 'userMessage', id: clientMessageId }, { type: 'agentMessage', id: 'answer' },
  ] }] };
}
function nativeState() {
  const turn = { turnId: otherId, params: { clientUserMessageId: clientMessageId },
    itemsPagination: { hasLoadedOldest: true }, items: [
      { type: 'userMessage', id: 'native-user', clientId: clientMessageId },
      { type: 'agentMessage', id: 'native-answer' },
    ] };
  return { id: nativeId, hostId: 'durable', turns: [], turnHistory: { kind: 'canonical', history: {
    entitiesByKey: { turn }, islands: [{ entries: [{ value: 'turn' }],
      olderBoundary: { status: 'available' }, newerBoundary: { status: 'exhausted' } }],
  } } };
}
const evidence = () => ({ frontendId, clientMessageId });
const latestTurn = state => state.turnHistory.history.entitiesByKey.turn;

test('parses bounded candidate records, normalizes UUIDs and deduplicates exact copies', () => {
  const result = parseCloudIdentityLinks(encode([link(), link({ frontendId: frontendId.toUpperCase() })]));
  assert.deepEqual(result, [link()]);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result[0]));
  assert.deepEqual(parseCloudIdentityLinks(encode([])), []);
  const empty = encode([]), exactLimit = ' '.repeat(64 * 1024 - Buffer.byteLength(empty)) + empty;
  assert.deepEqual(parseCloudIdentityLinks(exactLimit), []);
  assert.equal(parseCloudIdentityLinks(' ' + exactLimit), null);
  assert.throws(() => { result[0].nativeId = otherId; }, TypeError);
});

test('rejects unknown schemas, content fields, invalid IDs, oversized inputs and conflicting links', () => {
  for (const text of [null, '', '{', '[]', '{}', JSON.stringify({ version: 2, links: [] }),
    JSON.stringify({ version: 1, links: [], credentials: 'unwanted' }), encode([link({ body: 'unwanted' })]),
    encode([link({ verification: 'title-match' })]), encode(Array.from({ length: 129 }, () => link())),
    ' '.repeat(64 * 1024) + encode([]), encode([link(), link({ nativeId: otherId })]),
    encode([link(), link({ frontendId: otherId })]), encode([link(), link({ verifiedClientMessageId: otherId })])]) {
    assert.equal(parseCloudIdentityLinks(text), null);
  }
  for (const field of ['frontendId', 'nativeId', 'verifiedClientMessageId']) {
    for (const value of [null, 'bad', '00000000-0000-0000-0000-000000000000', `${nativeId}\n`]) {
      assert.equal(parseCloudIdentityLinks(encode([link({ [field]: value })])), null);
    }
  }
});

test('candidate needs one exact frontend title but native title and recent-list presence are optional', () => {
  const links = parseCloudIdentityLinks(encode([link()]));
  assert.deepEqual(findLinkedCloudCandidate(directory(), rawTitle, links), link());
  assert.deepEqual(findLinkedCloudCandidate({ threads: [frontend()] }, rawTitle, links), link());
  assert.deepEqual(findLinkedCloudCandidate(directory([native({ id: otherId, title: rawTitle })]), rawTitle, links), link());
  assert.deepEqual(findLinkedCloudCandidate({ ...directory(), pinnedThreads: [frontend(), native()] }, rawTitle, links), link());
  assert.equal(findLinkedCloudCandidate(directory(), `${rawTitle} `, links), null);
  assert.equal(findLinkedCloudCandidate({ threads: [native()] }, rawTitle, links), null);
});

test('candidate rejects ambiguous frontend titles, local names, conflicting rows and polluted link arguments', () => {
  for (const row of [frontend({ id: otherId }), native({ id: otherId, hostId: 'local', title: rawTitle }),
    native({ id: otherId, hostId: 'remote', title: rawTitle }), { id: otherId, kind: 'unknown', title: rawTitle },
    frontend({ title: 'old title' }), native({ hostId: 'local' }), native({ kind: 'chatgpt' }),
    frontend({ id: 'invalid' })]) {
    assert.equal(findLinkedCloudCandidate(directory([row]), rawTitle, [link()]), null);
  }
  for (const list of [null, [], {}, { threads: null }, { threads: [frontend()], pinnedThreads: {} }]) {
    assert.equal(findLinkedCloudCandidate(list, rawTitle, [link()]), null);
  }
  assert.equal(findLinkedCloudCandidate(directory(), rawTitle, [link(), link({ nativeId: otherId })]), null);
  assert.equal(findLinkedCloudCandidate(directory(), rawTitle, [link({ verification: 'untrusted' })]), null);
  for (const title of ['ChatGPT', 'New chat', '', `${rawTitle}\n`, 'x'.repeat(513)]) {
    assert.equal(findLinkedCloudCandidate({ threads: [frontend({ title })] }, title, [link()]), null);
  }
});

test('frontend evidence uses only the unique latest user ID from the exact frontend readback', () => {
  assert.deepEqual(frontendMessageEvidence(frontendRead(), frontendId, rawTitle), evidence());
  const read = frontendRead();
  read.thread.id = frontendId.toUpperCase(); read.turns[0].items[0].id = clientMessageId.toUpperCase();
  assert.deepEqual(frontendMessageEvidence(read, frontendId, rawTitle), evidence());
  for (const change of [r => { r.thread.id = otherId; }, r => { r.thread.kind = 'codex'; },
    r => { r.thread.title += ' '; }, r => { r.page.order = 'oldest_first'; }, r => { delete r.page; },
    r => { r.turns = []; }, r => { r.turns[0].items = []; }, r => { r.turns[0].items[0].id = 'bad'; },
    r => { r.turns[0].items.push({ type: 'userMessage', id: otherId }); },
    r => { r.turns.unshift({ items: [{ type: 'agentMessage', id: 'no-user' }] }); }]) {
    const value = frontendRead(); change(value);
    assert.equal(frontendMessageEvidence(value, frontendId, rawTitle), null);
  }
});

test('native evidence accepts complete current items without requiring full older history', () => {
  assert.equal(matchesCloudMessageEvidence(nativeState(), nativeId, evidence()), true);
  const state = nativeState();
  state.id = nativeId.toUpperCase(); latestTurn(state).params.clientUserMessageId = clientMessageId.toUpperCase();
  latestTurn(state).items[0].clientId = clientMessageId.toUpperCase();
  assert.equal(matchesCloudMessageEvidence(state, nativeId, evidence()), true);
});

test('native evidence rejects missing identity, message disagreement, incomplete items and absent current boundary', () => {
  for (const change of [s => { s.id = otherId; }, s => { s.hostId = 'local'; },
    s => { s.turnHistory.kind = 'legacy'; }, s => { s.turnHistory.history.islands[0].newerBoundary.status = 'available'; },
    s => { s.turnHistory.history.islands = { at: 1 }; },
    s => { s.turnHistory.history.islands[0].entries = []; }, s => { delete latestTurn(s).params; },
    s => { latestTurn(s).params.clientUserMessageId = otherId; }, s => { latestTurn(s).items[0].clientId = otherId; },
    s => { delete latestTurn(s).items[0].clientId; }, s => { latestTurn(s).items = []; },
    s => { latestTurn(s).items.reverse(); }, s => { latestTurn(s).items.push({ type: 'userMessage', clientId: clientMessageId }); },
    s => { latestTurn(s).items.push({ type: 'steeringUserMessage', status: 'accepted', clientUserMessageId: otherId }); },
    s => { delete latestTurn(s).itemsPagination; }, s => { latestTurn(s).itemsPagination.hasLoadedOldest = false; },
    s => { latestTurn(s).itemsPagination.evicted = true; }, s => { latestTurn(s).itemsPagination.reconnect = {}; },
    s => { s.turns.push({ turnId: 'optimistic', items: [] }); }]) {
    const state = nativeState(); change(state);
    assert.equal(matchesCloudMessageEvidence(state, nativeId, evidence()), false);
  }
  for (const state of [null, {}, { id: nativeId, hostId: 'durable', turnHistory: { kind: 'canonical', history: {} } }]) {
    assert.equal(matchesCloudMessageEvidence(state, nativeId, evidence()), false);
  }
});

test('an older matching client ID cannot validate a newer divergent turn or fork', () => {
  const state = nativeState(), next = structuredClone(latestTurn(state));
  next.turnId = 'later-turn'; next.params.clientUserMessageId = otherId; next.items[0].clientId = otherId;
  state.turnHistory.history.entitiesByKey.next = next;
  state.turnHistory.history.islands[0].entries.push({ value: 'next' });
  assert.equal(matchesCloudMessageEvidence(state, nativeId, evidence()), false);
});
