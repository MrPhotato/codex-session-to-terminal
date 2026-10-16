#!/usr/bin/env node
// Desktop owns initialization and approvals. This bridge only moves JSONL frames.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';

const GLOBAL_VALUES = new Set(['-c', '--config', '--enable', '--disable', '-m', '--model', '-p', '--profile', '-C', '--cd', '-s', '--sandbox', '-a', '--ask-for-approval', '--remote', '--remote-bearer-token', '--add-dir', '-i', '--image']);
const SERVER_VALUES = new Set(['-c', '--config', '--enable', '--disable', '--listen', '--code-mode-host', '--ws-auth', '--ws-token-file', '--ws-token-sha256', '--ws-shared-secret-file', '--ws-issuer', '--ws-audience', '--ws-max-clock-skew-seconds']);

export function serverInvocation(args) {
  let commandIndex = -1;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') return null;
    if (GLOBAL_VALUES.has(arg)) { i++; continue; }
    if (arg.startsWith('-')) continue;
    commandIndex = i; break;
  }
  if (commandIndex < 0 || args[commandIndex] !== 'app-server') return null;
  for (let i = commandIndex + 1; i < args.length; i++) {
    const arg = args[i];
    if (SERVER_VALUES.has(arg)) { i++; continue; }
    if (!arg.startsWith('-') || arg === '--help' || arg === '-h') return null;
  }
  return { commandIndex };
}

export function shouldIntercept(args, env, config) {
  return serverInvocation(args) !== null &&
    !args.some(arg => arg === '--stdio' || arg === '--listen' || arg.startsWith('--listen=') || arg.startsWith('--ws-')) &&
    env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE === (config.interceptOriginator ?? 'Codex Desktop');
}

export function backendArguments(args, config) {
  if (args.some(arg => arg === '--stdio' || arg === '--listen' || arg.startsWith('--listen=') || arg.startsWith('--ws-'))) {
    throw new Error('Explicit backend transport or authentication options conflict with the shared-session bridge.');
  }
  return [...args, '--listen', `ws://127.0.0.1:${config.backendPort}`, '--ws-auth', 'capability-token', '--ws-token-file', config.backendTokenFile];
}

export class JsonLineQueue {
  constructor(maxBytes = 64 * 1024 * 1024) {
    this.maxBytes = maxBytes;
    this.remainder = Buffer.alloc(0);
    this.lines = [];
    this.bytes = 0;
  }
  push(chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (this.bytes + this.remainder.length + buffer.length > this.maxBytes) throw new Error('Desktop input queue exceeded its bounded capacity.');
    const joined = Buffer.concat([this.remainder, buffer]);
    let start = 0;
    for (let i = 0; i < joined.length; i++) {
      if (joined[i] !== 10) continue;
      let line = joined.subarray(start, i);
      if (line.at(-1) === 13) line = line.subarray(0, -1);
      if (line.length) { this.lines.push(Buffer.from(line)); this.bytes += line.length; }
      start = i + 1;
    }
    this.remainder = Buffer.from(joined.subarray(start));
  }
  shift() { const line = this.lines.shift(); if (line) this.bytes -= line.length; return line; }
}

function validPid(pid) { return Number.isInteger(pid) && pid > 0; }
function pidAlive(pid) {
  if (!validPid(pid)) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

async function loadConfig() {
  const file = process.env.CODEX_SHARED_SESSION_CONFIG;
  if (!file || !isAbsolute(file)) throw new Error('CODEX_SHARED_SESSION_CONFIG must identify an absolute private JSON configuration.');
  const config = JSON.parse(await readFile(file, 'utf8'));
  for (const key of ['realCliPath', 'root', 'backendTokenFile']) {
    if (typeof config[key] !== 'string' || !isAbsolute(config[key])) throw new Error(`The configuration requires an absolute ${key}.`);
  }
  if (!Number.isInteger(config.backendPort) || config.backendPort < 1024 || config.backendPort > 65535) throw new Error('The configuration requires a backendPort between 1024 and 65535.');
  config.runtimeFile ??= join(config.root, 'runtime.json');
  if (!isAbsolute(config.runtimeFile)) throw new Error('runtimeFile must be absolute.');
  return config;
}

async function requireFreePort(port) {
  const server = createServer();
  await new Promise((resolveReady, reject) => {
    server.once('error', () => reject(new Error('The configured local backend port is already in use.')));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(error => error ? reject(error) : resolveReady()));
  });
}

