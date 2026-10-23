import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';
import { createCloudNativeCliBridge, createCloudNativeMetadataReader } from '../cloud-native-cli-bridge.mjs';
import { validateProtocol } from '../protocol-validation.mjs';

const threadId = '11111111-1111-4111-8111-111111111111';
function fixture() {
  const turn = { turnId: 'native-turn', status: 'completed', turnStartedAtMs: 1792490894000, durationMs: 9000,
    items: [{ id: 'native-user', type: 'userMessage', content: [{ type: 'text', text: 'Original cloud prompt' }] },
      { id: 'native-assistant', type: 'agentMessage', text: 'Original cloud answer', phase: 'final_answer' }],
    itemsPagination: { hasLoadedOldest: true } };
  const state = { id: threadId, sessionId: threadId, hostId: 'durable', title: 'Cloud fixture',
    createdAt: 1792490891000, updatedAt: 1792548246000,
    source: { custom: 'codex-cloud-agent' }, threadSource: 'user', originator: 'codex_work_web',
    historyMode: 'legacy', modelProvider: 'local', latestModel: 'gpt-6.1-sol-wm',
    cwd: '/workspace/scratch/example', threadRuntimeStatus: { type: 'idle' },
    latestThreadSettings: { model: 'gpt-6.1-sol-wm', cwd: '/workspace/scratch/example', effort: 'medium', disabledPluginIds: [],
      multiAgentMode: { custom: '' }, collaborationMode: { mode: 'default', settings: {
        model: 'gpt-6.1-sol-wm', reasoning_effort: 'medium', developer_instructions: null,
      } }, approvalPolicy: { granular: { sandbox_approval: false, rules: false, skill_approval: false, request_permissions: false, mcp_elicitations: true } },
      approvalsReviewer: 'auto_review', sandboxPolicy: { type: 'dangerFullAccess' } },
    currentPermissions: { runtimeWorkspaceRoots: ['/workspace/scratch/example'] },
    turns: [], turnHistory: { kind: 'canonical', history: { entitiesByKey: { turn }, islands: [{
      entries: [{ value: 'turn' }], olderBoundary: { status: 'exhausted' }, newerBoundary: { status: 'exhausted' },
    }] } } };
  const f = { state, writes: [], hydrations: 0, constructions: [], closed: false };
  f.desktop = Object.assign(new EventEmitter(), {
    state, status: { phase: 'idle', ready: false }, owner: { clientId: 'existing-owner' },
    async connect(id) { assert.equal(id, threadId); this.status = { phase: 'ready', ready: true }; this.emit('status', this.status); },
    async ensureCompleteHistory() { f.hydrations++; throw new Error('Owner hydration must not be called.'); },
    async requestFollower(method, params) { f.writes.push({ method, params }); throw new Error('Writes must not reach Desktop.'); },
    close() { f.closed = true; },
  });
  f.factories = {
    createDesktopClient(settings) { f.constructions.push(settings); return f.desktop; },
    createMetadataReader() { assert.fail('A local metadata backend must never be created.'); },
  };
  return f;
}

let sequence = 0;
function rpc(socket, method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('message', receive); reject(new Error('Fixture RPC timeout.')); }, 3000);
    const receive = bytes => { const message = JSON.parse(bytes); if (message.id === id) { clearTimeout(timer); socket.off('message', receive); resolve(message); } };
    socket.on('message', receive);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

