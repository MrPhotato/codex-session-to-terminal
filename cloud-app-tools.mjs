import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const SERVER = 'cst_cloud';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const error = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details });
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
function id(value, name = 'conversation ID') {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\x00-\x20]/u.test(value)) {
    throw error('INVALID_ARGUMENT', `A valid ${name} is required.`);
  }
  return value;
}
function duration(value, fallback) {
  const result = value ?? fallback;
  if (!integer(result, 1, 120_000)) throw error('INVALID_ARGUMENT', 'Invalid request deadline.');
  return result;
}
function readArguments(targetId, options) {
  if (!object(options) || Object.keys(options).some(key => !['hostId', 'cursor', 'turnLimit', 'includeOutputs', 'maxOutputCharsPerItem'].includes(key))) {
    throw error('INVALID_ARGUMENT', 'Unsupported conversation read option.');
  }
  const args = { threadId: id(targetId), turnLimit: 10, includeOutputs: false, maxOutputCharsPerItem: 8_000 };
  if (options.hostId !== undefined) {
    if (options.hostId !== 'durable') throw error('INVALID_ARGUMENT', 'Only an explicit durable host is supported.');
    args.hostId = 'durable';
  }
  if (options.cursor !== undefined) {
    if (typeof options.cursor !== 'string' || options.cursor.length === 0 || options.cursor.length > 8_192) {
      throw error('INVALID_ARGUMENT', 'Invalid history cursor.');
    }
    args.cursor = options.cursor;
  }
  if (options.turnLimit !== undefined) {
    if (!integer(options.turnLimit, 1, 50)) throw error('INVALID_ARGUMENT', 'Invalid turn limit.');
    args.turnLimit = options.turnLimit;
  }
  if (options.maxOutputCharsPerItem !== undefined) {
    if (!integer(options.maxOutputCharsPerItem, 1, 32_000)) throw error('INVALID_ARGUMENT', 'Invalid output limit.');
    args.maxOutputCharsPerItem = options.maxOutputCharsPerItem;
  }
  if (options.includeOutputs !== undefined) {
    if (typeof options.includeOutputs !== 'boolean') throw error('INVALID_ARGUMENT', 'Invalid output selection.');
    args.includeOutputs = options.includeOutputs;
  }
  return args;
}
function toolBody(response) {
  if (!object(response) || response.isError === true || response.is_error === true) {
    throw error('APP_TOOL_REJECTED', 'The Desktop app tool did not complete successfully.');
  }
  const structured = response.structuredContent ?? response.structured_content;
  if (object(structured)) return structured;
  if (!Array.isArray(response.content)) throw error('INVALID_TOOL_RESPONSE', 'The Desktop app tool returned invalid content.');
  const candidates = [];
  for (const item of response.content ?? []) {
    if (item?.type !== 'text' || typeof item.text !== 'string') continue;
    try { const body = JSON.parse(item.text); if (object(body)) candidates.push(body); } catch {}
  }
  if (candidates.length !== 1) throw error('INVALID_TOOL_RESPONSE', 'The Desktop app tool returned no unambiguous result.');
  return candidates[0];
}
function deadline(promise, milliseconds, code) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(error(code, 'The operation timed out.')), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

// A bounded official-executor adapter. Endpoint discovery and executable
// verification belong to the caller. This module reads no config or credentials.
// allowSendTargets must come from explicit user authorization, not model output.
// Experimental writes additionally require sendCapability: 'send-or-steer':
// Desktop may change state after a read, so idle-only delivery is not atomic.
export class CloudAppToolsClient {
  #options;
  #allowed;
  #child;
  #pending = new Map();
  #sequence = 0;
  #buffer = '';
  #decoder = new StringDecoder('utf8');
  #ready;
  #helperId;
  #startIssued = false;
  #helperObserved;
  #observeHelper;
  #closed = false;
  #closePromise;
  #broken;
  #sendActive = false;
  #sendUncertain = false;
  #navigateTarget;
  #navigateActive = false;
  #navigateUncertain = false;

