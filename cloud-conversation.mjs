// Pure normalization of ChatGPT conversation data, not a CLI resume response.
// Shape evidence: installed Codex 26.1013.4894.0 app-initial bundle, Hx/Gx/qx,
// Pj, dNr, vgr/bgr and Asi. No network, credentials, defaults for permissions,
// synthetic turn IDs, or grouping of cloud messages into app-server turns.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = value => typeof value === 'string' && value.length > 0;
const optionalString = value => typeof value === 'string' ? value : null;
const optionalNumber = value => Number.isFinite(value) ? value : null;
const RUNTIME_FIELDS = [
  'approvalPolicy', 'approvalsReviewer', 'sandbox', 'cwd', 'modelProvider',
  'thread.sessionId', 'thread.cliVersion', 'thread.status',
];

function invalid(reason, path) {
  // Diagnostics contain structural paths only, never message text or IDs.
  throw Object.assign(new Error(`Invalid cloud conversation: ${reason} at ${path}.`), {
    code: 'INVALID_CLOUD_CONVERSATION', reason, path,
  });
}

function textContent(content) {
  if (!object(content) || content.content_type !== 'text') return null;
  if (Array.isArray(content.parts) && content.parts.some(part => typeof part !== 'string')) return null;
  if (typeof content.text === 'string') return content.text;
  if (Array.isArray(content.parts) && content.parts.every(part => typeof part === 'string')) {
    return content.parts.join('');
  }
  return null;
}

function approvalFrom(message, metadata) {
  const fromServer = metadata.jit_plugin_data?.from_server
    ?? metadata.elicitation_metadata?.plugin_data?.from_server;
  const request = metadata.codex_mcp_elicitation ?? fromServer?.body?.codex_mcp_elicitation;
  if (!object(request) || !string(request.kind)) return null;
  return {
    messageId: message.id,
    requestId: typeof request.request_id === 'string' || typeof request.request_id === 'number'
      ? request.request_id : null,
    targetMessageId: optionalString(request.target_message_id),
    kind: request.kind,
    status: optionalString(request.status),
    requestType: optionalString(fromServer?.type),
  };
}

