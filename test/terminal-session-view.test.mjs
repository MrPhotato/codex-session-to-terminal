import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { runTerminalSessionView, CLOUD_READONLY_BANNER } from '../terminal-session-view.mjs';
import { runCloudReadonlyView } from '../cloud-readonly-view.mjs';

const require = createRequire(import.meta.url), { Terminal } = require('@xterm/headless');
const E = '\u001b', delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 120 && !check(); i++) await delay(5); assert.ok(check(), 'condition did not become true'); }
class Input extends EventEmitter {
  isTTY = true; isRaw = false; readableFlowing = false;
  setRawMode(value) { this.isRaw = value; } resume() { this.readableFlowing = true; } pause() { this.readableFlowing = false; }
}
class Output extends EventEmitter {
  isTTY = true; columns = 80; rows = 16; chunks = [];
  write(value) { this.chunks.push(value); return true; } get text() { return this.chunks.join(''); }
}
class Pty {
  emitter = new EventEmitter(); writes = []; resizes = []; killed = 0;
  onData(fn) { this.emitter.on('data', fn); return { dispose: () => this.emitter.off('data', fn) }; }
  onExit(fn) { this.emitter.on('exit', fn); return { dispose: () => this.emitter.off('exit', fn) }; }
  data(value) { this.emitter.emit('data', value); } write(value) { this.writes.push(value); }
  resize(cols, rows) { this.resizes.push({ cols, rows }); } pause() {} resume() {}
  kill() { this.killed++; this.emitter.emit('exit', { exitCode: 0 }); }
}
function fixture(options = {}, launchExtra = {}) {
  const input = new Input(), output = new Output(), child = new Pty(), frames = [], spawns = [];
  const abort = new AbortController();
  const { runner = runTerminalSessionView, ...settings } = options;
  const running = runner({ executable: 'codex.exe', args: ['--remote', 'ws://127.0.0.1:12345', 'resume', 'bound-thread'],
    options: { cwd: 'C:\\isolated', env: { TERM: 'dumb' } }, ...launchExtra }, {
    input, output, signal: abort.signal, frameIntervalMs: 0, shutdownTimeoutMs: 20, locale: 'en-US',
    onFrame: frame => frames.push(frame), onOpenDesktop: async () => ({ navigated: true, focusConfirmed: true }),
    spawnPty: (...args) => { spawns.push(args); return child; }, createTerminal: settings => new Terminal(settings), ...settings,
  });
  running.catch(() => {});
  return { input, output, child, frames, spawns, running,
    click() { const { left } = frames.at(-1).buttonRect; input.emit('data', `${E}[<0;${left};1M${E}[<0;${left};1m`); },
    async stop() { abort.abort(); return running; } };
}
const nativeScreen = (rows, body = 'History') => `${E}[?1049h${E}[2J${E}[1;1H${body}${E}[${rows - 3};1H› Ask Codex to do anything` +
  `${E}[${rows - 1};1HModel · cwd${E}[${rows};1H? shortcuts${E}[${rows - 3};3H${E}[?25h`;

test('local reserves one toolbar row and retains full original CLI body, args, cursor and color', async () => {
  const args = ['-c', 'custom.setting=true', '--remote', 'ws://127.0.0.1:12345', 'resume', 'bound-thread'];
  const f = fixture({}, { args }); f.child.data(nativeScreen(15, `${E}[38;2;1;2;3m中文 body${E}[0m`));
  await until(() => f.frames.some(frame => frame.lines[1] === '中文 body'));
  assert.deepEqual(f.spawns[0][1], ['-c', 'tui.fullscreen_transcript=true', '-c', 'tui.alternate_screen="always"', ...args]); assert.equal(f.spawns[0][2].rows, 15);
  const frame = f.frames.at(-1); assert.equal(frame.toolbarRows, 1); assert.equal(frame.lines[0].trim(), '[Open in ChatGPT ↗]');
  assert.equal(frame.lines[12], '› Ask Codex to do anything'); assert.equal(frame.lines[15], '? shortcuts');
  assert.equal(frame.bodyRows, 15); assert.ok(f.output.text.includes(`${E}[13;3H`)); assert.ok(f.output.text.includes(`${E}[?25h`));
  assert.ok(f.output.text.includes(`${E}[0;38;2;1;2;3m中文`)); await f.stop();
});

