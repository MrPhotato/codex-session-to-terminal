import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';
import { RpcClient } from './rpc-client.mjs';

let client;
try {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--config' || args[2] !== '--thread'
      || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(args[3])) throw new Error();
  const config = JSON.parse(await fs.readFile(args[1], 'utf8'));
  const runtime = JSON.parse(await fs.readFile(config.runtimeFile, 'utf8'));
  const desktop = JSON.parse(await fs.readFile(path.join(config.root, 'desktop.json'), 'utf8'));
  if (!runtime.ready || !desktop.generation || runtime.generation !== desktop.generation) throw new Error();
  const token = (await fs.readFile(config.backendTokenFile, 'utf8')).trim();
  client = new RpcClient(`ws://127.0.0.1:${config.backendPort}`, {
    name:'codex_shared_attach_check', timeoutMs:10000,
    createSocket:url=>new WebSocket(url,{headers:{Authorization:`Bearer ${token}`}}),
  });
  await client.connect();
  const loaded = await client.call('thread/loaded/list', {});
  if (!(loaded.data ?? []).some(id => id.toLowerCase() === args[3].toLowerCase())) throw new Error();
  const result = await client.call('thread/read', {threadId:args[3]});
  if (result.thread?.id?.toLowerCase() !== args[3].toLowerCase()) throw new Error();
  console.log('Connecting to the same local chat. Closing this terminal will leave Desktop running.');
} catch {
  console.error('The current chat could not be verified on the shared Desktop backend.');
  process.exitCode = 1;
} finally { client?.close(); }
