import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { win32 } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { createCloudWindowsCliProxy, createCloudWindowsPathProjection } from '../cloud-windows-cli-proxy.mjs';
import { createCloudNativeMetadataReader } from '../cloud-native-cli-bridge.mjs';
import { resumeFromLiveSnapshot } from '../native-cli-bridge.mjs';

const threadId = '11111111-1111-4111-8111-111111111111';
const otherThreadId = '22222222-2222-4222-8222-222222222222';
const remoteCwd = '/workspace/scratch/example';
const namespace = '\\\\?\\CST-CLOUD-33333333-3333-4333-8333-333333333333';
const projection = () => createCloudWindowsPathProjection({ threadId, remoteCwd, namespace });
function stateFixture(cwd = remoteCwd) {
  const turn = { turnId: 'native-turn', status: 'inProgress', turnStartedAtMs: 1792490894000,
    items: [{ id: 'native-user', type: 'userMessage', clientId: 'frontend-user', content: [{ type: 'text', text: `Read ${cwd}` }] },
      { id: 'native-assistant', type: 'agentMessage', text: `Still in ${cwd}`, phase: 'commentary' }],
    itemsPagination: { hasLoadedOldest: true } };
  return { id: threadId, sessionId: threadId, hostId: 'durable', title: 'Cloud fixture',
    createdAt: 1792490891000, updatedAt: 1792548246000, source: { custom: 'codex-cloud-agent' }, threadSource: 'user',
    originator: 'codex_work_web', historyMode: 'legacy', modelProvider: 'local', latestModel: 'gpt-6.1-sol-wm',
    cwd, threadRuntimeStatus: { type: 'active', activeFlags: [] },
    latestThreadSettings: { model: 'gpt-6.1-sol-wm', cwd, effort: 'medium', disabledPluginIds: [],
      multiAgentMode: { custom: '' }, collaborationMode: { mode: 'default', settings: {
        model: 'gpt-6.1-sol-wm', reasoning_effort: 'medium', developer_instructions: null,
      } }, approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'dangerFullAccess' } },
    currentPermissions: { runtimeWorkspaceRoots: [cwd] }, turns: [],
    turnHistory: { kind: 'canonical', history: { entitiesByKey: { turn }, islands: [{ entries: [{ value: 'turn' }],
      olderBoundary: { status: 'exhausted' }, newerBoundary: { status: 'exhausted' } }] } } };
}
function metadata(state) {
  return createCloudNativeMetadataReader({ getState: () => state, threadId, persistedThread: true, bridgeHome: tmpdir() });
}
async function resumeFixture(state = stateFixture()) {
  const reader = metadata(state);
  return resumeFromLiveSnapshot(await reader.call('thread/read', { threadId, includeTurns: true }), state);
}
let sequence = 0;
function rpc(socket, method, params = {}, id = ++sequence) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('message', receive); reject(new Error('Fixture RPC timeout.')); }, 3000);
    const receive = bytes => { const response = JSON.parse(bytes); if (response.id === id) { clearTimeout(timer); socket.off('message', receive); resolve(response); } };
    socket.on('message', receive); socket.send(JSON.stringify({ id, method, params }));
  });
}
const factories = { platform: 'win32', verifyUnusedNamespace: async name => {
  assert.match(name, /^CST-CLOUD-[0-9a-f-]{36}$/); return true;
} };
async function setup(t, options = {}, state = stateFixture()) {
  const reader = metadata(state), requests = [], sockets = new Set();
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  t.after(async () => { for (const socket of sockets) socket.terminate(); await new Promise(resolve => server.close(resolve)); });
  const bridge = { endpoint: `ws://127.0.0.1:${server.address().port}`, token: 'a'.repeat(64),
    state, status: { ready: true }, manifest: { readonly: true }, close() { assert.fail('The caller owns this bridge.'); } };
  const f = { state, reader, bridge, requests, sockets, respond: null };
  server.on('connection', (socket, request) => {
    assert.equal(request.headers.authorization, `Bearer ${bridge.token}`);
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    socket.on('message', async bytes => {
      const request = JSON.parse(bytes); requests.push(request);
      if (f.respond && await f.respond(request, socket)) return;
      let result;
      if (request.method === 'initialize') result = await reader.initialize();
      else if (request.method === 'thread/resume') {
        result = resumeFromLiveSnapshot(await reader.call('thread/read', { threadId, includeTurns: !request.params.excludeTurns }), state);
      } else if (request.method === 'thread/loaded/list') result = { data: [threadId], nextCursor: null };
      else if (request.method === 'thread/unsubscribe') result = { status: 'unsubscribed' };
      else result = await reader.call(request.method, request.params);
      socket.send(JSON.stringify({ id: request.id, result }));
    });
  });
  f.proxy = await createCloudWindowsCliProxy({ bridge, ...options }, factories);
  t.after(() => f.proxy.close());
  f.connect = async () => {
    const socket = new WebSocket(f.proxy.endpoint, { headers: { Authorization: `Bearer ${f.proxy.token}` } });
    t.after(() => socket.terminate()); socket.on('error', () => {}); await once(socket, 'open'); return socket;
  };
  f.socket = await f.connect();
  f.resume = async () => { await rpc(f.socket, 'initialize'); return rpc(f.socket, 'thread/resume', { threadId }); };
  return f;
}