test('bootstrap capabilities describe only this reader and the genuine current model', async () => {
  const f = fixture();
  const reader = createCloudNativeMetadataReader({ getState: () => f.state, threadId, persistedThread: true, bridgeHome: tmpdir() });
  const initialized = await reader.initialize();
  assert.equal(initialized.codexHome, tmpdir());
  assert.match(initialized.userAgent, /cloud-readonly-experiment/);
  assert.notEqual(initialized.codexHome, f.state.cwd);
  assert.deepEqual(await reader.call('account/read'), { account: null, requiresOpenaiAuth: false });
  const catalog = await reader.call('model/list');
  assert.equal(catalog.data.length, 1);
  assert.equal(catalog.data[0].model, f.state.latestThreadSettings.model);
  assert.equal(catalog.data[0].defaultReasoningEffort, 'medium');
  assert.deepEqual(catalog.data[0].inputModalities, ['text']);
  assert.deepEqual(catalog.data[0].supportedReasoningEfforts.map(value => value.reasoningEffort), ['medium']);
  const { requirements } = await reader.call('configRequirements/read');
  assert.equal(requirements.allowRemoteControl, false);
  assert.equal(requirements.allowBrowserAndComputerUse, false);
  assert.equal(requirements.allowedApprovalPolicies, undefined);
  assert.equal(requirements.allowedSandboxModes, undefined);
  assert.match(reader.manifest.requirements, /not cloud execution policy/);
  await reader.close();
  await assert.rejects(reader.call('model/list'), { code: 'CLOSED' });
});

test('metadata exposes complete native history with stable page cursors and refuses local/environment queries', async () => {
  const f = fixture(), reader = createCloudNativeMetadataReader({ getState: () => f.state, threadId, persistedThread: true });
  const read = await reader.call('thread/read', { threadId, includeTurns: true });
  assert.equal(read.thread.turns[0].id, 'native-turn');
  assert.equal(read.thread.turns[0].items[0].id, 'native-user');
  assert.equal(read.thread.modelProvider, 'local');
  read.thread.turns[0].items[0].content[0].text = 'Caller mutation';
  const first = await reader.call('thread/items/list', { threadId, limit: 1 });
  assert.equal(first.data[0].item.content[0].text, 'Original cloud prompt');
  first.data[0].item.content[0].text = 'Page mutation';
  assert.equal((await reader.call('thread/items/list', { threadId, limit: 1 })).data[0].item.content[0].text, 'Original cloud prompt');
  const next = await reader.call('thread/items/list', { threadId, limit: 1, cursor: first.nextCursor });
  assert.equal(first.data[0].item.id, 'native-user');
  assert.equal(next.data[0].item.id, 'native-assistant');
  assert.equal(next.nextCursor, null);
  for (const method of ['config/read', 'hooks/list', 'account/rateLimits/read', 'collaborationMode/list', 'turn/start']) {
    await assert.rejects(reader.call(method), error => error.rpcError.code === -32601);
  }
  await assert.rejects(reader.call('thread/read', { threadId: 'foreign' }), { code: 'THREAD_MISMATCH' });
  assert.equal(f.hydrations, 0);
});

test('skills catalog describes only the read-only adapter and never reads or refreshes executor state', async () => {
  const reader = createCloudNativeMetadataReader({ getState() { assert.fail('Skills must not inspect cloud or local state.'); }, threadId });
  for (const params of [{}, { cwds: [] }, { forceReload: true }, { forceReload: false, cwds: ['C:\\not-read', '/cloud/not-read'] }]) {
    const original = structuredClone(params);
    assert.deepEqual(await reader.call('skills/list', params), { data: [] });
    assert.deepEqual(params, original);
  }
  for (const params of [null, [], { forceReload: null }, { forceReload: 'true' }, { cwds: 'C:\\not-read' },
    { cwds: [null] }, { cwds: ['/path\0suffix'] }, { cwds: ['/path\nsuffix'] }, { cwds: Array(33).fill('/path') },
    { cwd: '/other' }, { install: null }, { extraRoots: [] }]) {
    await assert.rejects(reader.call('skills/list', params), error => error.code === 'INVALID_PARAMS' && error.rpcError.code === -32602);
  }
  assert.match(reader.manifest.skills, /this read-only terminal only/);
  assert.match(reader.manifest.skills, /no cloud or local skill inventory/);
  for (const method of ['skills/config/write', 'skills/remote/export', 'skills/extraRoots/set']) {
    await assert.rejects(reader.call(method), error => error.rpcError.code === -32601);
  }
  await reader.close();
  await assert.rejects(reader.call('skills/list'), { code: 'CLOSED' });
});

