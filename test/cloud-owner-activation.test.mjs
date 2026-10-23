import test from 'node:test';
import assert from 'node:assert/strict';
import { attachCloudWithPageRecovery } from '../cloud-owner-activation.mjs';

const threadId = '11111111-1111-4111-8111-111111111111';
const context = { version: 1, status: 'ready', pid: 123, window: 456, started: '639000000000000001',
  title: 'Cloud test', documentRuntimeId: '42,8,9', capturedAt: 100000, lastInputTick: 80000 };
const failure = code => Object.assign(new Error(code), { code });
function fixture() {
  const f = { calls: [], phases: [], attempts: 0, reads: 0, current: structuredClone(context),
    time: 100050, resource: { close() {} }, controller: new AbortController() };
  f.navigator = {
    readConversation: async target => { f.calls.push(['read', target]); return { thread: { id: threadId, kind: 'codex', hostId: 'durable', title: context.title } }; },
    navigateConversation: async target => { f.calls.push(['navigate', target]); return { navigated: true }; },
    close: async () => f.calls.push(['close']),
  };
  f.options = { plan: { threadId, context: structuredClone(context) }, signal: f.controller.signal,
    connect: async () => { f.calls.push(['connect']); if (++f.attempts === 1) throw failure('NO_OWNER'); return f.resource; },
    createNavigator: async targets => { f.calls.push(['create', ...targets]); return f.navigator; },
    onPhase: value => f.phases.push(value) };
  f.dependencies = { now: () => f.time, pause: async milliseconds => { f.time += milliseconds; },
    restorePage: async actual => { assert.deepEqual(actual, f.current); f.calls.push(['back']); return { dispatched: true }; },
    readContext: async () => { f.reads++; return structuredClone(f.current); } };
  return f;
}

const frontendId = '22222222-2222-4222-8222-222222222222';
const clientMessageId = '33333333-3333-4333-8333-333333333333';
const newerMessageId = '44444444-4444-4444-8444-444444444444';
function linkedFixture() {
  const f = fixture();
  f.options.plan.linkedEvidence = { frontendId, clientMessageId };
  f.options.plan.nativeTitle = null;
  f.frontend = { thread: { id: frontendId, kind: 'chatgpt', title: context.title },
    page: { order: 'newest_first' }, turns: [{ items: [{ type: 'userMessage', id: clientMessageId }] }] };
  f.native = { thread: { id: threadId, kind: 'codex', hostId: 'durable', title: null } };
  f.navigator.readConversation = async (target, args) => {
    f.calls.push(['read', target]);
    assert.ok(target === frontendId || target === threadId);
    assert.equal(args.turnLimit, 1); assert.equal(args.maxOutputCharsPerItem, 1);
    assert.equal(args.hostId, target === threadId ? 'durable' : undefined);
    return structuredClone(target === frontendId ? f.frontend : f.native);
  };
  f.navigator.navigateConversation = async target => {
    f.calls.push(['navigate', target]);
    f.current = { ...f.current, title: 'ChatGPT', documentRuntimeId: '42,8,10' };
    return { navigated: true };
  };
  return f;
}

test('a linked cold owner with no native title checks both identities then returns from the generic page', async () => {
  for (const nativePageTitle of ['ChatGPT', 'Codex']) {
    const f = linkedFixture(), navigate = f.navigator.navigateConversation;
    f.navigator.navigateConversation = async target => {
      const result = await navigate(target); f.current.title = nativePageTitle; return result;
    };
    assert.equal(await attachCloudWithPageRecovery(f.options, f.dependencies), f.resource);
    assert.deepEqual(f.calls, [['connect'], ['create', threadId], ['read', threadId], ['read', frontendId],
      ['navigate', threadId], ['connect'], ['back'], ['close']]);
    assert.deepEqual(f.phases, ['opening', 'connecting', 'returned']);
  }
});

