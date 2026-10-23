import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { CloudAppToolsClient } from '../cloud-app-tools.mjs';

// A synthetic official app-server transport, never a Desktop pipe or cloud call.
const pipe = '\\\\.\\pipe\\codex-app-tools-11111111-1111-4111-8111-111111111111';
const target = '22222222-2222-4222-8222-222222222222';
const helper = '33333333-3333-4333-8333-333333333333';
const snapshot = () => ({
  thread: { id: target, title: '云聊', status: { type: 'idle' } },
  turns: [{ id: 'real-turn', items: [{ id: 'real-message', type: 'agentMessage', text: '读取 🌤️' }] }],
  nextCursor: 'opaque/history/cursor', hasMore: true, unknownFutureField: { retained: true },
});
const listing = () => ({ schemaVersion: 4, pinnedThreads: [], threads: [
  { id: target, kind: 'codex', hostId: 'durable', title: '真实云会话', status: 'idle' },
  { id: 'frontend-id', kind: 'chatgpt', hostId: null, title: '前端会话' },
], unavailableHosts: [{ hostId: 'offline-host', reason: 'thread_list_unavailable' }] });
const mcp = body => ({ content: [{ type: 'text', text: JSON.stringify(body) }], isError: false });
const code = expected => value => value.code === expected;
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function fixture(t, settings = {}) {
  const requests = [], spawns = [], replies = [];
  const child = new EventEmitter();
  child.exitCode = null;
  child.kills = 0;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { child.kills++; child.exitCode = 0; child.emit('exit', 0); return true; };
  let input = '';
  const reply = (request, result, extra = {}) => {
    const response = { id: request.id, result, ...extra };
    replies.push(response);
    child.stdout.write(`${JSON.stringify(response)}\n`);
  };
  const normal = request => {
    if (request.method === 'initialize') reply(request, {});
    else if (request.method === 'thread/start') reply(request, { thread: { id: helper } });
    else if (request.method === 'thread/name/set') reply(request, {});
    else if (request.method === 'thread/archive') reply(request, {});
    else if (request.method === 'mcpServer/tool/call') {
      reply(request, request.params.tool === 'read_thread' ? mcp(snapshot()) :
        request.params.tool === 'list_threads' ? mcp(listing()) :
        request.params.tool === 'navigate_to_codex_page' ? mcp({ navigated: true }) : mcp({ threadId: target }));
    }
  };
  child.stdin = new Writable({
    write(chunk, _encoding, done) {
      input += chunk.toString('utf8');
      let end;
      while ((end = input.indexOf('\n')) >= 0) {
        const request = JSON.parse(input.slice(0, end));
        input = input.slice(end + 1);
        requests.push(request);
        queueMicrotask(() => settings.onRequest?.(request, { child, reply, normal, requests }) ?? normal(request));
      }
      done();
    },
  });
  child.stdin.on('finish', () => {
    if (!settings.hangOnEnd && child.exitCode === null) {
      child.exitCode = 0; child.emit('exit', 0);
    }
  });
  const allow = settings.allowSendTargets ?? [];
  const client = new CloudAppToolsClient({
    backendPath: 'C:\\official\\codex.exe', nodePath: 'C:\\official\\node.exe',
    pluginPath: 'C:\\official\\codex-app-tools\\server.mjs', cwd: 'C:\\workspace',
    rpcTimeoutMs: 100, cleanupTimeoutMs: 70, endpointTimeoutMs: 60,
    resolvePipeEndpoint: async () => pipe, allowSendTargets: allow, sendCapability: settings.sendCapability,
    env: { PATH: 'fixture' }, disabledPlugins: ['other@market'], disabledMcpServers: ['other'],
    ...settings.clientOptions,
    spawnImpl: (...args) => { spawns.push(args); return child; },
  });
  t.after(() => client.close());
  return { client, child, requests, spawns, replies, allow };
}

