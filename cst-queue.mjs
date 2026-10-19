import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const ALLOWED = new Set(['initialize', 'thread/queue/list', 'thread/queue/add']);

// The Desktop follower API replaces the entire queue. Instead, append through
// the official local queue API. This short-lived helper never resumes a thread,
// starts a turn, becomes its writer, or changes the Desktop's process/config.
export function createQueueSender(backendPath, { spawnBackend = spawn, timeoutMs = 15000, cwd, env = process.env } = {}) {
  if (!isAbsolute(backendPath ?? '')) throw new Error('A full Desktop backend path is required for queuing.');
  return async ({ threadId, text, clientUserMessageId, signal }) => {
    if (signal?.aborted) throw Object.assign(new Error('排队已取消。'), { code: 'QUEUE_CANCELLED' });
    const child = spawnBackend(backendPath, ['app-server'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], cwd, env });
    const pending = new Map();
    const decoder = new StringDecoder('utf8');
    let sequence = 0, buffer = '', closed = false, writeAttempted = false;
    const fail = error => {
      closed = true;
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
      pending.clear();
    };
    const abort = () => {
      fail(Object.assign(new Error('排队连接已关闭。'), { code: 'QUEUE_CANCELLED' }));
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) child.kill();
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stderr.on('data', () => {}); // Never persist backend diagnostics or account data.
    child.on('error', () => fail(new Error('Could not start the queue helper.')));
    child.on('exit', () => fail(new Error('Queue helper disconnected.')));
    child.stdin.on('error', () => fail(new Error('Queue helper input closed.')));
    child.stdout.on('error', () => fail(new Error('Queue helper output closed.')));
    child.stdout.on('data', chunk => {
      buffer += decoder.write(chunk);
      if (buffer.length > 2 * 1024 * 1024) { fail(new Error('Queue helper response was too large.')); return; }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { fail(new Error('Queue helper returned invalid JSON.')); return; }
        if (message.method && message.id !== undefined) {
          // The helper is never authorized to execute tools or request login.
          if (!closed) child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'CST queue helper does not handle server requests.' } }) + '\n');
        } else if (message.id !== undefined) {
          const item = pending.get(message.id);
          if (!item) continue;
          pending.delete(message.id); clearTimeout(item.timer);
          if (message.error) item.reject(new Error(`${item.method} was rejected (code ${message.error.code ?? 'unknown'}).`));
          else item.resolve(message.result);
        }
      }
    });
    const call = (method, params) => {
      if (!ALLOWED.has(method) || closed) return Promise.reject(new Error('Queue helper is unavailable.'));
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out.`)); }, timeoutMs);
        pending.set(id, { resolve, reject, timer, method });
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      });
    };
    try {
      await call('initialize', { clientInfo: { name: 'cst_queue_append', version: '0.2.0' }, capabilities: { experimentalApi: true } });
      child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
      // Capability check before writing; this does not load or claim the thread.
      await call('thread/queue/list', { threadId });
      writeAttempted = true;
      const result = await call('thread/queue/add', { threadId, clientUserMessageId, input: [{ type: 'text', text }] });
      if (result?.queuedSubmission?.clientUserMessageId !== clientUserMessageId) throw new Error('Queue response could not be matched to this message.');
      return { action: 'queue', clientUserMessageId, queuedSubmissionId: result.queuedSubmission.id };
    } catch (error) {
      if (writeAttempted) {
        const uncertain = new Error('排队结果未确认。请先在桌面检查消息队列，避免重复发送；CST 没有重试。');
        uncertain.code = 'QUEUE_OUTCOME_UNKNOWN';
        throw uncertain;
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      fail(new Error('Queue helper closed.'));
      child.stdin.end();
      const waitForExit = timeout => new Promise(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) { resolve(true); return; }
        const finish = exited => { clearTimeout(timer); child.removeListener('exit', onExit); resolve(exited); };
        const onExit = () => finish(true);
        const timer = setTimeout(() => finish(false), timeout);
        child.once('exit', onExit);
      });
      if (!await waitForExit(1000)) {
        child.kill();
        if (!await waitForExit(1000)) {
          const error = new Error('排队助手未能退出。请先检查桌面队列，避免重复发送；CST 没有重试。');
          error.code = 'QUEUE_HELPER_CLEANUP_FAILED';
          throw error;
        }
      }
    }
  };
}
