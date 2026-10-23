import { mkdtemp, writeFile, open } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { defaultCliPath, nativeTerminalError } from './cst-native-terminal.mjs';
import { createTrayLease } from './cst-terminal.mjs';
import { createSessionPresence, presenceTitle } from './cst-presence.mjs';
import { createDesktopButtonAction } from './desktop-button-action.mjs';
import { matchCloudThreadByTitle, matchesCloudTitleRead } from './cloud-title-selection.mjs';
import { decodeDesktopTitleContext, recheckDesktopTitleContext } from './desktop-title-context.mjs';
import { attachCloudWithPageRecovery } from './cloud-owner-activation.mjs';
import { parseCloudIdentityLinks, findLinkedCloudCandidate, frontendMessageEvidence, matchesCloudMessageEvidence, cloudFrontends, discoverCloudCandidate } from './cloud-identity-links.mjs';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const fail = code => Object.assign(new Error(code), { code });
const chinese = () => /^zh\b/i.test(Intl.DateTimeFormat().resolvedOptions().locale);

// Optional CST-owned, manually verified hints. Never read Desktop databases or
// infer a binding from adjacent list rows, timestamps, or similar message text.
export async function loadCloudIdentityLinks(controlDirectory) {
  let file;
  try {
    file = await open(join(dirname(dirname(controlDirectory)), 'cloud-identity-links.json'), 'r');
    const buffer = Buffer.alloc(65537);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 65536) return [];
    return parseCloudIdentityLinks(buffer.subarray(0, bytesRead).toString('utf8')) ?? [];
  } catch { return []; }
  finally { await file?.close().catch(() => {}); }
}

export function parseCloudArguments(args) {
  const values = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!['--thread', '--title-context', '--control-directory', '--powershell-path', '--backend-path', '--cli-path'].includes(key) ||
        values[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) throw fail('INVALID_ARGUMENTS');
    values[key] = args[++i];
  }
  for (const key of ['--control-directory', '--powershell-path', '--backend-path']) {
    if (!isAbsolute(values[key] ?? '')) throw fail('INVALID_ARGUMENTS');
  }
  if (values['--thread'] !== undefined && !UUID.test(values['--thread']) ||
      values['--cli-path'] !== undefined && !isAbsolute(values['--cli-path'])) throw fail('INVALID_ARGUMENTS');
  if (values['--thread'] && values['--title-context']) throw fail('INVALID_ARGUMENTS');
  return { controlDirectory: values['--control-directory'], powershellPath: values['--powershell-path'],
    backendPath: values['--backend-path'], cliPath: values['--cli-path'] ?? defaultCliPath,
    threadId: values['--thread']?.toLowerCase(), titleContext: decodeDesktopTitleContext(values['--title-context']) };
}

// Display candidates retain native cloud identities. Optional title matching
// below is only a conservative read-only suggestion, never a control identity.
export function cloudCandidates(list) {
  const result = new Map();
  for (const row of [...(list?.pinnedThreads ?? []), ...(list?.threads ?? [])]) {
    if (row?.kind !== 'codex' || row.hostId !== 'durable' || !UUID.test(row.id ?? '')) continue;
    const id = row.id.toLowerCase();
    if (!result.has(id)) result.set(id, { id, title: presenceTitle(row.title) || id, hostId: 'durable' });
  }
  return [...result.values()];
}

export async function chooseCloudThread(candidates, { input = process.stdin, output = process.stdout, signal } = {}) {
  if (!candidates.length) throw fail('NO_CLOUD_SESSIONS');
  if (signal?.aborted) throw fail('ABORTED');
  output.write(chinese() ? '选择要观看的云端会话（最近会话及置顶会话）：\n' : 'Select an online session to view (recent and pinned sessions):\n');
  candidates.forEach((row, i) => output.write(`${i + 1}. ${row.title}  [${row.id.slice(0, 8)}]\n`));
  const rl = createInterface({ input, output });
  const abort = () => rl.close();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      const answer = await new Promise((resolve, reject) => {
        const closed = () => reject(fail('ABORTED'));
        rl.once('close', closed);
        rl.question(chinese() ? '输入序号：' : 'Session number: ', value => { rl.off('close', closed); resolve(value.trim()); });
      });
      if (/^[1-9][0-9]*$/.test(answer) && Number(answer) <= candidates.length) return candidates[Number(answer) - 1].id;
      output.write(chinese() ? '请输入列表中的序号。\n' : 'Enter a number from the list.\n');
    }
  } finally { signal?.removeEventListener('abort', abort); rl.close(); }
}