test('a newer or invalid frontend message discovered during cold preparation prevents any navigation', async () => {
  for (const mutate of [
    read => { read.turns[0].items[0].id = newerMessageId; },
    read => { read.thread.id = newerMessageId; },
    read => { read.thread.title = 'Other chat'; },
    read => { read.page.order = 'oldest_first'; },
    read => { read.turns[0].items.push({ type: 'userMessage', id: newerMessageId }); },
  ]) {
    const f = linkedFixture(); mutate(f.frontend);
    await assert.rejects(attachCloudWithPageRecovery(f.options, f.dependencies), { code: 'CLOUD_IDENTITY_UNCONFIRMED' });
    assert.equal(f.attempts, 1);
    assert.equal(f.calls.some(call => call[0] === 'navigate' || call[0] === 'back'), false);
    assert.deepEqual(f.calls.at(-1), ['close']);
  }
});

test('linked recovery independently rejects changed native metadata before reading frontend or navigating', async () => {
  for (const change of [{ id: newerMessageId }, { kind: 'chatgpt' }, { hostId: 'local' }, { title: 'Renamed native' }]) {
    const f = linkedFixture(); Object.assign(f.native.thread, change);
    await assert.rejects(attachCloudWithPageRecovery(f.options, f.dependencies), { code: 'CLOUD_PAGE_CHANGED' });
    assert.deepEqual(f.calls, [['connect'], ['create', threadId], ['read', threadId], ['close']]);
  }
});

test('linked untitled native recovery preserves subsequent page and window changes', async () => {
  for (const change of [{ title: 'Another page' },
    { documentRuntimeId: '42,8,11' }, { window: 457 }, { pid: 124 }]) {
    const f = linkedFixture(), connect = f.options.connect;
    f.options.connect = async () => { const resource = await connect(); Object.assign(f.current, change); return resource; };
    assert.equal(await attachCloudWithPageRecovery(f.options, f.dependencies), f.resource);
    assert.deepEqual(f.calls.filter(call => call[0] === 'navigate'), [['navigate', threadId]]);
    assert.equal(f.calls.some(call => call[0] === 'back'), false);
    assert.equal(f.phases.at(-1), 'return-skipped');
    assert.deepEqual(f.calls.at(-1), ['close']);
  }
});

test('a linked untitled native page cannot use the original title or an unrelated page to authorize Back', async () => {
  for (const title of [context.title, 'Another page', '']) {
    const f = linkedFixture(), navigate = f.navigator.navigateConversation;
    f.navigator.navigateConversation = async target => {
      const result = await navigate(target); f.current.title = title; return result;
    };
    assert.equal(await attachCloudWithPageRecovery(f.options, f.dependencies), f.resource);
    assert.equal(f.calls.some(call => call[0] === 'back'), false);
    assert.equal(f.phases.at(-1), 'return-skipped');
  }
});

test('a verified untitled owner may finish loading its first-prompt title before guarded Back', async () => {
  const prompt = 'A long plain-text question about memory requirements and cloud execution capacity.';
  const generated = prompt.slice(0, 59).trimEnd() + '…';
  for (const mutate of [null, 'input', 'document', 'unrelated', 'wrong-thread', 'partial', 'rich']) {
    const f = linkedFixture(), connect = f.options.connect;
    f.resource.state = { id: threadId, hostId: 'durable', title: null, turnHistory: { kind: 'canonical', history: {
      entitiesByKey: { first: { turnId: 'first', itemsPagination: { hasLoadedOldest: true },
        items: [{ type: 'userMessage', content: [{ type: 'text', text: prompt }] }] } },
      islands: [{ olderBoundary: { status: 'exhausted' }, newerBoundary: { status: 'exhausted' }, entries: [{ value: 'first' }] }],
    } } };
    f.options.connect = async () => {
      const resource = await connect(); f.current.title = generated;
      if (mutate === 'input') f.current.lastInputTick++;
      if (mutate === 'document') f.current.documentRuntimeId = '42,8,11';
      if (mutate === 'unrelated') f.current.title = 'Other page';
      if (mutate === 'wrong-thread') resource.state.id = frontendId;
      if (mutate === 'partial') resource.state.turnHistory.history.islands[0].olderBoundary.status = 'loading';
      if (mutate === 'rich') resource.state.turnHistory.history.entitiesByKey.first.items[0].content[0].text = '**' + prompt;
      return resource;
    };
    assert.equal(await attachCloudWithPageRecovery(f.options, f.dependencies), f.resource);
    const shouldReturn = mutate == null || mutate === 'input';
    assert.equal(f.calls.some(call => call[0] === 'back'), shouldReturn);
    assert.equal(f.phases.at(-1), shouldReturn ? 'returned' : 'return-skipped');
  }
});

