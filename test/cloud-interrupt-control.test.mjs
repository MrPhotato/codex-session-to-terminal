import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { interruptCloudTurn } from '../cloud-interrupt-control.mjs';

const threadId = 'cloud-fixture-thread', turnId = 'cloud-fixture-turn', frontendMessageId = 'frontend-message';
const ownerId = 'original-owner', method = 'thread-follower-interrupt-turn';
const params = { threadId, turnId, frontendMessageId, timeoutMs: 50 };
const user = () => ({ type: 'userMessage', id: 'native-user-item', clientId: frontendMessageId,
  content: [{ type: 'text', text: 'synthetic fixture' }] });
const turn = (status = 'inProgress', items = [user()]) => ({ turnId, status, items });
const state = (value = turn()) => ({ id: threadId, hostId: 'durable', turns: [],
  threadRuntimeStatus: { type: value.status === 'inProgress' ? 'active' : 'idle' },
  turnHistory: { kind: 'canonical', history: {
    islands: [{ entries: [{ value: 'current' }], olderBoundary: { status: 'available' }, newerBoundary: { status: 'exhausted' } }],
    entitiesByKey: { current: value },
  } },
});
const receipt = (result = { ok: true, interruptedTurnId: turnId }, overrides = {}) => ({
  type: 'response', requestId: 'native-request-id', resultType: 'success', method,
  handledByClientId: ownerId, result, ...overrides,
});
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

function fixture(t, reply = () => receipt()) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const desktop = Object.assign(new EventEmitter(), {
    hostId: 'durable', threadId, state: state(), revision: 3,
    currentOwner: { clientId: ownerId }, status: { phase: 'ready', ready: true },
    requestFollower(name, value) {
      assert.equal(this.listenerCount('state'), 1); assert.equal(this.listenerCount('status'), 1);
      calls.push({ method: name, params: value });
      return reply(this);
    },
  });
  return { desktop, calls,
    call(extra = {}) { return interruptCloudTurn(desktop, { ...params, ...extra }); },
    publish(value = turn('interrupted'), revision = desktop.revision + 1) {
      desktop.state = state(value); desktop.revision = revision; desktop.emit('state', desktop.state);
    },
    clean(count = 1) {
      assert.equal(calls.length, count); assert.equal(desktop.listenerCount('state'), 0); assert.equal(desktop.listenerCount('status'), 0);
    },
  };
}

test('exact RPC receipt and newer authoritative turn state confirm only native interruption', async t => {
  const f = fixture(t), pending = f.call(); await flush();
  f.publish();
  const result = await pending;
  assert.equal(result.status, 'interrupted'); assert.equal(result.rpcConfirmed, true); assert.equal(result.nativeObserved, true);
  assert.equal(result.backendConfirmed, false); assert.equal(result.frontendConfirmed, false);
  assert.equal(result.outcomeUnknown, false);
  assert.deepEqual(f.calls, [{ method, params: { conversationId: threadId, mode: 'user-stop', expectedTurnId: turnId } }]);
  f.clean();
});

test('a native state arriving before its RPC receipt is retained without premature success', async t => {
  let accept;
  const f = fixture(t, () => new Promise(resolve => { accept = resolve; }));
  let settled = false;
  const pending = f.call().then(result => { settled = true; return result; });
  f.publish(); await flush(); assert.equal(settled, false);
  accept(receipt());
  assert.equal((await pending).status, 'interrupted'); f.clean();
});

test('interrupted turn with temporarily active runtime retains a late receipt without claiming backend idle', async t => {
  let accept;
  const f = fixture(t, () => new Promise(resolve => { accept = resolve; }));
  let settled = false;
  const pending = f.call().then(result => { settled = true; return result; });
  f.desktop.state = state(turn('interrupted')); f.desktop.state.threadRuntimeStatus = { type: 'active' };
  f.desktop.revision++; f.desktop.emit('state', f.desktop.state);
  await flush(); assert.equal(settled, false);
  accept(receipt());
  const result = await pending;
  assert.equal(result.status, 'interrupted'); assert.equal(result.nativeObserved, true);
  assert.equal(result.backendConfirmed, false); assert.equal(result.frontendConfirmed, false); f.clean();
});

