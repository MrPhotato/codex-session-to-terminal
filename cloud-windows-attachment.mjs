import { createCloudNativeCliBridge } from './cloud-native-cli-bridge.mjs';
import { validThreadId } from './native-cli-bridge.mjs';

const failure = code => Object.assign(new Error(code), { code });

// Experimental assembly only. The caller still selects the actual identities,
// verifies the official executables and launches the original CLI. No tray,
// Desktop startup, account, global CLI configuration or model task is changed.
export async function createCloudWindowsAttachment(options = {}, factories = {}) {
  // Reject the removed control API before constructing any connection. Keeping
  // an old opt-in or callback must never silently enable cloud writes again.
  if (options.allowInterrupt === true || Object.hasOwn(options, 'interruptControl')) {
    throw failure('READ_ONLY_REQUIRED');
  }
  const { threadId: inputThreadId, powershellPath, bridgeHome, originalThread,
    persistedThread = false, allowInterrupt = false,
    onState, onStatus, onError, signal } = options;
  if (!validThreadId(inputThreadId) || typeof allowInterrupt !== 'boolean') {
    throw failure('INVALID_CLOUD_ATTACHMENT');
  }
  const threadId = inputThreadId.toLowerCase();
  if (signal?.aborted) throw failure('ABORTED');
  const createBridge = factories.createBridge ?? createCloudNativeCliBridge;
  const createProxy = factories.createProxy ??
    (async args => (await import('./cloud-windows-cli-proxy.mjs')).createCloudWindowsCliProxy(args));
  const lifetime = new AbortController();
  let bridge, proxy, closed = false, closePromise;
  const close = () => {
    if (closePromise) return closePromise;
    closed = true;
    // Publish the promise before aborting: abort callbacks may call close again.
    closePromise = Promise.resolve().then(async () => {
      try { await proxy?.close(); }
      finally { await bridge?.close(); }
    });
    lifetime.abort();
    signal?.removeEventListener('abort', onAbort);
    return closePromise;
  };
  const onAbort = () => { void close().catch(() => {}); };
  const disconnected = error => {
    if (closed) return;
    try { onError?.(error); } finally { void close().catch(() => {}); }
  };
  const accept = async (resource, own) => {
    if (closed) {
      await resource.close();
      throw failure('ABORTED');
    }
    // Adopt synchronously, before this async function yields to its caller.
    // Otherwise cancellation can close the stack before it sees this resource.
    own(resource);
  };
  const requireOpen = () => { if (closed) throw failure('ABORTED'); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await accept(await createBridge({
      threadId, powershellPath, bridgeHome, originalThread, persistedThread,
      allowControl: false, signal: lifetime.signal, onState,
      onStatus: status => {
        onStatus?.(status);
        // Normal cleanup emits disconnected/CLOSED and then closed. Reporting
        // those would hide the setup error that caused cleanup in the first
        // place, or turn an intentional close into a connection failure.
        if (!['disconnected', 'owner-unavailable'].includes(status?.phase) || status.reason === 'CLOSED') return;
        if (typeof status.reason === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(status.reason)) {
          disconnected(failure(status.reason));
        } else {
          // Desktop emits status before its detailed error callback. Give that
          // synchronous callback priority, retaining a fallback for status-only
          // disconnections. close() suppresses any later duplicate report.
          queueMicrotask(() => disconnected(failure('OWNER_UNAVAILABLE')));
        }
      },
      onError: disconnected,
    }), resource => { bridge = resource; });
    requireOpen();
    if (bridge.state?.id !== threadId || bridge.state?.hostId !== 'durable' || bridge.status?.ready !== true ||
        bridge.manifest?.readonly !== true) throw failure('INVALID_CLOUD_ATTACHMENT');
    await accept(await createProxy({
      bridge, powershellPath, signal: lifetime.signal, onError: disconnected,
    }), resource => { proxy = resource; });
    requireOpen();
    return {
      endpoint: proxy.endpoint, token: proxy.token, close,
      get state() { return bridge.state; },
      get status() { return closed ? { phase: 'closed', ready: false } : bridge.status; },
      get evidence() { return { bridge: bridge.evidence, proxy: proxy.records }; },
      get manifest() { return {
        experimental: true, hostId: 'durable', nativeCliRequired: true,
        readonly: true, observe: true, interrupt: false,
        send: false, steer: false, queue: false, filesystem: false,
        frontendIdentity: 'not used',
      }; },
    };
  } catch (error) {
    // Cleanup still attempts every owned resource; preserve the setup failure.
    await close().catch(() => {});
    throw error;
  }
}