test('one exact cwd is reversible, and only typed protocol paths change', async () => {
  const p = projection(), source = await resumeFixture();
  const original = structuredClone(source);
  const command = { id: 'cmd', type: 'commandExecution', command: `ls ${remoteCwd}`, commandActions: [], cwd: remoteCwd, status: 'completed' };
  source.thread.turns[0].items.push(command);
  const result = p.projectResponse('thread/resume', source);
  assert.equal(p.decodePath(p.encodePath(remoteCwd)), remoteCwd);
  assert.equal(result.cwd, `${namespace}\\workspace\\scratch\\example`);
  assert.equal(result.thread.cwd, result.cwd); assert.deepEqual(result.runtimeWorkspaceRoots, [result.cwd]);
  assert.equal(result.thread.turns[0].items[0].content[0].text, `Read ${remoteCwd}`);
  assert.equal(result.thread.turns[0].items[1].text, `Still in ${remoteCwd}`);
  assert.deepEqual(result.thread.turns[0].items[2], command);
  for (const key of ['model', 'modelProvider', 'approvalPolicy', 'approvalsReviewer', 'sandbox']) assert.deepEqual(result[key], original[key]);
  assert.equal(source.cwd, remoteCwd); assert.equal(source.thread.id, result.thread.id);
  assert.throws(() => p.encodePath(`${remoteCwd}/child`));
  assert.throws(() => p.decodePath(`${p.encodedCwd}\\..`));
  assert.throws(() => p.decodePath(remoteCwd));
});

test('bounded POSIX spellings use exact wire aliases without Windows path normalization', () => {
  const spellings = ['/', '//server/share', '/workspace/', '/workspace//docs', '/workspace/./docs',
    '/workspace/../secret', '/workspace/a b', '/workspace/trailing. ', '/workspace/<>:"|?*\\',
    '/tmp/task/workspace/C:\\Users\\ExampleUser\\Documents\\Example Project',
    '/workspace/中文/é😀', '/workspace/中文/e\u0301😀', '/workspace/CON', '/workspace/nul', '/workspace/COM1',
    `/workspace/${'a'.repeat(256)}`, `/${'a'.repeat(4095)}`, `/${'中'.repeat(1365)}`];
  const encoded = new Set();
  for (const cwd of spellings) {
    const p = createCloudWindowsPathProjection({ threadId, remoteCwd: cwd, namespace });
    assert.match(p.encodedCwd.slice(namespace.length), /^\\cwd~[0-9a-f]{64}$/);
    assert.equal(win32.normalize(p.encodedCwd), p.encodedCwd);
    assert.equal(p.decodePath(p.encodedCwd), cwd);
    assert.equal(p.encodePath(cwd), p.encodedCwd);
    assert.equal(p.remoteCwd, cwd);
    assert.equal(p.namespace, namespace);
    assert.throws(() => p.decodePath(p.encodedCwd.toUpperCase()));
    assert.throws(() => p.decodePath(`${p.encodedCwd}\\..`));
    assert.throws(() => p.decodePath(`${namespace}\\..\\C:\\Users`));
    assert.throws(() => p.decodePath('C:\\Users\\ExampleUser'));
    encoded.add(p.encodedCwd);
  }
  assert.equal(encoded.size, spellings.length);
  // Existing simple spellings remain compatible, but comparison never folds
  // case or accepts a Windows-normalized variant in either direction.
  for (const cwd of ['/workspace/Case', '/workspace/case', '/a_b/C-2']) {
    const p = createCloudWindowsPathProjection({ threadId, remoteCwd: cwd, namespace });
    assert.equal(p.encodedCwd, `${namespace}\\${cwd.slice(1).replaceAll('/', '\\')}`);
    assert.equal(p.decodePath(p.encodedCwd), cwd);
    assert.throws(() => p.encodePath(cwd.toUpperCase()));
    assert.throws(() => p.decodePath(p.encodedCwd.toUpperCase()));
  }
  const variants = ['/workspace/Case', '/workspace/case', '/workspace//Case', '/workspace/./Case', '/workspace/Case/'];
  assert.equal(new Set(variants.map(cwd => createCloudWindowsPathProjection({ threadId, remoteCwd: cwd, namespace }).encodedCwd)).size, variants.length);
});

