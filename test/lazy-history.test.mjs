import test from 'node:test';
import assert from 'node:assert/strict';
import { LazyHistory, HISTORY_ITEM_PAGE_SIZE } from '../lazy-history.mjs';
import { DesktopEventProjector } from '../desktop-events.mjs';
import { applyDesktopPatches } from '../desktop-ipc.mjs';
import { validateProtocol } from '../protocol-validation.mjs';

const message = (id, text = id) => ({ type: 'agentMessage', id, text, phase: 'commentary' });
const turn = (id, items = [message(`i-${id}`)], extra = {}) => ({
  turnId: id, status: 'completed', items, turnStartedAtMs: 1000, durationMs: 10, ...extra,
});
function state(turns, boundary = { status: 'exhausted' }) {
  return { turns: [], turnHistory: { kind: 'canonical', history: {
    islands: [{ entries: turns.map(t => ({ value: t.turnId })), olderBoundary: boundary, newerBoundary: { status: 'exhausted' } }],
    entitiesByKey: Object.fromEntries(turns.map(t => [t.turnId, t])),
  } } };
}
const itemParams = extra => ({ sortDirection: 'desc', ...extra });
const shell = id => ({ id, items: [], itemsView: 'notLoaded', status: 'completed', error: null,
  rootTurnId: null, startedAt: 1, completedAt: 2, durationMs: 1000 });
const entry = (turnId, id, text = id) => ({ turnId, item: message(id, text) });
const reader = handlers => {
  const calls = [];
  return { calls, call: async (method, params) => {
    calls.push({ method, params: structuredClone(params) });
    const handler = handlers.shift();
    assert.ok(handler, `unexpected read ${method}`);
    return handler(method, params);
  } };
};

test('latest native TUI history opens without any older-history IO', async () => {
  const remote = reader([]);
  const snapshot = state(Array.from({ length: 20 }, (_, i) => turn(`t${i}`)),
    { status: 'available', handle: { cursor: 'older-turns' } });
  const history = new LazyHistory(snapshot, { threadId: 'chat', call: remote.call });
  assert.equal(remote.calls.length, 0);
  assert.deepEqual(history.turns.map(t => t.id), ['t15', 't16', 't17', 't18', 't19']);
  assert.equal(history.turns.every(t => t.itemsView === 'notLoaded' && t.items.length === 0), true);
  const turns = await history.page('turns', { limit: 5, itemsView: 'notLoaded' });
  const items = await history.page('items', itemParams({ limit: 5 }));
  assert.deepEqual(turns.data.map(t => t.id), ['t19', 't18', 't17', 't16', 't15']);
  assert.deepEqual(items.data.map(e => e.item.id), ['i-t19', 'i-t18', 'i-t17', 'i-t16', 'i-t15']);
  assert.ok(turns.nextCursor);
  assert.ok(items.nextCursor);
  assert.equal(remote.calls.length, 0);
  validateProtocol('v2/ThreadTurnsListResponse', turns);
  validateProtocol('v2/ThreadItemsListResponse', items);
});

test('old completed items are not inspected while opening a loaded long chat', async () => {
  let accesses = 0;
  const old = turn('old');
  Object.defineProperty(old, 'items', { get() { accesses++; return [message('old-item')]; } });
  const history = new LazyHistory(state([old, ...Array.from({ length: 5 }, (_, i) => turn(`t${i}`))]),
    { threadId: 'chat', call: async () => assert.fail('complete baseline should not read metadata') });
  await history.page('items', itemParams({ limit: 5 }));
  assert.equal(accesses, 0);
  const page = await history.page('items', itemParams({ limit: 6 }));
  assert.equal(page.data.at(-1).item.id, 'old-item');
  assert.ok(accesses > 0);
});