test('official protocol loopback reader resumes real cloud state and rejects every control operation', { timeout: 10000 }, async t => {
  const f = fixture();
  const bridge = await createCloudNativeCliBridge({ threadId, persistedThread: true, bridgeHome: tmpdir() }, f.factories);
  t.after(() => bridge.close());
  assert.deepEqual(f.constructions, [{ hostId: 'durable', allowExperimentalDurableControl: false }]);
  const socket = new WebSocket(bridge.endpoint, { headers: { Authorization: `Bearer ${bridge.token}` } });
  t.after(() => socket.terminate());
  await once(socket, 'open');
  assert.ok((await rpc(socket, 'initialize')).result);
  assert.deepEqual((await rpc(socket, 'account/read')).result, { account: null, requiresOpenaiAuth: false });
  assert.equal((await rpc(socket, 'model/list')).result.data[0].model, 'gpt-6.1-sol-wm');
  assert.equal((await rpc(socket, 'configRequirements/read')).result.requirements.allowAppshots, false);
  assert.deepEqual((await rpc(socket, 'skills/list', { cwds: ['C:\\not-read'], forceReload: true })).result, { data: [] });
  const resumed = await rpc(socket, 'thread/resume', { threadId });
  validateProtocol('v2/ThreadResumeResponse', resumed.result);
  assert.equal(resumed.result.thread.turns[0].items[1].text, 'Original cloud answer');
  assert.deepEqual(resumed.result.sandbox, { type: 'dangerFullAccess' });
  assert.deepEqual(resumed.result.approvalPolicy, f.state.latestThreadSettings.approvalPolicy);
  assert.equal(resumed.result.approvalsReviewer, 'auto_review');
  for (const method of ['turn/start', 'turn/steer', 'turn/interrupt', 'thread/settings/update', 'thread/start', 'account/login/start']) {
    assert.ok((await rpc(socket, method, { threadId, input: [{ type: 'text', text: 'MUST NOT SEND' }] })).error);
  }
  assert.deepEqual(f.writes, []);
  assert.equal(f.hydrations, 0);
  assert.equal(bridge.evidence.readonly, true);
  assert.equal(bridge.manifest.localBackendStarted, false);
  assert.deepEqual(bridge.manifest.metadataProjection.unknownFields, ['cliVersion', 'projectId']);
  socket.close(); await once(socket, 'close');
  await bridge.close(); assert.equal(f.closed, true);
});

test('unknown effort and unsupported history fail before publishing an endpoint without fetching or writing', async () => {
  for (const change of [state => { delete state.latestThreadSettings.effort; },
    state => { state.historyMode = 'paginated'; }]) {
    const f = fixture(); change(f.state);
    await assert.rejects(createCloudNativeCliBridge({ threadId, persistedThread: true }, f.factories));
    assert.equal(f.closed, true); assert.equal(f.hydrations, 0); assert.deepEqual(f.writes, []);
  }
});

test('a recent-only snapshot is completed once through its existing owner before CLI attachment', async () => {
  const f = fixture(), controller = new AbortController();
  f.state.turnHistory.history.islands[0].olderBoundary.status = 'available';
  f.desktop.ensureCompleteHistory = async options => {
    f.hydrations++;
    assert.equal(options.timeoutMs, 20000);
    assert.equal(options.signal, controller.signal);
    const next = structuredClone(f.state);
    next.turnHistory.history.islands[0].olderBoundary.status = 'exhausted';
    f.desktop.state = next;
    return next;
  };
  const bridge = await createCloudNativeCliBridge({ threadId, persistedThread: true, signal: controller.signal }, f.factories);
  try {
    assert.equal(bridge.status.ready, true);
    assert.equal(f.hydrations, 1);
    assert.deepEqual(f.writes, []);
    assert.match(bridge.manifest.history, /20-second deadline/);
  } finally { await bridge.close(); }
});