test('reads via its own real helper and preserves official history without inventing runtime settings', async t => {
  const f = fixture(t);
  const value = await f.client.readConversation(target, { cursor: 'older', includeOutputs: true, turnLimit: 2 });
  assert.deepEqual(value, snapshot());
  assert.equal('approvalPolicy' in value, false);
  assert.equal('model' in value, false);
  const calls = f.requests.filter(request => request.method === 'mcpServer/tool/call');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, {
    threadId: helper, server: 'cst_cloud', tool: 'read_thread',
    arguments: { threadId: target, cursor: 'older', turnLimit: 2, includeOutputs: true, maxOutputCharsPerItem: 8_000 },
  });
  assert.equal(f.requests.some(request => request.method === 'turn/start'), false);
  assert.equal('_meta' in calls[0].params, false);
  const publish = f.requests.findIndex(request => request.method === 'thread/name/set');
  assert.ok(publish > 0 && publish < f.requests.indexOf(calls[0]));
  assert.deepEqual(f.requests[publish].params, { threadId: helper, name: 'Codex Session to Terminal 云端连接辅助' });
  const [binary, args, options] = f.spawns[0];
  assert.equal(binary, 'C:\\official\\codex.exe');
  assert.equal(args.at(-1), 'app-server');
  assert.equal(options.windowsHide, true);
  assert.equal(options.env.CODEX_APP_TOOLS_PIPE_PATH, pipe);
  assert.ok(args.includes('mcp_servers.cst_cloud.enabled_tools=["read_thread","list_threads"]'));
  assert.ok(args.includes('plugins."other@market".enabled=false'));
  // Real installed CLI rejects quoted MCP names as transport entries.
  assert.ok(args.includes('mcp_servers.other.enabled=false'));
  assert.ok(!args.some(value => value.startsWith('mcp_servers."')));
  assert.deepEqual(await f.client.close(), { helperThreadId: helper, archived: true, helperMayExist: false });
  assert.deepEqual(f.requests.filter(request => request.method === 'thread/archive').map(request => request.params), [{ threadId: helper }]);
  assert.equal(f.child.exitCode, 0);
  assert.equal(f.child.kills, 0);
});

test('rejects unapproved targets, empty text and option injection before starting an executor', async t => {
  const f = fixture(t);
  await assert.rejects(f.client.sendText(target, 'hello'), code('SEND_NOT_AUTHORIZED'));
  await assert.rejects(f.client.readConversation(target, { threadId: 'another' }), code('INVALID_ARGUMENT'));
  await assert.rejects(f.client.readConversation(target, { turnLimit: 100_000 }), code('INVALID_ARGUMENT'));
  await assert.rejects(f.client.readConversation(target, { hostId: 'local' }), code('INVALID_ARGUMENT'));
  assert.equal(f.spawns.length, 0);
});

test('target authorization alone cannot enable experimental send-or-steer behavior', async t => {
  const f = fixture(t, { allowSendTargets: [target] });
  await assert.rejects(f.client.sendText(target, 'do not send'), code('SEND_DISABLED'));
  assert.equal(f.spawns.length, 0);
  await f.client.readConversation(target);
  assert.ok(f.spawns[0][1].includes('mcp_servers.cst_cloud.enabled_tools=["read_thread","list_threads"]'));
  assert.equal(f.requests.some(request => request.params?.tool === 'send_message_to_thread'), false);
});

test('lists real source identities and availability without selecting a current chat or enabling writes', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.client.listConversations(), listing());
  assert.deepEqual(await f.client.listConversations({ limit: 2 }), listing());
  assert.deepEqual(f.requests.filter(request => request.params?.tool === 'list_threads').map(request => request.params.arguments),
    [{ limit: 50 }, { limit: 2 }]);
  assert.equal(f.requests.some(request => request.params?.tool === 'send_message_to_thread'), false);
});

test('accepts official ChatGPT list rows without hostId while preserving native host validation', async t => {
  const body = listing();
  delete body.threads[1].hostId;
  body.pinnedThreads.push({ id: 'pinned-frontend', kind: 'chatgpt', title: '前端置顶' });
  const f = fixture(t, { onRequest(request, context) {
    if (request.params?.tool === 'list_threads') context.reply(request, mcp(body));
    else context.normal(request);
    return true;
  } });
  assert.deepEqual(await f.client.listConversations(), body);
  assert.equal('hostId' in body.threads[1], false);
  for (const thread of [
    { id: target, kind: 'codex' },
    { id: 'frontend', kind: 'chatgpt', hostId: 12 },
    { id: target, kind: 'codex', hostId: {} },
  ]) {
    body.threads = [thread];
    await assert.rejects(f.client.listConversations(), code('INVALID_TOOL_RESPONSE'));
  }
  assert.equal(f.requests.some(request => request.params?.tool === 'send_message_to_thread'), false);
});

