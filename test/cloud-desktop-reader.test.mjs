import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { cloudIsolationNames, createCloudDesktopReader } from '../cloud-desktop-reader.mjs';

const pipe = 'codex-app-tools-11111111-2222-4333-8444-555555555555';
const code = expected => error => error.code === expected;

test('extracts only isolation names, ignoring credentials and fake headers in comments or multiline strings', () => {
  const source = `token = "NEVER_COPY"
instructions = """
[mcp_servers.fake]
"""
# [plugins."fake@market"]
[plugins."one@market"]
enabled = true
[mcp_servers.real.env]
SECRET = "NEVER_COPY"
[mcp_servers]
other = { command = "tool", env = { SECRET = "NEVER_COPY" } }
`;
  assert.deepEqual(cloudIsolationNames(source), { disabledPlugins: ['one@market'], disabledMcpServers: ['real', 'other'] });
  assert.deepEqual(cloudIsolationNames("mcp_servers.'one'.enabled = true\nplugins.\"two@market\".enabled = true\n"),
    { disabledPlugins: ['two@market'], disabledMcpServers: ['one'] });
  for (const invalid of ['mcp_servers = { unsafe = {} }', '[mcp_servers."server.with.dots"]', 'value = "unterminated']) {
    assert.throws(() => cloudIsolationNames(invalid), error => ['INVALID_CLOUD_CONFIG', 'UNSUPPORTED_CLOUD_CONFIG'].includes(error.code));
  }
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'cst-reader-test-'));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert(directory.includes('cst-reader-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  const user = join(directory, 'user'), home = join(directory, 'codex home'), cwd = join(directory, 'run');
  await mkdir(home, { recursive: true }); await mkdir(cwd, { recursive: true });
  const options = { cwd };
  for (const key of ['backendPath', 'nodePath', 'powershellPath']) {
    options[key] = join(directory, `${key}.exe`); await writeFile(options[key], 'fixture');
  }
  await writeFile(join(home, 'config.toml'), '[plugins."other@market"]\nenabled=true\n[mcp_servers.other.env]\nTOKEN="SECRET_CONFIG_VALUE"\n');
  const plugin = async (root, version = '0.1.6', metadata = {}) => {
    const path = join(root, 'plugins', 'cache', 'openai-bundled', 'codex-app-tools', version);
    await mkdir(join(path, '.codex-plugin'), { recursive: true });
    await writeFile(join(path, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'codex-app-tools', version, author: { name: 'OpenAI' }, ...metadata }));
    await writeFile(join(path, 'server.mjs'), '// fixture, never executed');
    return join(path, 'server.mjs');
  };
  await plugin(home, '0.1.5'); const pluginPath = await plugin(home, '0.1.10');
  const calls = { execute: [], verify: [], destroyed: 0, client: [], list: [], read: [], navigate: [], close: 0 };
  const factories = {
    fileSystem: { ...fs, async stat(path) {
      // Ancestor discovery must not read the developer's real config in a test.
      if (!resolve(path).startsWith(resolve(directory))) throw Object.assign(new Error('fixture absent'), { code: 'ENOENT' });
      return fs.stat(path);
    } },
    homedir: () => user,
    env: { CODEX_HOME: home, PATH: 'fixture path', USERPROFILE: user, OPENAI_API_KEY: 'NEVER_FORWARD', CODEX_THREAD_ID: 'foreign-thread' },
    execute: async (...args) => { calls.execute.push(args); return { stdout: JSON.stringify([pipe]) }; },
    transportFactory: (...args) => async ({ signal }) => {
      calls.verify.push({ args, signal });
      return { destroyed: false, destroy() { this.destroyed = true; calls.destroyed++; } };
    },
    createClient: settings => {
      calls.client.push(settings);
      return {
        async listConversations(value) { calls.list.push(value); await settings.resolvePipeEndpoint(); return { threads: [] }; },
        async readConversation(id, options) { calls.read.push({ id, options }); return { thread: { id } }; },
        async navigateConversation(id) { calls.navigate.push(id); return { navigated: true }; },
        close() { calls.close++; return Promise.resolve({ archived: true }); },
      };
    },
  };
  return { directory, user, home, options, factories, calls, pluginPath, plugin };
}

