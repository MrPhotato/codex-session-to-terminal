import { createRequire } from 'node:module';
import { createTerminalSessionInput } from './terminal-session-input.mjs';

const require = createRequire(import.meta.url);
const ESC = '\u001b';
export const CLOUD_READONLY_BANNER = 'Online Session Read Only for Terminal';
const COMPOSER_ROWS = 4;
const NATIVE_EMPTY_PROMPT = 'Ask Codex to do anything';
const ENTER_VIEW = `${ESC}[?1049h${ESC}[?25l${ESC}[?7l${ESC}[?1000h${ESC}[?1006h${ESC}[?2004h${ESC}[2J${ESC}[H`;
const LEAVE_VIEW = `${ESC}[0m${ESC}[?2026l${ESC}[?2004l${ESC}[?1006l${ESC}[?1000l${ESC}[?7h${ESC}[?25h${ESC}[?1049l`;
const PARSE_PAUSE_BYTES = 1024 * 1024, PARSE_RESUME_BYTES = 256 * 1024;
const PARSE_LIMIT_BYTES = 16 * 1024 * 1024;
const failure = code => Object.assign(new Error(code), { code });

const dimensions = output => ({
  cols: Math.max(1, Math.min(1000, Math.trunc(output.columns) || 80)),
  rows: Math.max(1, Math.min(500, Math.trunc(output.rows) || 24)),
});

function safeTerminalTitle(value) {
  let title = '', length = 0;
  for (const character of value) {
    if (/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(character)) continue;
    title += character;
    if (++length === 256) break;
  }
  return title;
}

function cellStyle(cell) {
  const values = [0];
  for (const [method, code] of [['isBold', 1], ['isDim', 2], ['isItalic', 3], ['isUnderline', 4],
    ['isBlink', 5], ['isInverse', 7], ['isInvisible', 8], ['isStrikethrough', 9], ['isOverline', 53]]) {
    if (cell[method]()) values.push(code);
  }
  for (const [channel, prefix] of [['Fg', 38], ['Bg', 48]]) {
    const color = cell[`get${channel}Color`]();
    if (cell[`is${channel}RGB`]()) values.push(prefix, 2, (color >>> 16) & 255, (color >>> 8) & 255, color & 255);
    else if (cell[`is${channel}Palette`]()) values.push(prefix, 5, color);
  }
  return `${ESC}[${values.join(';')}m`;
}

function renderedLine(line, cols, terminal, local) {
  let ansi = '', text = '', previousStyle = `${ESC}[0m`, previousLink = '';
  for (let column = 0; column < cols; column++) {
    const cell = line?.getCell(column);
    if (!cell) { ansi += ' '; text += ' '; continue; }
    if (cell.getWidth() === 0) continue; // Second half of a wide CJK/emoji cell.
    // Pinned xterm 6.0 stores OSC8 IDs on CellData. Keep this narrow adapter
    // covered by real-emulator tests; raw OSC forwarding loses cell identity.
    const link = local && cell.extended?.urlId
      ? terminal._core._oscLinkService.getLinkData(cell.extended.urlId)?.uri ?? '' : '';
    const safeLink = link.length <= 8192 && !/[\u0000-\u0020\u007f-\u009f]/.test(link) ? link : '';
    if (safeLink !== previousLink) {
      if (previousLink) ansi += `${ESC}]8;;${ESC}\\`;
      if (safeLink) ansi += `${ESC}]8;;${safeLink}${ESC}\\`;
      previousLink = safeLink;
    }
    const style = cellStyle(cell);
    if (style !== previousStyle) { ansi += style; previousStyle = style; }
    // The emulator owns escape parsing. Never copy arbitrary raw controls;
    // local links above are reconstructed from the cells they actually cover.
    const chars = cell.getChars().replace(/[\u0000-\u001f\u007f-\u009f]/g, '') || ' ';
    ansi += chars; text += chars;
  }
  if (previousLink) ansi += `${ESC}]8;;${ESC}\\`;
  return { ansi, text: text.trimEnd() };
}

function terminalLine(terminal, row) {
  return terminal.buffer.active.getLine(terminal.buffer.active.baseY + row);
}

