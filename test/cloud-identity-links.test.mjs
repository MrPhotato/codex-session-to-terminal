import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCloudIdentityLinks, findLinkedCloudCandidate, frontendMessageEvidence,
  matchesCloudMessageEvidence, discoverCloudCandidate, cloudFrontends } from '../cloud-identity-links.mjs';

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

function discoveryFixture() {
  const earlier = 'Earlier question about a specific deployment';
  const current = 'Current detailed question about memory offloading';
  const source = frontendRead();
  source.turns[0].items[0].content = [{ type: 'text', text: current }];
  source.turns.push({ items: [{ type: 'userMessage', id: otherId, content: [{ type: 'text', text: earlier }] }] });
  const target = { thread: native(), page: { order: 'newest_first' }, turns: [{ items: [
    { type: 'userMessage', content: [{ type: 'text', text: earlier }] },
    { type: 'agentMessage', text: 'answer' },
    { type: 'userMessage', content: [{ type: 'text', text: current }] },
  ] }] };
  const calls = [];
  return { source, target, calls, read: async (key) => { calls.push(key); return key === frontendId ? source : target; } };
}

test('discovers an untitled candidate using full ordered text, then checks fresh frontend identity', async () => {
  const f = discoveryFixture();
  const result = await discoverCloudCandidate(directory(), frontend(), f.read);
  assert.equal(result.native.thread.id, nativeId);
  assert.deepEqual(result.evidence, { ...evidence(), discovered: true });
  assert.deepEqual(f.calls, [frontendId, nativeId, frontendId]);
  assert.deepEqual(cloudFrontends(directory()), [{ id: frontendId, kind: 'chatgpt', title: rawTitle }]);
});

test('discovery rejects duplicates, failed reads, truncated messages and stale frontend evidence', async () => {
  for (const mode of ['duplicate','failed','truncated','changed','reverse']) {
    const f = discoveryFixture(); let reads = 0;
    const rows = directory(mode === 'duplicate' ? [native({ id: otherId })] : []);
    const read = async key => {
      if (mode === 'failed' && key === nativeId) throw Error('unavailable');
      const value = structuredClone(key === frontendId ? f.source : { ...f.target, thread: native({ id: key }) });
      if (mode === 'truncated' && key === nativeId) value.turns[0].items[2].truncated = true;
      if (mode === 'reverse' && key === nativeId) value.turns[0].items.reverse();
      if (key === frontendId && ++reads === 2 && mode === 'changed') value.turns[0].items[0].id = otherId;
      return value;
    };
    assert.equal(await discoverCloudCandidate(rows, frontend(), read), null, mode);
  }
});

for (const mode of ['unique', 'late-duplicate', 'late-failure', 'source-changed']) {
  test(`bounded concurrent discovery waits for all candidates: ${mode}`, { timeout: 2000 }, async () => {
    const f = discoveryFixture();
    const extra = Array.from({ length: 16 }, (_, i) => native({
      id: `12345678-1234-4234-8234-${String(i + 1).padStart(12, '0')}`,
    }));
    const lastId = extra.at(-1).id;
    let releaseLast, reportLastStarted, active = 0, peak = 0, sourceReads = 0, settled = false;
    const lastGate = new Promise(resolve => { releaseLast = resolve; });
    const lastStarted = new Promise(resolve => { reportLastStarted = resolve; });
    const reads = [];
    const read = async key => {
      if (key === frontendId) {
        const value = structuredClone(f.source);
        if (++sourceReads === 2 && mode === 'source-changed') value.turns[0].items[0].id = otherId;
        return value;
      }
      reads.push(key); active++; peak = Math.max(peak, active);
      try {
        await new Promise(resolve => setImmediate(resolve));
        if (key === lastId) {
          reportLastStarted(); await lastGate;
          if (mode === 'late-failure') throw Object.assign(Error('Rate limited'), { code: 'RATE_LIMITED' });
        }
        const value = structuredClone(f.target); value.thread.id = key;
        if (key !== nativeId && !(key === lastId && mode === 'late-duplicate')) {
          value.turns[0].items[2].content[0].text = 'Another conversation with a different question';
        }
        return value;
      } finally { active--; }
    };
    const running = discoverCloudCandidate(directory(extra), frontend(), read).finally(() => { settled = true; });
    try {
      await lastStarted;
      assert.equal(settled, false, 'the first matching candidate must not bypass a later candidate');
      assert.equal(peak, 8, 'use the bounded window without opening extra readers');
      assert.equal(reads.length, 17);
      assert.equal(new Set(reads).size, 17);
    } finally { releaseLast(); }
    const result = await running;
    assert.equal(result?.native.thread.id ?? null, mode === 'unique' ? nativeId : null);
    assert.equal(sourceReads, ['unique', 'source-changed'].includes(mode) ? 2 : 1);
    assert.equal(active, 0);
  });
}

