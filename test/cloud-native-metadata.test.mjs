import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudNativeMetadataFromSnapshot } from '../cloud-native-metadata.mjs';
import { resumeFromLiveSnapshot } from '../native-cli-bridge.mjs';
import { SnapshotHistory } from '../snapshot-history.mjs';
import { validateProtocol } from '../protocol-validation.mjs';

const threadId = '11111111-1111-4111-8111-111111111111';
function fixture() {
  const turn = { turnId: 'native-turn', status: 'completed', turnStartedAtMs: 1792490894000, durationMs: 9000,
    items: [{ id: 'native-user', type: 'userMessage', content: [{ type: 'text', text: 'Original prompt' }] },
      { id: 'native-assistant', type: 'agentMessage', text: 'Original answer', phase: 'final_answer' }],
    itemsPagination: { hasLoadedOldest: true } };
  return { id: threadId, sessionId: threadId, hostId: 'durable', title: 'Cloud task',
    createdAt: 1792490891123, updatedAt: 1792548246999, recencyAt: 1792548246000,
    source: { custom: 'codex-cloud-agent' }, threadSource: 'user', originator: 'codex_work_web',
    historyMode: 'legacy', rolloutPath: '', modelProvider: 'local', latestModel: 'gpt-6.1-sol-wm',
    cwd: '/workspace/scratch/example', threadRuntimeStatus: { type: 'idle' },
    latestThreadSettings: { model: 'gpt-6.1-sol-wm', cwd: '/workspace/scratch/example', effort: 'medium', disabledPluginIds: [],
      multiAgentMode: { custom: '' }, collaborationMode: { mode: 'default', settings: {
        model: 'gpt-6.1-sol-wm', reasoning_effort: 'medium', developer_instructions: null,
      } },
      approvalPolicy: { granular: { sandbox_approval: false, rules: false, skill_approval: false, request_permissions: false, mcp_elicitations: true } },
      approvalsReviewer: 'auto_review', sandboxPolicy: { type: 'dangerFullAccess' } },
    currentPermissions: { runtimeWorkspaceRoots: ['/workspace/scratch/example'] },
    turns: [], turnHistory: { kind: 'canonical', history: { entitiesByKey: { turn }, islands: [{
      entries: [{ value: 'turn' }], olderBoundary: { status: 'exhausted' }, newerBoundary: { status: 'exhausted' },
    }] } } };
}
// These are explicit fixture facts, not facts recovered by the live experiment.
const original = () => ({ id: threadId, cliVersion: '0.163.0', ephemeral: false, projectId: null });

test('a snapshot alone cannot prove the thread is persisted', () => {
  assert.throws(() => cloudNativeMetadataFromSnapshot(fixture()), error => {
    assert.equal(error.code, 'INCOMPLETE_CLOUD_METADATA');
    assert.deepEqual(error.missingFields, ['ephemeral']);
    assert.equal(error.message.includes('Original prompt'), false);
    return true;
  });
});

test('verified persisted thread exposes unknown display metadata without inventing a creator version', () => {
  const state = fixture();
  const metadata = cloudNativeMetadataFromSnapshot(state, { persistedThread: true });
  assert.equal(metadata.thread.cliVersion, '');
  assert.equal(metadata.thread.projectId, null);
  assert.equal(metadata.thread.ephemeral, false);
  assert.deepEqual(metadata.projection, { unknownFields: ['cliVersion', 'projectId'], derivedFields: ['ephemeral', 'preview'] });
  const result = resumeFromLiveSnapshot(metadata, state);
  result.thread.turns = new SnapshotHistory(state).turns;
  validateProtocol('v2/ThreadResumeResponse', result);
});

test('same-thread facts plus canonical history produce a schema-valid real runtime resume', () => {
  const state = fixture();
  const metadata = cloudNativeMetadataFromSnapshot(state, { originalThread: original() });
  assert.equal(metadata.thread.createdAt, 1792490891);
  assert.equal(metadata.thread.updatedAt, 1792548246);
  assert.equal(metadata.thread.preview, 'Original prompt');
  assert.deepEqual(metadata.thread.source, { custom: 'codex-cloud-agent' });
  assert.equal(metadata.thread.modelProvider, 'local');
  assert.equal(metadata.thread.path, undefined);
  assert.deepEqual(metadata.thread.turns, []);
  const result = resumeFromLiveSnapshot(metadata, state);
  result.thread.turns = new SnapshotHistory(state).turns;
  validateProtocol('v2/ThreadResumeResponse', result);
  assert.equal(result.thread.turns[0].id, 'native-turn');
  assert.equal(result.thread.turns[0].items[0].id, 'native-user');
  assert.deepEqual(result.approvalPolicy, state.latestThreadSettings.approvalPolicy);
  assert.deepEqual(result.sandbox, { type: 'dangerFullAccess' });
});

