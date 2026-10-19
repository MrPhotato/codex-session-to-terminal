import { randomUUID } from 'node:crypto';
import { orderedDesktopTurns, apiTurn, apiItems } from './desktop-events.mjs';

const unsupported = message => Object.assign(new Error(message), { code: 'INCOMPLETE_HISTORY', rpcError: { code: -32602, message } });

// A native terminal attachment requires a complete canonical snapshot. A
// partially loaded Desktop history must not be presented as complete history,
// and mixing a later disk page with the live event baseline loses/duplicates
// active-turn text. The owner must finish loading history before this snapshot.
export class SnapshotHistory {
  constructor(state) {
    const history = state.turnHistory?.kind === 'canonical' ? state.turnHistory.history : null;
    if (!history || history.islands?.length !== 1 || history.islands[0].olderBoundary?.status !== 'exhausted' || history.islands[0].newerBoundary?.status !== 'exhausted') {
      throw unsupported('Desktop has not supplied the complete chat history. Open the chat in Desktop and try attaching again.');
    }
    if (state.turns?.some(turn => turn.status === 'inProgress' && !turn.turnId)) throw unsupported('Desktop is still admitting a new turn; wait before attaching the terminal.');
    if (orderedDesktopTurns(state).some(turn => turn.itemsPagination?.hasLoadedOldest === false)) {
      throw unsupported('Desktop has not supplied every turn item. Open the chat in Desktop and try attaching again.');
    }
    this.epoch = randomUUID();
    this.state = state;
    this.turns = orderedDesktopTurns(state).map(turn => apiTurn(turn));
    this.entries = orderedDesktopTurns(state).flatMap(turn => apiItems(turn).map(item => ({ turnId: turn.turnId, item,
      startedAtMs: turn.aeonAssistantMessageStartedAtMsById?.[item.id] ?? null,
      completedAtMs: turn.agentMessageCompletedAtMsById?.[item.id] ?? null,
    })));
    if (this.turns.length > 10000 || this.entries.length > 100000) throw unsupported('This chat exceeds the terminal history limit. Continue in Desktop.');
  }
  page(kind, params = {}) {
    const direction = params.sortDirection ?? (kind === 'items' ? 'asc' : 'desc');
    if (!['asc', 'desc'].includes(direction)) throw unsupported('Unsupported history sort direction.');
    const requestedLimit = params.limit ?? 25;
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 0 || requestedLimit > 0xffffffff) throw unsupported('Unsupported history page size.');
    const limit = Math.max(1, Math.min(100, requestedLimit));
    const filter = params.turnId ?? null;
    let offset = 0;
    if (params.cursor !== null && params.cursor !== undefined) {
      let cursor;
      try { cursor = JSON.parse(Buffer.from(params.cursor, 'base64url').toString('utf8')); } catch { throw unsupported('Invalid snapshot history cursor.'); }
      if (cursor.epoch !== this.epoch || cursor.kind !== kind || cursor.direction !== direction || cursor.filter !== filter || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw unsupported('The snapshot history cursor does not belong to this page.');
      offset = cursor.offset;
    }
    let rows = kind === 'turns' ? this.turns : this.entries.filter(entry => !filter || entry.turnId === filter);
    if (direction === 'desc') rows = [...rows].reverse();
    let data = rows.slice(offset, offset + limit);
    if (kind === 'turns' && params.itemsView === 'notLoaded') data = data.map(turn => ({ ...turn, items: [], itemsView: 'notLoaded' }));
    const next = offset + data.length;
    return { data, nextCursor: next < rows.length ? Buffer.from(JSON.stringify({ epoch: this.epoch, kind, direction, filter, offset: next })).toString('base64url') : null, backwardsCursor: null };
  }
}
