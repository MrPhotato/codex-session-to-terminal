import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import WebSocket from 'ws';
import { createNativeCliBridge, validThreadId } from '../native-cli-bridge.mjs';
import { DesktopEventProjector, apiItems } from '../desktop-events.mjs';
import { createDesktopController, validateInheritedSettings, assertControlReady } from '../desktop-control.mjs';
import { METADATA_METHODS } from '../readonly-metadata.mjs';
import { SnapshotHistory } from '../snapshot-history.mjs';
import { validateProtocol } from '../protocol-validation.mjs';

test('metadata helper never exposes execution or plugin update methods', () => {
  for (const method of ['thread/resume', 'thread/start', 'turn/start', 'turn/steer', 'turn/interrupt', 'plugin/list', 'config/value/write']) assert.equal(METADATA_METHODS.has(method), false);
  assert.equal(METADATA_METHODS.has('thread/items/list'), true);
});

test('canonical live lifecycle emits native ordered events once with incremental text', () => {
  const events = [];
  const projector = new DesktopEventProjector('thread', (method, params) => events.push({ method, params }));
  const state = { title: 'test', latestThreadSettings: {}, threadRuntimeStatus: { type: 'idle' }, turns: [],
    turnHistory: { kind: 'canonical', history: { islands: [{ entries: [], newerBoundary: { status: 'exhausted' } }], entitiesByKey: {} } } };
  projector.seed(state);
  const update = (text, status) => {
    const next = structuredClone(state);
    next.turnHistory.history.islands[0].entries = [{ value: 'real-turn' }];
    next.turnHistory.history.entitiesByKey['real-turn'] = { turnId: 'real-turn', status, turnStartedAtMs: 1000,
      items: [{ type: 'agentMessage', id: 'real-item', text, phase: 'final_answer' }], completedItemIds: status === 'completed' ? ['real-item'] : [] };
    projector.update(next);
  };
  update('he', 'inProgress'); update('hello', 'inProgress'); update('hello', 'completed'); update('hello', 'completed');
  assert.deepEqual(events.map(event => event.method), ['turn/started', 'item/started', 'item/agentMessage/delta', 'item/agentMessage/delta', 'item/completed', 'turn/completed']);
  assert.deepEqual(events.filter(event => event.method.endsWith('/delta')).map(event => event.params.delta), ['he', 'llo']);
  assert.equal(events[0].params.turn.id, 'real-turn');
  for (const event of events) validateProtocol('ServerNotification', event);
});

test('history expansion never emits live completion or releases a native queue', () => {
  const events = [], p = new DesktopEventProjector('thread', (method, params) => events.push({ method, params }));
  const state = { title: 'test', turns: [{ turnId: 'live', status: 'inProgress', items: [], turnStartedAtMs: 2000 }] };
  p.seed(state);
  p.update({ ...state, turns: [{ turnId: 'old', status: 'completed', items: [], turnStartedAtMs: 1000 }, ...state.turns] });
  assert.deepEqual(events, []);
});

test('same snapshot supplies active-turn history and stream baseline without losing prefix', () => {
  const turn = { turnId: 'active', status: 'inProgress', turnStartedAtMs: 1000,
    items: [{ type: 'agentMessage', id: 'message', text: 'prefix', phase: 'commentary' }] };
  const state = { turns: [], turnHistory: { kind: 'canonical', history: { islands: [{ entries: [{ value: 'active' }], olderBoundary: { status: 'exhausted' }, newerBoundary: { status: 'exhausted' } }], entitiesByKey: { active: turn } } } };
  const history = new SnapshotHistory(state), events = [], p = new DesktopEventProjector('thread', (method, params) => events.push({ method, params }));
  p.seed(state);
  const turnsPage = history.page('turns', { itemsView: 'notLoaded' }), itemPage = history.page('items');
  validateProtocol('v2/ThreadTurnsListResponse', turnsPage); validateProtocol('v2/ThreadItemsListResponse', itemPage);
  assert.equal(turnsPage.data[0].status, 'inProgress'); assert.equal(itemPage.data[0].item.text, 'prefix');
  const next = structuredClone(state); next.turnHistory.history.entitiesByKey.active.items[0].text += ' suffix';
  p.update(next);
  assert.equal(events[0].method, 'item/agentMessage/delta'); assert.equal(events[0].params.delta, ' suffix');
  assert.equal(history.page('items').data[0].item.text, 'prefix');
});