export function normalizeCloudConversation(snapshot) {
  if (!object(snapshot)) invalid('expected object', '/');
  if (!string(snapshot.conversation_id)) invalid('missing conversation ID', '/conversation_id');
  if (!object(snapshot.mapping)) invalid('expected full conversation mapping', '/mapping');
  if (!Object.hasOwn(snapshot, 'current_node')
    || snapshot.current_node !== null && !string(snapshot.current_node)) {
    invalid('expected selected node ID or null', '/current_node');
  }

  const nodes = [], seenNodes = new Set(), seenMessages = new Set();
  let nodeId = snapshot.current_node;
  while (nodeId !== null) {
    if (seenNodes.has(nodeId)) invalid('cyclic selected branch', '/mapping/<node>/parent');
    if (!Object.hasOwn(snapshot.mapping, nodeId)) invalid('missing selected branch node', '/mapping/<node>');
    const node = snapshot.mapping[nodeId];
    if (!object(node)) invalid('expected node object', '/mapping/<node>');
    if (node.id !== undefined && node.id !== nodeId) invalid('node ID mismatch', '/mapping/<node>/id');
    if (!Object.hasOwn(node, 'parent') || node.parent !== null && !string(node.parent)) {
      invalid('expected parent ID or null', '/mapping/<node>/parent');
    }
    if (!Object.hasOwn(node, 'message')) invalid('missing message field', '/mapping/<node>/message');
    if (node.message !== null) {
      const message = node.message;
      if (!object(message) || !string(message.id) || !object(message.author)
        || !string(message.author.role) || !Object.hasOwn(message, 'content')) {
        invalid('invalid message shape', '/mapping/<node>/message');
      }
      if (seenMessages.has(message.id)) invalid('repeated message ID', '/mapping/<node>/message/id');
      seenMessages.add(message.id);
    }
    seenNodes.add(nodeId);
    nodes.push({ nodeId, node });
    nodeId = node.parent;
  }
  nodes.reverse();

  const messages = [], omitted = [], unsupported = [], approvals = [];
  for (const { nodeId, node } of nodes) {
    const message = node.message;
    if (message === null) continue;
    const metadata = object(message.metadata) ? message.metadata : {};
    const role = message.author.role;
    const contentType = optionalString(message.content?.content_type);
    const identity = { nodeId, messageId: message.id };
    if (metadata.codex_optimistic_steering_user === true || metadata.codex_optimistic_steering_assistant === true) {
      omitted.push({ ...identity, reason: 'optimistic' });
      continue;
    }
    const approval = approvalFrom(message, metadata);
    if (approval) approvals.push(approval);
    const hidden = metadata.is_visually_hidden_from_conversation === true;
    const tool = role === 'tool' ? 'tool-output'
      : role === 'assistant' && string(message.recipient) && message.recipient !== 'all' ? 'tool-call' : null;
    if (tool) unsupported.push({ ...identity, reason: tool, contentType, hidden });
    if (hidden) {
      omitted.push({ ...identity, reason: 'hidden' });
      continue;
    }
    if (role === 'system' || role === 'developer') {
      omitted.push({ ...identity, reason: 'system-role' });
      continue;
    }
    if (tool) continue;
    if (role !== 'user' && role !== 'assistant') {
      unsupported.push({ ...identity, reason: 'author-role', contentType });
      continue;
    }
    const text = textContent(message.content);
    if (text === null) {
      unsupported.push({ ...identity, reason: 'content', contentType });
      continue;
    }
    if (role === 'assistant' && /^::\s*SKIP_COMPLETION\s*::$/.test(text.trim())) {
      omitted.push({ ...identity, reason: 'skip-completion' });
      continue;
    }
    if (role === 'assistant' && message.channel != null
      && !['commentary', 'final'].includes(message.channel)) {
      unsupported.push({ ...identity, reason: 'assistant-channel', channel: optionalString(message.channel), contentType });
      continue;
    }
    if (metadata.work_activity != null) unsupported.push({ ...identity, reason: 'work-activity-summary', contentType });
    if (Array.isArray(metadata.attachments) && metadata.attachments.length > 0) {
      unsupported.push({ ...identity, reason: 'attachments', contentType });
    }
    if (approval) unsupported.push({ ...identity, reason: 'approval-interaction', contentType });
    messages.push({
      id: message.id, nodeId, parentNodeId: node.parent, role, text,
      channel: optionalString(message.channel),
      recipient: optionalString(message.recipient),
      status: optionalString(message.status),
      endTurn: typeof message.end_turn === 'boolean' ? message.end_turn : null,
      createdAt: optionalNumber(message.create_time),
      updatedAt: optionalNumber(message.update_time),
      // Keep candidates separate: their equivalence is not established.
      turnIdentity: {
        turnId: optionalString(metadata.turnId),
        turn_id: optionalString(metadata.turn_id),
        workingTurnId: optionalString(metadata.working_turn_id),
        turnExchangeId: optionalString(metadata.turn_exchange_id),
      },
    });
  }

  const historyReasons = [];
  if (snapshot.current_node === null && Object.keys(snapshot.mapping).length > 0) historyReasons.push('no-selected-branch');
  if (nodes[0]?.nodeId.startsWith('paginated-root:')) historyReasons.push('synthetic-pagination-root');
  if (snapshot.pagination != null) historyReasons.push('pagination-not-certified');
  if (snapshot.context_truncation_continuation != null) historyReasons.push('context-continuation');
  const configuredModel = optionalString(snapshot.default_model_slug);
  return {
    conversationId: snapshot.conversation_id,
    currentNodeId: snapshot.current_node,
    title: optionalString(snapshot.title),
    configuredModel,
    asyncStatus: Number.isInteger(snapshot.async_status) && snapshot.async_status >= 1 && snapshot.async_status <= 7
      ? snapshot.async_status : null,
    messages, omitted, unsupported, approvals,
    history: { completeSelectedBranch: historyReasons.length === 0, reasons: historyReasons },
    projection: { completeVisibleText: unsupported.length === 0 },
    nativeResume: {
      supported: false,
      missingRuntimeFields: [...RUNTIME_FIELDS, ...(configuredModel === null ? ['model'] : [])],
      missingTurnContract: true,
    },
  };
}
