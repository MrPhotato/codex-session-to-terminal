import { randomUUID } from 'node:crypto';
import { win32 as windowsPath } from 'node:path';
import { getActiveTurnId } from './cst-state.mjs';

const fault = (message, code = -32000) => Object.assign(new Error(message), { rpcError: { code, message } });
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const normalize = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(normalize)
  : Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])])) : value;
const stable = value => JSON.stringify(normalize(value));
const comparableSetting = (key, value) => key === 'runtimeWorkspaceRoots' && Array.isArray(value)
  ? value.map(root => typeof root === 'string' ? windowsPath.normalize(root) : root)
  : key === 'cwd' && typeof value === 'string' ? windowsPath.normalize(value) : value;

export function validateInheritedSettings(params, state, method = 'turn/start') {
  const settings = state.latestThreadSettings ?? {}, permissions = state.currentPermissions ?? {};
  const expected = { model: settings.model, effort: settings.effort ?? state.latestReasoningEffort,
    summary: settings.summary, serviceTier: settings.serviceTier, cwd: settings.cwd ?? state.cwd,
    approvalPolicy: permissions.approvalPolicy ?? settings.approvalPolicy,
    approvalsReviewer: permissions.approvalsReviewer ?? settings.approvalsReviewer,
    sandboxPolicy: permissions.sandboxPolicy ?? settings.sandboxPolicy,
    collaborationMode: settings.collaborationMode ?? state.latestCollaborationMode,
    runtimeWorkspaceRoots: permissions.runtimeWorkspaceRoots,
    disabledPluginIds: settings.disabledPluginIds,
    multiAgentMode: settings.multiAgentMode,
    personality: settings.personality,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (params[key] !== null && params[key] !== undefined && stable(comparableSetting(key, params[key])) !== stable(comparableSetting(key, value))) {
      throw fault(`Changing ${key} from this terminal is not supported; change it in Desktop first.`, -32601);
    }
  }
  const allowed = new Set(['threadId', 'input', 'clientUserMessageId', ...Object.keys(expected)]);
  if (method === 'turn/steer') allowed.add('expectedTurnId');
  if (method === 'turn/start' && params.turnTrigger === 'user') allowed.add('turnTrigger');
  for (const [key, value] of Object.entries(params)) {
    if (!allowed.has(key) && value !== null && value !== undefined) throw fault(`The ${key} override is not supported here. Use Desktop for it.`, -32601);
  }
}

export function assertControlReady(state) {
  const history = state.turnHistory?.kind === 'canonical' ? state.turnHistory.history : null;
  if (history && history.islands?.at(-1)?.newerBoundary?.status !== 'exhausted') {
    throw fault('Desktop has not loaded the current end of this chat. No command was sent.');
  }
  const turns = [...(state.turns ?? []), ...Object.values(history?.entitiesByKey ?? {})];
  if (turns.some(turn => turn?.status === 'inProgress' && !validId(turn.turnId))) {
    throw fault('Desktop is admitting a new turn. Wait for it to be ready; no command was sent.');
  }
  if (state.threadRuntimeStatus?.type === 'active' && !getActiveTurnId(state)) {
    throw fault('Desktop reports activity without a confirmed active turn. No command was sent.');
  }
}

export function createDesktopController(desktop, threadId) {
  let pending = false;
  const counts = {};
  return {
    get counts() { return { ...counts }; },
    async call(method, params) {
      if (params.threadId !== threadId) throw fault('Only the attached chat can receive commands.', -32602);
      if (!desktop.status.ready || !desktop.currentOwner) throw fault('The original Desktop owner is unavailable.');
      if (pending) throw fault('Wait for the previous Desktop command result.');
      assertControlReady(desktop.state);
      const activeTurnId = getActiveTurnId(desktop.state);
      if (method === 'turn/interrupt') {
        for (const [key, value] of Object.entries(params)) if (!['threadId', 'turnId'].includes(key) && value !== null && value !== undefined) throw fault(`The ${key} interrupt parameter is not implemented.`, -32601);
        if (!activeTurnId) return {};
        if (params.turnId && params.turnId !== activeTurnId) throw fault('The active turn changed; no interrupt was sent.');
        pending = true;
        try {
          counts[method] = (counts[method] ?? 0) + 1;
          const response = await desktop.requestFollower('thread-follower-interrupt-turn', { conversationId: threadId, mode: 'user-stop', expectedTurnId: activeTurnId });
          if (response.result?.ok !== true && response.result?.result?.ok !== true) throw fault('The Desktop interrupt outcome is unconfirmed; CST did not retry.');
          return {};
        } catch (cause) {
          if (cause.rpcError) throw cause;
          throw fault('The Desktop interrupt result is unconfirmed. Check Desktop before trying again; CST did not retry.');
        } finally { pending = false; }
      }
      if (!['turn/start', 'turn/steer'].includes(method)) throw fault('This Desktop control command is not implemented.', -32601);
      if (!Array.isArray(params.input) || params.input.length === 0 || params.input.some(item => item?.type !== 'text' || typeof item.text !== 'string')) {
        throw fault('This terminal currently accepts plain text input only. Send attachments from Desktop.', -32602);
      }
      const text = params.input.map(item => item.text).join('\n');
      if (!text.trim() || Buffer.byteLength(text) > 256 * 1024) throw fault('The input is empty or exceeds the terminal input limit.', -32602);
      if (method === 'turn/start' && activeTurnId) throw fault('The original Desktop already has an active turn.');
      if (method === 'turn/steer' && !activeTurnId) throw fault('no active turn to steer', -32600);
      if (method === 'turn/steer' && params.expectedTurnId !== activeTurnId) throw fault(`expected active turn id \`${params.expectedTurnId}\` but found \`${activeTurnId}\``, -32600);
      const state = desktop.state, settings = state.latestThreadSettings;
      validateInheritedSettings(params, state, method);
      const clientUserMessageId = params.clientUserMessageId ?? randomUUID();
      if (!validId(clientUserMessageId)) throw fault('The client message ID is invalid.', -32602);
      const restoreMessage = { id: clientUserMessageId, text, cwd: state.cwd, createdAt: Date.now(), context: {
        prompt: text, addedFiles: [], fileAttachments: [], ideContext: null, imageAttachments: [], workspaceRoots: [state.cwd],
      } };
      const input = params.input;
      const ipcMethod = method === 'turn/start' ? 'thread-follower-start-turn' : 'thread-follower-steer-turn';
      const ipcParams = method === 'turn/start' ? {
        conversationId: threadId,
        turnStart: { request: { threadId, input, clientUserMessageId, ...(params.turnTrigger === 'user' ? { turnTrigger: 'user' } : {}) }, context: { restoreMessage, inheritThreadSettings: true } },
      } : { conversationId: threadId, input, restoreMessage, attachments: [], clientUserMessageId };
      pending = true;
      try {
        counts[method] = (counts[method] ?? 0) + 1;
        const response = await desktop.requestFollower(ipcMethod, ipcParams);
        const result = response.result?.result;
        if (!(method === 'turn/start' ? validId(result?.turn?.id) : validId(result?.turnId))) throw fault('The Desktop delivery result is unconfirmed. Check Desktop before sending again; CST did not retry.');
        if (method === 'turn/steer' && result.turnId !== activeTurnId) throw fault('The Desktop accepted a different active turn. Check Desktop before sending again; CST did not retry.');
        return result;
      } catch (cause) {
        if (cause.rpcError) throw cause;
        throw fault('The Desktop delivery result is unconfirmed. Check Desktop before sending again; CST did not retry.');
      } finally { pending = false; }
    },
  };
}
