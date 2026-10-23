import { createCloudReadonlyInputFilter } from './cloud-readonly-input.mjs';

const ESC = 27, LIMIT = 256;
const PASTE_END = Buffer.from('\u001b[201~');

// Byte-preserving local input with one owned toolbar hit target. Unknown local
// keys are not re-encoded as Unicode. Only mouse coordinates are translated.
export function createTerminalSessionInput({ mode = 'local', onToolbarClick, toolbarRows = 1,
  onSelectionMouse, onCopySelection, onClearSelection } = {}) {
  if (!['local', 'readonly'].includes(mode)) throw new TypeError('Invalid terminal mode.');
  const readonly = mode === 'readonly', filter = createCloudReadonlyInputFilter();
  let state = 'ground', sequence = [], stringEsc = false, stringOsc = false, pasteEnd = 0, utf8C1Prefix = false;
  let layout = { cols: 0, rows: 0, button: null }, generation = 0, sequenceGeneration = 0, pressed = null, bodyMouse = true, bodyPressed = false;
  const isHit = (x, y) => y === 1 && layout.button?.enabled !== false &&
    x >= layout.button?.left && x <= layout.button?.right;
  const emitMouse = (value, output) => {
    const event = /^\u001b\[<(\d{1,5});(\d{1,5});(\d{1,5})([Mm])$/.exec(value);
    if (!event) return;
    const button = Number(event[1]), x = Number(event[2]), y = Number(event[3]), release = event[4] === 'm';
    if (!x || !y || x > layout.cols || y > layout.rows || button > 65535) { pressed = null; return; }
    if (readonly && release && button === 0) onSelectionMouse?.({ x, y, release: true, drag: false });
    if (toolbarRows && y <= toolbarRows) {
      if (!readonly && bodyPressed && release) {
        bodyPressed = false;
        // Finish a native selection released over our toolbar; do not leave
        // the CLI believing the body mouse button is still held down.
        output.push(...Buffer.from(`\u001b[<${button};${x};1m`)); return;
      }
      if (button === 0 && !release && isHit(x, y)) pressed = generation;
      else if (button === 0 && release && pressed === generation && isHit(x, y)) {
        pressed = null; onToolbarClick?.();
      } else pressed = null;
      return;
    }
    // A toolbar press followed by a body release is not a body gesture either.
    if (pressed !== null) { pressed = null; return; }
    if (readonly && !release && [0, 32].includes(button)) {
      onSelectionMouse?.({ x, y, release: false, drag: button === 32 }); return;
    }
    if (readonly && button === 2 && !release) { onCopySelection?.(); return; }
    if (!bodyMouse && !readonly) return;
    if (!readonly && (button & 96) === 0) bodyPressed = !release;
    output.push(...Buffer.from(`\u001b[<${button};${x};${y - toolbarRows}${event[4]}`));
  };
  const finishCsi = output => {
    const value = Buffer.from(sequence).toString('ascii');
    if (value === '\u001b[200~') { state = 'paste'; pasteEnd = 0; output.push(...sequence); }
    else {
      state = 'ground';
      if (value.startsWith('\u001b[<')) { if (sequenceGeneration === generation) emitMouse(value, output); }
      else if (value !== '\u001b[M') output.push(...sequence);
      else state = 'x10-discard'; // We requested SGR; do not misroute legacy coordinates.
    }
    sequence = [];
  };
  const filtered = output => {
    const bytes = Buffer.from(output);
    return readonly ? Buffer.from(filter.push(bytes)) : bytes;
  };
  return Object.freeze({
    setLayout(next) {
      const button = next.button ? { ...next.button } : null;
      if (next.cols !== layout.cols || next.rows !== layout.rows ||
        JSON.stringify(button) !== JSON.stringify(layout.button)) { generation++; pressed = null; bodyPressed = false; }
      layout = { cols: next.cols, rows: next.rows, button };
    },
    setBodyMouse(enabled) { bodyMouse = enabled === true; },
    get pendingEscape() { return state === 'escape' && sequence.length === 1; },
    // Like a terminal key decoder, local bare Esc needs a short disambiguation
    // interval. The view owns that timer; readonly Esc is never forwarded.
    flushEscape() {
      if (state !== 'escape' || sequence.length !== 1) return Buffer.alloc(0);
      state = 'ground'; sequence = [];
      if (readonly) onClearSelection?.();
      return readonly ? Buffer.alloc(0) : Buffer.from([ESC]);
    },
    push(input) {
      if (typeof input !== 'string' && !Buffer.isBuffer(input)) throw new TypeError('Expected terminal input as a Buffer or string.');
      const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input), output = [];
      for (const byte of bytes) {
        if (state === 'paste') {
          output.push(byte);
          pasteEnd = byte === PASTE_END[pasteEnd] ? pasteEnd + 1 : byte === ESC ? 1 : 0;
          if (pasteEnd === PASTE_END.length) { state = 'ground'; pasteEnd = 0; }
          continue;
        }
        if (state === 'string') {
          output.push(byte);
          if (stringEsc && byte === 92 || stringOsc && byte === 7 || utf8C1Prefix && byte === 156) { state = 'ground'; stringEsc = false; }
          else stringEsc = byte === ESC;
          utf8C1Prefix = byte === 194;
          continue;
        }
        if (state === 'x10-discard') {
          sequence.push(byte); if (sequence.length === 3) { state = 'ground'; sequence = []; }
          continue;
        }
        if (state === 'csi-discard') { if (byte >= 64 && byte <= 126) state = 'ground'; continue; }
        if (state === 'csi' || state === 'ss3') {
          sequence.push(byte);
          if (sequence.length > LIMIT) { state = 'csi-discard'; sequence = []; continue; }
          if (byte >= 64 && byte <= 126) finishCsi(output);
          continue;
        }
        if (state === 'escape') {
          sequence.push(byte);
          if (byte === 91) state = 'csi';
          else if (byte === 79) state = 'ss3';
          else if ([93, 80, 88, 94, 95].includes(byte)) {
            state = 'string'; stringOsc = byte === 93; stringEsc = false;
            output.push(...sequence); sequence = [];
          } else { output.push(...sequence); sequence = []; state = 'ground'; }
          continue;
        }
        if (utf8C1Prefix && [144, 152, 157, 158, 159].includes(byte)) {
          output.push(byte); state = 'string'; stringOsc = byte === 157; stringEsc = false;
        } else if (utf8C1Prefix && byte === 155) { sequence = [byte]; state = 'csi'; }
        else if (byte === ESC) { state = 'escape'; sequence = [ESC]; sequenceGeneration = generation; }
        else if (readonly && byte === 3) onCopySelection?.();
        else output.push(byte);
        utf8C1Prefix = byte === 194;
      }
      return filtered(output);
    },
    reset() { state = 'ground'; sequence = []; stringEsc = false; pasteEnd = 0; utf8C1Prefix = false; pressed = null; bodyPressed = false; generation++; filter.reset(); },
  });
}
