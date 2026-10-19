import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { getActiveTurnId } from './cst-state.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const PHASES = new Set(['idle', 'connecting', 'initializing', 'discovering', 'syncing', 'owner-unavailable', 'ready', 'disconnected', 'closed']);
const BUSY = new Set(['EACCES', 'EBUSY', 'EPERM']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function presenceTitle(value) {
  if (typeof value !== 'string') return '';
  return Array.from(stripVTControlCharacters(value)
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '')).slice(0, 200).join('').trim();
}

// The panel reads only this deliberately small metadata record. Conversation
// bodies, IPC errors, paths, credentials and provider configuration never enter it.
export function createSessionPresence({ controlDirectory, threadId, instanceId = randomUUID(), pid = process.pid,
  heartbeatMs = 2000, now = Date.now, fileSystem = fs, setIntervalFn = setInterval,
  clearIntervalFn = clearInterval, retryDelay = sleep } = {}) {
  if (!isAbsolute(controlDirectory ?? '') || !UUID.test(threadId ?? '') || !UUID.test(instanceId ?? '') ||
    !Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1) {
    throw new TypeError('Invalid Codex Session to Terminal session presence options.');
  }
  const directory = join(controlDirectory, 'sessions');
  const filePath = join(directory, `${instanceId}.json`);
  const temporaryPath = join(directory, `${instanceId}.json.tmp`);
  const openedAt = new Date(now()).toISOString();
  let phase = 'connecting', title = '', activeTurn = false, closed = false, dirty = false, pending, closing;

  async function retry(operation) {
    for (let attempt = 0; ; attempt++) {
      try { return await operation(); }
      catch (error) {
        if (!BUSY.has(error?.code) || attempt >= 4) throw error;
        await retryDelay(20 * (attempt + 1));
      }
    }
  }
  async function remove(path) {
    try { await retry(() => fileSystem.unlink(path)); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  async function write() {
    // Use an exact allowlist, rather than copying any properties from IPC data.
    const record = { schema: 1, instanceId, threadId, pid, title, phase,
      activeTurn: phase === 'ready' && activeTurn, updatedAt: new Date(now()).toISOString(), openedAt };
    try {
      await fileSystem.mkdir(directory, { recursive: true });
      if (closed) return;
      await fileSystem.writeFile(temporaryPath, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
      if (!closed) await retry(() => fileSystem.rename(temporaryPath, filePath));
    } finally {
      // A failed write/rename may leave a partial temporary file. The panel only
      // consumes .json files, and every attempt cleans its own temporary file.
      await remove(temporaryPath).catch(() => {});
    }
  }
  function publish() {
    if (closed) return;
    dirty = true;
    if (pending) return;
    pending = (async () => {
      while (dirty && !closed) {
        dirty = false;
        // Presence is optional UI bookkeeping; failures must never disconnect
        // a live conversation, or replace its phase with a fabricated status.
        await write().catch(() => {});
      }
    })().finally(() => { pending = undefined; });
  }
  const timer = setIntervalFn(publish, heartbeatMs);
  timer?.unref?.();
  publish();

  return {
    instanceId, filePath,
    updateStatus(value) {
      if (closed) return;
      const next = PHASES.has(value?.phase) && (value.phase !== 'ready' || value.ready === true) ? value.phase : 'disconnected';
      if (next !== phase) { phase = next; publish(); }
    },
    updateState(state) {
      if (closed) return;
      const nextTitle = presenceTitle(state?.title);
      const nextActive = Boolean(getActiveTurnId(state)) || (Array.isArray(state?.turns) && state.turns.some(turn => turn?.status === 'inProgress' && turn.turnId == null));
      if (nextTitle !== title || nextActive !== activeTurn) { title = nextTitle; activeTurn = nextActive; publish(); }
    },
    async flush() { if (pending) await pending; },
    close() {
      if (closing) return closing;
      closed = true; dirty = false; clearIntervalFn(timer);
      closing = (async () => {
        await pending;
        await Promise.all([remove(filePath).catch(() => {}), remove(temporaryPath).catch(() => {})]);
      })();
      return closing;
    },
  };
}
