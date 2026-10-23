import { assertControlReady } from './desktop-control.mjs';
import { getActiveTurnId } from './cst-state.mjs';
import { orderedDesktopTurns } from './desktop-events.mjs';

const METHOD = 'thread-follower-interrupt-turn';
const validId = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
const attempts = new WeakMap();
const failure = (code, message) => Object.assign(new Error(message), { code, outcomeUnknown: false });
const matchingUser = (turn, frontendMessageId) => turn?.items?.some(item =>
  item?.type === 'userMessage' && validId(item.id) && item.clientId === frontendMessageId);

/**
 * One experimental native interrupt of an explicitly identified frontend turn.
 * A matching RPC plus native state is NOT independent backend or frontend proof:
 * Desktop can mark its turn interrupted after its own interrupt RPC returns.
 * This helper never sends, steers, retries, hydrates history, or changes an owner.
 */
export function interruptCloudTurn(desktop, { threadId, turnId, frontendMessageId, timeoutMs = 10000, signal } = {}) {
  for (const [name, value] of Object.entries({ threadId, turnId, frontendMessageId })) {
    if (!validId(value)) throw new TypeError(`Invalid ${name}.`);
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new TypeError('Invalid timeoutMs.');
  if (!desktop || typeof desktop.requestFollower !== 'function' || typeof desktop.on !== 'function' || typeof desktop.off !== 'function') {
    throw new TypeError('A connected Desktop client is required.');
  }
  if (signal?.aborted) throw failure('ABORTED', 'The cloud interrupt was cancelled before sending.');
  const ownerId = desktop.currentOwner?.clientId;
  const initialRevision = desktop.revision;
  const connected = () => desktop.hostId === 'durable' && desktop.threadId === threadId &&
    desktop.status?.ready === true && validId(ownerId) && desktop.currentOwner?.clientId === ownerId &&
    desktop.state?.id === threadId && desktop.state?.hostId === 'durable';
  if (!connected() || !Number.isSafeInteger(initialRevision) || initialRevision < 0) {
    throw failure('NOT_READY', 'A current durable snapshot from the original Desktop owner is required.');
  }
  assertControlReady(desktop.state);
  const activeTurn = orderedDesktopTurns(desktop.state).find(turn => turn.turnId === turnId);
  if (getActiveTurnId(desktop.state) !== turnId || activeTurn?.status !== 'inProgress') {
    throw failure('TURN_CHANGED', 'The explicitly selected cloud turn is no longer active. No interrupt was sent.');
  }
  if (!matchingUser(activeTurn, frontendMessageId)) {
    throw failure('FRONTEND_MESSAGE_MISMATCH', 'The active native turn does not identify the selected frontend message. No interrupt was sent.');
  }
  let attempt = attempts.get(desktop);
  if (!attempt) { attempt = { pending: false, turns: new Set() }; attempts.set(desktop, attempt); }
  if (attempt.pending) throw failure('INTERRUPT_PENDING', 'Wait for the pending cloud interrupt result.');
  const attemptKey = `${threadId}\0${turnId}`;
  if (attempt.turns.has(attemptKey)) throw failure('INTERRUPT_ALREADY_ATTEMPTED', 'This cloud turn already received an interrupt attempt. It will not be retried.');

  return new Promise(resolve => {
    let settled = false, nativeObserved = false, rpcConfirmed = false, rpcFailed = false, goalPauseError = false;
    const finish = (status, reason) => {
      if (settled) return;
      settled = true; clearTimeout(timer); attempt.pending = false;
      desktop.off('state', observe); desktop.off('status', checkStatus);
      signal?.removeEventListener('abort', abort);
      resolve({ status, reason, threadId, turnId, frontendMessageId, nativeObserved, rpcConfirmed,
        goalPauseError, backendConfirmed: false, frontendConfirmed: false,
        outcomeUnknown: status === 'outcome-unknown' });
    };
    const checkStatus = () => { if (!connected()) finish('outcome-unknown', 'owner-or-connection-changed'); };
    const observe = () => {
      if (settled) return;
      if (!connected()) { finish('outcome-unknown', 'owner-or-connection-changed'); return; }
      // Only state installed by the revision-checked client counts, never the
      // event argument or an optimistic restore/steering message.
      if (!Number.isSafeInteger(desktop.revision) || desktop.revision <= initialRevision) return;
      const history = desktop.state.turnHistory?.kind === 'canonical' ? desktop.state.turnHistory.history : null;
      if (history && history.islands?.at(-1)?.newerBoundary?.status !== 'exhausted') {
        finish('outcome-unknown', 'current-history-unavailable'); return;
      }
      // The exact turn can become interrupted before threadRuntimeStatus becomes
      // idle. assertControlReady is an active-turn preflight, not a stop receipt
      // check; using it here would discard this normal stopping transition.
      const turn = orderedDesktopTurns(desktop.state).find(candidate => candidate.turnId === turnId);
      if (turn?.status !== 'interrupted' || !matchingUser(turn, frontendMessageId)) return;
      nativeObserved = true;
      if (rpcConfirmed) finish('interrupted', 'matching-native-receipt-and-state');
      else if (rpcFailed) finish('outcome-unknown', 'native-state-without-matching-receipt');
    };
    const abort = () => finish('outcome-unknown', 'cancelled-after-attempt');
    const timer = setTimeout(() => {
      observe();
      finish('outcome-unknown', 'confirmation-timeout');
    }, timeoutMs);
    desktop.on('state', observe); desktop.on('status', checkStatus);
    signal?.addEventListener('abort', abort, { once: true });
    attempt.pending = true; attempt.turns.add(attemptKey);
    const failed = () => {
      if (settled) return;
      rpcFailed = true;
      observe();
    };
    try {
      // No await, discovery or hydration between validation and this single send.
      Promise.resolve(desktop.requestFollower(METHOD, {
        conversationId: threadId, mode: 'user-stop', expectedTurnId: turnId,
      })).then(response => {
        if (settled) return;
        if (!connected()) { finish('outcome-unknown', 'owner-or-connection-changed'); return; }
        const receipt = response?.result;
        if (response?.type !== 'response' || response.resultType !== 'success' || response.method !== METHOD ||
          !validId(response.requestId) || response.handledByClientId !== ownerId || receipt?.ok !== true) {
          finish('outcome-unknown', 'invalid-native-receipt'); return;
        }
        goalPauseError = receipt.goalPauseError != null;
        if (receipt.interruptedTurnId === null) { finish('not-interrupted', 'native-receipt-no-matching-turn'); return; }
        if (receipt.interruptedTurnId !== turnId) { finish('outcome-unknown', 'native-receipt-turn-mismatch'); return; }
        rpcConfirmed = true;
        observe();
      }, failed);
    } catch { failed(); }
  });
}