test('cancelling a full query window cannot refill it when late reads finish', { timeout: 2000 }, async () => {
  const f = discoveryFixture(), abort = new AbortController();
  const extra = Array.from({ length: 16 }, (_, i) => native({
    id: `12345678-1234-4234-8234-${String(i + 1).padStart(12, '0')}`,
  }));
  const pending = []; let sourceReads = 0, windowStarted;
  const fullWindow = new Promise(resolve => { windowStarted = resolve; });
  const running = discoverCloudCandidate(directory(extra), frontend(), async key => {
    if (key === frontendId) { sourceReads++; return f.source; }
    return new Promise(resolve => {
      pending.push(() => resolve({ ...f.target, thread: native({ id: key }) }));
      if (pending.length === 8) windowStarted();
    });
  }, { signal: abort.signal });
  const rejected = assert.rejects(running, { code: 'ABORTED' });
  await fullWindow;
  abort.abort(); await rejected;
  pending.forEach(finish => finish());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 8);
  assert.equal(sourceReads, 1);
});

test('discovery is bounded and a late read cannot start scanning further chats', async () => {
  const f = discoveryFixture(); let resolveRead, calls = 0;
  const reports = [];
  await assert.rejects(discoverCloudCandidate(directory(), frontend(), () => { calls++; return new Promise(r => { resolveRead = r; }); },
    { timeoutMs: 10, onDiagnostic: value => reports.push(value) }), { code: 'CLOUD_DISCOVERY_TIMEOUT' });
  assert.equal(reports[0].outcome, 'timeout');
  resolveRead(f.source);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(calls, 1);
});

test('short recent replies expand the nomination suffix without accepting mismatched older text', async () => {
  for (const different of [false, true]) {
    const f = discoveryFixture(), calls = [];
    const inputs = ['A sufficiently long earlier deployment question', 'Please go', 'y'];
    const read = async (key, options) => {
      calls.push({ key, limit: options.turnLimit });
      const value = structuredClone(key === frontendId ? f.source : f.target);
      value.page.hasMore = true;
      value.turns = inputs.slice(-options.turnLimit).reverse().map((text, index) => ({ items: [{
        type: 'userMessage', id: index === 0 ? clientMessageId : otherId,
        content: [{ type: 'text', text: different && key === nativeId && text === inputs[0] ? 'Other unrelated older input' : text }],
      }] }));
      return value;
    };
    const result = await discoverCloudCandidate(directory(), frontend(), read);
    assert.equal(result?.native.thread.id ?? null, different ? null : nativeId);
    assert.deepEqual(calls.slice(0, 4), [{ key: frontendId, limit: 2 }, { key: frontendId, limit: 4 },
      { key: nativeId, limit: 2 }, { key: nativeId, limit: 4 }]);
  }
});

test('discovery reads two turns first and expands only summaries missing the second user message', async () => {
  for (const sparse of [false, true]) {
    const f = discoveryFixture(), calls = [];
    const read = async (key, options) => {
      calls.push({ key, limit: options.turnLimit });
      const value = structuredClone(key === frontendId ? f.source : f.target);
      if (sparse && options.turnLimit === 2) {
        if (key === frontendId) value.turns.length = 1;
        else value.turns[0].items.shift();
      }
      return value;
    };
    const result = await discoverCloudCandidate(directory(), frontend(), read);
    assert.equal(result.native.thread.id, nativeId);
    assert.deepEqual(calls, sparse ? [
      {key:frontendId,limit:2},{key:frontendId,limit:4},
      {key:nativeId,limit:2},{key:nativeId,limit:4},{key:frontendId,limit:1},
    ] : [{key:frontendId,limit:2},{key:nativeId,limit:2},{key:frontendId,limit:1}]);
  }
});

