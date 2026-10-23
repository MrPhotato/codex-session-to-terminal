import { inheritedThreadSettings, orderedDesktopTurns } from './desktop-events.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const present = (value, key) => own(value, key) && value[key] !== undefined;
const nonempty = value => typeof value === 'string' && value.length > 0;
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const milliseconds = value => Number.isSafeInteger(value) && value >= 0;
const fail = (code, message, missingFields = []) => Object.assign(new Error(message), { code, missingFields });

function previewFromSnapshot(state) {
  const history = state.turnHistory?.kind === 'canonical' ? state.turnHistory.history : null;
  // A tail page does not establish the first user message. An unavailable
  // display preview is an empty string, not a fabricated transcript entry.
  if (history?.islands?.[0]?.olderBoundary?.status !== 'exhausted') return '';
  for (const turn of orderedDesktopTurns(state)) {
    const user = turn.items?.find(item => item.type === 'userMessage');
    if (user) return (Array.isArray(user.content) ? user.content : []).filter(part => part?.type === 'text' && typeof part.text === 'string')
      .map(part => part.text).join('\n');
  }
  return '';
}

/**
 * Experimental, pure projection of a durable Desktop snapshot to thread/read
 * metadata (includeTurns:false). It does not resume, connect, or hydrate history.
 * originalThread, when supplied, must be an authoritative Thread for this same
 * native ID; it can restore creation/project facts omitted by Desktop snapshots.
 * cliVersion means the creating CLI version, never this adapter's version. An
 * absent version is represented by the protocol's empty/unknown string. A null
 * projectId means this projection does not expose the canonical assignment; it
 * must not be used to infer or change backend project membership.
 * persistedThread must come from an authoritative prior persisted-thread read,
 * not merely from the existence of a live snapshot. It only permits deriving
 * ephemeral:false when Desktop omitted that storage fact.
 */
export function cloudNativeMetadataFromSnapshot(state, { originalThread, persistedThread = false } = {}) {
  if (!object(state) || state.hostId !== 'durable' || !uuid(state.id)) {
    throw fail('INVALID_CLOUD_SNAPSHOT', 'A durable native Desktop snapshot with its real thread ID is required.');
  }
  if (originalThread !== undefined && (!object(originalThread) || originalThread.id !== state.id)) {
    throw fail('THREAD_MISMATCH', 'Original thread metadata must belong to the same native thread.');
  }
  if (typeof persistedThread !== 'boolean') throw fail('INVALID_CLOUD_METADATA_OPTIONS', 'persistedThread must be a boolean.');
  const original = originalThread ?? {};
  const fact = key => present(state, key) ? state[key] : original[key];
  const projection = { unknownFields: [], derivedFields: [] };
  const cliVersion = fact('cliVersion');
  const projectId = fact('projectId');
  const ephemeral = fact('ephemeral');
  if (cliVersion === undefined) projection.unknownFields.push('cliVersion');
  if (projectId === undefined) projection.unknownFields.push('projectId');
  if (ephemeral === undefined && persistedThread) projection.derivedFields.push('ephemeral');
  const settings = inheritedThreadSettings(state);
  const fields = {
    sessionId: state.sessionId,
    modelProvider: settings.modelProvider ?? state.modelProvider,
    cwd: settings.cwd ?? state.cwd,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    source: fact('source'),
    status: state.threadRuntimeStatus,
    cliVersion: cliVersion === undefined ? '' : cliVersion,
    ephemeral: ephemeral === undefined && persistedThread ? false : ephemeral,
    projectId: projectId === undefined ? null : projectId,
  };
  const checks = {
    // Official Thread/ThreadResumeResponse require a string, not a nonempty
    // provider ID. Preserve an authoritative empty value without inventing one.
    sessionId: uuid, modelProvider: value => typeof value === 'string', cwd: nonempty,
    createdAt: milliseconds, updatedAt: milliseconds,
    source: value => ['cli', 'vscode', 'exec', 'appServer', 'unknown'].includes(value) || object(value) &&
      (typeof value.custom === 'string' || typeof value.subAgent === 'string' || object(value.subAgent)),
    status: value => object(value) && ['idle', 'active', 'notLoaded', 'systemError'].includes(value.type) &&
      (value.type !== 'active' || Array.isArray(value.activeFlags)),
    cliVersion: value => typeof value === 'string', ephemeral: value => typeof value === 'boolean',
    projectId: value => value === null || nonempty(value),
  };
  const missing = Object.keys(checks).filter(key => !checks[key](fields[key]));
  if (missing.length) throw fail('INCOMPLETE_CLOUD_METADATA',
    `The durable snapshot lacks required native thread metadata: ${missing.join(', ')}.`, missing);

  const thread = {
    id: state.id, ...fields,
    createdAt: Math.floor(fields.createdAt / 1000),
    updatedAt: Math.floor(fields.updatedAt / 1000),
    preview: typeof fact('preview') === 'string' ? fact('preview') : previewFromSnapshot(state),
    turns: [],
  };
  if (typeof fact('preview') !== 'string') projection.derivedFields.push('preview');
  for (const key of ['historyMode', 'originator', 'threadSource', 'forkedFromId', 'parentThreadId',
    'agentNickname', 'agentRole', 'daybreakEnabled', 'environments', 'gitInfo']) {
    if (fact(key) !== undefined) thread[key] = fact(key);
  }
  if (state.title !== undefined) thread.name = state.title;
  if (state.latestModel !== undefined) thread.model = settings.model ?? state.latestModel;
  if (state.latestReasoningEffort !== undefined) thread.reasoningEffort = settings.effort ?? state.latestReasoningEffort;
  if (state.recencyAt !== undefined && state.recencyAt !== null) {
    if (!milliseconds(state.recencyAt)) throw fail('INCOMPLETE_CLOUD_METADATA', 'The durable recency timestamp is invalid.', ['recencyAt']);
    thread.recencyAt = Math.floor(state.recencyAt / 1000);
  }
  if (nonempty(state.rolloutPath)) thread.path = state.rolloutPath;
  // Callers may attach protocol turns later without mutating the live snapshot.
  return structuredClone({ thread, projection });
}
