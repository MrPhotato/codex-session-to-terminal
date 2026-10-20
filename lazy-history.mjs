import { randomUUID } from 'node:crypto';
import { apiTurn, apiItems } from './desktop-events.mjs';

const invalid = message => Object.assign(new Error(message), {
  code: 'HISTORY_NOT_READY', rpcError: { code: -32602, message },
});
const unavailable = message => Object.assign(invalid(message), { code: 'LAZY_HISTORY_UNAVAILABLE' });
const clone = value => structuredClone(value);
const key = entry => `${entry.turnId}\0${entry.item.id}`;
// The native CLI hydrates enough rendered rows for its viewport. Small pages
// reduce overshoot without changing its settings or hiding the continuation.
export const HISTORY_ITEM_PAGE_SIZE = 20;

// Keep the live snapshot and streamed deltas on one immutable baseline. Older
// items are read only when the native TUI asks for them, strictly before that
// baseline's item boundary. The helper never resumes or owns the Desktop chat.
export class LazyHistory {
  constructor(state, { threadId, call } = {}) {
    if (typeof threadId !== 'string' || typeof call !== 'function') throw invalid('A read-only history reader and chat identity are required.');
    const canonical = state.turnHistory?.kind === 'canonical' ? state.turnHistory.history : null;
    const islands = canonical?.islands ?? [];
    const tail = islands.at(-1);
    if (!tail || tail.newerBoundary?.status !== 'exhausted') throw invalid('Desktop has not supplied the current end of this chat. Open the chat in Desktop and reconnect.');
    if (state.turns?.some(turn => turn.status === 'inProgress' && !turn.turnId)) throw invalid('Desktop is still admitting a new turn. Reconnect when that turn appears.');
    this.threadId = threadId;
    this.call = call;
    this.epoch = randomUUID();
    this.queue = Promise.resolve();
    this.turnRows = [];
    this.turnsById = new Map();
    this.deferredTurns = new Map();
    this.itemStreams = new Map();
    this.streams = new Map();
    this.turnCursors = new Set();
    const visible = (tail.entries ?? []).map(entry => canonical.entitiesByKey?.[entry.value]);
    if (visible.some(turn => !turn?.turnId)) throw invalid('Desktop supplied an unresolved history boundary. Reconnect after the chat loads.');
    // Optimistic/current turns may be outside the canonical island. Only append
    // confirmed turns absent from every canonical island; otherwise an older
    // island would accidentally be appended at the current end.
    const canonicalIds = new Set(islands.flatMap(island => (island.entries ?? [])
      .map(entry => canonical.entitiesByKey?.[entry.value]?.turnId)));
    for (const turn of state.turns ?? []) if (turn?.turnId && !canonicalIds.has(turn.turnId)) visible.push(turn);
    const frozen = new Map();
    for (const [index, turn] of visible.entries()) {
      if (frozen.has(turn.turnId)) continue;
      const shell = clone({ ...apiTurn(turn, { emptyItems: true }), itemsView: 'notLoaded' });
      frozen.set(turn.turnId, shell);
      this.turnsById.set(turn.turnId, shell);
      if (index >= visible.length - 5 || turn.status === 'inProgress') this.itemStreams.set(turn.turnId, this.#freezeItems(turn));
      else {
        // DesktopIpcClient applies patches immutably. Keep the old completed
        // turn object from this baseline and project its items only if reached;
        // do not scan/copy a loaded multi-year transcript during attachment.
        this.deferredTurns.set(turn.turnId, turn);
      }
    }
    this.turnRows = [...frozen.values()].reverse();
    this.baselineIds = new Set(frozen.keys());
    const boundary = tail.olderBoundary;
    if (!['exhausted', 'available'].includes(boundary?.status)) throw invalid('Desktop has not established the older history boundary. Reconnect after the chat loads.');
    this.turnsComplete = boundary.status === 'exhausted';
    const handle = boundary.handle;
    this.turnCursor = typeof handle?.cursor === 'string' && handle.source !== 'timeline' ? handle.cursor : null;
    this.needsTurnAnchor = !this.turnsComplete && !this.turnCursor;
    this.skippingBaseline = this.needsTurnAnchor;
    if (this.needsTurnAnchor && !this.baselineIds.size) throw invalid('Desktop has not supplied a recent turn to anchor older history.');
  }

  // Resume only needs shells; the official CLI hydrates bounded item pages.
  get turns() { return this.turnRows.slice(0, 5).map(clone).reverse(); }

  #freezeItems(turn) {
    const pagination = turn.itemsPagination ?? {};
    if (pagination.reconnect || (pagination.summaryItemIds && Object.keys(pagination.summaryItemIds).length)) {
      throw unavailable('Desktop is rebuilding a sparse turn history. Let this chat finish loading in Desktop, then reconnect.');
    }
    // DesktopIpcClient applies patches immutably, so these item references
    // retain the exact baseline. Deep-copy only the returned page below, not
    // every large tool output in the recent turns during attachment.
    const items = apiItems(turn);
    if (pagination.hasLoadedOldest === false && items.length === 0) throw unavailable('Desktop has not supplied the first visible item of a partial turn. Reconnect when its recent messages appear.');
    return {
      rows: items.reverse().map(item => ({
        turnId: turn.turnId, item,
        startedAtMs: turn.aeonAssistantMessageStartedAtMsById?.[item.id] ?? null,
        completedAtMs: turn.agentMessageCompletedAtMsById?.[item.id] ?? null,
      })),
      seen: new Set(items.map(item => item.id)),
      cursor: pagination.olderCursor ?? (pagination.hasLoadedOldest === false ? { type: 'item', itemId: items.at(-1).id } : null),
      complete: pagination.hasLoadedOldest !== false, cursors: new Set(),
    };
  }

