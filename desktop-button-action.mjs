import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const helper = fileURLToPath(new URL('./Focus-Desktop.ps1', import.meta.url));
const nativeHelper = fileURLToPath(new URL('./bin/Desktop-Navigation.exe', import.meta.url));
const nativeHelperAvailable = async () => { try { await access(nativeHelper); return true; } catch { return false; } };
const fail = code => Object.assign(new Error(code), { code });
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;

// The official Desktop deep link is a navigation request. It needs neither a
// model executor nor a new app-tools thread. Construction performs no IO.
export function createDesktopButtonAction(options, { executeFn = execute, hasNativeHelper = nativeHelperAvailable, signal } = {}) {
  if (typeof options?.threadId !== 'string' || !UUID.test(options.threadId) || !['local', 'durable'].includes(options?.hostId) ||
      typeof options?.powershellPath !== 'string' || !isAbsolute(options.powershellPath) || /[\0\r\n]/u.test(options.powershellPath)) {
    throw fail('INVALID_NAVIGATION_TARGET');
  }
  const target = Object.freeze({ threadId: options.threadId.toLowerCase(), hostId: options.hostId,
    nativeExecutionView: options.hostId === 'durable' });
  const powershellPath = options.powershellPath;
  const lifetime = new AbortController();
  let pending, closed = false, uncertain = false;
  const open = (...args) => {
    if (args.length) return Promise.reject(fail('NAVIGATION_NOT_AUTHORIZED'));
    if (closed || lifetime.signal.aborted) return Promise.reject(fail('NAVIGATOR_CLOSED'));
    if (uncertain) return Promise.reject(fail('NAVIGATION_OUTCOME_UNKNOWN'));
    if (pending) return Promise.reject(fail('NAVIGATION_IN_PROGRESS'));
    pending = (async () => {
      let result;
      try {
        const useNative = await hasNativeHelper();
        if (closed || lifetime.signal.aborted) throw fail('NAVIGATOR_CLOSED');
        const response = await executeFn(useNative ? nativeHelper : powershellPath,
          useNative ? ['--thread', target.threadId, '--host', target.hostId]
            : ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', helper,
              '-Action', 'OpenThread', '-ThreadId', target.threadId, '-HostId', target.hostId],
        { windowsHide: true, timeout: 15000, maxBuffer: 16384, signal: lifetime.signal });
        result = JSON.parse(response.stdout);
        if (!result || typeof result.dispatched !== 'boolean' || typeof result.foreground !== 'boolean' ||
            typeof result.status !== 'string') throw fail('INVALID_NAVIGATION_RESULT');
      } catch {
        if (closed || lifetime.signal.aborted) throw fail('NAVIGATOR_CLOSED');
        uncertain = true;
        throw fail('NAVIGATION_OUTCOME_UNKNOWN');
      }
      if (closed || lifetime.signal.aborted) throw fail('NAVIGATOR_CLOSED');
      if (!result.dispatched) throw fail('DESKTOP_NAVIGATION_UNAVAILABLE');
      // A successful process handoff is not an authoritative page receipt.
      return { ...target, dispatched: true, focusConfirmed: result.foreground, pageReadyConfirmed: false };
    })().finally(() => { pending = undefined; });
    return pending;
  };
  const close = async () => {
    if (!closed) { closed = true; lifetime.abort(); signal?.removeEventListener('abort', onAbort); }
    try { await pending; } catch {}
  };
  const onAbort = () => { void close(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  return Object.freeze({ open, close });
}