test('authoritative empty provider strings are preserved and accepted by both official schema fields', () => {
  for (const location of ['snapshot', 'settings']) {
    const state = fixture();
    if (location === 'snapshot') state.modelProvider = '';
    else state.latestThreadSettings.modelProvider = '';
    const before = structuredClone(state);
    const metadata = cloudNativeMetadataFromSnapshot(state, { persistedThread: true });
    assert.equal(metadata.thread.modelProvider, '');
    assert.equal(metadata.projection.unknownFields.includes('modelProvider'), false);
    assert.equal(metadata.projection.derivedFields.includes('modelProvider'), false);
    assert.deepEqual(state, before);

    const result = resumeFromLiveSnapshot(metadata, state);
    assert.equal(result.thread.modelProvider, '');
    assert.equal(result.modelProvider, '');
    validateProtocol('v2/ThreadResumeResponse', result);
  }
});

test('missing, null and nonstring provider facts remain invalid and original metadata cannot fill them', () => {
  for (const value of [undefined, null, 0, false, {}, []]) {
    const state = fixture();
    if (value === undefined) delete state.modelProvider;
    else state.modelProvider = value;
    assert.throws(() => cloudNativeMetadataFromSnapshot(state, { originalThread: { ...original(), modelProvider: 'openai' } }),
      error => error.code === 'INCOMPLETE_CLOUD_METADATA' && error.missingFields.includes('modelProvider'));
    const settingsState = fixture();delete settingsState.modelProvider;
    settingsState.latestThreadSettings.modelProvider = value;
    assert.throws(() => cloudNativeMetadataFromSnapshot(settingsState, { persistedThread: true }),
      error => error.code === 'INCOMPLETE_CLOUD_METADATA' && error.missingFields.includes('modelProvider'));
  }
});

test('snapshot facts take precedence and projection cannot mutate the live objects', () => {
  const state = { ...fixture(), cliVersion: 'creator-version', ephemeral: true, projectId: 'real-project' };
  const before = structuredClone(state);
  const { thread } = cloudNativeMetadataFromSnapshot(state, { originalThread: original() });
  assert.equal(thread.cliVersion, 'creator-version');
  assert.equal(thread.ephemeral, true);
  assert.equal(thread.projectId, 'real-project');
  thread.source.custom = 'changed';
  thread.status.type = 'systemError';
  assert.deepEqual(state, before);
});

test('foreign metadata, frontend ChatGPT snapshots and missing session identity are rejected', () => {
  const state = fixture();
  assert.throws(() => cloudNativeMetadataFromSnapshot(state, { originalThread: { ...original(), id: 'foreign' } }), { code: 'THREAD_MISMATCH' });
  assert.throws(() => cloudNativeMetadataFromSnapshot({ ...state, hostId: 'local' }), { code: 'INVALID_CLOUD_SNAPSHOT' });
  assert.throws(() => cloudNativeMetadataFromSnapshot({ conversation_id: threadId, mapping: {} }), { code: 'INVALID_CLOUD_SNAPSHOT' });
  delete state.sessionId;
  assert.throws(() => cloudNativeMetadataFromSnapshot(state, { originalThread: original() }), error => error.missingFields.includes('sessionId'));
});

test('partial history does not relabel a later prompt as the original preview', () => {
  const state = fixture();
  state.turnHistory.history.islands[0].olderBoundary.status = 'available';
  assert.equal(cloudNativeMetadataFromSnapshot(state, { originalThread: original() }).thread.preview, '');
  assert.equal(cloudNativeMetadataFromSnapshot(state, { originalThread: { ...original(), preview: 'Authoritative preview' } }).thread.preview, 'Authoritative preview');
});

test('invalid timestamps and null creation facts fail rather than receiving defaults', () => {
  for (const value of [NaN, Infinity, -1, 1.5, '1792490891000']) {
    assert.throws(() => cloudNativeMetadataFromSnapshot({ ...fixture(), createdAt: value }, { originalThread: original() }), error => error.missingFields.includes('createdAt'));
  }
  assert.throws(() => cloudNativeMetadataFromSnapshot(fixture(), { originalThread: { ...original(), cliVersion: null, ephemeral: null } }), error => {
    assert.deepEqual(error.missingFields, ['cliVersion', 'ephemeral']); return true;
  });
});

test('metadata cannot supply missing runtime permissions to resume', () => {
  const state = fixture();
  delete state.currentPermissions;
  const metadata = cloudNativeMetadataFromSnapshot(state, { originalThread: original() });
  assert.throws(() => resumeFromLiveSnapshot(metadata, state), { code: 'INCOMPLETE_STATE' });
});

test('unknown runtime source/status shapes fail instead of being remapped to local defaults', () => {
  for (const [field, value, missing] of [['source', 'chatgpt', 'source'],
    ['threadRuntimeStatus', { type: 'completed' }, 'status'], ['threadRuntimeStatus', { type: 'active' }, 'status']]) {
    assert.throws(() => cloudNativeMetadataFromSnapshot({ ...fixture(), [field]: value }, { persistedThread: true }),
      error => error.missingFields.includes(missing));
  }
});
