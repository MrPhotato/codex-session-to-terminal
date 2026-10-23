import { setTimeout as delay } from 'node:timers/promises';
import { readDesktopTitleContext, restoreDesktopPage, validDesktopTitleContext } from './desktop-title-context.mjs';
import { frontendMessageEvidence } from './cloud-identity-links.mjs';

const fail = code => Object.assign(new Error(code), { code });
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(value);
const inputTick = value => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff;
const identity = (a, b) => validDesktopTitleContext(a) && validDesktopTitleContext(b) &&
  ['pid', 'window', 'started'].every(key => a[key] === b[key]);
const untouched = (source, actual) => identity(source, actual) && actual.title === source.title &&
  inputTick(source.lastInputTick) && actual.lastInputTick === source.lastInputTick;

// Navigation is an explicitly authorized UI excursion, not a passive owner
// creation request. No messages/settings/ownership claims are sent. The caller
// checks either a title-directory candidate or an inspected message-linked pair.
export async function attachCloudWithPageRecovery({ connect, plan, createNavigator,
  signal, onPhase = () => {} }, { readContext = readDesktopTitleContext, restorePage = restoreDesktopPage, now = Date.now,
  pause = milliseconds => delay(milliseconds, undefined, { signal }) } = {}) {
  const phase = value => { try { onPhase(value); } catch {} };
  const check = () => { if (signal?.aborted) throw fail('ABORTED'); };
  const wait = async milliseconds => {
    try { await pause(milliseconds); } catch (error) { check(); throw error; }
  };
  check();
  try {
    const attachment = await connect();
    if (signal?.aborted) { try { await attachment.close(); } catch {} check(); }
    return attachment;
  }
  catch (error) { if (error.code !== 'NO_OWNER' || !plan) throw error; }
  check();
  const { threadId, context, linkedEvidence, nativeTitle } = plan;
  if (!uuid(threadId) ||
      !validDesktopTitleContext(context) || !inputTick(context.lastInputTick) ||
      !Number.isSafeInteger(context.capturedAt) || now() < context.capturedAt ||
      now() - context.capturedAt > 30000) throw fail('CLOUD_PAGE_CHANGED');
  const refresh = () => readContext(context, { signal });
  const before = await refresh();
  if (!untouched(context, before) || before.documentRuntimeId !== context.documentRuntimeId) throw fail('CLOUD_PAGE_CHANGED');
  let navigator, navigated = false, opened, openedAt, connected;
  try {
    navigator = await createNavigator([threadId]);
    check();
    // Starting the helper can take time. Recheck after initialization and just
    // before the only forward dispatch, so user navigation wins that interval.
    const prepared = await navigator.readConversation(threadId, { hostId: 'durable', turnLimit: 1, maxOutputCharsPerItem: 1 });
    if (prepared?.thread?.id !== threadId || prepared.thread.kind !== 'codex' ||
        prepared.thread.hostId !== 'durable' || (linkedEvidence
          ? (prepared.thread.title ?? null) !== nativeTitle : prepared.thread.title !== context.title)) {
      throw fail('CLOUD_PAGE_CHANGED');
    }
    if (linkedEvidence) {
      if (!uuid(linkedEvidence.frontendId) || !uuid(linkedEvidence.clientMessageId)) throw fail('CLOUD_IDENTITY_UNCONFIRMED');
      const frontend = await navigator.readConversation(linkedEvidence.frontendId, { turnLimit: 1, maxOutputCharsPerItem: 1 });
      const fresh = frontendMessageEvidence(frontend, linkedEvidence.frontendId, context.title);
      if (fresh?.clientMessageId !== linkedEvidence.clientMessageId) throw fail('CLOUD_IDENTITY_UNCONFIRMED');
    }
    const current = await refresh();
    if (!untouched(context, current) || current.documentRuntimeId !== context.documentRuntimeId) throw fail('CLOUD_PAGE_CHANGED');
    check(); phase('opening');
    const result = await navigator.navigateConversation(threadId);
    if (result?.navigated !== true) throw fail('NAVIGATION_OUTCOME_UNKNOWN');
    navigated = true; openedAt = now();
    await wait(250);
    opened = await refresh();
    phase('connecting');
    // Only discovery is retried. Each attempt is a separate read-only follower
    // and cleans itself up on failure. No navigation or user input is replayed.
    for (let attempt = 0; attempt < 4; attempt++) {
      check();
      try { return connected = await connect(); }
      catch (error) {
        if (error.code !== 'NO_OWNER' || attempt === 3 || now() - openedAt >= 15000) throw error;
        await wait(350);
      }
    }
  } finally {
    if (navigated && !signal?.aborted) {
      try {
        const current = await refresh();
        const expectedOpenedTitle = linkedEvidence && nativeTitle == null
          ? ['ChatGPT', 'Codex'].includes(opened?.title) : opened?.title === (linkedEvidence ? nativeTitle : context.title);
        const openedContext = expectedOpenedTitle ? { ...context, title: opened.title } : context;
        if (now() >= openedAt && now() - openedAt <= 45000 && expectedOpenedTitle && untouched(openedContext, opened) &&
            untouched(openedContext, current) && current.documentRuntimeId === opened.documentRuntimeId) {
          // Exactly one return dispatch, and only without any keyboard/mouse
          // activity since the shortcut. Unknown results are never retried.
          // The normal Desktop navigation pushed one entry. Use its actual
          // Back control, preserving the original route instead of guessing a
          // frontend ID from a title. The native helper rechecks this exact
          // context and last-input epoch immediately before its single Invoke.
          const result = await restorePage(current, { signal });
          phase(result?.dispatched === true ? 'returned' : 'return-skipped');
        } else phase('return-skipped');
      } catch { phase('return-unconfirmed'); }
    }
    try { await navigator?.close(); } catch {}
    if (signal?.aborted && connected) { try { await connected.close(); } catch {} check(); }
  }
}