export function cloudCliLaunch(options, attachment, home, environment = process.env) {
  const manifest = attachment?.manifest;
  if (!manifest?.readonly || manifest.hostId !== 'durable' ||
      ['send', 'steer', 'queue', 'interrupt'].some(key => manifest[key] !== false) ||
      attachment.state?.id !== options.threadId || !UUID.test(options.threadId ?? '') || !isAbsolute(home)) throw fail('READ_ONLY_REQUIRED');
  const endpoint = new URL(attachment.endpoint);
  if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port || endpoint.pathname !== '/' ||
      endpoint.search || endpoint.hash || endpoint.username || endpoint.password || !/^[a-f0-9]{64}$/i.test(attachment.token ?? '')) throw fail('INVALID_BRIDGE');
  const env = Object.fromEntries(Object.entries(environment).filter(([key]) =>
    /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH|PATHEXT|LANG|LC_ALL)$/i.test(key)));
  Object.assign(env, { CODEX_HOME: home, TERM: 'xterm-256color', CST_CLOUD_READ_TOKEN: attachment.token });
  return { executable: options.cliPath,
    args: ['-c', 'tui.fullscreen_transcript=true', '-c', 'tui.terminal_title=["thread-name"]',
      '-c', `log_dir=${JSON.stringify(home)}`, '--remote', attachment.endpoint,
      '--remote-auth-token-env', 'CST_CLOUD_READ_TOKEN', 'resume', options.threadId],
    options: { cwd: home, env, windowsHide: true, shell: false } };
}

