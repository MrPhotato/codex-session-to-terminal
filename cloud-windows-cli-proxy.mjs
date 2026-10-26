import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { validateProtocol } from './protocol-validation.mjs';
import { validCloudSkillsListParams } from './cloud-native-cli-bridge.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
const threadIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const namespacePattern = /^\\\\\?\\CST-CLOUD-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REMOTE_CWD_BYTES = 4096;
const simplePosixCwd = /^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+$/;
const reservedWindowsComponent = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
// Full native history can exceed a request-sized frame. Match DesktopIpcClient's
// supported receive limit; the client-facing request limit stays small.
const MAX_UPSTREAM_FRAME_BYTES = 256 * 1024 * 1024;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
// A single complete history frame gets its own allowance only on an empty
// socket. The small extra margin covers the explicit cwd encoding overhead.
const MAX_LARGE_RESPONSE_BYTES = MAX_UPSTREAM_FRAME_BYTES + MAX_BUFFERED_BYTES;
const fail = (message, code = 'UNSUPPORTED_CLOUD_PROJECTION') => { throw Object.assign(new Error(message), { code }); };
const methodParams = new Map([
  ['initialize', ['clientInfo', 'capabilities']], ['account/read', ['refreshToken']],
  ['model/list', ['cursor', 'limit', 'includeHidden']], ['configRequirements/read', []],
  ['skills/list', ['cwds', 'forceReload']],
  ['thread/read', ['threadId', 'includeTurns']], ['thread/resume', ['threadId', 'excludeTurns', 'initialTurnsPage']],
  ['thread/loaded/list', ['cursor', 'limit']], ['thread/turns/list', ['threadId', 'cursor', 'limit', 'sortDirection', 'itemsView']],
  ['thread/items/list', ['threadId', 'turnId', 'cursor', 'limit', 'sortDirection']], ['thread/unsubscribe', ['threadId']],
]);
const itemFields = {
  userMessage: ['type', 'id', 'clientId', 'content'],
  fileChange: ['type', 'id', 'changes', 'status'],
  imageView: ['type', 'id', 'path'],
  agentMessage: ['type', 'id', 'text', 'phase', 'delivery', 'memoryCitation', 'questions'],
  reasoning: ['type', 'id', 'summary', 'content'], contextCompaction: ['type', 'id', 'completed', 'source'],
  commandExecution: ['type', 'id', 'command', 'commandActions', 'cwd', 'status', 'aggregatedOutput', 'durationMs',
    'exitCode', 'pluginId', 'processId', 'scriptPath', 'source'],
  plan: ['type', 'id', 'text'], sleep: ['type', 'id', 'durationMs'],
  functionCallOutput: ['type', 'id', 'name', 'namespace', 'output'],
  mcpToolCall: ['type', 'id', 'server', 'tool', 'arguments', 'status', 'result', 'error', 'durationMs',
    'appContext', 'mcpAppResourceUri', 'mcpAppUi', 'pluginId', 'readOnlyHint'],
  dynamicToolCall: ['type', 'id', 'namespace', 'tool', 'arguments', 'status', 'contentItems', 'success', 'durationMs'],
  webSearch: ['type', 'id', 'query', 'action', 'results'],
  subAgentActivity: ['type', 'id', 'agentPath', 'agentThreadId', 'kind', 'model', 'reasoningEffort'],
  collabAgentToolCall: ['type', 'id', 'tool', 'status', 'senderThreadId', 'receiverThreadIds', 'prompt', 'model', 'reasoningEffort', 'agentsStates', 'receiverThreads'],
};
const passthroughEvents = new Set(['thread/status/changed', 'thread/name/updated', 'thread/tokenUsage/updated',
  'item/agentMessage/delta', 'item/commandExecution/outputDelta', 'item/reasoning/textDelta',
  'item/reasoning/summaryTextDelta', 'item/reasoning/summaryPartAdded', 'item/plan/delta',
  'item/mcpToolCall/progress', 'warning', 'error']);
const onlyFields = (value, fields) => object(value) && Object.keys(value).every(key => fields.includes(key));
const cloudDisplayPath = value => typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') &&
  value.isWellFormed() && Buffer.byteLength(value, 'utf8') <= 4096 && !/[\\\u0000-\u001f\u007f-\u009f]/u.test(value);
