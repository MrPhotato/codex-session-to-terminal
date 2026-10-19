import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

// Desktop's existing client-coordination protocol, observed in 26.1013.4894.0.
// This never starts a router, resumes a thread, or announces thread ownership.
// The transport factory MUST authenticate the pipe peer before returning a stream.
const VERSIONS = Object.freeze({ initialize: 0, 'thread-owner-discovery': 1,
  'thread-follower-start-turn': 2, 'thread-follower-steer-turn': 1 });
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const revision = value => Number.isSafeInteger(value) && value >= 0;

function failure(code, message, outcomeUnknown = false) {
  return Object.assign(new Error(message), { code, outcomeUnknown });
}

// Immer patches use array paths, not JSON Pointer strings. Copy only affected
// ancestors: cloning a multi-megabyte conversation for each text delta is costly.
export function applyDesktopPatches(state, patches) {
  if (!Array.isArray(patches) || patches.length > 10000) throw failure('INVALID_PATCH', 'Invalid Desktop patches.');
  let next = state;
  for (const patch of patches) {
    if (!object(patch) || !['add', 'replace', 'remove'].includes(patch.op) || !Array.isArray(patch.path) || patch.path.length > 128 ||
      patch.path.some(key => !(typeof key === 'string' || Number.isSafeInteger(key)) || FORBIDDEN_KEYS.has(key))) {
      throw failure('INVALID_PATCH', 'Unsupported Desktop patch shape.');
    }
    if (patch.op !== 'remove' && !own(patch, 'value')) throw failure('INVALID_PATCH', 'Desktop patch has no value.');
    if (!patch.path.length) {
      if (patch.op === 'remove' || !object(patch.value)) throw failure('INVALID_PATCH', 'Invalid conversation replacement.');
      next = patch.value;
      continue;
    }
    const update = (node, depth) => {
      if (node === null || typeof node !== 'object') throw failure('INVALID_PATCH', 'Desktop patch parent is unavailable.');
      const key = patch.path[depth], array = Array.isArray(node), last = depth === patch.path.length - 1;
      if (array && (!Number.isSafeInteger(key) || key < 0 || key > node.length || (!last || patch.op !== 'add') && key >= node.length)) {
        throw failure('INVALID_PATCH', 'Desktop patch index is unavailable.');
      }
      if ((!last || patch.op !== 'add') && !own(node, key)) throw failure('INVALID_PATCH', 'Desktop patch target is unavailable.');
      const copy = array ? node.slice() : { ...node };
      if (!last) copy[key] = update(node[key], depth + 1);
      else if (patch.op === 'remove') array ? copy.splice(key, 1) : delete copy[key];
      else if (patch.op === 'add' && array) copy.splice(key, 0, patch.value);
      else copy[key] = patch.value;
      return copy;
    };
    next = update(next, 0);
  }
  return next;
}

function latestTurn(state) {
  if (state?.turnHistory?.kind === 'canonical') {
    const history = state.turnHistory.history;
    const tail = history?.islands?.at(-1);
    if (tail?.newerBoundary?.status !== 'exhausted') throw failure('INCOMPLETE_STATE', 'The live end of this conversation is unavailable.');
    const entries = tail.entries;
    if (!Array.isArray(entries) || !object(history.entitiesByKey)) throw failure('INCOMPLETE_STATE', 'Invalid live conversation history.');
    // A new optimistic turn can exist beside the canonical transcript before
    // its server ID arrives. Do not mistake the previous completed turn for idle.
    if (state.turns?.some(turn => turn?.status === 'inProgress' && turn.turnId == null)) {
      throw failure('NOT_READY', 'The current turn is still being admitted.');
    }
    for (let index = entries.length - 1; index >= 0; index--) {
      const turn = history.entitiesByKey[entries[index]?.value];
      if (turn && (turn.turnId != null || !['completed', 'failed'].includes(turn.status))) return turn;
    }
    return null;
  }
  if (!Array.isArray(state?.turns)) throw failure('INCOMPLETE_STATE', 'Live conversation turns are unavailable.');
  return state.turns.findLast(turn => turn && (turn.turnId != null || !['completed', 'failed'].includes(turn.status))) ?? null;
}