  page(kind, params = {}) {
    const request = clone(params);
    const operation = this.queue.then(() => this.#page(kind, request));
    this.queue = operation.catch(() => {});
    return operation;
  }

  #parse(kind, params) {
    if (!['turns', 'items'].includes(kind)) throw invalid('Unsupported history page kind.');
    const direction = params.sortDirection ?? (kind === 'turns' ? 'desc' : 'asc');
    if (direction !== 'desc') throw invalid('This terminal history connection supports descending pages only.');
    const requestedLimit = params.limit ?? 25;
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 0 || requestedLimit > 0xffffffff) throw invalid('Unsupported history page size.');
    if (params.threadId !== undefined && params.threadId !== this.threadId) throw invalid('The history request belongs to another chat.');
    if (kind === 'turns' && params.itemsView !== undefined && params.itemsView !== 'notLoaded') throw invalid('This terminal requests turn metadata separately from item history.');
    if (kind === 'turns' && params.turnId != null) throw invalid('Turn metadata cannot be filtered by turnId.');
    const filter = params.turnId ?? null;
    if (filter !== null && (typeof filter !== 'string' || !filter)) throw invalid('Invalid history turn filter.');
    let offset = 0;
    if (params.cursor != null) {
      let cursor;
      try { cursor = JSON.parse(Buffer.from(params.cursor, 'base64url').toString('utf8')); } catch { throw invalid('Invalid terminal history cursor.'); }
      if (cursor.epoch !== this.epoch || cursor.kind !== kind || cursor.filter !== filter || cursor.direction !== direction ||
          !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw invalid('The terminal history cursor does not belong to this page.');
      offset = cursor.offset;
    }
    const pageLimit = kind === 'items' ? HISTORY_ITEM_PAGE_SIZE : 100;
    return { kind, direction, filter, offset, limit: Math.max(1, Math.min(pageLimit, requestedLimit)) };
  }