test('mixed Windows-looking cloud cwd changes only explicit schema paths and not the snapshot', async () => {
  const cwd = '/tmp/job/workspace/C:\\Users\\ExampleUser\\Documents\\Example Project';
  const state = stateFixture(cwd), beforeState = structuredClone(state);
  const source = await resumeFixture(state);
  const command = { id: 'cmd-mixed', type: 'commandExecution', command: `cd '${cwd}'`, commandActions: [], cwd, status: 'completed' };
  source.thread.turns[0].items.push(command);
  const beforeResponse = structuredClone(source);
  const p = createCloudWindowsPathProjection({ threadId, remoteCwd: cwd, namespace });
  const result = p.projectResponse('thread/resume', source);
  assert.equal(result.cwd, p.encodedCwd);
  assert.equal(result.thread.cwd, p.encodedCwd);
  assert.deepEqual(result.runtimeWorkspaceRoots, [p.encodedCwd]);
  assert.equal(result.thread.turns[0].items[0].content[0].text, `Read ${cwd}`);
  assert.equal(result.thread.turns[0].items[1].text, `Still in ${cwd}`);
  assert.deepEqual(result.thread.turns[0].items[2], command);
  const event = { method: 'thread/settings/updated', params: { threadId, threadSettings: { ...state.latestThreadSettings, modelProvider: 'local' } } };
  assert.equal(p.projectNotification(event).params.threadSettings.cwd, p.encodedCwd);
  assert.equal(event.params.threadSettings.cwd, cwd);
  assert.deepEqual(source, beforeResponse);
  assert.deepEqual(state, beforeState);
});

test('nonabsolute, control, malformed Unicode, oversized paths and unbound roots fail closed', async () => {
  for (const cwd of ['', 'workspace/relative', 'C:\\local', '\\\\server\\share', '/x\0y', '/x\ny', '/x\ry', '/x\ty',
    '/x\u007fy', '/x\u0085y', '/x\ud800', '/x\udc00', `/${'a'.repeat(4096)}`, `/${'中'.repeat(1366)}`]) {
    assert.throws(() => createCloudWindowsPathProjection({ threadId, remoteCwd: cwd, namespace }));
  }
  for (const path of ['\\\\server\\share', '\\\\?\\C:\\local', '\\\\?\\GLOBALROOT', 'C:\\local']) {
    assert.throws(() => createCloudWindowsPathProjection({ threadId, remoteCwd, namespace: path }));
  }
  for (const change of [v => { v.thread.path = '/tmp/rollout.jsonl'; }, v => { v.thread.id = otherThreadId; },
    v => { v.runtimeWorkspaceRoots.push('/other'); }, v => { v.activePermissionProfile = { id: ':workspace' }; },
    v => { v.sandbox = { type: 'workspaceWrite', writableRoots: [remoteCwd] }; },
    v => { v.sandbox.writableRoots = [remoteCwd]; }]) {
    const source = await resumeFixture(); change(source); assert.throws(() => projection().projectResponse('thread/resume', source));
  }
  const source = await resumeFixture(); source.sandbox = { type: 'readOnly', networkAccess: false };
  assert.deepEqual(projection().projectResponse('thread/resume', source).sandbox, source.sandbox);
  source.sandbox = { type: 'externalSandbox', networkAccess: 'restricted' };
  assert.deepEqual(projection().projectResponse('thread/resume', source).sandbox, source.sandbox);
  source.sandbox.networkAccess = 'enabled';
  assert.deepEqual(projection().projectResponse('thread/resume', source).sandbox, source.sandbox);
  source.sandbox.networkAccess = true;
  assert.throws(() => projection().projectResponse('thread/resume', source), { code: 'PROTOCOL_SCHEMA_MISMATCH' });
});

test('complex bound cwd crosses proxy sockets while retaining the original remote binding', { timeout: 10000 }, async t => {
  const cwd = '/tmp/task/workspace/C:\\Users\\某用户/../Example Project';
  const state = stateFixture(cwd), original = structuredClone(state), f = await setup(t, {}, state);
  const resumed = await f.resume();
  assert.match(resumed.result.cwd, /^\\\\\?\\CST-CLOUD-[a-f0-9-]{36}\\cwd~[a-f0-9]{64}$/);
  assert.equal(resumed.result.thread.cwd, resumed.result.cwd);
  assert.equal(resumed.result.thread.turns[0].items[0].content[0].text, `Read ${cwd}`);
  assert.equal(f.proxy.records.namespaceUnregisteredAtStart, true);
  assert.equal(f.proxy.manifest.filesystem, false);
  assert.deepEqual(f.proxy.state, original);
  const read = await rpc(f.socket, 'thread/read', { threadId, includeTurns: true });
  assert.equal(read.result.thread.cwd, resumed.result.cwd);
  assert.deepEqual(f.requests.find(request => request.method === 'thread/resume').params, { threadId });
});

test('unknown items, images and attachments reject history and live updates', async () => {
  const badItems = [{ id: 'x', type: 'fileChange', changes: [] }, { id: 'x', type: 'newFutureItem' },
    { id: 'x', type: 'userMessage', content: [{ type: 'localImage', path: remoteCwd }] },
    { id: 'x', type: 'agentMessage', text: 'answer', attachments: ['private-file'] }];
  for (const item of badItems) {
    const source = await resumeFixture(); source.thread.turns[0].items.push(item);
    assert.throws(() => projection().projectResponse('thread/read', { thread: source.thread }));
    assert.throws(() => projection().projectNotification({ method: 'item/started', params: { threadId, turnId: 'native-turn', item } }));
  }
});