test('an existing owner connects immediately with no UI inspection or navigation', async () => {
  const f = fixture(); f.attempts = 1;
  assert.equal(await attachCloudWithPageRecovery(f.options, f.dependencies), f.resource);
  assert.deepEqual(f.calls, [['connect']]); assert.equal(f.reads, 0);
});

test('Desktop resolving an untitled native target to the unchanged Work page does not go Back', async () => {
  const f = linkedFixture();
  f.navigator.navigateConversation = async target => {
    f.calls.push(['navigate', target]); f.current.lastInputTick++; return { navigated: true };
  };
  assert.equal(await attachCloudWithPageRecovery(f.options, f.dependencies), f.resource);
  assert.equal(f.phases.at(-1), 'original-page-preserved');
  assert.equal(f.calls.some(call => call[0] === 'back'), false);
});

test('a cold owner opens once, connects, then returns once and releases the navigator', async () => {
  const f = fixture();
  assert.equal(await attachCloudWithPageRecovery(f.options, f.dependencies), f.resource);
  assert.deepEqual(f.calls, [['connect'], ['create', threadId], ['read', threadId],
    ['navigate', threadId], ['connect'], ['back'], ['close']]);
  assert.deepEqual(f.phases, ['opening', 'connecting', 'returned']);
});

test('input in other windows during each recovery stage allows connection and passes fresh input to Back', async t => {
  for (const makeFixture of [fixture, linkedFixture]) {
    for (const stage of ['before-recovery', 'preparation', 'navigation', 'connection', 'every-snapshot']) {
      await t.test(`${makeFixture.name}: ${stage}`, async () => {
        const f = makeFixture();
        if (stage === 'before-recovery') f.current.lastInputTick++;
        if (stage === 'preparation') {
          const create = f.options.createNavigator;
          f.options.createNavigator = async targets => { const result = await create(targets); f.current.lastInputTick++; return result; };
        }
        if (stage === 'navigation') {
          const navigate = f.navigator.navigateConversation;
          f.navigator.navigateConversation = async target => { const result = await navigate(target); f.current.lastInputTick++; return result; };
        }
        if (stage === 'connection') {
          const connect = f.options.connect;
          f.options.connect = async () => { const resource = await connect(); f.current.lastInputTick++; return resource; };
        }
        if (stage === 'every-snapshot') {
          const read = f.dependencies.readContext;
          f.dependencies.readContext = async () => { f.current.lastInputTick++; return read(); };
        }
        let returnedContext;
        const restore = f.dependencies.restorePage;
        f.dependencies.restorePage = async actual => { returnedContext = actual; return restore(actual); };
        assert.equal(await attachCloudWithPageRecovery(f.options, f.dependencies), f.resource);
        assert.equal(f.phases.at(-1), 'returned');
        assert.equal(f.calls.filter(call => call[0] === 'navigate').length, 1);
        assert.equal(f.calls.filter(call => call[0] === 'back').length, 1);
        assert.equal(returnedContext.lastInputTick, f.current.lastInputTick);
        assert.notEqual(returnedContext.lastInputTick, context.lastInputTick);
        assert.equal(f.options.plan.context.lastInputTick, context.lastInputTick);
      });
    }
  }
});

test('only an exact missing-owner failure with a fresh source plan permits recovery', async () => {
  for (const code of ['REMOTE_ERROR', 'INCOMPLETE_HISTORY', 'HISTORY_TIMEOUT', 'NO_OWNER']) {
    const f = fixture(); f.options.connect = async () => { throw failure(code); };
    if (code === 'NO_OWNER') f.options.plan = undefined;
    await assert.rejects(attachCloudWithPageRecovery(f.options, f.dependencies), { code });
    assert.deepEqual(f.calls, []);
  }
  for (const change of [{ lastInputTick: undefined }, { lastInputTick: null }, { capturedAt: 1 }, { capturedAt: 100051 }]) {
    const f = fixture(); Object.assign(f.options.plan.context, change);
    await assert.rejects(attachCloudWithPageRecovery(f.options, f.dependencies), { code: 'CLOUD_PAGE_CHANGED' });
    assert.deepEqual(f.calls, [['connect']]);
  }
});

