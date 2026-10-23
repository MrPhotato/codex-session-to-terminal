import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { defaultCliPath, nativeCliLaunch, nativeTerminalError, parseNativeArguments, runNativeTerminal, shouldWaitOnError } from '../cst-native-terminal.mjs';

const threadId = '11111111-2222-4333-8444-555555555555';
const options = {
  threadId, controlDirectory: resolve('test-control'), powershellPath: resolve('pwsh.exe'),
  backendPath: resolve('backend.exe'), cliPath: resolve('codex.exe'), check: false,
};
const args = ['--thread', threadId, '--control-directory', options.controlDirectory,
  '--powershell-path', options.powershellPath, '--backend-path', options.backendPath];
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

function fixture(extra = {}) {
  const events = new EventEmitter();
  const calls = { spawn: [], kill: [], statuses: [], states: [], bridgeClose: 0, presenceClose: 0, intervalsCleared: 0 };
  let leaseValid = true, tick, bridgeArgs;
  const child = new EventEmitter();
  child.kill = signal => { calls.kill.push(signal); queueMicrotask(() => child.emit('exit', null, signal)); return true; };
  const bridge = {
    endpoint: 'ws://127.0.0.1:32123', token: 'private-test-token',
    state: { title: 'Test chat', latestThreadSettings: { cwd: resolve('workspace'), approvalPolicy: 'on-request' } },
    status: { phase: 'ready', ready: true }, close: async () => { calls.bridgeClose++; },
  };
  const presence = {
    updateState: state => calls.states.push(state), updateStatus: status => calls.statuses.push(status),
    close: async () => { calls.presenceClose++; },
  };
  const dependencies = {
    createBridge: async value => { bridgeArgs = value; return bridge; },
    lease: () => leaseValid, createPresence: () => presence,
    spawnFn: (...values) => { calls.spawn.push(values); return child; },
    processEvents: events, environment: { KEEP_SETTING: 'unchanged' },
    setIntervalFn: (fn, duration) => { assert.equal(duration, 2000); tick = fn; return 42; },
    clearIntervalFn: value => { assert.equal(value, 42); calls.intervalsCleared++; },
    ...extra,
  };
  return { dependencies, child, bridge, calls, events, presence,
    get bridgeArgs() { return bridgeArgs; },
    expireLease() { leaseValid = false; tick?.(); }, tick() { tick?.(); } };
}

test('native arguments preserve the old required entry contract and default official executable', () => {
  assert.deepEqual(parseNativeArguments(args), { ...options, cliPath: defaultCliPath });
  assert.equal(parseNativeArguments([...args, '--check']).check, true);
  assert.equal(parseNativeArguments([...args, '--cli-path', options.cliPath]).cliPath, options.cliPath);
  for (const invalid of [[], [...args, '--check', '--check'], [...args, '--thread', threadId],
    [...args, '--cli-path', 'relative.exe'], [...args, '--unknown', 'x'], [...args, '--smoke-ms', '1']]) {
    assert.throws(() => parseNativeArguments(invalid), { code: 'INVALID_ARGUMENTS' });
  }
});

test('official CLI receives only queue config and same thread; token is child environment only', () => {
  const f = fixture();
  const source = { Keep: 'kept', CODEX_HOME: 'original-home', CST_NATIVE_TOKEN: 'old-token',
    cst_native_lab_token: 'lab-token', CODEX_SHARED_SESSION_TOKEN: 'shared-token' };
  const launch = nativeCliLaunch(options, f.bridge, source);
  assert.equal(launch.executable, options.cliPath);
  assert.deepEqual(launch.args, ['-c', 'tui.keymap.composer.queue=["ctrl-enter","tab"]', '--remote', f.bridge.endpoint,
    '--remote-auth-token-env', 'CST_NATIVE_TOKEN', 'resume', threadId]);
  assert.equal(launch.args.join(' ').includes(f.bridge.token), false);
  assert.equal(launch.options.env.CST_NATIVE_TOKEN, f.bridge.token);
  assert.equal(launch.options.env.cst_native_lab_token, undefined);
  assert.equal(launch.options.env.CODEX_SHARED_SESSION_TOKEN, undefined);
  assert.equal(launch.options.env.CODEX_HOME, source.CODEX_HOME);
  assert.equal(source.CST_NATIVE_TOKEN, 'old-token');
  assert.equal(launch.options.cwd, f.bridge.state.latestThreadSettings.cwd);
  assert.equal(launch.options.stdio, 'inherit');
  assert.equal(launch.options.shell, false);
  assert.equal(launch.args.some(x => /sandbox|approval|permission/.test(x)), false);
});