  constructor(options = {}) {
    for (const name of ['backendPath', 'nodePath', 'pluginPath', 'cwd']) {
      if (typeof options[name] !== 'string' || !options[name].trim() || /[\0\r\n]/u.test(options[name])) {
        throw error('INVALID_ARGUMENT', `${name} is required.`);
      }
    }
    if (typeof options.resolvePipeEndpoint !== 'function') throw error('INVALID_ARGUMENT', 'A verified Desktop endpoint resolver is required.');
    if (options.allowSendTargets !== undefined && !Array.isArray(options.allowSendTargets) && !(options.allowSendTargets instanceof Set)) {
      throw error('INVALID_ARGUMENT', 'Authorized send targets must be an explicit collection.');
    }
    if (options.sendCapability !== undefined && options.sendCapability !== 'send-or-steer') {
      throw error('INVALID_ARGUMENT', 'Unsupported experimental send capability.');
    }
    this.#allowed = new Set(Array.from(options.allowSendTargets ?? [], target => id(target)));
    if (options.navigateTargets !== undefined && (!Array.isArray(options.navigateTargets) ||
        options.navigateTargets.length !== 1 || typeof options.navigateTargets[0] !== 'string' ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(options.navigateTargets[0]))) {
      throw error('INVALID_ARGUMENT', 'Navigation must bind exactly one session ID.');
    }
    this.#navigateTarget = options.navigateTargets?.[0];
    if (this.#navigateTarget !== undefined && (this.#allowed.size || options.sendCapability !== undefined)) {
      throw error('INVALID_ARGUMENT', 'A navigation helper cannot also enable sending.');
    }
    this.#options = {
      ...options,
      rpcTimeoutMs: duration(options.rpcTimeoutMs, 45_000),
      cleanupTimeoutMs: duration(options.cleanupTimeoutMs, 5_000),
      shutdownTimeoutMs: duration(options.shutdownTimeoutMs, 1_500),
      endpointTimeoutMs: duration(options.endpointTimeoutMs, 10_000),
      maxFrameBytes: options.maxFrameBytes ?? 16 * 1024 * 1024,
      spawnImpl: options.spawnImpl ?? spawn,
    };
    if (!integer(this.#options.maxFrameBytes, 256, 32 * 1024 * 1024)) throw error('INVALID_ARGUMENT', 'Invalid response size limit.');
    if (this.#options.shutdownTimeoutMs > 1_500) throw error('INVALID_ARGUMENT', 'The executor shutdown grace period must not exceed 1500 ms.');
    for (const field of ['disabledPlugins', 'disabledMcpServers']) {
      const key = field === 'disabledPlugins' ? /^[a-zA-Z0-9_.@-]{1,200}$/u : /^[a-zA-Z0-9_-]{1,200}$/u;
      if (options[field] !== undefined && (!Array.isArray(options[field]) || options[field].some(value => typeof value !== 'string' || !key.test(value)))) {
        throw error('INVALID_ARGUMENT', 'Invalid runtime isolation configuration.');
      }
    }
    this.#helperObserved = new Promise(resolve => { this.#observeHelper = resolve; });
  }

  async readConversation(targetId, options = {}) {
    const args = readArguments(targetId, options);
    await this.#ensureReady();
    const body = toolBody(await this.#tool('read_thread', args));
    if (!object(body.thread) || body.thread.id !== targetId || !Array.isArray(body.turns) ||
        args.hostId === 'durable' && (body.thread.hostId !== 'durable' || body.thread.kind !== 'codex')) {
      throw error('INVALID_TOOL_RESPONSE', 'The conversation response does not match the requested chat.');
    }
    // This is the official UI summary, not an authoritative CLI runtime.
    // Its grouped turns can say completed while thread.status is active.
    // Preserve pagination, IDs, and unknown fields without inventing settings.
    return body;
  }

  async listConversations(options = {}) {
    if (!object(options) || Object.keys(options).some(key => key !== 'limit') ||
        options.limit !== undefined && !integer(options.limit, 1, 50)) {
      throw error('INVALID_ARGUMENT', 'A conversation list limit between 1 and 50 is required.');
    }
    await this.#ensureReady();
    const body = toolBody(await this.#tool('list_threads', { limit: options.limit ?? 50 }));
    if (!Array.isArray(body.pinnedThreads) || !Array.isArray(body.threads) ||
        [...body.pinnedThreads, ...body.threads].some(thread => !object(thread) ||
          typeof thread.id !== 'string' || !thread.id || !['codex', 'chatgpt'].includes(thread.kind) ||
          thread.hostId !== null && typeof thread.hostId !== 'string' &&
            !(thread.kind === 'chatgpt' && thread.hostId === undefined))) {
      throw error('INVALID_TOOL_RESPONSE', 'The Desktop conversation list is incomplete.');
    }
    // Preserve both kinds, availability and source titles. Selection belongs to
    // the caller; a recent row is never evidence of the current Desktop page.
    return body;
  }

  async sendText(targetId, text) {
    id(targetId);
    if (!this.#allowed.has(targetId)) throw error('SEND_NOT_AUTHORIZED', 'Sending to this conversation has not been authorized.');
    if (this.#options.sendCapability !== 'send-or-steer') {
      throw error('SEND_DISABLED', 'Experimental cloud sending is disabled without explicit send-or-steer authorization.');
    }
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > 256 * 1024) {
      throw error('INVALID_ARGUMENT', 'A bounded nonempty text message is required.');
    }
    if (this.#sendUncertain) throw error('SEND_OUTCOME_UNKNOWN', 'An earlier send remains unconfirmed; this client will not send again.', { outcome: 'unknown' });
    if (this.#sendActive) throw error('SEND_IN_PROGRESS', 'Another send is in progress.');
    this.#sendActive = true;
    let submitted = false;
    try {
      await this.#ensureReady();
      // Best-effort preflight only. It does not prevent a later Desktop turn
      // from starting before send_message_to_thread receives this request.
      const current = await this.readConversation(targetId, { turnLimit: 1 });
      if (current.thread.status?.type !== 'idle') {
        throw error(current.thread.status?.type === 'active' ? 'CONVERSATION_BUSY' : 'CONVERSATION_STATE_UNKNOWN',
          'The cloud conversation is not confirmed idle; sending is unavailable.');
      }
      const response = await this.#tool('send_message_to_thread', { threadId: targetId, prompt: text }, () => { submitted = true; });
      const body = toolBody(response);
      if (body.threadId !== targetId) throw error('INVALID_TOOL_RESPONSE', 'The send result does not match the requested chat.');
      // This is the official tool result, not a fabricated message receipt.
      return body;
    } catch (cause) {
      if (submitted) {
        this.#sendUncertain = true;
        throw error('SEND_OUTCOME_UNKNOWN', 'The send outcome is unconfirmed. Do not resend automatically.', { outcome: 'unknown', cause });
      }
      throw cause;
    } finally {
      this.#sendActive = false;
    }
  }

  async navigateConversation(targetId) {
    if (targetId !== this.#navigateTarget || this.#navigateTarget === undefined) {
      throw error('NAVIGATION_NOT_AUTHORIZED', 'Navigation is not enabled for this session.');
    }
    if (this.#navigateUncertain) throw error('NAVIGATION_OUTCOME_UNKNOWN', 'Check Desktop before opening a new navigator; this request will not be repeated.', { outcome: 'unknown' });
    if (this.#navigateActive) throw error('NAVIGATION_IN_PROGRESS', 'A navigation request is already in progress.');
    this.#navigateActive = true;
    let submitted = false;
    try {
      await this.#ensureReady();
      const response = await this.#tool('navigate_to_codex_page', { threadId: targetId }, () => { submitted = true; });
      const body = toolBody(response);
      if (body.navigated !== true) throw error('INVALID_TOOL_RESPONSE', 'Desktop did not confirm navigation dispatch.');
      // The official receipt confirms dispatch, not focus, page readiness or a
      // native-to-ChatGPT identity mapping. Never infer any of those here.
      return { navigated: true };
    } catch (cause) {
      if (submitted) {
        this.#navigateUncertain = true;
        throw error('NAVIGATION_OUTCOME_UNKNOWN', 'Navigation may already have happened. Check Desktop; do not retry automatically.', { outcome: 'unknown', cause });
      }
      throw cause;
    } finally { this.#navigateActive = false; }
  }

  #ensureReady() {
    if (this.#closed) return Promise.reject(error('CLIENT_CLOSED', 'The cloud tool client is closed.'));
    if (this.#broken) return Promise.reject(this.#broken);
    return this.#ready ??= this.#start().catch(async cause => { await this.close(); throw cause; });
  }

  async #start() {
    const endpoint = await deadline(Promise.resolve().then(() => this.#options.resolvePipeEndpoint()),
      this.#options.endpointTimeoutMs, 'ENDPOINT_TIMEOUT');
    if (this.#closed) throw error('CLIENT_CLOSED', 'The cloud tool client is closed.');
    if (typeof endpoint !== 'string' || !/^\\\\\.\\pipe\\codex-app-tools-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(endpoint)) {
      throw error('INVALID_ENDPOINT', 'A verified official Desktop app-tools pipe is required.');
    }
    const tools = this.#allowed.size && this.#options.sendCapability === 'send-or-steer'
      ? ['read_thread', 'list_threads', 'send_message_to_thread'] : ['read_thread', 'list_threads'];
    if (this.#navigateTarget !== undefined) tools.push('navigate_to_codex_page');
    const config = [
      ...(this.#options.disabledPlugins ?? []).map(name => `plugins.${JSON.stringify(name)}.enabled=false`),
      // The installed CLI treats quoted MCP override names as different
      // transport entries. Bare identifiers are validated in the constructor.
      ...(this.#options.disabledMcpServers ?? []).map(name => `mcp_servers.${name}.enabled=false`),
      `mcp_servers.${SERVER}.command=${JSON.stringify(this.#options.nodePath)}`,
      `mcp_servers.${SERVER}.args=${JSON.stringify([this.#options.pluginPath])}`,
      `mcp_servers.${SERVER}.enabled=true`,
      `mcp_servers.${SERVER}.enabled_tools=${JSON.stringify(tools)}`,
      `mcp_servers.${SERVER}.default_tools_approval_mode="prompt"`,
      `mcp_servers.${SERVER}.env_vars=["CODEX_APP_TOOLS_PIPE_PATH"]`,
      `mcp_servers.${SERVER}.startup_timeout_sec=15`,
      `mcp_servers.${SERVER}.tool_timeout_sec=${Math.max(1, Math.ceil(this.#options.rpcTimeoutMs / 1_000))}`,
    ];
    this.#child = this.#options.spawnImpl(this.#options.backendPath, [...config.flatMap(value => ['-c', value]), 'app-server'], {
      cwd: this.#options.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...(this.#options.env ?? process.env), CODEX_APP_TOOLS_PIPE_PATH: endpoint },
    });
    const fail = cause => this.#fail(error('HELPER_EXITED', 'The official cloud helper stopped.', {
      ...(typeof cause?.code === 'string' && /^[A-Z0-9_]+$/u.test(cause.code) ? { systemCode: cause.code } : {}),
    }));
    this.#child.on('error', fail);
    this.#child.on('exit', (exitCode, signal) => this.#fail(error('HELPER_EXITED', 'The official cloud helper stopped.', {
      exitCode: Number.isInteger(exitCode) ? exitCode : null,
      signal: typeof signal === 'string' && /^SIG[A-Z0-9]+$/u.test(signal) ? signal : null,
    })));
    this.#child.stdin.on('error', fail);
    this.#child.stdout.on('error', fail);
    this.#child.stderr.on('error', fail);
    this.#child.stderr.on('data', () => {}); // Drain; never retain runtime diagnostics or credentials.
    this.#child.stdout.on('data', bytes => this.#receive(bytes));
    await this.#request('initialize', { clientInfo: { name: 'cst_cloud_tools', version: '0.1' }, capabilities: { experimentalApi: true } });
    this.#write({ method: 'initialized' });
    await this.#request('thread/start', { cwd: this.#options.cwd, sandbox: 'read-only', approvalPolicy: 'on-request', ephemeral: false },
      this.#options.rpcTimeoutMs, () => { this.#startIssued = true; });
    if (!this.#helperId) throw error('INVALID_HELPER', 'The official executor did not return a helper thread.');
    // Publish the real helper's metadata before Desktop resolves its MCP caller.
    await this.#request('thread/name/set', { threadId: this.#helperId, name: 'Codex Session to Terminal 云端连接辅助' });
  }

  #tool(tool, args, onSubmitted) {
    if (this.#closed) return Promise.reject(error('CLIENT_CLOSED', 'The cloud tool client is closed.'));
    return this.#request('mcpServer/tool/call', {
      threadId: this.#helperId, server: SERVER, tool, arguments: args,
    }, this.#options.rpcTimeoutMs, onSubmitted);
  }

  #write(message) {
    if (this.#broken || !this.#child || this.#child.stdin.destroyed || this.#child.stdin.writable === false) {
      throw this.#broken ?? error('HELPER_EXITED', 'The official cloud helper is unavailable.');
    }
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #request(method, params, timeoutMs = this.#options.rpcTimeoutMs, onSubmitted) {
    if (this.#pending.size >= 16) return Promise.reject(error('TOO_MANY_REQUESTS', 'Too many cloud tool requests are pending.'));
    return new Promise((resolve, reject) => {
      const requestId = ++this.#sequence;
      const pending = { resolve, reject, method, timer: null, expired: false };
      pending.timer = setTimeout(() => {
        pending.expired = true;
        // Retain only a late helper creation response so close() can archive it.
        if (method !== 'thread/start') this.#pending.delete(requestId);
        reject(error('RPC_TIMEOUT', 'The official executor request timed out.', { method }));
      }, timeoutMs);
      this.#pending.set(requestId, pending);
      try {
        this.#write({ id: requestId, method, params });
        onSubmitted?.();
      } catch (cause) {
        clearTimeout(pending.timer);
        this.#pending.delete(requestId);
        reject(cause);
      }
    });
  }

  #receive(bytes) {
    this.#buffer += this.#decoder.write(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
    while (true) {
      const end = this.#buffer.indexOf('\n');
      const segment = end < 0 ? this.#buffer : this.#buffer.slice(0, end);
      if (Buffer.byteLength(segment, 'utf8') > this.#options.maxFrameBytes) {
        this.#fail(error('RESPONSE_TOO_LARGE', 'The official executor response exceeded its size limit.'));
        this.#child.kill();
        return;
      }
      if (end < 0) return;
      this.#buffer = this.#buffer.slice(end + 1);
      if (!segment.trim()) continue;
      let message;
      try { message = JSON.parse(segment); } catch {
        this.#fail(error('INVALID_RPC_RESPONSE', 'The official executor returned invalid JSON.'));
        return;
      }
      if (!object(message)) {
        this.#fail(error('INVALID_RPC_RESPONSE', 'The official executor returned an invalid message.'));
        return;
      }
      if (typeof message.method === 'string') {
        if (message.id !== undefined) {
          try { this.#write({ id: message.id, error: { code: -32601, message: 'CST cloud tools cannot approve or answer interactive requests.' } }); } catch {}
        }
        continue;
      }
      const pending = this.#pending.get(message.id);
      if (!pending) continue;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (pending.method === 'thread/start' && typeof message.result?.thread?.id === 'string') {
        try { this.#helperId = id(message.result.thread.id, 'helper thread ID'); this.#observeHelper(); } catch {}
      }
      if (pending.expired) continue;
      if (object(message.error)) pending.reject(error('RPC_REJECTED', 'The official executor rejected the request.', { method: pending.method, rpcCode: message.error.code }));
      else if (Object.hasOwn(message, 'result')) pending.resolve(message.result);
      else pending.reject(error('INVALID_RPC_RESPONSE', 'The official executor returned no result.'));
    }
  }

  #fail(cause) {
    this.#broken ??= cause;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error(cause.code, cause.message, {
        method: pending.method, exitCode: cause.exitCode, signal: cause.signal, systemCode: cause.systemCode,
      }));
    }
    this.#pending.clear();
    this.#observeHelper();
  }

  close() {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    return this.#closePromise = this.#cleanup();
  }

  async #cleanup() {
    const result = { helperThreadId: this.#helperId ?? null, archived: false, helperMayExist: false };
    const until = Date.now() + this.#options.cleanupTimeoutMs;
    for (const [requestId, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error('CLIENT_CLOSED', 'The cloud tool client is closing.'));
      pending.expired = true;
      if (pending.method !== 'thread/start') this.#pending.delete(requestId);
    }
    if (this.#startIssued && !this.#helperId && !this.#broken) {
      try { await deadline(this.#helperObserved, Math.max(1, until - Date.now()), 'CLEANUP_TIMEOUT'); } catch {}
    }
    result.helperThreadId = this.#helperId ?? null;
    if (this.#helperId && !this.#broken && Date.now() < until) {
      try {
        await this.#request('thread/archive', { threadId: this.#helperId }, Math.max(1, until - Date.now()));
        result.archived = true;
      } catch {}
    }
    result.helperMayExist = this.#startIssued && !result.archived;
    this.#fail(error('CLIENT_CLOSED', 'The cloud tool client is closed.'));
    await this.#shutdown();
    this.#buffer = '';
    return result;
  }

  async #shutdown() {
    const child = this.#child;
    if (!child || child.exitCode !== null) return;
    let exited;
    const stopped = new Promise(resolve => { exited = resolve; });
    child.once('exit', exited);
    child.once('error', exited);
    try {
      // EOF lets the official executor dispose its own MCP child processes.
      // This grace period is separate from the bounded archival deadline.
      try { child.stdin.end(); } catch {}
      if (child.exitCode === null) {
        try { await deadline(stopped, this.#options.shutdownTimeoutMs, 'SHUTDOWN_TIMEOUT'); } catch {}
      }
      if (child.exitCode === null) child.kill();
    } finally {
      child.off('exit', exited);
      child.off('error', exited);
    }
  }
}