function hasCurrentComposer(terminal, rows) {
  // A resize acknowledgement is not available in the PTY stream. Require the
  // actual empty CLI composer at its new footer before exposing the resized
  // body; receiving any output alone does not establish the new geometry.
  for (let row = Math.max(0, rows - COMPOSER_ROWS); row < rows; row++) {
    if (/^[›»] +Ask Codex to do anything\s*$/.test(terminalLine(terminal, row)?.translateToString(true) ?? '')) return true;
  }
  return false;
}

function staleComposerRows(terminal, starts, bodyRows) {
  const hidden = new Set();
  for (const start of starts) {
    if (start >= bodyRows) continue;
    // Restrict matching to known old footer coordinates, and to the native
    // empty prompt (including a fragmented redraw), not arbitrary › prose.
    let found = false;
    for (let row = start; row < Math.min(start + COMPOSER_ROWS, bodyRows); row++) {
      const text = terminalLine(terminal, row)?.translateToString(true) ?? '';
      const match = /^(?:[›»] ?| {2})(.*)$/.exec(text);
      if (match && (match[1] || /^[›»]/.test(text)) &&
        (NATIVE_EMPTY_PROMPT.startsWith(match[1]) || match[1].startsWith(NATIVE_EMPTY_PROMPT))) found = true;
    }
    if (found) for (let row = start; row < Math.min(start + COMPOSER_ROWS, bodyRows); row++) hidden.add(row);
  }
  return hidden;
}

function frameFromTerminal(terminal, size, hideBody, oldComposerStarts, local) {
  const { cols, rows } = size, compact = !local && (cols < 40 || rows < 10);
  const bodyRows = local ? rows : compact ? 0 : rows - COMPOSER_ROWS;
  const staleRows = local ? new Set() : staleComposerRows(terminal, oldComposerStarts, bodyRows);
  const rendered = Array.from({ length: rows }, (_, row) => row < bodyRows && !hideBody && !staleRows.has(row)
    ? renderedLine(terminalLine(terminal, row), cols, terminal, local)
    : { ansi: '', text: '' });
  if (compact) {
    // Wrap the exact banner, rather than exposing or enabling the native editor
    // when its four-row layout cannot fit in a small terminal.
    const wrapped = CLOUD_READONLY_BANNER.match(new RegExp(`.{1,${cols}}`, 'g')) ?? [];
    for (let row = 0; row < Math.min(rows, wrapped.length); row++) rendered[row] = { ansi: wrapped[row], text: wrapped[row] };
    if (wrapped.length < rows) {
      const hint = 'Resize to at least 40 x 10.'.slice(0, cols);
      rendered[wrapped.length] = { ansi: hint, text: hint };
    }
  } else if (!local) rendered[bodyRows] = { ansi: `${ESC}[1m${CLOUD_READONLY_BANNER}`, text: CLOUD_READONLY_BANNER };
  return { cols, rows, bodyRows, compact, rendered };
}