test('rejects unbounded list options and malformed list responses', async t => {
  const f = fixture(t);
  for (const options of [{ limit: 0 }, { limit: 51 }, { limit: 1.5 }, { hostId: 'durable' }, { cursor: 'opaque' }, null]) {
    await assert.rejects(f.client.listConversations(options), code('INVALID_ARGUMENT'));
  }
  assert.equal(f.spawns.length, 0);
  const malformed = fixture(t, { onRequest(request, context) {
    if (request.params?.tool === 'list_threads') context.reply(request, mcp({ threads: [] }));
    else context.normal(request);
    return true;
  } });
  await assert.rejects(malformed.client.listConversations(), code('INVALID_TOOL_RESPONSE'));
});

test('durable reads bind both real native kind and host, without automatic host substitution', async t => {
  for (const thread of [
    { id: target, kind: 'codex', hostId: 'durable' },
    { id: target, kind: 'chatgpt', hostId: null },
    { id: target, kind: 'codex', hostId: 'local' },
  ]) {
    const f = fixture(t, { onRequest(request, context) {
      if (request.params?.tool === 'read_thread') context.reply(request, mcp({ ...snapshot(), thread }));
      else context.normal(request);
      return true;
    } });
    if (thread.hostId === 'durable') assert.deepEqual((await f.client.readConversation(target, { hostId: 'durable' })).thread, thread);
    else await assert.rejects(f.client.readConversation(target, { hostId: 'durable' }), code('INVALID_TOOL_RESPONSE'));
    assert.equal(f.requests.find(request => request.params?.tool === 'read_thread').params.arguments.hostId, 'durable');
  }
});

test('rejects MCP names that cannot be represented safely as supported CLI override keys', t => {
  assert.throws(() => fixture(t, { clientOptions: { disabledMcpServers: ['server.with.dots'] } }), code('INVALID_ARGUMENT'));
  assert.throws(() => fixture(t, { clientOptions: { disabledMcpServers: ['"quoted"'] } }), code('INVALID_ARGUMENT'));
});

test('navigation is absent by default and an explicit capability binds exactly one target without send access', async t => {
  const plain = fixture(t);
  await assert.rejects(plain.client.navigateConversation(target), code('NAVIGATION_NOT_AUTHORIZED'));
  assert.equal(plain.spawns.length, 0);
  for (const navigateTargets of [[], [target, helper], [target, target], 'all', ['bad']]) {
    assert.throws(() => fixture(t, { clientOptions: { navigateTargets } }), code('INVALID_ARGUMENT'));
  }
  assert.throws(() => fixture(t, { allowSendTargets: [target], clientOptions: { navigateTargets: [target] } }), code('INVALID_ARGUMENT'));
  const allowed = [target], f = fixture(t, { clientOptions: { navigateTargets: allowed } });
  allowed[0] = helper;
  await assert.rejects(f.client.navigateConversation(helper), code('NAVIGATION_NOT_AUTHORIZED'));
  assert.deepEqual(await f.client.navigateConversation(target), { navigated: true });
  const call = f.requests.find(request => request.params?.tool === 'navigate_to_codex_page');
  assert.deepEqual(call.params.arguments, { threadId: target });
  assert.equal(call.params.threadId, helper);
  assert.ok(f.spawns[0][1].includes('mcp_servers.cst_cloud.enabled_tools=["read_thread","list_threads","navigate_to_codex_page"]'));
  await assert.rejects(f.client.sendText(target, 'never send'), code('SEND_NOT_AUTHORIZED'));
  assert.equal(f.requests.some(request => request.params?.tool === 'send_message_to_thread'), false);
});

