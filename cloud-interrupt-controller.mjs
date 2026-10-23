import { getActiveTurnId } from './cst-state.mjs';
import { orderedDesktopTurns } from './desktop-events.mjs';
import { interruptCloudTurn } from './cloud-interrupt-control.mjs';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const validId = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
const failure = (code, message) => Object.assign(new Error(message), { code, outcomeUnknown: false });

// The caller supplies an official frontend reader and owns both connections.
// This controller correlates actual IDs, never text, timestamps or list order.
// It cannot discover a pair, create an owner, send a message or change settings.
export function createCloudInterruptController({ desktop, frontendId, readConversation, timeoutMs = 20000, signal } = {}) {
  if (!desktop || typeof desktop.requestFollower !== 'function' || !uuid(desktop.threadId) ||
      desktop.hostId !== 'durable' || !uuid(frontendId) || typeof readConversation !== 'function') {
    throw new TypeError('An attached durable client, frontend ID and official conversation reader are required.');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new TypeError('Invalid timeoutMs.');
  frontendId = frontendId.toLowerCase();
  const threadId = desktop.threadId;
  let pending = false;

  const selectedTurn = turnId => {
    if (!desktop.status?.ready || desktop.hostId !== 'durable' || desktop.threadId !== threadId ||
        desktop.state?.id !== threadId || desktop.state?.hostId !== 'durable' ||
        !validId(desktop.currentOwner?.clientId)) {
      throw failure('NOT_READY', 'The original cloud owner is unavailable. No interrupt was sent.');
    }
    const turn = orderedDesktopTurns(desktop.state).find(value => value.turnId === turnId);
    if (getActiveTurnId(desktop.state) !== turnId || turn?.status !== 'inProgress') {
      throw failure('TURN_CHANGED', 'The selected cloud turn is no longer active. No interrupt was sent.');
    }
    const user = turn.items?.findLast(item => item?.type === 'userMessage');
    if (!validId(user?.id) || !uuid(user?.clientId)) {
      throw failure('FRONTEND_MESSAGE_UNAVAILABLE', 'The current cloud input has no frontend message identity. No interrupt was sent.');
    }
    return { ownerId: desktop.currentOwner.clientId, frontendMessageId: user.clientId };
  };

  return async function interrupt(params) {
    if (!params || Object.keys(params).some(key => !['threadId', 'turnId'].includes(key)) ||
        params.threadId !== threadId || !validId(params.turnId)) {
      throw failure('INVALID_THREAD', 'Interrupt requires this attachment and an explicit turn.');
    }
    if (signal?.aborted) throw failure('ABORTED', 'The cloud interrupt was cancelled before sending.');
    if (pending) throw failure('INTERRUPT_PENDING', 'A cloud interrupt is already pending.');
    const before = selectedTurn(params.turnId);
    pending = true;
    let timer;
    const abort = new AbortController();
    const started = performance.now();
    const cancelled = () => abort.abort();
    signal?.addEventListener('abort', cancelled, { once: true });
    let removeAbort = () => {};
    try {
      const stopped = new Promise((_, reject) => {
        const onAbort = () => reject(failure('ABORTED', 'The cloud interrupt was cancelled before sending.'));
        abort.signal.addEventListener('abort', onAbort, { once: true });
        removeAbort = () => abort.signal.removeEventListener('abort', onAbort);
        timer = setTimeout(() => reject(failure('FRONTEND_READ_TIMEOUT', 'Frontend confirmation timed out. No interrupt was sent.')), timeoutMs);
      });
      // A late read cannot continue into a write after this race has rejected.
      const read = Promise.resolve().then(() => {
        if (abort.signal.aborted) throw failure('ABORTED', 'The cloud interrupt was cancelled before reading.');
        return readConversation(frontendId, {
          turnLimit: 10, includeOutputs: false, maxOutputCharsPerItem: 1,
        });
      }).catch(() => { throw failure('FRONTEND_STATE_UNAVAILABLE', 'The frontend conversation could not be verified. No interrupt was sent.'); });
      const frontend = await Promise.race([read, stopped]);
      clearTimeout(timer);
      removeAbort();
      if (abort.signal.aborted) throw failure('ABORTED', 'The cloud interrupt was cancelled before sending.');
      const after = selectedTurn(params.turnId);
      if (after.ownerId !== before.ownerId || after.frontendMessageId !== before.frontendMessageId) {
        throw failure('TURN_CHANGED', 'The cloud owner or current input changed during confirmation. No interrupt was sent.');
      }
      if (frontend?.thread?.id !== frontendId || frontend.thread.kind !== 'chatgpt' ||
          frontend.thread.status?.type !== 'active' || !Array.isArray(frontend.turns)) {
        throw failure('FRONTEND_STATE_UNCONFIRMED', 'The selected ChatGPT conversation is not confirmed active. No interrupt was sent.');
      }
      // Summary groups are not execution order. Match actual message identity
      // within this chat; expectedTurnId pins the native operation separately.
      const matches = frontend.turns.flatMap(turn => Array.isArray(turn?.items) ? turn.items : [])
        .filter(item => item?.type === 'userMessage' && item.id === before.frontendMessageId);
      if (matches.length !== 1) {
        throw failure('FRONTEND_MESSAGE_MISMATCH', 'The active input is not uniquely present in the original ChatGPT conversation. No interrupt was sent.');
      }
      const remaining = Math.floor(timeoutMs - (performance.now() - started));
      if (remaining < 1) throw failure('FRONTEND_READ_TIMEOUT', 'Frontend confirmation timed out. No interrupt was sent.');
      const result = await interruptCloudTurn(desktop, {
        threadId, turnId: params.turnId, frontendMessageId: before.frontendMessageId,
        timeoutMs: remaining, signal: abort.signal,
      });
      return { ...result, frontendPreflight: {
        conversationId: frontendId, messageId: before.frontendMessageId, status: 'active',
      } };
    } finally {
      clearTimeout(timer);
      removeAbort();
      signal?.removeEventListener('abort', cancelled);
      pending = false;
    }
  };
}
