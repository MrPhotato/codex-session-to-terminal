import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createCloudInterruptController } from '../cloud-interrupt-controller.mjs';

const threadId = '11111111-1111-4111-8111-111111111111';
const frontendId = 'b2222222-2222-4222-8222-222222222222';
const frontendMessageId = '33333333-3333-4333-8333-333333333333';
const turnId = 'native-turn', ownerId = 'actual-owner';
const frontend = () => ({ thread: { id: frontendId, kind: 'chatgpt', status: { type: 'active' } },
  turns: [{ id: frontendMessageId, items: [{ type: 'userMessage', id: frontendMessageId, content: [] }] }] });
const active = () => ({ turnId, status: 'inProgress',
  items: [{ type: 'userMessage', id: 'native-item', clientId: frontendMessageId, content: [] }] });
function fixture(read = async () => frontend(), options = {}) {
  const requests = [], reads = [];
  const desktop = Object.assign(new EventEmitter(), {
    threadId, hostId: 'durable', currentOwner: { clientId: ownerId }, revision: 1,
    status: { ready: true }, state: { id: threadId, hostId: 'durable', threadRuntimeStatus: { type: 'active' }, turns: [active()] },
    requestFollower(method, params) {
      requests.push({ method, params });
      desktop.state = { ...desktop.state, threadRuntimeStatus: { type: 'idle' }, turns: [{ ...active(), status: 'interrupted' }] };
      desktop.revision++;
      desktop.emit('state', desktop.state);
      return { type: 'response', method, requestId: 'real-request', resultType: 'success',
        handledByClientId: ownerId, result: { ok: true, interruptedTurnId: turnId } };
    },
  });
  const callback = createCloudInterruptController({ desktop, frontendId,
    readConversation: async (...args) => { reads.push(args); return read(desktop); }, ...options });
  return { desktop, callback, reads, requests, call: () => callback({ threadId, turnId }) };
}
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const tick = () => new Promise(resolve => setImmediate(resolve));

test('official frontend identity confirmation enables exactly one native stop without a manual gate file', async () => {
  const f = fixture(), result = await f.call();
  assert.equal(result.status, 'interrupted');
  assert.equal(result.rpcConfirmed, true);
  assert.equal(result.backendConfirmed, false);
  assert.equal(result.frontendConfirmed, false);
  assert.deepEqual(result.frontendPreflight, { conversationId: frontendId, messageId: frontendMessageId, status: 'active' });
  assert.deepEqual(f.requests, [{ method: 'thread-follower-interrupt-turn',
    params: { conversationId: threadId, mode: 'user-stop', expectedTurnId: turnId } }]);
  assert.deepEqual(f.reads, [[frontendId, { turnLimit: 10, includeOutputs: false, maxOutputCharsPerItem: 1 }]]);
  assert.equal(f.desktop.listenerCount('state'), 0);
});

test('same message text, another frontend, stale idle state and duplicate IDs never authorize a stop', async () => {
  for (const change of [
    value => { value.thread.id = 'another-chat'; },
    value => { value.thread.kind = 'codex'; },
    value => { value.thread.status.type = 'idle'; },
    value => { delete value.thread.status; },
    value => { value.turns[0].items[0].id = 'same-text-but-different-message'; },
    value => { value.turns.push(structuredClone(value.turns[0])); },
    value => { value.turns[0].items[0].type = 'agentMessage'; },
  ]) {
    const f = fixture(async () => { const value = frontend(); change(value); return value; });
    await assert.rejects(f.call());
    assert.equal(f.requests.length, 0);
  }
});

test('a changed owner, replacement turn or new steered input during the frontend read prevents interruption', async () => {
  for (const change of [
    desktop => { desktop.currentOwner.clientId = 'replacement-owner'; },
    desktop => { desktop.state.turns[0].turnId = 'next-turn'; },
    desktop => { desktop.state.turns[0].status = 'completed'; },
    desktop => { desktop.status.ready = false; },
    desktop => { desktop.state.turns[0].items.push({ type: 'userMessage', id: 'new-item', clientId: '44444444-4444-4444-8444-444444444444' }); },
  ]) {
    const f = fixture(async desktop => { change(desktop); return frontend(); });
    await assert.rejects(f.call());
    assert.equal(f.requests.length, 0);
  }
});

