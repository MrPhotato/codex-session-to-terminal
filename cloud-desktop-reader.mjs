import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CloudAppToolsClient } from './cloud-app-tools.mjs';
import { installedDesktopPipeHelper, verifiedDesktopTransport } from './cst-transport.mjs';

const failure = code => Object.assign(new Error(code), { code });
const pipePattern = /^codex-app-tools-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const names = { plugins: /^[a-zA-Z0-9_.@-]{1,200}$/, mcp_servers: /^[a-zA-Z0-9_-]{1,200}$/ };
const execute = promisify(execFile);

// Read table/key names only. Quoted values and comments are masked first so a
// multiline prompt containing a fake config header cannot become a capability.
// Unsupported namespace representations fail before an executor is started.
export function cloudIsolationNames(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > 1024 * 1024) throw failure('INVALID_CLOUD_CONFIG');
  let masked = '', quote = null, triple = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (char === '\\' && quote === '"') {
        masked += ' '; if (i + 1 < source.length) masked += source[++i] === '\n' ? '\n' : ' ';
      } else if (char === quote && (!triple || source.slice(i, i + 3) === quote.repeat(3))) {
        masked += ' '.repeat(triple ? 3 : 1); if (triple) i += 2; quote = null;
      } else {
        if (char === '\n' && !triple) throw failure('INVALID_CLOUD_CONFIG');
        masked += char === '\n' ? '\n' : ' ';
      }
    } else if (char === '#') {
      while (i < source.length && source[i] !== '\n') { masked += ' '; i++; }
      if (i < source.length) masked += '\n';
    } else if (char === '"' || char === "'") {
      quote = char; triple = source.slice(i, i + 3) === char.repeat(3);
      masked += ' '.repeat(triple ? 3 : 1); if (triple) i += 2;
    } else masked += char;
  }
  if (quote) throw failure('INVALID_CLOUD_CONFIG');
  const keys = input => {
    const parts = []; let rest = input.trim();
    while (rest) {
      const match = /^(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')/.exec(rest);
      if (!match) throw failure('INVALID_CLOUD_CONFIG');
      let key = match[0];
      try { if (key[0] === '"') key = JSON.parse(key); else if (key[0] === "'") key = key.slice(1, -1); }
      catch { throw failure('INVALID_CLOUD_CONFIG'); }
      parts.push(key); rest = rest.slice(match[0].length).trim();
      if (!rest) break;
      if (rest[0] !== '.' || !rest.slice(1).trim()) throw failure('INVALID_CLOUD_CONFIG');
      rest = rest.slice(1).trim();
    }
    return parts;
  };
  const found = { plugins: new Set(), mcp_servers: new Set() };
  const collect = path => {
    if (!Object.hasOwn(found, path[0])) return;
    if (path.length < 2 || !names[path[0]].test(path[1])) throw failure('UNSUPPORTED_CLOUD_CONFIG');
    found[path[0]].add(path[1]);
  };
  const original = source.split('\n'); let section = [];
  masked.split('\n').forEach((line, index) => {
    if (!line.trim()) return;
    if (line.trimStart().startsWith('[')) {
      const first = line.indexOf('['), last = line.lastIndexOf(']');
      if (last < first || line.slice(last + 1).trim() || line[first + 1] === '[') throw failure('UNSUPPORTED_CLOUD_CONFIG');
      section = keys(original[index].slice(first + 1, last));
      if (section.length > 1) collect(section);
    } else {
      const equals = line.indexOf('=');
      if (equals < 0) return; // Continuation of an unrelated array/inline value.
      const path = [...section, ...keys(original[index].slice(0, equals))];
      collect(path);
    }
  });
  return { disabledPlugins: [...found.plugins], disabledMcpServers: [...found.mcp_servers] };
}

async function boundedText(fileSystem, path, maximum) {
  const info = await fileSystem.stat(path);
  if (!info.isFile() || info.size > maximum) throw failure('INVALID_CLOUD_CONFIG');
  return fileSystem.readFile(path, 'utf8');
}

