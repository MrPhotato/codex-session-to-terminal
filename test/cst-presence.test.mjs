import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createSessionPresence, presenceTitle } from '../cst-presence.mjs';

const threadId = '01a11946-12fe-7f81-81d9-de3b2fb11444';
async function fixture(t) {
  const parent = resolve(tmpdir());
  const controlDirectory = await fs.mkdtemp(join(parent, 'cst-presence-test-'));
  t.after(async () => {
    assert.ok(resolve(controlDirectory).startsWith(join(parent, 'cst-presence-test-')));
    await fs.rm(controlDirectory, { recursive: true, force: true });
  });
  return controlDirectory;
}
function timerFixture() {
  let tick, unref = 0, cleared = 0;
  return {
    setIntervalFn(fn, delay) { assert.equal(delay, 2000); tick = fn; return { unref() { unref++; } }; },
    clearIntervalFn() { cleared++; },
    tick() { tick(); },
    counts() { return { unref, cleared }; },
  };
}
const record = async presence => JSON.parse(await fs.readFile(presence.filePath, 'utf8'));

test('presence publishes only approved metadata and sanitizes the title', async t => {
  const controlDirectory = await fixture(t);
  const presence = createSessionPresence({ controlDirectory, threadId });
  t.after(() => presence.close());
  presence.updateState({ title: '\x1b]52;c;secret\x07项目\n名称\u202e' + '😀'.repeat(240), cwd: 'private-folder',
    apiKey: 'private-key', turns: [{ turnId: 'turn-1', status: 'inProgress', content: 'private-message' }] });
  presence.updateStatus({ phase: 'ready', ready: true, reason: 'private-error', token: 'private-token' });
  await presence.flush();
  const value = await record(presence);
  assert.deepEqual(Object.keys(value).sort(), ['schema', 'instanceId', 'threadId', 'pid', 'title', 'phase', 'activeTurn', 'updatedAt', 'openedAt'].sort());
  assert.equal(value.schema, 1);
  assert.equal(value.threadId, threadId);
  assert.equal(value.pid, process.pid);
  assert.equal(value.phase, 'ready');
  assert.equal(value.activeTurn, true);
  assert.equal(Array.from(value.title).length, 200);
  assert.ok(value.title.startsWith('项目名称'));
  assert.ok(!JSON.stringify(value).includes('private-'));
  assert.ok(!JSON.stringify(value).includes('secret'));
  assert.match(value.updatedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.equal(presenceTitle(null), '');
});

test('heartbeats retain the real status and advance timestamps without new IPC events', async t => {
  const controlDirectory = await fixture(t), timer = timerFixture();
  let now = Date.parse('2026-10-19T00:00:00.000Z');
  const presence = createSessionPresence({ controlDirectory, threadId, now: () => now, ...timer });
  t.after(() => presence.close());
  await presence.flush();
  assert.equal((await record(presence)).phase, 'connecting');
  presence.updateStatus({ phase: 'ready', ready: true });
  await presence.flush();
  const openedAt = (await record(presence)).openedAt;
  now += 2000; timer.tick(); await presence.flush();
  assert.equal((await record(presence)).updatedAt, new Date(now).toISOString());
  assert.equal((await record(presence)).openedAt, openedAt);
  assert.equal((await record(presence)).phase, 'ready');
  presence.updateStatus({ phase: 'disconnected', ready: false });
  now += 2000; timer.tick(); await presence.flush();
  assert.equal((await record(presence)).phase, 'disconnected');
  presence.updateStatus({ phase: 'ready', ready: false });
  await presence.flush();
  assert.equal((await record(presence)).phase, 'disconnected');
  await presence.close();
  assert.deepEqual(timer.counts(), { unref: 1, cleared: 1 });
  assert.deepEqual(await fs.readdir(join(controlDirectory, 'sessions')), []);
  timer.tick(); await presence.flush();
  assert.deepEqual(await fs.readdir(join(controlDirectory, 'sessions')), []);
});

test('two terminals on the same chat have separate identities and closing one preserves the other', async t => {
  const controlDirectory = await fixture(t);
  const first = createSessionPresence({ controlDirectory, threadId });
  const second = createSessionPresence({ controlDirectory, threadId });
  t.after(() => Promise.all([first.close(), second.close()]));
  await Promise.all([first.flush(), second.flush()]);
  assert.notEqual(first.instanceId, second.instanceId);
  assert.equal((await fs.readdir(join(controlDirectory, 'sessions'))).length, 2);
  await first.close();
  assert.deepEqual(await fs.readdir(join(controlDirectory, 'sessions')), [`${second.instanceId}.json`]);
});

test('Windows busy rename is retried within a fixed bound and never exposes partial JSON', async t => {
  const controlDirectory = await fixture(t);
  let calls = 0;
  const waits = [];
  const presence = createSessionPresence({ controlDirectory, threadId, retryDelay: async ms => waits.push(ms),
    fileSystem: { ...fs, async rename(...args) {
      calls++;
      if (calls < 3) throw Object.assign(new Error('busy'), { code: 'EPERM' });
      return fs.rename(...args);
    } } });
  t.after(() => presence.close());
  await presence.flush();
  assert.equal(calls, 3);
  assert.deepEqual(waits, [20, 40]);
  assert.equal((await record(presence)).phase, 'connecting');
  assert.deepEqual(await fs.readdir(join(controlDirectory, 'sessions')), [`${presence.instanceId}.json`]);
});

test('failed metadata writes do not escape to IPC callers or leave temporary files', async t => {
  const controlDirectory = await fixture(t);
  let calls = 0;
  const presence = createSessionPresence({ controlDirectory, threadId, retryDelay: async () => {},
    fileSystem: { ...fs, async rename() { calls++; throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } } });
  t.after(() => presence.close());
  presence.updateStatus({ phase: 'ready', ready: true });
  await assert.doesNotReject(presence.flush());
  assert.ok(calls >= 5 && calls <= 10);
  assert.deepEqual(await fs.readdir(join(controlDirectory, 'sessions')), []);
  await assert.doesNotReject(presence.close());
  assert.deepEqual(await fs.readdir(join(controlDirectory, 'sessions')), []);
});

test('close waits for an in-flight write and removes its own record', async t => {
  const controlDirectory = await fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const writing = new Promise(resolve => { entered = resolve; });
  const presence = createSessionPresence({ controlDirectory, threadId, fileSystem: { ...fs,
    async writeFile(...args) { entered(); await gate; return fs.writeFile(...args); },
  } });
  await writing;
  const closing = presence.close();
  release(); await closing;
  assert.deepEqual(await fs.readdir(join(controlDirectory, 'sessions')), []);
});

test('filesystem recovery publishes the latest actual disconnected status, never a stale ready state', async t => {
  const controlDirectory = await fixture(t), timer = timerFixture();
  let failing = true;
  const presence = createSessionPresence({ controlDirectory, threadId, ...timer, fileSystem: { ...fs,
    async writeFile(...args) { if (failing) throw Object.assign(new Error('unavailable'), { code: 'EIO' }); return fs.writeFile(...args); },
  } });
  t.after(() => presence.close());
  presence.updateStatus({ phase: 'ready', ready: true });
  await presence.flush();
  presence.updateStatus({ phase: 'disconnected', ready: false });
  await presence.flush();
  failing = false; timer.tick(); await presence.flush();
  assert.equal((await record(presence)).phase, 'disconnected');
});

test('invalid directories and identities cannot choose arbitrary output paths', () => {
  assert.throws(() => createSessionPresence({ controlDirectory: '.', threadId }));
  assert.throws(() => createSessionPresence({ controlDirectory: resolve(tmpdir()), threadId, instanceId: '../other' }));
  assert.throws(() => createSessionPresence({ controlDirectory: resolve(tmpdir()), threadId: '../other' }));
});