test('cloud file-change diffs and viewed-image labels pass unchanged as display-only history and live items', async () => {
  const source = await resumeFixture(), p = projection();
  const items = [
    { id: 'patch', type: 'fileChange', status: 'completed', changes: [
      { path: '/workspace/report.py', kind: { type: 'add' }, diff: '+print("report")' },
      { path: '/workspace/old.md', kind: { type: 'update', move_path: '/workspace/new.md' }, diff: '-old\n+new' },
    ] },
    { id: 'view', type: 'imageView', path: '/mnt/data/图表.png' },
  ];
  for (const item of items) {
    const thread = structuredClone(source.thread); thread.turns[0].items.push(item);
    assert.deepEqual(p.projectResponse('thread/read', { thread }).thread.turns[0].items.at(-1), item);
    const event = { method: 'item/completed', params: { threadId, turnId: 'native-turn', completedAtMs: 1792490895000, item } };
    assert.deepEqual(p.projectNotification(event), event);
  }
  for (const path of ['C:\\private.png', '\\\\server\\share', '//server/share', 'relative.png', 'file:///C:/private', '/bad\u0000path', '/x\\file', '/' + 'a'.repeat(4096)]) {
    for (const item of [{ ...items[1], path }, { ...items[0], changes: [{ path, kind: { type: 'add' }, diff: '+text' }] }]) {
      const thread = structuredClone(source.thread); thread.turns[0].items.push(item);
      assert.throws(() => p.projectResponse('thread/read', { thread }));
    }
  }
  for (const item of [{ ...items[0], status: 'invented' }, { ...items[0], changes: [{ path: '/ok', kind: { type: 'update', move_path: 'C:\\private' }, diff: '+x' }] },
    { ...items[1], imageData: 'not-supported' }]) {
    const thread = structuredClone(source.thread); thread.turns[0].items.push(item);
    assert.throws(() => p.projectResponse('thread/read', { thread }));
  }
});

function displayItems() {
  return [
    { id: 'plan', type: 'plan', text: 'Inspect and report.' },
    { id: 'function-string', type: 'functionCallOutput', name: 'inspect', namespace: null, output: 'C:\\display-only\\result' },
    { id: 'function-text', type: 'functionCallOutput', name: 'inspect', output: [{ type: 'input_text', text: 'Complete' }] },
    { id: 'mcp', type: 'mcpToolCall', server: 'fixture', tool: 'read', arguments: { path: 'C:\\display-only\\source' }, status: 'completed',
      result: { content: [{ type: 'text', text: 'Tool response', annotations: { audience: ['user'], priority: 0.5 }, _meta: { display: true } }],
        structuredContent: { path: 'C:\\display-only\\result' } }, error: null, durationMs: 12 },
    { id: 'dynamic', type: 'dynamicToolCall', namespace: 'fixture', tool: 'inspect', arguments: { path: remoteCwd }, status: 'completed',
      contentItems: [{ type: 'inputText', text: 'Dynamic response' }], success: true, durationMs: 3 },
    { id: 'web', type: 'webSearch', query: 'official docs', action: { type: 'search', queries: ['official docs'] }, results: [{ title: 'Result' }] },
    { id: 'sleep', type: 'sleep', durationMs: 50 },
    { id: 'agent', type: 'subAgentActivity', agentPath: '/root/research', agentThreadId: otherThreadId, kind: 'completed', model: 'existing-model', reasoningEffort: 'high' },
    { id: 'collab', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed', senderThreadId: threadId,
      receiverThreadIds: [otherThreadId], prompt: 'Research', agentsStates: { [otherThreadId]: { status: 'completed', message: 'Done' } } },
  ];
}

test('known text tool displays survive full history, pages and live items without mutation or execution', async () => {
  const p = projection(), source = await resumeFixture(), items = displayItems();
  source.thread.turns[0].items.push(...items);
  const original = structuredClone(source);
  const resumed = p.projectResponse('thread/resume', source);
  assert.deepEqual(resumed.thread.turns[0].items, source.thread.turns[0].items);
  assert.deepEqual(p.projectResponse('thread/read', { thread: source.thread }).thread.turns[0].items, source.thread.turns[0].items);
  const page = { data: items.map(item => ({ turnId: 'native-turn', item })), nextCursor: null };
  assert.deepEqual(p.projectResponse('thread/items/list', page), page);
  for (const item of items) for (const method of ['item/started', 'item/completed']) {
    const time = method === 'item/started' ? { startedAtMs: 1792490894000 } : { completedAtMs: 1792490895000 };
    const event = { method, params: { threadId, turnId: 'native-turn', item, ...time } };
    assert.deepEqual(p.projectNotification(event), event);
  }
  assert.deepEqual(source, original);
});