const textOutputs = (values, type) => Array.isArray(values) && values.every(value =>
  onlyFields(value, ['type', 'text']) && value.type === type && typeof value.text === 'string');
const mcpTextContent = values => Array.isArray(values) && values.every(value => {
  if (!onlyFields(value, ['type', 'text', 'annotations', '_meta']) || value.type !== 'text' || typeof value.text !== 'string') return false;
  if (value._meta != null && !object(value._meta)) return false;
  const a = value.annotations;
  return a == null || onlyFields(a, ['audience', 'priority', 'lastModified']) &&
    (a.audience === undefined || Array.isArray(a.audience) && a.audience.every(role => ['user', 'assistant'].includes(role))) &&
    (a.priority === undefined || typeof a.priority === 'number' && Number.isFinite(a.priority) && a.priority >= 0 && a.priority <= 1) &&
    (a.lastModified === undefined || typeof a.lastModified === 'string');
});

function checkItem(item, turnId) {
  const fields = object(item) && Object.hasOwn(itemFields, item.type) ? itemFields[item.type] : null;
  if (!fields || !validId(item.id) || Object.keys(item).some(key => !fields.includes(key))) {
    fail('This cloud history item is outside the supported read-only display contract.');
  }
  if (item.type === 'contextCompaction') {
    // Desktop attaches lifecycle/display metadata to the official marker.
    // The CLI wire item has only id/type; lifecycle is carried by its existing
    // item/started and item/completed events. Keep the marker in all histories.
    if (Object.hasOwn(item, 'completed') && typeof item.completed !== 'boolean' ||
        Object.hasOwn(item, 'source') && (typeof item.source !== 'string' || !item.source.length ||
          item.source.length > 64 || /[\u0000-\u001f\u007f-\u009f]/u.test(item.source))) {
      fail('The Desktop context compaction metadata is malformed.');
    }
    delete item.completed;
    delete item.source;
  }
  if (item.type === 'collabAgentToolCall' && Object.hasOwn(item, 'receiverThreads')) {
    // Desktop adds a cache of loaded child threads to the official wire item.
    // Keep the actual collaboration record and IDs; do not expose that cache
    // (which may include another chat's history) to the CLI.
    if (!Array.isArray(item.receiverThreads) || !Array.isArray(item.receiverThreadIds) ||
        item.receiverThreads.some(entry => !onlyFields(entry, ['threadId', 'thread']) ||
          !item.receiverThreadIds.includes(entry.threadId) ||
          entry.thread !== null && (!object(entry.thread) || entry.thread.id !== entry.threadId)) ||
        new Set(item.receiverThreads.map(entry => entry.threadId)).size !== item.receiverThreads.length) {
      fail('The Desktop child-thread display cache is malformed.');
    }
    delete item.receiverThreads;
  }
  if (item.type === 'userMessage' && Array.isArray(item.content)) {
    item.content = item.content.map(value => {
      if (value?.type !== 'image') return value;
      if (!onlyFields(value, ['type', 'url', 'detail']) || typeof value.url !== 'string' || !value.url ||
          value.detail != null && !['auto', 'low', 'high', 'original'].includes(value.detail)) fail('The cloud image input is malformed.');
      // The Windows CLI cannot open a cloud attachment. Show an explicit text
      // placeholder; never pass its URL/data to the CLI or fetch it locally.
      return { type: 'text', text: /^zh\b/i.test(Intl.DateTimeFormat().resolvedOptions().locale)
        ? '[图片：请在 ChatGPT 中查看]' : '[Image: view in ChatGPT]' };
    });
  }
  if (item.type === 'userMessage' && (!Array.isArray(item.content) || item.content.some(value =>
    !object(value) || value.type !== 'text' || typeof value.text !== 'string' ||
    Object.keys(value).some(key => !['type', 'text', 'text_elements'].includes(key))))) {
    fail('File, image and unknown inputs are outside this attachment.');
  }
  if (item.type === 'agentMessage' && typeof item.text !== 'string') fail('An agent message is incomplete.');
  // Pinned Windows CLI renders these history records from supplied text only:
  // fileChange displays the supplied diff; imageView displays a path label. No
  // cloud image is downloaded or mapped to a local file. Body link interaction
  // remains disabled by the read-only terminal wrapper.
  if (item.type === 'imageView' && !cloudDisplayPath(item.path)) fail('Only cloud path labels are supported for viewed images.');
  if (item.type === 'fileChange' && (!Array.isArray(item.changes) || item.changes.some(change =>
    !onlyFields(change, ['path', 'kind', 'diff']) || !cloudDisplayPath(change.path) || typeof change.diff !== 'string' ||
    !onlyFields(change.kind, ['type', 'move_path']) ||
    change.kind.move_path != null && (change.kind.type !== 'update' || !cloudDisplayPath(change.kind.move_path))))) {
    fail('Only supplied cloud file-change text is supported.');
  }
  if (item.type === 'commandExecution' && (typeof item.command !== 'string' || typeof item.cwd !== 'string')) {
    fail('A command-display item is incomplete.');
  }
  if (item.type === 'functionCallOutput' && typeof item.output !== 'string' && !textOutputs(item.output, 'input_text') ||
    item.type === 'dynamicToolCall' && item.contentItems != null && !textOutputs(item.contentItems, 'inputText')) {
    fail('Only text tool output is supported; image, audio and resource output is unavailable in this terminal.');
  }
  if (item.type === 'mcpToolCall') {
    if (item.mcpAppUi != null || item.mcpAppResourceUri != null || item.appContext?.resourceUri != null ||
      item.appContext != null && !onlyFields(item.appContext, ['actionName', 'appName', 'connectorId', 'linkId', 'resourceUri']) ||
      item.error != null && !onlyFields(item.error, ['message']) ||
      item.result != null && (!onlyFields(item.result, ['content', 'structuredContent', '_meta']) || !mcpTextContent(item.result.content))) {
      fail('Only text MCP output is supported; app, image, audio and resource output is unavailable in this terminal.');
    }
  }
  // Validate the real item and turn ID using the bundled official item schema.
  // This envelope is local validation only; no extra item or event is emitted.
  validateProtocol('v2/ThreadItemsListResponse', { data: [{ turnId, item }] });
}
function checkTurn(turn) {
  if (!object(turn) || !validId(turn.id) || !Array.isArray(turn.items)) fail('A native turn is incomplete.');
  turn.items.forEach(item => checkItem(item, turn.id));
}
function checkPermissions(sandbox, profile) {
  if (!object(sandbox) || !['dangerFullAccess', 'readOnly', 'externalSandbox'].includes(sandbox.type) || profile != null ||
    Object.keys(sandbox).some(key => !(sandbox.type === 'dangerFullAccess' ? ['type'] : ['type', 'networkAccess']).includes(key))) {
    fail('Filesystem permission and named-profile projections are outside this attachment.');
  }
}

