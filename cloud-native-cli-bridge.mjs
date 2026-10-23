import { dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNativeCliBridge, validThreadId } from './native-cli-bridge.mjs';
import { cloudNativeMetadataFromSnapshot } from './cloud-native-metadata.mjs';
import { DesktopIpcClient } from './desktop-ipc.mjs';
import { verifiedDesktopTransport } from './cst-transport.mjs';
import { SnapshotHistory } from './snapshot-history.mjs';

const DEFAULT_BRIDGE_HOME = dirname(fileURLToPath(import.meta.url));
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const unavailable = (message, code = 'UNSUPPORTED_CLOUD_METADATA', rpcCode = -32601) =>
  Object.assign(new Error(message), { code, rpcError: { code: rpcCode, message } });
const manifest = () => ({
  experimental: true, readonly: true, hostId: 'durable', localBackendStarted: false,
  initialization: 'CST bridge process and bridge home; not the cloud executor filesystem',
  account: 'No account identity disclosed; this bridge requires no additional OpenAI login',
  models: 'Only the current Desktop model and effort; text presentation; no setting changes',
  skills: 'Empty catalog for this read-only terminal only; no cloud or local skill inventory is read, installed or refreshed',
  requirements: 'Restrictions of this CST bridge, not cloud execution policy',
  runtime: 'Model, provider, source, permissions and IDs come from the authoritative Desktop snapshot',
  history: 'Canonical legacy history from the existing owner; one read-only completion request if needed, with a 20-second deadline',
  unsupported: ['all writes', 'configuration', 'skill execution and management', 'hooks', 'account limits', 'model switching', 'approval answers'],
});

// Official startup reads have only cwds and forceReload. This catalog describes
// adapter capabilities, so neither argument causes filesystem or executor IO.
export function validCloudSkillsListParams(params) {
  return params !== null && typeof params === 'object' && !Array.isArray(params) &&
    Object.keys(params).every(key => ['cwds', 'forceReload'].includes(key)) &&
    (!Object.hasOwn(params, 'forceReload') || typeof params.forceReload === 'boolean') &&
    (!Object.hasOwn(params, 'cwds') || Array.isArray(params.cwds) && params.cwds.length <= 32 && params.cwds.every(cwd =>
      typeof cwd === 'string' && cwd.length > 0 && cwd.length <= 32768 && cwd.isWellFormed() && !/[\u0000-\u001f\u007f-\u009f]/u.test(cwd)));
}

function currentModel(state) {
  const model = state.latestThreadSettings?.model ?? state.latestModel;
  const effort = state.latestThreadSettings?.effort ?? state.latestReasoningEffort;
  if (typeof model !== 'string' || !model || !EFFORTS.has(effort)) {
    throw unavailable('The Desktop snapshot must identify the current model and reasoning effort.', 'INCOMPLETE_CLOUD_CAPABILITIES', -32000);
  }
  return { id: model, model, displayName: model, hidden: false, isDefault: true,
    description: 'Current Desktop model. This CST attachment is read-only; model and reasoning settings cannot be changed.',
    defaultReasoningEffort: effort,
    supportedReasoningEfforts: [{ reasoningEffort: effort, description: 'Current setting; this attachment cannot change it.' }],
    inputModalities: ['text'], supportsPersonality: false,
    serviceTiers: [], additionalSpeedTiers: [], defaultServiceTier: null,
  };
}

