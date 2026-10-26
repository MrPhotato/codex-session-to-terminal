import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { createTrayLease, renderScreen, wrapText } from '../cst-terminal.mjs';
import { verifiedDesktopTransport } from '../cst-transport.mjs';
import { DesktopIpcClient } from '../desktop-ipc.mjs';

function leaseFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'cst-lease-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const owner = { pid: 1234, startTicks: '639000000000000001' };
  writeFileSync(join(directory, 'owner.json'), JSON.stringify(owner));
  writeFileSync(join(directory, 'heartbeat'), 'fixture');
  return { directory, owner };
}

test('tray lease rejects crash, stale heartbeat, changed owner and permanent stop', t => {
  const { directory, owner } = leaseFixture(t);
  let alive = true;
  const lease = createTrayLease(directory, { isAlive: pid => alive && pid === owner.pid });
  assert.equal(lease(), true);
  alive = false; assert.equal(lease(), false); alive = true;
  const old = new Date(Date.now() - 20000);
  utimesSync(join(directory, 'heartbeat'), old, old); assert.equal(lease(), false);
  const current = new Date(); utimesSync(join(directory, 'heartbeat'), current, current);
  assert.equal(lease(), true);
  writeFileSync(join(directory, 'owner.json'), JSON.stringify({ ...owner, startTicks: '639000000000000002' }));
  assert.equal(lease(), false);
  writeFileSync(join(directory, 'owner.json'), JSON.stringify(owner));
  writeFileSync(join(directory, 'stop.flag'), 'stopped'); assert.equal(lease(), false);
});

test('lease rejects unsafe tick precision and missing state without throwing', t => {
  const { directory, owner } = leaseFixture(t);
  const lease = createTrayLease(directory, { isAlive: () => true });
  writeFileSync(join(directory, 'owner.json'), JSON.stringify({ ...owner, startTicks: 639000000000000001 }));
  assert.equal(lease(), false);
  writeFileSync(join(directory, 'owner.json'), '{'); assert.equal(lease(), false);
  assert.equal(createTrayLease(join(directory, 'missing'))(), false);
});

function childFixture() {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.exitCode = null; child.signalCode = null; child.kills = 0;
  child.kill = () => { child.kills++; child.signalCode = 'SIGTERM'; queueMicrotask(() => child.emit('close', null, 'SIGTERM')); return true; };
  return child;
}
const powershellPath = resolve('fixture-pwsh.exe');

test('transport keeps default local arguments and admits only an exact app-tools pipe name', async () => {
  for (const pipeName of [undefined, 'codex-app-tools-11111111-2222-4333-8444-555555555555']) {
    const child = childFixture(); let args;
    const pending = verifiedDesktopTransport(powershellPath, { pipeName, nativeHelperPath: null, spawnHelper: (_exe, value) => { args = value; return child; } })();
    child.stderr.write('CST_PIPE_VERIFIED\n');
    const stream = await pending;
    assert.equal(args.includes('-PipeName'), pipeName !== undefined);
    if (pipeName) assert.deepEqual(args.slice(-2), ['-PipeName', pipeName]);
    else assert.equal(args.at(-2), '-File');
    stream.destroy();
  }
  for (const pipeName of ['other', 'codex-app-tools-invalid', '\\\\.\\pipe\\codex-ipc', 'codex-ipc\n', 'codex-ipc; command']) {
    assert.throws(() => verifiedDesktopTransport(powershellPath, { pipeName, spawnHelper: () => assert.fail('must not spawn') }), /supported Desktop pipe/);
  }
});

test('compiled transport uses the same readiness gate and never falls back after a failed verification', async () => {
  const helper = resolve('Desktop-Pipe.exe');
  for (const reject of [false, true]) {
    const child = childFixture(); const calls = [];
    const pending = verifiedDesktopTransport(powershellPath, { nativeHelperPath: helper,
      spawnHelper: (exe, args, options) => { calls.push({exe,args,options}); return child; } })();
    assert.equal(calls[0].exe, helper); assert.deepEqual(calls[0].args, ['--pipe','codex-ipc']);
    assert.equal(calls[0].options.windowsHide, true);
    if (reject) {
      child.exitCode = 1; child.emit('close', 1, null);
      await assert.rejects(pending, /did not exit cleanly/);
    } else {
      child.stderr.write('CST_PIPE_VERIFIED\n'); const stream = await pending; stream.destroy();
    }
    assert.equal(calls.length, 1);
  }
});

