import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createMetadataReader, METADATA_METHODS } from './readonly-metadata.mjs';
import { DesktopIpcClient } from './desktop-ipc.mjs';
import { verifiedDesktopTransport } from './cst-transport.mjs';
import { DesktopEventProjector } from './desktop-events.mjs';
import { createDesktopController } from './desktop-control.mjs';
import { SnapshotHistory } from './snapshot-history.mjs';
import { validateProtocol } from './protocol-validation.mjs';

const error = (message, rpcCode = -32601, code = 'UNSUPPORTED_NATIVE_COMMAND') => Object.assign(new Error(message), { code, rpcError: { code: rpcCode, message } });
export const validThreadId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

function required(value, key) {
  if (value === undefined || value === null || value === '') throw error(`The current Desktop snapshot has no ${key}; terminal attachment cannot continue.`, -32000, 'INCOMPLETE_STATE');
  return value;
}

// Project only authoritative, live Desktop execution settings. No defaults that
// could imply permissions the Desktop does not actually use.
export function resumeFromLiveSnapshot(metadata, state) {
  const settings = required(state.latestThreadSettings, 'thread settings');
  const permissions = required(state.currentPermissions, 'current permissions');
  const thread = { ...metadata.thread, name: state.title ?? metadata.thread.name,
    sessionId: required(state.sessionId, 'session ID'),
    status: required(state.threadRuntimeStatus, 'runtime status'),
    model: required(settings.model ?? state.latestModel, 'model'),
    modelProvider: required(settings.modelProvider ?? state.modelProvider, 'model provider'),
    cwd: required(settings.cwd ?? state.cwd, 'working directory'),
  };
  return {
    thread,
    model: thread.model,
    modelProvider: thread.modelProvider,
    cwd: thread.cwd,
    approvalPolicy: required(permissions.approvalPolicy ?? settings.approvalPolicy, 'approval policy'),
    approvalsReviewer: required(permissions.approvalsReviewer ?? settings.approvalsReviewer, 'approval reviewer'),
    sandbox: required(permissions.sandboxPolicy ?? settings.sandboxPolicy, 'sandbox policy'),
    activePermissionProfile: permissions.activePermissionProfile ?? settings.activePermissionProfile ?? null,
    runtimeWorkspaceRoots: permissions.runtimeWorkspaceRoots ?? null,
    disabledPluginIds: settings.disabledPluginIds ?? null,
    serviceTier: settings.serviceTier ?? null,
    reasoningEffort: settings.effort ?? state.latestReasoningEffort ?? null,
    collaborationMode: settings.collaborationMode ?? state.latestCollaborationMode ?? null,
    multiAgentMode: settings.multiAgentMode ?? null,
    turnsBackwardsCursor: null,
    itemsBackwardsCursor: null,
  };
}

