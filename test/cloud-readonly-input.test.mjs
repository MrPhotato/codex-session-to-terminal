import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudReadonlyInputFilter } from '../cloud-readonly-input.mjs';

const ESC = '\u001b', up = `${ESC}[5~`, down = `${ESC}[6~`;
const home = `${ESC}[1;5H`, end = `${ESC}[1;5F`;
const startPaste = `${ESC}[200~`, endPaste = `${ESC}[201~`;
const filter = text => createCloudReadonlyInputFilter().push(text);

test('only the four verified navigation keys pass and explicit unmodified pages normalize', () => {
  assert.equal(filter(up + down + home + end), up + down + home + end);
  assert.equal(filter(`${ESC}[5;1~${ESC}[6;1~`), up + down);
  assert.equal(filter(`type nothing${up}不输入${down}\r${home}\t${end}`), up + down + home + end);
});

test('ordinary editing, submission, interrupt, shell and arbitrary Unicode are ignored', () => {
  assert.equal(filter('hello /model /quit !echo test\r\n\t\b\u007f\u0003\u0004\u0001\u0014'), '');
  assert.equal(filter('中文🙂 e\u0301 \u202e'), '');
  for (const sequence of ['[A', '[B', '[C', '[D', '[H', '[F', 'OH', 'OF', '[1~', '[4~', '[7~', '[8~', '[Z']) {
    assert.equal(filter(ESC + sequence), '', sequence);
  }
  const f = createCloudReadonlyInputFilter();
  assert.equal(f.push(ESC), ''); assert.equal(f.push('\r'), '');
  assert.equal(f.push(up), up);
});

test('modified page keys, unsupported keyboard encodings and device replies fail closed', () => {
  for (const sequence of ['[5;2~', '[6;5~', '[5;3~', '[1;2H', '[1;6F', '[1;5:3H', '[27;5;13~',
    '[13;5u', '[57358u', '[?1;2c', '[0n', '[12;40R', '[8;24;80t', '[I', '[O']) {
    assert.equal(filter(ESC + sequence), '', sequence);
  }
});

test('allowed keys parse correctly across every chunk boundary and UTF-8 buffers', () => {
  const text = `中🙂${up}${home}${down}${end}`;
  const bytes = Buffer.from(text);
  for (let split = 0; split <= bytes.length; split++) {
    const f = createCloudReadonlyInputFilter();
    assert.equal(f.push(bytes.subarray(0, split)) + f.push(bytes.subarray(split)), up + home + down + end, `split ${split}`);
  }
  const f = createCloudReadonlyInputFilter();
  assert.equal([...bytes].map(byte => f.push(Buffer.from([byte]))).join(''), up + home + down + end);
});

test('SGR wheel presses map to pages while mouse clicks, releases and modifier bits disappear', () => {
  assert.equal(filter(`${ESC}[<64;1;1M${ESC}[<65;65535;65535M`), up + down);
  for (const body of ['<0;1;1M', '<2;1;1M', '<3;1;1m', '<32;1;1M', '<64;1;1m', '<65;1;1m',
    '<68;1;1M', '<72;1;1M', '<80;1;1M', '<64;0;1M', '<65;1;0M', '<64;65536;1M', '<65;1;65536M', '<64;-1;1M']) {
    assert.equal(filter(`${ESC}[${body}`), '', body);
  }
  const value = `${ESC}[<64;50;20M`, f = createCloudReadonlyInputFilter();
  assert.equal([...value].map(char => f.push(char)).join(''), up);
});

test('bracketed paste drops text, navigation, wheel and embedded control strings as one paste', () => {
  const text = `${startPaste}text\n${up}${home}${ESC}[<64;1;1M${ESC}]0;title\u0007${ESC}P${down}${ESC}\\${endPaste}${down}`;
  assert.equal(filter(text), down);
  const bytes = Buffer.from(text);
  for (let split = 0; split <= bytes.length; split++) {
    const f = createCloudReadonlyInputFilter();
    assert.equal(f.push(bytes.subarray(0, split)) + f.push(bytes.subarray(split)), down, `split ${split}`);
  }
  const f = createCloudReadonlyInputFilter();
  assert.equal([...bytes].map(byte => f.push(Buffer.from([byte]))).join(''), down);
});

test('partial paste termination never leaks a navigation suffix', () => {
  const f = createCloudReadonlyInputFilter();
  assert.equal(f.push(startPaste + `${ESC}[20`), '');
  assert.equal(f.push(`broken${up}${ESC}[201`), '');
  assert.equal(f.push(`~${home}`), home);
});

test('unknown OSC, DCS, SOS, PM and APC strings swallow nested navigation until their terminator', () => {
  for (const prefix of [']', 'P', 'X', '^', '_']) {
    const text = `${ESC}${prefix}unknown${up}${ESC}[<65;5;5M${home}${ESC}\\${down}`;
    assert.equal(filter(text), down, prefix);
    const f = createCloudReadonlyInputFilter();
    assert.equal([...text].map(char => f.push(char)).join(''), down, `split ${prefix}`);
  }
  assert.equal(filter(`${ESC}]52;c;${up}\u0007${down}`), down);
  assert.equal(filter(`${ESC}Pignored\u0007${up}${ESC}\\${end}`), end);
});

test('C1 control strings are consumed but C1 navigation is not forwarded', () => {
  for (const prefix of ['\u009d', '\u0090', '\u0098', '\u009e', '\u009f']) {
    assert.equal(filter(`${prefix}${up}${home}\u009c${down}`), down);
  }
  assert.equal(filter(`\u009b5~\u009b1;5H${up}`), up);
  assert.equal(filter(`\u009b200~${down}${endPaste}${up}`), up);
});

test('malformed CSI and SS3 nested escapes cannot become navigation', () => {
  for (const sequence of [`${ESC}[123${up}`, `${ESC}[1;\u00005~`, `${ESC}O${up}`, `${ESC}[123${ESC}]${up}\u0007`]) {
    assert.equal(filter(sequence + down), down, JSON.stringify(sequence));
  }
  assert.equal(filter(`${ESC}[?9999h${up}`), up);
  assert.equal(filter(`${ESC}O5~${down}`), down);
});

test('overlong unfinished control strings consume bounded state and recover at valid boundaries', () => {
  const f = createCloudReadonlyInputFilter();
  assert.equal(f.push(`${ESC}[${'1'.repeat(1024 * 1024)}`), '');
  assert.equal(f.push(`~${up}`), up);
  assert.equal(f.push(`${ESC}]${'x'.repeat(1024 * 1024)}${up}`), '');
  assert.equal(f.push(`\u0007${down}`), down);
  assert.equal(f.push(`${startPaste}${'x'.repeat(1024 * 1024)}${home}`), '');
  assert.equal(f.push(`${endPaste}${end}`), end);
});

test('reset abandons partial escape, string, paste and UTF-8 state without emitting it', () => {
  for (const prefix of [ESC, `${ESC}[1;`, `${ESC}]title`, `${ESC}Pbody`, startPaste, Buffer.from([0xf0, 0x9f])]) {
    const f = createCloudReadonlyInputFilter(); assert.equal(f.push(prefix), '');
    assert.equal(f.reset(), undefined); assert.equal(f.push(up), up);
  }
  assert.throws(() => createCloudReadonlyInputFilter().push({}), TypeError);
});
