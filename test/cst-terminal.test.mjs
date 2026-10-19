import test from 'node:test';
import assert from 'node:assert/strict';
import { keyAction, safeText, wrapText, renderScreen, parseArguments } from '../cst-terminal.mjs';

test('terminal strips command and OSC escape injection from displayed text', () => {
  assert.equal(safeText('hello\x1b[2J世界\x1b]52;c;c2VjcmV0\x07!'), 'hello世界!');
  assert.equal(safeText('a\u202eb'), 'ab');
});
test('Chinese and emoji wrap without splitting graphemes', () => {
  assert.deepEqual(wrapText('你好abc', 4), ['你好', 'abc']);
  assert.deepEqual(wrapText('👨‍👩‍👧‍👦abc', 4), ['👨‍👩‍👧‍👦ab', 'c']);
});
test('Enter, CtrlEnter and Tab retain distinct send/queue semantics; paste cannot submit', () => {
  assert.equal(keyAction({ name: 'return' }), 'send');
  assert.equal(keyAction({ sequence: '\x1b[13;5u' }), 'queue');
  assert.equal(keyAction({ name: 'tab' }), 'queue');
  assert.equal(keyAction({ name: 'return' }, true), 'paste');
});
test('screen render stays bounded during resize and excludes old offscreen rows', () => {
  const view = { messages: Array.from({ length: 200 }, (_, i) => ({ role: 'assistant', text: `row ${i}` })) };
  const output = renderScreen(view, { columns: 40, rows: 15 });
  assert.equal(output.split('\r\n').length, 15);
  assert.ok(output.includes('row 199'));
  assert.ok(!output.includes('row 0'));
});
test('only exact local thread IDs are accepted', () => {
  assert.throws(() => parseArguments(['--thread', 'codex://threads/1']));
  assert.throws(() => parseArguments(['--thread', '01a11946-12fe-7f81-81d9-de3b2fb11444', '--powershell-path', 'relative.exe']));
});