test('navigation timeout, malformed receipt and tool rejection lock the capability without replay', async t => {
  for (const response of [undefined, mcp({ navigated: false }), { ...mcp({ navigated: true }), isError: true }]) {
    const f = fixture(t, { clientOptions: { navigateTargets: [target], rpcTimeoutMs: 20 }, onRequest(request, context) {
      if (request.params?.tool === 'navigate_to_codex_page') {
        if (response) context.reply(request, response);
      } else context.normal(request);
      return true;
    } });
    await assert.rejects(f.client.navigateConversation(target), code('NAVIGATION_OUTCOME_UNKNOWN'));
    await assert.rejects(f.client.navigateConversation(target), code('NAVIGATION_OUTCOME_UNKNOWN'));
    assert.equal(f.requests.filter(request => request.params?.tool === 'navigate_to_codex_page').length, 1);
    assert.deepEqual(await f.client.readConversation(target), snapshot());
  }
});

test('concurrent navigation cannot issue another call or helper', async t => {
  let release, arrived;
  const seen = new Promise(resolve => { arrived = resolve; });
  const f = fixture(t, { clientOptions: { navigateTargets: [target] }, onRequest(request, context) {
    if (request.params?.tool === 'navigate_to_codex_page') { release = () => context.normal(request); arrived(); }
    else context.normal(request);
    return true;
  } });
  const first = f.client.navigateConversation(target);
  await seen;
  await assert.rejects(f.client.navigateConversation(target), code('NAVIGATION_IN_PROGRESS'));
  release(); await first;
  assert.equal(f.requests.filter(request => request.method === 'thread/start').length, 1);
  assert.equal(f.requests.filter(request => request.params?.tool === 'navigate_to_codex_page').length, 1);
});

test('closing before navigation dispatch prevents startup; closing in-flight blocks replay despite a late receipt', async t => {
  const unopened = fixture(t, { clientOptions: { navigateTargets: [target] } });
  await unopened.client.close();
  await assert.rejects(unopened.client.navigateConversation(target), code('CLIENT_CLOSED'));
  assert.equal(unopened.spawns.length, 0);
  let release, arrived;
  const seen = new Promise(resolve => { arrived = resolve; });
  const f = fixture(t, { clientOptions: { navigateTargets: [target] }, onRequest(request, context) {
    if (request.params?.tool === 'navigate_to_codex_page') { release = () => context.normal(request); arrived(); }
    else context.normal(request);
    return true;
  } });
  const pending = assert.rejects(f.client.navigateConversation(target), code('NAVIGATION_OUTCOME_UNKNOWN'));
  await seen;
  await f.client.close(); await pending;
  release();
  await assert.rejects(f.client.navigateConversation(target), code('NAVIGATION_OUTCOME_UNKNOWN'));
  assert.equal(f.requests.filter(request => request.params?.tool === 'navigate_to_codex_page').length, 1);
});

test('authorization is a target snapshot and a successful send returns only the official result', async t => {
  const authorized = [target];
  const f = fixture(t, { allowSendTargets: authorized, sendCapability: 'send-or-steer' });
  authorized.push('later-unapproved-target');
  await assert.rejects(f.client.sendText('later-unapproved-target', 'hello'), code('SEND_NOT_AUTHORIZED'));
  await assert.rejects(f.client.sendText(target, ' '), code('INVALID_ARGUMENT'));
  assert.deepEqual(await f.client.sendText(target, 'literal prompt'), { threadId: target });
  const sends = f.requests.filter(request => request.params?.tool === 'send_message_to_thread');
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0].params.arguments, { threadId: target, prompt: 'literal prompt' });
});

test('a timed-out send is never repeated, even after a late success; reads remain usable', async t => {
  let send;
  const f = fixture(t, {
    allowSendTargets: [target], sendCapability: 'send-or-steer', clientOptions: { rpcTimeoutMs: 20 },
    onRequest(request, context) {
      if (request.params?.tool === 'send_message_to_thread') { send = request; return true; }
      context.normal(request); return true;
    },
  });
  await assert.rejects(f.client.sendText(target, 'one message'), value => value.code === 'SEND_OUTCOME_UNKNOWN' && value.outcome === 'unknown');
  f.child.stdout.write(`${JSON.stringify({ id: send.id, result: mcp({ threadId: target }) })}\n`);
  await assert.rejects(f.client.sendText(target, 'one message'), code('SEND_OUTCOME_UNKNOWN'));
  assert.deepEqual(await f.client.readConversation(target), snapshot());
  assert.equal(f.requests.filter(request => request.params?.tool === 'send_message_to_thread').length, 1);
});

