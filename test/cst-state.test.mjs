import test from 'node:test';
import assert from 'node:assert/strict';
import { buildView, getActiveTurnId, safeText } from '../cst-state.mjs';

// Synthetic data only. Field shapes match Desktop conversationState:
// src-DsLVGakC.js q/No/g_/Ky and conversation-turn-mutations Jn/er.
// ThreadItem text/content/tool fields match the local app-server v2 schema.
const user = (id, text) => ({ id, type: 'userMessage', content: [{ type: 'text', text }] });
const agent = (id, text) => ({ id, type: 'agentMessage', text, phase: 'final_answer' });
const turn = (turnId, items, status = 'completed') => ({ turnId, items, status, params: { input: [] } });
function canonical(turns, extra = {}) {
  return { title: 'Example', turns: [], requests: [], turnHistory: { kind: 'canonical', history: {
    entitiesByKey: Object.fromEntries(turns.map(t => [`turn:${t.turnId}`, t])),
    islands: [{ id: 'tail:1', entries: turns.map(t => ({ key: `turn:${t.turnId}`, value: `turn:${t.turnId}` })), newerBoundary: { status: 'exhausted' } }], isComplete: true,
  } }, ...extra };
}

test('legacy and canonical states render matching user and assistant messages', () => {
  const turns = [turn('t1', [user('u1', 'Hello'), agent('a1', 'Example answer')])];
  for (const state of [{ turns }, canonical(turns)]) {
    const view = buildView(state);
    assert.deepEqual(view.messages.map(m => [m.role, m.text, m.status]), [['user', 'Hello', 'completed'], ['assistant', 'Example answer', 'completed']]);
    assert.equal(view.activeTurnId, null);
    assert.equal(view.pendingInput, false);
  }
});

test('ordered canonical islands exclude orphan entities and deduplicate legacy history', () => {
  const t1 = turn('t1', [agent('a1', 'older')]), t2 = turn('t2', [agent('a2', 'newer')]);
  const state = canonical([t1, t2], { turns: [turn('t2', [agent('a2', 'stale duplicate')])] });
  state.turnHistory.history.entitiesByKey.orphan = turn('orphan', [agent('orphan', 'hidden')]);
  state.turnHistory.history.islands = [
    { entries: [{ value: 'turn:t1' }] },
    { entries: [{ value: 'turn:t2' }], newerBoundary: { status: 'exhausted' } },
  ];
  assert.deepEqual(buildView(state).messages.map(m => m.text), ['older', 'newer']);
});

test('active selection only targets latest running turn on a complete live tail', () => {
  const state = canonical([turn('old', [], 'inProgress'), turn('latest', [], 'completed')]);
  assert.equal(getActiveTurnId(state), null);
  state.turnHistory.history.entitiesByKey['turn:latest'].status = 'inProgress';
  assert.equal(getActiveTurnId(state), 'latest');
  state.turnHistory.history.islands[0].newerBoundary.status = 'available';
  assert.equal(getActiveTurnId(state), null);
  assert.equal(getActiveTurnId({ turns: [turn('old', [], 'inProgress'), turn(null, [], 'inProgress')] }), null);
});

test('latest 12 visible messages are bounded and limit allows more history', () => {
  const state = canonical(Array.from({ length: 1000 }, (_, i) => turn(`t${i}`, [agent(`a${i}`, `message ${i}`)])));
  assert.equal(buildView(state).messages.length, 12);
  assert.equal(buildView(state).messages[0].text, 'message 988');
  assert.equal(buildView(state, { limit: 30 }).messages.length, 30);
  assert.equal(buildView(state, { limit: NaN }).messages.length, 12);
  assert.equal(buildView(state, { limit: 100000 }).messages.length, 1000);
});

test('live assistant replacements preserve ID and reflect newly applied deltas', () => {
  const state = canonical([turn('t', [agent('a', 'First')], 'inProgress')]);
  const initial = buildView(state).messages[0];
  state.turnHistory.history.entitiesByKey['turn:t'].items[0].text += '\nSecond';
  const next = buildView(state).messages[0];
  assert.equal(next.id, initial.id);
  assert.equal(next.text, 'First\nSecond');
  assert.equal(next.status, 'running');
  assert.equal(buildView(state).activeTurnId, 't');
});

test('terminal controls, OSC clipboard injection, and bidi overrides are removed', () => {
  const unsafe = '\u001b[31mRed\u001b[0m\r\nline\t2\u0007\u001b]52;c;YWJj\u0007\u009b2J\u202eend';
  assert.equal(safeText(unsafe), 'Red\nline    2end');
  const view = buildView({ title: '\u001b[2JTitle', turns: [turn('t', [agent('a', unsafe)])] });
  assert.equal(view.title, 'Title');
  assert(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(view.messages[0].text));
  assert.equal(safeText({ toString() { throw Error('must not stringify payloads'); } }), '');
});