  #cursor({ kind, direction, filter }, offset) {
    return Buffer.from(JSON.stringify({ epoch: this.epoch, kind, direction, filter, offset })).toString('base64url');
  }

  async #page(kind, params) {
    const query = this.#parse(kind, params);
    let rows, more;
    const budget = { requests: 0 };
    if (kind === 'turns') {
      if (query.offset > this.turnRows.length) throw invalid('The history cursor skips unloaded turns.');
      await this.#ensureTurns(query.offset + query.limit, budget);
      rows = this.turnRows;
      more = !this.turnsComplete;
    } else {
      const streamKey = query.filter ?? '*';
      let stream = this.streams.get(streamKey);
      if (!stream) {
        stream = { rows: [], seen: new Set(), turnIndex: 0, itemOffset: 0, complete: false };
        this.streams.set(streamKey, stream);
      }
      if (query.offset > stream.rows.length) throw invalid('The history cursor skips unloaded items.');
      await this.#ensureItems(stream, query.filter, query.offset + query.limit, budget);
      rows = stream.rows;
      more = !stream.complete;
    }
    const data = rows.slice(query.offset, query.offset + query.limit).map(clone);
    const next = query.offset + data.length;
    return { data, nextCursor: next < rows.length || more ? this.#cursor(query, next) : null, backwardsCursor: null };
  }

  async #read(method, params, budget) {
    // Empty or overlapping server pages must not create an unbounded foreground
    // wait. Fail visibly; never convert a budget/error into "history complete".
    if (++budget.requests > 128) throw invalid('This history page crossed too many empty turns. Retry a smaller page or continue in Desktop.');
    const response = await this.call(method, { threadId: this.threadId, ...params });
    if (!response || !Array.isArray(response.data) || (response.nextCursor != null && typeof response.nextCursor !== 'string')) throw invalid('The history reader returned an invalid page.');
    return response;
  }

  async #ensureTurns(count, budget) {
    while (this.turnRows.length < count && !this.turnsComplete) {
      const bootstrap = this.needsTurnAnchor;
      const previous = this.turnCursor;
      const page = await this.#read('thread/turns/list', {
        cursor: previous, sortDirection: 'desc', itemsView: 'notLoaded',
        // A small shell batch avoids one extra metadata round trip per older
        // item-bearing turn, while still leaving item content demand-driven.
        limit: bootstrap || this.skippingBaseline ? 100 : Math.min(100, Math.max(5, count - this.turnRows.length)),
      }, budget);
      let data = page.data;
      if (bootstrap) {
        const anchor = data.findIndex(turn => this.baselineIds.has(turn?.id));
        if (anchor < 0) throw invalid('The recent Desktop history is not yet available to the read-only history reader. Reconnect shortly.');
        data = data.slice(anchor);
      }
      const staged = [], stagedIds = new Set();
      for (const turn of data) {
        if (!turn || typeof turn.id !== 'string' || !turn.id) throw invalid('The history reader returned a turn without an identity.');
        if (this.turnsById.has(turn.id) || stagedIds.has(turn.id)) continue;
        if (turn.status === 'inProgress') throw invalid('The history reader crossed the frozen live boundary. Reconnect this terminal.');
        const shell = clone({ ...turn, items: [], itemsView: 'notLoaded' });
        staged.push(shell);
        stagedIds.add(shell.id);
      }
      if (page.nextCursor != null && (page.nextCursor === previous || this.turnCursors.has(page.nextCursor))) throw invalid('The older turn history cursor did not advance.');
      // Commit only after the complete page and its continuation are valid. A
      // rejected page must remain rejected when the TUI retries that cursor.
      for (const shell of staged) {
        this.turnRows.push(shell);
        this.turnsById.set(shell.id, shell);
      }
      if (page.nextCursor != null) this.turnCursors.add(page.nextCursor);
      this.turnCursor = page.nextCursor ?? null;
      this.needsTurnAnchor = false;
      this.skippingBaseline = staged.length === 0 && page.nextCursor != null;
      this.turnsComplete = page.nextCursor == null;
    }
  }

  async #turnItems(turnId, count, budget) {
    let stream = this.itemStreams.get(turnId);
    if (!stream && this.deferredTurns.has(turnId)) {
      stream = this.#freezeItems(this.deferredTurns.get(turnId));
      this.deferredTurns.delete(turnId);
      this.itemStreams.set(turnId, stream);
    }
    if (!stream) {
      stream = { rows: [], seen: new Set(), cursor: null, complete: false, cursors: new Set() };
      this.itemStreams.set(turnId, stream);
    }
    while (stream.rows.length < count && !stream.complete) {
      const previous = stream.cursor;
      const page = await this.#read('thread/items/list', {
        turnId, cursor: previous, sortDirection: 'desc',
        limit: Math.min(100, Math.max(1, count - stream.rows.length)),
      }, budget);
      const staged = [], stagedIds = new Set();
      for (const entry of page.data) {
        if (entry?.turnId !== turnId || typeof entry?.item?.id !== 'string') throw invalid('The history reader returned an item outside its requested turn.');
        if (stream.seen.has(entry.item.id) || stagedIds.has(entry.item.id)) continue;
        stagedIds.add(entry.item.id);
        staged.push(clone(entry));
      }
      if (page.nextCursor != null && (page.nextCursor === previous || stream.cursors.has(page.nextCursor))) throw invalid('The older item history cursor did not advance.');
      for (const entry of staged) {
        stream.seen.add(entry.item.id);
        stream.rows.push(entry);
      }
      if (page.nextCursor != null) stream.cursors.add(page.nextCursor);
      stream.cursor = page.nextCursor ?? null;
      stream.complete = page.nextCursor == null;
    }
    return stream;
  }

  async #ensureItems(stream, filter, count, budget) {
    while (stream.rows.length < count && !stream.complete) {
      if (filter) {
        if (!this.turnsById.has(filter)) throw invalid('Load the requested turn metadata before requesting its items.');
      } else {
        await this.#ensureTurns(stream.turnIndex + 1, budget);
        if (stream.turnIndex >= this.turnRows.length) { stream.complete = true; break; }
      }
      const turnId = filter ?? this.turnRows[stream.turnIndex].id;
      const items = await this.#turnItems(turnId, stream.itemOffset + count - stream.rows.length, budget);
      while (stream.itemOffset < items.rows.length && stream.rows.length < count) {
        const entry = items.rows[stream.itemOffset++];
        if (!stream.seen.has(key(entry))) { stream.seen.add(key(entry)); stream.rows.push(entry); }
      }
      if (stream.itemOffset === items.rows.length && items.complete) {
        if (filter) stream.complete = true;
        else {
          stream.turnIndex++;
          stream.itemOffset = 0;
          stream.complete = this.turnsComplete && stream.turnIndex >= this.turnRows.length;
        }
      }
    }
  }
}
