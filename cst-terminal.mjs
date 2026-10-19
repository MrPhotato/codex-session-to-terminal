import { emitKeypressEvents } from 'node:readline';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { DesktopIpcClient } from './desktop-ipc.mjs';
import { buildView } from './cst-state.mjs';
import { verifiedDesktopTransport } from './cst-transport.mjs';
import { createQueueSender } from './cst-queue.mjs';
import { createSessionPresence } from './cst-presence.mjs';

const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export const graphemes = text => Array.from(segments.segment(text), x => x.segment);
export function safeText(value) {
  return stripVTControlCharacters(String(value ?? '')).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\t/g, '  ');
}
function cellWidth(character) {
  const point = character.codePointAt(0);
  if (/^\p{Mark}+$/u.test(character)) return 0;
  return point >= 0x1100 && (point <= 0x115f || point === 0x2329 || point === 0x232a ||
    (point >= 0x2e80 && point <= 0xa4cf) || (point >= 0xac00 && point <= 0xd7a3) ||
    (point >= 0xf900 && point <= 0xfaff) || (point >= 0xfe10 && point <= 0xfe6f) ||
    (point >= 0xff00 && point <= 0xff60) || (point >= 0xffe0 && point <= 0xffe6) ||
    point >= 0x1f000) ? 2 : 1;
}
export function wrapText(value, width) {
  const result = []; width = Math.max(1, Math.floor(width) || 1);
  for (const paragraph of safeText(value).split('\n')) {
    let line = '', cells = 0;
    for (const char of graphemes(paragraph)) {
      const size = cellWidth(char);
      if (size > width) { if (line) result.push(line); result.push(' '); line = ''; cells = 0; continue; }
      if (cells + size > width) { result.push(line); line = ''; cells = 0; }
      line += char; cells += size;
    }
    result.push(line);
  }
  return result;
}
const roleNames = { user: '你', assistant: 'Agent', tool: '工具', input: '等待输入', approval: '等待批准', queued: '排队' };
export function renderScreen(view, { columns = 80, rows = 24, draft = '', caret = 0, status = '连接中…', notice = '', offset = 0, busy = false } = {}) {
  const width = Math.max(1, (Number.isFinite(columns) ? Math.floor(columns) : 80) - 1);
  const height = Math.max(1, Number.isFinite(rows) ? Math.floor(rows) : 24);
  const draftChars = graphemes(draft);
  const beforeCaret = '> ' + draftChars.slice(0, caret).join('');
  const inputLines = wrapText(beforeCaret + '┃' + draftChars.slice(caret).join(''), width);
  const caretLine = wrapText(beforeCaret + '┃', width).length - 1;
  const input = inputLines.slice(Math.max(0, caretLine - 3), Math.max(4, caretLine + 1));
  const top = [wrapText(`CST · ${view.title || '当前聊天'} · ${view.activeTurnId ? '运行中' : '空闲'}`, width)[0], wrapText(status, width)[0]];
  const help = 'Enter 发送/补充 · Ctrl+Enter 或 Tab 排队 · Ctrl+J 换行 · Ctrl+C 退出';
  const bottom = [wrapText(notice || (view.pendingInput ? '需要审批或补充信息，请在 ChatGPT 中处理。' : 'PgUp/PgDn 浏览 · Ctrl+R 重连 · Ctrl+U 清空'), width)[0], ...input,
    wrapText(busy ? '正在提交，请稍候…' : help, width)[0]];
  const content = [];
  for (const message of view.messages ?? []) {
    content.push(wrapText(`[${roleNames[message.role] || message.role}]${message.status ? ' ' + safeText(message.status) : ''}`, width)[0]);
    content.push(...wrapText(message.text, width), '');
  }
  if (height <= top.length + bottom.length) return [...input, bottom.at(-1)].slice(0, height).map(line => '\x1b[2K' + line).join('\r\n');
  const available = height - top.length - bottom.length;
  const end = Math.max(Math.min(available, content.length), content.length - Math.max(0, offset));
  const body = content.slice(Math.max(0, end - available), end);
  while (body.length < available) body.push('');
  return [...top, ...body, ...bottom].slice(0, height).map(line => '\x1b[2K' + line).join('\r\n');
}

// Each tray run has a unique directory. The identity never changes, the stop
// marker is permanent, and a stale/dead owner disables both viewing and writes.
export function createTrayLease(controlDirectory, { now = Date.now, isAlive = pid => {
  try { process.kill(pid, 0); return true; } catch { return false; }
}, maxAgeMs = 8000 } = {}) {
  if (!isAbsolute(controlDirectory ?? '')) throw new Error('A tray control directory is required.');
  let identity;
  return () => {
    try {
      if (existsSync(join(controlDirectory, 'stop.flag'))) return false;
      const ownerFile = join(controlDirectory, 'owner.json');
      if (statSync(ownerFile).size > 1024) return false;
      const owner = JSON.parse(readFileSync(ownerFile, 'utf8').replace(/^\uFEFF/, ''));
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.startTicks !== 'string' || !/^\d{17,19}$/.test(owner.startTicks)) return false;
      const nextIdentity = `${owner.pid}:${owner.startTicks}`;
      if (identity && identity !== nextIdentity) return false;
      const age = now() - statSync(join(controlDirectory, 'heartbeat')).mtimeMs;
      if (age < -2000 || age > maxAgeMs || !isAlive(owner.pid)) return false;
      identity = nextIdentity;
      return true;
    } catch { return false; }
  };
}

