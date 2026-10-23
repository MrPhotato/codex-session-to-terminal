import { runTerminalSessionView } from './terminal-session-view.mjs';
export { CLOUD_READONLY_BANNER } from './terminal-session-view.mjs';

// Legacy callers without desktop navigation keep their existing viewport.
// Product callers provide onOpenDesktop to enable the shared fixed toolbar.
export function runCloudReadonlyView(launch, options = {}) {
  return runTerminalSessionView(launch, { ...options, mode: 'readonly', toolbar: typeof options.onOpenDesktop === 'function' });
}
