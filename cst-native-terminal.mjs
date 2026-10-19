import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTrayLease } from './cst-terminal.mjs';
import { createSessionPresence } from './cst-presence.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const defaultCliPath = join(root, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
const failure = code => Object.assign(new Error(code), { code });

export function parseNativeArguments(args) {
  const values = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--check' && !values[key]) { values[key] = true; continue; }
    if (!['--thread', '--control-directory', '--powershell-path', '--backend-path', '--cli-path'].includes(key) ||
        values[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) throw failure('INVALID_ARGUMENTS');
    values[key] = args[++i];
  }
  if (!UUID.test(values['--thread'] ?? '')) throw failure('INVALID_ARGUMENTS');
  for (const key of ['--control-directory', '--powershell-path', '--backend-path']) {
    if (!isAbsolute(values[key] ?? '')) throw failure('INVALID_ARGUMENTS');
  }
  if (values['--cli-path'] !== undefined && !isAbsolute(values['--cli-path'])) throw failure('INVALID_ARGUMENTS');
  return {
    threadId: values['--thread'], controlDirectory: values['--control-directory'],
    powershellPath: values['--powershell-path'], backendPath: values['--backend-path'],
    cliPath: values['--cli-path'] ?? defaultCliPath, check: values['--check'] === true,
  };
}

// The token is passed only to the child environment. Do not copy credentials
// belonging to an older CST connection, and do not rewrite unrelated settings.
export function nativeCliLaunch(options, bridge, environment = process.env) {
  const endpoint = new URL(bridge.endpoint);
  if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port || endpoint.username || endpoint.password ||
      typeof bridge.token !== 'string' || !bridge.token || /[\r\n\0]/.test(bridge.token)) throw failure('INVALID_BRIDGE');
  const cwd = bridge.state?.latestThreadSettings?.cwd ?? bridge.state?.cwd;
  if (!isAbsolute(cwd ?? '')) throw failure('MISSING_CWD');
  const env = { ...environment };
  for (const key of Object.keys(env)) {
    if (['CST_NATIVE_TOKEN', 'CST_NATIVE_LAB_TOKEN', 'CODEX_SHARED_SESSION_TOKEN'].includes(key.toUpperCase())) delete env[key];
  }
  env.CST_NATIVE_TOKEN = bridge.token;
  return {
    executable: options.cliPath,
    args: ['-c', 'tui.keymap.composer.queue=["ctrl-enter","tab"]', '--remote', bridge.endpoint,
      '--remote-auth-token-env', 'CST_NATIVE_TOKEN', 'resume', options.threadId],
    options: { cwd, env, stdio: 'inherit', windowsHide: false, shell: false },
  };
}

