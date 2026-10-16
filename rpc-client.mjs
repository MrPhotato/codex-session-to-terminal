// Loopback RPC client for bounded connection verification; no model calls.
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_TIMEOUT = 45_000;

export function localUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'ws:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) {
    throw new Error('This client accepts only a loopback ws:// URL.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Put any bearer token in the token environment variable, not the URL.');
  }
  return url.href;
}

export function safeError(error, secret = '') {
  let message = String(error?.message ?? error);
  if (secret) message = message.split(secret).join('[redacted]');
  return message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 1500);
}

export async function websocketFactory({ token = '', wsModule } = {}) {
  if (token || wsModule) {
    let module;
    try {
      module = await import(wsModule && isAbsolute(wsModule) ? pathToFileURL(wsModule).href : wsModule || 'ws');
    } catch {
      throw new Error('Bearer authentication requires the ws package or --ws-module with its absolute entry path.');
    }
    const WebSocketClass = module.WebSocket ?? module.default;
    return url => new WebSocketClass(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  }
  if (typeof globalThis.WebSocket !== 'function') {
    throw new Error('Use Node 22+ or provide --ws-module with the ws package entry path.');
  }
  return url => new globalThis.WebSocket(url);
}

// Exported for the launcher and bounded tests. RPC calls never retry: a retry of
// turn/start could run the same prompt twice after an ambiguous transport error.
export class RpcClient {
  constructor(url, { name = 'session_bridge_check', createSocket, timeoutMs = DEFAULT_TIMEOUT } = {}) {
    this.url = localUrl(url);
    this.name = name;
    this.createSocket = createSocket ?? (url => new globalThis.WebSocket(url));
    this.timeoutMs = timeoutMs;
    this.sequence = 0;
    this.pending = new Map();
    this.events = [];
    this.listeners = new Set();
    this.rejectedServerRequests = [];
    this.closed = false;
  }

  async connect() {
    this.socket = this.createSocket(this.url);
    this.socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString()); }
      catch { this.fail(new Error('App-server returned an invalid JSON message.')); return; }
      if (message.id !== undefined && message.method) {
        // Tests never authorize tools, approvals, login, or external actions.
        this.rejectedServerRequests.push({ method: message.method, id: message.id });
        this.socket.send(JSON.stringify({ id: message.id, error: { code: -32601, message: 'This connection checker does not handle server requests.' } }));
      } else if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message ?? 'RPC error'} (code ${message.error.code})`));
        else pending.resolve(message.result);
      } else if (message.method) {
        const event = { ...message, receivedAt: Date.now() };
        this.events.push(event);
        if (this.events.length > 10_000) this.events.shift();
        for (const listener of this.listeners) listener(event);
      }
    });
    this.socket.addEventListener('close', () => {
      this.closed = true;
      this.fail(new Error('App-server connection closed.'));
    });
    this.socket.addEventListener('error', () => this.fail(new Error('App-server WebSocket connection failed.')));
    await new Promise((resolveOpen, reject) => {
      const timer = setTimeout(() => reject(new Error('App-server WebSocket connection timed out.')), this.timeoutMs);
      this.socket.addEventListener('open', () => { clearTimeout(timer); resolveOpen(); }, { once: true });
      this.socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('App-server WebSocket connection failed.')); }, { once: true });
      this.socket.addEventListener('close', () => { clearTimeout(timer); reject(new Error('App-server closed before initialization.')); }, { once: true });
    });
    this.serverInfo = await this.call('initialize', {
      clientInfo: { name: this.name, title: 'Session Bridge connection check', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.notify('initialized', {});
    return this.serverInfo;
  }

  call(method, params = {}, timeoutMs = this.timeoutMs) {
    if (!this.socket || this.socket.readyState !== 1) return Promise.reject(new Error('App-server connection is not open.'));
    const id = ++this.sequence;
    return new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out. Its outcome may be unknown; it was not retried.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveResult, reject, timer, method });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  notify(method, params = {}) {
    this.socket.send(JSON.stringify({ method, params }));
  }

  waitFor(method, predicate = () => true, { since = 0, timeoutMs = this.timeoutMs } = {}) {
    const match = event => event.receivedAt >= since && event.method === method && predicate(event.params ?? {});
    const existing = this.events.find(match);
    if (existing) return Promise.resolve(existing);
    if (this.closed) return Promise.reject(new Error(`Connection closed before ${method}.`));
    return new Promise((resolveEvent, reject) => {
      const finish = (error, event) => {
        clearTimeout(timer);
        this.listeners.delete(listener);
        this.listeners.delete(onFailure);
        if (error) reject(error); else resolveEvent(event);
      };
      const listener = event => { if (match(event)) finish(null, event); };
      const onFailure = event => { if (event.method === '__connectionFailure') finish(event.error); };
      const timer = setTimeout(() => finish(new Error(`Did not observe ${method} before the timeout.`)), timeoutMs);
      this.listeners.add(listener);
      this.listeners.add(onFailure);
    });
  }

  fail(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const listener of [...this.listeners]) listener({ method: '__connectionFailure', error });
  }

  close() {
    this.closed = true;
    this.fail(new Error('Connection checker closed.'));
    if (!this.socket || this.socket.readyState === 3) return;
    this.socket.close();
    if (typeof this.socket.terminate === 'function') {
      const timer = setTimeout(() => this.socket.terminate(), 500);
      timer.unref();
    }
  }
}
