import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCloudConversation } from '../cloud-conversation.mjs';

// Synthetic fixtures use the installed app's observed wire shape. They prove
// parser behavior only; they are not captured cloud responses or live tests.
const message = (id, role, text, extra = {}) => ({
  id, author: { role }, content: { content_type: 'text', parts: [text] }, ...extra,
});
const snapshot = (...messages) => {
  const mapping = { root: { id: 'root', parent: null, children: [], message: null } };
  let parent = 'root';
  for (const item of messages) {
    const id = `node-${item.id}`;
    mapping[parent].children.push(id);
    mapping[id] = { id, parent, children: [], message: item };
    parent = id;
  }
  return { conversation_id: 'cloud-conversation', title: 'Test', current_node: parent, mapping };
};
const reason = expected => error => error.code === 'INVALID_CLOUD_CONVERSATION' && error.reason === expected;

test('follows only the selected branch and preserves real message and node identities', () => {
  const input = snapshot(
    message('user-1', 'user', 'Hello'),
    message('answer-1', 'assistant', 'Good', { channel: 'commentary' }),
    message('answer-2', 'assistant', '', {
      content: { content_type: 'text', parts: ['day', ' 🌤️'] }, channel: 'final',
      status: 'finished_successfully', end_turn: true, create_time: 12.5,
      metadata: { turn_id: 'real-turn', working_turn_id: 'work', turn_exchange_id: 'exchange' },
    }),
  );
  input.mapping.other = { id: 'other', parent: 'root', children: [], message: message('other-answer', 'assistant', 'Unselected') };
  input.mapping.root.children.push('other');
  const before = structuredClone(input);
  const result = normalizeCloudConversation(input);
  assert.deepEqual(result.messages.map(item => item.id), ['user-1', 'answer-1', 'answer-2']);
  assert.equal(result.messages[2].nodeId, 'node-answer-2');
  assert.equal(result.messages[2].text, 'day 🌤️');
  assert.equal(result.messages[2].createdAt, 12.5);
  assert.deepEqual(result.messages[2].turnIdentity, {
    turnId: null, turn_id: 'real-turn', workingTurnId: 'work', turnExchangeId: 'exchange',
  });
  assert.equal(result.history.completeSelectedBranch, true);
  assert.deepEqual(input, before);
  assert.equal('turns' in result, false);
});

test('omits hidden/system/optimistic and skip-completion messages with explicit reasons', () => {
  const result = normalizeCloudConversation(snapshot(
    message('system', 'system', 'Private instructions'),
    message('hidden', 'assistant', 'Hidden', { metadata: { is_visually_hidden_from_conversation: true } }),
    message('optimistic', 'user', 'Not a receipt', { metadata: { codex_optimistic_steering_user: true } }),
    message('skip', 'assistant', ' :: SKIP_COMPLETION :: '),
    message('visible', 'assistant', 'Visible', { channel: 'final' }),
  ));
  assert.deepEqual(result.messages.map(item => item.id), ['visible']);
  assert.deepEqual(result.omitted.map(item => item.reason), ['system-role', 'hidden', 'optimistic', 'skip-completion']);
  assert.equal(JSON.stringify(result).includes('Private instructions'), false);
});

test('reports tools, media, unknown roles and channels without silently converting them to assistant text', () => {
  const result = normalizeCloudConversation(snapshot(
    message('call', 'assistant', '{"command":"anything"}', { recipient: 'functions.exec' }),
    message('output', 'tool', 'Command output'),
    message('image', 'user', '', { content: { content_type: 'multimodal_text', parts: ['Caption', { content_type: 'image_asset_pointer' }] } }),
    message('role', 'unknown', 'Unknown'),
    message('analysis', 'assistant', 'Unmapped channel', { channel: 'analysis' }),
    message('mixed', 'user', '', { content: { content_type: 'text', text: 'Text', parts: ['Text', {}] } }),
  ));
  assert.equal(result.messages.length, 0);
  assert.deepEqual(result.unsupported.map(item => item.reason), [
    'tool-call', 'tool-output', 'content', 'author-role', 'assistant-channel', 'content',
  ]);
  assert.equal(result.projection.completeVisibleText, false);
  assert.equal(result.history.completeSelectedBranch, true);
  assert.equal(JSON.stringify(result).includes('Command output'), false);
});