const systemLocale = () => Intl.DateTimeFormat().resolvedOptions().locale;
const isChinese = locale => /^zh(?:-|$)/i.test(locale);
export function nativeTerminalError(error, locale = systemLocale()) {
  const messages = {
    INVALID_ARGUMENTS: ['启动参数无效，请从 Codex Session to Terminal 托盘重新打开终端。', 'Invalid launch arguments. Reopen the terminal from the Codex Session to Terminal tray.'],
    TRAY_STOPPED: ['Codex Session to Terminal 托盘已退出，终端连接已关闭。桌面任务会继续运行。', 'The Codex Session to Terminal tray has stopped. The terminal connection is closed; the Desktop task continues.'],
    TERMINAL_REQUIRED: ['请从 Codex Session to Terminal 托盘在交互式终端中打开会话。', 'Open this chat in an interactive terminal from the Codex Session to Terminal tray.'],
    ABORTED: ['Codex Session to Terminal 终端连接已关闭。桌面任务会继续运行。', 'The terminal connection is closed. The Desktop task continues.'],
    UNSUPPORTED_VERSION: ['当前桌面通信版本尚不兼容，请更新 Codex Session to Terminal 后重试。', 'This Desktop protocol version is not supported. Update Codex Session to Terminal and retry.'],
    SNAPSHOT_TIMEOUT: ['同步会话超时，请在桌面端打开该聊天后重试。', 'Chat synchronization timed out. Open this chat in Desktop and retry.'],
    HISTORY_TIMEOUT: ['完整历史加载超时。请保持桌面端这条聊天打开，稍后重新连接。', 'Loading the complete chat history timed out. Keep this chat open in Desktop and reconnect shortly.'],
    HISTORY_LOAD_IN_PROGRESS: ['会话历史仍在加载，请稍后重新打开终端。', 'Chat history is still loading. Reopen the terminal shortly.'],
    OWNER_UNAVAILABLE: ['找不到当前会话，请在桌面端打开该聊天后重试。', 'The current chat is unavailable. Open it in Desktop and retry.'],
    NO_OWNER: ['桌面端尚未加载这条会话，请先打开它再连接。', 'Desktop has not loaded this chat. Open it before connecting.'],
    FRAME_TOO_LARGE: ['会话数据超出了支持的通信大小，无法打开此终端。', 'The chat data exceeds the supported transport size. This terminal cannot open it.'],
    CLI_START_FAILED: ['官方 Codex CLI 启动失败，请检查 Codex Session to Terminal 安装是否完整。', 'The official Codex CLI could not start. Check that the Codex Session to Terminal installation is complete.'],
    MISSING_CWD: ['会话的工作目录尚未就绪，请在桌面端打开该聊天后重试。', 'The chat working directory is unavailable. Open the chat in Desktop and retry.'],
    PROTOCOL_SCHEMA_MISMATCH: ['会话数据与官方 CLI 协议不兼容，请更新 Codex Session to Terminal 后重试。', 'The chat data does not match the official CLI protocol. Update Codex Session to Terminal and retry.'],
  };
  const safeCode = typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : '';
  const text = (messages[safeCode] ?? ['Codex Session to Terminal 无法连接当前会话，请确认桌面端已打开该聊天后重试。',
    'Codex Session to Terminal could not connect to this chat. Open the chat in Desktop and retry.'])[isChinese(locale) ? 0 : 1];
  return safeCode ? `${text} (${safeCode})` : text;
}

export function shouldWaitOnError(error, interactive, check) {
  return interactive && !check && !['TRAY_STOPPED', 'ABORTED'].includes(error?.code);
}

async function waitForDismissal(locale) {
  try { process.stdin.setRawMode?.(false); } catch {}
  const input = createInterface({ input: process.stdin, output: process.stderr });
  await new Promise(resolve => {
    input.once('close', resolve);
    input.once('SIGINT', () => input.close());
    input.question(isChinese(locale) ? '按 Enter 关闭此终端。' : 'Press Enter to close this terminal.', () => input.close());
  });
}

