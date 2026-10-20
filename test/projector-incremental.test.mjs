import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopEventProjector } from '../desktop-events.mjs';

const agent = (id, text) => ({ type: 'agentMessage', id, text, phase: 'commentary' });
const turn = (turnId, status = 'completed', items = []) => ({ turnId, status, items, turnStartedAtMs: 1000 });
function canonical(groups, extra = {}) {
  return { turns: [], ...extra, turnHistory: { kind: 'canonical', history: {
    islands: groups.map((turns, index) => ({
      entries: turns.map(t => ({ value: t.turnId })),
      olderBoundary: { status: index === 0 ? 'available' : 'exhausted' },
      newerBoundary: { status: index === groups.length - 1 ? 'exhausted' : 'available' },
    })),
    entitiesByKey: Object.fromEntries(groups.flat().map(t => [t.turnId, t])),
  } } };
}
function fixture(state) {
  const events = [], projector = new DesktopEventProjector('thread', (method, params) => events.push({ method, params }));
  projector.seed(state);
  return { projector, events };
}
const methods = events => events.map(event => event.method);

test('historical islands and old item hydration never publish live lifecycle events', () => {
  const old = turn('old', 'inProgress', []), latest = turn('latest', 'inProgress', [agent('live', 'prefix')]);
  const { projector, events } = fixture(canonical([[old], [latest]]));
  // An old island can retain an obsolete in-progress summary. Filling its
  // items/completion must not release a queued message in the native CLI.
  old.status = 'completed';
  old.items.push(agent('filled-old', 'historical answer'));
  projector.update(canonical([[turn('older')], [old], [latest]]));
  projector.update(canonical([[turn('older', 'completed', [agent('older-item', 'answer')]), {
    ...old, items: [...old.items, agent('additional', 'another history page')],
  }], [turn('gap', 'completed', [agent('gap-item', 'old gap')]), latest]]));
  assert.deepEqual(events, []);
});

test('a completed tail remains history when its items arrive later or its object is reused', () => {
  const latest = turn('latest');
  const { projector, events } = fixture({ turns: [latest] });
  latest.items.push(agent('late', 'historic'));
  projector.update({ turns: [latest] });
  projector.update({ turns: [{ ...latest, items: [...latest.items, agent('second', 'historic')] }] });
  assert.deepEqual(events, []);
  projector.update({ turns: [latest, turn('new', 'completed', [agent('reply', 'fresh')])] });
  assert.deepEqual(methods(events), ['turn/started', 'item/started', 'item/agentMessage/delta', 'item/completed', 'turn/completed']);
  projector.update({ turns: [latest, turn('new', 'completed', [agent('reply', 'fresh')])] });
  assert.equal(events.length, 5);
});

test('active history prefixes are silent while live suffixes keep their streaming baseline', () => {
  const live = turn('live', 'inProgress', [agent('current', 'prefix')]);
  live.itemsPagination = { hasLoadedOldest: false };
  const state = canonical([[live]]), { projector, events } = fixture(state);
  const historical = agent('historical', 'already finished');
  live.items.unshift(historical);
  live.completedItemIds = ['historical'];
  projector.update(state);
  assert.deepEqual(events, []);
  live.items[1].text += ' suffix';
  live.items.push(agent('next', 'new output'));
  projector.update(state);
  assert.deepEqual(methods(events), ['item/agentMessage/delta', 'item/started', 'item/agentMessage/delta']);
  assert.equal(events[0].params.delta, ' suffix');
  assert.equal(events[1].params.item.id, 'next');
  projector.update(state);
  assert.equal(events.length, 3, 'unchanged state cannot repeat any prefix or live event');
});

test('reused active objects retain primitive text and completion baselines', () => {
  const message = agent('message', 'prefix'), live = turn('live', 'inProgress', [message]);
  live.completedItemIds = {};
  const state = { turns: [live] }, { projector, events } = fixture(state);
  message.text += ' suffix';
  projector.update(state);
  live.completedItemIds.message = true;
  projector.update(state);
  live.status = 'completed';
  live.durationMs = 500;
  projector.update(state);
  projector.update(state);
  assert.deepEqual(methods(events), ['item/agentMessage/delta', 'item/completed', 'turn/completed']);
  assert.equal(events[0].params.delta, ' suffix');
  assert.equal(events[1].params.completedAtMs >= 1000, true);
  assert.equal(events[2].params.turn.completedAt, 1);
});