test('launch refuses non-loopback endpoints, URL credentials and unknown working directory', () => {
  const f = fixture();
  for (const endpoint of ['ws://example.com:123', 'wss://127.0.0.1:123', 'ws://user:secret@127.0.0.1:123']) {
    assert.throws(() => nativeCliLaunch(options, { ...f.bridge, endpoint }), { code: 'INVALID_BRIDGE' });
  }
  assert.throws(() => nativeCliLaunch(options, { ...f.bridge, state: {} }), { code: 'MISSING_CWD' });
});

test('a stopped tray never creates presence, connects or spawns', async () => {
  const f = fixture({ lease: () => false, createPresence: () => assert.fail('presence must not start') });
  await assert.rejects(runNativeTerminal(options, f.dependencies), { code: 'TRAY_STOPPED' });
  assert.equal(f.bridgeArgs, undefined);
  assert.equal(f.calls.spawn.length, 0);
});

test('normal CLI exit closes presence and bridge without stopping a Desktop task', async () => {
  const f = fixture();
  const run = runNativeTerminal(options, f.dependencies);
  await nextTurn();
  assert.equal(f.calls.spawn.length, 1);
  assert.equal(f.bridgeArgs.threadId, threadId);
  assert.equal(f.bridgeArgs.allowControl, true);
  f.bridgeArgs.onState({ title: 'Updated' });
  f.bridgeArgs.onStatus({ phase: 'ready', ready: true });
  f.child.emit('exit', 7, null);
  assert.equal(await run, 7);
  assert.equal(f.calls.bridgeClose, 1);
  assert.equal(f.calls.presenceClose, 1);
  assert.deepEqual(f.calls.kill, []);
  assert.equal(f.bridgeArgs.signal.aborted, true);
  assert.equal(f.events.listenerCount('SIGTERM'), 0);
  assert.equal(f.events.listenerCount('SIGINT'), 0);
});

test('lease expiry closes only owned CLI and bridge and disables callbacks', async () => {
  const f = fixture();
  const run = runNativeTerminal(options, f.dependencies);
  const rejected = assert.rejects(run, { code: 'TRAY_STOPPED' });
  await nextTurn();
  f.expireLease();
  await rejected;
  assert.deepEqual(f.calls.kill, ['SIGTERM']);
  assert.equal(f.calls.bridgeClose, 1);
  assert.equal(f.calls.presenceClose, 1);
  assert.equal(f.calls.intervalsCleared, 1);
  const count = f.calls.states.length;
  f.bridgeArgs.onState({ title: 'must not persist' });
  assert.equal(f.calls.states.length, count);
});

test('lease expiry aborts initialization and closes an adapter that resolves late', async () => {
  let finish, received;
  const f = fixture({ createBridge: value => { received = value; return new Promise(resolve => { finish = resolve; }); } });
  const run = runNativeTerminal(options, f.dependencies);
  const rejected = assert.rejects(run, { code: 'TRAY_STOPPED' });
  await nextTurn();
  f.expireLease();
  await rejected;
  assert.equal(received.signal.aborted, true);
  assert.equal(f.calls.spawn.length, 0);
  assert.equal(f.calls.presenceClose, 1);
  finish(f.bridge);
  await nextTurn();
  assert.equal(f.calls.bridgeClose, 1);
});

test('a failed bridge closes bookkeeping without starting CLI', async () => {
  const f = fixture({ createBridge: async () => { throw Object.assign(new Error('private response'), { code: 'SNAPSHOT_TIMEOUT' }); } });
  await assert.rejects(runNativeTerminal(options, f.dependencies), { code: 'SNAPSHOT_TIMEOUT' });
  assert.equal(f.calls.spawn.length, 0);
  assert.equal(f.calls.presenceClose, 1);
  assert.equal(f.events.listenerCount('SIGTERM'), 0);
});