test('a concurrent send is rejected and does not create a second helper or duplicate prompt', async t => {
  let release, arrived;
  const seen = new Promise(resolve => { arrived = resolve; });
  const f = fixture(t, { allowSendTargets: [target], sendCapability: 'send-or-steer', onRequest(request, context) {
    if (request.params?.tool === 'send_message_to_thread') {
      release = () => context.normal(request); arrived(); return true;
    }
    context.normal(request); return true;
  } });
  const first = f.client.sendText(target, 'one');
  await seen;
  await assert.rejects(f.client.sendText(target, 'two'), code('SEND_IN_PROGRESS'));
  release();
  await first;
  assert.equal(f.requests.filter(request => request.method === 'thread/start').length, 1);
});

test('completed summary groups do not permit sending when the chat is active or its state is unknown', async t => {
  for (const status of [{ type: 'active', activeFlags: [] }, { type: 'notLoaded' }, {}, undefined, 'idle']) {
    const f = fixture(t, { allowSendTargets: [target], sendCapability: 'send-or-steer', onRequest(request, context) {
      if (request.params?.tool === 'read_thread') {
        const body = snapshot();
        body.thread.status = status;
        body.turns[0].status = 'completed';
        context.reply(request, mcp(body));
      } else context.normal(request);
      return true;
    } });
    await assert.rejects(f.client.sendText(target, 'do not steer'), value =>
      ['CONVERSATION_BUSY', 'CONVERSATION_STATE_UNKNOWN'].includes(value.code));
    assert.equal(f.requests.some(request => request.params?.tool === 'send_message_to_thread'), false);
    assert.equal((await f.client.close()).archived, true);
  }
});

test('interactive executor requests receive explicit refusal and are never approved', async t => {
  const f = fixture(t, { onRequest(request, context) {
    if (request.params?.tool === 'read_thread') {
      context.child.stdout.write(`${JSON.stringify({ id: 'approval', method: 'item/commandExecution/requestApproval', params: {} })}\n`);
    }
    context.normal(request); return true;
  } });
  await f.client.readConversation(target);
  await pause(0);
  const refusal = f.requests.find(request => request.id === 'approval');
  assert.equal(refusal.error.code, -32601);
  assert.equal('result' in refusal, false);
});

test('rejects mismatched, ambiguous and tool-error history rather than projecting another chat', async t => {
  for (const response of [
    mcp({ ...snapshot(), thread: { id: 'wrong' } }),
    { content: [...mcp(snapshot()).content, ...mcp(snapshot()).content] },
    { ...mcp(snapshot()), isError: true },
  ]) {
    const f = fixture(t, { onRequest(request, context) {
      if (request.params?.tool === 'read_thread') context.reply(request, response);
      else context.normal(request);
      return true;
    } });
    await assert.rejects(f.client.readConversation(target), value => ['INVALID_TOOL_RESPONSE', 'APP_TOOL_REJECTED'].includes(value.code));
    assert.equal((await f.client.close()).archived, true);
  }
});

test('handles UTF-8 split across transport chunks and structured MCP output', async t => {
  const f = fixture(t, { onRequest(request, context) {
    if (request.params?.tool !== 'read_thread') { context.normal(request); return true; }
    const wire = Buffer.from(`${JSON.stringify({ id: request.id, result: { structuredContent: snapshot(), isError: false } })}\n`);
    const split = wire.indexOf(Buffer.from('🌤️')) + 1;
    context.child.stdout.write(wire.subarray(0, split));
    context.child.stdout.write(wire.subarray(split));
    return true;
  } });
  assert.deepEqual(await f.client.readConversation(target), snapshot());
});

test('endpoint discovery has a deadline and invalid endpoints never launch helpers', async t => {
  const waiting = fixture(t, { clientOptions: { resolvePipeEndpoint: () => new Promise(() => {}), endpointTimeoutMs: 10 } });
  await assert.rejects(waiting.client.readConversation(target), code('ENDPOINT_TIMEOUT'));
  assert.equal(waiting.spawns.length, 0);
  const invalid = fixture(t, { clientOptions: { resolvePipeEndpoint: async () => '\\\\.\\pipe\\unrelated' } });
  await assert.rejects(invalid.client.readConversation(target), code('INVALID_ENDPOINT'));
  assert.equal(invalid.spawns.length, 0);
});

