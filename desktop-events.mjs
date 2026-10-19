const ITEM_TYPES = new Set(['userMessage', 'hookPrompt', 'agentMessage', 'functionCallOutput', 'plan', 'reasoning',
  'commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall', 'subAgentActivity',
  'webSearch', 'imageView', 'sleep', 'imageGeneration', 'enteredReviewMode', 'exitedReviewMode', 'contextCompaction']);

export function orderedDesktopTurns(state) {
  const result = [], ids = new Set();
  const history = state.turnHistory?.kind === 'canonical' ? state.turnHistory.history : null;
  for (const island of history?.islands ?? []) for (const entry of island.entries ?? []) {
    const turn = history.entitiesByKey?.[entry.value];
    if (turn?.turnId && !ids.has(turn.turnId)) { ids.add(turn.turnId); result.push(turn); }
  }
  for (const turn of state.turns ?? []) if (turn?.turnId && !ids.has(turn.turnId)) { ids.add(turn.turnId); result.push(turn); }
  return result;
}

export function apiItem(item) {
  if (item?.type === 'steeringUserMessage' && item.status === 'accepted' && typeof item.serverUserMessageId === 'string') {
    return { type: 'userMessage', id: item.serverUserMessageId, clientId: item.serverClientUserMessageId ?? item.clientUserMessageId ?? null, content: item.input };
  }
  if (!item || !ITEM_TYPES.has(item.type) || typeof item.id !== 'string') return null;
  return item;
}

export function apiItems(turn) {
  const items = turn.items ?? [], nativeIds = new Set(items.filter(item => ITEM_TYPES.has(item.type)).map(item => item.id));
  const result = [], seen = new Set();
  for (const raw of items) {
    const item = apiItem(raw);
    if (!item || seen.has(item.id) || raw.type === 'steeringUserMessage' && nativeIds.has(item.id)) continue;
    seen.add(item.id); result.push(item);
  }
  return result;
}

export function apiTurn(turn, { emptyItems = false, status = turn.status } = {}) {
  const startedAt = Number.isFinite(turn.turnStartedAtMs) ? Math.floor(turn.turnStartedAtMs / 1000) : null;
  return { id: turn.turnId, items: emptyItems ? [] : apiItems(turn), status,
    error: turn.error ?? null, rootTurnId: turn.rootTurnId ?? null,
    startedAt, completedAt: status !== 'inProgress' && startedAt !== null && Number.isFinite(turn.durationMs)
      ? Math.floor((turn.turnStartedAtMs + turn.durationMs) / 1000) : null,
    durationMs: turn.durationMs ?? null,
  };
}

function completed(turn, item) {
  return turn.status !== 'inProgress' || item.type === 'userMessage' ||
    (Array.isArray(turn.completedItemIds) && turn.completedItemIds.includes(item.id)) ||
    (turn.completedItemIds && !Array.isArray(turn.completedItemIds) && turn.completedItemIds[item.id] === true) ||
    ['completed', 'failed', 'declined'].includes(item.status) ||
    Number.isFinite(turn.agentMessageCompletedAtMsById?.[item.id]);
}
function lifecycleTime(turn, item, complete, observedAt) {
  const value = complete ? turn.agentMessageCompletedAtMsById?.[item.id]
    : turn.aeonAssistantMessageStartedAtMsById?.[item.id];
  if (Number.isFinite(value)) return Math.trunc(value);
  if (complete && Number.isFinite(turn.durationMs) && Number.isFinite(turn.turnStartedAtMs)) return Math.trunc(turn.turnStartedAtMs + turn.durationMs);
  if (!complete && Number.isFinite(turn.turnStartedAtMs)) return Math.trunc(turn.turnStartedAtMs);
  // The Desktop snapshot does not retain every tool lifecycle timestamp. For
  // those notifications only, timestamp when this bridge observed the change.
  return observedAt;
}
const textSpec = item => item.type === 'agentMessage' ? ['text', 'item/agentMessage/delta']
  : item.type === 'plan' ? ['text', 'item/plan/delta']
    : item.type === 'commandExecution' ? ['aggregatedOutput', 'item/commandExecution/outputDelta'] : null;

