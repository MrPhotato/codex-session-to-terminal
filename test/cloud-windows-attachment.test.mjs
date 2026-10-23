import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudWindowsAttachment } from '../cloud-windows-attachment.mjs';

const threadId = 'a1111111-1111-4111-8111-111111111111';
const frontendId = '22222222-2222-4222-8222-222222222222';
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const calls = [], bridge = {
    endpoint: 'ws://127.0.0.1:10001', token: 'base-secret', status: { ready: true },
    manifest: { readonly: true }, evidence: { readonly: true },
    state: { id: threadId, hostId: 'durable', cwd: '/workspace/cloud' },
    async close() { calls.push('bridge-close'); },
  };
  const proxy = { endpoint: 'ws://127.0.0.1:10002', token: 'client-secret', records: {},
    async close() { calls.push('proxy-close'); } };
  let bridgeOptions, proxyOptions;
  const factories = {
    async createBridge(options) { bridgeOptions = options; calls.push('bridge-create'); return bridge; },
    createControlClient() { assert.fail('A read-only attachment must never construct a control client.'); },
    async createProxy(options) { proxyOptions = options; calls.push('proxy-create'); return proxy; },
  };
  return { calls, bridge, proxy, factories,
    get bridgeOptions() { return bridgeOptions; }, get proxyOptions() { return proxyOptions; } };
}

test('default cloud assembly exposes observation only and never creates a control client', async () => {
  const f = fixture(), attachment = await createCloudWindowsAttachment({ threadId }, f.factories);
  assert.deepEqual(f.calls, ['bridge-create', 'proxy-create']);
  assert.equal(f.proxyOptions.interruptControl, undefined);
  assert.equal(Object.hasOwn(f.proxyOptions, 'interruptControl'), false);
  assert.equal(f.bridgeOptions.allowControl, false);
  assert.equal(attachment.endpoint, f.proxy.endpoint); assert.equal(attachment.token, f.proxy.token);
  assert.equal(attachment.state.cwd, '/workspace/cloud');
  assert.equal(attachment.manifest.readonly, true);
  for (const operation of ['send', 'steer', 'queue', 'interrupt', 'filesystem']) assert.equal(attachment.manifest[operation], false);
  await attachment.close(); await attachment.close();
  assert.deepEqual(f.calls.slice(-2), ['proxy-close', 'bridge-close']);
  assert.equal(attachment.status.ready, false);
});

test('removed interrupt options reject before any resource or callback is accessed', async () => {
  let callbacks = 0;
  for (const options of [{ allowInterrupt: true },
    { allowInterrupt: true, frontendId, readConversation: async () => { callbacks++; } },
    { interruptControl: async () => { callbacks++; } }, { interruptControl: null }, { interruptControl: undefined }]) {
    const f = fixture();
    await assert.rejects(createCloudWindowsAttachment({ threadId, ...options }, f.factories), { code: 'READ_ONLY_REQUIRED' });
    assert.deepEqual(f.calls, []);
  }
  assert.equal(callbacks, 0);
});

test('an explicit false interrupt flag remains read-only without forwarding a control option', async () => {
  const f = fixture();
  const attachment = await createCloudWindowsAttachment({ threadId, allowInterrupt: false }, f.factories);
  assert.equal(attachment.manifest.readonly, true);
  assert.equal(attachment.manifest.interrupt, false);
  assert.equal(Object.hasOwn(f.proxyOptions, 'interruptControl'), false);
  assert.equal(Object.hasOwn(f.proxyOptions, 'allowInterrupt'), false);
  await attachment.close();
});

test('closing or aborting an attached cloud terminal never interrupts its running task', async () => {
  const f = fixture(), abort = new AbortController();
  const original = structuredClone(f.bridge.state);
  const attachment = await createCloudWindowsAttachment({ threadId, signal: abort.signal }, f.factories);
  abort.abort(); await attachment.close();
  assert.deepEqual(f.bridge.state, original);
  assert.deepEqual(f.calls, ['bridge-create', 'proxy-create', 'proxy-close', 'bridge-close']);
});

test('connection loss closes only owned resources and reports an unavailable owner', async () => {
  const f = fixture(), errors = [];
  const attachment = await createCloudWindowsAttachment({ threadId, onError: error => errors.push(error.code) }, f.factories);
  f.bridgeOptions.onStatus({ phase: 'owner-unavailable', ready: false });
  await tick();
  assert.deepEqual(errors, ['OWNER_UNAVAILABLE']);
  assert.equal(attachment.status.ready, false);
  assert.deepEqual(f.calls.slice(-2), ['proxy-close', 'bridge-close']);
});

test('specific disconnected reasons survive the status-before-error callback order', async () => {
  for (const code of ['CONNECT_TIMEOUT', 'REQUEST_TIMEOUT', 'REMOTE_ERROR', 'PROTOCOL_ERROR']) {
    const f = fixture(), errors = [];
    const attachment = await createCloudWindowsAttachment({ threadId, onError: error => errors.push(error.code) }, f.factories);
    f.bridgeOptions.onStatus({ phase: 'disconnected', ready: false, reason: code });
    f.bridgeOptions.onError(Object.assign(new Error('original connection error'), { code }));
    await tick();
    assert.deepEqual(errors, [code]);
    assert.equal(attachment.status.ready, false);
    assert.equal(f.calls.filter(call => call === 'bridge-close').length, 1);
    assert.equal(f.calls.filter(call => call === 'proxy-close').length, 1);
  }
});

