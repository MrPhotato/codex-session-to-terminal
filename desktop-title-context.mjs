import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const helper = fileURLToPath(new URL('./bin/Desktop-Context.exe', import.meta.url));
const positive = (value, max) => Number.isSafeInteger(value) && value > 0 && value <= max;
const ticks = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/u.test(value) && BigInt(value) <= 3155378975999999999n;
const inputTick = value => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff;

export function validDesktopTitleContext(value) {
  return value?.version === 1 && value.status === 'ready' && positive(value.pid, 2147483647) &&
    positive(value.window, Number.MAX_SAFE_INTEGER) && ticks(value.started) &&
    typeof value.title === 'string' && value.title.length > 0 && value.title.length <= 512 &&
    !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value.title) &&
    typeof value.documentRuntimeId === 'string' && value.documentRuntimeId.length <= 384 &&
    /^-?\d+(?:,-?\d+){1,31}$/u.test(value.documentRuntimeId) &&
    (!Object.hasOwn(value, 'lastInputTick') || inputTick(value.lastInputTick));
}

async function readSnapshot(context, { signal, executeFn = execute, now = Date.now } = {}) {
  if (!validDesktopTitleContext(context)) return { reason: 'unavailable' };
  if (signal?.aborted) return { reason: 'aborted' };
  try {
    const result = await executeFn(helper, ['--pid', String(context.pid), '--window', String(context.window), '--started', context.started],
      { windowsHide: true, shell: false, timeout: 1500, maxBuffer: 8192, encoding: 'utf8', signal });
    if (signal?.aborted) return { reason: 'aborted' };
    const actual = JSON.parse(result.stdout);
    if (!validDesktopTitleContext(actual)) return { reason: 'unavailable' };
    if (['pid', 'window', 'started'].some(key => actual[key] !== context[key])) return { reason: 'identity-changed' };
    const capturedAt = now();
    if (!Number.isSafeInteger(capturedAt) || capturedAt < 0) return { reason: 'unavailable' };
    return { actual: { ...actual, capturedAt } };
  } catch { return { reason: 'helper-failed' }; }
}

// Refresh this exact process/window generation. The title/document may have
// changed; the caller owns route checks and any last-input guard. An old helper
// may omit lastInputTick, so navigation callers must explicitly require it.
export async function readDesktopTitleContext(context, options = {}) {
  return (await readSnapshot(context, options)).actual ?? null;
}

// Explicit one-shot return, separate from the default read-only helper mode.
// The helper rechecks this exact page/input snapshot before invoking the
// application's chrome Back button. A timeout is uncertain, never retryable.
export async function restoreDesktopPage(context, { signal, executeFn = execute, now = Date.now } = {}) {
  const result = status => ({ dispatched: status === 'dispatched', status });
  if (signal?.aborted) return result('aborted');
  if (!validDesktopTitleContext(context) || !inputTick(context.lastInputTick) ||
      !Number.isSafeInteger(context.capturedAt) || now() < context.capturedAt || now() - context.capturedAt > 30000) {
    return result('invalid-context');
  }
  try {
    const response = await executeFn(helper, ['--back', '--pid', String(context.pid), '--window', String(context.window),
      '--started', context.started, '--input-tick', String(context.lastInputTick), '--document', context.documentRuntimeId, '--title', context.title],
    { windowsHide: true, shell: false, timeout: 1500, maxBuffer: 8192, encoding: 'utf8', signal });
    const value = JSON.parse(response.stdout);
    if (!value || value.version !== 1 || typeof value.dispatched !== 'boolean' ||
        !['dispatched', 'context-changed', 'back-unavailable', 'invalid-context', 'outcome-unknown'].includes(value.status) ||
        value.dispatched !== (value.status === 'dispatched') || Object.keys(value).some(key => !['version', 'dispatched', 'status'].includes(key))) {
      return result('outcome-unknown');
    }
    return result(value.status);
  } catch { return result('outcome-unknown'); }
}

// Context is a short-lived observation of one HWND, not an ID or a persistent
// title-to-thread mapping. Bad/expired observations simply leave the picker.
export function decodeDesktopTitleContext(encoded, now = Date.now()) {
  try {
    if (typeof encoded !== 'string' || encoded.length > 8192 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) return null;
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) return null;
    const value = JSON.parse(bytes.toString('utf8'));
    if (!validDesktopTitleContext(value) || !Number.isSafeInteger(value.capturedAt) ||
        now < value.capturedAt || now - value.capturedAt > 30000) return null;
    return value;
  } catch { return null; }
}

export async function recheckDesktopTitleContext(context, { signal, executeFn = execute, now = Date.now, onDiagnostic = () => {} } = {}) {
  const started = now();
  const finish = reason => {
    try { onDiagnostic({ reason, elapsedMs: Math.max(0, now() - started) }); } catch {}
    return reason === 'matched';
  };
  if (!validDesktopTitleContext(context) || !Number.isSafeInteger(context.capturedAt) ||
      now() < context.capturedAt || now() - context.capturedAt > 30000) return finish('expired');
  if (signal?.aborted) return finish('aborted');
  const { actual, reason } = await readSnapshot(context, { signal, executeFn, now });
  if (now() < context.capturedAt || now() - context.capturedAt > 30000) return finish('expired');
  if (!actual) return finish(reason);
  if (actual.title !== context.title) return finish('title-changed');
  if (actual.documentRuntimeId !== context.documentRuntimeId) return finish('document-changed');
  return finish('matched');
}
