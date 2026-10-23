import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createDesktopButtonAction as createAction } from '../desktop-button-action.mjs';
const createDesktopButtonAction = (options, dependencies) => createAction(options, { hasNativeHelper: async () => false, ...dependencies });

const options = { threadId: '11111111-2222-4333-8444-555555555555', hostId: 'local', powershellPath: resolve('pwsh.exe') };
test('unused toolbar does no IO; invalid targets fail before helper invocation', async () => {
  let calls = 0;
  const action = createDesktopButtonAction(options, { executeFn: async () => { calls++; } });
  await action.close(); assert.equal(calls, 0);
  for (const change of [{ threadId: 'bad' }, { hostId: 'ssh' }, { powershellPath: 'relative' }])
    assert.throws(() => createDesktopButtonAction({ ...options, ...change }), { code: 'INVALID_NAVIGATION_TARGET' });
});
test('each local/cloud click uses one short-lived helper and exactly the bound session', async () => {
  for (const hostId of ['local', 'durable']) {
    const calls = [], settings = { ...options, hostId };
    const action = createDesktopButtonAction(settings, { executeFn: async (...args) => {
      calls.push(args); return { stdout: JSON.stringify({ dispatched: true, foreground: false, status: 'NotForeground' }) };
    } });
    settings.threadId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    await assert.rejects(action.open(settings.threadId), { code: 'NAVIGATION_NOT_AUTHORIZED' });
    const result = await action.open();
    assert.equal(result.dispatched, true); assert.equal(result.focusConfirmed, false);
    assert.equal(result.pageReadyConfirmed, false); assert.equal('navigated' in result, false);
    assert.equal(result.nativeExecutionView, hostId === 'durable');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][1].slice(-6), ['-Action', 'OpenThread', '-ThreadId', options.threadId, '-HostId', hostId]);
    assert.equal(calls[0][2].windowsHide, true); assert.equal(calls[0][2].timeout, 15000);
    await action.open(); assert.equal(calls.length, 2); await action.close();
  }
});
test('a known refusal does not claim dispatch; later explicit clicks remain possible', async () => {
  let calls = 0;
  const action = createDesktopButtonAction(options, { executeFn: async () => {
    calls++; return { stdout: '{"dispatched":false,"foreground":false,"status":"SourceChanged"}' };
  } });
  await assert.rejects(action.open(), { code: 'DESKTOP_NAVIGATION_UNAVAILABLE' });
  await assert.rejects(action.open(), { code: 'DESKTOP_NAVIGATION_UNAVAILABLE' });
  assert.equal(calls, 2); await action.close();
});
test('lost or invalid helper receipt is uncertain and is never replayed automatically', async () => {
  for (const executeFn of [async () => { throw Error('private data'); }, async () => ({ stdout: 'invalid' })]) {
    const action = createDesktopButtonAction(options, { executeFn });
    await assert.rejects(action.open(), { code: 'NAVIGATION_OUTCOME_UNKNOWN' });
    await assert.rejects(action.open(), { code: 'NAVIGATION_OUTCOME_UNKNOWN' }); await action.close();
  }
});
test('concurrent clicks do not launch another helper; close aborts its owned helper only', async () => {
  let release, seenSignal, calls = 0;
  const action = createDesktopButtonAction(options, { executeFn: (_file, _args, settings) => {
    calls++; seenSignal = settings.signal; return new Promise(resolve => { release = resolve; });
  } });
  const pending = action.open(); await assert.rejects(action.open(), { code: 'NAVIGATION_IN_PROGRESS' });
  await new Promise(resolve => setImmediate(resolve));
  const closing = action.close(); assert.equal(seenSignal.aborted, true);
  release({ stdout: '{"dispatched":false,"foreground":false,"status":"SourceChanged"}' });
  await assert.rejects(pending, { code: 'NAVIGATOR_CLOSED' }); await closing; assert.equal(calls, 1);
});

test('the installed native helper bypasses PowerShell without fallback after a lost receipt', async () => {
  const calls = [];
  const action = createDesktopButtonAction(options, { hasNativeHelper: async () => true,
    executeFn: async (...args) => { calls.push(args); return { stdout: '{"dispatched":true,"foreground":true,"status":"Foreground"}' }; } });
  assert.equal((await action.open()).focusConfirmed, true);
  assert.ok(calls[0][0].endsWith('Desktop-Navigation.exe'));
  assert.deepEqual(calls[0][1], ['--thread', options.threadId, '--host', 'local']);
  assert.equal(calls[0][2].windowsHide, true); await action.close();
  const broken = createDesktopButtonAction(options, { hasNativeHelper: async () => true,
    executeFn: async () => { throw Error('process failed'); } });
  await assert.rejects(broken.open(), { code: 'NAVIGATION_OUTCOME_UNKNOWN' });
  await assert.rejects(broken.open(), { code: 'NAVIGATION_OUTCOME_UNKNOWN' }); await broken.close();
});

test('closing during the executable lookup cannot launch either helper', async () => {
  let release, calls = 0;
  const action = createDesktopButtonAction(options, { hasNativeHelper: () => new Promise(resolve => { release = resolve; }),
    executeFn: async () => { calls++; } });
  const pending = action.open(); const closing = action.close(); release(true);
  await assert.rejects(pending, { code: 'NAVIGATOR_CLOSED' }); await closing;
  assert.equal(calls, 0);
});
