import test from 'node:test';
import assert from 'node:assert/strict';
import { matchCloudThreadByTitle, matchesCloudTitleRead } from '../cloud-title-selection.mjs';

const native = '11111111-2222-4333-8444-555555555555';
const frontend = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const other = '99999999-8888-4777-8666-555555555555';
const title = 'Codex Session to Terminal 云端连接测试';
const durableRow = (change = {}) => ({ id: native, kind: 'codex', hostId: 'durable', title, ...change });
const frontendRow = (change = {}) => ({ id: frontend, kind: 'chatgpt', title, ...change });
const directory = (extra = []) => ({ threads: [durableRow(), frontendRow(), ...extra], pinnedThreads: [] });

test('suggests one exact native cloud title only with a single matching frontend title', () => {
  assert.equal(matchCloudThreadByTitle(directory(), title), native);
  assert.equal(matchCloudThreadByTitle({ threads: [durableRow()] }, title), null);
  assert.equal(matchCloudThreadByTitle({ threads: [frontendRow()] }, title), null);
  assert.equal(matchCloudThreadByTitle({ threads: [durableRow(), frontendRow({ title: 'Renamed' })] }, title), null);
});

test('pinned and recent copies deduplicate only when their identity and raw title agree', () => {
  assert.equal(matchCloudThreadByTitle({ ...directory(), pinnedThreads: [durableRow(), frontendRow()] }, title), native);
  assert.equal(matchCloudThreadByTitle({ ...directory(), pinnedThreads: [durableRow({ id: native.toUpperCase() }), frontendRow({ id: frontend.toUpperCase() })] }, title), native);
  for (const row of [durableRow({ title: 'Previous title' }), frontendRow({ title: 'Previous title' }),
    durableRow({ hostId: 'local' }), frontendRow({ kind: 'codex', hostId: 'durable' })]) {
    assert.equal(matchCloudThreadByTitle({ ...directory(), pinnedThreads: [row] }, title), null);
    assert.equal(matchCloudThreadByTitle({ threads: [row, ...directory().threads] }, title), null);
  }
});

test('duplicate titles on cloud, local, other-host, frontend or unknown rows are ambiguous', () => {
  for (const row of [durableRow({ id: other }), frontendRow({ id: other }),
    durableRow({ id: other, hostId: 'local' }), durableRow({ id: other, hostId: 'ssh-host' }),
    durableRow({ id: other, hostId: undefined }), durableRow({ id: other, kind: 'unknown' })]) {
    assert.equal(matchCloudThreadByTitle(directory([row]), title), null);
  }
});

test('compares complete raw titles without trimming, case folding, normalization or truncation', () => {
  for (const changed of [` ${title}`, `${title} `, title.toLowerCase(), `${title}x`]) {
    assert.equal(matchCloudThreadByTitle(directory(), changed), null);
  }
  const composed = 'Café cloud session';
  assert.equal(matchCloudThreadByTitle({ threads: [durableRow({ title: composed }), frontendRow({ title: composed })] }, composed.normalize('NFD')), null);
  const long = '云'.repeat(512);
  const longList = { threads: [durableRow({ title: long }), frontendRow({ title: long })] };
  assert.equal(matchCloudThreadByTitle(longList, long), native);
  assert.equal(matchCloudThreadByTitle(longList, long.slice(0, 200)), null);
});

test('rejects unsafe, missing and generic title observations', () => {
  for (const rawTitle of [undefined, null, 42, '', ' ', 'x'.repeat(513), 'ChatGPT', 'chatgpt', ' Codex ',
    'New chat', 'New thread', 'New conversation', 'Untitled', '新聊天', '新对话', '新会话', '未命名',
    `${title}\n`, `${title}\r`, `${title}\0`, `${title}\x1b`, `${title}\x85`, `${title}\u202e`, `${title}\u200b`, `${title}\u2028`]) {
    assert.equal(matchCloudThreadByTitle({ threads: [durableRow({ title: rawTitle }), frontendRow({ title: rawTitle })] }, rawTitle), null);
  }
});

test('rejects malformed directories and matching rows with invalid identifiers', () => {
  for (const list of [null, undefined, [], {}, { threads: null }, { pinnedThreads: {} }, { threads: 'private' }]) {
    assert.equal(matchCloudThreadByTitle(list, title), null);
  }
  for (const id of [null, '', 'bad', `${native}\n`, '00000000-0000-0000-0000-000000000000']) {
    assert.equal(matchCloudThreadByTitle({ threads: [durableRow({ id }), frontendRow()] }, title), null);
    assert.equal(matchCloudThreadByTitle({ threads: [durableRow(), frontendRow({ id })] }, title), null);
  }
  assert.equal(matchCloudThreadByTitle(directory([null, 42, { title: 'Unrelated' }]), title), native);
});

test('readback must preserve the same native cloud ID and exact raw title', () => {
  assert.equal(matchesCloudTitleRead({ thread: durableRow() }, native, title), true);
  assert.equal(matchesCloudTitleRead({ thread: durableRow({ id: native.toUpperCase() }) }, native, title), true);
  for (const thread of [undefined, null, frontendRow(), durableRow({ id: other }), durableRow({ id: `${native}\n` }),
    durableRow({ hostId: 'local' }), durableRow({ hostId: undefined }), durableRow({ title: `${title} ` }),
    durableRow({ title: undefined })]) {
    assert.equal(matchesCloudTitleRead({ thread }, native, title), false);
  }
  assert.equal(matchesCloudTitleRead(null, native, title), false);
  assert.equal(matchesCloudTitleRead({ thread: durableRow() }, 'bad', title), false);
  assert.equal(matchesCloudTitleRead({ thread: durableRow({ title: 'ChatGPT' }) }, native, 'ChatGPT'), false);
});
