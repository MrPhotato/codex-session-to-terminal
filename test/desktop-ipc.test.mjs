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
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(predicate) {
  for (let index = 0; index < 100; index++) { if (predicate()) return; await tick(); }
  throw new Error('Fixture condition timed out');
}
async function fixture(t, options = {}) {
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\cst-test-${randomUUID()}` : path.join(os.tmpdir(), `cst-${randomUUID()}.sock`);
  const sockets = new Set(), messages = [], controls = [];
  const result = { messages, controls, conversation: options.conversation ?? state(), revision: 1, owner: ownerId, follows: 0 };
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
          else {
            controls.push(request);
            const accepted = request.method === 'thread-follower-start-turn' ? { turn: { id: 'turn-2' } } : { turnId: 'turn-1' };
            if (!options.dropWrites) result.reply(request, { result: options.unconfirmedWrite ? {} : accepted }, result.owner);
          }
        } else if (request.method === 'thread-stream-following-changed' && request.params.following) {
          result.follows++;
          if (!options.noSnapshots) result.snapshot();
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

test('requires a verified transport and validates bounds', () => {
  assert.throws(() => new DesktopIpcClient(), { code: 'VERIFIED_TRANSPORT_REQUIRED' });
  assert.throws(() => new DesktopIpcClient({ transportFactory() {}, maxFrameBytes: 300000000 }), /maxFrameBytes/);
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
  const header = Buffer.alloc(4); header.writeUInt32LE(2049); f.socket.write(header);
  await until(() => f.client.status.phase === 'disconnected');
  await assert.rejects(f.client.send('closed'), { code: 'NOT_READY' });
});

test('a missing snapshot times out and does not leave an indefinite connect', async t => {
  const f = await fixture(t, { noSnapshots: true, clientOptions: { timeoutMs: 50 } });
  await assert.rejects(f.client.connect(threadId), { code: 'SNAPSHOT_TIMEOUT' });
  assert.equal(f.client.status.phase, 'disconnected');
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
  await assert.rejects(f.client.send('do not transmit'), { code: 'NOT_READY' });
  assert.equal(f.controls.length, 0);
});

test('split framing is accepted and unknown discovery requests are explicitly declined', async t => {
  const f = await fixture(t); await f.client.connect(threadId);
  const data = frame({ type: 'client-discovery-request', requestId: 'discovery-fixture', request: { method: 'irrelevant' } });
  for (const byte of data) f.socket.write(Buffer.from([byte]));
  await until(() => f.messages.some(message => message.type === 'client-discovery-response'));
  assert.deepEqual(f.messages.find(message => message.type === 'client-discovery-response').response, { canHandle: false });
});