test('common tool history and genuine display notifications cross real sockets without control requests', { timeout: 10000 }, async t => {
  const state = stateFixture(), items = displayItems();
  state.turnHistory.history.entitiesByKey.turn.items.push(...items);
  const original = structuredClone(state), f = await setup(t, {}, state);
  const resumed = await f.resume();
  assert.deepEqual(resumed.result.thread.turns[0].items.slice(2), items);
  const page = await rpc(f.socket, 'thread/items/list', { threadId, limit: 50 });
  assert.deepEqual(page.result.data.slice(2).map(entry => entry.item), items);
  for (const event of [
    { method: 'item/started', params: { threadId, turnId: 'native-turn', startedAtMs: 1792490894000, item: items[0] } },
    { method: 'item/plan/delta', params: { threadId, turnId: 'native-turn', itemId: items[0].id, delta: 'Real update' } },
    { method: 'item/mcpToolCall/progress', params: { threadId, turnId: 'native-turn', itemId: items[3].id, message: 'Real progress' } },
    { method: 'item/completed', params: { threadId, turnId: 'native-turn', completedAtMs: 1792490895000, item: items[3] } },
  ]) {
    const received = once(f.socket, 'message');
    [...f.sockets][0].send(JSON.stringify(event));
    assert.deepEqual(JSON.parse((await received)[0]), event);
  }
  assert.deepEqual(f.requests.map(request => request.method), ['initialize', 'thread/resume', 'thread/items/list']);
  assert.deepEqual(state, original);
});

test('tool display schema rejects unknown fields, malformed status and all media or resource outputs', async () => {
  const source = await resumeFixture(), p = projection();
  const bad = [
    ...displayItems().map(item => ({ ...item, newUnknownField: true })),
    { ...displayItems()[3], status: 'invented' }, { id: 'sleep', type: 'sleep', durationMs: -1 },
    { ...displayItems()[4], contentItems: [{ type: 'inputImage', imageUrl: 'file:///C:/private.png' }] },
    { ...displayItems()[4], contentItems: [{ type: 'inputAudio', audioUrl: 'file:///C:/private.wav' }] },
    { ...displayItems()[1], output: [{ type: 'input_image', image_url: 'file:///C:/private.png' }] },
    { ...displayItems()[1], output: [{ type: 'input_text', text: 'text', path: '/extra' }] },
    ...['image', 'audio', 'resource', 'resource_link'].map(type => ({ ...displayItems()[3], result: { content: [{ type, uri: 'file:///C:/private' }] } })),
    { ...displayItems()[3], mcpAppResourceUri: 'file:///C:/app.html' },
    { ...displayItems()[3], mcpAppUi: { resourceUri: 'ui://app', preferredModelDisplayMode: 'inline' } },
    { ...displayItems()[3], appContext: { connectorId: 'app', resourceUri: 'file:///C:/app' } },
    { ...displayItems()[3], result: { content: [{ type: 'text', text: 'text', annotations: { priority: 'high' } }] } },
    { id: 'image', type: 'imageView', path: 'C:\\private.png' },
  ];
  for (const item of bad) {
    const thread = structuredClone(source.thread); thread.turns[0].items.push(item);
    assert.throws(() => p.projectResponse('thread/read', { thread }));
    assert.throws(() => p.projectNotification({ method: 'item/completed', params: { threadId, turnId: 'native-turn', item } }));
  }
});

test('only genuine schema-supported plan deltas and MCP progress pass unchanged', () => {
  const p = projection();
  for (const [method, content] of [['item/plan/delta', { delta: 'partial plan' }], ['item/mcpToolCall/progress', { message: 'Reading' }]]) {
    const event = { method, params: { threadId, turnId: 'native-turn', itemId: 'existing-item', ...content } };
    assert.deepEqual(p.projectNotification(event), event);
    assert.throws(() => p.projectNotification({ ...event, params: { ...event.params, unexpected: true } }));
    assert.throws(() => p.projectNotification({ ...event, params: { ...event.params, threadId: otherThreadId } }));
    assert.throws(() => p.projectNotification({ method, params: { threadId, turnId: 'native-turn', itemId: 'existing-item' } }));
  }
  assert.throws(() => p.projectNotification({ method: 'item/dynamicToolCall/delta', params: { threadId, turnId: 'native-turn', itemId: 'existing-item', delta: 'invented' } }));
});

test('startup skills reads expose only an empty adapter catalog and never forward reloads or writes', { timeout: 10000 }, async t => {
  const f = await setup(t);
  await rpc(f.socket, 'initialize');
  for (const params of [{}, { cwds: [] }, { cwds: ['C:\\startup\\not-read'], forceReload: true }]) {
    assert.deepEqual((await rpc(f.socket, 'skills/list', params)).result, { data: [] });
  }
  for (const request of f.requests.filter(value => value.method === 'skills/list')) assert.equal(request.params.forceReload, false);
  const count = f.requests.length;
  for (const params of [null, { forceReload: 'true' }, { cwds: [null] }, { extraRoots: [] }, { unknown: null }]) {
    assert.equal((await rpc(f.socket, 'skills/list', params)).error.code, -32602);
  }
  for (const method of ['skills/config/write', 'skills/extraRoots/set', 'skills/remote/export']) {
    assert.equal((await rpc(f.socket, method, {})).error.code, -32601);
  }
  assert.equal(f.requests.length, count);
  assert.match(f.proxy.manifest.skills, /not the cloud executor/);
});