/** Exact, reversible bound protocol encoding of one POSIX cwd. This is not a local
 * workspace, filesystem mapping, drive or mount. Never use encodedCwd for IO.
 * Text, command cwd strings, models, permissions and identities are not rewritten.
 */
export function createCloudWindowsPathProjection({ threadId, remoteCwd, namespace } = {}) {
  if (!threadIdPattern.test(threadId ?? '') || !namespacePattern.test(namespace ?? '') ||
    typeof remoteCwd !== 'string' || !remoteCwd.startsWith('/') || remoteCwd.length > MAX_REMOTE_CWD_BYTES ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(remoteCwd) || Buffer.byteLength(remoteCwd, 'utf8') > MAX_REMOTE_CWD_BYTES ||
    Buffer.from(remoteCwd, 'utf8').toString('utf8') !== remoteCwd) {
    fail('A bound chat, valid absolute POSIX cwd of at most 4096 UTF-8 bytes and reserved namespace are required.');
  }
  // Keep existing simple paths readable. All other spellings use one bounded
  // alias, including POSIX components containing Windows path punctuation,
  // Unicode, dot segments, empty segments or device names. Never normalize the
  // input: only the exact bound alias can decode to the exact original string.
  // The digest is a wire label, not a directory or an independently resolvable
  // location. The '~' keeps aliases distinct from preserved simple spellings.
  // No filesystem operation is performed on either spelling here.
  const keepSimpleSpelling = simplePosixCwd.test(remoteCwd) && remoteCwd.slice(1).split('/').every(component =>
    component.length <= 255 && !reservedWindowsComponent.test(component));
  const suffix = keepSimpleSpelling ? remoteCwd.slice(1).replaceAll('/', '\\')
    : `cwd~${createHash('sha256').update(remoteCwd, 'utf8').digest('hex')}`;
  const encodedCwd = `${namespace}\\${suffix}`;
  const encodePath = value => { if (value !== remoteCwd) fail('The remote cwd changed or an additional path was exposed.'); return encodedCwd; };
  const decodePath = value => { if (value !== encodedCwd) fail('The path is not the exact bound cloud cwd encoding.'); return remoteCwd; };
  const checkThread = thread => {
    if (!object(thread) || thread.id !== threadId || thread.path != null || !Array.isArray(thread.turns)) {
      fail('The thread identity, rollout path or history is outside this attachment.');
    }
    thread.cwd = encodePath(thread.cwd);
    thread.turns.forEach(checkTurn);
  };
  const projectResponse = (method, source) => {
    if (!object(source)) fail('The upstream response is incomplete.');
    const result = structuredClone(source);
    if (method === 'thread/read' || method === 'thread/resume') checkThread(result.thread);
    if (method === 'thread/resume') {
      result.cwd = encodePath(result.cwd);
      if (result.runtimeWorkspaceRoots != null) {
        if (!Array.isArray(result.runtimeWorkspaceRoots)) fail('Runtime workspace roots are incomplete.');
        result.runtimeWorkspaceRoots = result.runtimeWorkspaceRoots.map(encodePath);
      }
      checkPermissions(result.sandbox, result.activePermissionProfile);
      validateProtocol('v2/ThreadResumeResponse', result);
    }
    if (method === 'thread/turns/list') {
      validateProtocol('v2/ThreadTurnsListResponse', result);
      result.data.forEach(checkTurn);
    }
    if (method === 'thread/items/list') {
      validateProtocol('v2/ThreadItemsListResponse', result);
      result.data.forEach(entry => checkItem(entry.item, entry.turnId));
    }
    if (method === 'skills/list' && (!onlyFields(result, ['data']) || !Array.isArray(result.data) || result.data.length)) {
      fail('The read-only terminal skill catalog must be empty.');
    }
    if (method === 'thread/loaded/list' && (!Array.isArray(result.data) || result.data.some(id => id !== threadId))) {
      fail('An unbound chat appeared in the loaded list.');
    }
    return result;
  };
  const projectNotification = source => {
    const notification = structuredClone(source), { method, params } = notification;
    if (!object(params) || (method === 'warning' ? params.threadId != null && params.threadId !== threadId : params.threadId !== threadId)) {
      fail('An upstream notification did not identify the bound chat.');
    }
    if (['item/started', 'item/completed'].includes(method)) checkItem(params.item, params.turnId);
    else if (['turn/started', 'turn/completed'].includes(method)) checkTurn(params.turn);
    else if (method === 'thread/settings/updated') {
      const settings = params.threadSettings;
      if (!object(settings)) fail('Updated thread settings are incomplete.');
      settings.cwd = encodePath(settings.cwd);
      checkPermissions(settings.sandboxPolicy, settings.activePermissionProfile);
    } else if (!passthroughEvents.has(method)) fail('An unsupported upstream notification appeared.');
    if (['item/plan/delta', 'item/mcpToolCall/progress'].includes(method) &&
      !onlyFields(params, ['threadId', 'turnId', 'itemId', method === 'item/plan/delta' ? 'delta' : 'message'])) {
      fail('An unsupported field appeared in a tool display update.');
    }
    return validateProtocol('ServerNotification', notification);
  };
  return Object.freeze({ threadId, remoteCwd, namespace, encodedCwd, encodePath, decodePath, projectResponse, projectNotification });
}