test('unimplemented changes to execution settings fail before forwarding', () => {
  const state = { latestThreadSettings: { model: 'real', effort: 'high', cwd: 'C:\\test', collaborationMode: { mode: 'default', settings: {} } }, currentPermissions: { approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly' } } };
  for (const params of [{ effort: 'low' }, { cwd: 'C:\\elsewhere' }, { approvalPolicy: 'never' }, { sandboxPolicy: { type: 'dangerFullAccess' } }, { collaborationMode: { mode: 'plan' } }, { disabledPluginIds: [] }, { multiAgentMode: 'proactive' }, { personality: 'friendly' }, { responsesapiClientMetadata: {} }, { parentTurnId: 'parent' }, { turnTrigger: 'agent' }, { futureParameter: true }]) assert.throws(() => validateInheritedSettings(params, state), /not supported/);
  validateInheritedSettings({ model: 'real', effort: 'high', approvalPolicy: 'on-request', turnTrigger: 'user', personality: null }, state);
  state.currentPermissions.runtimeWorkspaceRoots = ['C:\\test', 'C:\\Users\\test/.codex/visualizations'];
  validateInheritedSettings({ runtimeWorkspaceRoots: ['C:\\test', 'C:\\Users\\test\\.codex\\visualizations'] }, state);
  assert.throws(() => validateInheritedSettings({ runtimeWorkspaceRoots: ['C:\\test', 'C:\\Users\\test'] }, state), /not supported/);
});

test('runtime workspace roots compare lexical Windows sets without broadening permissions', async () => {
  const project = 'C:\\workspace\\project', visual = 'C:\\Users\\test\\.codex\\visualizations';
  const originalRoots = [visual, project, 'C:\\Users\\test/.codex/visualizations'];
  const state = { cwd: project, latestThreadSettings: { cwd: project, model: 'real' },
    currentPermissions: { runtimeWorkspaceRoots: originalRoots, approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [project, visual], networkAccess: false } }, turns: [] };
  for (const roots of [[project, visual], [visual, project], [project, visual, visual], ['C:/workspace/project', visual]]) {
    validateInheritedSettings({ runtimeWorkspaceRoots: roots }, state);
  }
  assert.deepEqual(state.currentPermissions.runtimeWorkspaceRoots, originalRoots);
  for (const roots of [[project, visual, 'C:\\extra'], [project], [project, `${visual}-sibling`], [project, 'C:\\Users\\test'],
    [project, 'C:\\Users\\test\\.codex\\Visualizations'], [project, 'C:\\junction-alias']]) {
    assert.throws(() => validateInheritedSettings({ runtimeWorkspaceRoots: roots }, state), /Changing runtimeWorkspaceRoots/);
  }
  for (const change of [{ approvalPolicy: 'never' }, { sandboxPolicy: { ...state.currentPermissions.sandboxPolicy, networkAccess: true } },
    { sandboxPolicy: { ...state.currentPermissions.sandboxPolicy, writableRoots: [visual, project] } },
    { sandboxPolicy: { ...state.currentPermissions.sandboxPolicy, writableRoots: [project, visual, visual] } }]) {
    assert.throws(() => validateInheritedSettings(change, state), /not supported/);
  }
  const forwarded = [];
  const desktop = { state, status: { ready: true }, currentOwner: { clientId: 'owner' },
    async requestFollower(method, params) { forwarded.push({ method, params }); return { result: { result: { turn: { id: 'accepted' } } } }; } };
  const controller = createDesktopController(desktop, 'thread');
  await controller.call('turn/start', { threadId: 'thread', runtimeWorkspaceRoots: [project, visual], input: [{ type: 'text', text: 'fixture' }] });
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].params.turnStart.context.inheritThreadSettings, true);
  assert.equal(Object.hasOwn(forwarded[0].params.turnStart.request, 'runtimeWorkspaceRoots'), false);
  await assert.rejects(controller.call('turn/start', { threadId: 'thread', runtimeWorkspaceRoots: [project, visual, 'C:\\extra'],
    input: [{ type: 'text', text: 'fixture' }] }), /Changing runtimeWorkspaceRoots/);
  assert.equal(forwarded.length, 1);
});