export async function runCloudTerminal(options, dependencies = {}) {
  const { input = process.stdin, output = process.stdout, processEvents = process, signal,
    lease = createTrayLease(options.controlDirectory), createPresence = createSessionPresence,
    createHome = () => mkdtemp(join(options.controlDirectory, 'cloud-view-')),
    createReader = async args => (await import('./cloud-desktop-reader.mjs')).createCloudDesktopReader(args),
    createAttachment = async args => (await import('./cloud-windows-attachment.mjs')).createCloudWindowsAttachment(args),
    chooseThread = chooseCloudThread,
    recheckTitleContext = recheckDesktopTitleContext,
    runView = async (launch, settings) => (await import('./cloud-readonly-view.mjs')).runCloudReadonlyView(launch, settings),
    createButtonAction = createDesktopButtonAction,
    attachWithRecovery = attachCloudWithPageRecovery,
    loadIdentityLinks = loadCloudIdentityLinks,
    discoverCandidate = discoverCloudCandidate,
    environment = process.env,
    now = Date.now,
    writeDiagnostics = (home, value) => writeFile(join(home, 'diagnostics.json'), JSON.stringify(value, null, 2) + '\n', { flag: 'w' }),
  } = dependencies;
  if (!lease()) throw fail('TRAY_STOPPED');
  if (signal?.aborted) throw fail('ABORTED');
  const lifetime = new AbortController();
  const startedAt = now();
  const diagnostics = { version: 1, titleContextPresent: Boolean(options.titleContext), explicitThread: Boolean(options.threadId),
    contextAgeAtStartMs: Number.isSafeInteger(options.titleContext?.capturedAt) ? startedAt - options.titleContext.capturedAt : null,
    timingsMs: {}, candidateFound: null, readMatches: null, recheckPassed: null, recheckDetail: null, contextAgeAtRecheckMs: null,
    failedStage: null, outcome: 'pending' };
  let diagnosticHome, diagnosticsWritten = false;
  const measure = async (stage, action) => {
    const began = now();
    try { return await action(); }
    catch (error) { diagnostics.failedStage = stage; throw error; }
    finally { diagnostics.timingsMs[stage] = Math.max(0, now() - began); }
  };
  const publishDiagnostics = async outcome => {
    if (!diagnosticHome || diagnosticsWritten) return;
    diagnosticsWritten = true;
    diagnostics.outcome = outcome;
    diagnostics.elapsedMs = Math.max(0, now() - startedAt);
    // A bounded, content-free snapshot is written once before the picker/view.
    // Diagnostic I/O cannot turn a usable session into a connection failure.
    try { await writeDiagnostics(diagnosticHome, diagnostics); } catch {}
  };
  let reader, attachment, presence, viewer, buttonAction, closed = false, timer, stopError, rejectStopped;
  const stopped = new Promise((_, reject) => { rejectStopped = reject; });
  stopped.catch(() => {});
  const stop = error => { if (!stopError && !closed) { stopError = error; lifetime.abort(); rejectStopped(error); } };
  const shutdown = () => stop(fail('ABORTED'));
  const check = () => { if (!lease()) stop(fail('TRAY_STOPPED')); };
  const wait = promise => Promise.race([promise, stopped]);
  // Resource adoption happens in the same continuation that receives it. A
  // late setup result is closed even after this terminal has been cancelled.
  const adopt = (promise, own) => Promise.resolve(promise).then(async resource => {
    if (closed || stopError) { await resource.close(); throw stopError ?? fail('ABORTED'); }
    own(resource); return resource;
  });
  processEvents.on('SIGTERM', shutdown); processEvents.on('SIGINT', shutdown);
  signal?.addEventListener('abort', shutdown, { once: true });
  timer = setInterval(check, 2000);
  try {
    output.write(options.threadId
      ? (chinese() ? '正在连接云端只读会话…\n' : 'Connecting to the online read-only session…\n')
      : (chinese() ? '正在读取云端会话列表…\n' : 'Loading online sessions…\n'));
    const home = await wait(measure('createHome', createHome));
    diagnosticHome = home;
    await wait(adopt(measure('createReader', () => createReader({ backendPath: options.backendPath, nodePath: process.execPath,
      powershellPath: options.powershellPath, cwd: home })), value => { reader = value; }));
    let original, recoveryPlan, messageEvidence, frontendTitle;
    const threadId = options.threadId ?? await wait((async () => {
      const list = await measure('listConversations', () => reader.listConversations({ limit: 50 }));
      const titleContext = options.titleContext;
      const link = titleContext && findLinkedCloudCandidate(list, titleContext.title,
        await loadIdentityLinks(options.controlDirectory));
      if (link) {
        try {
          const frontend = await reader.readConversation(link.frontendId, { turnLimit: 1, maxOutputCharsPerItem: 1 });
          const evidence = frontendMessageEvidence(frontend, link.frontendId, titleContext.title);
          const native = evidence && await reader.readConversation(link.nativeId, { hostId: 'durable', turnLimit: 1, maxOutputCharsPerItem: 1 });
          if (evidence && native.thread?.id === link.nativeId && native.thread.kind === 'codex' && native.thread.hostId === 'durable' &&
              await recheckTitleContext(titleContext, { signal: lifetime.signal })) {
            original = native; messageEvidence = evidence; frontendTitle = titleContext.title;
            recoveryPlan = { threadId: link.nativeId, context: titleContext, linkedEvidence: evidence, nativeTitle: native.thread.title ?? null };
            diagnostics.candidateFound = true;
            await publishDiagnostics('linked-candidate');
            output.write((chinese() ? '正在核对已关联的云端会话：' : 'Verifying linked online session: ') + presenceTitle(titleContext.title) + '\n');
            return link.nativeId;
          }
        } catch { /* A stale hint never grants access or selects another ID. */ }
        if (lifetime.signal.aborted) throw fail('ABORTED');
        throw fail('CLOUD_IDENTITY_UNCONFIRMED');
      }
      const candidate = titleContext && matchCloudThreadByTitle(list, titleContext.title);
      diagnostics.candidateFound = Boolean(candidate);
      if (candidate) {
        try {
          const read = await measure('candidateRead', () => reader.readConversation(candidate, { hostId: 'durable', turnLimit: 1, maxOutputCharsPerItem: 1 }));
          diagnostics.readMatches = matchesCloudTitleRead(read, candidate, titleContext.title);
          if (diagnostics.readMatches) {
            diagnostics.contextAgeAtRecheckMs = now() - titleContext.capturedAt;
            diagnostics.recheckPassed = Boolean(await measure('titleRecheck', () => recheckTitleContext(titleContext, {
              signal: lifetime.signal,
              onDiagnostic: detail => {
                if (['expired', 'aborted', 'helper-failed', 'unavailable', 'identity-changed', 'title-changed', 'document-changed', 'matched'].includes(detail?.reason) &&
                    Number.isFinite(detail.elapsedMs) && detail.elapsedMs >= 0) {
                  diagnostics.recheckDetail = { reason: detail.reason, elapsedMs: detail.elapsedMs };
                }
              },
            })));
          }
          if (diagnostics.readMatches && diagnostics.recheckPassed) {
            original = read;
            recoveryPlan = { threadId: candidate, context: titleContext };
            await publishDiagnostics('matched');
            output.write((chinese() ? '按当前页面标题匹配：' : 'Matched current page title: ') + presenceTitle(titleContext.title) + '\n');
            return candidate;
          }
        } catch { /* Unavailable or changed candidates fall back to selection. */ }
      }
      if (lifetime.signal.aborted) throw fail('ABORTED');
      const frontends = cloudFrontends(list);
      const localTitleConflict = titleContext && [...(list.pinnedThreads ?? []), ...(list.threads ?? [])].some(row =>
        row?.title === titleContext.title && row.kind !== 'chatgpt' && !(row.kind === 'codex' && row.hostId === 'durable'));
      const matching = titleContext && !localTitleConflict ? frontends.filter(row => row.title === titleContext.title) : [];
      const resolveFrontend = async frontend => {
        output.write(chinese() ? '正在核对聊天与云端执行记录…\n' : 'Checking the chat against cloud execution records…\n');
        const result = await measure('discoverIdentity', () => discoverCandidate(list, frontend,
          (target, args) => reader.readConversation(target, args), { signal: lifetime.signal }));
        if (lifetime.signal.aborted) throw fail('ABORTED');
        if (!result) return null;
        original = result.native; messageEvidence = result.evidence; frontendTitle = result.title;
        if (titleContext && frontend.title === titleContext.title) {
          if (!await recheckTitleContext(titleContext, { signal: lifetime.signal })) throw fail('CLOUD_PAGE_CHANGED');
          recoveryPlan = { threadId: original.thread.id, context: titleContext,
            linkedEvidence: messageEvidence, nativeTitle: original.thread.title ?? null };
        }
        diagnostics.candidateFound = true;
        await publishDiagnostics('message-candidate');
        return original.thread.id;
      };
      if (!candidate && matching.length === 1) {
        const found = await resolveFrontend(matching[0]);
        if (found) return found;
      }
      await publishDiagnostics('manual-selection');
      output.write(chinese() ? '未能自动确定当前聊天，请按聊天名称选择。\n' : 'Current chat could not be identified; select its name.\n');
      const selected = await chooseThread([...frontends.map(row => ({ ...row, title: presenceTitle(row.title) })), ...cloudCandidates(list)], { input, output, signal: lifetime.signal });
      const frontend = frontends.find(row => row.id === selected);
      if (!frontend) return selected;
      const found = await resolveFrontend(frontend);
      if (!found) throw fail('CLOUD_IDENTITY_UNCONFIRMED');
      return found;
    })());
    await publishDiagnostics('explicit-thread');
    if (!UUID.test(threadId ?? '')) throw fail('INVALID_ARGUMENTS');
    original ??= await wait(reader.readConversation(threadId, { hostId: 'durable', turnLimit: 1, maxOutputCharsPerItem: 1 }));
    if (original.thread?.id !== threadId || original.thread.kind !== 'codex' || original.thread.hostId !== 'durable') throw fail('NOT_CLOUD_SESSION');
    presence = createPresence({ controlDirectory: options.controlDirectory, threadId });
    output.write('Online Session Read Only for Terminal\n');
    let identityVerified = !messageEvidence;
    const displayTitle = messageEvidence ? presenceTitle(frontendTitle) : undefined;
    const updatePresence = state => presence.updateState(displayTitle ? { ...state, title: displayTitle } : state);
    const connect = async () => {
      let ready = false, setupError;
      try {
        const value = await createAttachment({ threadId, powershellPath: options.powershellPath,
          bridgeHome: home, persistedThread: true, signal: lifetime.signal,
          onState: state => { if (!closed && identityVerified) updatePresence(state); },
          onStatus: status => { if (!closed && identityVerified) presence.updateStatus(status); },
          onError: error => { if (ready) stop(error); else setupError ??= error; },
        });
        if (setupError) { await value.close(); throw setupError; }
        if (messageEvidence && !matchesCloudMessageEvidence(value.state, threadId, messageEvidence)) {
          await value.close(); throw fail('CLOUD_IDENTITY_UNCONFIRMED');
        }
        identityVerified = true;
        updatePresence(value.state); presence.updateStatus(value.status);
        ready = true; return value;
      } catch (error) { throw setupError ?? error; }
    };
    await wait(adopt(attachWithRecovery({ connect, plan: recoveryPlan, signal: lifetime.signal,
      createNavigator: async navigateTargets => {
        // Release the initial read-only helper before starting a narrowly bound
        // one-page navigator. No extra executor is kept after the excursion.
        const oldReader = reader; reader = undefined; await oldReader.close();
        return createReader({ backendPath: options.backendPath, nodePath: process.execPath,
          powershellPath: options.powershellPath, cwd: home, navigateTargets });
      },
      onPhase: phase => {
        const lines = {
          opening: ['正在临时打开会话以建立连接，随后返回原页面…', 'Temporarily opening the session to connect, then returning to your page…'],
          'return-skipped': ['检测到页面或键鼠活动，保留你当前的页面。', 'Page or input activity detected; keeping your current page.'],
          'return-unconfirmed': ['未能确认自动返回，请在桌面端查看；终端连接保持。', 'Automatic return was not confirmed. Check Desktop; the terminal connection is retained.'],
        };
        if (lines[phase]) output.write(lines[phase][chinese() ? 0 : 1] + '\n');
      },
    }), value => { attachment = value; }));
    check(); if (stopError) throw stopError;
    const launch = cloudCliLaunch({ ...options, threadId }, attachment, home, environment);
    buttonAction = createButtonAction({ ...options, threadId, hostId: 'durable' }, { signal: lifetime.signal });
    viewer = Promise.resolve(runView(launch, { input, output, signal: lifetime.signal, displayTitle,
      onOpenDesktop: () => buttonAction.open() }));
    return await wait(viewer);
  } finally {
    await publishDiagnostics('selection-failed');
    closed = true; clearInterval(timer); lifetime.abort();
    signal?.removeEventListener('abort', shutdown);
    processEvents.off('SIGTERM', shutdown); processEvents.off('SIGINT', shutdown);
    // The view has its own bounded PTY shutdown. Let it restore the terminal
    // and release its child before main is allowed to end this wrapper process.
    try { await viewer; } catch {}
    try { await attachment?.close(); }
    finally { try { await reader?.close(); } finally { try { await buttonAction?.close(); } finally { await presence?.close(); } } }
  }
}