test('active text stays at the event baseline even if Desktop and disk grow', async () => {
  const live = turn('live', [message('a', 'prefix')], { status: 'inProgress' });
  const baseline = state([live]);
  const history = new LazyHistory(baseline, { threadId: 'chat', call: async () => assert.fail('no disk read') });
  const notifications = [];
  const projector = new DesktopEventProjector('chat', (method, params) => notifications.push({ method, params }));
  projector.seed(baseline);
  const newer = structuredClone(baseline);
  newer.turnHistory.history.entitiesByKey.live.items[0].text = 'prefix suffix';
  newer.turnHistory.history.entitiesByKey.live.items.push(message('later', 'new item'));
  projector.update(newer);
  const page = await history.page('items', itemParams());
  assert.equal(page.data[0].item.text, 'prefix');
  assert.equal(page.data.length, 1);
  assert.equal(page.nextCursor, null);
  assert.equal(notifications.find(e => e.method === 'item/agentMessage/delta').params.delta, ' suffix');
  page.data[0].item.text = 'caller modification';
  assert.equal((await history.page('items', itemParams())).data[0].item.text, 'prefix');
});

test('small item pages retain every record and their continuation without changing turn pages', async () => {
  const snapshot = state(Array.from({ length: 53 }, (_, i) => turn(`t${i}`)));
  const history = new LazyHistory(snapshot, { threadId: 'chat', call: async () => assert.fail('no disk read') });
  assert.equal((await history.page('turns', { limit: 100 })).data.length, 53);
  let cursor = null;
  const ids = [], sizes = [];
  do {
    const page = await history.page('items', itemParams({ limit: 100, cursor }));
    sizes.push(page.data.length);
    ids.push(...page.data.map(e => e.item.id));
    cursor = page.nextCursor;
    validateProtocol('v2/ThreadItemsListResponse', page);
  } while (cursor);
  assert.equal(HISTORY_ITEM_PAGE_SIZE, 20);
  assert.deepEqual(sizes, [20, 20, 13]);
  assert.deepEqual(ids, Array.from({ length: 53 }, (_, i) => `i-t${52 - i}`));
});

test('attachment copies no recent item bodies and only the requested page is materialized', async () => {
  let bodiesRead = 0;
  const items = Array.from({ length: 1000 }, (_, i) => ({
    type: 'agentMessage', id: `item-${i}`, phase: 'commentary',
    get text() { bodiesRead++; return `body-${i}`; },
  }));
  const history = new LazyHistory(state([turn('live', items, { status: 'inProgress' })]), {
    threadId: 'chat', call: async () => assert.fail('no disk read'),
  });
  assert.equal(bodiesRead, 0);
  const first = await history.page('items', itemParams({ limit: 100 }));
  assert.equal(bodiesRead, 20);
  assert.equal(first.data[0].item.text, 'body-999');
  const second = await history.page('items', itemParams({ limit: 100, cursor: first.nextCursor }));
  assert.equal(bodiesRead, 40);
  assert.equal(second.data[0].item.text, 'body-979');
});

test('immutable Desktop patches preserve uncopied baseline text and returned pages stay isolated', async () => {
  const snapshot = state([turn('live', [message('active', 'prefix')], { status: 'inProgress' })]);
  const history = new LazyHistory(snapshot, { threadId: 'chat', call: async () => assert.fail('no disk read') });
  const events = [], projector = new DesktopEventProjector('chat', (method, params) => events.push({ method, params }));
  projector.seed(snapshot);
  const newer = applyDesktopPatches(snapshot, [{
    op: 'replace', path: ['turnHistory', 'history', 'entitiesByKey', 'live', 'items', 0, 'text'], value: 'prefix suffix',
  }]);
  projector.update(newer);
  const page = await history.page('items', itemParams({ limit: 100 }));
  assert.equal(page.data[0].item.text, 'prefix');
  assert.deepEqual(events.filter(e => e.method === 'item/agentMessage/delta').map(e => e.params.delta), [' suffix']);
  page.data[0].item.text = 'caller mutation';
  assert.equal((await history.page('items', itemParams({ limit: 100 }))).data[0].item.text, 'prefix');
  assert.equal(newer.turnHistory.history.entitiesByKey.live.items[0].text, 'prefix suffix');
});