async function verifyUnusedNamespace(deviceName, powershellPath) {
  if (!validId(powershellPath)) fail('A PowerShell executable is required for the read-only namespace check.');
  // deviceName is generated here, never caller data. Query only: no device is
  // registered and no alias directory is created. Error 2 means not registered.
  const script = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class CstDeviceProbe { [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint QueryDosDevice(string name, System.Text.StringBuilder target, int length); }'; $buffer = New-Object System.Text.StringBuilder 32768; $result = [CstDeviceProbe]::QueryDosDevice('${deviceName}', $buffer, $buffer.Capacity); $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error(); if ($result -ne 0 -or $code -ne 2) { throw 'The cloud namespace is not available.' }; Write-Output 'UNREGISTERED'`;
  const { stdout } = await promisify(execFile)(powershellPath, ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 15000, maxBuffer: 16384 });
  return stdout.trim() === 'UNREGISTERED';
}

/** Experimental Windows adapter for an existing read-only durable bridge.
 * Owns only its sockets, not bridge lifecycle. Factories are an isolated-test
 * seam. Observation and history reads are the only supported operations.
 */
export async function createCloudWindowsCliProxy(options = {}, factories = {}) {
  // Fail before the namespace probe or sockets are opened, even when an old
  // caller supplies an undefined callback property rather than a function.
  if (options.allowInterrupt !== undefined && options.allowInterrupt !== false || Object.hasOwn(options, 'interruptControl')) {
    fail('Cloud terminal attachments are strictly read-only.', 'READ_ONLY_REQUIRED');
  }
  const { bridge, powershellPath, signal, onError } = options;
  if ((factories.platform ?? process.platform) !== 'win32' || bridge?.manifest?.readonly !== true || bridge?.state?.hostId !== 'durable') {
    fail('A read-only durable bridge on Windows is required.');
  }
  let upstreamUrl;
  try { upstreamUrl = new URL(bridge.endpoint); } catch { fail('Invalid upstream loopback endpoint.'); }
  if (upstreamUrl.protocol !== 'ws:' || upstreamUrl.hostname !== '127.0.0.1' || !upstreamUrl.port ||
    upstreamUrl.username || upstreamUrl.password || upstreamUrl.pathname !== '/' || upstreamUrl.search || upstreamUrl.hash ||
    typeof bridge.token !== 'string' || !/^[a-f0-9]{64}$/i.test(bridge.token)) fail('Only an authenticated loopback bridge is supported.');
  const threadId = bridge.state.id, remoteCwd = bridge.state.latestThreadSettings?.cwd;
  const deviceName = `CST-CLOUD-${randomUUID()}`;
  const projection = createCloudWindowsPathProjection({ threadId, remoteCwd, namespace: `\\\\?\\${deviceName}` });
  const checkBinding = () => {
    if (signal?.aborted) fail('The attachment was cancelled.', 'ABORTED');
    if (bridge.manifest?.readonly !== true || bridge.status?.ready !== true || bridge.state?.hostId !== 'durable' ||
      bridge.state.id !== threadId || bridge.state.latestThreadSettings?.cwd !== remoteCwd) fail('The original cloud binding is no longer ready.', 'BINDING_CHANGED');
  };
  checkBinding();
  if (await (factories.verifyUnusedNamespace ?? verifyUnusedNamespace)(deviceName, powershellPath) !== true) {
    fail('The cloud namespace could not be verified as unregistered.');
  }
  checkBinding();
  const token = randomBytes(32).toString('hex');
  const records = { methods: Object.create(null), responses: Object.create(null), rejected: Object.create(null), notifications: Object.create(null),
    interruptEnabled: false, namespaceUnregisteredAtStart: true, remoteCwd, encodedCwd: projection.encodedCwd,
    peakUpstreamBufferedBytes: 0, peakDownstreamBufferedBytes: 0 };
  const count = (group, method) => { group[method] = (group[method] ?? 0) + 1; };
  const server = createServer((_request, response) => { response.writeHead(404); response.end(); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const sockets = new Set(), upstreams = new Set();
  let closed = false, closing;
  const close = () => closing ??= (async () => {
    closed = true; signal?.removeEventListener('abort', abort);
    for (const socket of sockets) socket.terminate();
    for (const socket of upstreams) socket.terminate();
    wss.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  })();
  const abort = () => { void close(); };
  server.on('upgrade', (request, socket, head) => {
    const expected = Buffer.from(`Bearer ${token}`), received = Buffer.from(request.headers.authorization ?? '');
    let bound = true; try { checkBinding(); } catch { bound = false; }
    if (closed || !bound || request.headers.origin !== undefined || request.url !== '/' || sockets.size ||
      received.length !== expected.length || !timingSafeEqual(received, expected)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return;
    }
    wss.handleUpgrade(request, socket, head, websocket => wss.emit('connection', websocket));
  });
  wss.on('connection', socket => {
    sockets.add(socket);
    const upstream = new WebSocket(upstreamUrl, { headers: { Authorization: `Bearer ${bridge.token}` }, maxPayload: MAX_UPSTREAM_FRAME_BYTES });
    upstreams.add(upstream);
    const pending = new Map(), queued = [];
    let initialized = false, resumed = false, queuedBytes = 0, largeResponseBytes = 0, disconnected = false;
    const disconnectForBufferLimit = direction => {
      if (disconnected) return;
      disconnected = true; records.disconnectReason = 'buffer-limit-exceeded'; records.bufferLimitExceeded = direction;
      queued.length = 0; queuedBytes = 0; pending.clear();
      // A close handshake itself can sit behind the blocked data. Terminate
      // both sockets to release that queue; never drop an event and continue.
      socket.terminate(); upstream.terminate();
    };
    const forward = (value, bytes) => {
      if (disconnected) return;
      if (upstream.readyState === WebSocket.CONNECTING) {
        if (queuedBytes + bytes > MAX_BUFFERED_BYTES) { disconnectForBufferLimit('upstream'); return; }
        queued.push({ value, bytes }); queuedBytes += bytes;
        records.peakUpstreamBufferedBytes = Math.max(records.peakUpstreamBufferedBytes, queuedBytes);
      } else if (upstream.readyState === WebSocket.OPEN) {
        if (upstream.bufferedAmount + bytes > MAX_BUFFERED_BYTES) { disconnectForBufferLimit('upstream'); return; }
        upstream.send(value, error => { if (error) { socket.terminate(); upstream.terminate(); } });
        records.peakUpstreamBufferedBytes = Math.max(records.peakUpstreamBufferedBytes, upstream.bufferedAmount);
      }
    };
    const send = value => {
      if (disconnected || socket.readyState !== WebSocket.OPEN) return;
      const encoded = JSON.stringify(value), bytes = Buffer.byteLength(encoded) + 14;
      const large = bytes > MAX_BUFFERED_BYTES;
      if (large && (largeResponseBytes || socket.bufferedAmount || bytes > MAX_LARGE_RESPONSE_BYTES) ||
        !large && socket.bufferedAmount + bytes > MAX_BUFFERED_BYTES + largeResponseBytes) {
        disconnectForBufferLimit('downstream'); return;
      }
      if (large) largeResponseBytes = bytes;
      socket.send(encoded, error => {
        if (large) largeResponseBytes = 0;
        if (error) { socket.terminate(); upstream.terminate(); }
      });
      records.peakDownstreamBufferedBytes = Math.max(records.peakDownstreamBufferedBytes, socket.bufferedAmount);
    };
    const reject = (id, method, message, code = -32601) => {
      count(records.rejected, methodParams.has(method) || method === 'turn/interrupt' ? method : 'unsupported');
      send({ id, error: { code, message } });
    };
    const stop = () => {
      records.projectionFailed = true;
      socket.close(1011, 'This cloud attachment cannot safely represent the upstream state.'); upstream.terminate();
      // The CLI may exit before showing a WebSocket close reason. Notify the
      // owning wrapper so it can retain a localized, content-free explanation.
      try { onError?.(Object.assign(new Error('Unsupported cloud display format.'), { code: 'UNSUPPORTED_CLOUD_PROJECTION' })); } catch {}
    };
    upstream.on('open', () => {
      const buffered = queued.splice(0); queuedBytes = 0;
      for (const { value, bytes } of buffered) forward(value, bytes);
    });
    socket.on('error', () => {});
    socket.on('message', async bytes => {
      if (disconnected || closed) return;
      let request;
      try { request = JSON.parse(bytes); } catch { socket.close(1007); return; }
      if (!object(request)) { socket.close(1008); return; }
      if (request.id === undefined && request.method === 'initialized' && initialized) return;
      if (!(validId(request.id) || Number.isSafeInteger(request.id)) || typeof request.method !== 'string' ||
        Object.keys(request).some(key => !['jsonrpc', 'id', 'method', 'params'].includes(key))) { socket.close(1008); return; }
      const { id, method } = request;
      if (pending.has(id)) { socket.close(1008, 'Duplicate request ID.'); return; }
      count(records.methods, methodParams.has(method) || method === 'turn/interrupt' ? method : 'unsupported');
      try { checkBinding(); } catch { reject(id, method, 'The original cloud binding is no longer ready.', -32000); return; }
      if (method !== 'initialize' && !initialized) { reject(id, method, 'Initialize this attachment first.', -32600); return; }
      const params = request.params ?? {};
      if (!object(params)) { reject(id, method, 'Invalid request parameters.', -32602); return; }
      const allowed = methodParams.get(method);
      if (!allowed) { reject(id, method, 'This attachment does not support that operation. Continue in Desktop.'); return; }
      if (method === 'skills/list' && !validCloudSkillsListParams(Object.hasOwn(request, 'params') ? request.params : params)) {
        reject(id, method, 'Invalid read-only skill catalog parameters.', -32602); return;
      }
      // CLI serializes absent resume overrides as null. Strip those; no setting
      // override, path alias or new optional operation reaches the upstream.
      if (Object.entries(params).some(([key, value]) => !allowed.includes(key) && value != null) ||
        (method.startsWith('thread/') && method !== 'thread/loaded/list' && params.threadId !== threadId) ||
        (method === 'account/read' && params.refreshToken === true)) {
        reject(id, method, 'Changing settings or accessing another chat is unavailable.', -32602); return;
      }
      if (method === 'initialize' && (initialized || [...pending.values()].includes('initialize'))) {
        reject(id, method, 'This attachment is already initializing or initialized.', -32600); return;
      }
      if (pending.size >= 64) { reject(id, method, 'Too many pending read requests.', -32000); return; }
      const forwarded = { id, method, params: Object.fromEntries(Object.entries(params).filter(([key]) => allowed.includes(key))) };
      if (method === 'account/read') forwarded.params.refreshToken = false;
      if (method === 'skills/list') forwarded.params.forceReload = false;
      pending.set(id, method);
      const value = JSON.stringify(forwarded);
      if ([WebSocket.OPEN, WebSocket.CONNECTING].includes(upstream.readyState)) forward(value, Buffer.byteLength(value) + 14);
      else { pending.delete(id); reject(id, method, 'The upstream connection is closed.', -32000); }
    });
    upstream.on('message', bytes => {
      if (disconnected || closed) return;
      try {
        checkBinding();
        const response = JSON.parse(bytes);
        if (!object(response)) fail('Invalid upstream message.');
        if (response.id !== undefined) {
          const method = pending.get(response.id);
          if (!method || response.method !== undefined ||
            Object.hasOwn(response, 'result') === Object.hasOwn(response, 'error')) fail('Uncorrelated upstream response.');
          pending.delete(response.id);
          if (Object.hasOwn(response, 'result')) {
            response.result = projection.projectResponse(method, response.result);
            if (method === 'initialize') initialized = true;
            if (method === 'thread/resume') resumed = true;
            if (method === 'thread/unsubscribe') resumed = false;
          }
          count(records.responses, method); send(response);
        } else {
          if (!resumed) fail('A notification arrived before the bound resume.');
          const projected = projection.projectNotification(response);
          count(records.notifications, projected.method); send(projected);
        }
      } catch { stop(); }
    });
    upstream.on('error', () => socket.close(1011, 'The upstream cloud reader disconnected.'));
    upstream.on('close', () => { upstreams.delete(upstream); socket.close(); });
    socket.on('close', () => { sockets.delete(socket); queued.length = 0; queuedBytes = 0; pending.clear(); upstream.terminate(); });
  });
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); checkBinding();
    signal?.addEventListener('abort', abort, { once: true });
  } catch (cause) { await close(); throw cause; }
  return { endpoint: `ws://127.0.0.1:${server.address().port}`, token, close, records,
    get state() { return bridge.state; }, get status() { return bridge.status; },
    manifest: Object.freeze({ experimental: true, readonly: true, hostId: 'durable',
      observe: true, send: false, steer: false, queue: false, interrupt: false, filesystem: false,
      allowedControls: Object.freeze([]),
      pathEncoding: 'Exact cloud cwd only; not a Windows workspace, drive, share or mount.',
      localFilesystem: 'No namespace is created. Native CLI filesystem probes may fail against this unregistered encoding.',
      skills: 'Empty catalog describes this read-only terminal, not the cloud executor; no skill files are read or refreshed.',
      buffering: Object.freeze({ queuedBytesPerDirection: MAX_BUFFERED_BYTES, singleLargeResponseBytes: MAX_LARGE_RESPONSE_BYTES,
        overflow: 'Disconnect both sockets; no truncation, event dropping or retry.' }),
      lifecycle: 'Closing the proxy leaves the caller-owned cloud bridge running.' }) };
}