test('post-attempt newest history gaps prevent native-state confirmation', async t => {
  const f = fixture(t), pending = f.call(); await flush();
  f.desktop.state = state(turn('interrupted'));
  f.desktop.state.turnHistory.history.islands[0].newerBoundary = { status: 'available' };
  f.desktop.revision++; f.desktop.emit('state', f.desktop.state);
  const result = await pending;
  assert.equal(result.status, 'outcome-unknown'); assert.equal(result.reason, 'current-history-unavailable'); f.clean();
});

test('a valid receipt alone cannot confirm native state or backend completion', async t => {
  const f = fixture(t), pending = f.call(); await flush();
  t.mock.timers.tick(50);
  const result = await pending;
  assert.equal(result.status, 'outcome-unknown'); assert.equal(result.rpcConfirmed, true); assert.equal(result.nativeObserved, false);
  assert.equal(result.backendConfirmed, false); f.clean();
});

test('native interrupted state without an RPC receipt is observed separately at the deadline', async t => {
  const f = fixture(t, () => new Promise(() => {})), pending = f.call();
  f.publish(); t.mock.timers.tick(50);
  const result = await pending;
  assert.equal(result.status, 'outcome-unknown'); assert.equal(result.nativeObserved, true); assert.equal(result.rpcConfirmed, false);
  assert.equal(result.backendConfirmed, false); assert.equal(result.frontendConfirmed, false); f.clean();
});

test('RPC rejection followed by a native interruption never becomes a confirmed receipt', async t => {
  const f = fixture(t, () => Promise.reject(Object.assign(new Error('fixture timeout'), { code: 'REQUEST_TIMEOUT' })));
  const pending = f.call(); await flush(); f.publish();
  const result = await pending;
  assert.equal(result.status, 'outcome-unknown'); assert.equal(result.nativeObserved, true); assert.equal(result.rpcConfirmed, false); f.clean();
});

test('ok true with null interruptedTurnId means no matching turn was interrupted by this request', async t => {
  const f = fixture(t, () => receipt({ ok: true, interruptedTurnId: null }));
  const result = await f.call();
  assert.equal(result.status, 'not-interrupted'); assert.equal(result.rpcConfirmed, false); assert.equal(result.nativeObserved, false); f.clean();
});

test('contradictory or malformed receipts cannot be overridden by observed state', async t => {
  for (const response of [receipt({ ok: true, interruptedTurnId: 'replacement-turn' }), receipt({ ok: true }),
    receipt({ ok: false, interruptedTurnId: turnId }), receipt(undefined, { handledByClientId: 'other-owner' }),
    receipt(undefined, { method: 'thread-follower-start-turn' }), receipt(undefined, { requestId: '' }),
    { result: { ok: true, interruptedTurnId: turnId } }]) {
    let accept;
    const f = fixture(t, () => new Promise(resolve => { accept = resolve; }));
    const pending = f.call(); f.publish(); accept(response);
    const result = await pending;
    assert.equal(result.status, 'outcome-unknown'); assert.equal(result.nativeObserved, true); assert.equal(result.rpcConfirmed, false);
    f.clean(); t.mock.timers.reset();
  }
});

test('goal pause error stays distinct from exact native turn interruption', async t => {
  const f = fixture(t, () => receipt({ ok: true, interruptedTurnId: turnId, goalPauseError: 'fixture goal failure' }));
  const pending = f.call(); await flush(); f.publish();
  const result = await pending;
  assert.equal(result.status, 'interrupted'); assert.equal(result.goalPauseError, true); assert.equal(result.backendConfirmed, false); f.clean();
});

test('owner replacement, disconnection or resync terminates confirmation and releases listeners', async t => {
  for (const change of ['owner', 'disconnected', 'syncing', 'wrong-host', 'wrong-thread']) {
    const f = fixture(t, () => new Promise(() => {})), pending = f.call();
    if (change === 'owner') f.desktop.currentOwner = { clientId: 'replacement-owner' };
    else if (change === 'wrong-host') f.desktop.state.hostId = 'local';
    else if (change === 'wrong-thread') f.desktop.state.id = 'other-thread';
    else f.desktop.status = { phase: change, ready: false };
    f.desktop.emit('status', f.desktop.status);
    const result = await pending;
    assert.equal(result.status, 'outcome-unknown'); assert.equal(result.nativeObserved, false); f.clean(); t.mock.timers.reset();
  }
});

