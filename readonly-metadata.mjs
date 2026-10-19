import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { isAbsolute } from 'node:path';

export const METADATA_METHODS = new Set([
  'initialize', 'account/read', 'model/list', 'configRequirements/read',
  'collaborationMode/list', 'config/read', 'thread/read',
  'thread/turns/list', 'thread/items/list',
  'skills/list', 'hooks/list', 'thread/goal/get', 'account/rateLimits/read',
  'account/bedrock/checkGovCloudRequirements',
]);

export function createMetadataReader(backendPath, { timeoutMs = 30000, env = process.env } = {}) {
  if (!isAbsolute(backendPath)) throw new Error('An absolute official backend path is required.');
  const child = spawn(backendPath, ['app-server'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env });
  const pending = new Map(), decoder = new StringDecoder('utf8');
  const methods = new Set();
  let sequence = 0, buffer = '', closed = false;
  const fail = message => {
    closed = true;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(message)); }
    pending.clear();
  };
  child.stderr.on('data', () => {});
  child.on('error', () => fail('The official metadata helper could not start.'));
  child.on('exit', () => fail('The official metadata helper exited.'));
  child.stdin.on('error', () => fail('The metadata helper input closed.'));
  child.stdout.on('error', () => fail('The metadata helper output closed.'));
  child.stdout.on('data', bytes => {
    buffer += decoder.write(bytes);
    if (buffer.length > 64 * 1024 * 1024) { fail('Metadata exceeded the read limit.'); child.kill(); return; }
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { fail('Invalid metadata response.'); child.kill(); return; }
      if (message.method && message.id !== undefined) {
        if (!closed) child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'The read-only CST metadata helper does not handle server requests.' } }) + '\n');
      } else if (message.id !== undefined) {
        const item = pending.get(message.id);
        if (!item) continue;
        pending.delete(message.id); clearTimeout(item.timer);
        if (message.error) item.reject(Object.assign(new Error(`${item.method} was rejected.`), { rpcError: { code: message.error.code, message: `${item.method} was rejected by the official metadata helper.` } }));
        else item.resolve(message.result);
      }
    }
  });
  const call = (method, params = {}) => {
    if (!METADATA_METHODS.has(method)) return Promise.reject(Object.assign(new Error('Read-only metadata method is not allowed.'), { rpcError: { code: -32601, message: 'Unsupported read-only method.' } }));
    if (closed) return Promise.reject(new Error('The metadata helper is closed.'));
    methods.add(method);
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out.`)); }, timeoutMs);
      pending.set(id, { resolve, reject, timer, method });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  };
  return {
    call,
    get pid() { return child.pid; },
    get methods() { return [...methods]; },
    async initialize() {
      const result = await call('initialize', { clientInfo: { name: 'codex_session_to_terminal', version: '0.2' }, capabilities: { experimentalApi: true } });
      child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
      return result;
    },
    async close() {
      fail('The metadata helper is closing.');
      child.stdin.end();
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise(resolve => {
        const timer = setTimeout(() => { child.kill(); resolve(); }, 1500);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    },
  };
}