test('control refuses unconfirmed optimistic turns and incomplete live tails', () => {
  assert.throws(() => assertControlReady({ turns: [{ status: 'inProgress' }] }), /admitting a new turn/);
  assert.throws(() => assertControlReady({ turnHistory: { kind: 'canonical', history: { islands: [{ newerBoundary: { status: 'available' } }] } } }), /current end/);
  assert.throws(() => assertControlReady({ turns: [], threadRuntimeStatus: { type: 'active' } }), /without a confirmed/);
  assertControlReady({ turns: [{ turnId: 'active', status: 'inProgress' }], threadRuntimeStatus: { type: 'active' } });
});

test('snapshot paging follows official default directions and bounded page sizes', () => {
  const entities = Object.fromEntries(Array.from({ length: 110 }, (_, i) => [`t${i}`, { turnId: `t${i}`, status: 'completed', items: [{ type: 'userMessage', id: `i${i}`, content: [{ type: 'text', text: 'fixture' }] }] }]));
  const history = new SnapshotHistory({ turns: [], turnHistory: { kind: 'canonical', history: { islands: [{ entries: Object.keys(entities).map(value => ({ value })), olderBoundary: { status: 'exhausted' }, newerBoundary: { status: 'exhausted' } }], entitiesByKey: entities } } });
  assert.equal(history.page('turns').data[0].id, 't109');
  assert.equal(history.page('items').data[0].item.id, 'i0');
  assert.equal(history.page('items').data.length, 25);
  assert.equal(history.page('items', { limit: 0 }).data.length, 1);
  assert.equal(history.page('items', { limit: 1000 }).data.length, 100);
  assert.throws(() => history.page('items', { limit: -1 }), /page size/);
  const first = history.page('items');
  assert.equal(history.page('items', { cursor: first.nextCursor }).data[0].item.id, 'i25');
  const partial = structuredClone(history.state);
  partial.turnHistory.history.entitiesByKey.t0.itemsPagination = { hasLoadedOldest: false, evicted: true };
  assert.throws(() => new SnapshotHistory(partial), /every turn item/);
});

test('record-based Desktop completion flags finish an item before its turn', () => {
  const events = [], p = new DesktopEventProjector('thread', (method, params) => events.push({ method, params }));
  const state = { turns: [{ turnId: 'turn', status: 'inProgress', items: [{ type: 'agentMessage', id: 'item', text: 'fixture', phase: 'commentary' }], completedItemIds: {} }] };
  p.seed(state);
  const next = structuredClone(state); next.turns[0].completedItemIds.item = true;
  p.update(next);
  assert.deepEqual(events.map(event => event.method), ['item/completed']);
  for (const event of events) validateProtocol('ServerNotification', event);
});

test('accepted native steer identity maps once to a real user message', () => {
  const steering = { type: 'steeringUserMessage', status: 'accepted', serverUserMessageId: 'server-id', clientUserMessageId: 'client-id', input: [{ type: 'text', text: 'test', text_elements: [] }] };
  assert.equal(apiItems({ items: [steering] })[0].clientId, 'client-id');
  assert.equal(apiItems({ items: [steering, { type: 'userMessage', id: 'server-id', content: steering.input }] }).length, 1);
});

test('native message identity is preserved and uncertain Desktop delivery is never retried', async () => {
  const forwarded = [];
  const desktop = { status: { ready: true }, currentOwner: { clientId: 'original-owner' },
    state: { cwd: 'C:\\test', latestThreadSettings: { model: 'real-model' }, turns: [] },
    async requestFollower(method, params) { forwarded.push({ method, params }); return { result: { result: { turn: { id: 'accepted-turn' } } } }; },
  };
  const control = createDesktopController(desktop, 'thread');
  await control.call('turn/start', { threadId: 'thread', clientUserMessageId: 'native-client-id', input: [{ type: 'text', text: 'test' }] });
  assert.equal(forwarded[0].params.turnStart.request.clientUserMessageId, 'native-client-id');
  assert.equal(forwarded[0].params.conversationId, 'thread');
  desktop.requestFollower = async () => { forwarded.push('uncertain'); throw new Error('timeout'); };
  await assert.rejects(control.call('turn/start', { threadId: 'thread', input: [{ type: 'text', text: 'test' }] }), /unconfirmed/);
  assert.equal(forwarded.length, 2);
});