test('changed source identity or page before dispatch prevents navigation', async () => {
  for (const change of [{ pid: 124 }, { window: 457 }, { started: '639000000000000002' },
    { title: 'Other chat' }, { documentRuntimeId: '42,8,10' }]) {
    const f = fixture(); Object.assign(f.current, change);
    await assert.rejects(attachCloudWithPageRecovery(f.options, f.dependencies), { code: 'CLOUD_PAGE_CHANGED' });
    assert.deepEqual(f.calls, [['connect']]);
  }
});

test('changes during navigator preparation are caught by the second source check', async () => {
  for (const change of [{ title: 'Other chat' }, { documentRuntimeId: '42,8,10' },
    { pid: 124 }, { window: 457 }, { started: '639000000000000002' }]) {
    const f = fixture(), read = f.navigator.readConversation;
    f.navigator.readConversation = async target => { const result = await read(target); Object.assign(f.current, change); return result; };
    await assert.rejects(attachCloudWithPageRecovery(f.options, f.dependencies), { code: 'CLOUD_PAGE_CHANGED' });
    assert.equal(f.calls.some(call => call[0] === 'navigate'), false);
    assert.deepEqual(f.calls.at(-1), ['close']);
  }
});

test('native target is independently read back before dispatch', async () => {
  for (const field of ['id', 'kind', 'hostId', 'title']) {
    const f = fixture(); f.navigator.readConversation = async () => ({ thread: { id: threadId, kind: 'codex', hostId: 'durable', title: context.title, [field]: 'other' } });
    await assert.rejects(attachCloudWithPageRecovery(f.options, f.dependencies), { code: 'CLOUD_PAGE_CHANGED' });
    assert.equal(f.calls.some(call => call[0] === 'navigate'), false);
  }
});

test('a changed current page or window suppresses return without losing the attachment', async () => {
  for (const change of [{ title: 'Other chat' }, { documentRuntimeId: '42,8,10' },
    { window: 457 }, { pid: 124 }, { started: '639000000000000002' }]) {
    const f = fixture(), connect = f.options.connect;
    f.options.connect = async () => { const resource = await connect(); Object.assign(f.current, change); return resource; };
    assert.equal(await attachCloudWithPageRecovery(f.options, f.dependencies), f.resource);
    assert.deepEqual(f.calls.filter(call => call[0] === 'navigate'), [['navigate', threadId]]);
    assert.equal(f.phases.at(-1), 'return-skipped');
  }
});

test('an unavailable snapshot never authorizes returning', async () => {
  const f = fixture();
  f.navigator.navigateConversation = async target => {
    f.calls.push(['navigate', target]); f.current = null; return { navigated: true };
  };
  assert.equal(await attachCloudWithPageRecovery(f.options, f.dependencies), f.resource);
  assert.equal(f.calls.filter(call => call[0] === 'navigate').length, 1);
  assert.equal(f.phases.at(-1), 'return-skipped');
});

test('input arriving during the native Back guard skips return without retrying or losing the attachment', async () => {
  const f = linkedFixture();
  let closed = false;
  f.resource.close = () => { closed = true; };
  f.dependencies.restorePage = async actual => {
    assert.deepEqual(actual, f.current);
    f.calls.push(['back']); f.current.lastInputTick++;
    return { dispatched: false, status: 'context-changed' };
  };
  assert.equal(await attachCloudWithPageRecovery(f.options, f.dependencies), f.resource);
  assert.equal(f.calls.filter(call => call[0] === 'back').length, 1);
  assert.equal(f.phases.at(-1), 'return-skipped');
  assert.equal(closed, false);
});

