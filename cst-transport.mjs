import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { lstatSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function installedDesktopPipeHelper() {
  if (process.platform !== 'win32') return null;
  const path = join(dirname(fileURLToPath(import.meta.url)), 'bin', 'Desktop-Pipe.exe');
  try {
    const directory = lstatSync(dirname(path)), file = lstatSync(path);
    return directory.isDirectory() && !directory.isSymbolicLink() && file.isFile() && !file.isSymbolicLink() ? path : null;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// A separate native (or source-checkout PowerShell) helper checks the server PID, executable and Windows
// user on the exact named-pipe handle that carries the traffic. Never send a
// prompt to an unverified same-name pipe.
export function verifiedDesktopTransport(powershellPath, { spawnHelper = spawn, pipeName = 'codex-ipc',
  nativeHelperPath = installedDesktopPipeHelper() } = {}) {
  if (!isAbsolute(powershellPath ?? '')) throw new Error('A full PowerShell path is required.');
  if (nativeHelperPath !== null && (!isAbsolute(nativeHelperPath) || /[\0\r\n]/.test(nativeHelperPath))) throw new Error('A full native helper path is required.');
  if (typeof pipeName !== 'string' || !/^(?:codex-ipc|codex-app-tools-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(pipeName)) {
    throw new Error('Only a supported Desktop pipe name is allowed.');
  }
  const helper = join(dirname(fileURLToPath(import.meta.url)), 'desktop-pipe-proxy.ps1');
  return async ({ signal } = {}) => {
    if (signal?.aborted) throw new Error('Desktop connection cancelled.');
    const child = spawnHelper(nativeHelperPath ?? powershellPath, nativeHelperPath ? ['--pipe', pipeName]
      : ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', helper,
        ...(pipeName === 'codex-ipc' ? [] : ['-PipeName', pipeName])], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const decoder = new StringDecoder('utf8');
    let diagnostics = '', stderrBuffer = '', ready = false, resolveReady, rejectReady;
    const readiness = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const stream = new Duplex({
      // EOF can precede the helper's exit status. Only child.close may confirm
      // a clean shutdown; auto-destruction would hide a later nonzero exit.
      autoDestroy: false,
      read() { child.stdout.resume(); },
      write(chunk, encoding, callback) { child.stdin.write(chunk, encoding, callback); },
      final(callback) { child.stdin.end(callback); },
      destroy(error, callback) {
        signal?.removeEventListener('abort', abort);
        if (!ready) rejectReady(error || new Error('Desktop connection closed before verification.'));
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        if (child.exitCode === null && child.signalCode === null) child.kill();
        callback(error);
      },
    });
    // A child can fail before the caller receives the stream and attaches its
    // normal listeners. Keep a guard without suppressing downstream listeners.
    stream.on('error', () => {});
    const abort = () => stream.destroy(new Error('Desktop connection cancelled.'));
    signal?.addEventListener('abort', abort, { once: true });
    child.stderr.on('data', bytes => {
      stderrBuffer += decoder.write(bytes);
      let index;
      while ((index = stderrBuffer.indexOf('\n')) >= 0) {
        const line = stderrBuffer.slice(0, index).replace(/\r$/, '');
        stderrBuffer = stderrBuffer.slice(index + 1);
        if (line === 'CST_PIPE_VERIFIED' && !ready && !stream.destroyed) {
          ready = true; resolveReady(stream); child.stdout.resume();
        } else diagnostics = (diagnostics + line + '\n').slice(-2000);
      }
      if (stderrBuffer.length > 2000) stderrBuffer = stderrBuffer.slice(-2000);
    });
    child.stdout.on('data', bytes => {
      if (!ready) { stream.destroy(new Error('Desktop helper sent traffic before verification.')); return; }
      if (!stream.push(bytes)) child.stdout.pause();
    });
    // Stderr/stdout are separate OS streams: stdout may become readable first
    // even though the helper wrote its readiness marker first. Hold it safely.
    child.stdout.pause();
    child.stdout.once('end', () => stream.push(null));
    for (const source of [child.stdin, child.stdout, child.stderr]) source.on('error', error => stream.destroy(error));
    child.on('error', error => stream.destroy(error));
    // close follows stdio drain; exit can precede the last IPC bytes.
    child.once('close', (code, signal) => {
      const clean = code === 0 && signal == null;
      if (!stream.destroyed) stream.destroy(clean ? undefined : new Error((diagnostics + stderrBuffer).trim() || 'Desktop pipe helper did not exit cleanly.'));
    });
    if (signal?.aborted) abort();
    return readiness;
  };
}