test('an active state turn with an orphan canonical entity retains its live prefix', async () => {
  const snapshot = state([turn('completed')]);
  const live = turn('live', [message('active', 'prefix')], { status: 'inProgress' });
  snapshot.turnHistory.history.entitiesByKey.live = live;
  snapshot.turns = [live];
  const history = new LazyHistory(snapshot, {
    threadId: 'chat', call: async () => assert.fail('complete visible items should not read disk'),
  });
  assert.equal(history.turns.at(-1).id, 'live');
  const page = await history.page('items', itemParams({ limit: 1 }));
  assert.equal(page.data[0].item.text, 'prefix');
});

test('partial active items use the strict item anchor and frozen duplicates', async () => {
  const remote = reader([(method, params) => {
    assert.equal(method, 'thread/items/list');
    assert.equal(params.turnId, 'live');
    assert.deepEqual(params.cursor, { type: 'item', itemId: 'oldest-visible' });
    return { data: [entry('live', 'oldest-visible', 'later text'), entry('live', 'older')], nextCursor: 'more-items' };
  }, (method, params) => {
    assert.equal(params.cursor, 'more-items');
    return { data: [entry('live', 'oldest')], nextCursor: null };
  }]);
  const snapshot = state([turn('live', [message('oldest-visible', 'frozen'), message('newest', 'prefix')],
    { status: 'inProgress', itemsPagination: { hasLoadedOldest: false } })]);
  const history = new LazyHistory(snapshot, { threadId: 'chat', call: remote.call });
  const first = await history.page('items', itemParams({ limit: 3 }));
  assert.deepEqual(first.data.map(e => e.item.id), ['newest', 'oldest-visible', 'older']);
  assert.equal(first.data[1].item.text, 'frozen');
  assert.ok(first.nextCursor);
  const second = await history.page('items', itemParams({ cursor: first.nextCursor, limit: 3 }));
  assert.deepEqual(second.data.map(e => e.item.id), ['oldest']);
  assert.equal(second.nextCursor, null);
  assert.equal(remote.calls.length, 2);
});

test('ordinary partial turns preserve the native older item cursor', async () => {
  const remote = reader([(_method, params) => {
    assert.equal(params.cursor, 'opaque-desktop-item-cursor');
    return { data: [entry('live', 'older')], nextCursor: null };
  }]);
  const history = new LazyHistory(state([turn('live', [message('recent')], {
    itemsPagination: { hasLoadedOldest: false, olderCursor: 'opaque-desktop-item-cursor' },
  })]), { threadId: 'chat', call: remote.call });
  assert.deepEqual((await history.page('items', itemParams())).data.map(e => e.item.id), ['recent', 'older']);
});

test('older global items are fetched per turn with preserved native cursors', async () => {
  const remote = reader([
    (method, params) => {
      assert.equal(method, 'thread/turns/list');
      assert.equal(params.cursor, 'turn-boundary');
      assert.equal(params.itemsView, 'notLoaded');
      return { data: [shell('old')], nextCursor: 'still-older-turns' };
    },
    (method, params) => {
      assert.equal(method, 'thread/items/list');
      assert.equal(params.turnId, 'old');
      assert.equal(params.cursor, null);
      return { data: [entry('old', 'o2')], nextCursor: 'older-items' };
    },
    (_method, params) => {
      assert.equal(params.cursor, 'older-items');
      return { data: [entry('old', 'o1')], nextCursor: null };
    },
    (method, params) => {
      assert.equal(method, 'thread/turns/list');
      assert.equal(params.cursor, 'still-older-turns');
      return { data: [shell('empty')], nextCursor: null };
    },
    (_method, params) => {
      assert.equal(params.turnId, 'empty');
      return { data: [], nextCursor: null };
    },
  ]);
  const history = new LazyHistory(state([turn('live')], { status: 'available', handle: { cursor: 'turn-boundary' } }),
    { threadId: 'chat', call: remote.call });
  const first = await history.page('items', itemParams({ limit: 2 }));
  assert.deepEqual(first.data.map(e => e.item.id), ['i-live', 'o2']);
  const second = await history.page('items', itemParams({ limit: 3, cursor: first.nextCursor }));
  assert.deepEqual(second.data.map(e => e.item.id), ['o1']);
  assert.equal(second.nextCursor, null);
  const shells = await history.page('turns', { limit: 100, itemsView: 'notLoaded' });
  assert.deepEqual(shells.data.map(t => t.id), ['live', 'old', 'empty']);
  assert.equal(shells.nextCursor, null);
});