export function keyAction(key = {}, pasted = false) {
  if (pasted) return 'paste';
  if (key.sequence === '\x1b[13;5u' || key.sequence === '\x1b[27;5;13~' || (key.ctrl && ['return', 'enter'].includes(key.name))) return 'queue';
  if (key.ctrl && key.name === 'c') return 'quit';
  if (key.ctrl && key.name === 'r') return 'reconnect';
  if (key.ctrl && key.name === 'u') return 'clear';
  if (key.ctrl && key.name === 'j') return 'newline';
  if (key.name === 'tab') return 'queue';
  if (key.name === 'return' || key.name === 'enter') return 'send';
  return key.name;
}

export function parseArguments(args) {
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--thread', '--control-directory', '--powershell-path', '--backend-path', '--smoke-ms'].includes(args[i]) || !args[i + 1] || values[args[i]]) throw new Error('Invalid CST terminal arguments.');
    values[args[i]] = args[i + 1];
  }
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(values['--thread'] ?? '')) throw new Error('A local thread ID is required.');
  for (const key of ['--control-directory', '--powershell-path', '--backend-path']) if (values[key] && !isAbsolute(values[key])) throw new Error(`${key} must be an absolute path.`);
  if (!values['--powershell-path']) throw new Error('A verified Desktop transport requires PowerShell.');
  if (values['--smoke-ms'] && !/^[0-9]+$/.test(values['--smoke-ms'])) throw new Error('Invalid smoke duration.');
  return values;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args), threadId = options['--thread'];
  const smokeMs = Math.min(20000, Number(options['--smoke-ms'] || 0));
  const interactive = !smokeMs;
  if (interactive && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error('CST needs an interactive terminal.');
  if (interactive && !options['--control-directory']) throw new Error('Start the terminal from the CST tray.');
  const lease = options['--control-directory'] ? createTrayLease(options['--control-directory']) : () => true;
  if (!lease()) throw new Error('The CST tray is no longer running.');
  const presence = options['--control-directory'] ? createSessionPresence({ controlDirectory: options['--control-directory'], threadId }) : null;
  let client, draft = '', pasteBuffer = '', deferredPaste = '', caret = 0, notice = '', status = '连接中…', offset = 0, busy = false, closed = false, pasted = false, renderTimer, updates = 0, connected = false, connecting = false;
  let view = { messages: [], activeTurnId: null };
  const draw = () => {
    if (!interactive || closed || renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      if (closed) return;
      process.stdout.write('\x1b[H' + renderScreen(view, { columns: process.stdout.columns, rows: process.stdout.rows, draft, caret, status, notice, offset, busy }) + '\x1b[J');
    }, 50);
  };
  const connect = async () => {
    if (connecting || closed) return;
    connecting = true; connected = false;
    let current;
    try {
      await client?.close();
      if (closed || !lease()) { await close(); return; }
      const queueSender = options['--backend-path'] ? createQueueSender(options['--backend-path']) : undefined;
      current = client = new DesktopIpcClient({
        transportFactory: verifiedDesktopTransport(options['--powershell-path']),
        queueSender: queueSender ? request => {
          if (closed || !lease()) throw new Error('The CST tray is no longer running.');
          return queueSender(request);
        } : undefined,
      });
      const isCurrent = () => !closed && client === current;
      current.on('state', state => { if (isCurrent()) { presence?.updateState(state); view = buildView(state, { limit: 100 }); updates++; draw(); } });
      current.on('status', value => {
        if (!isCurrent()) return;
        presence?.updateStatus(value);
        connected = value.ready === true;
        status = ({ ready: '已连接 ChatGPT · 同一会话实时同步', connecting: '正在连接 ChatGPT…', initializing: '正在初始化…', discovering: '正在寻找当前会话…', syncing: '正在同步会话…', 'owner-unavailable': '会话暂未就绪 · 请在 ChatGPT 打开它', disconnected: '连接已断开 · Ctrl+R 重试', closed: '连接已关闭' })[value.phase] || '正在更新连接状态…';
        draw();
      });
      current.on('error', error => { if (isCurrent()) { notice = safeText(error.message); connected = false; draw(); } });
      status = '连接中…'; draw();
      await current.connect(threadId);
      if (!isCurrent() || !lease()) { await close(); return; }
      connected = true; status = '已连接 ChatGPT · 同一会话实时同步'; draw();
    } catch (error) { if (!closed && (!current || client === current)) { status = '连接未就绪 · Ctrl+R 重试'; notice = safeText(error.message); draw(); } }
    finally { connecting = false; }
  };
  let stopTimer, rawMode = false, terminalScreen = false;
  const close = async () => {
    if (closed) return;
    closed = true; clearTimeout(renderTimer); clearInterval(stopTimer);
    process.stdin.removeListener('keypress', onKey); process.stdout.removeListener('resize', draw);
    process.stdin.removeListener('end', shutdown); process.stdin.removeListener('error', shutdown);
    process.removeListener('SIGTERM', shutdown); process.removeListener('SIGINT', shutdown);
    if (rawMode) { try { process.stdin.setRawMode(false); } catch {} rawMode = false; }
    if (interactive) process.stdin.pause();
    if (terminalScreen) { terminalScreen = false; if (!process.stdout.destroyed) process.stdout.write('\x1b[?2004l\x1b[?25h\x1b[?1049l'); }
    try { await client?.close(); } finally { await presence?.close(); }
  };
  const shutdown = () => { void close(); };
  const insert = text => {
    const chars = graphemes(draft), added = [];
    let remaining = Math.max(0, 64000 - draft.length);
    for (const char of graphemes(safeText(text))) { if (char.length > remaining) break; added.push(char); remaining -= char.length; }
    chars.splice(caret, 0, ...added); caret += added.length; draft = chars.join('');
  };
  const send = async mode => {
    if (closed || !lease()) { await close(); return; }
    if (!connected || busy || !draft.trim()) return;
    if (draft.trim() === '/quit') { await close(); return; }
    const submitted = draft;
    busy = true; notice = ''; draw();
    try {
      const result = await client.send(submitted, { mode });
      if (closed) return;
      if (draft === submitted) { draft = ''; caret = 0; }
      notice = result.action === 'queue' ? '已加入会话队列；由原会话完成当前任务后处理。' : result.action === 'steer' ? '已补充到当前任务。' : '已发送到当前会话。';
      offset = 0;
    } catch (error) { notice = safeText(error.message); }
    finally { busy = false; if (!closed && deferredPaste) { insert(deferredPaste); deferredPaste = ''; } draw(); }
  };
  const onKey = (text, key = {}) => {
    if (closed) return;
    if (key.sequence === '\x1b[200~') { pasted = true; pasteBuffer = ''; return; }
    if (key.sequence === '\x1b[201~') {
      pasted = false;
      if (busy) deferredPaste = (deferredPaste + pasteBuffer).slice(0, 64000);
      else insert(pasteBuffer);
      pasteBuffer = ''; draw(); return;
    }
    const action = keyAction(key, pasted);
    if (action === 'paste') {
      const value = ['return', 'enter'].includes(key.name) ? '\n' : text || '';
      // Readline emits each pasted character separately. Batch reconstruction
      // and grapheme segmentation until paste ends, so long pastes stay fast.
      pasteBuffer = (pasteBuffer + value).slice(0, 64000);
      return;
    }
    if (action === 'quit') { void close(); return; }
    if (action === 'reconnect') { if (!busy) void connect(); return; }
    if (action === 'pageup' || action === 'pagedown') { offset = Math.max(0, offset + (action === 'pageup' ? 1 : -1) * Math.max(3, (process.stdout.rows || 24) - 8)); draw(); return; }
    if (busy) return;
    if (action === 'send' || action === 'queue') { void send(action === 'send' ? 'steer' : 'queue'); return; }
    const chars = graphemes(draft);
    if (action === 'clear') { draft = ''; caret = 0; }
    else if (action === 'newline') insert('\n');
    else if (action === 'left') caret = Math.max(0, caret - 1);
    else if (action === 'right') caret = Math.min(chars.length, caret + 1);
    else if (action === 'home') caret = 0;
    else if (action === 'end') caret = chars.length;
    else if (action === 'backspace' && caret) { chars.splice(--caret, 1); draft = chars.join(''); }
    else if (action === 'delete') { chars.splice(caret, 1); draft = chars.join(''); }
    else if (text && !key.ctrl && !key.meta && !text.startsWith('\x1b')) insert(text);
    draw();
  };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
  // Error handlers remain attached until process termination to absorb late
  // EPIPE from an already closed terminal while child streams shut down.
  process.stdout.on('error', shutdown);
  try {
    if (interactive) {
      process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[?2004h'); terminalScreen = true;
      emitKeypressEvents(process.stdin); process.stdin.setRawMode(true); rawMode = true; process.stdin.resume();
      process.stdin.on('keypress', onKey); process.stdout.on('resize', draw);
      process.stdin.once('end', shutdown); process.stdin.once('error', shutdown);
    }
    if (options['--control-directory']) stopTimer = setInterval(() => { if (!lease()) shutdown(); }, 400);
    await connect();
    if (smokeMs) {
      await new Promise(resolve => setTimeout(resolve, smokeMs));
      const result = { connected, stateUpdates: updates, visibleMessages: view.messages.length, hasActiveTurn: !!view.activeTurnId, readOnly: true };
      await close();
      process.stdout.write(JSON.stringify(result) + '\n');
      if (!connected || !updates) process.exitCode = 1;
    }
  } catch (error) { await close(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(safeText(error.message) + '\n'); process.exitCode = 1; });
}