test('failed or cancelled history completion releases the connection and never publishes a partial history', async () => {
  for (const code of ['HISTORY_TIMEOUT', 'ABORTED']) {
    const f = fixture();
    f.state.turnHistory.history.islands[0].olderBoundary.status = 'available';
    f.desktop.ensureCompleteHistory = async () => { f.hydrations++; throw Object.assign(new Error(code), { code }); };
    await assert.rejects(createCloudNativeCliBridge({ threadId, persistedThread: true }, f.factories), { code });
    assert.equal(f.hydrations, 1);
    assert.equal(f.closed, true);
    assert.deepEqual(f.writes, []);
  }
});

test('owner history completion must still return the same complete durable thread', async () => {
  for (const change of [state => { state.id = '22222222-2222-4222-8222-222222222222'; },
    state => { state.hostId = 'local'; }, state => {}, state => { state.historyMode = 'paginated'; }]) {
    const f = fixture();
    f.state.turnHistory.history.islands[0].olderBoundary.status = 'available';
    f.desktop.ensureCompleteHistory = async () => { f.hydrations++; change(f.desktop.state); return f.desktop.state; };
    await assert.rejects(createCloudNativeCliBridge({ threadId, persistedThread: true }, f.factories));
    assert.equal(f.hydrations, 1); assert.equal(f.closed, true); assert.deepEqual(f.writes, []);
  }
});

test('control opt-ins and cancellation are rejected before any desktop transport is constructed', async () => {
  const f = fixture();
  for (const options of [{ allowControl: true }, { allowExperimentalDurableControl: true }]) {
    await assert.rejects(createCloudNativeCliBridge({ threadId, ...options }, f.factories), { code: 'READ_ONLY_REQUIRED' });
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createCloudNativeCliBridge({ threadId, signal: controller.signal }, f.factories), { code: 'ABORTED' });
  assert.deepEqual(f.constructions, []);
});

test('live native updates retain IDs and pass the official notification schema without permission substitution', { timeout: 10000 }, async t => {
  const f = fixture(), errors = [];
  const bridge = await createCloudNativeCliBridge({ threadId, persistedThread: true, onError: error => errors.push(error) }, f.factories);
  t.after(() => bridge.close());
  const socket = new WebSocket(bridge.endpoint, { headers: { Authorization: `Bearer ${bridge.token}` } });
  t.after(() => socket.terminate()); await once(socket, 'open');
  await rpc(socket, 'initialize'); await rpc(socket, 'thread/resume', { threadId });
  const received = [];
  socket.on('message', bytes => { const value = JSON.parse(bytes); if (value.method) received.push(value); });
  const next = structuredClone(f.state);
  next.turnHistory.history.islands[0].entries.push({ value: 'live' });
  next.turnHistory.history.entitiesByKey.live = { turnId: 'real-live-turn', status: 'inProgress', turnStartedAtMs: 1792548247000,
    items: [{ type: 'agentMessage', id: 'real-live-message', text: 'Cloud delta', phase: 'commentary' }] };
  next.threadRuntimeStatus = { type: 'active', activeFlags: [] };
  f.desktop.state = next; f.desktop.emit('state', next, { revision: 2 });
  await rpc(socket, 'thread/loaded/list');
  assert.equal(received.find(value => value.method === 'turn/started').params.turn.id, 'real-live-turn');
  assert.equal(received.find(value => value.method === 'item/agentMessage/delta').params.itemId, 'real-live-message');
  for (const value of received) validateProtocol('ServerNotification', value);
  assert.deepEqual(errors, []); assert.deepEqual(f.writes, []);
});