test('cloud wrapper adds the toolbar while preserving the readonly banner and input policy', async () => {
  const f = fixture({ runner: runCloudReadonlyView }); f.child.data(nativeScreen(15));
  await until(() => f.frames.some(frame => frame.lines[1] === 'History'));
  assert.equal(f.frames.at(-1).lines[12], CLOUD_READONLY_BANNER);
  assert.equal(f.output.text.includes('Ask Codex to do anything'), false);
  f.input.emit('data', `hello\r\u0003${E}[5~`);
  assert.equal(f.child.writes.map(String).join(''), `${E}[5~`);
  f.click(); await until(() => f.frames.some(frame => frame.navigation === 'opened'));
  assert.equal(f.child.writes.map(String).join(''), `${E}[5~`); await f.stop();
});

test('local and cloud preserve parsed CLI session titles across fragmented OSC sequences', async () => {
  for (const mode of ['local', 'readonly']) {
    const f = fixture({ mode });
    const titles = [], mirror = new Terminal({ cols: 80, rows: 16 });
    mirror.onTitleChange(value => titles.push(value));
    f.child.data(`${E}]0;支持会话 🙂 | Exam`);
    await delay(10);
    assert.equal(f.output.text.includes(`${E}]2;支持会话`), false);
    f.child.data(`ple\u0007`);
    await until(() => f.output.text.includes(`${E}]2;支持会话 🙂 | Example${E}\\`));
    f.child.data(`${E}]2;Updated session${E}`);
    f.child.data('\\');
    await until(() => f.output.text.includes(`${E}]2;Updated session${E}\\`));
    await new Promise(resolve => mirror.write(f.output.text, resolve));
    assert.deepEqual(titles, ['支持会话 🙂 | Example', 'Updated session']);
    assert.deepEqual(f.child.writes, []);
    mirror.dispose(); await f.stop();
  }
});

test('a readonly display title is sanitized initially and remains fixed across parsed CLI titles', async () => {
  const polluted = `云端\u0000\u0007\r\n${E}\u0085\u202e\u2066\u200f\u061c会话🙂`;
  const f = fixture({ runner: runCloudReadonlyView, displayTitle: polluted });
  await until(() => f.frames.length);
  const titles = [], mirror = new Terminal({ cols: 80, rows: 16 });
  mirror.onTitleChange(value => titles.push(value));
  await new Promise(resolve => mirror.write(f.output.text, resolve));
  assert.deepEqual(titles, ['云端会话🙂']);
  let offset = f.output.text.length;
  f.child.data(`${E}]0;Native default`);f.child.data(`\u0007${E}]2;Changed native title${E}\\${nativeScreen(15)}`);
  await until(() => f.frames.some(frame => frame.lines[1] === 'History'));
  await new Promise(resolve => mirror.write(f.output.text.slice(offset), resolve));
  assert.deepEqual(titles, ['云端会话🙂']);
  assert.equal(/[\u0000\u0007\u0085\u202e\u2066\u200f\u061c]/u.test(f.output.text), false);
  assert.equal(f.output.text.includes('Native default'), false);
  assert.equal(f.output.text.includes('Changed native title'), false);
  assert.deepEqual(f.child.writes, []);
  mirror.dispose();await f.stop();
});

test('local mode ignores displayTitle and preserves later official CLI title changes', async () => {
  const f = fixture({ mode: 'local', displayTitle: 'Frontend title must be ignored' });
  await until(() => f.frames.length);
  const titles = [], mirror = new Terminal({ cols: 80, rows: 16 });
  mirror.onTitleChange(value => titles.push(value));
  f.child.data(`${E}]2;Official session${E}\\${E}]2;Official updated session${E}\\`);
  await until(() => f.output.text.includes(`${E}]2;Official updated session${E}\\`));
  await new Promise(resolve => mirror.write(f.output.text, resolve));
  assert.deepEqual(titles, ['Official session', 'Official updated session']);
  assert.equal(f.output.text.includes('Frontend title must be ignored'), false);
  mirror.dispose();await f.stop();
});

test('readonly display titles retain the shared Unicode length limit without splitting emoji', async () => {
  const f = fixture({ mode: 'readonly', displayTitle: `${'中'.repeat(255)}🙂discarded` });
  const titles = [], mirror = new Terminal({ cols: 80, rows: 16 });
  mirror.onTitleChange(value => titles.push(value));
  await until(() => f.frames.length);
  await new Promise(resolve => mirror.write(f.output.text, resolve));
  assert.deepEqual(titles, [`${'中'.repeat(255)}🙂`]);
  assert.equal(f.output.text.includes('discarded'), false);
  mirror.dispose();await f.stop();
});