test('a nonempty upstream skills inventory cannot be exposed as this adapter catalog', { timeout: 10000 }, async t => {
  const f = await setup(t); await rpc(f.socket, 'initialize');
  f.respond = (request, socket) => {
    if (request.method !== 'skills/list') return false;
    socket.send(JSON.stringify({ id: request.id, result: { data: [{ cwd: 'C:\\not-read', skills: [] }] } })); return true;
  };
  const closed = once(f.socket, 'close');
  f.socket.send(JSON.stringify({ id: 'skills-nonempty', method: 'skills/list', params: {} }));
  assert.equal((await closed)[0], 1011);
  assert.equal(f.proxy.records.projectionFailed, true);
});

test('notification paths and identities are checked without rewriting content', async () => {
  const state = stateFixture();
  const event = { method: 'thread/settings/updated', params: { threadId, threadSettings: { ...state.latestThreadSettings, modelProvider: 'local' } } };
  const result = projection().projectNotification(event);
  assert.equal(result.params.threadSettings.cwd, projection().encodedCwd);
  assert.equal(event.params.threadSettings.cwd, remoteCwd);
  const delta = { method: 'item/agentMessage/delta', params: { threadId, turnId: 'native-turn', itemId: 'native-assistant', delta: remoteCwd } };
  assert.deepEqual(projection().projectNotification(delta), delta);
  for (const value of [{ ...delta, params: { ...delta.params, threadId: otherThreadId } },
    { method: 'unknown/event', params: { threadId } },
    { ...event, params: { threadId, threadSettings: { ...event.params.threadSettings, cwd: '/another' } } },
    { ...event, params: { threadId, threadSettings: { ...event.params.threadSettings, activePermissionProfile: { id: ':workspace' } } } }]) {
    assert.throws(() => projection().projectNotification(value));
  }
});

test('proxy uses a separate token, truthful state getters, and never takes bridge ownership', { timeout: 10000 }, async t => {
  const f = await setup(t); const response = await f.resume();
  assert.notEqual(f.proxy.token, f.bridge.token);
  assert.match(response.result.cwd, /^\\\\\?\\CST-CLOUD-/);
  assert.equal(f.proxy.state, f.state); assert.equal(f.proxy.state.latestThreadSettings.cwd, remoteCwd);
  assert.equal(f.proxy.status, f.bridge.status); assert.equal(f.proxy.manifest.readonly, true);
  assert.deepEqual(f.proxy.manifest.allowedControls, []);
  for (const operation of ['send', 'steer', 'queue', 'interrupt', 'filesystem']) assert.equal(f.proxy.manifest[operation], false);
  assert.equal(f.proxy.records.interruptEnabled, false);
  assert.deepEqual((await rpc(f.socket, 'thread/loaded/list')).result.data, [threadId]);
  const read = await rpc(f.socket, 'thread/read', { threadId, includeTurns: true });
  assert.equal(read.result.thread.turns[0].items[0].clientId, 'frontend-user');
  assert.equal((await rpc(f.socket, 'thread/turns/list', { threadId, limit: 1 })).result.data[0].id, 'native-turn');
  assert.equal((await rpc(f.socket, 'thread/items/list', { threadId, limit: 1 })).result.data[0].item.id, 'native-user');
  await f.proxy.close(); await f.proxy.close(); assert.equal(f.bridge.status.ready, true);
});

test('a history response larger than one MiB crosses real proxy sockets without truncation', { timeout: 10000 }, async t => {
  const f = await setup(t);
  // Also exceeds the normal queued-output budget, exercising the separate
  // allowance for one complete large history frame.
  const text = `HISTORY_START\n${'complete cloud history '.repeat(250000)}\nHISTORY_END`;
  assert.ok(Buffer.byteLength(text) > 1024 * 1024);
  f.state.turnHistory.history.entitiesByKey.turn.items[1].text = text;
  await rpc(f.socket, 'initialize');
  const read = await rpc(f.socket, 'thread/read', { threadId, includeTurns: true });
  assert.equal(read.result.thread.turns[0].items[1].text, text);
  const resumed = await rpc(f.socket, 'thread/resume', { threadId });
  assert.equal(resumed.result.thread.turns[0].items[1].text, text);
  assert.deepEqual((await rpc(f.socket, 'thread/loaded/list')).result.data, [threadId]);
  assert.equal(f.socket.readyState, WebSocket.OPEN);
  assert.equal(f.proxy.records.projectionFailed, undefined);
});

async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail('Fixture condition did not become true.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('a paused real client is disconnected at the bounded downstream budget', { timeout: 10000 }, async t => {
  const f = await setup(t);
  f.state.turnHistory.history.entitiesByKey.turn.items[1].text = 'history '.repeat(16384);
  await f.resume();
  f.socket.pause();
  t.after(() => f.socket.resume());
  for (let i = 0; i < 64; i++) f.socket.send(JSON.stringify({ id: `slow-read-${i}`, method: 'thread/read', params: { threadId, includeTurns: true } }));
  await waitFor(() => f.proxy.records.bufferLimitExceeded === 'downstream');
  assert.equal(f.proxy.records.disconnectReason, 'buffer-limit-exceeded');
  assert.ok(f.proxy.records.peakDownstreamBufferedBytes > 0);
  assert.ok(f.proxy.records.peakDownstreamBufferedBytes <= f.proxy.manifest.buffering.queuedBytesPerDirection);
  await waitFor(() => f.sockets.size === 0);
  f.socket.resume();
  await waitFor(() => f.socket.readyState === WebSocket.CLOSED);
});