test('retains approval identity and unknown status without inventing permission or approval actions', () => {
  const input = snapshot(message('approval', 'tool', '', {
    metadata: {
      is_visually_hidden_from_conversation: true,
      jit_plugin_data: { from_server: { type: 'confirm_action', body: {
        codex_mcp_elicitation: { request_id: 7, target_message_id: 'target', kind: 'openaiForm' },
      } } },
    },
  }));
  input.approvalPolicy = 'never'; // Not a verified cloud runtime field.
  input.sandbox = { type: 'dangerFullAccess' };
  input.default_model_slug = 'auto';
  const result = normalizeCloudConversation(input);
  assert.deepEqual(result.approvals, [{
    messageId: 'approval', requestId: 7, targetMessageId: 'target',
    kind: 'openaiForm', status: null, requestType: 'confirm_action',
  }]);
  assert.equal(result.nativeResume.supported, false);
  assert.equal(result.nativeResume.missingTurnContract, true);
  for (const field of ['approvalPolicy', 'approvalsReviewer', 'sandbox', 'cwd', 'modelProvider']) {
    assert.ok(result.nativeResume.missingRuntimeFields.includes(field));
    assert.equal(Object.hasOwn(result, field), false);
  }
  assert.equal(result.configuredModel, 'auto');
});

test('fails on missing ancestors, cycles, conflicting node IDs and repeated message IDs', () => {
  const missing = snapshot(message('a', 'user', 'test'));
  delete missing.mapping.root;
  assert.throws(() => normalizeCloudConversation(missing), reason('missing selected branch node'));
  const cycle = snapshot(message('a', 'user', 'test'));
  cycle.mapping.root.parent = cycle.current_node;
  assert.throws(() => normalizeCloudConversation(cycle), reason('cyclic selected branch'));
  const mismatch = snapshot(message('a', 'user', 'test'));
  mismatch.mapping.root.id = 'different';
  assert.throws(() => normalizeCloudConversation(mismatch), reason('node ID mismatch'));
  const duplicate = snapshot(message('a', 'user', 'test'), message('b', 'assistant', 'test'));
  duplicate.mapping['node-b'].message.id = 'a';
  assert.throws(() => normalizeCloudConversation(duplicate), reason('repeated message ID'));
});

test('does not certify a synthetic paginated root or context continuation as complete history', () => {
  const input = snapshot(message('a', 'user', 'latest'));
  input.mapping['paginated-root:cloud-conversation'] = {
    ...input.mapping.root, id: 'paginated-root:cloud-conversation',
  };
  input.mapping['node-a'].parent = 'paginated-root:cloud-conversation';
  delete input.mapping.root;
  input.pagination = { cursor: 'older-page', oldestMessageId: 'a', numTurns: 1 };
  input.context_truncation_continuation = {};
  const result = normalizeCloudConversation(input);
  assert.equal(result.history.completeSelectedBranch, false);
  assert.deepEqual(result.history.reasons, ['synthetic-pagination-root', 'pagination-not-certified', 'context-continuation']);
});

test('preserves text and reports attachments and display-only work summaries separately', () => {
  const result = normalizeCloudConversation(snapshot(message('a', 'assistant', '', {
    content: { content_type: 'text', text: 'Actual text', parts: ['Unused alternate'] },
    metadata: { attachments: [{ id: 'file' }], work_activity: { groups: [] } },
  })));
  assert.equal(result.messages[0].text, 'Actual text');
  assert.deepEqual(result.unsupported.map(item => item.reason), ['work-activity-summary', 'attachments']);
  assert.equal(result.projection.completeVisibleText, false);
});

test('rejects untyped/page-only input and keeps unknown async state unknown', () => {
  assert.throws(() => normalizeCloudConversation({ conversation_id: 'test', messages: [], page_info: {} }), reason('expected full conversation mapping'));
  const input = snapshot(message('a', 'user', 'test'));
  input.async_status = 999;
  assert.equal(normalizeCloudConversation(input).asyncStatus, null);
  delete input.mapping.root.parent;
  assert.throws(() => normalizeCloudConversation(input), reason('expected parent ID or null'));
});