test('title forwarding strips controls, bounds Unicode without splitting emoji, and ignores other OSC payloads', async () => {
  const f = fixture();
  f.child.data(`${E}]2;Support\u202e\u2066\u200f\u061c center${E}\\`);
  await until(() => f.output.text.includes(`${E}]2;Support center${E}\\`));
  f.child.data(`${E}]2;${'中'.repeat(255)}🙂ignored${E}\\`);
  await until(() => f.output.text.includes(`${E}]2;${'中'.repeat(255)}🙂${E}\\`));
  assert.equal(f.output.text.includes('ignored'), false);
  assert.equal(/[\u202e\u2066\u200f\u061c]/.test(f.output.text), false);
  f.child.data(`${E}]1;icon-only${E}\\${E}]9;unrelated-control${E}\\`);
  await delay(10);
  assert.equal(f.output.text.includes('icon-only'), false);
  assert.equal(f.output.text.includes('unrelated-control'), false);
  await f.stop();
});

test('toolbar locale follows the provided system locale and narrow windows never create a wrong hit target', async () => {
  const f = fixture({ locale: 'zh-CN' }); await until(() => f.frames.length);
  assert.equal(f.frames.at(-1).lines[0].trim(), '[在ChatGPT中打开↗]');
  assert.deepEqual(f.frames.at(-1).buttonRect, { left: 63, right: 80, enabled: true });
  f.output.columns = 12; f.output.emit('resize'); await until(() => f.frames.at(-1).cols === 12);
  assert.equal(f.frames.at(-1).buttonRect, null); await f.stop();
});

test('navigation is nonreentrant, reports focus uncertainty and never writes its clicks to CLI', async () => {
  let calls = 0, resolveNavigation;
  const f = fixture({ onOpenDesktop: () => { calls++; return new Promise(resolve => { resolveNavigation = resolve; }); } });
  await until(() => f.frames.length); f.click(); f.click();
  await until(() => f.frames.some(frame => frame.navigation === 'opening'));
  assert.equal(calls, 1); assert.deepEqual(f.child.writes, []);
  resolveNavigation({ navigated: true, focusConfirmed: false });
  await until(() => f.frames.some(frame => frame.navigation === 'switch'));
  assert.ok(f.frames.at(-1).lines[0].includes('Opened; switch to ChatGPT')); await f.stop();
});

test('navigation errors keep the CLI alive and unknown outcomes prohibit a blind second click', async () => {
  for (const code of ['NAVIGATION_OUTCOME_UNKNOWN', 'NOT_OPEN']) {
    let calls = 0;
    const f = fixture({ onOpenDesktop: async () => { calls++; throw Object.assign(new Error('private detail'), { code }); } });
    await until(() => f.frames.length); f.click();
    await until(() => f.frames.some(frame => frame.navigation === (code === 'NAVIGATION_OUTCOME_UNKNOWN' ? 'unknown' : 'failed')));
    assert.equal(f.child.killed, 0); assert.equal(f.output.text.includes('private detail'), false);
    f.click(); await delay(10); assert.equal(calls, code === 'NAVIGATION_OUTCOME_UNKNOWN' ? 1 : 2); await f.stop();
  }
});

test('a deep-link dispatch reports the request separately from a confirmed page navigation', async () => {
  for (const focusConfirmed of [true, false]) {
    const f = fixture({ onOpenDesktop: async () => ({ dispatched: true, focusConfirmed }) });
    await until(() => f.frames.length); f.click();
    await until(() => f.frames.some(frame => frame.navigation === (focusConfirmed ? 'focused' : 'requested')));
    assert.equal(f.frames.some(frame => frame.navigation === 'opened'), false);
    assert.deepEqual(f.child.writes, []); await f.stop();
  }
});