export class DesktopEventProjector {
  constructor(threadId, notify) { this.threadId = threadId; this.notify = notify; this.turns = new Map(); this.counts = {}; }
  emit(method, params) { this.counts[method] = (this.counts[method] ?? 0) + 1; this.notify(method, params); }
  seed(state) {
    this.turns.clear();
    for (const turn of orderedDesktopTurns(state)) this.turns.set(turn.turnId, {
      status: turn.status,
      items: new Map(apiItems(turn).map(item => [item.id, { item, complete: completed(turn, item) }])),
    });
    this.lastName = state.title;
    this.lastStatus = JSON.stringify(state.threadRuntimeStatus);
    this.lastSettings = JSON.stringify(state.latestThreadSettings);
    this.lastUsage = JSON.stringify(state.latestTokenUsageInfo);
    this.lastLiveTurnId = orderedDesktopTurns(state).at(-1)?.turnId ?? null;
    this.warnedRequests = new Set();
  }
  pendingRequests(state) {
    for (const request of state.requests ?? []) {
      if (request.completed === true || this.warnedRequests.has(request.id)) continue;
      this.warnedRequests.add(request.id);
      this.emit('warning', { threadId: this.threadId, message: 'This chat is waiting for approval or input in Desktop. Answer it in Desktop; this terminal does not forward approval answers yet.' });
    }
  }
  update(state) {
    const threadId = this.threadId, observedAt = Date.now();
    const currentTurns = orderedDesktopTurns(state);
    const liveBoundary = this.lastLiveTurnId ? currentTurns.findIndex(turn => turn.turnId === this.lastLiveTurnId) : -1;
    if (this.lastLiveTurnId && liveBoundary < 0) {
      // The previously known live tail disappeared (resync/history replacement).
      // Fail the connection rather than replay old lifecycle events into TUI's
      // queue, which can otherwise execute a queued user message prematurely.
      throw new Error('The Desktop live history boundary changed; reconnect the native CLI before continuing.');
    }
    for (let turnIndex = 0; turnIndex < currentTurns.length; turnIndex++) {
      const turn = currentTurns[turnIndex];
      let previous = this.turns.get(turn.turnId);
      if (!previous && turnIndex < liveBoundary) {
        this.turns.set(turn.turnId, { status: turn.status, items: new Map(apiItems(turn).map(item => [item.id, { item, complete: completed(turn, item) }])) });
        continue;
      }
      if (!previous) {
        previous = { status: 'inProgress', items: new Map() };
        this.turns.set(turn.turnId, previous);
        this.emit('turn/started', { threadId, turn: apiTurn(turn, { emptyItems: true, status: 'inProgress' }) });
      }
      for (const item of apiItems(turn)) {
        const old = previous.items.get(item.id), spec = textSpec(item);
        if (!old) {
          const startedItem = spec ? { ...item, [spec[0]]: '' } : item;
          this.emit('item/started', { threadId, turnId: turn.turnId, item: startedItem, startedAtMs: lifecycleTime(turn, item, false, observedAt) });
        }
        if (spec && !old?.complete) {
          const before = old?.item?.[spec[0]] ?? '', after = item[spec[0]] ?? '';
          if (typeof before === 'string' && typeof after === 'string' && after.startsWith(before) && after.length > before.length) {
            this.emit(spec[1], { threadId, turnId: turn.turnId, itemId: item.id, delta: after.slice(before.length) });
          } else if (old && typeof before === 'string' && typeof after === 'string' && !after.startsWith(before)) {
            throw new Error('Desktop replaced already streamed text; reconnect the native CLI to resynchronize.');
          }
        }
        const isComplete = completed(turn, item);
        if (isComplete && !old?.complete) this.emit('item/completed', { threadId, turnId: turn.turnId, item, completedAtMs: lifecycleTime(turn, item, true, observedAt) });
        previous.items.set(item.id, { item, complete: isComplete });
      }
      if (turn.status !== 'inProgress' && previous.status === 'inProgress') this.emit('turn/completed', { threadId, turn: apiTurn(turn) });
      previous.status = turn.status;
    }
    this.lastLiveTurnId = currentTurns.at(-1)?.turnId ?? this.lastLiveTurnId;
    this.pendingRequests(state);
    if (state.title !== this.lastName) { this.lastName = state.title; this.emit('thread/name/updated', { threadId, threadName: state.title ?? null }); }
    const status = JSON.stringify(state.threadRuntimeStatus);
    if (status !== this.lastStatus) { this.lastStatus = status; this.emit('thread/status/changed', { threadId, status: state.threadRuntimeStatus }); }
    const settings = JSON.stringify(state.latestThreadSettings);
    if (settings !== this.lastSettings) { this.lastSettings = settings; this.emit('thread/settings/updated', { threadId, threadSettings: state.latestThreadSettings }); }
    const usage = JSON.stringify(state.latestTokenUsageInfo), last = currentTurns.at(-1);
    if (last?.turnId && usage !== this.lastUsage && state.latestTokenUsageInfo) {
      this.lastUsage = usage; this.emit('thread/tokenUsage/updated', { threadId, turnId: last.turnId, tokenUsage: state.latestTokenUsageInfo });
    }
  }
}
