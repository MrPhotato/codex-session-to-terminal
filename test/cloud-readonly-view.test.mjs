import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { CLOUD_READONLY_BANNER, runCloudReadonlyView } from '../cloud-readonly-view.mjs';

const require = createRequire(import.meta.url), { Terminal } = require('@xterm/headless');
const ESC = '\u001b';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 100 && !check(); i++) await delay(5);
  assert.ok(check(), 'condition did not become true');
}

class Input extends EventEmitter {
  isTTY = true; isRaw = false; readableFlowing = false; rawCalls = [];
  setRawMode(value) { this.isRaw = value; this.rawCalls.push(value); }
  resume() { this.readableFlowing = true; }
  pause() { this.readableFlowing = false; }
}
class Output extends EventEmitter {
  isTTY = true; columns = 60; rows = 14; chunks = []; block = false;
  write(data) { this.chunks.push(data); return !this.block; }
  get text() { return this.chunks.join(''); }
}
class Pty {
  emitter = new EventEmitter(); writes = []; resizes = []; killed = 0; paused = 0; resumed = 0;
  onData(callback) { this.emitter.on('data', callback); return { dispose: () => this.emitter.off('data', callback) }; }
  onExit(callback) { this.emitter.on('exit', callback); return { dispose: () => this.emitter.off('exit', callback) }; }
  data(value) { this.emitter.emit('data', value); }
  exit(exitCode = 0) { this.emitter.emit('exit', { exitCode }); }
  write(value) { this.writes.push(value); }
  resize(cols, rows) { this.resizes.push({ cols, rows }); }
  pause() { this.paused++; }
  resume() { this.resumed++; }
  kill() { this.killed++; this.exit(1); }
}
function fixture(options = {}, launchOverrides = {}) {
  const input = options.input ?? new Input(), output = options.output ?? new Output(), child = new Pty();
  const controller = new AbortController(), frames = [], spawns = [], terminals = [];
  const launch = { executable: 'codex.exe', args: ['--remote', 'ws://127.0.0.1:12345', 'resume', 'thread-id'],
    options: { cwd: 'C:\\isolated', env: { TERM: 'dumb', CST_TOKEN: 'synthetic-test-token' } }, ...launchOverrides };
  const running = runCloudReadonlyView(launch, {
    input, output, signal: controller.signal, frameIntervalMs: 0, shutdownTimeoutMs: 30,
    onFrame: frame => frames.push(frame),
    spawnPty: (...args) => { spawns.push(args); return child; },
    createTerminal: settings => { const terminal = new Terminal(settings); terminals.push(terminal); return terminal; },
    ...options,
  });
  // Avoid unhandled rejections when a test deliberately exercises an error.
  running.catch(() => {});
  return { input, output, child, controller, frames, spawns, terminals, running,
    stop: async () => { controller.abort(); return running; } };
}
function screen(rows, body = 'Visible history', footer = 'EDITOR MUST NOT APPEAR') {
  return `${ESC}[?1049h${ESC}[2J${ESC}[1;1H${body}` + Array.from({ length: 4 }, (_, i) => `${ESC}[${rows - 3 + i};1H${footer} ${i}`).join('');
}
function nativeScreen(rows, body = 'Visible history') {
  return `${ESC}[?1049h${ESC}[2J${ESC}[1;1H${body}${ESC}[${rows - 3};1H› Ask Codex to do anything` +
    `${ESC}[${rows - 1};1H  Model · /cloud/workspace${ESC}[${rows};1H  ? for shortcuts`;
}