test('finds newest installed official plugin, isolates config, and verifies unique pipe only when reader starts', async t => {
  const f = await fixture(t);
  const localConfig = join(f.options.cwd, '.codex'); await mkdir(localConfig);
  await writeFile(join(localConfig, 'config.toml'), '[mcp_servers.project_server]\ncommand="never start"');
  const reader = await createCloudDesktopReader(f.options, f.factories);
  assert.deepEqual(Object.keys(reader), ['listConversations', 'readConversation', 'close']);
  assert.equal(f.calls.execute.length, 0);
  const settings = f.calls.client[0];
  assert.equal(settings.pluginPath, f.pluginPath);
  assert.deepEqual(settings.disabledPlugins, ['other@market']);
  assert.deepEqual(settings.disabledMcpServers, ['other', 'project_server']);
  assert.deepEqual(settings.allowSendTargets, []);
  assert.equal('sendCapability' in settings, false);
  assert.equal(settings.env.CODEX_HOME, f.home);
  assert.equal('OPENAI_API_KEY' in settings.env, false);
  assert.equal('CODEX_THREAD_ID' in settings.env, false);
  assert.equal(JSON.stringify(settings).includes('SECRET_CONFIG_VALUE'), false);
  await reader.listConversations({ limit: 50 });
  assert.deepEqual(f.calls.list, [{ limit: 50 }]);
  assert.equal(f.calls.execute[0][2].windowsHide, true);
  assert.equal(f.calls.execute[0][2].timeout, 10000);
  assert.deepEqual(f.calls.verify[0].args, [f.options.powershellPath, { pipeName: pipe }]);
  assert.equal(f.calls.destroyed, 1);
  assert.equal(f.calls.verify[0].signal.aborted, true);
  await reader.readConversation('native-id', { hostId: 'durable' });
  assert.deepEqual(f.calls.read, [{ id: 'native-id', options: { hostId: 'durable' } }]);
  await reader.close(); assert.equal(f.calls.close, 1);
});

test('falls back to the current user plugin root without changing the executor config home', async t => {
  const f = await fixture(t);
  // Remove only the known fixture cache, within its verified test directory.
  const cache = join(f.home, 'plugins'); assert(cache.startsWith(f.directory));
  await rm(cache, { recursive: true, force: true });
  const expected = await f.plugin(join(f.user, '.codex'));
  await createCloudDesktopReader(f.options, f.factories);
  assert.equal(f.calls.client[0].pluginPath, expected);
  assert.equal(f.calls.client[0].env.CODEX_HOME, f.home);
});

test('an explicitly bound navigation facade snapshots one ID and cannot grant send or other target access', async t => {
  const f = await fixture(t), target = '11111111-2222-4333-8444-555555555555';
  const targets = [target];
  const pending = createCloudDesktopReader({ ...f.options, navigateTargets: targets }, f.factories);
  targets[0] = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const reader = await pending;
  assert.equal('sendText' in reader, false);
  assert.deepEqual(f.calls.client[0].navigateTargets, [target]);
  assert.deepEqual(f.calls.client[0].allowSendTargets, []);
  assert.equal('sendCapability' in f.calls.client[0], false);
  await assert.rejects(reader.navigateConversation(targets[0]), code('NAVIGATION_NOT_AUTHORIZED'));
  assert.deepEqual(await reader.navigateConversation(target), { navigated: true });
  assert.deepEqual(f.calls.navigate, [target]);
  await reader.close();
  for (const navigateTargets of [[], [target, target], 'all', ['bad']]) {
    await assert.rejects(createCloudDesktopReader({ ...f.options, navigateTargets }, f.factories), code('INVALID_CLOUD_READER'));
  }
  assert.equal(f.calls.client.length, 1);
});

test('closing the facade revokes its single navigation capability before any later dispatch', async t => {
  const f = await fixture(t), target = '11111111-2222-4333-8444-555555555555';
  const reader = await createCloudDesktopReader({ ...f.options, navigateTargets: [target] }, f.factories);
  assert.deepEqual(await reader.navigateConversation(target), { navigated: true });
  await reader.close();
  await assert.rejects(reader.navigateConversation(target), code('CLIENT_CLOSED'));
  assert.deepEqual(f.calls.navigate, [target]);
});

