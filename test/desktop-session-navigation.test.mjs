import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createDesktopSessionNavigator } from '../desktop-session-navigation.mjs';

const id = '11111111-2222-4333-8444-555555555555';
const other = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const settings = { threadId: id, kind: 'codex', hostId: 'durable',
  backendPath: resolve('backend.exe'), nodePath: resolve('node.exe'), powershellPath: resolve('pwsh.exe'), cwd: resolve('owned-navigation') };
const code = expected => error => error.code === expected;
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

function fixture(options = {}, implementations = {}) {
  const calls = [], target = { ...settings, ...options };
  const reader = {
    async readConversation(threadId, args) { calls.push({ read: threadId, args }); return { thread: { id: threadId, kind: target.kind, ...(target.kind === 'codex' ? { hostId: target.hostId } : {}) } }; },
    async navigateConversation(threadId) { calls.push({ navigate: threadId }); return { navigated: true }; },
    async close() { calls.push('closed'); },
    ...implementations,
  };
  const navigator = createDesktopSessionNavigator(target, { createReader: async args => { calls.push({ create: args }); return reader; } });
  return { navigator, calls, reader, target };
}

test('construction and closing before a click do no IO; unsupported target/control options fail', async () => {
  const f = fixture(); assert.deepEqual(f.calls, []);
  await f.navigator.close(); assert.deepEqual(f.calls, []);
  await assert.rejects(f.navigator.navigate(), code('NAVIGATOR_CLOSED'));
  for (const change of [{ threadId: 'bad' }, { kind: 'other' }, { hostId: 'unknown' }, { kind: 'chatgpt', hostId: 'durable' },
    { allowSendTargets: [id] }, { navigateTargets: [id] }, { cwd: 'relative' }]) {
    assert.throws(() => createDesktopSessionNavigator({ ...settings, ...change }), code('INVALID_NAVIGATION_TARGET'));
  }
});

test('each local, durable and explicit ChatGPT target uses its true identity and only its bound ID', async () => {
  for (const options of [{ hostId: 'local' }, { hostId: 'durable' }, { kind: 'chatgpt', hostId: null }]) {
    const f = fixture(options);
    await assert.rejects(f.navigator.navigate(other), code('NAVIGATION_NOT_AUTHORIZED'));
    assert.equal(f.calls.length, 0);
    const result = await f.navigator.navigate();
    assert.deepEqual(result, { threadId: id, kind: f.target.kind, hostId: f.target.hostId,
      nativeExecutionView: options.hostId === 'durable', navigated: true, focusConfirmed: false, pageReadyConfirmed: false });
    assert.deepEqual(f.calls[0].create.navigateTargets, [id]);
    assert.equal('allowSendTargets' in f.calls[0].create, false);
    assert.equal(f.calls[1].args.hostId, options.hostId === 'durable' ? 'durable' : undefined);
    assert.deepEqual(f.calls[2], { navigate: id });
    await f.navigator.close(); assert.equal(f.calls.at(-1), 'closed');
  }
});

test('target is immutable and mismatched kind/host/ID cannot navigate', async () => {
  const f = fixture(); f.target.threadId = other;
  assert.equal(f.navigator.target.threadId, id);
  assert.throws(() => { f.navigator.target.threadId = other; }, TypeError);
  for (const thread of [{ id: other, kind: 'codex', hostId: 'durable' }, { id, kind: 'chatgpt' }, { id, kind: 'codex', hostId: 'local' }]) {
    f.reader.readConversation = async () => ({ thread });
    await assert.rejects(f.navigator.navigate(), code('NAVIGATION_TARGET_MISMATCH'));
  }
  assert.equal(f.calls.some(call => call.navigate), false);
  await f.navigator.close();
});

test('close during lazy creation disposes the late helper and prevents both read and navigation', async () => {
  const pending = deferred(), entered = deferred(), calls = [];
  const navigator = createDesktopSessionNavigator(settings, { createReader: () => { entered.resolve(); return pending.promise; } });
  const navigate = navigator.navigate();
  const rejected = assert.rejects(navigate, code('NAVIGATOR_CLOSED'));
  await entered.promise;
  const closing = navigator.close();
  pending.resolve({ close: async () => calls.push('close'), readConversation: () => calls.push('read') });
  await closing; await rejected;
  assert.deepEqual(calls, ['close']);
  assert.strictEqual(navigator.close(), closing);
});

test('close during identity preflight never dispatches navigation', async () => {
  const pending = deferred(), entered = deferred();
  const f = fixture({}, { readConversation: () => { entered.resolve(); return pending.promise; } });
  const running = f.navigator.navigate(), rejected = assert.rejects(running, code('NAVIGATOR_CLOSED'));
  await entered.promise; await f.navigator.close();
  pending.resolve({ thread: { id, kind: 'codex', hostId: 'durable' } }); await rejected;
  assert.equal(f.calls.some(call => call.navigate), false);
});

test('concurrent clicks and an uncertain dispatched result never cause replay or close the caller terminal', async () => {
  const pending = deferred(), entered = deferred();
  let count = 0;
  const f = fixture({}, { navigateConversation: () => { count++; entered.resolve(); return pending.promise; } });
  const first = f.navigator.navigate(), rejected = assert.rejects(first, code('NAVIGATION_OUTCOME_UNKNOWN'));
  await entered.promise;
  await assert.rejects(f.navigator.navigate(), code('NAVIGATION_IN_PROGRESS'));
  pending.reject(Object.assign(new Error('timeout'), { code: 'RPC_TIMEOUT' })); await rejected;
  await assert.rejects(f.navigator.navigate(), code('NAVIGATION_OUTCOME_UNKNOWN'));
  assert.equal(count, 1); assert.equal(f.calls.includes('closed'), false);
  await f.navigator.close();
});

test('only a confirmed dispatch permits a later explicit click; invalid receipts stay locked', async () => {
  const f = fixture(); await f.navigator.navigate(); await f.navigator.navigate();
  assert.equal(f.calls.filter(call => call.create).length, 1);
  assert.equal(f.calls.filter(call => call.navigate).length, 2); await f.navigator.close();
  const invalid = fixture({}, { navigateConversation: async () => ({ navigated: false }) });
  await assert.rejects(invalid.navigator.navigate(), code('NAVIGATION_OUTCOME_UNKNOWN'));
  await assert.rejects(invalid.navigator.navigate(), code('NAVIGATION_OUTCOME_UNKNOWN'));
  await invalid.navigator.close();
});