test('launch preserves original executable and connection args, forces ConPTY and non-dumb TERM', async () => {
  const f = fixture();
  assert.equal(f.spawns.length, 1);
  const [executable, args, options] = f.spawns[0];
  assert.equal(executable, 'codex.exe');
  assert.deepEqual(args, ['-c', 'tui.fullscreen_transcript=true', '-c', 'tui.alternate_screen="always"', '--remote', 'ws://127.0.0.1:12345', 'resume', 'thread-id']);
  assert.equal(options.env.TERM, 'xterm-256color'); assert.equal(options.env.CST_TOKEN, 'synthetic-test-token');
  assert.deepEqual([options.useConpty, options.useConptyDll, options.conptyInheritCursor], [true, true, false]);
  assert.equal(options.cwd, 'C:\\isolated'); assert.equal(options.cols, 60); assert.equal(options.rows, 14);
  assert.equal(await f.stop(), 130); assert.equal(f.child.killed, 1);
});

test('fullscreen override does not duplicate and incompatible screen arguments fail before starting', async () => {
  const f = fixture({}, { args: ['-c', 'tui.fullscreen_transcript=true', 'resume', 'thread-id'] });
  assert.deepEqual(f.spawns[0][1], ['-c', 'tui.alternate_screen="always"', '-c', 'tui.fullscreen_transcript=true', 'resume', 'thread-id']); await f.stop();
  for (const args of [['--no-alt-screen'], ['--no-alt-screen=true'], ['-c', 'tui.fullscreen_transcript=false']]) {
    const invalid = fixture({}, { args });
    await assert.rejects(invalid.running, /READONLY_VIEW_REQUIRES/); assert.equal(invalid.spawns.length, 0);
  }
});

test('body layout, CJK cell widths, RGB, palette and style survive while all four composer rows disappear', async () => {
  const f = fixture();
  f.child.data(screen(14, `${ESC}[1;38;2;12;34;56;48;5;17m中文A${ESC}[0m plain`));
  await until(() => f.frames.some(frame => frame.lines[0] === '中文A plain'));
  const frame = f.frames.at(-1);
  assert.equal(frame.bodyRows, 10); assert.equal(frame.lines[10], CLOUD_READONLY_BANNER);
  assert.deepEqual(frame.lines.slice(11), ['', '', '']);
  assert.equal(f.output.text.includes('EDITOR MUST NOT APPEAR'), false);
  assert.ok(f.output.text.includes(`${ESC}[0;1;38;2;12;34;56;48;5;17m中文A`));
  // Re-emulate the safe output to verify wide cells did not move following text.
  const mirror = new Terminal({ cols: 60, rows: 14, allowProposedApi: true });
  await new Promise(resolve => mirror.write(f.output.text, resolve));
  assert.equal(mirror.buffer.active.getLine(0).getCell(4).getChars(), 'A');
  assert.equal(mirror.buffer.active.getLine(10).translateToString(true), CLOUD_READONLY_BANNER);
  mirror.dispose(); await f.stop();
});

test('cloud forwards only the parsed session title while blocking raw clipboard and hyperlink controls', async () => {
  const f = fixture();
  f.child.data(screen(14, `${ESC}]0;secret-title\u0007${ESC}]52;c;c2VjcmV0\u0007${ESC}]8;;https://example.invalid/private${ESC}\\linked${ESC}]8;;${ESC}\\`));
  await until(() => f.frames.some(frame => frame.lines[0] === 'linked'));
  const titleControl = `${ESC}]2;secret-title${ESC}\\`;
  assert.ok(f.output.text.includes(titleControl));
  assert.equal(f.output.text.replace(titleControl, '').includes(`${ESC}]`), false);
  assert.equal(/c2VjcmV0|https:\/\/example/.test(f.output.text), false);
  assert.ok(f.output.text.includes('linked')); await f.stop();
});

test('only filtered navigation reaches PTY; Esc, submit, interrupt and pasted navigation do not', async () => {
  const f = fixture();
  f.input.emit('data', Buffer.from('message /quit\r\t\u0003\u0004'));
  f.input.emit('data', ESC); f.input.emit('data', '\r');
  f.input.emit('data', `${ESC}[A${ESC}[H${ESC}[200~${ESC}[5~message${ESC}[201~`);
  assert.deepEqual(f.child.writes, []);
  f.input.emit('data', `${ESC}[5`); f.input.emit('data', `~${ESC}[6~${ESC}[1;5H${ESC}[1;5F${ESC}[<64;5;5M`);
  assert.equal(f.child.writes.join(''), `${ESC}[5~${ESC}[6~${ESC}[1;5H${ESC}[1;5F${ESC}[5~`);
  assert.equal(f.child.killed, 0); await f.stop();
});