function isolatedBridgeFixtures(threadId) {
  const calls = [], writes = [];
  const state = { title: 'fixture', sessionId: threadId, cwd: 'C:\\fixture', threadRuntimeStatus: { type: 'idle' },
    latestThreadSettings: { model: 'fixture', modelProvider: 'fixture', cwd: 'C:\\fixture', disabledPluginIds: [], multiAgentMode: 'explicitRequestOnly' },
    currentPermissions: { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxPolicy: { type: 'readOnly' }, runtimeWorkspaceRoots: [] },
    turns: [], turnHistory: { kind: 'canonical', history: { islands: [{ entries: [], olderBoundary: { status: 'exhausted' }, newerBoundary: { status: 'exhausted' } }], entitiesByKey: {} } } };
  const metadata = { methods: calls, closed: false,
    async initialize() { calls.push('initialize'); return { userAgent: 'fixture' }; },
    async call(method, params) {
      calls.push(method);
      assert.equal(method, 'thread/read'); assert.equal(params.threadId, threadId);
      return { thread: { id: threadId, sessionId: threadId, cliVersion: 'fixture', createdAt: 1, updatedAt: 1, cwd: state.cwd,
        ephemeral: false, modelProvider: 'fixture', preview: '', projectId: null, source: 'cli', status: { type: 'idle' }, turns: [] } };
    },
    async close() { this.closed = true; },
  };
  const desktop = Object.assign(new EventEmitter(), { state, status: { phase: 'idle', ready: false }, currentOwner: { clientId: 'owner' }, completeLoads: 0, closed: false,
    async connect(id) { assert.equal(id, threadId); this.status = { phase: 'ready', ready: true }; this.emit('status', this.status); this.emit('state', this.state); },
    async ensureCompleteHistory() { this.completeLoads++; return this.state; },
    async requestFollower(method, params) { writes.push({ method, params }); return { result: { result: { turn: { id: 'real-turn' } } } }; },
    close() { this.closed = true; },
  });
  return { desktop, metadata, writes, factories: { createMetadataReader: () => metadata, createDesktopClient: () => desktop } };
}

let requestSequence = 0;
async function rpc(socket, method, params) {
  const id = ++requestSequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('message', receive); reject(new Error('Fixture RPC timed out.')); }, 3000);
    const receive = bytes => { const message = JSON.parse(bytes); if (message.id === id) { clearTimeout(timer); socket.off('message', receive); resolve(message); } };
    socket.on('message', receive); socket.send(JSON.stringify({ id, method, params }));
  });
}

async function rejectedUpgrade(endpoint, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint, { headers });
    socket.on('error', () => {});
    socket.once('open', () => { socket.terminate(); reject(new Error('Unauthorized connection was accepted.')); });
    socket.once('unexpected-response', (_request, response) => { response.resume(); socket.terminate(); resolve(response.statusCode); });
  });
}

test('selected GUID attachment uses the original owner and rejects another chat', { timeout: 10000 }, async () => {
  assert.equal(validThreadId('../thread'), false);
  await assert.rejects(createNativeCliBridge({ threadId: 'not-a-guid' }), /valid selected chat ID/);
  for (const threadId of ['00000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111']) {
    const fixtures = isolatedBridgeFixtures(threadId), states = [], statuses = [], errors = [];
    const bridge = await createNativeCliBridge({ threadId, onState: state => states.push(state), onStatus: status => statuses.push(status), onError: error => errors.push(error) }, fixtures.factories);
    try {
      assert.equal(bridge.state, fixtures.desktop.state); assert.equal(bridge.status.ready, true);
      assert.equal(states.length, 1); assert.equal(statuses.length, 1); assert.equal(fixtures.desktop.completeLoads, 1);
      const socket = new WebSocket(bridge.endpoint, { headers: { Authorization: `Bearer ${bridge.token}` } });
      await once(socket, 'open');
      await rpc(socket, 'initialize', {});
      const wrong = await rpc(socket, 'thread/read', { threadId: '22222222-2222-7222-8222-222222222222' });
      assert.equal(wrong.error.code, -32602);
      const unsupported = await rpc(socket, 'plugin/list', {});
      assert.equal(unsupported.error.code, -32601); assert.equal(errors.length, 0);
      const resumed = await rpc(socket, 'thread/resume', { threadId });
      assert.equal(resumed.result.thread.id, threadId); assert.equal(fixtures.desktop.completeLoads, 2);
      const sent = await rpc(socket, 'turn/start', { threadId, input: [{ type: 'text', text: 'fixture' }], clientUserMessageId: 'client-fixture' });
      assert.equal(sent.result.turn.id, 'real-turn');
      assert.equal(fixtures.writes[0].params.conversationId, threadId);
      assert.equal(fixtures.writes[0].params.turnStart.request.clientUserMessageId, 'client-fixture');
      assert.deepEqual(fixtures.metadata.methods, ['initialize', 'thread/read', 'thread/read']);
      socket.close(); await once(socket, 'close');
    } finally { await bridge.close(); }
    assert.equal(fixtures.desktop.closed, true); assert.equal(fixtures.metadata.closed, true);
  }
});

