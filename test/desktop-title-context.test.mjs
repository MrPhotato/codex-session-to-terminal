import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeDesktopTitleContext, readDesktopTitleContext, recheckDesktopTitleContext, restoreDesktopPage, validDesktopTitleContext } from '../desktop-title-context.mjs';

const context = { version: 1, status: 'ready', pid: 123, window: 456, started: '639000000000000001',
  title: '云端聊天 "🙂"', documentRuntimeId: '42,-8,10', capturedAt: 100000 };
const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64');

test('observations preserve exact titles and process generation without accepting expired or malformed data', () => {
  assert.deepEqual(decodeDesktopTitleContext(encoded(context), 100010), context);
  for (const change of [{ capturedAt: 100011 }, { capturedAt: 70000 }, { started: 639000000000000001 },
    { pid: 0 }, { window: '456' }, { title: 'bad\x1b[0m' }, { documentRuntimeId: 'not-an-id' }, { status: 'unavailable' }]) {
    assert.equal(decodeDesktopTitleContext(encoded({ ...context, ...change }), 100010), null);
  }
  for (const value of ['x', '', undefined, encoded(context) + '\n', 'a'.repeat(8193)]) assert.equal(decodeDesktopTitleContext(value), null);
});

test('recheck is a bounded hidden read against the exact source window, never a shell or navigation', async () => {
  let calls = 0;
  const executeFn = async (helper, args, options) => {
    calls++; assert.match(helper, /Desktop-Context\.exe$/u);
    assert.deepEqual(args, ['--pid', '123', '--window', '456', '--started', context.started]);
    assert.equal(options.windowsHide, true); assert.equal(options.shell, false); assert.equal(options.timeout, 4000);
    return { stdout: JSON.stringify(context) };
  };
  assert.equal(await recheckDesktopTitleContext(context, { executeFn, now: () => 100010 }), true);
  assert.equal(calls, 1);
});

test('changed page/window/generation, a blocked helper, and cancellation all fall back', async () => {
  for (const change of [{ title: 'another' }, { documentRuntimeId: '42,-8,11' }, { pid: 124 },
    { window: 457 }, { started: '639000000000000002' }, { status: 'unavailable' }]) {
    assert.equal(await recheckDesktopTitleContext(context, { now: () => 100010,
      executeFn: async () => ({ stdout: JSON.stringify({ ...context, ...change }) }) }), false);
  }
  assert.equal(await recheckDesktopTitleContext(context, { now: () => 100010, executeFn: async () => { throw new Error('timeout'); } }), false);
  const abort = new AbortController(); abort.abort();
  assert.equal(await recheckDesktopTitleContext(context, { now: () => 100010, signal: abort.signal,
    executeFn: () => assert.fail('must not spawn') }), false);
  assert.equal(validDesktopTitleContext(null), false);
});

test('recheck diagnostics contain only a reason and duration and cannot affect selection', async () => {
  for (const [change, reason] of [[{}, 'matched'], [{ title: 'private title' }, 'title-changed'],
    [{ documentRuntimeId: '42,-8,11' }, 'document-changed'], [{ pid: 124 }, 'identity-changed'],
    [{ status: 'unavailable' }, 'unavailable']]) {
    const diagnostics = [];
    assert.equal(await recheckDesktopTitleContext(context, { now: () => 100010,
      executeFn: async () => ({ stdout: JSON.stringify({ ...context, ...change }) }),
      onDiagnostic: value => diagnostics.push(value) }), reason === 'matched');
    assert.deepEqual(diagnostics, [{ reason, elapsedMs: 0 }]);
  }
  assert.equal(await recheckDesktopTitleContext(context, { now: () => 100010,
    executeFn: async () => ({ stdout: JSON.stringify(context) }), onDiagnostic: () => { throw new Error('writer failed'); } }), true);
});

test('input epoch is optional for old readers but must be an exact uint when present', () => {
  assert.equal(validDesktopTitleContext(context), true);
  for (const lastInputTick of [0, 1, 0xffffffff]) {
    assert.equal(validDesktopTitleContext({ ...context, lastInputTick }), true);
    assert.equal(decodeDesktopTitleContext(encoded({ ...context, lastInputTick }), 100010).lastInputTick, lastInputTick);
  }
  for (const lastInputTick of [undefined, null, -1, 0x100000000, 1.1, '123', true, NaN]) {
    assert.equal(validDesktopTitleContext({ ...context, lastInputTick }), false);
  }
});

test('slow lookup can refresh age only after re-reading the same window generation and page', async () => {
  for (const change of [{}, { title: 'Other page' }, { documentRuntimeId: '42,99' }, { pid: 999 },
    { window: 999 }, { started: '639000000000000002' }]) {
    let reads = 0;
    const dependencies = { now: () => 180000, executeFn: async () => {
      reads++; return { stdout: JSON.stringify({ ...context, ...change }) };
    } };
    assert.equal(await recheckDesktopTitleContext(context, dependencies), false);
    assert.equal(reads, 0);
    assert.equal(await recheckDesktopTitleContext(context, { ...dependencies, refreshAge: true }), Object.keys(change).length === 0);
    assert.equal(reads, 1);
  }
});

