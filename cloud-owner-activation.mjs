import { setTimeout as delay } from 'node:timers/promises';
import { readDesktopTitleContext, restoreDesktopPage, validDesktopTitleContext } from './desktop-title-context.mjs';
import { frontendMessageEvidence } from './cloud-identity-links.mjs';
import { orderedDesktopTurns } from './desktop-events.mjs';

const fail = code => Object.assign(new Error(code), { code });
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(value);
const inputTick = value => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff;
const identity = (a, b) => validDesktopTitleContext(a) && validDesktopTitleContext(b) &&
  ['pid', 'window', 'started'].every(key => a[key] === b[key]);
// Global input includes clicks in the newly opened terminal and other apps.
// Follow the captured Desktop window; its page checks are independent of focus.
const sameWindowTitle = (source, actual) => identity(source, actual) && actual.title === source.title;

function loadedUntitledPageTitle(attachment, threadId) {
  const state = attachment?.state;
  if (state?.id !== threadId || state.hostId !== 'durable' || state.title != null ||
      state.turnHistory?.kind !== 'canonical' ||
      state.turnHistory.history?.islands?.[0]?.olderBoundary?.status !== 'exhausted') return null;
  try {
    const first = orderedDesktopTurns(state)[0];
    const user = first?.items?.[0];
    if (first.itemsPagination?.hasLoadedOldest !== true || user?.type !== 'userMessage' ||
        user.content?.length !== 1 || user.content[0].type !== 'text') return null;
    const raw = user.content[0].text;
    // The current Desktop uses the first plain-text prompt, whitespace folded,
    // truncated to 60 UTF-16 code units. Rich Markdown/context wrappers need a
    // renderer we do not reproduce here; leave those return cases unresolved.
    if (typeof raw !== 'string' || raw.length > 4096 || /[<>{}\[\]`*_#|\\\p{Cf}]/u.test(raw)) return null;
    const text = raw.trim().replace(/\s+/gu, ' ');
    return text.length ? text.length <= 60 ? text : `${text.slice(0, 59).trimEnd()}…` : null;
  } catch { return null; }
}

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
  if (!sameWindowTitle(context, before) || before.documentRuntimeId !== context.documentRuntimeId) throw fail('CLOUD_PAGE_CHANGED');
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
    if (!sameWindowTitle(context, current) || current.documentRuntimeId !== context.documentRuntimeId) throw fail('CLOUD_PAGE_CHANGED');
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
        const fallbackTitle = linkedEvidence && nativeTitle == null ? loadedUntitledPageTitle(connected, threadId) : null;
        const allowedTitles = linkedEvidence && nativeTitle == null
          ? ['ChatGPT', 'Codex', ...(fallbackTitle ? [fallbackTitle] : [])] : [linkedEvidence ? nativeTitle : context.title];
        const expectedOpenedTitle = allowedTitles.includes(opened?.title);
        // One supported loading transition: generic page title -> the verified
        // native prompt title. An unrelated page/document still cancels Back.
        const expectedCurrentTitle = current?.title === opened?.title ||
          ['ChatGPT', 'Codex'].includes(opened?.title) && fallbackTitle != null && current?.title === fallbackTitle;
        if (linkedEvidence && nativeTitle == null && context.title !== fallbackTitle &&
            sameWindowTitle(context, opened) && sameWindowTitle(context, current) &&
            opened.documentRuntimeId === context.documentRuntimeId && current.documentRuntimeId === context.documentRuntimeId) {
          // Desktop may resolve an already-known native target to the current
          // Work page. No Back is needed, and Back would leave the user's chat.
          phase('original-page-preserved');
        } else if (now() >= openedAt && now() - openedAt <= 45000 && expectedOpenedTitle && expectedCurrentTitle &&
            sameWindowTitle({ ...context, title: opened.title }, opened) &&
            sameWindowTitle({ ...context, title: current.title }, current) && current.documentRuntimeId === opened.documentRuntimeId) {
          // Exactly one return attempt using a fresh snapshot, not the input
          // epoch from the shortcut. Unknown results are never retried.
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
