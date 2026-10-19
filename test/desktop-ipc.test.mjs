import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { DesktopIpcClient, applyDesktopPatches } from '../desktop-ipc.mjs';

const threadId = 'fixture-thread';
const clientId = 'assigned-cst-client';
const ownerId = 'existing-owner';
function frame(message) {
  const body = Buffer.from(JSON.stringify(message)), head = Buffer.alloc(4);
  head.writeUInt32LE(body.length);
  return Buffer.concat([head, body]);
}
function state(status = 'completed') {
  return { id: threadId, cwd: 'C:\\fixture', latestModel: 'fixture-model', turns: [
    { turnId: 'turn-1', status, items: [{ type: 'agentMessage', text: 'hello' }] },
  ] };
}
function canonicalState({ partial = false, partialItems = false } = {}) {
  const conversation = state(), turn = conversation.turns[0];
  turn.itemsPagination = { hasLoadedOldest: !partialItems, ...(partialItems ? { evicted: true } : {}) };
  conversation.turns = [];
  conversation.turnHistory = { kind: 'canonical', history: {
    islands: [{ entries: [{ value: 'turn-1' }], olderBoundary: { status: partial ? 'available' : 'exhausted' }, newerBoundary: { status: 'exhausted' } }],
    entitiesByKey: { 'turn-1': turn },
  } };
  return conversation;
}
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(predicate) {
  for (let index = 0; index < 100; index++) { if (predicate()) return; await tick(); }
  throw new Error('Fixture condition timed out');
}
async function fixture(t, options = {}) {
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\cst-test-${randomUUID()}` : path.join(os.tmpdir(), `cst-${randomUUID()}.sock`);
  const sockets = new Set(), messages = [], controls = [];
  const result = { messages, controls, historyLoads: [], conversation: options.conversation ?? state(), revision: 1, owner: ownerId, follows: 0, dropSnapshots: options.dropSnapshots ?? 0 };
  const server = net.createServer(socket => {
    sockets.add(socket); result.socket = socket;
    socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on('data', bytes => {
      buffer = Buffer.concat([buffer, bytes]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const length = buffer.readUInt32LE(0), request = JSON.parse(buffer.subarray(4, length + 4));
        buffer = buffer.subarray(length + 4); messages.push(request);
        if (request.type === 'request') {
          if (request.method === 'initialize') result.reply(request, { clientId }, clientId);
          else if (request.method === 'thread-owner-discovery') result.reply(request, { supportsUntrustedAppInput: true }, result.owner);
          else if (request.method === 'thread-follower-load-complete-history') {
            result.historyLoads.push(request);
            options.onHistoryLoad?.(request, result);
          }
          else {
            controls.push(request);
            const accepted = request.method === 'thread-follower-start-turn' ? { turn: { id: 'turn-2' } } : { turnId: 'turn-1' };
            if (!options.dropWrites) result.reply(request, request.method === 'thread-follower-interrupt-turn'
              ? { ok: true, interruptedTurnId: 'turn-1' } : { result: options.unconfirmedWrite ? {} : accepted }, result.owner);
          }
        } else if (request.method === 'thread-stream-following-changed' && request.params.following) {
          result.follows++;
          if (result.dropSnapshots > 0) result.dropSnapshots--;
          else if (!options.noSnapshots) result.snapshot();
        }
      }
    });
  });
  result.reply = (request, response, handledByClientId) => result.socket.write(frame({ type: 'response', requestId: request.requestId, resultType: 'success', method: request.method, handledByClientId, result: response }));
  result.broadcast = (method, params, { source = result.owner, version = 11, target = clientId } = {}) => result.socket.write(frame({ type: 'broadcast', method, version, sourceClientId: source, targetClientIds: [target], params }));
  result.change = (change, extra) => result.broadcast('thread-stream-state-changed', { hostId: 'local', conversationId: threadId, change }, extra);
  result.snapshot = () => result.change({ type: 'snapshot', revision: result.revision, conversationState: result.conversation });
  result.patch = (patches, extra = {}) => result.change({ type: 'patches', baseRevision: result.revision, revision: ++result.revision, patches, ...extra });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
  const transportFactory = ({ signal }) => new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    const abort = () => socket.destroy();
    signal.addEventListener('abort', abort, { once: true });
    socket.once('close', () => signal.removeEventListener('abort', abort));
    socket.once('error', reject); socket.once('connect', () => resolve(socket));
  });
  const client = new DesktopIpcClient({ transportFactory, timeoutMs: 500, ...options.clientOptions });
  result.client = client;
  t.after(async () => { client.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return result;
}

// Exercise real request/deadline handling without waiting minutes or opening a
// pipe. Only the already-connected transport is replaced; replies still pass
// through the client's normal protocol receiver.
function clockedHistoryFixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = new DesktopIpcClient({ transportFactory() {} });
  const messages = [];
  client._closed = false; client._threadId = threadId; client._clientId = clientId;
  client._owner = { clientId: ownerId }; client._revision = 1;
  client._state = canonicalState({ partial: true }); client._status = { phase: 'ready', ready: true };
  client._socket = { writable: true, write(bytes) { messages.push(JSON.parse(bytes.subarray(4))); }, end() {}, destroy() {} };
  t.after(() => client.close());
  return { client, messages, reply(revision = 2) {
    const request = messages.find(message => message.method === 'thread-follower-load-complete-history');
    client._receive({ type: 'response', requestId: request.requestId, resultType: 'success', method: request.method,
      handledByClientId: ownerId, result: { revision } });
  }, snapshot() {
    client._receive({ type: 'broadcast', method: 'thread-stream-state-changed', version: 11, sourceClientId: ownerId,
      targetClientIds: [clientId], params: { hostId: 'local', conversationId: threadId,
        change: { type: 'snapshot', revision: 2, conversationState: canonicalState() } } });
  } };
}

test('requires a verified transport and validates bounds', () => {
  assert.throws(() => new DesktopIpcClient(), { code: 'VERIFIED_TRANSPORT_REQUIRED' });
  assert.throws(() => new DesktopIpcClient({ transportFactory() {}, maxFrameBytes: 300000000 }), /maxFrameBytes/);
  for (const option of ['snapshotTimeoutMs', 'snapshotRetryMs', 'maxSnapshotAttempts']) {
    assert.throws(() => new DesktopIpcClient({ transportFactory() {}, [option]: 0 }), new RegExp(option));
  }
});

test('the default admits the observed large history header up to the Desktop protocol cap without allocating its payload', t => {
  const client = new DesktopIpcClient({ transportFactory() {} });
  assert.equal(client.options.maxFrameBytes, 268435456);
  const allocations = [];
  // Exercise header admission with a tiny stand-in for the body. This does not
  // claim to test a 118 MiB transfer and never allocates private history bytes.
  t.mock.method(Buffer, 'allocUnsafe', bytes => { allocations.push(bytes); return Buffer.alloc(1); });
  const header = Buffer.alloc(4); header.writeUInt32LE(123537367);
  assert.doesNotThrow(() => client._parse(header));
  assert.deepEqual(allocations, [123537367]);
  const oversized = new DesktopIpcClient({ transportFactory() {} });
  header.writeUInt32LE(268435457);
  assert.throws(() => oversized._parse(header), { code: 'FRAME_TOO_LARGE', frameBytes: 268435457, limitBytes: 268435456 });
  assert.deepEqual(allocations, [123537367]);
  const limited = new DesktopIpcClient({ transportFactory() {}, maxFrameBytes: 64 * 1024 * 1024 });
  header.writeUInt32LE(123537367);
  assert.throws(() => limited._parse(header), { code: 'FRAME_TOO_LARGE', frameBytes: 123537367, limitBytes: 67108864 });
  assert.deepEqual(allocations, [123537367]);
});

test('discovers an existing owner with its own assigned identity, follows and cleans up', async t => {
  const f = await fixture(t);
  await f.client.connect(threadId);
  assert.equal(f.client.status.ready, true);
  assert.deepEqual(f.client.state, f.conversation);
  assert.equal(f.client.owner.clientId, ownerId);
  assert.equal(f.messages[0].params.clientType, 'cst-terminal');
  assert.equal(f.messages[1].sourceClientId, clientId);
  assert(!f.messages.some(message => /resume|start-turn/.test(message.method)));
  const owner = f.client.owner; owner.clientId = 'mutated';
  assert.equal(f.client.owner.clientId, ownerId);
  f.client.close();
  await tick();
  assert.equal(f.client.status.phase, 'closed');
  assert.equal(f.client.owner, null);
});

test('applies incremental text and rejects foreign source or destination', async t => {
  const f = await fixture(t); await f.client.connect(threadId);
  const changes = []; f.client.on('state', (_, metadata) => changes.push(metadata));
  const patch = [{ op: 'replace', path: ['turns', 0, 'items', 0, 'text'], value: 'streaming text' }];
  f.change({ type: 'patches', baseRevision: 1, revision: 2, patches: patch }, { source: 'foreign' });
  f.change({ type: 'patches', baseRevision: 1, revision: 2, patches: patch }, { target: 'other-client' });
  await tick(); assert.equal(f.client.revision, 1);
  f.patch(patch, { acceptedTextChanges: [{ kind: 'fixture' }] });
  await until(() => f.client.revision === 2);
  assert.equal(f.client.state.turns[0].items[0].text, 'streaming text');
  assert.equal(changes[0].acceptedTextChanges.length, 1);
  assert.equal(f.conversation.turns[0].items[0].text, 'hello');
});

test('revision gaps and invalid patches request a fresh snapshot without changing ownership', async t => {
  const f = await fixture(t); await f.client.connect(threadId);
  f.conversation = { ...state(), title: 'resynchronized' }; f.revision = 5;
  f.change({ type: 'patches', baseRevision: 4, revision: 5, patches: [] });
  await until(() => f.client.revision === 5);
  assert.equal(f.follows, 2); assert.equal(f.client.owner.clientId, ownerId);
  assert.equal(f.client.state.title, 'resynchronized');
  f.patch([{ op: 'replace', path: ['missing', 'key'], value: 'invalid' }]);
  await until(() => f.follows === 3 && f.client.status.ready);
  assert.equal(f.client.state.title, 'resynchronized');
});

test('patches are immutable and cannot traverse prototypes or invalid array indices', () => {
  const original = { a: [1, 2], safe: { text: 'original' } };
  assert.deepEqual(applyDesktopPatches(original, [
    { op: 'add', path: ['a', 1], value: 3 }, { op: 'remove', path: ['a', 0] },
  ]), { a: [3, 2], safe: { text: 'original' } });
  assert.deepEqual(original.a, [1, 2]);
  for (const path of [['__proto__', 'polluted'], ['constructor', 'prototype'], ['a', -1], ['a', 10]]) {
    assert.throws(() => applyDesktopPatches(original, [{ op: 'replace', path, value: true }]), { code: 'INVALID_PATCH' });
  }
  assert.equal({}.polluted, undefined);
});

test('idle steer sends one start with inherited settings and no resume or permission override', async t => {
  const f = await fixture(t); await f.client.connect(threadId);
  const sent = await f.client.send('new task', { mode: 'steer' });
  assert.equal(sent.action, 'start'); assert.equal(f.controls.length, 1);
  const request = f.controls[0];
  assert.equal(request.method, 'thread-follower-start-turn'); assert.equal(request.version, 2);
  assert.equal(request.targetClientId, ownerId); assert(!own(request, 'hostId'));
  assert.equal(request.params.turnStart.request.input[0].text, 'new task');
  assert.equal(request.params.turnStart.context.inheritThreadSettings, true);
  assert(!own(request.params.turnStart.request, 'approvalPolicy'));
});
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

test('active steer uses the existing owner and a distinct user message ID', async t => {
  const f = await fixture(t, { conversation: state('inProgress') }); await f.client.connect(threadId);
  const sent = await f.client.send('adjust task', { mode: 'steer' });
  assert.equal(sent.action, 'steer'); assert.equal(f.controls[0].method, 'thread-follower-steer-turn');
  assert.equal(f.controls[0].version, 1);
  assert.equal(f.controls[0].params.restoreMessage.id, sent.clientUserMessageId);
  assert.deepEqual(f.controls[0].params.restoreMessage.context.workspaceRoots, ['C:\\fixture']);
});

test('an empty start or steer result is uncertain and is never reported as delivered', async t => {
  for (const status of ['completed', 'inProgress']) {
    const f = await fixture(t, { conversation: state(status), unconfirmedWrite: true });
    await f.client.connect(threadId);
    await assert.rejects(f.client.send('one attempt'), { code: 'DELIVERY_UNCONFIRMED', outcomeUnknown: true });
    assert.equal(f.controls.length, 1);
  }
});

test('canonical history uses only a confirmed live tail', async t => {
  const canonical = state(); canonical.turnHistory = { kind: 'canonical', history: {
    islands: [{ newerBoundary: { status: 'exhausted' }, entries: [{ value: 'live' }] }],
    entitiesByKey: { live: state('inProgress').turns[0] },
  } };
  const f = await fixture(t, { conversation: canonical }); await f.client.connect(threadId);
  assert.equal((await f.client.send('follow up')).action, 'steer');
  f.conversation = { ...canonical, turnHistory: { ...canonical.turnHistory, history: { ...canonical.turnHistory.history,
    islands: [{ newerBoundary: { status: 'unknown' }, entries: [{ value: 'live' }] }],
  } } }; f.revision++; f.snapshot(); await until(() => f.client.revision === f.revision);
  await assert.rejects(f.client.send('unsafe history'), { code: 'INCOMPLETE_STATE' });
  assert.equal(f.controls.length, 1);
});

test('writes are never replayed on timeout and concurrent writes are refused', async t => {
  const f = await fixture(t, { dropWrites: true, clientOptions: { timeoutMs: 80 } }); await f.client.connect(threadId);
  const pending = f.client.send('only once');
  await assert.rejects(f.client.send('concurrent'), { code: 'SEND_IN_PROGRESS' });
  await assert.rejects(pending, { code: 'REQUEST_TIMEOUT', outcomeUnknown: true });
  await tick(); assert.equal(f.controls.length, 1);
});

test('an optimistic turn beside canonical history cannot be mistaken for idle', async t => {
  const conversation = state();
  conversation.turnHistory = { kind: 'canonical', history: {
    islands: [{ newerBoundary: { status: 'exhausted' }, entries: [{ value: 'previous' }] }],
    entitiesByKey: { previous: state().turns[0] },
  } };
  conversation.turns.push({ turnId: null, status: 'inProgress', items: [] });
  const f = await fixture(t, { conversation }); await f.client.connect(threadId);
  await assert.rejects(f.client.send('wait for admission'), { code: 'NOT_READY' });
  assert.equal(f.controls.length, 0);
});

test('owner disconnect prevents sends and a new owner connection refreshes state', async t => {
  const f = await fixture(t); await f.client.connect(threadId);
  f.broadcast('client-status-changed', { clientId: ownerId, status: 'disconnected' }, { version: 0 });
  await until(() => f.client.status.phase === 'owner-unavailable');
  await assert.rejects(f.client.send('not now'), { code: 'NOT_READY' });
  f.owner = 'new-owner'; f.revision = 0;
  f.broadcast('client-status-changed', { clientId: f.owner, status: 'connected' }, { version: 0 });
  await until(() => f.client.status.ready);
  assert.equal(f.client.owner.clientId, f.owner); assert.equal(f.controls.length, 0);
});

test('queue requires safe append injection and never sends whole-queue replacement', async t => {
  const f = await fixture(t); await f.client.connect(threadId);
  await assert.rejects(f.client.send('queued', { mode: 'queue' }), { code: 'UNSUPPORTED_QUEUE' });
  const calls = [];
  f.client.options.queueSender = async request => { calls.push(request); return { queued: true }; };
  assert.equal((await f.client.send('queued', { mode: 'queue' })).action, 'queue');
  assert.equal(calls.length, 1); assert.equal(calls[0].threadId, threadId);
  assert.equal(f.controls.length, 0);
  f.client.options.queueSender = async () => { throw new Error('fixture unknown'); };
  await assert.rejects(f.client.send('queue failure', { mode: 'queue' }), /fixture unknown/);
  assert.equal(f.controls.length, 0);
});

test('message bounds are UTF-8 byte based and validation never transmits', async t => {
  const f = await fixture(t, { clientOptions: { maxInputBytes: 6 } }); await f.client.connect(threadId);
  await assert.rejects(f.client.send('三个字'), { code: 'INVALID_INPUT' });
  await assert.rejects(f.client.send('   '), { code: 'INVALID_INPUT' });
  await assert.rejects(f.client.send('valid', { mode: 'invalid' }), { code: 'INVALID_MODE' });
  assert.equal(f.controls.length, 0);
});

test('oversized or unsupported protocol frames close the connection', async t => {
  const f = await fixture(t, { clientOptions: { maxFrameBytes: 2048 } }); await f.client.connect(threadId);
  let reported;
  f.client.once('error', error => { reported = error; });
  const header = Buffer.alloc(4); header.writeUInt32LE(2049); f.socket.write(header);
  await until(() => f.client.status.phase === 'disconnected');
  assert.equal(reported.frameBytes, 2049); assert.equal(reported.limitBytes, 2048);
  assert.match(reported.message, /2049.*2048/);
  await assert.rejects(f.client.send('closed'), { code: 'NOT_READY' });
});

test('invalid empty frame diagnostics expose only byte counts', async t => {
  const f = await fixture(t, { clientOptions: { maxFrameBytes: 2048 } }); await f.client.connect(threadId);
  let reported;
  f.client.once('error', error => { reported = error; });
  f.socket.write(Buffer.alloc(4));
  await until(() => f.client.status.phase === 'disconnected');
  assert.equal(reported.code, 'FRAME_TOO_LARGE'); assert.equal(reported.frameBytes, 0); assert.equal(reported.limitBytes, 2048);
});

test('outgoing oversize diagnostics do not include input contents or send a frame', async t => {
  const f = await fixture(t, { clientOptions: { maxFrameBytes: 2048 } }); await f.client.connect(threadId);
  await assert.rejects(f.client.requestFollower('thread-follower-steer-turn', { conversationId: threadId, text: 'private-marker'.repeat(300) }), error => {
    assert.equal(error.code, 'FRAME_TOO_LARGE'); assert(error.frameBytes > 2048); assert.equal(error.limitBytes, 2048);
    assert(!error.message.includes('private-marker')); return true;
  });
  assert.equal(f.controls.length, 0);
});

test('a missing snapshot times out and does not leave an indefinite connect', async t => {
  const f = await fixture(t, { noSnapshots: true, clientOptions: { snapshotTimeoutMs: 100, snapshotRetryMs: 15 } });
  await assert.rejects(f.client.connect(threadId), { code: 'SNAPSHOT_TIMEOUT' });
  assert.equal(f.client.status.phase, 'disconnected');
  assert.equal(f.follows, 3);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(f.follows, 3);
  assert.equal(f.controls.length, 0);
});

test('a lost initial snapshot retries only following and stops as soon as state arrives', async t => {
  const f = await fixture(t, { dropSnapshots: 1, clientOptions: { snapshotRetryMs: 20, snapshotTimeoutMs: 200 } });
  await f.client.connect(threadId);
  assert.equal(f.follows, 2);
  assert.equal(f.client.status.ready, true);
  assert.equal(f.client.owner.clientId, ownerId);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(f.follows, 2);
  assert.equal(f.controls.length, 0);
  assert.deepEqual(f.messages.filter(message => message.type === 'request').map(message => message.method), ['initialize', 'thread-owner-discovery']);
});

test('a lost resync snapshot recovers with the same owner after a revision gap', async t => {
  const f = await fixture(t, { clientOptions: { snapshotRetryMs: 20, snapshotTimeoutMs: 200 } });
  await f.client.connect(threadId);
  f.dropSnapshots = 1;
  f.conversation = { ...state(), title: 'current state' }; f.revision = 5;
  f.change({ type: 'patches', baseRevision: 4, revision: 5, patches: [] });
  await until(() => f.client.revision === 5);
  assert.equal(f.follows, 3);
  assert.equal(f.client.state.title, 'current state');
  assert.equal(f.client.owner.clientId, ownerId);
  assert.equal(f.controls.length, 0);
});

test('closing while waiting for a snapshot cancels all subscription retries', async t => {
  const f = await fixture(t, { noSnapshots: true, clientOptions: { snapshotRetryMs: 50, snapshotTimeoutMs: 200 } });
  const pending = assert.rejects(f.client.connect(threadId), { code: 'CLOSED' });
  await until(() => f.follows === 1);
  f.client.close();
  await pending;
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(f.follows, 1);
  assert.equal(f.controls.length, 0);
});

test('owner loss during initial snapshot rejects connect instead of hanging', async t => {
  const f = await fixture(t, { noSnapshots: true });
  const connected = f.client.connect(threadId);
  const rejected = assert.rejects(connected, { code: 'OWNER_DISCONNECTED' });
  await until(() => f.follows === 1);
  f.broadcast('client-status-changed', { clientId: ownerId, status: 'disconnected' }, { version: 0 });
  await rejected;
  assert.equal(f.client.status.phase, 'disconnected');
});

test('disconnect during a write reports an unknown outcome and does not retry', async t => {
  const f = await fixture(t, { dropWrites: true }); await f.client.connect(threadId);
  const pending = f.client.send('one attempt');
  const rejected = assert.rejects(pending, { outcomeUnknown: true });
  await until(() => f.controls.length === 1);
  f.socket.destroy(); await rejected;
  await tick(); assert.equal(f.controls.length, 1);
  assert.equal(f.client.status.phase, 'disconnected');
});

test('a foreign broadcast cannot impersonate owner disconnection', async t => {
  const f = await fixture(t); await f.client.connect(threadId);
  f.broadcast('client-status-changed', { clientId: ownerId, status: 'disconnected' }, { version: 0, source: 'foreign-client' });
  await tick(); assert.equal(f.client.status.ready, true);
});

test('stream version mismatch fails closed before any input is sent', async t => {
  const f = await fixture(t); await f.client.connect(threadId);
  f.change({ type: 'patches', baseRevision: 1, revision: 2, patches: [] }, { version: 12 });
  await until(() => f.client.status.phase === 'disconnected');
  assert.equal(f.client.status.reason, 'UNSUPPORTED_VERSION');
  await assert.rejects(f.client.send('do not transmit'), { code: 'NOT_READY' });
  assert.equal(f.controls.length, 0);
});

test('an unsupported snapshot protocol cancels pending retries without accepting state', async t => {
  const f = await fixture(t, { noSnapshots: true, clientOptions: { snapshotRetryMs: 50, snapshotTimeoutMs: 200 } });
  const pending = assert.rejects(f.client.connect(threadId), { code: 'UNSUPPORTED_VERSION' });
  await until(() => f.follows === 1);
  f.change({ type: 'snapshot', revision: 1, conversationState: f.conversation }, { version: 12 });
  await pending;
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(f.follows, 1);
  assert.equal(f.client.state, null);
  assert.equal(f.controls.length, 0);
});

test('split framing is accepted and unknown discovery requests are explicitly declined', async t => {
  const f = await fixture(t); await f.client.connect(threadId);
  const data = frame({ type: 'client-discovery-request', requestId: 'discovery-fixture', request: { method: 'irrelevant' } });
  for (const byte of data) f.socket.write(Buffer.from([byte]));
  await until(() => f.messages.some(message => message.type === 'client-discovery-response'));
  assert.deepEqual(f.messages.find(message => message.type === 'client-discovery-response').response, { canHandle: false });
});

test('public follower controls bind versions, conversation and owner while preserving the response envelope', async t => {
  const f = await fixture(t); await f.client.connect(threadId);
  for (const [method, version] of [['thread-follower-start-turn', 2], ['thread-follower-steer-turn', 1], ['thread-follower-interrupt-turn', 4]]) {
    const params = { conversationId: threadId, ...(method.endsWith('start-turn') ? { turnStart: { request: { threadId } } } : {}) };
    const response = await f.client.requestFollower(method, params);
    assert.equal(response.method, method); assert.equal(response.resultType, 'success');
    assert.equal(f.controls.at(-1).version, version); assert.equal(f.controls.at(-1).targetClientId, ownerId);
    assert.deepEqual(f.controls.at(-1).params, params);
  }
  assert.deepEqual(f.controls.map(request => request.method), ['thread-follower-start-turn', 'thread-follower-steer-turn', 'thread-follower-interrupt-turn']);
});

test('public follower validation never forwards unsupported, foreign or unavailable controls', async t => {
  const f = await fixture(t); await f.client.connect(threadId);
  await assert.rejects(f.client.requestFollower('thread-follower-load-complete-history', { conversationId: threadId }), { code: 'UNSUPPORTED_METHOD' });
  await assert.rejects(f.client.requestFollower('thread-follower-steer-turn', { conversationId: 'other' }), { code: 'INVALID_THREAD' });
  await assert.rejects(f.client.requestFollower('thread-follower-steer-turn', { conversationId: threadId, hostId: 'other' }), { code: 'INVALID_THREAD' });
  await assert.rejects(f.client.requestFollower('thread-follower-start-turn', { conversationId: threadId, turnStart: { request: { threadId: 'other' } } }), { code: 'INVALID_THREAD' });
  f.client.close();
  await assert.rejects(f.client.requestFollower('thread-follower-interrupt-turn', { conversationId: threadId }), { code: 'NOT_READY' });
  assert.equal(f.controls.length, 0); assert.equal(f.historyLoads.length, 0);
});

test('public controls mark an unconfirmed write and never replay it', async t => {
  const f = await fixture(t, { dropWrites: true, clientOptions: { timeoutMs: 60 } }); await f.client.connect(threadId);
  await assert.rejects(f.client.requestFollower('thread-follower-interrupt-turn', { conversationId: threadId }), { code: 'REQUEST_TIMEOUT', outcomeUnknown: true });
  await tick(); assert.equal(f.controls.length, 1);
  const pending = f.client.requestFollower('thread-follower-steer-turn', { conversationId: threadId });
  const rejected = assert.rejects(pending, { code: 'CLOSED', outcomeUnknown: true });
  await until(() => f.controls.length === 2); f.client.close(); await rejected;
  assert.equal(f.controls.length, 2);
});

test('already complete canonical history returns the same authoritative state without a request', async t => {
  const f = await fixture(t, { conversation: canonicalState() }); await f.client.connect(threadId);
  assert.equal(await f.client.ensureCompleteHistory(), f.client.state);
  assert.equal(f.historyLoads.length, 0); assert.equal(f.follows, 1);
  for (const timeoutMs of [0, -1, 335001, 1.5]) await assert.rejects(f.client.ensureCompleteHistory({ timeoutMs }), /timeoutMs/);
});

test('default history hydration may finish after sixty seconds within the Desktop request budget', async t => {
  const f = clockedHistoryFixture(t);
  let settled = false;
  const load = f.client.ensureCompleteHistory().finally(() => { settled = true; });
  const request = f.messages[0];
  assert.equal(request.method, 'thread-follower-load-complete-history'); assert.equal(request.timeoutMs, 305000);
  t.mock.timers.tick(65000); await Promise.resolve();
  assert.equal(settled, false); assert.equal(f.client._pending.size, 1);
  f.snapshot(); f.reply();
  assert.equal(await load, f.client.state);
  assert.equal(f.messages.length, 1); assert.equal(f.client._pending.size, 0); assert.equal(f.client._historyLoad, null);
});

test('the default history RPC expires at 305 seconds without another load request', async t => {
  const f = clockedHistoryFixture(t);
  const rejected = assert.rejects(f.client.ensureCompleteHistory(), { code: 'HISTORY_TIMEOUT', outcomeUnknown: false });
  t.mock.timers.tick(305000); await rejected;
  assert.equal(f.messages.length, 1); assert.equal(f.client._pending.size, 0); assert.equal(f.client._historyLoad, null);
  assert.equal(f.client.listenerCount('state'), 0); assert.equal(f.client.listenerCount('status'), 0);
});

test('a late history reply gets at most thirty seconds to publish its revision within the total bound', async t => {
  const f = clockedHistoryFixture(t);
  let settled = false;
  const load = f.client.ensureCompleteHistory().finally(() => { settled = true; });
  const rejected = assert.rejects(load, { code: 'HISTORY_TIMEOUT', outcomeUnknown: false });
  t.mock.timers.tick(304999); f.reply(); await Promise.resolve();
  t.mock.timers.tick(29999); await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1); await rejected;
  assert.equal(f.messages.filter(message => message.type === 'request').length, 1);
  assert(f.messages.filter(message => message.params?.following).length <= 3);
  assert.equal(f.client._pending.size, 0); assert.equal(f.client._historyLoad, null);
  assert.equal(f.client.listenerCount('state'), 0); assert.equal(f.client.listenerCount('status'), 0);
});

test('history loads once through the original owner and accepts state that arrives before its reply', async t => {
  const f = await fixture(t, { conversation: canonicalState({ partial: true }), onHistoryLoad(request, server) {
    server.conversation = canonicalState(); server.revision = 4; server.snapshot();
    server.reply(request, { revision: 4 }, server.owner);
  } });
  await f.client.connect(threadId);
  const complete = await f.client.ensureCompleteHistory({ timeoutMs: 300 });
  assert.equal(complete, f.client.state); assert.equal(f.client.revision, 4);
  assert.equal(f.historyLoads.length, 1); assert.equal(f.controls.length, 0);
  const request = f.historyLoads[0];
  assert.equal(request.version, 1); assert.equal(request.targetClientId, ownerId); assert.equal(request.timeoutMs, 300);
  assert.deepEqual(request.params, { conversationId: threadId });
  assert.equal(f.client.owner.clientId, ownerId); assert.equal(f.follows, 1);
  assert(!f.messages.some(message => /resume|start-turn/.test(message.method)));
});

test('per-turn partial or evicted items require a load and a missing publication is recovered by following', async t => {
  const f = await fixture(t, { conversation: canonicalState({ partialItems: true }), clientOptions: { snapshotRetryMs: 15 }, onHistoryLoad(request, server) {
    server.conversation = canonicalState(); server.revision = 2;
    server.reply(request, { revision: 2 }, server.owner);
  } });
  await f.client.connect(threadId);
  await f.client.ensureCompleteHistory({ timeoutMs: 200 });
  assert.equal(f.historyLoads.length, 1); assert.equal(f.follows, 2); assert.equal(f.client.revision, 2);
  await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(f.follows, 2);
});

test('complete state below the returned revision cannot finish history loading', async t => {
  const f = await fixture(t, { conversation: canonicalState({ partial: true }), clientOptions: { snapshotRetryMs: 100 }, onHistoryLoad(request, server) {
    server.conversation = canonicalState(); server.revision = 2; server.snapshot();
    server.reply(request, { revision: 3 }, server.owner);
  } });
  await f.client.connect(threadId);
  let completed = false;
  const load = f.client.ensureCompleteHistory({ timeoutMs: 400 }).then(result => { completed = true; return result; });
  await until(() => f.client.revision === 2); await tick(); assert.equal(completed, false);
  f.revision = 3; f.snapshot(); await load;
  assert.equal(f.client.revision, 3); assert.equal(f.historyLoads.length, 1);
});

test('history accepts complete authoritative patches at the acknowledged revision without another snapshot', async t => {
  const f = await fixture(t, { conversation: canonicalState({ partialItems: true }), onHistoryLoad(request, server) {
    server.reply(request, { revision: 2 }, server.owner);
    server.patch([{ op: 'replace', path: ['turnHistory', 'history', 'entitiesByKey', 'turn-1', 'itemsPagination', 'hasLoadedOldest'], value: true }]);
  } });
  await f.client.connect(threadId);
  const complete = await f.client.ensureCompleteHistory({ timeoutMs: 300 });
  assert.equal(complete.turnHistory.history.entitiesByKey['turn-1'].itemsPagination.hasLoadedOldest, true);
  assert.equal(f.client.revision, 2); assert.equal(f.follows, 1); assert.equal(f.historyLoads.length, 1);
});

test('history snapshot retries and the overall deadline are bounded without replaying the load', async t => {
  const f = await fixture(t, { conversation: canonicalState({ partial: true }), clientOptions: { snapshotRetryMs: 10 }, onHistoryLoad(request, server) {
    server.reply(request, { revision: 2 }, server.owner);
  } });
  await f.client.connect(threadId);
  const stateListeners = f.client.listenerCount('state'), statusListeners = f.client.listenerCount('status');
  await assert.rejects(f.client.ensureCompleteHistory({ timeoutMs: 90 }), { code: 'HISTORY_TIMEOUT', outcomeUnknown: false });
  assert.equal(f.historyLoads.length, 1); assert.equal(f.follows, 4); assert.equal(f.client.status.ready, true);
  assert.equal(f.client.listenerCount('state'), stateListeners); assert.equal(f.client.listenerCount('status'), statusListeners);
  assert.equal(f.client._pending.size, 0); assert.equal(f.client._historyLoad, null);
  await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(f.follows, 4);
});

test('a missing history reply times out once and removes its pending request', async t => {
  const f = await fixture(t, { conversation: canonicalState({ partial: true }) }); await f.client.connect(threadId);
  await assert.rejects(f.client.ensureCompleteHistory({ timeoutMs: 50 }), { code: 'HISTORY_TIMEOUT' });
  assert.equal(f.historyLoads.length, 1); assert.equal(f.follows, 1); assert.equal(f.client._pending.size, 0);
});

test('history waiting rejects on owner loss, close, or cancellation and never claims another owner', async t => {
  for (const action of ['owner-loss', 'close', 'abort']) {
    const f = await fixture(t, { conversation: canonicalState({ partial: true }) }); await f.client.connect(threadId);
    const abort = new AbortController();
    const load = f.client.ensureCompleteHistory({ timeoutMs: 300, signal: abort.signal });
    const rejected = assert.rejects(load, { code: action === 'owner-loss' ? 'OWNER_DISCONNECTED' : action === 'close' ? 'CLOSED' : 'ABORTED', outcomeUnknown: false });
    await until(() => f.historyLoads.length === 1);
    if (action === 'owner-loss') f.broadcast('client-status-changed', { clientId: ownerId, status: 'disconnected' }, { version: 0 });
    else if (action === 'close') f.client.close();
    else abort.abort();
    await rejected;
    assert.equal(f.client._pending.size, 0); assert.equal(f.client._historyLoad, null);
    assert.equal(f.historyLoads.length, 1); assert.equal(f.controls.length, 0);
  }
});

test('history refuses concurrent loads and invalid owner revision without hiding protocol failure', async t => {
  const f = await fixture(t, { conversation: canonicalState({ partial: true }) }); await f.client.connect(threadId);
  const load = f.client.ensureCompleteHistory({ timeoutMs: 300 });
  const rejected = assert.rejects(load, { code: 'PROTOCOL_ERROR' });
  await assert.rejects(f.client.ensureCompleteHistory(), { code: 'HISTORY_LOAD_IN_PROGRESS' });
  await until(() => f.historyLoads.length === 1);
  f.reply(f.historyLoads[0], { revision: 'invalid' }, ownerId); await rejected;
  assert.equal(f.historyLoads.length, 1); assert.equal(f.client._pending.size, 0);
});

test('history stream protocol failure rejects immediately and stops all recovery attempts', async t => {
  const f = await fixture(t, { conversation: canonicalState({ partial: true }), clientOptions: { snapshotRetryMs: 40 }, onHistoryLoad(request, server) {
    server.reply(request, { revision: 2 }, server.owner);
    server.change({ type: 'snapshot', revision: 2, conversationState: canonicalState() }, { version: 12 });
  } });
  await f.client.connect(threadId);
  await assert.rejects(f.client.ensureCompleteHistory({ timeoutMs: 300 }), { code: 'UNSUPPORTED_VERSION' });
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(f.historyLoads.length, 1); assert.equal(f.follows, 1);
  assert.equal(f.client._pending.size, 0); assert.equal(f.client.listenerCount('state'), 0);
});