// The optional factories are an isolated-test seam; normal callers use only
// the public options and the verified Desktop transport.
export async function createNativeCliBridge({ backendPath, powershellPath, threadId, allowControl = true,
  onState, onStatus, onError, signal } = {}, factories = {}) {
  if (!validThreadId(threadId)) throw Object.assign(new Error('A valid selected chat ID is required.'), { code: 'INVALID_THREAD' });
  threadId = threadId.toLowerCase();
  if (signal?.aborted) throw Object.assign(new Error('Terminal attachment was cancelled.'), { code: 'ABORTED' });
  const metadata = (factories.createMetadataReader ?? createMetadataReader)(backendPath);
  let desktop;
  try { desktop = factories.createDesktopClient?.() ?? new DesktopIpcClient({ transportFactory: verifiedDesktopTransport(powershellPath) }); }
  catch (cause) { await metadata.close(); throw cause; }
  const controller = createDesktopController(desktop, threadId);
  const projectors = new Set();
  const methods = new Map(), rejected = new Map();
  const notificationCounts = {};
  const server = createServer((_request, response) => { response.writeHead(404); response.end(); });
  const sockets = new Set();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const token = randomBytes(32).toString('hex');
  let initialized, closed = false, disconnected = false, closing;
  const notifyError = cause => { try { onError?.(cause); } catch {} };
  const callback = (fn, ...args) => { try { fn?.(...args); } catch { notifyError(new Error('The terminal presence callback failed.')); } };
  const checkOpen = () => { if (closed || signal?.aborted) throw Object.assign(new Error('Terminal attachment was cancelled.'), { code: 'ABORTED' }); };
  desktop.on('error', notifyError);
  desktop.on('state', (state, details) => {
    if (closed) return;
    callback(onState, state, details);
    for (const projector of projectors) {
      try { projector.update(state); }
      catch (cause) { notifyError(Object.assign(cause, { code: cause.code ?? 'PROTOCOL_PROJECTION_FAILED' })); projector.stop(); projectors.delete(projector); }
    }
  });
  desktop.on('status', status => {
    callback(onStatus, status);
    if (status.phase === 'disconnected' || status.phase === 'owner-unavailable') {
      disconnected = true;
      for (const socket of sockets) socket.close(1011, 'The original Desktop connection was lost.');
    }
  });
  const stop = () => closing ??= (async () => {
    closed = true;
    signal?.removeEventListener('abort', abort);
    projectors.clear();
    for (const socket of sockets) socket.terminate();
    wss.close();
    if (server.listening) server.close();
    desktop.close();
    await metadata.close();
  })();
  const abort = () => { void stop().catch(notifyError); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    checkOpen();
    initialized = await metadata.initialize();
    checkOpen();
    await desktop.connect(threadId);
    checkOpen();
    await desktop.ensureCompleteHistory({ signal });
    checkOpen();
    // Fail before launching the native UI if its required live settings cannot
    // be projected truthfully.
    const initialRead = await metadata.call('thread/read', { threadId, includeTurns: false });
    checkOpen();
    if (initialRead?.thread?.id !== threadId) throw Object.assign(new Error('Desktop metadata did not match the selected chat.'), { code: 'THREAD_MISMATCH' });
    const initialBaseline = desktop.state;
    const initialHistory = new SnapshotHistory(initialBaseline);
    const initialResume = resumeFromLiveSnapshot(initialRead, initialBaseline);
    initialResume.thread.turns = initialHistory.turns;
    validateProtocol('v2/ThreadResumeResponse', initialResume);
    validateProtocol('v2/ThreadTurnsListResponse', initialHistory.page('turns', { limit: 1000 }));
    validateProtocol('v2/ThreadItemsListResponse', initialHistory.page('items', { limit: 1000 }));
    server.on('upgrade', (request, socket, head) => {
      const expected = Buffer.from(`Bearer ${token}`), received = Buffer.from(request.headers.authorization ?? '');
      if (closed || disconnected || request.headers.origin || request.url !== '/' || received.length !== expected.length || !timingSafeEqual(received, expected) || sockets.size) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
      }
      wss.handleUpgrade(request, socket, head, websocket => wss.emit('connection', websocket));
    });
    wss.on('connection', socket => {
      sockets.add(socket);
      let projector, history;
      socket.once('close', () => { sockets.delete(socket); if (projector) projectors.delete(projector); });
      socket.on('error', () => {});
      let acceptedInitialize = false;
      socket.on('message', async bytes => {
        let request;
        try { request = JSON.parse(bytes.toString('utf8')); } catch { socket.close(1007); return; }
        if (!request || typeof request.method !== 'string' || request.id === undefined) return;
        const method = request.method;
        methods.set(method, (methods.get(method) ?? 0) + 1);
        const reply = result => { if (socket.readyState === 1) socket.send(JSON.stringify({ id: request.id, result })); };
        try {
          if (method === 'initialize') {
            if (acceptedInitialize) throw error('The native CLI connection is already initialized.', -32600);
            acceptedInitialize = true; reply(initialized); return;
          }
          if (!acceptedInitialize || closed || disconnected || !desktop.status.ready) throw error('The original Desktop connection is not ready.', -32000);
          const params = { ...(request.params ?? {}) };
          if (method === 'thread/loaded/list') { reply({ data: [threadId], nextCursor: null }); return; }
          if (method.startsWith('thread/') && params.threadId !== threadId) throw error('This terminal is attached to a different chat.', -32602);
          if (method === 'thread/resume') {
            await desktop.ensureCompleteHistory({ signal });
            const read = await metadata.call('thread/read', { threadId, includeTurns: false });
            checkOpen();
            if (read?.thread?.id !== threadId) throw error('Desktop metadata did not match the selected chat.', -32000);
            const baseline = desktop.state;
            history = new SnapshotHistory(baseline);
            const response = resumeFromLiveSnapshot(read, baseline);
            response.thread.turns = params.excludeTurns ? [] : history.turns;
            validateProtocol('v2/ThreadResumeResponse', response);
            reply(response);
            if (projector) projectors.delete(projector);
            projector = new DesktopEventProjector(threadId, (notificationMethod, notificationParams) => {
              const notification = validateProtocol('ServerNotification', { method: notificationMethod, params: notificationParams });
              notificationCounts[notificationMethod] = (notificationCounts[notificationMethod] ?? 0) + 1;
              if (socket.readyState === 1) socket.send(JSON.stringify(notification));
            });
            projector.stop = () => {
              if (socket.readyState === 1) socket.send(JSON.stringify({ method: 'warning', params: { threadId, message: 'Codex Session to Terminal could not preserve the official event contract. Reconnect this terminal to refresh the Desktop snapshot. No message was retried.' } }));
              socket.close(1011, 'The Desktop event projection must be resynchronized.');
            };
            projector.seed(baseline); projectors.add(projector); projector.pendingRequests(baseline);
            return;
          }
          if (history && (method === 'thread/turns/list' || method === 'thread/items/list')) {
            const result = history.page(method === 'thread/turns/list' ? 'turns' : 'items', params);
            validateProtocol(method === 'thread/turns/list' ? 'v2/ThreadTurnsListResponse' : 'v2/ThreadItemsListResponse', result);
            reply(result); return;
          }
          if (method === 'thread/unsubscribe') { if (projector) projectors.delete(projector); reply({ status: 'unsubscribed' }); return; }
          if (['turn/start', 'turn/steer', 'turn/interrupt'].includes(method)) {
            if (!history || !projector) throw error('Attach this terminal to the selected chat before sending a command.', -32600);
            if (!allowControl) throw error('This terminal was opened in read-only mode.');
            reply(await controller.call(method, params)); return;
          }
          if (!METADATA_METHODS.has(method)) throw error('This terminal does not support that command. Use Desktop for it.');
          if (method === 'account/read') params.refreshToken = false;
          if (method === 'skills/list' || method === 'hooks/list') {
            params.cwds = [desktop.state.latestThreadSettings?.cwd ?? desktop.state.cwd];
            if (method === 'skills/list') params.forceReload = false;
          }
          if (method === 'config/read') {
            const cwd = desktop.state.latestThreadSettings?.cwd ?? desktop.state.cwd;
            if (params.cwd && params.cwd !== cwd) throw error('Only the attached chat working directory can be inspected.');
          }
          reply(await metadata.call(method, params));
        } catch (cause) {
          rejected.set(method, (rejected.get(method) ?? 0) + 1);
          const rpcError = cause.rpcError ?? { code: -32000, message: `${method} could not be completed. Continue in Desktop or reconnect this terminal.` };
          if (socket.readyState === 1) socket.send(JSON.stringify({ id: request.id, error: rpcError }));
        }
      });
    });
    checkOpen();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { if (closed) server.close(); resolve(); });
    });
    checkOpen();
    return {
      endpoint: `ws://127.0.0.1:${server.address().port}`,
      token,
      close: stop,
      get state() { return desktop.state; },
      get status() { return desktop.status; },
      get evidence() { return { methods: Object.fromEntries(methods), rejected: Object.fromEntries(rejected), metadataMethods: metadata.methods, desktopReady: desktop.status.ready, ownerUnchanged: !disconnected, threadId, readonly: !allowControl, controlCalls: controller.counts,
        notifications: { ...notificationCounts } }; },
    };
  } catch (cause) { await stop(); throw cause; }
}