test('default reader cannot gain navigation while its asynchronous discovery runs', async t => {
  const f = await fixture(t), options = { ...f.options };
  const pending = createCloudDesktopReader(options, f.factories);
  options.navigateTargets = ['11111111-2222-4333-8444-555555555555'];
  const reader = await pending;
  assert.equal('navigateConversation' in reader, false);
  assert.equal(f.calls.client[0].navigateTargets, undefined);
  await reader.close();
});

test('rejects ambiguous or malformed endpoints before verification and sanitizes discovery failures', async t => {
  const f = await fixture(t);
  for (const result of [[], [pipe, pipe], ['codex-ipc'], ['../' + pipe], ['codex-app-tools-not-a-uuid'], 'bad-json']) {
    const reader = await createCloudDesktopReader(f.options, { ...f.factories,
      execute: async () => ({ stdout: typeof result === 'string' ? result : JSON.stringify(result) }) });
    await assert.rejects(reader.listConversations(), code('CLOUD_PIPE_UNAVAILABLE'));
  }
  assert.equal(f.calls.verify.length, 0);
  const reader = await createCloudDesktopReader(f.options, { ...f.factories, execute: async () => { throw new Error('SECRET_STDERR'); } });
  await assert.rejects(reader.listConversations(), error => error.code === 'CLOUD_PIPE_UNAVAILABLE' && !error.message.includes('SECRET'));
});

test('refuses an unverified or already closed pipe and never exposes native verification diagnostics', async t => {
  const f = await fixture(t);
  for (const transportFactory of [
    () => async () => { throw new Error('SECRET_NATIVE_DIAGNOSTIC'); },
    () => async () => ({ destroyed: true, destroy() { f.calls.destroyed++; } }),
  ]) {
    const reader = await createCloudDesktopReader(f.options, { ...f.factories, transportFactory });
    await assert.rejects(reader.listConversations(), error => error.code === 'CLOUD_PIPE_UNAVAILABLE' && !error.message.includes('SECRET'));
  }
  assert.equal(f.calls.destroyed, 1);
});

test('closing the reader cancels only its pending discovery or verification helper', async t => {
  for (const phase of ['discovery', 'verification']) {
    const f = await fixture(t);
    let arrived, observed;
    const ready = new Promise(resolve => { arrived = resolve; });
    const waiting = signal => new Promise((_, reject) => {
      observed = signal; arrived();
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    });
    const reader = await createCloudDesktopReader(f.options, { ...f.factories,
      ...(phase === 'discovery' ? { execute: (_exe, _args, options) => waiting(options.signal) }
        : { transportFactory: () => ({ signal }) => waiting(signal) }),
    });
    const pending = reader.listConversations();
    const rejected = assert.rejects(pending, code('CLOUD_PIPE_UNAVAILABLE'));
    await ready; await reader.close(); await rejected;
    assert.equal(observed.aborted, true);
    assert.equal(f.calls.close, 1);
    if (phase === 'discovery') assert.equal(f.calls.verify.length, 0);
  }
});

test('plugin discovery ignores an unrelated manifest and fails when no official entry is present', async t => {
  const f = await fixture(t);
  await f.plugin(f.home, '0.2.0', { name: 'unrelated' });
  await createCloudDesktopReader(f.options, f.factories);
  assert.equal(f.calls.client[0].pluginPath, f.pluginPath);
  for (const version of ['0.1.5', '0.1.10']) {
    await writeFile(join(f.home, 'plugins', 'cache', 'openai-bundled', 'codex-app-tools', version, '.codex-plugin', 'plugin.json'), '{}');
  }
  await assert.rejects(createCloudDesktopReader(f.options, f.factories), code('CLOUD_PLUGIN_UNAVAILABLE'));
});

test('invalid paths, unsupported config isolation and send options fail before client construction', async t => {
  const f = await fixture(t);
  for (const options of [{ ...f.options, cwd: 'relative' }, { ...f.options, allowSendTargets: ['x'] }, { ...f.options, backendPath: f.options.cwd }]) {
    await assert.rejects(createCloudDesktopReader(options, f.factories), code('INVALID_CLOUD_READER'));
  }
  await writeFile(join(f.home, 'config.toml'), '[mcp_servers."unsafe.name"]\ncommand="never start"');
  await assert.rejects(createCloudDesktopReader(f.options, f.factories), code('UNSUPPORTED_CLOUD_CONFIG'));
  assert.equal(f.calls.client.length, 0);
});
