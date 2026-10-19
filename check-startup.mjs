import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { RpcClient } from './rpc-client.mjs';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export const NOT_READY = 'The Desktop connection is not ready. Desktop has been left running.';

// Only connection metadata is inspected. This checker never starts a thread,
// invokes a model, handles approvals, or changes the Desktop process lifecycle.
export async function checkStartup({ configPath, generation, timeoutMs = 60_000, pollMs = 150 } = {}) {
  let client;
  let timer;
  const abort = new AbortController();
  const end = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, end - Date.now());
  const ensureActive = () => { if (abort.signal.aborted || Date.now() >= end) throw new Error(NOT_READY); };
  const json = async file => JSON.parse(await readFile(file, { encoding: 'utf8', signal: abort.signal }));
  const closeClient = () => { try { client?.close(); } catch {} client = undefined; };
  try {
    if (!isAbsolute(configPath ?? '') || !UUID.test(generation ?? '')
        || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000
        || !Number.isInteger(pollMs) || pollMs < 1) throw new Error(NOT_READY);
    const run = async () => {
      const config = await json(configPath);
      ensureActive();
      if (!config || !['root', 'runtimeFile', 'backendTokenFile'].every(key => typeof config[key] === 'string' && isAbsolute(config[key]))
          || !Number.isInteger(config.backendPort) || config.backendPort < 1024 || config.backendPort > 65535) throw new Error(NOT_READY);
      const desktopFile = join(config.root, 'desktop.json');
      const readReadyRuntime = async () => {
        const [runtime, desktop] = await Promise.all([json(config.runtimeFile), json(desktopFile)]);
        ensureActive();
        if (runtime?.ready !== true || runtime.generation !== generation || desktop?.generation !== generation
            || runtime.backendPort !== config.backendPort || typeof runtime.instanceId !== 'string' || !runtime.instanceId) return null;
        return runtime;
      };
      while (true) {
        ensureActive();
        try {
          const runtime = await readReadyRuntime();
          if (runtime) {
            const token = (await readFile(config.backendTokenFile, { encoding: 'utf8', signal: abort.signal })).trim();
            ensureActive();
            if (token.length < 16 || /\s/.test(token)) throw new Error(NOT_READY);
            const attemptMs = Math.min(5000, remaining());
            client = new RpcClient(`ws://127.0.0.1:${config.backendPort}`, {
              name: 'session_bridge_startup_check', timeoutMs: attemptMs,
              createSocket: url => new WebSocket(url, {
                headers: { Authorization: `Bearer ${token}` }, handshakeTimeout: attemptMs,
              }),
            });
            const initialized = await client.connect();
            ensureActive();
            if (!initialized || typeof initialized !== 'object' || Array.isArray(initialized)) throw new Error(NOT_READY);
            const loaded = await client.call('thread/loaded/list', {}, Math.min(5000, remaining()));
            ensureActive();
            if (!loaded || !Array.isArray(loaded.data) || !loaded.data.every(id => typeof id === 'string' && id.length > 0)) throw new Error(NOT_READY);
            // A second launch must not make an obsolete endpoint look ready.
            const current = await readReadyRuntime();
            if (current?.instanceId === runtime.instanceId) return { ready: true };
          }
        } catch {
          // Local files, RPC errors and transport errors may contain private
          // paths or server data. Keep them out of output and retry only reads.
        } finally { closeClient(); }
        ensureActive();
        await delay(Math.min(pollMs, remaining()), undefined, { signal: abort.signal });
      }
    };
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => { abort.abort(); closeClient(); reject(new Error(NOT_READY)); }, timeoutMs);
    });
    return await Promise.race([run(), expired]);
  } catch {
    throw new Error(NOT_READY);
  } finally {
    clearTimeout(timer);
    abort.abort();
    closeClient();
  }
}

async function main() {
  const values = {};
  const args = process.argv.slice(2);
  if (args.length % 2) throw new Error(NOT_READY);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!['--config', '--generation', '--timeout-ms'].includes(key) || values[key] !== undefined) throw new Error(NOT_READY);
    values[key] = args[i + 1];
  }
  const result = await checkStartup({
    configPath: values['--config'], generation: values['--generation'],
    timeoutMs: values['--timeout-ms'] === undefined ? 60_000 : Number(values['--timeout-ms']),
  });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(() => { console.error(NOT_READY); process.exitCode = 1; });
}