test('initialization cleanup statuses never hide the original history, schema or metadata error', async () => {
  for (const code of ['HISTORY_TIMEOUT', 'PROTOCOL_SCHEMA_MISMATCH', 'METADATA_TIMEOUT']) {
    const original = Object.assign(new Error('private diagnostic details'), { code });
    let bridgeSignal;
    const f = fixture({ createBridge: async value => {
      bridgeSignal = value.signal;
      value.onStatus({ phase: 'ready', ready: true });
      value.onStatus({ phase: 'disconnected', ready: false, reason: 'CLOSED' });
      value.onStatus({ phase: 'closed', ready: false });
      // Mirrors the bridge's catch -> await stop() -> throw cause sequence.
      await nextTurn();
      assert.equal(value.signal.aborted, false);
      throw original;
    } });
    await assert.rejects(runNativeTerminal(options, f.dependencies), error => error === original);
    assert.equal(bridgeSignal.aborted, true);
    assert.equal(f.calls.spawn.length, 0);
    assert.equal(f.calls.presenceClose, 1);
  }
});

test('an initializer that returns after reporting a terminal status still fails closed', async () => {
  const f = fixture();
  f.dependencies.createBridge = async value => {
    value.onStatus({ phase: 'disconnected', ready: false, reason: 'PROTOCOL_ERROR' });
    return f.bridge; // Even a stale ready getter cannot authorize a CLI launch.
  };
  await assert.rejects(runNativeTerminal(options, f.dependencies), { code: 'PROTOCOL_ERROR' });
  assert.equal(f.calls.spawn.length, 0);
  assert.equal(f.calls.bridgeClose, 1);
  assert.equal(f.calls.presenceClose, 1);
});

test('specific connection errors survive a preceding disconnected status during initialization', async () => {
  const original = Object.assign(new Error('private transport details'), { code: 'PIPE_AUTH_FAILED' });
  const f = fixture({ createBridge: async value => {
    value.onStatus({ phase: 'disconnected', ready: false, reason: original.code });
    value.onError(original);
    throw original;
  } });
  await assert.rejects(runNativeTerminal(options, f.dependencies), error => error === original);
  assert.equal(f.calls.spawn.length, 0);
  assert.equal(f.calls.presenceClose, 1);
});

test('check mode connects read-only, verifies readiness and closes without spawning', async () => {
  const f = fixture();
  assert.equal(await runNativeTerminal({ ...options, check: true }, f.dependencies), 0);
  assert.equal(f.bridgeArgs.allowControl, false);
  assert.equal(f.calls.spawn.length, 0);
  assert.equal(f.calls.bridgeClose, 1);
  assert.equal(f.calls.presenceClose, 1);
  const broken = fixture();
  broken.bridge.status = { phase: 'syncing', ready: false };
  await assert.rejects(runNativeTerminal({ ...options, check: true }, broken.dependencies), { code: 'OWNER_UNAVAILABLE' });
});

test('CLI spawn failure removes bridge and presence without leaking spawn errors', async () => {
  const f = fixture({ spawnFn: () => { throw new Error('secret environmental details'); } });
  await assert.rejects(runNativeTerminal(options, f.dependencies), { code: 'CLI_START_FAILED' });
  assert.equal(f.calls.bridgeClose, 1);
  assert.equal(f.calls.presenceClose, 1);
});

test('asynchronous CLI error is sanitized and cleanup completes', async () => {
  const f = fixture();
  const run = runNativeTerminal(options, f.dependencies);
  const rejected = assert.rejects(run, { code: 'CLI_START_FAILED' });
  await nextTurn();
  f.child.emit('error', new Error('private path or account data'));
  await rejected;
  assert.equal(f.calls.bridgeClose, 1);
  assert.equal(f.calls.presenceClose, 1);
});

test('bridge disconnection ends the wrapper without retrying user operations', async () => {
  const f = fixture();
  const run = runNativeTerminal(options, f.dependencies);
  const rejected = assert.rejects(run, { code: 'OWNER_UNAVAILABLE' });
  await nextTurn();
  f.bridgeArgs.onStatus({ phase: 'disconnected', ready: false });
  await rejected;
  assert.deepEqual(f.calls.kill, ['SIGTERM']);
  assert.equal(f.calls.spawn.length, 1);
});