export async function writeRuntime(config, value, io = { writeFile, rename, unlink, mkdir }) {
  await io.mkdir(config.root, { recursive: true });
  const temp = `${config.runtimeFile}.${value.instanceId}.${randomUUID()}.tmp`;
  try {
    await io.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    // A short Windows reader/antivirus lock must not take down a healthy backend.
    // Keep atomic replacement; never delete the previous runtime record first.
    for (let attempt = 0; ; attempt++) {
      try { await io.rename(temp, config.runtimeFile); break; }
      catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 5) throw error;
        await new Promise(resolveDelay => setTimeout(resolveDelay, 25 * 2 ** attempt));
      }
    }
  } finally {
    try { await io.unlink(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function childEnvironment(config) {
  return { ...process.env, CODEX_CLI_PATH: config.realCliPath };
}

export async function runBridge(config, args) {
  const generation = process.env.CODEX_SHARED_SESSION_GENERATION;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(generation ?? '')) {
    throw new Error('A per-launch shared-session generation is required.');
  }
  const realArgs = backendArguments(args, config);
  // The listening port is authoritative. Old runtime PIDs may have been reused.
  await requireFreePort(config.backendPort);
  const token = (await readFile(config.backendTokenFile, 'utf8')).trim();
  if (token.length < 16 || /\s/.test(token)) throw new Error('The backend capability-token file is not valid.');
  const queue = new JsonLineQueue(config.maxQueuedBytes ?? 64 * 1024 * 1024);
  const instanceId = randomUUID();
  const backend = spawn(config.realCliPath, realArgs, {
    env: childEnvironment(config), stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true,
  });
  const runtime = {
    schemaVersion: 1, instanceId, generation, status: 'starting', ready: false,
    shimPid: Number(process.env.CODEX_SHARED_SHIM_PID) || process.ppid,
    bridgePid: process.pid, backendPid: backend.pid ?? null,
    backendPort: config.backendPort, startedAt: new Date().toISOString(),
    dynamicAppToolsAvailable: Boolean(process.env.CODEX_APP_TOOLS_PIPE_PATH),
    workspaceIdentityAvailable: Boolean(process.env.CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY),
    originatorMatched: true,
  };
  let socket, stopping = false, flushing = false, retryTimer, monitorTimer, flushTimer;
  let backendEnded = false, runtimeWritten = false;
  let runtimeWrite = Promise.resolve();
  const persistRuntime = value => {
    const snapshot = { ...value };
    runtimeWrite = runtimeWrite.catch(() => {}).then(() => writeRuntime(config, snapshot));
    return runtimeWrite;
  };
  let finish;
  const done = new Promise(resolveDone => { finish = resolveDone; });

  const stop = async (code, reason) => {
    if (stopping) return;
    stopping = true;
    clearTimeout(retryTimer); clearInterval(monitorTimer); clearTimeout(flushTimer);
    process.stdin.pause();
    socket?.terminate();
    if (!backendEnded) {
      try { backend.kill(); } catch {}
      await Promise.race([new Promise(resolveExit => backend.once('exit', resolveExit)), new Promise(resolveWait => setTimeout(resolveWait, 2000))]);
    }
    await runtimeWrite.catch(() => {});
    if (runtimeWritten) {
      try {
        const current = JSON.parse(await readFile(config.runtimeFile, 'utf8'));
        if (current.instanceId === instanceId) await persistRuntime({ ...runtime, status: 'stopped', ready: false, stoppedAt: new Date().toISOString(), exitCode: code, reason });
      } catch {}
    }
    if (code) console.error(`[codex shared-session bridge] ${reason}`);
    finish(code);
  };
  const flush = () => {
    if (stopping || flushing || socket?.readyState !== WebSocket.OPEN) return;
    flushing = true;
    while (queue.lines.length && socket.bufferedAmount < 4 * 1024 * 1024) {
      const line = queue.shift();
      socket.send(line, { binary: false }, error => { if (error) void stop(1, 'Backend transport write failed.'); });
    }
    flushing = false;
    if (queue.lines.length) {
      process.stdin.pause();
      clearTimeout(flushTimer);
      flushTimer = setTimeout(flush, 10);
    } else if (!stopping) process.stdin.resume();
  };
  const input = chunk => {
    try { queue.push(chunk); flush(); }
    catch { void stop(1, 'Desktop input exceeded the bounded transport queue.'); }
  };
  process.stdin.on('data', input);
  process.stdin.once('end', () => void stop(0, 'Desktop input closed.'));
  process.stdin.once('error', () => void stop(1, 'Desktop input failed.'));
  process.stdout.once('error', () => void stop(0, 'Desktop output closed.'));
  process.stdout.on('drain', () => socket?.resume());
  process.once('SIGINT', () => void stop(0, 'Desktop bridge interrupted.'));
  process.once('SIGTERM', () => void stop(0, 'Desktop bridge terminated.'));
  backend.once('error', () => void stop(1, 'The official backend process could not start.'));
  backend.once('exit', () => { backendEnded = true; if (!stopping) void stop(1, 'The official backend process exited.'); });
  monitorTimer = setInterval(() => { if (!pidAlive(runtime.shimPid)) void stop(0, 'The Desktop shim process closed.'); }, 1000);
  monitorTimer.unref();

  const deadline = Date.now() + 20_000;
  const connect = () => {
    if (stopping) return;
    if (Date.now() >= deadline) { void stop(1, 'The authenticated backend connection did not become ready.'); return; }
    socket = new WebSocket(`ws://127.0.0.1:${config.backendPort}`, {
      headers: { Authorization: `Bearer ${token}` }, perMessageDeflate: false,
      maxPayload: queue.maxBytes, handshakeTimeout: 1500,
    });
    let opened = false;
    socket.once('open', async () => {
      opened = true;
      if (stopping || backendEnded) { socket.terminate(); return; }
      runtime.status = 'running';
      runtime.ready = true;
      try { await persistRuntime(runtime); runtimeWritten = true; }
      catch { void stop(1, 'Could not save the private backend runtime record.'); return; }
      if (stopping) return;
      flush();
    });
    socket.on('message', data => {
      if (stopping) return;
      // ws app-server emits one JSON document per frame. Keep stdout exclusively
      // for the Desktop's JSONL protocol; never write diagnostic text there.
      let line;
      try { line = JSON.stringify(JSON.parse(data.toString('utf8'))) + '\n'; }
      catch { void stop(1, 'The backend returned an invalid protocol frame.'); return; }
      if (!process.stdout.write(line)) socket.pause();
    });
    socket.once('error', () => {}); // Close handles failures without logging credentials or payloads.
    socket.once('close', () => {
      if (stopping) return;
      if (opened) void stop(1, 'The authenticated backend connection closed.');
      else retryTimer = setTimeout(connect, 100);
    });
  };
  connect();
  return done;
}

async function passthrough(config, args) {
  const child = spawn(config.realCliPath, args, { env: childEnvironment(config), stdio: 'inherit', windowsHide: true });
  const forward = signal => { try { child.kill(signal); } catch {} };
  process.once('SIGINT', () => forward('SIGINT'));
  process.once('SIGTERM', () => forward('SIGTERM'));
  return new Promise(resolveExit => {
    child.once('error', () => { console.error('[codex shared-session bridge] The official CLI could not start.'); resolveExit(1); });
    child.once('exit', code => resolveExit(code ?? 1));
  });
}

async function main() {
  const config = await loadConfig();
  const args = process.argv.slice(2);
  const code = await (shouldIntercept(args, process.env, config) ? runBridge(config, args) : passthrough(config, args));
  process.exit(code);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => { console.error('[codex shared-session bridge] Startup failed; check the private launcher configuration and service status.'); process.exit(1); });
}