test('a paused real upstream is disconnected without unbounded request writes', { timeout: 10000 }, async t => {
  const f = await setup(t); await f.resume();
  const upstream = [...f.sockets][0]; upstream.pause();
  t.after(() => upstream.resume());
  const cursor = 'c'.repeat(256 * 1024);
  for (let i = 0; i < 64; i++) f.socket.send(JSON.stringify({ id: `slow-upstream-${i}`, method: 'model/list', params: { cursor } }));
  await waitFor(() => f.proxy.records.bufferLimitExceeded === 'upstream');
  assert.equal(f.proxy.records.disconnectReason, 'buffer-limit-exceeded');
  assert.ok(f.proxy.records.peakUpstreamBufferedBytes > 0);
  assert.ok(f.proxy.records.peakUpstreamBufferedBytes <= f.proxy.manifest.buffering.queuedBytesPerDirection);
  await waitFor(() => f.socket.readyState === WebSocket.CLOSED);
  upstream.resume();
});

test('writes, settings overrides and foreign identities never reach the upstream', { timeout: 10000 }, async t => {
  const f = await setup(t); await f.resume(); const before = f.requests.length;
  for (const method of ['turn/start', 'turn/steer', 'turn/interrupt', 'turn/addUserMessage', 'thread/start', 'thread/settings/update',
    'thread/queue/add', 'thread/queue/remove', 'thread/rollback', 'thread/compact/start', 'thread/name/set',
    'command/exec', 'process/kill', 'fs/writeFile', 'fs/readFile', 'item/permissions/requestApproval', 'account/login/start']) {
    assert.ok((await rpc(f.socket, method, { threadId, turnId: 'native-turn' })).error);
  }
  for (const params of [{ threadId: otherThreadId }, { threadId, cwd: remoteCwd }, { threadId, model: 'replacement' },
    { threadId, config: {} }, { threadId, runtimeWorkspaceRoots: [] }, { threadId, approvalPolicy: 'never' }]) {
    assert.ok((await rpc(f.socket, 'thread/resume', params)).error);
  }
  assert.ok((await rpc(f.socket, 'thread/read', { threadId: otherThreadId })).error);
  assert.ok((await rpc(f.socket, 'account/read', { refreshToken: true })).error);
  assert.equal(f.requests.length, before);
  assert.ok((await rpc(f.socket, 'thread/resume', { threadId, cwd: null, config: null, model: null, excludeTurns: true })).result);
  assert.deepEqual(f.requests.at(-1).params, { threadId, excludeTurns: true });
});

async function rejectedUpgrade(endpoint, headers = {}) {
  const socket = new WebSocket(endpoint, { headers });
  const result = new Promise(resolve => {
    socket.on('unexpected-response', (_request, response) => { response.resume(); socket.terminate(); resolve(response.statusCode); });
    socket.on('error', () => {}); socket.on('open', () => { socket.terminate(); resolve('opened'); });
  });
  return result;
}
test('loopback handshake rejects wrong credentials, origins, paths and concurrent clients', { timeout: 10000 }, async t => {
  const f = await setup(t), authorization = `Bearer ${f.proxy.token}`;
  for (const headers of [{}, { Authorization: `Bearer ${f.bridge.token}` }, { Authorization: authorization, Origin: 'https://example.com' },
    { Authorization: authorization, Origin: '' }, { Authorization: authorization }]) {
    assert.equal(await rejectedUpgrade(f.proxy.endpoint, headers), 401);
  }
  f.socket.close(); await once(f.socket, 'close');
  assert.equal(await rejectedUpgrade(`${f.proxy.endpoint}/other`, { Authorization: authorization }), 401);
  assert.equal(await rejectedUpgrade(`${f.proxy.endpoint}/?secret=1`, { Authorization: authorization }), 401);
  assert.equal(await rejectedUpgrade(f.proxy.endpoint, { Authorization: `Bearer ${f.bridge.token}` }), 401);
  const valid = await f.connect(); assert.equal(valid.readyState, WebSocket.OPEN);
});

test('unavailable namespace and non-loopback endpoints fail before connecting', async () => {
  const state = stateFixture();
  const bridge = { endpoint: 'ws://127.0.0.1:12345', token: 'a'.repeat(64), state, status: { ready: true }, manifest: { readonly: true } };
  await assert.rejects(createCloudWindowsCliProxy({ bridge }, { ...factories, verifyUnusedNamespace: async () => false }));
  await assert.rejects(createCloudWindowsCliProxy({ bridge }, { ...factories, platform: 'linux' }));
  for (const endpoint of ['ws://example.com:123', 'ws://localhost:123', 'wss://127.0.0.1:123', 'ws://user:pass@127.0.0.1:123', 'ws://127.0.0.1:123/?a=1']) {
    await assert.rejects(createCloudWindowsCliProxy({ bridge: { ...bridge, endpoint } }, factories));
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createCloudWindowsCliProxy({ bridge, signal: controller.signal }, factories), { code: 'ABORTED' });
});