test('loopback WebSocket requires its token, disallows browser origins and allows one client', { timeout: 10000 }, async () => {
  const threadId = '00000000-0000-7000-8000-000000000002', fixtures = isolatedBridgeFixtures(threadId);
  const bridge = await createNativeCliBridge({ threadId }, fixtures.factories);
  try {
    assert.equal(new URL(bridge.endpoint).hostname, '127.0.0.1');
    assert.equal(await rejectedUpgrade(bridge.endpoint), 401);
    assert.equal(await rejectedUpgrade(bridge.endpoint, { Authorization: 'Bearer incorrect' }), 401);
    assert.equal(await rejectedUpgrade(bridge.endpoint, { Authorization: `Bearer ${bridge.token}`, Origin: 'https://example.invalid' }), 401);
    assert.equal(await rejectedUpgrade(`${bridge.endpoint}/other`, { Authorization: `Bearer ${bridge.token}` }), 401);
    const socket = new WebSocket(bridge.endpoint, { headers: { Authorization: `Bearer ${bridge.token}` } });
    await once(socket, 'open');
    assert.equal(await rejectedUpgrade(bridge.endpoint, { Authorization: `Bearer ${bridge.token}` }), 401);
    socket.close(); await once(socket, 'close');
  } finally { await bridge.close(); }
});

test('abort during initialization closes only the adapter dependencies', { timeout: 5000 }, async () => {
  const threadId = '00000000-0000-7000-8000-000000000003', fixtures = isolatedBridgeFixtures(threadId), controller = new AbortController();
  let rejectInitialize;
  fixtures.metadata.initialize = () => new Promise((_resolve, reject) => { rejectInitialize = reject; });
  fixtures.metadata.close = async function () { this.closed = true; rejectInitialize?.(new Error('closed')); };
  const starting = createNativeCliBridge({ threadId, signal: controller.signal }, fixtures.factories);
  controller.abort();
  await assert.rejects(starting, /closed|cancelled/);
  assert.equal(fixtures.desktop.closed, true); assert.equal(fixtures.metadata.closed, true);
  await assert.rejects(createNativeCliBridge({ threadId, signal: controller.signal }), /cancelled/);
});

test('a lost Desktop owner closes the client and never retries a write', { timeout: 5000 }, async () => {
  const threadId = '00000000-0000-7000-8000-000000000004', fixtures = isolatedBridgeFixtures(threadId);
  const bridge = await createNativeCliBridge({ threadId }, fixtures.factories);
  try {
    const socket = new WebSocket(bridge.endpoint, { headers: { Authorization: `Bearer ${bridge.token}` } });
    await once(socket, 'open'); await rpc(socket, 'initialize', {}); await rpc(socket, 'thread/resume', { threadId });
    const closed = once(socket, 'close');
    fixtures.desktop.status = { phase: 'owner-unavailable', ready: false }; fixtures.desktop.emit('status', fixtures.desktop.status);
    await closed;
    assert.equal(bridge.evidence.ownerUnchanged, false); assert.equal(fixtures.writes.length, 0);
    assert.equal(await rejectedUpgrade(bridge.endpoint, { Authorization: `Bearer ${bridge.token}` }), 401);
  } finally { await bridge.close(); }
});