test('an established connection retains the specific safe disconnect reason and stops its CLI', async () => {
  const f = fixture();
  const run = runNativeTerminal(options, f.dependencies);
  const rejected = assert.rejects(run, { code: 'PROTOCOL_ERROR' });
  await nextTurn();
  f.bridgeArgs.onStatus({ phase: 'disconnected', ready: false, reason: 'PROTOCOL_ERROR' });
  await rejected;
  assert.deepEqual(f.calls.kill, ['SIGTERM']);
  assert.equal(f.calls.bridgeClose, 1);
  assert.equal(f.calls.presenceClose, 1);
});

test('external abort and process shutdown release only wrapper-owned resources', async () => {
  for (const type of ['abort', 'SIGTERM', 'SIGINT']) {
    const abort = new AbortController();
    const f = fixture({ signal: abort.signal });
    const run = runNativeTerminal(options, f.dependencies);
    const rejected = assert.rejects(run, { code: 'ABORTED' });
    await nextTurn();
    if (type === 'abort') abort.abort(); else f.events.emit(type);
    await rejected;
    assert.equal(f.calls.bridgeClose, 1);
    assert.equal(f.calls.presenceClose, 1);
    assert.deepEqual(f.calls.kill, ['SIGTERM']);
  }
});

test('displayed errors never echo raw exception messages or arbitrary error codes', () => {
  const secret = 'token-and-private-chat-content';
  assert.equal(nativeTerminalError({ message: secret, code: secret }).includes(secret), false);
  assert.match(nativeTerminalError({ code: 'SNAPSHOT_TIMEOUT', message: secret }, 'zh-CN'), /超时/);
  assert.match(nativeTerminalError({ code: 'HISTORY_TIMEOUT', message: secret }, 'en-SG'), /history timed out.*HISTORY_TIMEOUT/);
  assert.match(nativeTerminalError({ code: 'PROTOCOL_SCHEMA_MISMATCH' }, 'zh-TW'), /不兼容/);
  assert.match(nativeTerminalError({ code: 'FRAME_TOO_LARGE' }, 'zh-CN'), /超出了支持的通信大小/);
  assert.match(nativeTerminalError({ code: 'FUTURE_SAFE_CODE' }, 'en-US'), /\(FUTURE_SAFE_CODE\)$/);
  assert.equal(nativeTerminalError({ code: 'A'.repeat(65) }).includes('A'.repeat(65)), false);
});

test('interactive errors remain visible, but checks and explicit lifecycle exits never wait', () => {
  assert.equal(shouldWaitOnError({ code: 'HISTORY_TIMEOUT' }, true, false), true);
  assert.equal(shouldWaitOnError({ code: 'TRAY_STOPPED' }, true, false), false);
  assert.equal(shouldWaitOnError({ code: 'ABORTED' }, true, false), false);
  assert.equal(shouldWaitOnError({ code: 'CLI_START_FAILED' }, false, false), false);
  assert.equal(shouldWaitOnError({ code: 'CLI_START_FAILED' }, true, true), false);
});

test('production terminal host preserves local mode and binds the toolbar without navigation at startup',async()=>{
  let viewed,resolveView,opens=0,closed=0;
  const f=fixture({spawnFn:undefined,createButtonAction:args=>{
    assert.equal(args.threadId,threadId);assert.equal(args.hostId,'local');
    return {open:async()=>{opens++;return {navigated:true};},close:async()=>{closed++;}};
  },runView:async(launch,settings)=>{viewed={launch,settings};return new Promise(resolve=>{resolveView=resolve;});}});
  const running=runNativeTerminal(options,f.dependencies);await nextTurn();
  assert.equal(viewed.settings.mode,'local');assert.equal(opens,0);
  await viewed.settings.onOpenDesktop();assert.equal(opens,1);resolveView(0);
  assert.equal(await running,0);assert.equal(closed,1);assert.equal(f.calls.bridgeClose,1);
});