async function findPlugin(fileSystem, roots) {
  for (const home of roots) {
    const base = join(home, 'plugins', 'cache', 'openai-bundled', 'codex-app-tools');
    let versions;
    try { versions = await fileSystem.readdir(base, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') continue; throw failure('CLOUD_PLUGIN_UNAVAILABLE'); }
    versions = versions.filter(entry => entry.isDirectory() && /^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(entry.name))
      .sort((a, b) => {
        const av = a.name.split('.').map(Number), bv = b.name.split('.').map(Number);
        return bv[0] - av[0] || bv[1] - av[1] || bv[2] - av[2];
      });
    for (const version of versions) {
      const directory = join(base, version.name), entry = join(directory, 'server.mjs');
      try {
        const metadata = JSON.parse(await boundedText(fileSystem, join(directory, '.codex-plugin', 'plugin.json'), 64 * 1024));
        if (metadata.name !== 'codex-app-tools' || metadata.version !== version.name || metadata.author?.name !== 'OpenAI') continue;
        const actual = await fileSystem.realpath(entry), anchor = await fileSystem.realpath(base);
        const child = relative(anchor, actual);
        if (!child || child.startsWith(`..${sep}`) || isAbsolute(child) || !(await fileSystem.stat(actual)).isFile()) continue;
        return actual;
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw failure('CLOUD_PLUGIN_UNAVAILABLE');
      }
    }
  }
  throw failure('CLOUD_PLUGIN_UNAVAILABLE');
}

/** Product reader for the user's existing official Desktop app-tools plugin.
 * No credentials are read/copied and sends are absent. Navigation is absent
 * unless explicitly bound to one target; opening that page uses normal Desktop behavior.
 * Factories provide isolated filesystem/process seams for synthetic tests only.
 */
export async function createCloudDesktopReader(options = {}, factories = {}) {
  if (!options || Object.keys(options).some(key => !['backendPath', 'nodePath', 'powershellPath', 'cwd', 'navigateTargets'].includes(key))) {
    throw failure('INVALID_CLOUD_READER');
  }
  if (options.navigateTargets !== undefined && (!Array.isArray(options.navigateTargets) ||
      options.navigateTargets.length !== 1 || typeof options.navigateTargets[0] !== 'string' ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(options.navigateTargets[0]))) {
    throw failure('INVALID_CLOUD_READER');
  }
  // Snapshot capability before any asynchronous filesystem discovery.
  const navigateTarget = options.navigateTargets?.[0];
  for (const key of ['backendPath', 'nodePath', 'powershellPath', 'cwd']) {
    if (typeof options[key] !== 'string' || !isAbsolute(options[key]) || /[\0\r\n]/.test(options[key])) throw failure('INVALID_CLOUD_READER');
  }
  const fileSystem = factories.fileSystem ?? fs, env = factories.env ?? process.env;
  const userHome = join((factories.homedir ?? homedir)(), '.codex');
  const configHome = env.CODEX_HOME || userHome;
  if (!isAbsolute(configHome) || /[\0\r\n]/.test(configHome)) throw failure('INVALID_CLOUD_READER');
  try {
    for (const key of ['backendPath', 'nodePath', 'powershellPath', 'cwd']) {
      const info = await fileSystem.stat(options[key]);
      if (!(key === 'cwd' ? info.isDirectory() : info.isFile())) throw failure('INVALID_CLOUD_READER');
    }
  } catch { throw failure('INVALID_CLOUD_READER'); }
  const pluginPath = await findPlugin(fileSystem, [...new Set([configHome, userHome])]);
  const configs = new Set([join(configHome, 'config.toml')]);
  // The executor also loads trusted project config layers. Disable their named
  // plugins/servers as well; never retain or forward their values.
  for (let directory = resolve(options.cwd); ; directory = dirname(directory)) {
    configs.add(join(directory, '.codex', 'config.toml'));
    if (dirname(directory) === directory) break;
  }
  const plugins = new Set(), servers = new Set();
  for (const path of configs) {
    try {
      const value = cloudIsolationNames(await boundedText(fileSystem, path, 1024 * 1024));
      value.disabledPlugins.forEach(name => plugins.add(name)); value.disabledMcpServers.forEach(name => servers.add(name));
    } catch (error) {
      if (error.code !== 'ENOENT') throw failure(error.code === 'UNSUPPORTED_CLOUD_CONFIG' ? error.code : 'INVALID_CLOUD_CONFIG');
    }
  }
  const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) =>
    /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH|PATHEXT|HOME|XDG_CACHE_HOME)$/i.test(key)));
  childEnv.CODEX_HOME = configHome;
  const lifetime = new AbortController();
  const resolvePipeEndpoint = async () => {
    if (lifetime.signal.aborted) throw failure('CLIENT_CLOSED');
    const nativeHelper = (factories.findPipeHelper ?? installedDesktopPipeHelper)();
    if (nativeHelper !== null) {
      try {
        if (!isAbsolute(nativeHelper) || /[\0\r\n]/.test(nativeHelper)) throw failure('CLOUD_PIPE_UNAVAILABLE');
        const result = await (factories.execute ?? execute)(nativeHelper, ['--discover-app-tools'],
          { windowsHide: true, timeout: 10000, maxBuffer: 16384, signal: lifetime.signal });
        const value = JSON.parse(result.stdout);
        if (!value || Object.keys(value).length !== 1 || typeof value.pipeName !== 'string' || !pipePattern.test(value.pipeName) || lifetime.signal.aborted) {
          throw failure('CLOUD_PIPE_UNAVAILABLE');
        }
        // The compiled helper performs enumeration, package and same-user
        // verification together. A failed check never falls back to another path.
        return `\\\\.\\pipe\\${value.pipeName}`;
      } catch { throw failure('CLOUD_PIPE_UNAVAILABLE'); }
    }
    let result;
    try {
      result = await (factories.execute ?? execute)(options.powershellPath,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
          "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $names = @([IO.Directory]::GetFiles('\\\\.\\pipe\\') | ForEach-Object { [IO.Path]::GetFileName($_) } | Where-Object { $_ -cmatch '^codex-app-tools-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$' }); ConvertTo-Json -InputObject $names -Compress"],
        { windowsHide: true, timeout: 10000, maxBuffer: 16384, signal: lifetime.signal });
    } catch { throw failure('CLOUD_PIPE_UNAVAILABLE'); }
    let pipes;
    try { pipes = JSON.parse(result.stdout); } catch { throw failure('CLOUD_PIPE_UNAVAILABLE'); }
    if (!Array.isArray(pipes) || pipes.length !== 1 || typeof pipes[0] !== 'string' || !pipePattern.test(pipes[0])) throw failure('CLOUD_PIPE_UNAVAILABLE');
    if (lifetime.signal.aborted) throw failure('CLIENT_CLOSED');
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 12000);
    let stream;
    try {
      stream = await (factories.transportFactory ?? verifiedDesktopTransport)(options.powershellPath, { pipeName: pipes[0] })({ signal: AbortSignal.any([abort.signal, lifetime.signal]) });
      if (!stream || stream.destroyed) throw failure('CLOUD_PIPE_UNAVAILABLE');
      return `\\\\.\\pipe\\${pipes[0]}`;
    } catch { throw failure('CLOUD_PIPE_UNAVAILABLE'); }
    finally { clearTimeout(timer); stream?.destroy(); abort.abort(); }
  };
  const client = (factories.createClient ?? (settings => new CloudAppToolsClient(settings)))({
    ...options, pluginPath, env: childEnv, disabledPlugins: [...plugins], disabledMcpServers: [...servers],
    navigateTargets: navigateTarget === undefined ? undefined : [navigateTarget],
    resolvePipeEndpoint, allowSendTargets: [], endpointTimeoutMs: 30000,
  });
  return Object.freeze({
    listConversations: options => client.listConversations(options),
    readConversation: (id, options) => client.readConversation(id, options),
    ...(navigateTarget === undefined ? {} : { navigateConversation: id => {
      if (id !== navigateTarget) return Promise.reject(failure('NAVIGATION_NOT_AUTHORIZED'));
      if (lifetime.signal.aborted) return Promise.reject(failure('CLIENT_CLOSED'));
      return client.navigateConversation(id);
    } }),
    close: () => { lifetime.abort(); return client.close(); },
  });
}