test('discovery does not expand a complete short history or an already different latest message', async () => {
  for (const mode of ['exhausted','different','truncated']) {
    const f = discoveryFixture(), limits = [];
    const read = async (key, options) => {
      if(key===frontendId)return f.source;
      limits.push(options.turnLimit);
      const value=structuredClone(f.target);value.turns[0].items.splice(0,2);
      if(mode==='exhausted')value.page.hasMore=false;
      if(mode==='different')value.turns[0].items[0].content[0].text='A different latest user message';
      if(mode==='truncated')value.turns[0].items[0].truncated=true;
      return value;
    };
    assert.equal(await discoverCloudCandidate(directory(),frontend(),read),null);
    assert.deepEqual(limits,[2]);
  }
});

for (const discovered of [false, true]) test(`${discovered ? 'discovered' : 'linked'} candidate requires exact latest admitted client ID including in-turn user continuation`, () => {
  const s = nativeState();
  latestTurn(s).items.push({ type: 'userMessage', clientId: otherId });
  const ev = { frontendId, clientMessageId: otherId, ...(discovered ? { discovered: true } : {}) };
  assert.equal(matchesCloudMessageEvidence(s, nativeId, ev), true);
  assert.equal(matchesCloudMessageEvidence(s, nativeId, { ...ev, clientMessageId }), false);
  latestTurn(s).params.clientUserMessageId = otherId;
  assert.equal(matchesCloudMessageEvidence(s, nativeId, ev), false);
});

for (const discovered of [false, true]) test(`a live canonical ${discovered ? 'discovered' : 'linked'} cloud turn verifies its frontend receipt before paginated history exists`, () => {
  const make = () => {
    const s = nativeState(); s.historyMode = 'legacy'; s.threadRuntimeStatus = { type: 'active' };
    const t = latestTurn(s); t.status = 'inProgress'; t.turnStartedAtMs = 1792736659826; t.params = {}; delete t.itemsPagination;
    return s;
  };
  const ev = { ...evidence(), ...(discovered ? { discovered: true } : {}) };
  assert.equal(matchesCloudMessageEvidence(make(), nativeId, ev), true);
  const completed = make(); completed.threadRuntimeStatus.type = 'idle'; latestTurn(completed).status = 'completed';
  assert.equal(matchesCloudMessageEvidence(completed, nativeId, ev), true);
  const interrupted = make(); interrupted.threadRuntimeStatus.type = 'idle'; latestTurn(interrupted).status = 'interrupted';
  assert.equal(matchesCloudMessageEvidence(interrupted, nativeId, ev), true);
  interrupted.threadRuntimeStatus.type = 'active';
  assert.equal(matchesCloudMessageEvidence(interrupted, nativeId, ev), false);
  interrupted.threadRuntimeStatus.type = 'idle'; latestTurn(interrupted).items[0].clientId = otherId;
  assert.equal(matchesCloudMessageEvidence(interrupted, nativeId, ev), false);
  for (const change of [s => s.threadRuntimeStatus.type = 'idle', s => latestTurn(s).status = 'completed',
    s => latestTurn(s).turnId = 'optimistic', s => latestTurn(s).params = null, s => delete latestTurn(s).turnStartedAtMs,
    s => latestTurn(s).params.clientUserMessageId = otherId,
    s => latestTurn(s).items[0].clientId = otherId,
    s => latestTurn(s).itemsPagination = { hasLoadedOldest: false },
    s => s.turns.push({ turnId: clientMessageId, items: [] })]) {
    const s = make(); change(s); assert.equal(matchesCloudMessageEvidence(s, nativeId, ev), false);
  }
});
