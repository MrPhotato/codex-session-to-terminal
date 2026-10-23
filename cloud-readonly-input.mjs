import { StringDecoder } from 'node:string_decoder';

const ESC = '\u001b';
const PAGE_UP = `${ESC}[5~`, PAGE_DOWN = `${ESC}[6~`;
const MAX_SEQUENCE_LENGTH = 64;
const PASTE_END = `${ESC}[201~`;

// User-input channel only. Terminal device reports are handled separately by
// the terminal emulator. Do not add general CSI forwarding to this filter.
export function createCloudReadonlyInputFilter() {
  let decoder, state, sequence, allowNavigation, stringEscape, pasteEndIndex;
  const reset = () => {
    decoder = new StringDecoder('utf8'); state = 'ground'; sequence = '';
    allowNavigation = false; stringEscape = false; pasteEndIndex = 0;
  };
  reset();

  const finishCsi = () => {
    const value = sequence, allowed = allowNavigation;
    state = 'ground'; sequence = ''; allowNavigation = false;
    if (value === '200~') { state = 'paste'; pasteEndIndex = 0; return ''; }
    if (!allowed) return '';
    // Explicit modifier 1 means no modifier. Normalize it rather than passing
    // arbitrary variants through. Modified page keys and release events fail closed.
    if (value === '5~' || value === '5;1~') return PAGE_UP;
    if (value === '6~' || value === '6;1~') return PAGE_DOWN;
    if (value === '1;5H' || value === '1;5F') return `${ESC}[${value}`;
    // SGR mouse: only unmodified wheel presses, with valid one-based u16
    // coordinates. Clicks, releases, motion and modifier bits are not navigation.
    const wheel = /^<(64|65);([1-9]\d{0,4});([1-9]\d{0,4})M$/.exec(value ?? '');
    if (wheel && Number(wheel[2]) <= 65535 && Number(wheel[3]) <= 65535) {
      return wheel[1] === '64' ? PAGE_UP : PAGE_DOWN;
    }
    return '';
  };

  const push = input => {
    if (typeof input !== 'string' && !Buffer.isBuffer(input)) throw new TypeError('Expected terminal input as a Buffer or string.');
    const output = [];
    for (const char of decoder.write(Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8'))) {
      if (state === 'paste') {
        // Paste content, including navigation and control strings, never enters
        // the key parser. Only the complete framing terminator ends this mode.
        pasteEndIndex = char === PASTE_END[pasteEndIndex] ? pasteEndIndex + 1 : char === ESC ? 1 : 0;
        if (pasteEndIndex === PASTE_END.length) { state = 'ground'; pasteEndIndex = 0; }
        continue;
      }
      if (state === 'osc' || state === 'string') {
        if (char === '\u009c' || stringEscape && char === '\\' || state === 'osc' && char === '\u0007') {
          state = 'ground'; stringEscape = false;
        } else stringEscape = char === ESC;
        continue;
      }
      if (state === 'escape') {
        if (char === ESC) continue;
        if (char === '[' || char === 'O') {
          state = 'csi'; sequence = ''; if (char === 'O') allowNavigation = false;
        } else if (char === ']') { state = 'osc'; stringEscape = false; }
        else if (['P', 'X', '^', '_'].includes(char)) { state = 'string'; stringEscape = false; }
        else if (char >= ' ' && char <= '/') { state = 'escape-intermediate'; }
        else state = 'ground';
        continue;
      }
      if (state === 'escape-intermediate') {
        if (char === ESC) { state = 'escape'; allowNavigation = false; }
        else if (!(char >= ' ' && char <= '/')) state = 'ground';
        continue;
      }
      if (state === 'csi') {
        if (char === ESC) {
          // A malformed enclosing control must not turn a nested sequence into
          // a user navigation key. Consume that sequence with forwarding off.
          state = 'escape'; allowNavigation = false; sequence = ''; continue;
        }
        if (char >= '@' && char <= '~') {
          if (sequence !== null && sequence.length < MAX_SEQUENCE_LENGTH) sequence += char;
          else sequence = null;
          output.push(finishCsi());
        } else if (char >= ' ' && char <= '?' && sequence !== null && sequence.length < MAX_SEQUENCE_LENGTH) sequence += char;
        else sequence = null; // Remain in discard mode until this CSI ends.
        continue;
      }
      if (char === ESC) { state = 'escape'; allowNavigation = true; }
      else if (char === '\u009b') { state = 'csi'; sequence = ''; allowNavigation = false; }
      else if (char === '\u009d') { state = 'osc'; stringEscape = false; }
      else if (['\u0090', '\u0098', '\u009e', '\u009f'].includes(char)) { state = 'string'; stringEscape = false; }
      // All printable input, Unicode, bare control keys and unmatched suffixes
      // are discarded. A naked Escape stays buffered as one state, never sent.
    }
    return output.join('');
  };
  return Object.freeze({ push, reset });
}