test('local input retains Unicode and paste bytes, maps body selection gestures, and keeps Esc available', async () => {
  const f = fixture({ escapeDelayMs: 10 });
  f.child.data(`${E}[?1002h`); await until(() => f.output.text.includes(`${E}[?1002h`));
  const bytes = Buffer.from(`中文🙂${E}[200~${E}[<0;70;1M${E}[<0;70;1m${E}[201~\r\u0003`);
  f.input.emit('data', bytes);
  assert.deepEqual(Buffer.concat(f.child.writes.map(value => Buffer.from(value))), bytes);
  f.input.emit('data', `${E}[<0;8;3M${E}[<32;10;4M${E}[<0;10;4m`);
  assert.equal(f.child.writes.at(-1).toString(), `${E}[<0;8;2M${E}[<32;10;3M${E}[<0;10;3m`);
  f.input.emit('data', E); await until(() => f.child.writes.at(-1).toString() === E);
  assert.equal(f.frames.at(-1).navigation, 'idle'); await f.stop();
});

test('pinned emulator preserves local OSC8 cell links, copy writes and keyboard modes without forwarding geometry queries', async () => {
  const f = fixture();
  f.child.data(`${E}[?1049h${E}[2J${E}[1;1H${E}]8;;https://example.com/path${E}\\link${E}]8;;${E}\\` +
    `${E}]52;c;Y29weQ==${E}\\${E}]52;c;?${E}\\${E}[?1h${E}=${E}[?1004h${E}[?1002h${E}[?25h${E}[6 q${E}[5n${E}[6n`);
  await until(() => f.frames.some(frame => frame.lines[1] === 'link'));
  // OSC8 cells acquire underline in xterm, so the renderer correctly inserts
  // an SGR between link opening and text. Verify the rendered cell association
  // instead of requiring one particular byte ordering for equivalent styles.
  const mirror = new Terminal({ cols: 80, rows: 16, allowProposedApi: true });
  await new Promise(resolve => mirror.write(f.output.text, resolve));
  const linkedLine = mirror.buffer.active.getLine(1);
  assert.equal(linkedLine.translateToString(true).trimEnd(), 'link');
  for (let column = 0; column < 4; column++) {
    const cell = linkedLine.getCell(column);
    assert.equal(mirror._core._oscLinkService.getLinkData(cell.extended.urlId)?.uri, 'https://example.com/path');
    assert.ok(cell.isUnderline());
  }
  assert.equal(linkedLine.getCell(4).extended.urlId, 0);
  mirror.dispose();
  assert.ok(f.output.text.includes(`${E}]52;c;Y29weQ==${E}\\`)); assert.equal(f.output.text.includes(`${E}]52;c;?`), false);
  assert.ok(f.output.text.includes(`${E}[?1h`)); assert.ok(f.output.text.includes(`${E}[?1004h`)); assert.ok(f.output.text.includes(`${E}[?1002h`));
  assert.equal(f.output.text.includes(`${E}[5n`), false); assert.equal(f.output.text.includes(`${E}[6n`), false);
  assert.ok(f.child.writes.includes(`${E}[0n`)); assert.ok(f.child.writes.includes(`${E}[1;5R`));
  f.child.data(`${E}[?u${E}[>1u${E}[>4;2m`); await delay(10);
  assert.ok(f.output.text.includes(`${E}[?u`)); assert.ok(f.output.text.includes(`${E}[>1u`)); assert.ok(f.output.text.includes(`${E}[>4;2m`));
  f.input.emit('data', `${E}[?1u`); assert.equal(f.child.writes.at(-1).toString(), `${E}[?1u`);
  await f.stop(); assert.ok(f.output.text.includes(`${E}[<1u`));
});

test('resize invalidates a held toolbar press and keeps native coordinates below the fixed first row', async () => {
  let calls = 0;
  const f = fixture({ onOpenDesktop: async () => { calls++; return { navigated: true }; } });
  f.child.data(nativeScreen(15)); await until(() => f.frames.length);
  f.input.emit('data', `${E}[<0;70;1M`); f.output.columns = 90; f.output.rows = 20; f.output.emit('resize');
  f.input.emit('data', `${E}[<0;70;1m`);
  await until(() => f.frames.at(-1).rows === 20); assert.equal(calls, 0);
  assert.deepEqual(f.child.resizes, [{ cols: 90, rows: 19 }]);
  assert.equal(f.frames.at(-1).lines[0].trim(), '[Open in ChatGPT ↗]'); await f.stop();
});

test('local rejects explicit inline-history settings rather than silently losing scrollback', async () => {
  for (const args of [['--no-alt-screen'], ['--config=tui.fullscreen_transcript=false'], ['-c', 'tui.alternate_screen="never"']]) {
    const f = fixture({}, { args }); await assert.rejects(f.running, /TERMINAL_VIEW_REQUIRES/); assert.equal(f.spawns.length, 0);
  }
});