test('timeline boundary anchors one bounded recent metadata page only on older demand', async () => {
  const remote = reader([
    (method, params) => {
      assert.equal(method, 'thread/turns/list');
      assert.equal(params.cursor, null);
      assert.equal(params.limit, 100);
      return { data: [shell('later'), shell('live'), shell('old')], nextCursor: 'opaque-turn-next' };
    },
    (_method, params) => {
      assert.equal(params.cursor, 'opaque-turn-next');
      return { data: [shell('oldest')], nextCursor: null };
    },
  ]);
  const history = new LazyHistory(state([turn('live')], {
    status: 'available', handle: { source: 'timeline', cursor: 'never-pass-to-turns' },
  }), { threadId: 'chat', call: remote.call });
  const first = await history.page('turns', { limit: 1 });
  assert.equal(remote.calls.length, 0);
  const next = await history.page('turns', { limit: 1, cursor: first.nextCursor });
  assert.deepEqual(next.data.map(t => t.id), ['old']);
  const last = await history.page('turns', { limit: 1, cursor: next.nextCursor });
  assert.deepEqual(last.data.map(t => t.id), ['oldest']);
  assert.equal(last.nextCursor, null);
});

test('unanchored metadata never claims missing history is complete', async () => {
  let calls = 0;
  const history = new LazyHistory(state([turn('live')], { status: 'available' }),
    { threadId: 'chat', call: async () => { calls++; return { data: [shell('unrelated')], nextCursor: 'next' }; } });
  const first = await history.page('turns', { limit: 1 });
  assert.ok(first.nextCursor);
  await assert.rejects(history.page('turns', { limit: 2 }), /not yet available/);
  assert.equal(calls, 1);
  assert.ok((await history.page('turns', { limit: 1 })).nextCursor);
});

test('multiple islands use only the continuous latest tail and page across gaps', async () => {
  const snapshot = state([turn('live')], { status: 'available', handle: { cursor: 'before-live' } });
  snapshot.turnHistory.history.entitiesByKey.oldIsland = turn('oldIsland');
  snapshot.turnHistory.history.islands.unshift({ entries: [{ value: 'oldIsland' }],
    olderBoundary: { status: 'exhausted' }, newerBoundary: { status: 'available' } });
  snapshot.turns = [snapshot.turnHistory.history.entitiesByKey.oldIsland, snapshot.turnHistory.history.entitiesByKey.live];
  const history = new LazyHistory(snapshot, { threadId: 'chat', call: async () => ({
    data: [shell('gap'), shell('oldIsland')], nextCursor: null,
  }) });
  const page = await history.page('turns', { limit: 10 });
  assert.deepEqual(page.data.map(t => t.id), ['live', 'gap', 'oldIsland']);
});