// Only this wrapper's child and bridge are owned here. Closing the terminal or
// losing the tray lease must never send a turn/interrupt to the Desktop owner.
export async function runNativeTerminal(options, {
  createBridge = async args => (await import('./native-cli-bridge.mjs')).createNativeCliBridge(args),
  lease = createTrayLease(options.controlDirectory),
  createPresence = createSessionPresence,
  spawnFn = spawn,
  environment = process.env,
  processEvents = process,
  signal,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  if (!lease()) throw failure('TRAY_STOPPED');
  if (signal?.aborted) throw failure('ABORTED');
  const abort = new AbortController();
  const presence = createPresence({ controlDirectory: options.controlDirectory, threadId: options.threadId });
  let bridge, child, childDone, childExited = false, closed = false, timer, stopError, closePromise;
  let initializing = true, initialStatusError;
  let rejectStopped;
  const stopped = new Promise((_, reject) => { rejectStopped = reject; });
  // Every phase races this promise; attach a handler now for synchronous events.
  stopped.catch(() => {});
  const requestStop = error => {
    if (closed || stopError) return;
    stopError = error;
    abort.abort();
    rejectStopped(error);
  };
  const shutdown = () => requestStop(failure('ABORTED'));
  const checkLease = () => { if (!lease()) requestStop(failure('TRAY_STOPPED')); };
  const closeChild = async () => {
    if (!child || childExited) return;
    try { child.kill('SIGTERM'); } catch {}
    let timeout;
    const grace = new Promise(resolve => { timeout = setTimeoutFn(resolve, 1500); });
    await Promise.race([childDone.catch(() => {}), grace]);
    clearTimeoutFn(timeout);
    if (!childExited) { try { child.kill('SIGKILL'); } catch {} }
  };
  const close = () => {
    if (closePromise) return closePromise;
    closed = true;
    abort.abort();
    clearIntervalFn(timer);
    signal?.removeEventListener('abort', shutdown);
    processEvents.removeListener('SIGTERM', shutdown);
    processEvents.removeListener('SIGINT', shutdown);
    closePromise = (async () => {
      // Revoke the local endpoint before waiting for the owned CLI to exit.
      try { await bridge?.close(); }
      finally { try { await closeChild(); } finally { await presence.close(); } }
    })();
    return closePromise;
  };
  processEvents.on('SIGTERM', shutdown);
  processEvents.on('SIGINT', shutdown);
  signal?.addEventListener('abort', shutdown, { once: true });
  timer = setIntervalFn(checkLease, 2000);
  try {
    const pendingBridge = Promise.resolve().then(() => createBridge({
      backendPath: options.backendPath, powershellPath: options.powershellPath, threadId: options.threadId,
      allowControl: !options.check, signal: abort.signal,
      onState: state => { if (!closed && !stopError) presence.updateState(state); },
      onStatus: status => {
        if (closed || stopError) return;
        presence.updateStatus(status);
        if (['disconnected', 'closed', 'owner-unavailable'].includes(status?.phase)) {
          const code = typeof status.reason === 'string' && /^[A-Z0-9_]{1,64}$/.test(status.reason) && status.reason !== 'CLOSED'
            ? status.reason : 'OWNER_UNAVAILABLE';
          const error = failure(code);
          // Initialization failures close the Desktop client before rejecting
          // createBridge. Its cleanup statuses must not replace that original
          // schema/history/metadata error in the Promise race below. No CLI is
          // launched until initialization has succeeded without a terminal state.
          if (initializing) initialStatusError ??= error;
          else requestStop(error);
        }
      },
      onError: error => requestStop(error),
    })).then(async result => {
      // An adapter that finishes after cancellation must not leave a listener.
      if (closed || stopError) { await result.close(); throw stopError ?? failure('ABORTED'); }
      bridge = result;
      if (initialStatusError) throw initialStatusError;
      initializing = false;
      return result;
    });
    await Promise.race([pendingBridge, stopped]);
    checkLease();
    if (stopError) throw stopError;
    if (bridge.status?.ready !== true) throw failure('OWNER_UNAVAILABLE');
    presence.updateState(bridge.state);
    presence.updateStatus(bridge.status);
    if (options.check) return 0;
    const launch = nativeCliLaunch(options, bridge, environment);
    try { child = spawnFn(launch.executable, launch.args, launch.options); }
    catch { throw failure('CLI_START_FAILED'); }
    childDone = new Promise((resolve, reject) => {
      child.once('error', () => { childExited = true; reject(failure('CLI_START_FAILED')); });
      child.once('exit', (code, terminationSignal) => {
        childExited = true;
        resolve(Number.isInteger(code) ? code : terminationSignal ? 1 : 0);
      });
    });
    childDone.catch(() => {});
    return await Promise.race([childDone, stopped]);
  } finally {
    await close();
  }
}

export async function main(args = process.argv.slice(2)) {
  const locale = systemLocale();
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  try {
    const options = parseNativeArguments(args);
    if (!options.check && !interactive) throw failure('TERMINAL_REQUIRED');
    if (interactive && !options.check) process.stderr.write(isChinese(locale)
      ? '正在连接桌面会话并读取完整历史。长会话首次加载可能需要几分钟；Ctrl+C 可取消。\n'
      : 'Connecting to the Desktop chat and loading its full history. Long chats may take a few minutes on first load; Ctrl+C cancels.\n');
    process.exitCode = await runNativeTerminal(options);
    if (options.check) process.stdout.write(isChinese(locale) ? 'Codex Session to Terminal 官方 CLI 连接检查通过。\n' : 'Codex Session to Terminal official CLI connection check passed.\n');
  } catch (error) {
    process.stderr.write(nativeTerminalError(error, locale) + '\n');
    process.exitCode = 1;
    if (shouldWaitOnError(error, interactive, args.includes('--check'))) await waitForDismissal(locale);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