test('uncertain forward navigation is not retried and cannot trigger a return', async () => {
  const f = fixture(); f.navigator.navigateConversation = async target => { f.calls.push(['navigate', target]); throw failure('NAVIGATION_OUTCOME_UNKNOWN'); };
  await assert.rejects(attachCloudWithPageRecovery(f.options, f.dependencies), { code: 'NAVIGATION_OUTCOME_UNKNOWN' });
  assert.equal(f.calls.filter(call => call[0] === 'navigate').length, 1);
  assert.equal(f.attempts, 1); assert.deepEqual(f.calls.at(-1), ['close']);
});

test('unknown return result preserves the usable terminal and is never retried', async () => {
  const f = fixture();
  f.dependencies.restorePage = async () => { f.calls.push(['back']); throw failure('NAVIGATION_OUTCOME_UNKNOWN'); };
  assert.equal(await attachCloudWithPageRecovery(f.options, f.dependencies), f.resource);
  assert.equal(f.calls.filter(call => call[0] === 'navigate').length, 1);
  assert.equal(f.calls.filter(call => call[0] === 'back').length, 1);
  assert.equal(f.phases.at(-1), 'return-unconfirmed');
});

test('discovery retries are bounded and failures still return to an untouched original page', async () => {
  const f = fixture(); f.options.connect = async () => { f.attempts++; throw failure('NO_OWNER'); };
  await assert.rejects(attachCloudWithPageRecovery(f.options, f.dependencies), { code: 'NO_OWNER' });
  assert.equal(f.attempts, 5);
  assert.deepEqual(f.calls.filter(call => call[0] === 'navigate' || call[0] === 'back'), [['navigate', threadId], ['back']]);
});

test('non-discovery failures are not retried and retain their original error after returning', async () => {
  const f = fixture(), connect = f.options.connect;
  f.options.connect = async () => { await connect(); throw failure('INCOMPLETE_CLOUD_METADATA'); };
  await assert.rejects(attachCloudWithPageRecovery(f.options, f.dependencies), { code: 'INCOMPLETE_CLOUD_METADATA' });
  assert.equal(f.attempts, 2); assert.equal(f.phases.at(-1), 'returned');
});

test('cancellation after dispatch cancels further connect/return but releases the navigator', async () => {
  const f = fixture(), navigate = f.navigator.navigateConversation;
  f.navigator.navigateConversation = async target => { const result = await navigate(target); f.controller.abort(); return result; };
  await assert.rejects(attachCloudWithPageRecovery(f.options, f.dependencies), { code: 'ABORTED' });
  assert.equal(f.attempts, 1); assert.deepEqual(f.calls.at(-1), ['close']);
  assert.equal(f.calls.filter(call => call[0] === 'navigate').length, 1);
});

test('late navigator adoption after cancellation is cleaned up without navigation', async () => {
  const f = fixture(); f.options.createNavigator = async () => { f.controller.abort(); return f.navigator; };
  await assert.rejects(attachCloudWithPageRecovery(f.options, f.dependencies), { code: 'ABORTED' });
  assert.deepEqual(f.calls, [['connect'], ['close']]);
});

test('cancellation during real delayed navigation settling reports ABORTED', async () => {
  const f = fixture(), navigate = f.navigator.navigateConversation;
  f.dependencies.pause = undefined;
  f.navigator.navigateConversation = async target => {
    const result = await navigate(target); setTimeout(() => f.controller.abort(), 5); return result;
  };
  await assert.rejects(attachCloudWithPageRecovery(f.options, f.dependencies), { code: 'ABORTED' });
  assert.equal(f.attempts, 1); assert.deepEqual(f.calls.at(-1), ['close']);
});

test('cancellation after connecting closes the not-yet-delivered attachment', async () => {
  const f = fixture(); let closed = 0; f.resource.close = async () => { closed++; };
  f.dependencies.restorePage = async () => { f.controller.abort(); return { dispatched: false }; };
  await assert.rejects(attachCloudWithPageRecovery(f.options, f.dependencies), { code: 'ABORTED' });
  assert.equal(closed, 1); assert.deepEqual(f.calls.at(-1), ['close']);
});