test('invalid and foreign cursors and unsupported requests do not read metadata', async () => {
  const options = { threadId: 'chat', call: async () => assert.fail('invalid params must not read') };
  const history = new LazyHistory(state([turn('a'), turn('b')]), options);
  const first = await history.page('items', itemParams({ limit: 1 }));
  const other = new LazyHistory(state([turn('a'), turn('b')]), options);
  for (const params of [
    { cursor: 'invalid' }, { sortDirection: 'asc' }, { limit: -1 }, { limit: 0.5 },
    { cursor: first.nextCursor, turnId: 'a' }, { threadId: 'other' },
  ]) await assert.rejects(history.page('items', itemParams(params)));
  await assert.rejects(other.page('items', itemParams({ cursor: first.nextCursor })), /does not belong/);
  await assert.rejects(history.page('turns', { cursor: first.nextCursor }), /does not belong/);
  await assert.rejects(history.page('turns', { itemsView: 'full' }), /separately/);
  await assert.rejects(history.page('items', itemParams({ turnId: 'unknown' })), /metadata/);
  assert.equal((await history.page('items', itemParams({ limit: 0 }))).data.length, 1);
});

test('partial empty and sparse recent histories fail explicitly instead of truncating', () => {
  const options = { threadId: 'chat', call: async () => {} };
  for (const pagination of [
    { hasLoadedOldest: false }, { reconnect: { beforeItemId: 'a' } },
    { summaryItemIds: ['sparse'] },
  ]) assert.throws(() => new LazyHistory(state([turn('live', [], { itemsPagination: pagination })]), options),
    { code: 'LAZY_HISTORY_UNAVAILABLE' });
  const notCurrent = state([turn('old')]);
  notCurrent.turnHistory.history.islands[0].newerBoundary.status = 'available';
  assert.throws(() => new LazyHistory(notCurrent, options), /current end/);
});

test('metadata failure leaves older history retryable with no duplicate entries', async () => {
  let count = 0;
  const history = new LazyHistory(state([turn('live')], { status: 'available', handle: { cursor: 'older' } }), {
    threadId: 'chat', call: async (_method, params) => {
      assert.equal(params.cursor, 'older');
      if (++count === 1) throw new Error('read timed out');
      return { data: [shell('old')], nextCursor: null };
    },
  });
  const first = await history.page('turns', { limit: 1 });
  await assert.rejects(history.page('turns', { cursor: first.nextCursor }), /timed out/);
  const retry = await history.page('turns', { cursor: first.nextCursor });
  assert.deepEqual(retry.data.map(t => t.id), ['old']);
  assert.equal(retry.nextCursor, null);
});

test('cyclic native cursors fail visibly without looping or reporting completion', async () => {
  let calls = 0;
  const history = new LazyHistory(state([turn('live')], { status: 'available', handle: { cursor: 'same' } }), {
    threadId: 'chat', call: async () => { calls++; return { data: [], nextCursor: 'same' }; },
  });
  await assert.rejects(history.page('turns', { limit: 2 }), /did not advance/);
  assert.equal(calls, 1);
  assert.ok((await history.page('turns', { limit: 1 })).nextCursor);
});

test('overlapping concurrent requests share one lazy fetch and stable cached data', async () => {
  let calls = 0;
  const history = new LazyHistory(state([turn('live')], { status: 'available', handle: { cursor: 'older' } }), {
    threadId: 'chat', call: async () => {
      calls++;
      await new Promise(resolve => setTimeout(resolve, 5));
      return { data: [shell('old')], nextCursor: null };
    },
  });
  const [a, b] = await Promise.all([history.page('turns', { limit: 2 }), history.page('turns', { limit: 2 })]);
  assert.deepEqual(a, b);
  assert.equal(calls, 1);
});

