import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { JsonLineQueue, serverInvocation, shouldIntercept, backendArguments, writeRuntime } from '../bridge-shim.mjs';
import { RpcClient, localUrl } from '../rpc-client.mjs';

test('only the main Desktop backend is intercepted', () => {
  assert(serverInvocation(['-c', 'features.code_mode_host=true', 'app-server', '--analytics-default-enabled']));
  assert.equal(serverInvocation(['-c', 'app-server', '--version']), null);
  assert.equal(serverInvocation(['app-server', 'generate-json-schema', '--out', 'temp']), null);
  assert.equal(shouldIntercept(['app-server'], { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'codex_latex_preview' }, {}), false);
  assert.equal(shouldIntercept(['app-server', '--listen', 'stdio://'], { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop' }, {}), false);
  const args = ['-c', 'features.code_mode_host=true', 'app-server'];
  assert.deepEqual(backendArguments(args, { backendPort: 12345, backendTokenFile: 'fixture.token' }).slice(0, args.length), args);
  assert.throws(() => backendArguments(['app-server', '--listen=ws://127.0.0.1:1'], {}), /conflict/);
});

test('JSONL framing is bounded and preserves split input', () => {
  const queue = new JsonLineQueue(64);
  queue.push(Buffer.from('{"id":1}\r'));
  queue.push(Buffer.from('\n{"id":2}\n'));
  assert.equal(queue.shift().toString(), '{"id":1}');
  assert.equal(queue.shift().toString(), '{"id":2}');
  assert.equal(queue.bytes, 0);
  assert.throws(() => queue.push(Buffer.alloc(65)), /bounded/);
});

test('atomic runtime replacement retries temporary Windows sharing locks and cleans up', async () => {
  let attempts = 0, cleanup = 0;
  const io = {
    mkdir: async () => {}, writeFile: async () => {},
    rename: async () => { if (++attempts < 3) throw Object.assign(new Error('fixture lock'), { code: 'EPERM' }); },
    unlink: async () => { cleanup++; throw Object.assign(new Error('already renamed'), { code: 'ENOENT' }); },
  };
  await writeRuntime({ root: 'fixture', runtimeFile: 'fixture/runtime.json' }, { instanceId: 'fixture' }, io);
  assert.equal(attempts, 3);
  assert.equal(cleanup, 1);
  await assert.rejects(writeRuntime({ root: 'fixture', runtimeFile: 'fixture/runtime.json' }, { instanceId: 'fixture' }, {
    ...io, rename: async () => { throw Object.assign(new Error('fixture permanent failure'), { code: 'EIO' }); },
  }), /permanent failure/);
  assert.equal(cleanup, 2);
});

test('loopback RPC performs handshake and refuses interactive server requests', async () => {
  assert.throws(() => localUrl('ws://example.com:1234'), /loopback/);
  assert.throws(() => localUrl('ws://127.0.0.1:1234/?token=fixture'), /token/);
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  const requests = [];
  let denied;
  const refusal = new Promise(resolve => { denied = resolve; });
  server.on('connection', socket => socket.on('message', bytes => {
    const message = JSON.parse(bytes.toString());
    requests.push(message.method);
    if (message.method === 'initialize') socket.send(JSON.stringify({ id: message.id, result: { userAgent: 'fixture' } }));
    if (message.method === 'thread/loaded/list') {
      socket.send(JSON.stringify({ id: message.id, result: { data: [] } }));
      socket.send(JSON.stringify({ id: 'approval-fixture', method: 'item/commandExecution/requestApproval', params: {} }));
    }
    if (message.id === 'approval-fixture') denied(message.error?.code);
  }));
  const client = new RpcClient(`ws://127.0.0.1:${server.address().port}`, { createSocket: url => new WebSocket(url), timeoutMs: 2000 });
  try {
    await client.connect();
    assert.deepEqual((await client.call('thread/loaded/list')).data, []);
    assert.equal(await refusal, -32601);
    assert.deepEqual(requests.slice(0, 3), ['initialize', 'initialized', 'thread/loaded/list']);
  } finally {
    client.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  }
});

test('release checks capabilities without pinning the Desktop version and keeps the default terminal mode', async () => {
  const launcher = await readFile(new URL('../production.ps1', import.meta.url), 'utf8');
  assert(!launcher.includes('$expectedDesktop'));
  assert(!launcher.includes('until the launcher is revalidated'));
  assert(launcher.includes('Assert-SessionBridgeCliCapabilities'));
  assert(launcher.includes('check-startup.mjs'));
  assert(!launcher.includes('--no-alt-screen'));
  assert(launcher.includes("'SessionBridge'"));
});