test('tools are concise and do not serialize arbitrary arguments or outputs', () => {
  const items = [
    { id: 'cmd', type: 'commandExecution', command: 'echo example', aggregatedOutput: 'private output', status: 'completed' },
    { id: 'mcp', type: 'mcpToolCall', server: 'example', tool: 'lookup', arguments: { secret: 'never render' }, result: { huge: 'never render' }, status: 'inProgress' },
    { id: 'file', type: 'fileChange', changes: [{ path: 'example.txt' }], status: 'failed' },
    { id: 'reason', type: 'reasoning', content: ['hidden reasoning'] },
    { id: 'unknown', type: 'newUnknownType', output: 'never dump unknown' },
  ];
  const view = buildView({ turns: [turn('t', items, 'inProgress')] });
  assert.deepEqual(view.messages.map(m => [m.text, m.status]), [['Command: echo example', 'completed'], ['Tool: example/lookup', 'running'], ['Files changed: 1', 'failed']]);
  assert(!JSON.stringify(view).includes('never render'));
});

test('pending input and approval requests are surfaced and item duplicates suppressed', () => {
  const state = { turns: [turn('t', [{ id: 'response', type: 'userInputResponse', requestId: 5, completed: false, questions: [{ question: 'Choose one' }] }], 'inProgress')], requests: [
    { id: 5, method: 'item/tool/requestUserInput', params: { questions: [{ header: 'Choice', question: 'Choose one', options: [{ label: 'A' }, { label: 'B' }] }] } },
    { id: 6, method: 'item/permissions/requestApproval', params: { reason: 'Read example folder' } },
    { id: 7, method: 'item/tool/requestUserInput', completed: true, params: { questions: [{ question: 'Old resolved request' }] } },
  ] };
  const view = buildView(state);
  assert.equal(view.messages.length, 2);
  assert.equal(view.messages[0].text, 'Choose one\n1. A\n2. B');
  assert.equal(view.messages[1].role, 'approval');
  assert.equal(view.pendingInput, true);
  assert.equal(buildView({ turns: [turn('t', [{ id: 'response', type: 'userInputResponse', requestId: 5, completed: true }])] }).pendingInput, false);
});

test('sleep items show bounded wait progress and inherit the current turn status', () => {
  const state = canonical([turn('t', [{ type: 'sleep', id: 'wait', durationMs: 30000 }], 'inProgress')]);
  assert.deepEqual(buildView(state).messages.map(m => [m.role, m.text, m.status]), [['tool', 'Wait 30s', 'running']]);
  state.turnHistory.history.entitiesByKey['turn:t'].status = 'completed';
  assert.equal(buildView(state).messages[0].status, 'completed');
  state.turnHistory.history.entitiesByKey['turn:t'].items[0].durationMs = Number.POSITIVE_INFINITY;
  assert.equal(buildView(state).messages[0].text, 'Wait');
});

test('optimistic local input is rendered without manufacturing a controllable turn ID', () => {
  const state = canonical([turn('done', [agent('a', 'Done')])]);
  state.turns = [{ turnId: null, status: 'inProgress', items: [], params: { input: [{ type: 'text', text: 'Next message' }] } }];
  const view = buildView(state);
  assert.deepEqual(view.messages.map(m => [m.text, m.status]), [['Done', 'completed'], ['Next message', 'pending']]);
  assert.equal(view.activeTurnId, null);
});

test('queue is explicit and never inferred from unrelated snapshot fields', () => {
  const state = { turns: [], queuedMessages: [{ text: 'untrusted unknown field' }] };
  assert.equal(buildView(state).queuedCount, 0);
  const view = buildView(state, { queuedMessages: [{ id: 'q1', input: [{ type: 'text', text: 'Next task' }] }] });
  assert.equal(view.queuedCount, 1);
  assert.deepEqual(view.messages, [{ id: 'queued:q1', role: 'queued', text: 'Next task', status: 'queued' }]);
});

test('async question metadata stays pending until an accepted matching user reply', () => {
  const message = { ...agent('question-item', ''), questions: [{ title: 'Continue?', options: ['Yes', 'No'] }] };
  const state = canonical([turn('t', [message], 'inProgress')]);
  assert.equal(buildView(state).pendingInput, true);
  assert.equal(buildView(state).messages[0].text, 'Continue?\n1. Yes\n2. No');
  const reply = `<send_user_message_question_reply>${JSON.stringify([{ questionItemId: JSON.stringify(['request_user_input_async', 'question-item', 0]), answer: 'Yes', question: 'Continue?' }])}</send_user_message_question_reply>`;
  state.turnHistory.history.entitiesByKey['turn:t'].items.push({ id: 'reply', type: 'steeringUserMessage', input: [{ type: 'text', text: reply }], status: 'pending' });
  assert.equal(buildView(state).pendingInput, true);
  state.turnHistory.history.entitiesByKey['turn:t'].items.at(-1).status = 'accepted';
  assert.equal(buildView(state).pendingInput, false);
  state.turnHistory.history.entitiesByKey['turn:t'].items.at(-1).type = 'agentMessage';
  assert.equal(buildView(state).pendingInput, true);
});

test('malformed and oversized fields stay safe and do not mutate snapshots', () => {
  assert.deepEqual(buildView(null), { messages: [], activeTurnId: null, queuedCount: 0, pendingInput: false, title: null });
  const state = canonical([turn('t', [agent('a', 'x'.repeat(100000))])]);
  const before = structuredClone(state);
  const view = buildView(state);
  assert(view.messages[0].text.length < 33000);
  assert.deepEqual(state, before);
  assert.equal(getActiveTurnId({ turns: [turn('bad\u001b[2J', [], 'inProgress')] }), null);
  assert.equal(buildView({ turnHistory: { kind: 'canonical', history: { islands: [{}], entitiesByKey: {} } } }).messages.length, 0);
});
