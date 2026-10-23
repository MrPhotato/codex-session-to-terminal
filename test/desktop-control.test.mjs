import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createDesktopController } from '../desktop-control.mjs';

const threadId = 'fixture-thread', messageId = 'fixture-client-message';
const userMessage = (overrides = {}) => ({ type: 'userMessage', id: 'server-message', clientId: messageId,
  content: [{ type: 'text', text: 'fixture' }], ...overrides });
const steeringMessage = (overrides = {}) => ({ type: 'steeringUserMessage', status: 'accepted',
  serverUserMessageId: 'server-message', serverClientUserMessageId: messageId,
  input: [{ type: 'text', text: 'fixture' }], ...overrides });
const turn = (turnId = 'new-turn', items = [], overrides = {}) => ({ turnId, status: 'inProgress', items, ...overrides });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

function fixture(t, { turns = [], reply, deliveryTimeoutMs } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const writes = [];
  const desktop = Object.assign(new EventEmitter(), {
    state: { id: threadId, cwd: 'C:\\fixture', turns }, status: { phase: 'ready', ready: true },
    currentOwner: { clientId: 'original-owner' },
    requestFollower(method, params) {
      assert.equal(this.listenerCount('state'), 1, 'subscribe before sending');
      assert.equal(this.listenerCount('status'), 1, 'observe owner continuity before sending');
      writes.push({ method, params });
      return reply ? reply(this) : Promise.reject(Object.assign(new Error('fixture timeout'), { code: 'REQUEST_TIMEOUT' }));
    },
  });
  const controller = createDesktopController(desktop, threadId, deliveryTimeoutMs === undefined ? {} : { deliveryTimeoutMs });
  return { desktop, writes, controller,
    call(method = 'turn/start') { return controller.call(method, { threadId, input: [{ type: 'text', text: 'fixture' }],
      clientUserMessageId: messageId, ...(method === 'turn/steer' ? { expectedTurnId: 'active-turn' } : {}) }); },
    publish(turns) { desktop.state = { ...desktop.state, turns }; desktop.emit('state', desktop.state); },
    clean() { assert.equal(writes.length, 1); assert.equal(desktop.listenerCount('state'), 0); assert.equal(desktop.listenerCount('status'), 0); },
  };
}

test('a valid RPC remains the fast path and releases receipt listeners', async t => {
  const result = { turn: { id: 'rpc-turn' } };
  const f = fixture(t, { reply: () => ({ result: { result } }) });
  assert.equal(await f.call(), result); f.clean();
  t.mock.timers.tick(30000); f.clean();
});

test('a late server receipt confirms a failed RPC without replaying the write', async t => {
  const f = fixture(t);
  const call = f.call(); await flush();
  t.mock.timers.tick(6000);
  f.publish([turn('accepted-turn', [userMessage()])]);
  const result = await call;
  assert.equal(result.turn.id, 'accepted-turn'); assert.equal(result.turn.items[0].id, 'server-message');
  f.clean();
});

test('a receipt observed before the RPC fails is retained and confirms immediately after failure', async t => {
  let rejectRpc;
  const f = fixture(t, { reply: () => new Promise((_resolve, reject) => { rejectRpc = reject; }) });
  const call = f.call();
  f.publish([turn('accepted-turn', [userMessage()], { status: 'completed' })]);
  rejectRpc(new Error('fixture remote handler timeout'));
  assert.equal((await call).turn.status, 'completed'); f.clean();
});

test('an invalid RPC result can be confirmed by a strict accepted steering receipt in a new turn', async t => {
  const f = fixture(t, { reply: () => ({ result: { result: {} } }) });
  const call = f.call(); await flush();
  f.publish([turn('accepted-turn', [steeringMessage()])]);
  assert.equal((await call).turn.id, 'accepted-turn'); f.clean();
});

test('canonical history supplies the same strict receipt without relying on local turn params', async t => {
  const f = fixture(t);
  const call = f.call(); await flush();
  f.desktop.state = { ...f.desktop.state, turns: [], turnHistory: { kind: 'canonical', history: {
    islands: [{ entries: [{ value: 'accepted-turn' }], olderBoundary: { status: 'exhausted' }, newerBoundary: { status: 'exhausted' } }],
    entitiesByKey: { 'accepted-turn': turn('accepted-turn', [userMessage()]) },
  } } };
  f.desktop.emit('state', f.desktop.state);
  assert.equal((await call).turn.id, 'accepted-turn'); f.clean();
});

test('an unconfirmed write has one total thirty-second budget and cleans up on expiry', async t => {
  const f = fixture(t);
  let settled = false;
  const call = f.call().finally(() => { settled = true; });
  const rejected = assert.rejects(call, /unconfirmed/);
  await flush(); t.mock.timers.tick(29999); await flush(); assert.equal(settled, false);
  t.mock.timers.tick(1); await rejected; f.clean();
});

