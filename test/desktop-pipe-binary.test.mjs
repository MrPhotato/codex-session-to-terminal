import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function powershell() {
  const located = spawnSync('where.exe', ['pwsh.exe'], { windowsHide: true, encoding: 'utf8' }).stdout?.trim().split(/\r?\n/) ?? [];
  return [process.env.CST_TEST_POWERSHELL, ...located,
    path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'native', 'powershell', 'pwsh.exe'),
  ].find(value => value && path.isAbsolute(value) && existsSync(value));
}

test('Windows pipe helper rejects arbitrary or command-shaped names before opening a pipe', { skip: process.platform !== 'win32' }, () => {
  const executable = powershell();
  assert(executable, 'PowerShell 7 is required for pipe parameter validation.');
  const script = fileURLToPath(new URL('../desktop-pipe-proxy.ps1', import.meta.url));
  for (const pipeName of ['unrelated-pipe', 'codex-app-tools-not-a-uuid', 'codex-ipc;Write-Output WRONG']) {
    const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, '-PipeName', pipeName],
      { windowsHide: true, encoding: 'utf8', timeout: 10000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /validate|pattern|模式|验证/i);
    assert.equal(result.stdout, '');
  }
});

test('Windows binary proxy preserves every byte under child-pipe backpressure', { skip: process.platform !== 'win32', timeout: 105000 }, async t => {
  const executable = powershell();
  assert(executable, 'PowerShell 7 is required for the Windows binary transport regression test.');
  const proxy = await readFile(new URL('../desktop-pipe-proxy.ps1', import.meta.url), 'utf8');
  const source = /Add-Type -TypeDefinition @'\r?\n([\s\S]+?)\r?\n'@/.exec(proxy)?.[1];
  assert(source?.includes('public static class CstVerifiedPipe'));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cst-binary-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert(path.basename(directory).startsWith('cst-binary-test-'));
    return rm(directory, { recursive: true, force: true });
  });
  const fixture = path.join(directory, 'binary-output.ps1');
  // Compile the exact production byte-copy routine, without Run(), package
  // discovery, peer validation or any connection to a Desktop pipe.
  await writeFile(fixture, `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n${source}\n'@\n[void][CstVerifiedPipe]::CopyToStdout([Console]::OpenStandardInput()).GetAwaiter().GetResult()\n`);
  for (const length of [14 * 1024 * 1024 + 137, 14 * 1024 * 1024 + 81919, 14 * 1024 * 1024 + 1]) {
    const payload = Buffer.allocUnsafe(length);
    for (let index = 0; index < payload.length; index++) payload[index] = index % 251;
    const expected = createHash('sha256').update(payload).digest('hex');
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', fixture], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let bytes = 0, chunks = 0, diagnostics = '', failure, resume;
    const hash = createHash('sha256');
    // Includes PowerShell startup, compilation and intentionally paused reads
    // on shared runners; byte counts and hashes remain the acceptance checks.
    const timeout = setTimeout(() => { failure = new Error('Binary transport test timed out.'); child.kill(); }, 30000);
    child.on('error', error => { failure = error; });
    child.stdin.on('error', error => { failure ??= error; });
    child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-2000); });
    child.stdout.on('data', chunk => {
      bytes += chunk.length; chunks++; hash.update(chunk);
      // Slow readers make a Windows nonblocking pipe perform partial/zero
      // writes. ConsoleStream.CopyToAsync used to silently lose large chunks.
      if (chunks % 4 === 0) {
        child.stdout.pause();
        resume = setTimeout(() => child.stdout.resume(), 20);
      }
    });
    child.stdin.end(payload);
    const exitCode = await new Promise(resolve => child.once('close', resolve));
    clearTimeout(timeout); clearTimeout(resume);
    if (failure) throw failure;
    assert.equal(exitCode, 0, diagnostics);
    assert.equal(diagnostics, '');
    assert.equal(bytes, payload.length, 'Proxy truncated data or added PowerShell pipeline output.');
    assert.equal(hash.digest('hex'), expected, 'Proxy changed the binary payload.');
  }
});