test('small native pages spanning many short turns stay bounded and reach the full history', async () => {
  let turnReads = 0, itemReads = 0;
  const history = new LazyHistory(state([turn('live')], {
    status: 'available', handle: { cursor: '0' },
  }), {
    threadId: 'chat', call: async (method, params) => {
      if (method === 'thread/turns/list') {
        turnReads++;
        const offset = Number(params.cursor);
        const data = Array.from({ length: Math.min(params.limit, 100 - offset) }, (_, i) => shell(`old-${offset + i}`));
        return { data, nextCursor: offset + data.length < 100 ? String(offset + data.length) : null };
      }
      itemReads++;
      return { data: [entry(params.turnId, `item-${params.turnId}`)], nextCursor: null };
    },
  });
  const page = await history.page('items', itemParams({ limit: 100 }));
  assert.equal(page.data.length, 20);
  assert.ok(page.nextCursor);
  assert.equal(itemReads, 19);
  assert.equal(turnReads, 4);
  const ids = page.data.map(e => e.turnId);
  let cursor = page.nextCursor;
  while (cursor) {
    const next = await history.page('items', itemParams({ cursor, limit: 100 }));
    assert.ok(next.data.length <= 20);
    ids.push(...next.data.map(e => e.turnId));
    cursor = next.nextCursor;
  }
  assert.deepEqual(ids, ['live', ...Array.from({ length: 100 }, (_, i) => `old-${i}`)]);
  assert.equal(itemReads, 100);
  assert.equal(turnReads, 20);
});

test('timeline overlap stays in bounded batches until the frozen baseline ends', async () => {
  const baseline = Array.from({ length: 500 }, (_, i) => turn(`t${i}`, []));
  const disk = [...baseline].reverse().map(t => shell(t.turnId)).concat(shell('older'));
  let reads = 0;
  const history = new LazyHistory(state(baseline, { status: 'available',
    handle: { source: 'timeline', cursor: 'timeline-only' },
  }), {
    threadId: 'chat', call: async (_method, params) => {
      reads++;
      assert.equal(params.limit, 100);
      const offset = Number(params.cursor ?? 0), data = disk.slice(offset, offset + params.limit);
      return { data, nextCursor: offset + data.length < disk.length ? String(offset + data.length) : null };
    },
  });
  let cursor = null;
  for (let i = 0; i < 5; i++) cursor = (await history.page('turns', { cursor, limit: 100 })).nextCursor;
  assert.equal(reads, 0);
  const page = await history.page('turns', { cursor, limit: 1 });
  assert.deepEqual(page.data.map(t => t.id), ['older']);
  assert.equal(reads, 6);
  assert.equal(page.nextCursor, null);
});

test('rejected native turn pages cannot partly enter the cache before retry', async () => {
  for (const badPage of [
    { data: [shell('old')], nextCursor: 'same' },
    { data: [shell('old'), { id: null }], nextCursor: null },
  ]) {
    let reads = 0;
    const history = new LazyHistory(state([turn('live')], {
      status: 'available', handle: { cursor: 'same' },
    }), {
      threadId: 'chat', call: async () => { reads++; return badPage; },
    });
    for (let i = 0; i < 2; i++) await assert.rejects(history.page('turns', { limit: 2 }));
    assert.equal(reads, 2);
    assert.equal(history.turnRows.length, 1);
    assert.equal(history.turnsById.has('old'), false);
  }
});

test('rejected native item pages cannot partly enter the cache before retry', async () => {
  for (const badPage of [
    { data: [entry('live', 'old')], nextCursor: 'same' },
    { data: [entry('live', 'old'), entry('different-turn', 'wrong')], nextCursor: null },
  ]) {
    let reads = 0;
    const history = new LazyHistory(state([turn('live', [message('recent')], {
      itemsPagination: { hasLoadedOldest: false, olderCursor: 'same' },
    })]), {
      threadId: 'chat', call: async () => { reads++; return badPage; },
    });
    for (let i = 0; i < 2; i++) await assert.rejects(history.page('items', itemParams({ limit: 2 })));
    assert.equal(reads, 2);
    assert.equal(history.itemStreams.get('live').rows.length, 1);
    assert.equal(history.itemStreams.get('live').seen.has('old'), false);
  }
});