test('device reports are generated by headless terminal; user-supplied reports are discarded', async () => {
  const f = fixture();
  f.input.emit('data', `${ESC}[0n${ESC}[12;40R${ESC}[?1;2c`);
  assert.deepEqual(f.child.writes, []);
  f.child.data(`${ESC}[5n${ESC}[6n`);
  await until(() => f.child.writes.some(value => value === `${ESC}[0n`));
  assert.ok(f.child.writes.some(value => /^\u001b\[\d+;\d+R$/.test(value)));
  await f.stop();
});

test('small terminals show only wrapped exact banner and resize hint, never child body or editor', async () => {
  const output = new Output(); output.columns = 20; output.rows = 8;
  const f = fixture({ output }); f.child.data(screen(8, 'PRIVATE BODY'));
  await until(() => f.frames.length > 0);
  const frame = f.frames.at(-1);
  assert.equal(frame.compact, true); assert.equal(frame.bodyRows, 0);
  assert.equal(frame.lines.slice(0, 2).join(''), CLOUD_READONLY_BANNER);
  assert.ok(frame.lines[2].startsWith('Resize'));
  assert.equal(/PRIVATE BODY|EDITOR MUST/.test(f.output.text), false); await f.stop();
});

test('resize uses absolute redraw without newlines and blanks the former editor before a new screen arrives', async () => {
  const f = fixture(); f.child.data(nativeScreen(14));
  await until(() => f.frames.some(frame => frame.lines[0] === 'Visible history'));
  f.output.rows = 20; f.output.columns = 70; f.output.emit('resize');
  await until(() => f.frames.some(frame => frame.rows === 20));
  assert.deepEqual(f.child.resizes, [{ cols: 70, rows: 20 }]);
  assert.equal(f.frames.at(-1).lines.filter(Boolean).join(''), CLOUD_READONLY_BANNER);
  f.child.data(nativeScreen(20, 'Resized history'));
  await until(() => f.frames.some(frame => frame.lines[0] === 'Resized history'));
  assert.equal(/Ask Codex to do anything|\n|\r/.test(f.output.text), false);
  assert.equal(f.frames.at(-1).lines[16], CLOUD_READONLY_BANNER); await f.stop();
});

test('output backpressure keeps only the newest screen and resumes on drain', async () => {
  const f = fixture(); await until(() => f.frames.length > 0);
  f.output.block = true; f.child.data(screen(14, 'blocked frame'));
  await until(() => f.frames.some(frame => frame.lines[0] === 'blocked frame'));
  const count = f.output.chunks.length;
  for (let i = 0; i < 100; i++) f.child.data(`${ESC}[1;1H${ESC}[2Klatest ${i}`);
  await delay(40); assert.equal(f.output.chunks.length, count);
  f.output.block = false; f.output.emit('drain');
  await until(() => f.frames.some(frame => frame.lines[0] === 'latest 99'));
  assert.equal(f.output.chunks.length, count + 1); await f.stop();
});

test('rapid output is coalesced and unchanged body rows are not repainted', async () => {
  const f = fixture({ frameIntervalMs: 40 }); f.child.data(screen(14, 'First line'));
  await until(() => f.frames.some(frame => frame.lines[0] === 'First line'));
  const before = f.output.chunks.length;
  for (let i = 0; i < 25; i++) f.child.data(`${ESC}[2;1H${ESC}[2KUpdate ${i}`);
  await until(() => f.frames.some(frame => frame.lines[1] === 'Update 24'));
  assert.equal(f.output.chunks.length, before + 1);
  assert.equal(f.output.chunks.at(-1).includes('First line'), false);
  assert.equal(f.output.chunks.at(-1).includes(CLOUD_READONLY_BANNER), false); await f.stop();
});

test('natural PTY exit drains its final output and restores terminal state without killing again', async () => {
  const input = new Input(); input.isRaw = true; input.readableFlowing = true;
  const f = fixture({ input }); f.child.data(screen(14, 'Final output')); f.child.exit(7);
  assert.equal(await f.running, 7); assert.equal(f.child.killed, 0);
  assert.ok(f.frames.some(frame => frame.lines[0] === 'Final output'));
  assert.deepEqual(input.rawCalls, [true, true]); assert.equal(input.readableFlowing, true);
  assert.equal(input.listenerCount('data'), 0); assert.equal(f.output.listenerCount('resize'), 0);
  assert.ok(f.output.text.endsWith(`${ESC}[?1049l`));
  for (const flag of ['?2004l', '?1006l', '?1000l', '?7h', '?25h']) assert.ok(f.output.text.includes(`${ESC}[${flag}`));
});

test('abort or terminal close cleans up only the owned PTY and restores previous raw/flow state', async () => {
  for (const event of ['abort', 'input-close', 'output-close']) {
    const f = fixture();
    if (event === 'abort') f.controller.abort();
    else if (event === 'input-close') f.input.emit('close'); else f.output.emit('close');
    assert.equal(await f.running, 130); assert.equal(f.child.killed, 1);
    assert.equal(f.input.isRaw, false); assert.equal(f.input.readableFlowing, false);
    assert.equal(f.child.emitter.listenerCount('data'), 0); assert.equal(f.child.emitter.listenerCount('exit'), 0);
    const count = f.child.writes.length; f.input.emit('data', `${ESC}[5~`); assert.equal(f.child.writes.length, count);
  }
});

test('pre-aborted, non-TTY and spawn failures do not leave raw or alternate-screen state behind', async () => {
  const controller = new AbortController(); controller.abort();
  const pre = fixture({ signal: controller.signal }); assert.equal(await pre.running, 130); assert.equal(pre.spawns.length, 0);
  const input = new Input(); input.isTTY = false;
  const tty = fixture({ input }); await assert.rejects(tty.running, /TERMINAL_REQUIRED/); assert.deepEqual(input.rawCalls, []);
  const failed = fixture({ spawnPty: () => { throw new Error('spawn failed'); } });
  await assert.rejects(failed.running, /spawn failed/); assert.equal(failed.output.text, ''); assert.deepEqual(failed.input.rawCalls, []);
});

test('slow terminal parsing pauses and resumes the PTY and fails boundedly if the source ignores pause', async () => {
  const pending = [];
  const f = fixture({ createTerminal: settings => {
    const terminal = new Terminal(settings);
    terminal.write = (data, callback) => pending.push(callback);
    return terminal;
  } });
  f.child.data('x'.repeat(1024 * 1024)); assert.equal(f.child.paused, 1);
  f.child.data('y'.repeat(1024)); assert.equal(f.child.paused, 1);
  pending.shift()(); assert.equal(f.child.resumed, 1); pending.shift()();
  f.child.data('z'.repeat(16 * 1024 * 1024)); assert.equal(f.child.paused, 2);
  f.child.data('overflow');
  await assert.rejects(f.running, /READONLY_VIEW_OUTPUT_LIMIT/);
  assert.equal(f.child.killed, 1); assert.equal(f.input.isRaw, false);
});

test('delayed old-size parser callbacks cannot unmask the previous editor after resize', async () => {
  const held = [], f = fixture({ createTerminal: settings => {
    const terminal = new Terminal(settings), write = terminal.write.bind(terminal);
    terminal.write = (data, callback) => write(data, () => held.push(callback));
    return terminal;
  } });
  f.child.data(screen(14)); await until(() => held.length === 1);
  f.output.rows = 20; f.output.emit('resize');
  held.shift()(); // An old-size parse completion arrives during a resize.
  await until(() => f.frames.some(frame => frame.rows === 20));
  assert.equal(f.frames.at(-1).lines.filter(Boolean).join(''), CLOUD_READONLY_BANNER);
  assert.equal(f.output.text.includes('EDITOR MUST'), false); await f.stop();
});

test('old-sized output arriving after resize stays hidden until the genuine new footer arrives', async () => {
  const f = fixture(); f.child.data(nativeScreen(14));
  await until(() => f.frames.some(frame => frame.lines[0] === 'Visible history'));
  f.output.rows = 20; f.output.emit('resize');
  f.child.data(nativeScreen(14, 'Late old-sized frame'));
  await delay(20);
  assert.equal(f.frames.at(-1).lines.filter(Boolean).join(''), CLOUD_READONLY_BANNER);
  f.child.data(`${ESC}[1;1H${ESC}[2KNew-sized body${ESC}[17;1H› Ask Codex to do anything`);
  await until(() => f.frames.some(frame => frame.lines[0] === 'New-sized body'));
  assert.equal(f.output.text.includes('Ask Codex to do anything'), false);
  assert.deepEqual(f.frames.at(-1).lines.slice(10, 14), ['', '', '', '']);
  await f.stop();
});

test('fragmented stale composer masks only its old four rows and ordinary arrow prose stays visible', async () => {
  const f = fixture(); f.child.data(nativeScreen(14));
  await until(() => f.frames.some(frame => frame.lines[0] === 'Visible history'));
  f.output.rows = 20; f.output.emit('resize');
  f.child.data(nativeScreen(20, 'Current body'));
  await until(() => f.frames.some(frame => frame.lines[0] === 'Current body'));
  f.child.data(`${ESC}[11;1H›${ESC}[15;1HPreserve after old footer`);
  await until(() => f.frames.some(frame => frame.lines[14] === 'Preserve after old footer'));
  assert.equal(f.frames.at(-1).lines[10], '');
  f.child.data(`${ESC}[11;2H Ask Code`);
  await delay(20); assert.equal(f.output.text.includes('Ask Code'), false);
  f.child.data(`${ESC}[11;1H${ESC}[2K› ordinary user history`);
  await until(() => f.frames.some(frame => frame.lines[10] === '› ordinary user history'));
  assert.equal(f.frames.at(-1).lines[14], 'Preserve after old footer');
  assert.equal(f.frames.at(-1).lines[16], CLOUD_READONLY_BANNER); await f.stop();
});

test('parse, child write and output errors restore owned resources', async () => {
  const parsed = fixture({ createTerminal: settings => {
    const terminal = new Terminal(settings);
    terminal.write = () => { throw new Error('parse error'); };
    return terminal;
  } });
  parsed.child.data('data'); await assert.rejects(parsed.running, /parse error/);
  assert.equal(parsed.child.killed, 1); assert.equal(parsed.input.isRaw, false);
  const child = fixture(); child.child.write = () => { throw new Error('write error'); };
  child.input.emit('data', `${ESC}[5~`); await assert.rejects(child.running, /write error/);
  assert.equal(child.child.killed, 1); assert.equal(child.input.isRaw, false);
  const output = fixture(); const before = output.output.chunks.length;
  output.output.emit('error', new Error('output closed')); await assert.rejects(output.running, /output closed/);
  assert.equal(output.output.chunks.length, before); assert.equal(output.child.killed, 1);
});

test('shutdown waits only a bounded time when its own PTY does not report exit', async () => {
  const f = fixture({ shutdownTimeoutMs: 10 });
  f.child.kill = () => { f.child.killed++; };
  const start = Date.now(); assert.equal(await f.stop(), 130);
  assert.ok(Date.now() - start < 1000); assert.equal(f.child.killed, 1);
  assert.equal(f.input.isRaw, false); assert.equal(f.child.emitter.listenerCount('exit'), 0);
});