/** In-memory experiment adapter. No account, filesystem configuration or backend is read. */
export function createCloudNativeMetadataReader({ getState, threadId, persistedThread = false,
  originalThread, bridgeHome = DEFAULT_BRIDGE_HOME, ensureHistory } = {}) {
  if (typeof getState !== 'function' || !validThreadId(threadId)) throw unavailable('A snapshot reader and native thread ID are required.', 'INVALID_CLOUD_BRIDGE', -32602);
  if (typeof bridgeHome !== 'string' || !isAbsolute(bridgeHome)) throw unavailable('The bridge home must be an absolute local path.', 'INVALID_CLOUD_BRIDGE', -32602);
  const methods = new Set();
  let closed = false, history, projection;
  const snapshot = () => {
    const state = getState();
    if (!state || state.id !== threadId || state.hostId !== 'durable') throw unavailable('The durable snapshot does not match this attachment.', 'THREAD_MISMATCH', -32602);
    return state;
  };
  const requireThread = params => {
    if (params?.threadId !== threadId) throw unavailable('This attachment only exposes its selected native thread.', 'THREAD_MISMATCH', -32602);
  };
  const call = async (method, params = {}) => {
    if (closed) throw unavailable('The cloud metadata adapter is closed.', 'CLOSED', -32000);
    methods.add(method);
    if (method === 'initialize') return {
      userAgent: 'codex-session-to-terminal-cloud-readonly-experiment/0.1',
      codexHome: bridgeHome,
      platformFamily: process.platform === 'win32' ? 'windows' : 'unix',
      platformOs: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : process.platform,
    };
    if (method === 'account/read') return { account: null, requiresOpenaiAuth: false };
    if (method === 'skills/list') {
      if (!validCloudSkillsListParams(params)) throw unavailable('Invalid read-only skill catalog parameters.', 'INVALID_PARAMS', -32602);
      return { data: [] };
    }
    if (method === 'configRequirements/read') return { requirements: {
      // These are bridge restrictions. Cloud approval/sandbox values belong to
      // the live resume response and are never replaced by a read-only sandbox.
      allowedLoginMethods: [], allowAppshots: false,
      allowBrowserAndComputerUse: false, allowRemoteControl: false,
    } };
    if (method === 'model/list') {
      if (params.cursor != null) throw unavailable('This attachment has one current-model catalog page.', 'INVALID_CURSOR', -32602);
      return { data: [currentModel(snapshot())], nextCursor: null };
    }
    if (method === 'thread/read') {
      requireThread(params);
      let state = snapshot();
      // Avoid a late CLI-bootstrap failure after its window has been launched.
      currentModel(state);
      if (state.historyMode !== 'legacy') throw unavailable('This experiment requires a complete legacy history snapshot.', 'UNSUPPORTED_CLOUD_HISTORY', -32000);
      let complete;
      try { complete = new SnapshotHistory(state); }
      catch (error) {
        if (error.code !== 'INCOMPLETE_HISTORY' || typeof ensureHistory !== 'function') throw error;
        // A native page initially supplies only its recent history. Ask its
        // existing owner to read the remaining history, never resume or send.
        await ensureHistory();
        if (closed) throw unavailable('The cloud metadata adapter is closed.', 'CLOSED', -32000);
        state = snapshot();
        currentModel(state);
        if (state.historyMode !== 'legacy') throw unavailable('The cloud history contract changed while loading.', 'UNSUPPORTED_CLOUD_HISTORY', -32000);
        complete = new SnapshotHistory(state);
      }
      const metadata = cloudNativeMetadataFromSnapshot(state, { persistedThread, originalThread });
      projection = metadata.projection;
      history = complete;
      return structuredClone({ thread: { ...metadata.thread, turns: params.includeTurns === true ? complete.turns : [] } });
    }
    if (method === 'thread/turns/list' || method === 'thread/items/list') {
      requireThread(params);
      if (!history) throw unavailable('Read the selected thread before requesting its history.', 'HISTORY_NOT_READY', -32000);
      return structuredClone(history.page(method === 'thread/turns/list' ? 'turns' : 'items', params));
    }
    throw unavailable('This read-only cloud attachment does not expose that operation. Continue in Desktop.');
  };
  return {
    call, initialize: () => call('initialize'), async close() { closed = true; history = null; },
    get methods() { return [...methods]; },
    get manifest() { return { ...manifest(), metadataProjection: structuredClone(projection ?? null) }; },
  };
}

/** Experimental standalone reader. It does not install or start the official CLI. */
export async function createCloudNativeCliBridge(options = {}, factories = {}) {
  if (options.allowControl !== undefined && options.allowControl !== false ||
    options.allowExperimentalDurableControl !== undefined && options.allowExperimentalDurableControl !== false) {
    throw unavailable('The experimental cloud CLI attachment is always read-only.', 'READ_ONLY_REQUIRED', -32602);
  }
  const { threadId, powershellPath, persistedThread = false, originalThread, bridgeHome,
    onState, onStatus, onError, signal } = options;
  if (!validThreadId(threadId)) throw unavailable('A valid native durable thread ID is required.', 'INVALID_CLOUD_BRIDGE', -32602);
  if (signal?.aborted) throw unavailable('Cloud terminal attachment was cancelled.', 'ABORTED', -32000);
  const selectedId = threadId.toLowerCase();
  let desktop, metadata;
  const bridge = await createNativeCliBridge({ threadId: selectedId, allowControl: false,
    onState, onStatus, onError, signal }, {
    createMetadataReader: () => metadata = createCloudNativeMetadataReader({
      getState: () => desktop?.state, threadId: selectedId, persistedThread, originalThread, bridgeHome,
      ensureHistory: () => desktop.ensureCompleteHistory({ timeoutMs: 20000, signal }),
    }),
    createDesktopClient: () => {
      // Only this factory seam is replaceable in isolated tests. There is no
      // metadata/backend factory override that could accidentally start locally.
      const settings = { hostId: 'durable', allowExperimentalDurableControl: false };
      desktop = factories.createDesktopClient?.(settings) ?? new DesktopIpcClient({
        ...settings, transportFactory: verifiedDesktopTransport(powershellPath),
      });
      // The shared bridge requests complete history before using SnapshotHistory.
      // Metadata initialization above has already completed a partial snapshot.
      // Validate here without requesting the same history a second time.
      return new Proxy(desktop, { get(target, key) {
        if (key === 'ensureCompleteHistory') return async () => {
          new SnapshotHistory(target.state);
          return target.state;
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    },
  });
  return {
    endpoint: bridge.endpoint, token: bridge.token, close: bridge.close,
    get state() { return bridge.state; }, get status() { return bridge.status; },
    get evidence() { return { ...bridge.evidence, cloudManifest: metadata.manifest }; },
    get manifest() { return metadata.manifest; },
  };
}