test('the total budget includes a pending RPC and can use an already confirmed receipt at its deadline', async t => {
  const f = fixture(t, { reply: () => new Promise(() => {}), deliveryTimeoutMs: 20 });
  const call = f.call(); f.publish([turn('accepted-turn', [userMessage()])]);
  t.mock.timers.tick(20);
  assert.equal((await call).turn.id, 'accepted-turn'); f.clean();
});

test('start ignores old turns, other client IDs, same text and optimistic turn params', async t => {
  const f = fixture(t, { turns: [turn('old-turn', [userMessage()], { status: 'completed' })], deliveryTimeoutMs: 20 });
  const rejected = assert.rejects(f.call(), /unconfirmed/); await flush();
  f.publish([
    turn('old-turn', [userMessage({ id: 'another-server-id' })]),
    turn('other-turn', [userMessage({ clientId: 'another-client' })]),
    turn(null, [userMessage()]),
    turn('params-only', [], { params: { clientUserMessageId: messageId } }),
    turn('invalid-server-id', [userMessage({ id: '' })]),
  ]);
  t.mock.timers.tick(20); await rejected; f.clean();
});

test('steer confirms only the original expected turn and a server client ID', async t => {
  const f = fixture(t, { turns: [turn('active-turn')], deliveryTimeoutMs: 20 });
  const call = f.call('turn/steer'); await flush();
  f.publish([turn('other-turn', [userMessage()]), turn('active-turn', [steeringMessage({ serverClientUserMessageId: null, clientUserMessageId: messageId })])]);
  t.mock.timers.tick(10);
  f.publish([turn('active-turn', [steeringMessage()])]);
  assert.deepEqual(await call, { turnId: 'active-turn' }); f.clean();
});

test('steer ignores old receipts, pending steering items and receipts on another turn', async t => {
  const f = fixture(t, { turns: [turn('active-turn', [userMessage({ id: 'old-message' })])], deliveryTimeoutMs: 20 });
  const rejected = assert.rejects(f.call('turn/steer'), /unconfirmed/); await flush();
  f.publish([turn('active-turn', [userMessage({ id: 'old-message' }), steeringMessage({ status: 'pending' })]),
    turn('other-turn', [userMessage()])]);
  t.mock.timers.tick(20); await rejected; f.clean();
});

test('owner loss, close and syncing cancel observation even if a matching receipt follows', async t => {
  for (const phase of ['owner-unavailable', 'closed', 'syncing']) {
    const f = fixture(t, { deliveryTimeoutMs: 20 });
    const rejected = assert.rejects(f.call(), /unconfirmed/); await flush();
    f.desktop.status = { phase, ready: false }; f.desktop.emit('status', f.desktop.status);
    f.desktop.status = { phase: 'ready', ready: true }; f.publish([turn('accepted-turn', [userMessage()])]);
    await rejected; f.clean(); t.mock.timers.reset();
  }
});

test('a changed owner cannot confirm a receipt or a valid late RPC', async t => {
  let resolveRpc;
  const f = fixture(t, { reply: () => new Promise(resolve => { resolveRpc = resolve; }) });
  const rejected = assert.rejects(f.call(), /unconfirmed/);
  f.desktop.currentOwner = { clientId: 'different-owner' };
  f.publish([turn('accepted-turn', [userMessage()])]);
  resolveRpc({ result: { result: { turn: { id: 'accepted-turn' } } } });
  await rejected; f.clean();
});

test('losing readiness after a receipt prevents success when the RPC later fails', async t => {
  let rejectRpc;
  const f = fixture(t, { reply: () => new Promise((_resolve, reject) => { rejectRpc = reject; }) });
  const rejected = assert.rejects(f.call(), /unconfirmed/);
  f.publish([turn('accepted-turn', [userMessage()])]);
  f.desktop.status = { phase: 'syncing', ready: false }; f.desktop.emit('status', f.desktop.status);
  rejectRpc(new Error('fixture timeout')); await rejected; f.clean();
});

test('delivery budget validation does not permit unbounded waiting', () => {
  for (const deliveryTimeoutMs of [0, -1, 30001, 1.5]) assert.throws(() => createDesktopController({}, threadId, { deliveryTimeoutMs }), /deliveryTimeoutMs/);
});

test('a receipt from a different conversation cannot confirm this submission', async t => {
  const f = fixture(t, { deliveryTimeoutMs: 20 });
  const rejected = assert.rejects(f.call(), /unconfirmed/); await flush();
  f.desktop.state = { ...f.desktop.state, id: 'different-thread', turns: [turn('accepted-turn', [userMessage()])] };
  f.desktop.emit('state', f.desktop.state);
  t.mock.timers.tick(20); await rejected; f.clean();
});

test('a contradictory steer RPC cannot be overridden by an observed receipt', async t => {
  let resolveRpc;
  const f = fixture(t, { turns: [turn('active-turn')], reply: () => new Promise(resolve => { resolveRpc = resolve; }) });
  const rejected = assert.rejects(f.call('turn/steer'), /unconfirmed/);
  f.publish([turn('active-turn', [steeringMessage()])]);
  resolveRpc({ result: { result: { turnId: 'another-turn' } } });
  await rejected; f.clean();
});
