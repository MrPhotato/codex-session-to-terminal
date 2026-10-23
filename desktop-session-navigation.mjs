import { isAbsolute } from 'node:path';
import { createCloudDesktopReader } from './cloud-desktop-reader.mjs';

const fail = (code, details = {}) => Object.assign(new Error(code), { code, ...details });
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;

/** A button-owned navigator, independent of the CLI's read/control connection.
 * Construction performs no IO. Only an explicit navigate() call creates the
 * official helper. The bound ID is never replaced by a title/time-based match.
 */
export function createDesktopSessionNavigator(options = {}, factories = {}) {
  if (!options || Object.keys(options).some(key => !['threadId', 'kind', 'hostId', 'backendPath', 'nodePath', 'powershellPath', 'cwd'].includes(key)) ||
      typeof options.threadId !== 'string' || !UUID.test(options.threadId) ||
      !['codex', 'chatgpt'].includes(options.kind) ||
      (options.kind === 'codex' ? !['local', 'durable'].includes(options.hostId) : options.hostId != null)) {
    throw fail('INVALID_NAVIGATION_TARGET');
  }
  const settings = {};
  for (const key of ['backendPath', 'nodePath', 'powershellPath', 'cwd']) {
    if (typeof options[key] !== 'string' || !isAbsolute(options[key]) || /[\0\r\n]/u.test(options[key])) throw fail('INVALID_NAVIGATION_TARGET');
    settings[key] = options[key];
  }
  const target = Object.freeze({ threadId: options.threadId.toLowerCase(), kind: options.kind,
    hostId: options.kind === 'codex' ? options.hostId : null,
    nativeExecutionView: options.kind === 'codex' && options.hostId === 'durable' });
  const createReader = factories.createReader ?? createCloudDesktopReader;
  let reader, opening, closed = false, active = false, uncertain = false, closePromise;
  const requireOpen = () => { if (closed) throw fail('NAVIGATOR_CLOSED'); };
  const getReader = () => opening ??= Promise.resolve().then(() => {
    requireOpen();
    return createReader({ ...settings, navigateTargets: [target.threadId] });
  }).then(async resource => {
    if (closed) { await resource.close(); throw fail('NAVIGATOR_CLOSED'); }
    reader = resource;
    return resource;
  });
  const navigate = async (...args) => {
    if (args.length) throw fail('NAVIGATION_NOT_AUTHORIZED');
    requireOpen();
    if (uncertain) throw fail('NAVIGATION_OUTCOME_UNKNOWN', { outcome: 'unknown' });
    if (active) throw fail('NAVIGATION_IN_PROGRESS');
    active = true;
    let dispatched = false;
    try {
      const client = await getReader();
      requireOpen();
      const current = await client.readConversation(target.threadId, {
        ...(target.hostId === 'durable' ? { hostId: 'durable' } : {}),
        turnLimit: 1, maxOutputCharsPerItem: 1,
      });
      requireOpen();
      if (current?.thread?.id !== target.threadId || current.thread.kind !== target.kind ||
          (target.kind === 'codex' ? current.thread.hostId !== target.hostId : current.thread.hostId != null)) {
        throw fail('NAVIGATION_TARGET_MISMATCH');
      }
      dispatched = true;
      const result = await client.navigateConversation(target.threadId);
      if (result?.navigated !== true) throw fail('INVALID_NAVIGATION_RESULT');
      return { ...target, navigated: true, focusConfirmed: false, pageReadyConfirmed: false };
    } catch (cause) {
      if (dispatched) {
        uncertain = true;
        throw fail('NAVIGATION_OUTCOME_UNKNOWN', { outcome: 'unknown', cause });
      }
      throw cause;
    } finally { active = false; }
  };
  const close = () => {
    if (closePromise) return closePromise;
    closed = true;
    return closePromise = Promise.resolve().then(async () => {
      if (reader) return reader.close();
      // A late factory result is closed by getReader's adoption continuation.
      if (opening) await opening.catch(() => {});
    });
  };
  return Object.freeze({ target, navigate, close });
}