test('cleanup is bounded, idempotent, and reports an unarchived helper honestly', async t => {
  const f = fixture(t, { clientOptions: { cleanupTimeoutMs: 15 }, onRequest(request, context) {
    if (request.method === 'thread/archive') return true;
    context.normal(request); return true;
  } });
  await f.client.readConversation(target);
  const closing = f.client.close();
  assert.equal(closing, f.client.close());
  assert.deepEqual(await closing, { helperThreadId: helper, archived: false, helperMayExist: true });
  assert.equal(f.child.exitCode, 0);
  await assert.rejects(f.client.readConversation(target), code('CLIENT_CLOSED'));
  assert.equal(f.requests.filter(request => request.method === 'thread/archive').length, 1);
});

test('gives the executor an EOF grace period and kills only when graceful shutdown times out', async t => {
  const f = fixture(t, { hangOnEnd: true, clientOptions: { shutdownTimeoutMs: 15 } });
  await f.client.readConversation(target);
  const closing = f.client.close();
  await pause(0);
  assert.equal(f.child.stdin.writableEnded, true);
  assert.equal(f.child.kills, 0);
  assert.equal((await closing).archived, true);
  assert.equal(f.child.kills, 1);
});

test('archives a helper whose creation response arrives after the startup deadline', async t => {
  const f = fixture(t, { clientOptions: { rpcTimeoutMs: 10, cleanupTimeoutMs: 70 }, onRequest(request, context) {
    if (request.method === 'thread/start') { setTimeout(() => context.normal(request), 25); return true; }
    context.normal(request); return true;
  } });
  await assert.rejects(f.client.readConversation(target), code('RPC_TIMEOUT'));
  assert.deepEqual(await f.client.close(), { helperThreadId: helper, archived: true, helperMayExist: false });
  assert.equal(f.requests.some(request => request.method === 'mcpServer/tool/call'), false);
});

test('does not dispatch an app tool if helper metadata publication fails, and still archives its own helper', async t => {
  const f = fixture(t, { onRequest(request, context) {
    if (request.method === 'thread/name/set') context.reply(request, undefined, { error: { code: -32000, message: 'Fixture publication failure' } });
    else context.normal(request);
    return true;
  } });
  await assert.rejects(f.client.readConversation(target), value => value.code === 'RPC_REJECTED' && value.method === 'thread/name/set');
  assert.equal(f.requests.some(request => request.method === 'mcpServer/tool/call'), false);
  assert.deepEqual(await f.client.close(), { helperThreadId: helper, archived: true, helperMayExist: false });
});

test('process loss and oversized frames reject pending work without restarting or retrying', async t => {
  for (const mode of ['exit', 'large']) {
    const f = fixture(t, { clientOptions: { maxFrameBytes: 512 }, onRequest(request, context) {
      if (request.params?.tool === 'read_thread') {
        if (mode === 'exit') context.child.kill();
        else context.child.stdout.write('x'.repeat(513));
      } else context.normal(request);
      return true;
    } });
    await assert.rejects(f.client.readConversation(target), code(mode === 'exit' ? 'HELPER_EXITED' : 'RESPONSE_TOO_LARGE'));
    const closed = await f.client.close();
    assert.equal(closed.archived, false);
    assert.equal(closed.helperMayExist, true);
    assert.equal(f.spawns.length, 1);
    assert.equal(f.requests.filter(request => request.params?.tool === 'read_thread').length, 1);
  }
});

test('startup exit reports only safe exit details and the pending method', async t => {
  const f = fixture(t, { onRequest(request, context) {
    if (request.method === 'initialize') {
      context.child.stderr.write('SENSITIVE_RUNTIME_DIAGNOSTIC');
      context.child.exitCode = 1;
      context.child.emit('exit', 1, null);
      return true;
    }
    context.normal(request); return true;
  } });
  await assert.rejects(f.client.readConversation(target), value => {
    assert.equal(value.code, 'HELPER_EXITED');
    assert.equal(value.exitCode, 1);
    assert.equal(value.signal, null);
    assert.equal(value.method, 'initialize');
    assert.equal(JSON.stringify(value).includes('SENSITIVE_RUNTIME_DIAGNOSTIC'), false);
    return true;
  });
  assert.equal((await f.client.close()).helperMayExist, false);
});
