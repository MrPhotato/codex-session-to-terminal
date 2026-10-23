import test from 'node:test';
import assert from 'node:assert/strict';
import { createTerminalSessionInput } from '../terminal-session-input.mjs';

const E = '\u001b', mouse = (button, x, y, end = 'M') => `${E}[<${button};${x};${y}${end}`;
const click = mouse(0, 70, 1) + mouse(0, 70, 1, 'm');
function setup(mode = 'local') {
  let clicks = 0;
  const input = createTerminalSessionInput({ mode, onToolbarClick: () => clicks++ });
  input.setLayout({ cols: 80, rows: 24, button: { left: 60, right: 80, enabled: true } });
  return { input, get clicks() { return clicks; } };
}

test('local text, UTF-8, IME bytes, controls and arbitrary encoded keys retain their bytes', () => {
  const f = setup(), bytes = Buffer.concat([Buffer.from(`中文🙂é\r\t\u0003\u0004${E}[1;5A${E}[13;5u`), Buffer.from([255, 254])]);
  assert.deepEqual(f.input.push(bytes), bytes);
  const split = setup();
  assert.deepEqual(Buffer.concat([...bytes].map(byte => split.input.push(Buffer.from([byte])))), bytes);
});

test('toolbar clicks work across every chunk split and never leak into the child', () => {
  const bytes = Buffer.from(click);
  for (let index = 0; index <= bytes.length; index++) {
    const f = setup();
    assert.equal(Buffer.concat([f.input.push(bytes.subarray(0, index)), f.input.push(bytes.subarray(index))]).length, 0);
    assert.equal(f.clicks, 1, `split ${index}`);
  }
});

test('only an unmodified left press/release within the same toolbar button activates it', () => {
  for (const sequence of [mouse(0, 70, 1, 'm'), mouse(2, 70, 1) + mouse(2, 70, 1, 'm'),
    mouse(8, 70, 1) + mouse(8, 70, 1, 'm'), mouse(0, 50, 1) + mouse(0, 70, 1, 'm'),
    mouse(0, 70, 1) + mouse(0, 70, 2, 'm'), mouse(0, 70, 1) + mouse(32, 71, 1) + mouse(0, 71, 1, 'm')]) {
    const f = setup(); f.input.push(sequence); assert.equal(f.clicks, 0, sequence);
  }
  const disabled = setup(); disabled.input.setLayout({ cols: 80, rows: 24, button: { left: 60, right: 80, enabled: false } });
  assert.equal(disabled.input.push(click).length, 0); assert.equal(disabled.clicks, 0);
});

test('body mouse coordinates shift by one row while modifiers and releases remain native', () => {
  const f = setup();
  assert.equal(f.input.push(mouse(0, 12, 2) + mouse(0, 12, 4, 'm') + mouse(32, 8, 5) + mouse(64, 4, 24)).toString(),
    mouse(0, 12, 1) + mouse(0, 12, 3, 'm') + mouse(32, 8, 4) + mouse(64, 4, 23));
  f.input.setBodyMouse(false); assert.equal(f.input.push(mouse(0, 12, 4)).length, 0);
  assert.equal(f.input.push(click).length, 0); assert.equal(f.clicks, 1);
});

test('a body selection released over the toolbar ends in CLI and does not activate navigation', () => {
  const f = setup();
  assert.equal(f.input.push(mouse(0, 70, 3) + mouse(0, 70, 1, 'm')).toString(), mouse(0, 70, 2) + mouse(0, 70, 1, 'm'));
  assert.equal(f.clicks, 0);
});

test('resize invalidates complete and partially received old-coordinate presses', () => {
  const f = setup(); f.input.push(mouse(0, 70, 1));
  f.input.setLayout({ cols: 90, rows: 24, button: { left: 70, right: 90 } });
  f.input.push(mouse(0, 70, 1, 'm')); assert.equal(f.clicks, 0);
  const partial = setup(); partial.input.push(`${E}[<0;70;`);
  partial.input.setLayout({ cols: 90, rows: 24, button: { left: 70, right: 90 } });
  partial.input.push(`1M${mouse(0, 70, 1, 'm')}`); assert.equal(partial.clicks, 0);
});