test('removed interrupt options reject before the bridge, namespace probe or any callback is accessed', async () => {
  let callbacks = 0, probes = 0;
  for (const options of [{ allowInterrupt: true }, { interruptControl: async () => { callbacks++; } },
    { interruptControl: undefined }, { interruptControl: null }]) {
    Object.defineProperty(options, 'bridge', { get() { assert.fail('The removed control API must reject before reading the bridge.'); } });
    await assert.rejects(createCloudWindowsCliProxy(options, {
      ...factories, verifyUnusedNamespace: async () => { probes++; return true; },
    }), { code: 'READ_ONLY_REQUIRED' });
  }
  assert.equal(callbacks, 0); assert.equal(probes, 0);
});

test('changed binding, foreign response and unsupported live item fail closed', { timeout: 10000 }, async t => {
  for (const scenario of ['changed', 'foreign', 'item', 'uncorrelated']) {
    await t.test(scenario, async t => {
      const f = await setup(t); await f.resume();
      const closed = once(f.socket, 'close');
      if (scenario === 'changed') f.bridge.state = { ...f.state, id: otherThreadId };
      const upstream = [...f.sockets][0];
      if (scenario === 'foreign' || scenario === 'changed') upstream.send(JSON.stringify({ method: 'thread/status/changed', params: { threadId: otherThreadId, status: { type: 'idle' } } }));
      if (scenario === 'item') upstream.send(JSON.stringify({ method: 'item/started', params: { threadId, turnId: 'native-turn', item: { id: 'x', type: 'fileChange', changes: [] } } }));
      if (scenario === 'uncorrelated') upstream.send(JSON.stringify({ id: 999999, result: {} }));
      assert.equal((await closed)[0], 1011); assert.equal(f.proxy.records.projectionFailed, true);
    });
  }
});

test('interrupt remains denied before and after resume and reconnect while observation continues', { timeout: 10000 }, async t => {
  const f = await setup(t, { allowInterrupt: false });
  const original = structuredClone(f.state);
  await rpc(f.socket, 'initialize');
  assert.equal((await rpc(f.socket, 'turn/interrupt', { threadId, turnId: 'native-turn' })).error.code, -32601);
  await rpc(f.socket, 'thread/resume', { threadId });
  for (const params of [{ threadId, turnId: 'native-turn' }, { threadId: otherThreadId, turnId: 'native-turn' },
    { threadId, turnId: 'old-turn' }, { threadId, turnId: 'native-turn', input: 'unexpected' }]) {
    assert.equal((await rpc(f.socket, 'turn/interrupt', params)).error.code, -32601);
  }
  const notification = { method: 'item/agentMessage/delta', params: { threadId, turnId: 'native-turn', itemId: 'native-assistant', delta: 'still running' } };
  const received = once(f.socket, 'message');
  [...f.sockets][0].send(JSON.stringify(notification));
  assert.deepEqual(JSON.parse((await received)[0]), notification);
  assert.ok((await rpc(f.socket, 'thread/turns/list', { threadId, limit: 1 })).result);
  await rpc(f.socket, 'thread/unsubscribe', { threadId });
  assert.equal((await rpc(f.socket, 'turn/interrupt', { threadId, turnId: 'native-turn' })).error.code, -32601);
  f.socket.close(); await once(f.socket, 'close'); f.socket = await f.connect(); await f.resume();
  assert.equal((await rpc(f.socket, 'turn/interrupt', { threadId, turnId: 'native-turn' })).error.code, -32601);
  assert.equal(f.requests.some(request => request.method === 'turn/interrupt'), false);
  assert.deepEqual(f.state, original);
  assert.equal(f.proxy.records.interruptEnabled, false);
  assert.equal(f.proxy.records.interruptResult, undefined);
});

test('proxy cancellation closes its sockets without closing the caller-owned bridge', { timeout: 10000 }, async t => {
  const controller = new AbortController(), f = await setup(t, { signal: controller.signal });
  await f.resume();
  const closed = once(f.socket, 'close'); controller.abort(); await closed;
  await f.proxy.close();
  assert.equal(f.bridge.status.ready, true);
  assert.equal(f.bridge.state.latestThreadSettings.cwd, remoteCwd);
});

test('duplicate in-flight request IDs and client approval responses close the session', { timeout: 10000 }, async t => {
  for (const kind of ['duplicate', 'approval-response']) await t.test(kind, async t => {
    const f = await setup(t); await f.resume(); const closed = once(f.socket, 'close');
    if (kind === 'duplicate') {
      f.respond = async request => request.method === 'model/list';
      f.socket.send(JSON.stringify({ id: 900, method: 'model/list' }));
      f.socket.send(JSON.stringify({ id: 900, method: 'model/list' }));
    } else f.socket.send(JSON.stringify({ id: 'approval-id', result: { decision: 'accept' } }));
    assert.equal((await closed)[0], 1008);
    assert.equal(f.requests.some(request => request.id === 'approval-id'), false);
  });
});
