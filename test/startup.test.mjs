import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { checkStartup, NOT_READY } from '../check-startup.mjs';

async function fixture(t, options = {}) {
  const parent = join(dirname(fileURLToPath(import.meta.url)), '..', '.test-work');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'startup-'));
  const token = randomBytes(32).toString('base64url');
  const requests = [];
  const denied = [];
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, verifyClient: info => info.req.headers.authorization === `Bearer ${token}` });
  await new Promise(resolve => server.once('listening', resolve));
  const config = { root, runtimeFile: join(root, 'runtime.json'), backendTokenFile: join(root, 'backend.token'), backendPort: server.address().port };
  const configPath = join(root, 'config.json');
  const generation = randomUUID();
  const runtime = { ready: true, generation, instanceId: randomUUID(), backendPort: config.backendPort };
  const save = (file, value) => writeFile(file, JSON.stringify(value));
  await Promise.all([save(configPath, config), save(config.runtimeFile, runtime), save(join(root, 'desktop.json'), { generation }), writeFile(config.backendTokenFile, token)]);
  server.on('connection', socket => socket.on('message', async bytes => {
    const message = JSON.parse(bytes.toString());
    if (message.method) requests.push(message.method);
    if (message.method === 'initialize' && !options.hang) {
      socket.send(JSON.stringify({ id: 'fixture-approval', method: 'item/commandExecution/requestApproval', params: {} }));
      socket.send(JSON.stringify({ id: message.id, result: { userAgent: 'fixture' } }));
    }
    if (message.id === 'fixture-approval') denied.push(message.error?.code);
    if (message.method === 'thread/loaded/list') {
      if (options.rotate) await save(join(root, 'desktop.json'), { generation: randomUUID() });
      const result = options.invalidShape ? { data: [123] } : { data: [] };
      socket.send(JSON.stringify({ id: message.id, result }));
    }
  }));
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return { config, configPath, generation, runtime, requests, denied, root, save, server };
}

test('startup waits for this generation and uses only authenticated read-only RPC', async t => {
  const f = await fixture(t);
  await f.save(f.config.runtimeFile, { ...f.runtime, ready: false });
  const checking = checkStartup({ configPath: f.configPath, generation: f.generation, timeoutMs: 2000, pollMs: 20 });
  await delay(80);
  assert.equal(f.requests.length, 0);
  await f.save(f.config.runtimeFile, f.runtime);
  assert.deepEqual(await checking, { ready: true });
  assert.deepEqual(f.requests, ['initialize', 'initialized', 'thread/loaded/list']);
  assert.deepEqual(f.denied, [-32601]);
});

test('a previous launch cannot pass startup even when its endpoint is reachable', async t => {
  const f = await fixture(t);
  await f.save(join(f.root, 'desktop.json'), { generation: randomUUID() });
  await assert.rejects(checkStartup({ configPath: f.configPath, generation: f.generation, timeoutMs: 200, pollMs: 20 }), { message: NOT_READY });
  assert.deepEqual(f.requests, []);
});

test('startup validates list response shape and rechecks ownership after RPC', async t => {
  for (const options of [{ invalidShape: true }, { rotate: true }]) {
    const f = await fixture(t, options);
    await assert.rejects(checkStartup({ configPath: f.configPath, generation: f.generation, timeoutMs: 250, pollMs: 20 }), { message: NOT_READY });
    assert(f.requests.includes('thread/loaded/list'));
    assert(f.requests.every(method => ['initialize', 'initialized', 'thread/loaded/list'].includes(method)));
  }
});

test('overall deadline bounds a server that opens its socket but never initializes', async t => {
  const f = await fixture(t, { hang: true });
  const started = Date.now();
  await assert.rejects(checkStartup({ configPath: f.configPath, generation: f.generation, timeoutMs: 200, pollMs: 20 }), { message: NOT_READY });
  assert(Date.now() - started < 1500, 'Handshake must obey the overall deadline.');
  assert.deepEqual(f.requests, ['initialize']);
  assert(f.server.address(), 'The checker leaves the backend running.');
});

test('invalid config errors expose neither private paths nor token content', async t => {
  const f = await fixture(t);
  await f.save(f.configPath, { ...f.config, backendPort: 'private-sensitive-fixture' });
  await assert.rejects(checkStartup({ configPath: f.configPath, generation: f.generation, timeoutMs: 200 }), { message: NOT_READY });
  assert.deepEqual(f.requests, []);
});