test('fresh reads refresh the exact window generation without treating a title or input change as identity', async () => {
  const actual = { ...context, title: 'Changed page', documentRuntimeId: '42,-8,11', lastInputTick: 3123 };
  const refreshed = await readDesktopTitleContext(context, { now: () => 140001,
    executeFn: async (file, args, options) => {
      assert.match(file, /Desktop-Context\.exe$/u);
      assert.deepEqual(args, ['--pid', '123', '--window', '456', '--started', context.started]);
      assert.equal(options.windowsHide, true); assert.equal(options.shell, false); assert.equal(options.timeout, 4000);
      return { stdout: JSON.stringify(actual) };
    } });
  assert.deepEqual(refreshed, { ...actual, capturedAt: 140001 });
  assert.notEqual(refreshed, actual);
  assert.equal(context.title, '云端聊天 "🙂"');
  // Old read-only selection remains compatible; navigation callers decide if
  // a fresh input epoch has changed and whether to skip the return action.
  assert.equal(await recheckDesktopTitleContext(context, { now: () => 100010,
    executeFn: async () => ({ stdout: JSON.stringify({ ...context, lastInputTick: 999 }) }) }), true);
});

test('fresh reads reject unknown epoch values, drifted identity, unreadable snapshots and cancellation', async () => {
  for (const change of [{ pid: 124 }, { window: 457 }, { started: '639000000000000002' },
    { status: 'unavailable' }, { lastInputTick: null }, { lastInputTick: '4' }]) {
    assert.equal(await readDesktopTitleContext(context, { now: () => 100010,
      executeFn: async () => ({ stdout: JSON.stringify({ ...context, ...change }) }) }), null);
  }
  for (const executeFn of [async () => { throw new Error('timeout'); }, async () => ({ stdout: 'bad' })]) {
    assert.equal(await readDesktopTitleContext(context, { executeFn }), null);
  }
  const controller = new AbortController(); controller.abort();
  assert.equal(await readDesktopTitleContext(context, { signal: controller.signal,
    executeFn: () => assert.fail('an aborted read must not start') }), null);
  const cancelled = new AbortController();
  assert.equal(await readDesktopTitleContext(context, { signal: cancelled.signal,
    executeFn: async () => { cancelled.abort(); return { stdout: JSON.stringify(context) }; } }), null);
});

test('return navigation requires a fresh input epoch and invokes only the exact window Back mode once', async () => {
  let calls = 0;
  const guarded = { ...context, lastInputTick: 1234 };
  assert.deepEqual(await restoreDesktopPage(guarded, { now: () => 100010,
    executeFn: async (file, args, options) => {
      calls++; assert.match(file, /Desktop-Context\.exe$/u);
      assert.deepEqual(args, ['--back', '--pid', '123', '--window', '456', '--started', context.started,
        '--input-tick', '1234', '--document', context.documentRuntimeId, '--title', context.title]);
      assert.equal(options.windowsHide, true); assert.equal(options.shell, false); assert.equal(options.timeout, 1500);
      return { stdout: JSON.stringify({ version: 1, status: 'dispatched', dispatched: true }) };
    } }), { status: 'dispatched', dispatched: true });
  assert.equal(calls, 1);
  for (const value of [context, { ...guarded, capturedAt: 69999 }, { ...guarded, capturedAt: 100011 }, { ...guarded, lastInputTick: null }]) {
    assert.deepEqual(await restoreDesktopPage(value, { now: () => 100010, executeFn: () => assert.fail('invalid context must not invoke') }),
      { status: 'invalid-context', dispatched: false });
  }
  const controller = new AbortController(); controller.abort();
  assert.deepEqual(await restoreDesktopPage(guarded, { signal: controller.signal,
    executeFn: () => assert.fail('aborted return must not invoke') }), { status: 'aborted', dispatched: false });
});

test('return navigation preserves known refusal reasons and never retries ambiguous outcomes', async () => {
  const guarded = { ...context, lastInputTick: 0xffffffff };
  for (const status of ['context-changed', 'back-unavailable', 'invalid-context', 'outcome-unknown']) {
    assert.deepEqual(await restoreDesktopPage(guarded, { now: () => 100010,
      executeFn: async () => ({ stdout: JSON.stringify({ version: 1, status, dispatched: false }) }) }), { status, dispatched: false });
  }
  for (const value of ['bad', JSON.stringify({ version: 2, status: 'dispatched', dispatched: true }),
    JSON.stringify({ version: 1, status: 'context-changed', dispatched: true }),
    JSON.stringify({ version: 1, status: 'dispatched', dispatched: true, extra: 'untrusted' }),
    JSON.stringify({ version: 1, status: 'private response', dispatched: false })]) {
    let calls = 0;
    assert.deepEqual(await restoreDesktopPage(guarded, { now: () => 100010,
      executeFn: async () => { calls++; return { stdout: value }; } }), { status: 'outcome-unknown', dispatched: false });
    assert.equal(calls, 1);
  }
  let calls = 0;
  assert.deepEqual(await restoreDesktopPage(guarded, { now: () => 100010,
    executeFn: async () => { calls++; throw new Error('timeout'); } }), { status: 'outcome-unknown', dispatched: false });
  assert.equal(calls, 1);
});