test('a hydrated active prefix with stale completion flags never becomes a live item', () => {
  const live = turn('live', 'inProgress', [agent('current', 'prefix')]);
  const state = { turns: [live] }, { projector, events } = fixture(state);
  live.items.unshift(agent('historical', 'old text'));
  projector.update(state);
  live.items[0].text = 'reloaded historical text';
  live.status = 'completed';
  projector.update(state);
  assert.deepEqual(methods(events), ['item/completed', 'turn/completed']);
  assert.equal(events[0].params.item.id, 'current');
});

test('replacement of an active item inside a reused array is still projected', () => {
  const live = turn('live', 'inProgress', [agent('message', 'prefix')]);
  const state = { turns: [live] }, { projector, events } = fixture(state);
  live.items[0] = { ...live.items[0], text: 'prefix suffix' };
  projector.update(state);
  assert.equal(events.length, 1);
  assert.equal(events[0].params.delta, ' suffix');
  live.items[0].text = 'replaced';
  assert.throws(() => projector.update(state), /replaced already streamed text/);
});

test('unchanged turn references do not skip status, permissions, usage or pending requests', () => {
  const live = turn('live', 'inProgress', [agent('message', 'prefix')]);
  const state = { turns: [live], title: 'Before', threadRuntimeStatus: { type: 'active' },
    latestThreadSettings: { approvalPolicy: 'on-request' }, latestTokenUsageInfo: { total: 1 } };
  const { projector, events } = fixture(state);
  state.title = 'After';
  state.threadRuntimeStatus = { type: 'idle' };
  state.latestThreadSettings.approvalPolicy = 'never';
  state.latestTokenUsageInfo.total = 2;
  state.requests = [{ id: 'approval', completed: false }];
  projector.update(state);
  assert.deepEqual(methods(events), ['warning', 'thread/name/updated', 'thread/status/changed',
    'thread/settings/updated', 'thread/tokenUsage/updated']);
  assert.equal(events[3].params.threadSettings.approvalPolicy, 'never');
  assert.equal(events[4].params.turnId, 'live');
  projector.update(state);
  assert.equal(events.length, 5);
});

test('historical items are never visited and unchanged completed active items are not rescanned', () => {
  let historyReads = 0, completedTypeReads = 0;
  const historical = Array.from({ length: 2000 }, (_, index) => {
    const entry = turn(`old-${index}`);
    Object.defineProperty(entry, 'items', { get() { historyReads++; return [agent(`item-${index}`, 'old')]; } });
    return entry;
  });
  const completedItems = Array.from({ length: 200 }, (_, index) => {
    const item = agent(`done-${index}`, 'finished');
    Object.defineProperty(item, 'type', { get() { completedTypeReads++; return 'agentMessage'; } });
    return item;
  });
  const live = turn('live', 'inProgress', [...completedItems, agent('current', 'prefix')]);
  live.completedItemIds = Object.fromEntries(completedItems.map(item => [item.id, true]));
  const state = canonical([historical, [live]]), { projector, events } = fixture(state);
  assert.equal(historyReads, 0, 'even initial seeding only needs the live turn items');
  completedTypeReads = 0;
  for (let i = 0; i < 10; i++) projector.update(state);
  assert.equal(historyReads, 0);
  assert.equal(completedTypeReads, 0, 'unchanged active snapshots reuse their projection');
  live.items.at(-1).text += ' suffix';
  projector.update(state);
  assert.equal(historyReads, 0, 'a live delta cannot scan older turns');
  assert.equal(events.length, 1);
  assert.equal(events[0].params.delta, ' suffix');
});

test('loss of the live boundary still fails closed without emitting history completions', () => {
  const { projector, events } = fixture(canonical([[turn('tail')]]));
  assert.throws(() => projector.update(canonical([[turn('different')]])), /live history boundary changed/);
  assert.deepEqual(events, []);
});