function viewArguments(args, local) {
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string' || value.includes('\0'))) throw failure('INVALID_ARGUMENTS');
  const prefix = local ? 'TERMINAL_VIEW' : 'READONLY_VIEW';
  if (args.some(value => value === '--no-alt-screen' || value.startsWith('--no-alt-screen='))) throw failure(`${prefix}_REQUIRES_ALT_SCREEN`);
  const configs = args.flatMap((value, index) => ['-c', '--config'].includes(value) ? [args[index + 1] ?? '']
    : value.startsWith('--config=') ? [value.slice(9)] : value.startsWith('-c') && value.length > 2 ? [value.slice(2)] : []);
  const fullscreen = configs.filter(value => /^tui\.fullscreen_transcript\s*=/.test(value));
  const alternate = configs.filter(value => /^tui\.alternate_screen\s*=/.test(value));
  if (fullscreen.some(value => !/^tui\.fullscreen_transcript\s*=\s*true\s*$/.test(value))) throw failure(`${prefix}_REQUIRES_FULLSCREEN`);
  if (alternate.some(value => !/^tui\.alternate_screen\s*=\s*["']always["']\s*$/.test(value))) throw failure(`${prefix}_REQUIRES_ALT_SCREEN`);
  // Process-only overrides keep the user config untouched and ensure history
  // navigation stays owned by the CLI inside the reserved toolbar viewport.
  return [...(fullscreen.length ? [] : ['-c', 'tui.fullscreen_transcript=true']),
    ...(alternate.length ? [] : ['-c', 'tui.alternate_screen="always"']), ...args];
}

/**
 * Toolbar presentation of an unmodified CLI. The caller owns its bridge and
 * credentials. This function owns only the PTY and terminal state it creates.
 * onFrame receives safe visible text and dimensions, never raw PTY controls.
 */
export async function runTerminalSessionView(launch, {
  mode = 'local', toolbar = true, onOpenDesktop, locale = Intl.DateTimeFormat().resolvedOptions().locale,
  input = process.stdin, output = process.stdout, signal, onFrame, displayTitle,
  spawnPty = (...args) => require('node-pty').spawn(...args),
  createTerminal = options => new (require('@xterm/headless').Terminal)(options),
  frameIntervalMs = 33, shutdownTimeoutMs = 500, escapeDelayMs = 50,
} = {}) {
  if (signal?.aborted) return 130;
  if (!['local', 'readonly'].includes(mode)) throw failure('INVALID_ARGUMENTS');
  const local = mode === 'local', toolbarRows = toolbar ? 1 : 0, chinese = /^zh(?:-|$)/i.test(locale);
  const fixedTitle = !local && typeof displayTitle === 'string' ? safeTerminalTitle(displayTitle) : undefined;
  if (typeof launch?.executable !== 'string' || !launch.executable || launch.executable.includes('\0')) throw failure('INVALID_ARGUMENTS');
  const args = viewArguments(launch.args, local);
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') throw failure('TERMINAL_REQUIRED');
  const frameDelay = Math.max(0, Math.min(1000, Number(frameIntervalMs) || 0));
  const shutdownDelay = Math.max(1, Math.min(2000, Number(shutdownTimeoutMs) || 500));
  const disposables = [], oldComposerStarts = new Set();
  const previousRaw = input.isRaw === true, previousFlowing = input.readableFlowing === true;
  let outerSize = dimensions(output), size = { ...outerSize, rows: Math.max(1, outerSize.rows - toolbarRows) };
  let terminal, child, entered = false, rawChanged = false, navigation = 'idle', escapeTimer, statusTimer;
  let cursorHidden = true, lastModes = '', lastCursor = '', lastTitle, keyboardPushes = 0;
  const controls = []; let controlBytes = 0;
  let stopping = false, exited = false, completed = false, outputClosed = false;
  let dirty = false, blocked = false, timer, lastRows = [], lastFrameAt = 0;
  let pendingParseBytes = 0, parsePaused = false, hideBody = false, resizeGeneration = 0;
  let resolveCompletion, resolveExit, resolveParsed;
  const completion = new Promise(resolve => { resolveCompletion = resolve; });
  const childExit = new Promise(resolve => { resolveExit = resolve; });
  const finish = (exitCode, error) => {
    if (!completed) { completed = true; resolveCompletion({ exitCode, error }); }
  };
  const write = text => {
    if (!text || outputClosed) return;
    if (!output.write(text)) blocked = true;
  };
  const control = value => {
    if (stopping || outputClosed) return;
    if (blocked) {
      controlBytes += Buffer.byteLength(value);
      if (controlBytes > 1024 * 1024) { finish(1, failure('TERMINAL_CONTROL_OUTPUT_LIMIT')); return; }
      controls.push(value);
    } else write(value);
  };
  const updateTitle = value => {
    const title = fixedTitle ?? safeTerminalTitle(value);
    if (title !== lastTitle) { lastTitle = title; control(`${ESC}]2;${title}${ESC}\\`); }
  };
  const buttonLabel = chinese ? '[在ChatGPT中打开↗]' : '[Open in ChatGPT ↗]';
  const buttonWidth = chinese ? 18 : 19;
  const toolbarFrame = () => {
    const status = ({ opening: chinese ? '正在打开…' : 'Opening…', opened: chinese ? '已在ChatGPT中打开' : 'Opened in ChatGPT',
      switch: chinese ? '已打开，请切回ChatGPT' : 'Opened; switch to ChatGPT',
      requested: chinese ? '已请求打开，请查看ChatGPT' : 'Opening requested; check ChatGPT',
      focused: chinese ? '已切回ChatGPT' : 'Switched to ChatGPT',
      unknown: chinese ? '请先检查ChatGPT，勿重复点击' : 'Check ChatGPT before clicking again',
      failed: chinese ? '未能打开，请重试' : 'Could not open; retry' })[navigation] ?? '';
    const width = outerSize.cols, fits = width >= buttonWidth;
    const button = fits ? { left: width - buttonWidth + 1, right: width, enabled: typeof onOpenDesktop === 'function' && !['opening', 'unknown'].includes(navigation) } : null;
    let prefix = '', used = 0;
    for (const character of status) {
      const cellWidth = /[\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff\uff01-\uff60]/u.test(character) ? 2 : 1;
      if (used + cellWidth > width - (fits ? buttonWidth + 1 : 0)) break;
      prefix += character; used += cellWidth;
    }
    const gap = ' '.repeat(Math.max(0, width - used - (fits ? buttonWidth : 0)));
    return { button, text: `${prefix}${gap}${fits ? buttonLabel : ''}`,
      ansi: `${prefix}${gap}${fits ? `${ESC}[${button.enabled ? '4;36' : '2'}m${buttonLabel}${ESC}[0m` : ''}` };
  };
  const openDesktop = () => {
    if (stopping || completed || typeof onOpenDesktop !== 'function' || ['opening', 'unknown'].includes(navigation)) return;
    navigation = 'opening'; clearTimeout(statusTimer); schedule();
    Promise.resolve().then(() => {
      if (!stopping && !completed) return onOpenDesktop({ signal });
    }).then(result => {
      if (stopping || completed) return;
      navigation = result?.navigated === true ? result.focusConfirmed === true ? 'opened' : 'switch'
        : result?.dispatched === true ? result.focusConfirmed === true ? 'focused' : 'requested' : 'failed';
      schedule(); statusTimer = setTimeout(() => { navigation = 'idle'; schedule(); }, 5000);
    }, error => {
      if (stopping || completed) return;
      navigation = error?.code === 'NAVIGATION_OUTCOME_UNKNOWN' ? 'unknown' : 'failed'; schedule();
    });
  };
  const filter = createTerminalSessionInput({ mode, toolbarRows, onToolbarClick: openDesktop });
  filter.setLayout({ ...outerSize, button: toolbar ? toolbarFrame().button : null });
  const paint = () => {
    timer = undefined;
    if (stopping || blocked || !dirty || !terminal) return;
    dirty = false;
    try {
      const frame = frameFromTerminal(terminal, size, hideBody, oldComposerStarts, local), changes = [];
      const top = toolbarFrame(), rendered = (toolbar ? [top, ...frame.rendered] : frame.rendered).slice(0, outerSize.rows);
      filter.setLayout({ ...outerSize, button: toolbar ? top.button : null });
      filter.setBodyMouse(local ? terminal.modes.mouseTrackingMode !== 'none' : true);
      rendered.forEach((line, row) => {
        if (lastRows[row] !== line.ansi) changes.push(`${ESC}[${row + 1};1H${ESC}[0m${ESC}[2K${line.ansi}`);
      });
      lastRows = rendered.map(line => line.ansi); lastFrameAt = Date.now();
      const modes = terminal.modes;
      const mouse = local && modes.mouseTrackingMode === 'any' ? 1003 : local && modes.mouseTrackingMode === 'drag' ? 1002 : 1000;
      const modeOutput = local ? `${ESC}[?1${modes.applicationCursorKeysMode ? 'h' : 'l'}${ESC}${modes.applicationKeypadMode ? '=' : '>'}` +
        `${ESC}[?1004${modes.sendFocusMode ? 'h' : 'l'}${ESC}[?1000l${ESC}[?1002l${ESC}[?1003l${ESC}[?${mouse}h${ESC}[?1006h` : '';
      const cursorRow = terminal.buffer.active.cursorY + toolbarRows + 1;
      const cursorOutput = local && !cursorHidden && cursorRow <= outerSize.rows
        ? `${ESC}[${cursorRow};${Math.min(size.cols, terminal.buffer.active.cursorX + 1)}H` +
          `${ESC}[${({ block: 2, underline: 4, bar: 6 }[terminal.options.cursorStyle] ?? 2) - (terminal.options.cursorBlink ? 1 : 0)} q${ESC}[?25h`
        : `${ESC}[?25l`;
      if (changes.length || modeOutput !== lastModes || cursorOutput !== lastCursor) {
        write(`${ESC}[?2026h${ESC}[?25l${changes.join('')}${ESC}[0m` +
          `${modeOutput !== lastModes ? modeOutput : ''}${cursorOutput}${ESC}[?2026l`);
        lastModes = modeOutput; lastCursor = cursorOutput;
      }
      onFrame?.({ cols: outerSize.cols, rows: outerSize.rows, bodyRows: frame.bodyRows, compact: frame.compact, toolbarRows,
        buttonRect: toolbar ? top.button : null, navigation, lines: rendered.map(line => line.text) });
    } catch (error) { finish(1, error); }
  };
  const schedule = () => {
    dirty = true;
    if (!stopping && !blocked && !timer) timer = setTimeout(paint, Math.max(0, lastFrameAt + frameDelay - Date.now()));
  };
  const writeToChild = data => {
    if (!stopping && !completed && !exited && data?.length) {
      try { child.write(data); } catch (error) { finish(1, error); }
    }
  };
  const onInput = data => {
    try {
      clearTimeout(escapeTimer); writeToChild(filter.push(data));
      if (local && filter.pendingEscape) escapeTimer = setTimeout(() => writeToChild(filter.flushEscape()), Math.max(10, Math.min(250, escapeDelayMs)));
    } catch (error) { finish(1, error); }
  };
  const onClose = () => finish(130);
  const onOutputClose = () => { outputClosed = true; finish(130); };
  const onError = error => finish(1, error);
  const onOutputError = error => { outputClosed = true; finish(1, error); };
  const onDrain = () => {
    blocked = false;
    while (controls.length && !blocked) { const value = controls.shift(); controlBytes -= Buffer.byteLength(value); write(value); }
    schedule();
  };
  const onResize = () => {
    if (stopping || completed) return;
    const nextOuter = dimensions(output), next = { ...nextOuter, rows: Math.max(1, nextOuter.rows - toolbarRows) };
    if (nextOuter.cols === outerSize.cols && nextOuter.rows === outerSize.rows) return;
    filter.setLayout({ ...nextOuter, button: null });
    if (!local && next.rows > size.rows) oldComposerStarts.add(Math.max(0, size.rows - COMPOSER_ROWS));
    outerSize = nextOuter; size = next; lastRows = []; hideBody = !local; resizeGeneration++;
    try {
      terminal.resize(size.cols, size.rows);
      // Drop the old-sized screen before a resize repaint so its former footer
      // cannot temporarily appear among the body rows of a taller terminal.
      if (!local) terminal.write(`${ESC}[2J${ESC}[H`, () => { if (!stopping) schedule(); });
      child.resize(size.cols, size.rows); schedule();
    } catch (error) { finish(1, error); }
  };
  const bounded = async promise => {
    let timeout;
    try { await Promise.race([promise, new Promise(resolve => { timeout = setTimeout(resolve, shutdownDelay); })]); }
    finally { clearTimeout(timeout); }
  };

  try {
    terminal = createTerminal({ ...size, allowProposedApi: true, scrollback: 0, logLevel: 'off' });
    if (local && typeof terminal._core?._oscLinkService?.getLinkData !== 'function') throw failure('TERMINAL_EMULATOR_INCOMPATIBLE');
    // The CLI title is terminal metadata, so repainting the screen cells alone
    // loses it. Rebuild only the parsed title, never forward raw OSC sequences.
    // A verified frontend title may label an otherwise unnamed cloud session.
    // It affects only this read-only view; local titles remain CLI-owned.
    disposables.push(terminal.onTitleChange(updateTitle));
    for (const final of ['h', 'l']) disposables.push(terminal.parser.registerCsiHandler({ prefix: '?', final }, params => {
      if (params.includes(25)) cursorHidden = final === 'l';
      return false;
    }));
    if (local) {
      // Copy fallback writes only; never query or read the user's clipboard.
      disposables.push(terminal.parser.registerOscHandler(52, data => {
        if (data.length <= 140000 && /^[cpqs0-7]*;[A-Za-z0-9+/]*={0,2}$/.test(data)) control(`${ESC}]52;${data}${ESC}\\`);
        return true;
      }));
      // Negotiate optional kitty keyboard support with the real terminal.
      // DSR/DA/window geometry remain exclusively emulator-owned.
      for (const prefix of ['?', '>', '<', '=']) disposables.push(terminal.parser.registerCsiHandler({ prefix, final: 'u' }, params => {
        const values = params.map(value => Array.isArray(value) ? value.join(':') : value).join(';');
        control(`${ESC}[${prefix}${prefix === '?' && values === '0' ? '' : values}u`);
        if (prefix === '>') keyboardPushes++;
        if (prefix === '<') keyboardPushes = Math.max(0, keyboardPushes - (Number(params[0]) || 1));
        return true;
      }));
      disposables.push(terminal.parser.registerCsiHandler({ prefix: '>', final: 'm' }, params => {
        if (params[0] === 4 && params.length <= 2) { control(`${ESC}[>${params.join(';')}m`); return true; }
        return false;
      }));
    }
    const env = { ...(launch.options?.env ?? process.env) };
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'TERM') delete env[key];
    env.TERM = 'xterm-256color';
    child = spawnPty(launch.executable, args, {
      cwd: launch.options?.cwd, env, name: 'xterm-256color', ...size,
      useConpty: true, useConptyDll: true, conptyInheritCursor: false,
    });
    disposables.push(child.onExit(event => {
      exited = true; resolveExit(); finish(Number.isInteger(event.exitCode) ? event.exitCode : 1);
    }));
    // Only reports created by our emulator may bypass the user-input filter.
    disposables.push(terminal.onData(writeToChild));
    disposables.push(child.onData(data => {
      if (stopping) return;
      try {
        const bytes = Buffer.byteLength(data), generation = resizeGeneration;
        pendingParseBytes += bytes;
        if (pendingParseBytes > PARSE_LIMIT_BYTES) { finish(1, failure('READONLY_VIEW_OUTPUT_LIMIT')); return; }
        if (!parsePaused && pendingParseBytes >= PARSE_PAUSE_BYTES) { parsePaused = true; child.pause(); }
        terminal.write(data, () => {
          pendingParseBytes -= bytes;
          if (stopping) return;
          try {
            if (generation === resizeGeneration && (!hideBody || hasCurrentComposer(terminal, size.rows))) hideBody = false;
            if (parsePaused && pendingParseBytes <= PARSE_RESUME_BYTES) { parsePaused = false; if (!exited) child.resume(); }
            if (!pendingParseBytes) { resolveParsed?.(); resolveParsed = undefined; }
            schedule();
          } catch (error) { finish(1, error); }
        });
      } catch (error) { finish(1, error); }
    }));
    input.setRawMode(true); rawChanged = true;
    input.on('data', onInput); input.on('end', onClose); input.on('close', onClose); input.on('error', onError);
    output.on('resize', onResize); output.on('drain', onDrain); output.on('close', onOutputClose); output.on('error', onOutputError);
    signal?.addEventListener('abort', onClose, { once: true });
    if (signal?.aborted) finish(130);
    entered = true; write(ENTER_VIEW);
    if (fixedTitle !== undefined) updateTitle(fixedTitle);
    input.resume(); schedule();
    const result = await completion;
    if (exited && pendingParseBytes) await bounded(new Promise(resolve => { resolveParsed = resolve; }));
    if (!blocked) { dirty = true; paint(); }
    if (result.error) throw result.error;
    return result.exitCode;
  } finally {
    stopping = true; clearTimeout(timer); clearTimeout(escapeTimer); clearTimeout(statusTimer); filter.reset(); controls.length = 0;
    input.off('data', onInput); input.off('end', onClose); input.off('close', onClose); input.off('error', onError);
    output.off('resize', onResize); output.off('drain', onDrain); output.off('close', onOutputClose); output.off('error', onOutputError);
    signal?.removeEventListener('abort', onClose);
    if (child && !exited) { try { child.kill(); await bounded(childExit); } catch {} }
    for (const disposable of disposables) disposable?.dispose();
    terminal?.dispose();
    if (rawChanged) { try { input.setRawMode(previousRaw); } catch {} }
    if (!previousFlowing) input.pause();
    if (entered && !outputClosed) {
      try { output.write((local ? `${ESC}]8;;${ESC}\\${ESC}[?1l${ESC}>${ESC}[?1004l${ESC}[?1002l${ESC}[?1003l${ESC}[>4;0m` +
        (keyboardPushes ? `${ESC}[<${keyboardPushes}u` : '') : '') + LEAVE_VIEW); } catch {}
    }
  }
}