test('transport waits for verified readiness and preserves split UTF8 IPC bytes', async () => {
  const child = childFixture(); let settled = false;
  const pending = verifiedDesktopTransport(powershellPath, { spawnHelper: () => child })();
  pending.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  // Independent OS pipes can deliver stdout before the stderr readiness marker.
  const bytes = Buffer.from('中文🙂'); child.stdout.write(bytes.subarray(0, 4));
  child.stderr.write('CST_PIPE_'); child.stderr.write('VERIFIED\n');
  const stream = await pending, chunks = [];
  stream.on('data', bytes => chunks.push(bytes));
  child.stdout.write(bytes.subarray(4));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(Buffer.concat(chunks), bytes);
  stream.destroy(); assert.equal(child.kills, 1);
});

test('transport cancellation before and after verification kills only its helper', async () => {
  for (const ready of [false, true]) {
    const child = childFixture(), abort = new AbortController();
    const pending = verifiedDesktopTransport(powershellPath, { spawnHelper: () => child })({ signal: abort.signal });
    if (ready) { child.stderr.write('CST_PIPE_VERIFIED\n'); const stream = await pending; abort.abort(); assert.equal(stream.destroyed, true); }
    else { abort.abort(); await assert.rejects(pending, /cancelled/); }
    assert.equal(child.kills, 1);
  }
});

test('transport EOF preserves drained bytes and waits for the helper clean close', async () => {
  const child = childFixture();
  const pending = verifiedDesktopTransport(powershellPath, { spawnHelper: () => child })();
  child.stderr.write('CST_PIPE_VERIFIED\n');
  const stream = await pending, chunks = [], errors = [];
  stream.on('data', bytes => chunks.push(bytes));
  stream.on('error', error => errors.push(error));
  const closed = new Promise(resolve => stream.once('close', resolve));
  child.stdout.end(Buffer.from('final IPC bytes'));
  stream.end();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(Buffer.concat(chunks), Buffer.from('final IPC bytes'));
  assert.equal(stream.destroyed, false);
  assert.equal(child.kills, 0);
  child.exitCode = 0; child.emit('close', 0, null);
  await closed;
  assert.equal(stream.destroyed, true);
  assert.equal(child.kills, 0);
  assert.deepEqual(errors, []);
});

test('transport EOF cannot hide a later failed, signaled or unknown helper exit', async () => {
  for (const [code, signal] of [[1, null], [null, 'SIGTERM'], [null, null], [0, 'SIGTERM']]) {
    const child = childFixture();
    const pending = verifiedDesktopTransport(powershellPath, { spawnHelper: () => child })();
    child.stderr.write('CST_PIPE_VERIFIED\n');
    const stream = await pending, errors = [];
    stream.on('error', error => errors.push(error)); stream.resume();
    const closed = new Promise(resolve => stream.once('close', resolve));
    stream.end(); child.stdout.end();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stream.destroyed, false);
    assert.equal(child.kills, 0);
    child.exitCode = code; child.signalCode = signal; child.emit('close', code, signal);
    await closed;
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /did not exit cleanly/);
  }
});

test('transport cancellation after EOF remains a failure while awaiting helper exit', async () => {
  const child = childFixture(), abort = new AbortController();
  const pending = verifiedDesktopTransport(powershellPath, { spawnHelper: () => child })({ signal: abort.signal });
  child.stderr.write('CST_PIPE_VERIFIED\n');
  const stream = await pending, errors = [];
  stream.on('error', error => errors.push(error)); stream.resume();
  const closed = new Promise(resolve => stream.once('close', resolve));
  stream.end(); child.stdout.end();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stream.destroyed, false);
  abort.abort();
  await closed;
  assert.equal(child.kills, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /cancelled/);
});

test('early spawn failure rejects without an unhandled stream error', async () => {
  const child = childFixture();
  const pending = verifiedDesktopTransport(powershellPath, { spawnHelper: () => child })();
  child.emit('error', new Error('spawn failed'));
  await assert.rejects(pending, /spawn failed/);
});

test('screen and wide characters remain within tiny resize dimensions', () => {
  const view = { title: '中文🙂', messages: [{ role: 'very long role', status: 'very long status', text: '你好🙂' }] };
  for (const columns of [2, 3, 5, 12]) for (const rows of [1, 2, 4, 7]) {
    const lines = stripVTControlCharacters(renderScreen(view, { columns, rows })).split('\r\n');
    assert.ok(lines.length <= rows);
    for (const line of lines) assert.equal(wrapText(line, columns - 1).length, 1);
  }
});

test('connection startup timeout is separate from the normal RPC timeout', async () => {
  const client = new DesktopIpcClient({ transportFactory: () => new Promise(() => {}), timeoutMs: 1, connectTimeoutMs: 40 });
  assert.equal(client.options.timeoutMs, 1); assert.equal(client.options.connectTimeoutMs, 40);
  const started = Date.now();
  await assert.rejects(client.connect('fixture-thread'), { code: 'CONNECT_TIMEOUT' });
  assert.ok(Date.now() - started >= 25);
  client.close();
});
