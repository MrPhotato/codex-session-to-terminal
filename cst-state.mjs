// Pure view of Desktop conversationState. No IO, logging, or turn control.
// Canonical history uses ordered islands and entitiesByKey; legacy turns are
// also used for local, not-yet-canonical turns. Tool arguments/results are not
// serialized into the view.
import { stripVTControlCharacters } from 'node:util';

const list = value => Array.isArray(value) ? value : [];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => object(value) && Object.hasOwn(value, key);
const MAX_MESSAGE_LENGTH = 32_000;
const MAX_LIMIT = 1000;

export function safeText(value, maxLength = MAX_MESSAGE_LENGTH) {
  if (typeof value !== 'string') return '';
  const text = stripVTControlCharacters(value.replace(/\r\n/g, '\n'))
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\t/g, '    ');
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n…` : text;
}

function identity(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && safeText(value, 512) === value ? value : null;
}

function status(value, fallback = 'completed') {
  switch (value) {
    case 'inProgress': case 'running': return 'running';
    case 'completed': case 'accepted': case 'success': return 'completed';
    case 'failed': case 'error': case 'declined': case 'rejected': return 'failed';
    case 'interrupted': case 'cancelled': case 'canceled': return 'interrupted';
    case 'queued': return 'queued';
    case 'pending': case 'waiting': return 'pending';
    default: return fallback;
  }
}

function canonicalHistory(state) {
  const history = state?.turnHistory?.kind === 'canonical' ? state.turnHistory.history : null;
  return object(history) && Array.isArray(history.islands) && object(history.entitiesByKey) ? history : null;
}

// Yield newest first without copying or walking the text in a large snapshot.
function* reverseTurns(state) {
  const history = canonicalHistory(state);
  const seen = new Set();
  if (history) {
    // Canonical history owns duplicate IDs. Local optimistic turns may not yet
    // have an entity in the canonical history and are rendered at the end.
    const canonicalIds = new Set();
    for (const island of history.islands) for (const entry of list(island?.entries)) {
      if (!own(history.entitiesByKey, entry?.value)) continue;
      const turn = history.entitiesByKey[entry.value];
      if (identity(turn?.turnId)) canonicalIds.add(turn.turnId);
    }
    const legacy = list(state?.turns);
    for (let i = legacy.length - 1; i >= 0; i--) {
      const turn = legacy[i];
      if (!object(turn) || (turn.turnId && canonicalIds.has(turn.turnId))) continue;
      const key = identity(turn.turnId) ?? `local:${i}`;
      if (!seen.has(key)) { seen.add(key); yield { turn, key }; }
    }
    for (let i = history.islands.length - 1; i >= 0; i--) {
      const entries = list(history.islands[i]?.entries);
      for (let j = entries.length - 1; j >= 0; j--) {
        const key = entries[j]?.value;
        if (typeof key !== 'string' || seen.has(key) || !own(history.entitiesByKey, key)) continue;
        const turn = history.entitiesByKey[key];
        if (!object(turn)) continue;
        const id = identity(turn.turnId);
        if (id && seen.has(id)) continue;
        seen.add(key); if (id) seen.add(id);
        yield { turn, key };
      }
    }
  } else {
    const turns = list(state?.turns);
    for (let i = turns.length - 1; i >= 0; i--) {
      if (!object(turns[i])) continue;
      const key = identity(turns[i].turnId) ?? `local:${i}`;
      if (!seen.has(key)) { seen.add(key); yield { turn: turns[i], key }; }
    }
  }
}

export function getActiveTurnId(state) {
  const history = canonicalHistory(state);
  if (history && history.islands.at(-1)?.newerBoundary?.status !== 'exhausted') return null;
  const latest = reverseTurns(state).next().value?.turn;
  return latest?.status === 'inProgress' ? identity(latest.turnId) : null;
}

function inputText(content) {
  const parts = [];
  for (const item of list(content)) {
    if (!object(item)) continue;
    if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text);
    else if (item.type === 'image' || item.type === 'localImage') parts.push('[Image]');
    else if (item.type === 'audio' || item.type === 'localAudio') parts.push('[Audio]');
    else if (item.type === 'skill') parts.push(`[Skill: ${safeText(item.name, 120)}]`);
    else if (item.type === 'mention') parts.push(`[Mention: ${safeText(item.name, 120)}]`);
    if (parts.reduce((n, p) => n + p.length, 0) >= MAX_MESSAGE_LENGTH) break;
  }
  return safeText(parts.join('\n'));
}

function questionsText(questions) {
  return safeText(list(questions).map(q => {
    const question = typeof q?.question === 'string' ? q.question : q?.title ?? q?.header;
    const options = list(q?.options).map(o => typeof o === 'string' ? o : o?.label).filter(x => typeof x === 'string');
    return [question, options.length ? options.map((o, i) => `${i + 1}. ${o}`).join('\n') : null].filter(x => typeof x === 'string').join('\n');
  }).join('\n\n'));
}

function viewItem(item, turn, key, index) {
  if (!object(item)) return null;
  const id = `${safeText(key, 512)}:${identity(item.id) ?? index}`;
  const base = { id, role: 'tool', text: '', status: status(item.status, status(turn.status)) };
  switch (item.type) {
    case 'userMessage': return { ...base, role: 'user', text: inputText(item.content), status: 'completed' };
    case 'steeringUserMessage': return { ...base, role: 'user', text: inputText(item.input), status: status(item.status, 'pending') };
    case 'agentMessage':
      if (item.phase === 'analysis') return null;
      return { ...base, role: 'assistant', text: safeText(item.text) };
    case 'plan': return { ...base, role: 'assistant', text: safeText(item.text) };
    case 'commandExecution': return { ...base, text: `Command: ${safeText(item.command, 500)}` };
    case 'fileChange': return { ...base, text: `Files changed: ${list(item.changes).length}` };
    case 'mcpToolCall': return { ...base, text: `Tool: ${safeText(item.server, 120)}/${safeText(item.tool, 160)}` };
    case 'dynamicToolCall': return { ...base, text: `Tool: ${safeText(item.namespace, 120)}${item.namespace ? '/' : ''}${safeText(item.tool, 160)}` };
    case 'collabAgentToolCall': return { ...base, text: `Agent: ${safeText(item.tool, 160)}` };
    case 'webSearch': return { ...base, text: `Web search: ${safeText(item.query, 500)}` };
    case 'imageGeneration': return { ...base, text: 'Image generation' };
    case 'imageView': return { ...base, text: 'View image' };
    case 'sleep': return { ...base, text: Number.isFinite(item.durationMs) && item.durationMs >= 0 ? `Wait ${Math.ceil(item.durationMs / 1000)}s` : 'Wait' };
    case 'contextCompaction': return { ...base, text: 'Conversation context compacted', status: 'completed' };
    case 'userInputResponse': return { ...base, role: 'input', text: questionsText(item.questions) || 'Input requested in Desktop', status: item.completed === true ? 'completed' : 'pending', requestId: String(item.requestId) };
    case 'permissionRequest': return { ...base, role: 'approval', text: safeText(item.reason) || 'Permission requested in Desktop', status: item.completed === true ? 'completed' : 'pending', requestId: String(item.requestId) };
    case 'mcpServerElicitation': return { ...base, role: 'input', text: safeText(item.params?.message) || 'Input requested in Desktop', status: item.completed === true ? 'completed' : 'pending', requestId: String(item.requestId) };
    // Reasoning, arbitrary function outputs, and unknown item payloads are not
    // dumped into the terminal. New item types remain safe to ignore.
    default: return null;
  }
}

function pendingRequest(request) {
  if (!object(request) || request.completed === true) return null;
  const params = object(request.params) ? request.params : {};
  const base = { id: `request:${safeText(String(request.id), 512)}`, status: 'pending', requestId: String(request.id) };
  switch (request.method) {
    case 'item/tool/requestUserInput': return { ...base, role: 'input', text: questionsText(params.questions) || 'Input requested in Desktop' };
    case 'item/tool/requestOptionPicker': return { ...base, role: 'input', text: safeText(params.title) || 'Choose an option in Desktop' };
    case 'mcpServer/elicitation/request': return { ...base, role: 'input', text: safeText(params.message) || 'Input requested in Desktop' };
    case 'item/commandExecution/requestApproval': return { ...base, role: 'approval', text: safeText(params.reason) || 'Command approval required in Desktop' };
    case 'item/fileChange/requestApproval': return { ...base, role: 'approval', text: safeText(params.reason) || 'File change approval required in Desktop' };
    case 'item/permissions/requestApproval': return { ...base, role: 'approval', text: safeText(params.reason) || 'Permission approval required in Desktop' };
    default: return null;
  }
}

// Desktop async questions live on agentMessage.questions rather than requests.
// The reply envelope is interpreted only in accepted user messages, just as in
// Desktop; assistant/tool text cannot dismiss a pending question.
function pendingAsyncQuestions(state) {
  const turn = reverseTurns(state).next().value?.turn;
  if (turn?.status !== 'inProgress' || !identity(turn.turnId)) return [];
  const answered = new Set();
  for (const item of list(turn.items)) {
    if (item?.type !== 'userMessage' && !(item?.type === 'steeringUserMessage' && item.status === 'accepted')) continue;
    const content = item.type === 'userMessage' ? item.content : item.input;
    if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== 'text' || typeof content[0].text !== 'string') continue;
    const raw = content[0].text.trim();
    const open = '<send_user_message_question_reply>', close = '</send_user_message_question_reply>';
    if (raw.length > MAX_MESSAGE_LENGTH || !raw.startsWith(open) || !raw.endsWith(close)) continue;
    try {
      const result = JSON.parse(raw.slice(open.length, -close.length));
      for (const reply of Array.isArray(result) ? result : [result]) if (typeof reply?.questionItemId === 'string') answered.add(reply.questionItemId);
    } catch { /* Malformed user text remains ordinary text. */ }
  }
  const questions = [];
  for (const item of list(turn.items)) {
    if (item?.type !== 'agentMessage' || !identity(item.id)) continue;
    list(item.questions).forEach((question, index) => {
      if (answered.has(JSON.stringify(['request_user_input_async', item.id, index]))) return;
      questions.push({ id: `question:${item.id}:${index}`, role: 'input', text: questionsText([question]) || 'Input requested in Desktop', status: 'pending' });
    });
  }
  return questions;
}

/**
 * Render only recent visible messages. queuedMessages is an explicit optional
 * input: Desktop's queue is separate from conversationState. The caller must
 * label a CST-local queue separately from the Desktop queue.
 */
export function buildView(state, { limit = 12, queuedMessages = [] } = {}) {
  const count = Number.isSafeInteger(limit) ? Math.max(1, Math.min(MAX_LIMIT, limit)) : 12;
  const requests = [...list(state?.requests).map(pendingRequest).filter(Boolean), ...pendingAsyncQuestions(state)];
  const requestIds = new Set(requests.map(r => r.requestId));
  const queued = list(queuedMessages).map((entry, index) => ({
    id: `queued:${identity(entry?.id) ?? index}`, role: 'queued',
    text: inputText(entry?.input) || safeText(entry?.text) || 'Queued message', status: 'queued',
  }));
  const reversed = [];
  let pendingInput = requests.length > 0;
  for (const { turn, key } of reverseTurns(state)) {
    const items = list(turn.items);
    const hasUserItem = items.some(item => item?.type === 'userMessage');
    for (let i = items.length - 1; i >= 0; i--) {
      const message = viewItem(items[i], turn, key, i);
      if (!message || !message.text || (message.requestId && requestIds.has(message.requestId))) continue;
      if ((message.role === 'input' || message.role === 'approval') && message.status === 'pending' && turn.status === 'inProgress') pendingInput = true;
      reversed.push(message);
      if (reversed.length >= count) break;
    }
    if (reversed.length >= count) break;
    // Optimistic Desktop turns can hold the initial user input only in params.
    if (!hasUserItem) {
      const text = inputText(turn.params?.input);
      if (text) reversed.push({ id: `${safeText(key, 512)}:input`, role: 'user', text, status: turn.turnId == null && turn.status === 'inProgress' ? 'pending' : 'completed' });
    }
    if (reversed.length >= count) break;
  }
  const messages = [...reversed.reverse(), ...requests, ...queued].slice(-count).map(({ requestId: _, ...message }) => message);
  return { messages, activeTurnId: getActiveTurnId(state), queuedCount: queued.length, pendingInput, title: safeText(state?.title, 500) || null };
}
