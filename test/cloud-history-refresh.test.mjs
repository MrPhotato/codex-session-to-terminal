import assert from 'node:assert/strict';
import test from 'node:test';
import { Duplex } from 'node:stream';
import { markCloudHistoryStale } from '../cloud-history-refresh.mjs';

const conversationId = '6ad73d84-aeec-83ec-ab74-5215898c55ff';
const clientId = '01a15c14-6334-7083-8763-48f8707d5f82';
function frame(message) {
  const body = Buffer.from(JSON.stringify(message)), header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}
function fixture(options = {}) {
  const messages = [], result = { messages, signal: null, ended: false };
  const stream = new Duplex({
    read() {},
    write(bytes, _encoding, callback) {
      assert.equal(bytes.readUInt32LE(0), bytes.length - 4);
      const message = JSON.parse(bytes.subarray(4));
      messages.push(message);
      if (options.holdBroadcast && message.type === 'broadcast') return;
      callback();
      if (message.method === 'initialize' && !options.noReply) queueMicrotask(() => {
        const reply = { type: 'response', requestId: message.requestId, method: 'initialize', resultType: 'success', result: { clientId } };
        if (options.reply) options.reply(stream, reply);
        else stream.push(frame(reply));
      });
    },
    final(callback) {
      result.ended = true;
      if (options.holdClose) return;
      callback(); stream.push(null);
    },
  });
  result.stream = stream;
  result.transportFactory = ({ signal }) => { result.signal = signal; return stream; };
  return result;
}

test('registers its own identity and writes only the exact single-chat invalidation', async () => {
  const f = fixture();
  assert.deepEqual(await markCloudHistoryStale({ conversationId, transportFactory: f.transportFactory }),
    { invalidationSent: true, refreshConfirmed: false });
  assert.equal(f.messages.length, 2);
  const [init, broadcast] = f.messages;
  assert.match(init.requestId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(init, { type: 'request', requestId: init.requestId, sourceClientId: 'initializing-client', version: 0,
    method: 'initialize', params: { clientType: 'cst-terminal' } });
  assert.deepEqual(broadcast, { type: 'broadcast', method: 'query-cache-invalidate', version: 0,
    sourceClientId: clientId, params: { queryKey: ['chatgpt-conversation', conversationId], reset: false } });
  assert.equal(f.ended, true);
  assert.equal(f.stream.destroyed, true);
  assert.equal(f.signal.aborted, true);
});

test('handles fragmented initialization and ignores unrelated broadcasts without claiming ownership', async () => {
  const f = fixture({ reply(stream, reply) {
    stream.push(frame({ type: 'broadcast', method: 'thread-stream-state-changed', params: { untrusted: true } }));
    stream.push(frame({ type: 'client-discovery-request', requestId: 'other-client', request: { method: 'thread-owner-discovery' } }));
    stream.push(frame({ ...reply, requestId: 'unrelated-response' }));
    const bytes = frame(reply);
    stream.push(bytes.subarray(0, 1)); stream.push(bytes.subarray(1, 5)); stream.push(bytes.subarray(5));
  } });
  await markCloudHistoryStale({ conversationId, transportFactory: f.transportFactory });
  assert.deepEqual(f.messages.map(message => message.method), ['initialize', 'query-cache-invalidate']);
});

test('rejects invalid IDs, arbitrary cache keys and reset/identity overrides before connecting', async () => {
  let connections = 0;
  const transportFactory = () => { connections++; };
  for (const invalid of ['', '*', 'chatgpt-conversation', 'not-a-uuid', `${conversationId} `, [conversationId], {}, null,
    '00000000-0000-0000-0000-000000000000']) {
    await assert.rejects(markCloudHistoryStale({ conversationId: invalid, transportFactory }), { code: 'INVALID_CONVERSATION' });
  }
  for (const override of [{ queryKey: [] }, { queryKey: ['chatgpt-conversation'] }, { reset: true },
    { sourceClientId: 'desktop' }, { targetClientIds: ['owner'] }, { method: 'thread-follower-start-turn' }]) {
    await assert.rejects(markCloudHistoryStale({ conversationId, transportFactory, ...override }), { code: 'INVALID_OPTIONS' });
  }
  for (const timeoutMs of [0, -1, 60001, Infinity, 1.5]) {
    await assert.rejects(markCloudHistoryStale({ conversationId, transportFactory, timeoutMs }), { code: 'INVALID_TIMEOUT' });
  }
  await assert.rejects(markCloudHistoryStale({ conversationId }), { code: 'VERIFIED_TRANSPORT_REQUIRED' });
  assert.equal(connections, 0);
});

test('initialization errors or malformed identities never send an invalidation', async () => {
  for (const response of [{ resultType: 'error', error: 'private diagnostic' }, { method: 'thread-owner-discovery' },
    { result: {} }, { result: { clientId: 'desktop' } }, { resultType: 'unknown' }]) {
    const f = fixture({ reply: (stream, reply) => stream.push(frame({ ...reply, ...response })) });
    await assert.rejects(markCloudHistoryStale({ conversationId, transportFactory: f.transportFactory }), error => {
      assert.ok(['INITIALIZE_REJECTED', 'PROTOCOL_ERROR'].includes(error.code));
      assert.equal(error.message.includes('private diagnostic'), false);
      assert.equal(error.invalidationSent, false);
      return true;
    });
    assert.deepEqual(f.messages.map(message => message.method), ['initialize']);
    assert.equal(f.stream.destroyed, true);
  }
});

test('bounds malformed frames and aggregate initialization traffic', async () => {
  for (const bytes of [Buffer.alloc(4), Buffer.from([1, 0, 16, 0]), frame(null), Buffer.from([1, 0, 0, 0, 123]),
    Buffer.alloc(2 * 1024 * 1024 + 1)]) {
    const f = fixture({ reply: stream => stream.push(bytes) });
    await assert.rejects(markCloudHistoryStale({ conversationId, transportFactory: f.transportFactory }), error => {
      assert.ok(['FRAME_TOO_LARGE', 'PROTOCOL_ERROR', 'RECEIVE_LIMIT'].includes(error.code));
      return true;
    });
    assert.equal(f.messages.length, 1);
    assert.equal(f.stream.destroyed, true);
  }
});

test('total timeout covers connection and destroys a transport that arrives late', async () => {
  let release, signal;
  const f = fixture();
  const pending = markCloudHistoryStale({ conversationId, timeoutMs: 20,
    transportFactory: options => { signal = options.signal; return new Promise(resolve => { release = resolve; }); } });
  await assert.rejects(pending, { code: 'TIMEOUT', invalidationSent: false, deliveryUnknown: false });
  assert.equal(signal.aborted, true);
  release(f.stream);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.stream.destroyed, true);
  assert.equal(f.messages.length, 0);
});