/**
 * Events: state(conversationState, {revision, acceptedTextChanges}),
 * status({phase, ready, reason?}), error(Error with code/outcomeUnknown).
 * state is read-only to consumers; it is the unmodified Desktop schema.
 * connect resolves only after a validated snapshot. No write is ever replayed.
 */
export class DesktopIpcClient extends EventEmitter {
  constructor({ transportFactory, queueSender, timeoutMs = 5000, connectTimeoutMs = 15000, maxFrameBytes = 64 * 1024 * 1024, maxInputBytes = 256 * 1024 } = {}) {
    super();
    if (typeof transportFactory !== 'function') throw failure('VERIFIED_TRANSPORT_REQUIRED', 'An authenticated Desktop pipe transport is required.');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new TypeError('Invalid timeoutMs.');
    if (!Number.isSafeInteger(connectTimeoutMs) || connectTimeoutMs < 1 || connectTimeoutMs > 60000) throw new TypeError('Invalid connectTimeoutMs.');
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1024 || maxFrameBytes > 268435456) throw new TypeError('Invalid maxFrameBytes.');
    if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes < 1 || maxInputBytes > 1024 * 1024) throw new TypeError('Invalid maxInputBytes.');
    this.options = { transportFactory, queueSender, timeoutMs, connectTimeoutMs, maxFrameBytes, maxInputBytes };
    this._status = { phase: 'idle', ready: false };
    this._state = null; this._owner = null; this._revision = null;
    this._pending = new Map(); this._socket = null; this._clientId = null;
    this._closed = true; this._generation = 0; this._sending = false;
    this._header = Buffer.alloc(4); this._headerUsed = 0; this._body = null; this._bodyUsed = 0;
    this._snapshotTimer = null; this._readyWaiter = null; this._discovering = false;
  }

  get state() { return this._state; }
  get owner() { return this._owner && { ...this._owner }; }
  get currentOwner() { return this.owner; }
  get status() { return { ...this._status }; }
  get revision() { return this._revision; }
  get threadId() { return this._threadId ?? null; }

  _setStatus(phase, reason) {
    this._status = { phase, ready: phase === 'ready', ...(reason ? { reason } : {}) };
    this.emit('status', this.status);
  }
  _report(error) { if (this.listenerCount('error')) this.emit('error', error); }
  _rejectPending(error) {
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(failure(error.code, error.message, pending.write));
    }
    this._pending.clear();
  }

  async connect(threadId) {
    if (!id(threadId)) throw failure('INVALID_THREAD', 'A valid conversation ID is required.');
    if (!this._closed) throw failure('ALREADY_CONNECTED', 'Close this connection before connecting again.');
    this._closed = false; this._threadId = threadId; this._state = null; this._revision = null; this._owner = null;
    this._clientId = null; this._headerUsed = 0; this._body = null; this._bodyUsed = 0;
    const generation = ++this._generation;
    this._abort = new AbortController();
    this._setStatus('connecting');
    let timer;
    try {
      const transport = Promise.resolve().then(() => this.options.transportFactory({ signal: this._abort.signal }));
      transport.then(socket => { if (generation !== this._generation || this._closed) socket?.destroy(); }, () => {});
      const socket = await Promise.race([transport, new Promise((_, reject) => {
        timer = setTimeout(() => reject(failure('CONNECT_TIMEOUT', 'Desktop connection timed out.')), this.options.connectTimeoutMs);
      })]);
      clearTimeout(timer);
      if (this._closed || generation !== this._generation) throw failure('CLOSED', 'Connection was closed.');
      if (!socket?.on || typeof socket.write !== 'function' || socket.destroyed || !socket.writable) throw failure('INVALID_TRANSPORT', 'Desktop transport is not a connected duplex stream.');
      this._socket = socket;
      socket.on('data', chunk => {
        if (this._closed || generation !== this._generation) return;
        try { this._parse(chunk); } catch { this._disconnect(failure('PROTOCOL_ERROR', 'Desktop sent an unsupported or invalid frame.')); }
      });
      socket.on('error', () => { if (generation === this._generation) this._disconnect(failure('TRANSPORT_ERROR', 'Desktop connection failed.')); });
      socket.on('close', () => { if (generation === this._generation) this._disconnect(failure('DISCONNECTED', 'Desktop connection closed.')); });
      socket.on('end', () => { if (generation === this._generation) this._disconnect(failure('DISCONNECTED', 'Desktop connection ended.')); });
      this._setStatus('initializing');
      const init = await this._request('initialize', { clientType: 'cst-terminal' });
      if (!id(init.result?.clientId)) throw failure('PROTOCOL_ERROR', 'Desktop initialization returned no client ID.');
      this._clientId = init.result.clientId;
      const ready = new Promise((resolve, reject) => { this._readyWaiter = { resolve, reject }; });
      // Handle rejection while owner discovery is still in flight.
      ready.catch(() => {});
      await this._discover();
      await ready;
      return this;
    } catch (error) {
      clearTimeout(timer);
      this._disconnect(error);
      throw error;
    }
  }

  _parse(chunk) {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    let offset = 0;
    while (offset < chunk.length) {
      if (!this._body) {
        const length = Math.min(4 - this._headerUsed, chunk.length - offset);
        chunk.copy(this._header, this._headerUsed, offset, offset + length);
        offset += length; this._headerUsed += length;
        if (this._headerUsed < 4) continue;
        const bytes = this._header.readUInt32LE(0);
        if (!bytes || bytes > this.options.maxFrameBytes) throw failure('FRAME_TOO_LARGE', 'Desktop frame exceeds the configured limit.');
        this._body = Buffer.allocUnsafe(bytes); this._bodyUsed = 0;
      }
      const length = Math.min(this._body.length - this._bodyUsed, chunk.length - offset);
      chunk.copy(this._body, this._bodyUsed, offset, offset + length);
      offset += length; this._bodyUsed += length;
      if (this._bodyUsed === this._body.length) {
        const message = JSON.parse(this._body.toString('utf8'));
        this._body = null; this._bodyUsed = 0; this._headerUsed = 0;
        this._receive(message);
        if (this._closed) return;
      }
    }
  }

  _write(message) {
    if (this._closed || !this._socket?.writable) throw failure('DISCONNECTED', 'Desktop is not connected.');
    const body = Buffer.from(JSON.stringify(message));
    if (body.length > this.options.maxFrameBytes) throw failure('FRAME_TOO_LARGE', 'Outgoing frame is too large.');
    const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
    this._socket.write(Buffer.concat([header, body]));
  }

  _request(method, params, { write = false, target = null } = {}) {
    const version = VERSIONS[method];
    if (version === undefined) return Promise.reject(failure('UNSUPPORTED_METHOD', 'Unsupported Desktop request.'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(requestId);
        reject(failure('REQUEST_TIMEOUT', write ? 'Delivery is unconfirmed. Check Desktop before sending again.' : 'Desktop request timed out.', write));
      }, this.options.timeoutMs);
      this._pending.set(requestId, { resolve, reject, timer, method, target, write });
      try {
        this._write({ type: 'request', requestId, sourceClientId: this._clientId ?? 'initializing-client', version, method, params,
          timeoutMs: this.options.timeoutMs, ...(target ? { targetClientId: target } : {}) });
      } catch (error) {
        clearTimeout(timer); this._pending.delete(requestId); reject(error);
      }
    });
  }

  _follow(following) {
    if (!this._clientId || !this._owner) return;
    this._write({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1,
      sourceClientId: this._clientId, targetClientIds: [this._owner.clientId],
      params: { hostId: 'local', conversationId: this._threadId, following } });
  }

  async _discover() {
    if (this._discovering || this._closed) return;
    this._discovering = true;
    this._setStatus('discovering');
    try {
      const response = await this._request('thread-owner-discovery', { hostId: 'local', conversationId: this._threadId });
      if (!id(response.handledByClientId) || response.handledByClientId === this._clientId) throw failure('NO_OWNER', 'No existing Desktop owner was found.');
      this._owner = { clientId: response.handledByClientId, supportsUntrustedAppInput: response.result?.supportsUntrustedAppInput === true };
      this._resync();
    } finally { this._discovering = false; }
  }

  _resync() {
    if (this._closed || !this._owner) return;
    if (this._snapshotTimer) return;
    this._setStatus('syncing');
    // Repeating following=true explicitly requests a fresh snapshot; no owner change.
    this._snapshotTimer = setTimeout(() => {
      this._snapshotTimer = null;
      this._disconnect(failure('SNAPSHOT_TIMEOUT', 'Desktop did not provide a current snapshot.'));
    }, this.options.timeoutMs);
    this._follow(true);
  }

  _receive(message) {
    if (!object(message)) throw failure('PROTOCOL_ERROR', 'Invalid Desktop frame.');
    if (message.type === 'response') {
      const pending = this._pending.get(message.requestId);
      if (!pending) return;
      if (message.resultType === 'success' && (message.method !== pending.method || pending.target && message.handledByClientId !== pending.target)) return;
      clearTimeout(pending.timer); this._pending.delete(message.requestId);
      if (message.resultType === 'success') pending.resolve(message);
      else pending.reject(failure('REMOTE_ERROR', pending.write ? 'Desktop did not confirm delivery. Check the conversation before retrying.' : 'Desktop could not handle this request.', pending.write));
      return;
    }
    if (message.type === 'client-discovery-request') {
      if (id(message.requestId)) this._write({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } });
      return;
    }
    if (message.type !== 'broadcast') return;
    if (message.targetClientIds && (!Array.isArray(message.targetClientIds) || !message.targetClientIds.includes(this._clientId))) return;
    const params = message.params;
    if (message.method === 'client-status-changed' && message.version === 0 && message.sourceClientId === this._owner?.clientId && params?.clientId === this._owner?.clientId && params.status === 'disconnected') {
      clearTimeout(this._snapshotTimer); this._snapshotTimer = null;
      this._owner = null; this._revision = null;
      this._setStatus('owner-unavailable');
      const error = failure('OWNER_DISCONNECTED', 'The Desktop owner disconnected.');
      this._rejectPending(error);
      this._readyWaiter?.reject(error); this._readyWaiter = null;
      return;
    }
    if (message.method === 'client-status-changed' && message.version === 0 && !this._owner && params?.status === 'connected' && this._clientId) {
      void this._discover().catch(error => { this._setStatus('owner-unavailable'); this._report(error); });
      return;
    }
    if (message.method === 'thread-stream-following-status-requested' && message.version === 1 && this._owner && message.sourceClientId === this._owner.clientId) {
      if (params?.conversationId === this._threadId && params.hostId === 'local') this._follow(true);
      return;
    }
    if (message.method !== 'thread-stream-state-changed' || message.sourceClientId !== this._owner?.clientId || params?.conversationId !== this._threadId || params.hostId !== 'local') return;
    if (message.version !== 11) throw failure('UNSUPPORTED_VERSION', 'Desktop stream protocol version is unsupported.');
    const change = params.change;
    if (!object(change) || !revision(change.revision)) throw failure('PROTOCOL_ERROR', 'Invalid Desktop stream revision.');
    if (change.type === 'snapshot') {
      if (!object(change.conversationState) || change.conversationState.id !== this._threadId || !Array.isArray(change.conversationState.turns)) throw failure('PROTOCOL_ERROR', 'Desktop snapshot belongs to a different or invalid conversation.');
      if (this._revision !== null && change.revision < this._revision) return;
      this._state = change.conversationState; this._revision = change.revision;
      clearTimeout(this._snapshotTimer); this._snapshotTimer = null;
      this._setStatus('ready');
      this._readyWaiter?.resolve(); this._readyWaiter = null;
      this.emit('state', this._state, { revision: this._revision, acceptedTextChanges: [] });
      return;
    }
    if (change.type !== 'patches') throw failure('PROTOCOL_ERROR', 'Unsupported Desktop stream change.');
    if (this._status.phase !== 'ready') return;
    if (change.revision <= this._revision) return; // Already applied; never roll back.
    if (change.baseRevision !== this._revision || change.revision !== change.baseRevision + 1) { this._resync(); return; }
    try {
      const updated = applyDesktopPatches(this._state, change.patches);
      if (updated.id !== this._threadId || !Array.isArray(updated.turns)) throw failure('INVALID_PATCH', 'Invalid conversation state.');
      this._state = updated; this._revision = change.revision;
    } catch { this._resync(); return; }
    this.emit('state', this._state, { revision: this._revision, acceptedTextChanges: Array.isArray(change.acceptedTextChanges) ? change.acceptedTextChanges : [] });
  }

  async send(text, { mode = 'steer' } = {}) {
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > this.options.maxInputBytes) throw failure('INVALID_INPUT', 'Enter a nonempty message within the input size limit.');
    if (!['steer', 'queue'].includes(mode)) throw failure('INVALID_MODE', 'Choose steer or queue.');
    if (!this._status.ready || !this._owner) throw failure('NOT_READY', 'Wait for a current Desktop snapshot before sending.');
    if (this._sending) throw failure('SEND_IN_PROGRESS', 'Wait for the previous delivery result.');
    if (mode === 'queue' && typeof this.options.queueSender !== 'function') throw failure('UNSUPPORTED_QUEUE', 'This connection has no safe queue append implementation.');
    const messageId = randomUUID(), owner = this._owner.clientId;
    this._sending = true;
    try {
      if (mode === 'queue') {
        const result = await this.options.queueSender({ threadId: this._threadId, text, clientUserMessageId: messageId, state: this._state, signal: this._abort.signal });
        return { action: 'queue', clientUserMessageId: messageId, result };
      }
      const active = latestTurn(this._state);
      const isActive = active?.status === 'inProgress';
      if (isActive && !id(active.turnId)) throw failure('NOT_READY', 'The current turn is still being admitted.');
      if (active && !['inProgress', 'completed', 'failed', 'interrupted'].includes(active.status)) throw failure('NOT_READY', 'The Desktop turn is not ready for input.');
      if (typeof this._state.cwd !== 'string' || !this._state.cwd) throw failure('INCOMPLETE_STATE', 'The conversation workspace is unavailable.');
      const input = [{ type: 'text', text, text_elements: [] }];
      const restoreMessage = { id: messageId, text, cwd: this._state.cwd, createdAt: Date.now(), context: {
        prompt: text, addedFiles: [], fileAttachments: [], ideContext: null, imageAttachments: [], workspaceRoots: [this._state.cwd],
      } };
      const action = isActive ? 'steer' : 'start';
      const params = isActive ? { conversationId: this._threadId, input, restoreMessage, attachments: [], clientUserMessageId: messageId }
        : { conversationId: this._threadId, turnStart: { request: { threadId: this._threadId, input, clientUserMessageId: messageId }, context: { restoreMessage, inheritThreadSettings: true } } };
      const response = await this._request(`thread-follower-${action}-turn`, params, { target: owner, write: true });
      const result = response.result?.result;
      if (!(action === 'start' ? id(result?.turn?.id) : id(result?.turnId))) {
        throw failure('DELIVERY_UNCONFIRMED', '发送结果未确认。请先在 ChatGPT 检查当前会话，避免重复发送；CST 没有重试。', true);
      }
      return { action, clientUserMessageId: messageId, result };
    } finally { this._sending = false; }
  }

  _disconnect(error) {
    if (this._closed) return;
    this._closed = true; ++this._generation; this._abort?.abort();
    clearTimeout(this._snapshotTimer); this._snapshotTimer = null;
    this._rejectPending(error);
    this._readyWaiter?.reject(error); this._readyWaiter = null;
    this._socket?.destroy(); this._socket = null;
    this._owner = null; this._revision = null; this._body = null;
    this._setStatus('disconnected', error.code);
    if (error.code !== 'CLOSED') this._report(error);
  }

  close() {
    if (this._closed) return;
    try { this._follow(false); this._socket?.end(); } catch { /* Disconnect itself removes follower registration. */ }
    this._disconnect(failure('CLOSED', 'Connection closed.'));
    this._setStatus('closed');
  }
}