test('detailed errors win over a generic disconnect status and preserve the first error', async () => {
  const f = fixture(), errors = [];
  const attachment = await createCloudWindowsAttachment({ threadId, onError: error => errors.push(error) }, f.factories);
  const original = Object.assign(new Error('specific setup failure'), { code: 'TRANSPORT_ERROR' });
  f.bridgeOptions.onStatus({ phase: 'disconnected', ready: false });
  f.bridgeOptions.onError(original);
  f.bridgeOptions.onError(Object.assign(new Error('late failure'), { code: 'REMOTE_ERROR' }));
  await tick();
  assert.deepEqual(errors, [original]);
  assert.equal(attachment.status.ready, false);
});

test('clean close statuses neither report failure nor mask the setup failure', async () => {
  const f = fixture(), errors = [];
  const attachment = await createCloudWindowsAttachment({ threadId, onError: error => errors.push(error.code) }, f.factories);
  f.bridgeOptions.onStatus({ phase: 'disconnected', ready: false, reason: 'CLOSED' });
  f.bridgeOptions.onStatus({ phase: 'closed', ready: false });
  await attachment.close();await tick();
  assert.deepEqual(errors, []);

  const failed = fixture(), setupError = Object.assign(new Error('bad snapshot'), { code: 'INCOMPLETE_CLOUD_METADATA' });
  failed.factories.createBridge = async args => {
    args.onStatus({ phase: 'disconnected', ready: false, reason: 'CLOSED' });
    args.onStatus({ phase: 'closed', ready: false });
    throw setupError;
  };
  await assert.rejects(createCloudWindowsAttachment({ threadId, onError: error => errors.push(error.code) }, failed.factories), error => error === setupError);
  await tick();assert.deepEqual(errors, []);
});

test('a failed proxy setup closes the read-only follower and cannot leak a terminal endpoint', async () => {
  const f = fixture();
  f.factories.createProxy = async () => { throw Object.assign(new Error('schema'), { code: 'PROTOCOL_SCHEMA_MISMATCH' }); };
  await assert.rejects(createCloudWindowsAttachment({ threadId }, f.factories), { code: 'PROTOCOL_SCHEMA_MISMATCH' });
  assert.deepEqual(f.calls, ['bridge-create', 'bridge-close']);
});

test('an adapter resolving after cancellation is immediately closed without starting the next layer', async () => {
  const f = fixture(), abort = new AbortController();
  let complete;
  f.factories.createBridge = () => new Promise(resolve => { complete = resolve; });
  const pending = createCloudWindowsAttachment({ threadId, signal: abort.signal }, f.factories);
  abort.abort(); complete(f.bridge);
  await assert.rejects(pending, { code: 'ABORTED' });
  assert.deepEqual(f.calls, ['bridge-close']);
});

test('abort between accepting a proxy and returning it cannot lose ownership of its endpoint', async () => {
  const f = fixture(), abort = new AbortController();
  f.factories.createProxy = () => {
    // The first await receives this resource; the nested microtask interrupts
    // the following await before an outside assignment could adopt it.
    queueMicrotask(() => queueMicrotask(() => abort.abort()));
    return f.proxy;
  };
  await assert.rejects(createCloudWindowsAttachment({ threadId, signal: abort.signal }, f.factories), { code: 'ABORTED' });
  assert.equal(f.calls.filter(value => value === 'proxy-close').length, 1);
  assert.equal(f.calls.filter(value => value === 'bridge-close').length, 1);
});

test('an already cancelled attachment creates no resources', async () => {
  const f = fixture(), abort = new AbortController();
  abort.abort();
  await assert.rejects(createCloudWindowsAttachment({ threadId, signal: abort.signal }, f.factories), { code: 'ABORTED' });
  assert.deepEqual(f.calls, []);
});

test('native UUID spelling is normalized for the read-only connection', async () => {
  const f = fixture();
  const attachment = await createCloudWindowsAttachment({ threadId: threadId.toUpperCase() }, f.factories);
  assert.equal(f.bridgeOptions.threadId, threadId);
  assert.equal(f.proxyOptions.bridge.state.id, threadId);
  await attachment.close();
});

test('cleanup failure does not replace the setup failure', async () => {
  const f = fixture();
  f.factories.createProxy = async () => { throw Object.assign(new Error('setup'), { code: 'PROXY_SETUP_FAILED' }); };
  f.bridge.close = async () => { f.calls.push('bridge-close'); throw new Error('bridge cleanup'); };
  await assert.rejects(createCloudWindowsAttachment({ threadId }, f.factories), { code: 'PROXY_SETUP_FAILED' });
  assert.deepEqual(f.calls, ['bridge-create', 'bridge-close']);
});

test('a proxy cleanup failure still closes the read-only follower', async () => {
  const f = fixture();
  f.proxy.close = async () => { f.calls.push('proxy-close'); throw new Error('proxy cleanup'); };
  const attachment = await createCloudWindowsAttachment({ threadId }, f.factories);
  await assert.rejects(attachment.close(), /proxy cleanup/);
  assert.deepEqual(f.calls.slice(-2), ['proxy-close', 'bridge-close']);
});

test('unsupported identities and malformed interrupt flags create no resources', async () => {
  for (const options of [{ threadId: 'bad' }, { threadId, allowInterrupt: 'yes' }]) {
    const f = fixture();
    await assert.rejects(createCloudWindowsAttachment(options, f.factories), { code: 'INVALID_CLOUD_ATTACHMENT' });
    assert.deepEqual(f.calls, []);
  }
});