test('initialization, write and graceful-close stalls share one bounded deadline and clean up', async () => {
  for (const [options, sent, unknown, count] of [[{ noReply: true }, false, false, 1],
    [{ holdBroadcast: true }, false, true, 2], [{ holdClose: true }, false, true, 2]]) {
    const f = fixture(options);
    await assert.rejects(markCloudHistoryStale({ conversationId, transportFactory: f.transportFactory, timeoutMs: 20 }),
      { code: 'TIMEOUT', invalidationSent: sent, refreshConfirmed: false, deliveryUnknown: unknown });
    assert.equal(f.signal.aborted, true);
    assert.equal(f.stream.destroyed, true);
    assert.equal(f.messages.length, count);
  }
});

test('a failed proxy after accepting a broadcast leaves delivery unknown', async () => {
  const f = fixture({ holdClose: true });
  const pending = markCloudHistoryStale({ conversationId, transportFactory: f.transportFactory });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.ended, true);
  f.stream.destroy(new Error('proxy forwarding failed'));
  await assert.rejects(pending, { code: 'TRANSPORT_ERROR', invalidationSent: false,
    refreshConfirmed: false, deliveryUnknown: true });
  assert.equal(f.messages.length, 2);
});

test('premature disconnect and transport rejection fail without replay or remote controls', async () => {
  const f = fixture({ reply: stream => stream.destroy() });
  await assert.rejects(markCloudHistoryStale({ conversationId, transportFactory: f.transportFactory }), { code: 'DISCONNECTED' });
  assert.equal(f.messages.length, 1);
  let attempts = 0;
  await assert.rejects(markCloudHistoryStale({ conversationId, transportFactory: () => { attempts++; throw new Error('private'); } }),
    { code: 'CONNECTION_FAILED' });
  assert.equal(attempts, 1);
});
