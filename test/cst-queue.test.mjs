import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { resolve } from 'node:path';
import { createQueueSender } from '../cst-queue.mjs';

function backend({ dropAdd = false, unsupported = false } = {}) {
  const calls = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.exitCode = null; child.signalCode = null;
  child.kill = () => { child.exitCode = 1; child.emit('exit', 1); };
  child.stdin = new Writable({ write(bytes, encoding, done) {
    const request = JSON.parse(bytes.toString()); calls.push(request);
    if (request.id !== undefined) queueMicrotask(() => {
      if (dropAdd && request.method === 'thread/queue/add') return;
      const response = unsupported && request.method === 'thread/queue/list'
        ? { id: request.id, error: { code: -32601 } }
        : { id: request.id, result: request.method === 'thread/queue/add' ? { queuedSubmission: { id: 'q1', clientUserMessageId: request.params.clientUserMessageId } } : { data: [] } };
      child.stdout.write(JSON.stringify(response) + '\n');
    });
    done();
  }, final(done) { child.exitCode = 0; child.emit('exit', 0); done(); } });
  return { calls, child, spawnBackend: () => child };
}

test('queue append uses only capability/list/add and never resumes or starts a turn', async () => {
  const mock = backend();
  const result = await createQueueSender(resolve('codex.exe'), mock)({ threadId: 'thread', text: '下一个任务', clientUserMessageId: 'message1' });
  assert.equal(result.action, 'queue');
  assert.deepEqual(mock.calls.map(x => x.method), ['initialize', 'initialized', 'thread/queue/list', 'thread/queue/add']);
  assert.equal(mock.calls.at(-1).params.input[0].text, '下一个任务');
  assert.equal(mock.child.exitCode, 0);
});

test('unsupported queue API fails before any write', async () => {
  const mock = backend({ unsupported: true });
  await assert.rejects(createQueueSender(resolve('codex.exe'), mock)({ threadId: 'thread', text: 'test', clientUserMessageId: 'm1' }));
  assert.equal(mock.calls.filter(x => x.method === 'thread/queue/add').length, 0);
});

test('ambiguous queue result is never retried or changed into start/steer', async () => {
  const mock = backend({ dropAdd: true });
  await assert.rejects(createQueueSender(resolve('codex.exe'), { ...mock, timeoutMs: 15 })({ threadId: 'thread', text: 'test', clientUserMessageId: 'm1' }), { code: 'QUEUE_OUTCOME_UNKNOWN' });
  assert.equal(mock.calls.filter(x => x.method === 'thread/queue/add').length, 1);
});

test('an already cancelled submission does not start a queue helper', async () => {
  const controller = new AbortController(); controller.abort();
  let spawned = false;
  await assert.rejects(createQueueSender(resolve('codex.exe'), { spawnBackend: () => { spawned = true; } })({ threadId: 'thread', text: 'test', clientUserMessageId: 'm1', signal: controller.signal }), { code: 'QUEUE_CANCELLED' });
  assert.equal(spawned, false);
});

test('cancelling an in-flight queue request closes only its helper and never retries', async () => {
  const mock = backend({ dropAdd: true }); const controller = new AbortController();
  const promise = createQueueSender(resolve('codex.exe'), mock)({ threadId: 'thread', text: 'test', clientUserMessageId: 'm1', signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(promise, { code: 'QUEUE_OUTCOME_UNKNOWN' });
  assert.equal(mock.calls.filter(x => x.method === 'thread/queue/add').length, 1);
  assert.notEqual(mock.child.exitCode, null);
});