test('unlinked native input and foreign caller parameters fail before any frontend IO', async () => {
  const f = fixture();
  for (const params of [{ threadId: frontendId, turnId }, { threadId, turnId, stopAll: true }, { threadId }]) {
    await assert.rejects(f.callback(params), { code: 'INVALID_THREAD' });
  }
  delete f.desktop.state.turns[0].items[0].clientId;
  await assert.rejects(f.call(), { code: 'FRONTEND_MESSAGE_UNAVAILABLE' });
  assert.equal(f.reads.length, 0); assert.equal(f.requests.length, 0);
});

test('concurrent stop attempts share neither an unconfirmed read nor a duplicate write', async () => {
  const waiting = deferred(), f = fixture(() => waiting.promise);
  const first = f.call();
  await assert.rejects(f.call(), { code: 'INTERRUPT_PENDING' });
  waiting.resolve(frontend());
  assert.equal((await first).status, 'interrupted');
  assert.equal(f.reads.length, 1); assert.equal(f.requests.length, 1);
});

test('a late frontend read after cancellation cannot send, and pending state is released', async () => {
  const abort = new AbortController(), waiting = deferred();
  const f = fixture(() => waiting.promise, { signal: abort.signal });
  const pending = f.call();
  const rejection = assert.rejects(pending, { code: 'ABORTED' });
  await tick(); abort.abort(); await rejection;
  waiting.resolve(frontend()); await tick();
  assert.equal(f.requests.length, 0);
  await assert.rejects(f.call(), { code: 'ABORTED' });
});

test('a late frontend read after its deadline cannot become a stop', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const waiting = deferred(), f = fixture(() => waiting.promise, { timeoutMs: 50 });
  const rejected = assert.rejects(f.call(), { code: 'FRONTEND_READ_TIMEOUT' });
  await tick(); t.mock.timers.tick(50); await rejected;
  waiting.resolve(frontend()); await tick();
  assert.equal(f.requests.length, 0);
});

test('frontend read errors are bounded, sanitized and never retried', async () => {
  const f = fixture(async () => { throw new Error('private response body'); });
  await assert.rejects(f.call(), error => error.code === 'FRONTEND_STATE_UNAVAILABLE' && !error.message.includes('private'));
  assert.equal(f.reads.length, 1); assert.equal(f.requests.length, 0);
});

test('frontend UUID spelling is normalized before official lookup and comparison', async () => {
  const f = fixture(undefined, { frontendId: frontendId.toUpperCase() });
  const result = await f.call();
  assert.equal(f.reads[0][0], frontendId);
  assert.equal(result.frontendPreflight.conversationId, frontendId);
  assert.equal(f.requests.length, 1);
});

test('immediate cancellation prevents the deferred frontend read from starting', async () => {
  const abort = new AbortController(), f = fixture(undefined, { signal: abort.signal });
  const pending = f.call();
  abort.abort();
  await assert.rejects(pending, { code: 'ABORTED' });
  await tick();
  assert.equal(f.reads.length, 0); assert.equal(f.requests.length, 0);
});

test('cancelling after the native send reports uncertainty without retry or leaked listeners', async () => {
  const abort = new AbortController(), reply = deferred();
  const f = fixture(undefined, { signal: abort.signal });
  f.desktop.requestFollower = (method, params) => {
    f.requests.push({ method, params });
    return reply.promise;
  };
  const pending = f.call();
  await tick(); assert.equal(f.requests.length, 1);
  abort.abort();
  const result = await pending;
  assert.equal(result.status, 'outcome-unknown'); assert.equal(result.rpcConfirmed, false);
  assert.equal(result.frontendConfirmed, false); assert.equal(result.backendConfirmed, false);
  reply.resolve({ type: 'response', method: 'thread-follower-interrupt-turn', requestId: 'late-request',
    resultType: 'success', handledByClientId: ownerId, result: { ok: true, interruptedTurnId: turnId } });
  await tick();
  assert.equal(f.requests.length, 1);
  assert.equal(f.desktop.listenerCount('state'), 0); assert.equal(f.desktop.listenerCount('status'), 0);
});