test('paste and control strings preserve local bytes without treating embedded clicks as actions', () => {
  for (const wrapped of [`${E}[200~中文${click}${E}[5~${E}[201~`, `${E}]0;${click}\u0007`,
    `${E}P${click}${E}\\`, `\u009dtitle${click}\u009c`]) {
    const bytes = Buffer.from(wrapped);
    for (let split = 0; split <= bytes.length; split++) {
      const f = setup();
      assert.deepEqual(Buffer.concat([f.input.push(bytes.subarray(0, split)), f.input.push(bytes.subarray(split))]), bytes);
      assert.equal(f.clicks, 0);
    }
  }
});

test('readonly permits only pages, endpoints, wheels and its explicit toolbar action', () => {
  const f = setup('readonly');
  assert.equal(f.input.push(`text\r\t\u0003${E}[A${E}[5~${E}[6~${E}[1;5H${E}[1;5F${mouse(64, 2, 5)}`).toString(),
    `${E}[5~${E}[6~${E}[1;5H${E}[1;5F${E}[5~`);
  assert.equal(f.input.push(click).length, 0); assert.equal(f.clicks, 1);
  f.input.push(`${E}[200~${click}${E}[5~${E}[201~`); assert.equal(f.clicks, 1);
  f.input.push(`\u009d${click}\u009c`); assert.equal(f.clicks, 1);
});

test('readonly selection and copy remain local and cannot be triggered from paste or control strings', () => {
  const events = [];
  const input = createTerminalSessionInput({ mode: 'readonly', onSelectionMouse: event => events.push(event),
    onCopySelection: () => events.push('copy'), onClearSelection: () => events.push('clear') });
  input.setLayout({ cols: 80, rows: 24, button: { left: 60, right: 80, enabled: true } });
  const gesture = mouse(0, 2, 3) + mouse(32, 9, 4) + mouse(0, 9, 4, 'm') + '\u0003' + mouse(2, 9, 4);
  for (const wrapped of [`${E}[200~${gesture}${E}[201~`, `${E}]0;${gesture}\u0007`, `${E}P${gesture}${E}\\`]) {
    for (const byte of Buffer.from(wrapped)) assert.equal(input.push(Buffer.from([byte])).length, 0);
    assert.deepEqual(events, []);
  }
  for (const byte of Buffer.from(gesture)) assert.equal(input.push(Buffer.from([byte])).length, 0);
  assert.deepEqual(events, [
    { x: 2, y: 3, release: false, drag: false }, { x: 9, y: 4, release: false, drag: true },
    { x: 9, y: 4, release: true, drag: false }, 'copy', 'copy',
  ]);
  input.push(E); assert.equal(input.flushEscape().length, 0); assert.equal(events.at(-1), 'clear');
});

test('bare local Esc uses explicit disambiguation; readonly never forwards it', () => {
  const f = setup(); assert.equal(f.input.push(E).length, 0); assert.equal(f.input.pendingEscape, true);
  assert.equal(f.input.flushEscape().toString(), E); assert.equal(f.input.pendingEscape, false);
  assert.equal(f.input.flushEscape().length, 0);
  const cloud = setup('readonly'); cloud.input.push(E); assert.equal(cloud.input.flushEscape().length, 0);
  const partial = setup(); partial.input.push(`${E}[`); assert.equal(partial.input.flushEscape().length, 0);
  assert.equal(partial.input.push('A').toString(), `${E}[A`);
});

test('overlong mouse controls, legacy mouse bytes and reset cannot activate a button', () => {
  const f = setup(); assert.equal(f.input.push(`${E}[<${'0'.repeat(10000)};70;1M`).length, 0);
  assert.equal(f.input.push(`${E}[M${String.fromCharCode(32, 102, 33)}`).length, 0);
  f.input.push(mouse(0, 70, 1)); f.input.reset(); f.input.push(mouse(0, 70, 1, 'm'));
  assert.equal(f.clicks, 0); assert.equal(f.input.push('still typing').toString(), 'still typing');
});