test('same text, optimistic items and another frontend client ID cannot authorize an interrupt', t => {
  for (const items of [[], [{ ...user(), clientId: 'other-message' }], [{ ...user(), id: '' }],
    [{ type: 'steeringUserMessage', status: 'accepted', serverClientUserMessageId: frontendMessageId }],
    [{ type: 'agentMessage', id: 'assistant', clientId: frontendMessageId, text: 'synthetic fixture' }]]) {
    const f = fixture(t); f.desktop.state = state(turn('inProgress', items));
    assert.throws(() => f.call(), { code: 'FRONTEND_MESSAGE_MISMATCH' }); f.clean(0); t.mock.timers.reset();
  }
});

test('preflight requires durable readiness, original thread and a valid state revision', t => {
  for (const change of [desktop => { desktop.hostId = 'local'; }, desktop => { desktop.threadId = 'other'; },
    desktop => { desktop.state.id = 'other'; }, desktop => { desktop.state.hostId = 'local'; },
    desktop => { desktop.status.ready = false; }, desktop => { desktop.currentOwner = null; },
    desktop => { desktop.revision = null; }]) {
    const f = fixture(t); change(f.desktop);
    assert.throws(() => f.call(), { code: 'NOT_READY' }); f.clean(0); t.mock.timers.reset();
  }
});

test('missing newest history or a changed active turn sends nothing', t => {
  for (const change of [desktop => { desktop.state.turnHistory.history.islands[0].newerBoundary.status = 'available'; },
    desktop => { desktop.state.turnHistory.history.entitiesByKey.current.status = 'completed'; },
    desktop => { desktop.state.turnHistory.history.entitiesByKey.current.turnId = 'replacement'; }]) {
    const f = fixture(t); change(f.desktop);
    assert.throws(() => f.call()); f.clean(0); t.mock.timers.reset();
  }
});

test('stale revisions and uninstalled event arguments cannot supply authoritative confirmation', async t => {
  const f = fixture(t), pending = f.call(); await flush();
  f.desktop.emit('state', state(turn('interrupted')));
  f.publish(turn('interrupted'), 3);
  t.mock.timers.tick(50);
  const result = await pending;
  assert.equal(result.status, 'outcome-unknown'); assert.equal(result.nativeObserved, false); f.clean();
});

test('a different interrupted turn or a completed target is not the selected interruption', async t => {
  for (const value of [{ ...turn('interrupted'), turnId: 'other-turn' }, turn('completed'), turn('failed'),
    turn('interrupted', [{ ...user(), clientId: 'other-message' }])]) {
    const f = fixture(t), pending = f.call(); await flush(); f.publish(value); t.mock.timers.tick(50);
    const result = await pending;
    assert.equal(result.status, 'outcome-unknown'); assert.equal(result.nativeObserved, false); f.clean(); t.mock.timers.reset();
  }
});

test('a total timeout covers pending RPC and blocks repeated attempts of the same turn', async t => {
  const f = fixture(t, () => new Promise(() => {})), pending = f.call();
  assert.throws(() => f.call(), { code: 'INTERRUPT_PENDING' });
  t.mock.timers.tick(50);
  assert.equal((await pending).status, 'outcome-unknown');
  assert.throws(() => f.call(), { code: 'INTERRUPT_ALREADY_ATTEMPTED' }); f.clean();
});

test('cancellation before send is safe and cancellation after the attempt does not retry', async t => {
  const f = fixture(t, () => new Promise(() => {})), controller = new AbortController();
  controller.abort(); assert.throws(() => f.call({ signal: controller.signal }), { code: 'ABORTED' }); f.clean(0);
  const next = new AbortController(), pending = f.call({ signal: next.signal }); next.abort();
  assert.equal((await pending).status, 'outcome-unknown'); f.clean();
});

test('required explicit IDs and wait bounds are validated without sending', t => {
  const f = fixture(t);
  for (const key of ['threadId', 'turnId', 'frontendMessageId']) for (const value of [undefined, '', ' ', 1, 'x'.repeat(257)]) {
    assert.throws(() => f.call({ [key]: value }), new RegExp(key));
  }
  for (const timeoutMs of [0, -1, 30001, 1.5, null]) assert.throws(() => f.call({ timeoutMs }), /timeoutMs/);
  f.clean(0);
});