export function cloudTerminalError(error, locale = Intl.DateTimeFormat().resolvedOptions().locale) {
  const messages = {
    NO_CLOUD_SESSIONS: ['暂未列出可选云端会话。列表只包含最近和置顶会话，并不代表账号没有其他云聊天。', 'No online sessions are currently listed. Only recent and pinned sessions are included.'],
    NOT_CLOUD_SESSION: ['所选会话不是云端会话。', 'The selected session is not an online session.'],
    READ_ONLY_REQUIRED: ['云端终端只允许只读连接。', 'Online terminal sessions require a read-only connection.'],
    CLOUD_PAGE_CHANGED: ['页面或键鼠活动已变化，未自动跳转。请在目标聊天重新按快捷键。', 'The page or input activity changed; no automatic navigation was performed. Use the shortcut again in the intended chat.'],
    CLOUD_IDENTITY_UNCONFIRMED: ['无法核对这条云端会话的最新消息，未显示候选会话。请在桌面端打开目标聊天后重试。', 'The latest online message could not be verified. The candidate session was not displayed. Open the intended chat in Desktop and retry.'],
    UNSUPPORTED_CLOUD_PROJECTION: ['这条云会话的内容格式尚不支持终端显示，请继续在桌面端查看。', 'This online session has content not yet supported by the terminal. View it in Desktop.'],
    NO_OWNER: ['已识别这条云端会话，但当前 Work 页面未建立原生 Codex 连接。请先在桌面端的 Codex 视图打开这条会话，再连接只读终端。 (NO_OWNER)', 'The online session was identified, but its Work page has no native Codex connection. Open this session in Desktop\'s Codex view, then reconnect the read-only terminal. (NO_OWNER)'],
  };
  return messages[error?.code]?.[/^zh\b/i.test(locale) ? 0 : 1] ?? nativeTerminalError(error, locale);
}

export async function main(args = process.argv.slice(2)) {
  try {
    const options = parseCloudArguments(args);
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw fail('TERMINAL_REQUIRED');
    return await runCloudTerminal(options);
  } catch (error) {
    process.stderr.write(cloudTerminalError(error) + '\n');
    if (process.stdin.isTTY && !['TRAY_STOPPED', 'ABORTED'].includes(error.code)) {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      await new Promise(resolve => { rl.once('close', resolve); rl.question(chinese() ? '按 Enter 关闭。' : 'Press Enter to close.', () => rl.close()); });
    }
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // node-pty owns a Windows worker; all resources above are closed before
  // ending this dedicated terminal wrapper, including on abrupt CLI exit.
  const code = await main(); process.exit(code);
}
