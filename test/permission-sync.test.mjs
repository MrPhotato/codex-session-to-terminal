import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { inheritedThreadSettings, DesktopEventProjector } from '../desktop-events.mjs';
import { resumeFromLiveSnapshot } from '../native-cli-bridge.mjs';
import { createDesktopController, validateInheritedSettings } from '../desktop-control.mjs';
import { validateProtocol } from '../protocol-validation.mjs';

const workspace = { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review',
  sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['C:\\fixture'], networkAccess: false,
    excludeTmpdirEnvVar: false, excludeSlashTmp: false },
  activePermissionProfile: { id: ':workspace', extends: null } };
const fullAccess = { approvalPolicy: 'never', approvalsReviewer: 'user',
  sandboxPolicy: { type: 'dangerFullAccess' },
  activePermissionProfile: { id: ':danger-full-access', extends: null } };
function stateWith(current = workspace, latest = fullAccess) {
  return { id: 'fixture-thread', cwd: 'C:\\fixture', sessionId: 'fixture-session', turns: [],
    threadRuntimeStatus: { type: 'idle' },
    currentPermissions: { ...structuredClone(current), runtimeWorkspaceRoots: ['C:\\fixture'] },
    latestThreadSettings: { model: 'fixture', modelProvider: 'fixture', cwd: 'C:\\fixture',
      collaborationMode: { mode: 'default', settings: { model: 'fixture', reasoning_effort: null, developer_instructions: null } },
      ...structuredClone(latest) } };
}

test('resume and validation follow the saved settings that Desktop inherits, in both directions', () => {
  for (const [current, latest] of [[workspace, fullAccess], [fullAccess, workspace]]) {
    const state = stateWith(current, latest), before = structuredClone(state);
    const response = resumeFromLiveSnapshot({ thread: { id: state.id } }, state);
    assert.equal(response.approvalPolicy, latest.approvalPolicy);
    assert.equal(response.approvalsReviewer, latest.approvalsReviewer);
    assert.deepEqual(response.sandbox, latest.sandboxPolicy);
    assert.deepEqual(response.activePermissionProfile, latest.activePermissionProfile);
    validateInheritedSettings({ approvalPolicy: response.approvalPolicy, approvalsReviewer: response.approvalsReviewer,
      permissions: response.activePermissionProfile.id, runtimeWorkspaceRoots: response.runtimeWorkspaceRoots }, state);
    assert.throws(() => validateInheritedSettings({ approvalPolicy: current.approvalPolicy }, state), /Changing approvalPolicy/);
    assert.deepEqual(state, before);
  }
});

test('a saved permission change publishes one consistent native settings update', () => {
  const state = stateWith(workspace, workspace), events = [];
  const projector = new DesktopEventProjector(state.id, (method, params) => events.push({ method, params }));
  projector.seed(state);
  state.latestThreadSettings = { ...state.latestThreadSettings, ...fullAccess };
  projector.update(state);
  assert.equal(events.length, 1);
  assert.equal(events[0].method, 'thread/settings/updated');
  validateProtocol('ServerNotification', events[0]);
  const settings = events[0].params.threadSettings;
  validateInheritedSettings({ approvalPolicy: settings.approvalPolicy, approvalsReviewer: settings.approvalsReviewer,
    permissions: settings.activePermissionProfile.id }, state);
  state.currentPermissions = { ...state.currentPermissions, ...fullAccess };
  projector.update(state);
  assert.equal(events.length, 1, 'catch-up of the previous-turn cache cannot revert or duplicate saved settings');
});

test('missing permission fields use the current snapshot but an explicit null clears the saved profile', () => {
  const state = stateWith(workspace, {}), events = [];
  assert.equal(inheritedThreadSettings(state).approvalPolicy, 'on-request');
  const projector = new DesktopEventProjector(state.id, (method, params) => events.push({ method, params }));
  projector.seed(state);
  state.currentPermissions = { ...state.currentPermissions, ...fullAccess };
  projector.update(state);
  assert.equal(events.length, 1);
  assert.equal(events[0].params.threadSettings.approvalPolicy, 'never');
  validateProtocol('ServerNotification', events[0]);
  state.latestThreadSettings.activePermissionProfile = null;
  assert.equal(inheritedThreadSettings(state).activePermissionProfile, null);
  assert.equal(resumeFromLiveSnapshot({ thread: { id: state.id } }, state).activePermissionProfile, null);
  assert.throws(() => validateInheritedSettings({ permissions: ':danger-full-access' }, state), /Changing permissions/);
});

test('matching native permission profile echoes are allowed without forwarding overrides', async () => {
  const state = stateWith(), writes = [];
  const desktop = Object.assign(new EventEmitter(), { state, status: { ready: true }, currentOwner: { clientId: 'owner' },
    async requestFollower(method, params) { writes.push({ method, params }); return { result: { result: { turn: { id: 'server-turn' } } } }; } });
  const controller = createDesktopController(desktop, state.id);
  await controller.call('turn/start', { threadId: state.id, input: [{ type: 'text', text: 'fixture' }],
    approvalPolicy: 'never', approvalsReviewer: 'user', permissions: ':danger-full-access' });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].params.turnStart.context.inheritThreadSettings, true);
  for (const key of ['approvalPolicy', 'approvalsReviewer', 'permissions', 'sandboxPolicy', 'activePermissionProfile']) {
    assert.equal(Object.hasOwn(writes[0].params.turnStart.request, key), false);
  }
  for (const params of [{ permissions: ':workspace' }, { approvalPolicy: 'on-request' }, { approvalsReviewer: 'auto_review' },
    { sandboxPolicy: workspace.sandboxPolicy }, { permissions: ':danger-full-access', sandboxPolicy: fullAccess.sandboxPolicy }]) {
    await assert.rejects(controller.call('turn/start', { threadId: state.id, input: [{ type: 'text', text: 'fixture' }], ...params }), /not supported/);
  }
  assert.equal(writes.length, 1, 'rejected changes must never reach Desktop');
});
