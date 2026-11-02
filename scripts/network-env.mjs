import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

const PROXY_NAMES = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']);
const BYPASS_NAMES = new Set(['NO_PROXY']);
const SYSTEM_TIMEOUT_MS = 2000;

/** Inspect names only; neither .env contents nor credentials are returned or applied. */
export function proxyKeysFromEnvFile(content) {
  return Object.keys(parseEnv(content)).filter(name => PROXY_NAMES.has(name.toUpperCase()) || BYPASS_NAMES.has(name.toUpperCase()));
}

function hasName(names, accepted) { return names.some(name => accepted.has(name.toUpperCase())); }

/** Parse only top-level manual proxy fields, ignoring PAC, SOCKS and scoped dictionaries. */
export function parseSystemProxyOutput(output) {
  if (typeof output !== 'string' || output.length > 64 * 1024 || !/^\s*<dictionary>\s*\{/.test(output)) {
    throw new Error('Unrecognized macOS proxy settings.');
  }
  const fields = {};
  const exceptions = [];
  let depth = 0;
  let inExceptions = false;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (depth === 1) {
      const match = /^(HTTPEnable|HTTPProxy|HTTPPort|HTTPSEnable|HTTPSProxy|HTTPSPort|ExcludeSimpleHostnames)\s*:\s*(.*)$/.exec(line);
      if (match) {
        if (Object.hasOwn(fields, match[1])) throw new Error('Ambiguous macOS proxy settings.');
        fields[match[1]] = match[2];
      }
      inExceptions = /^ExceptionsList\s*:\s*<array>\s*\{$/.test(line);
    } else if (depth === 2 && inExceptions) {
      const match = /^\d+\s*:\s*(.*)$/.exec(line);
      if (match) exceptions.push(match[1]);
    }
    if (line.endsWith('{')) depth++;
    if (line === '}') depth--;
    if (depth < 0) throw new Error('Unrecognized macOS proxy settings.');
  }
  if (depth !== 0) throw new Error('Incomplete macOS proxy settings.');
  return {
    http: { enabled: fields.HTTPEnable === '1', host: fields.HTTPProxy, port: fields.HTTPPort },
    https: { enabled: fields.HTTPSEnable === '1', host: fields.HTTPSProxy, port: fields.HTTPSPort },
    exceptions,
    excludeSimpleHostnames: fields.ExcludeSimpleHostnames === '1',
  };
}

/** Keep only bypass patterns supported by DSH; never expand CIDR or an arbitrary wildcard. */
export function convertProxyExceptions(exceptions = [], excludeSimpleHostnames = false) {
  const accepted = [];
  let skipped = excludeSimpleHostnames ? 1 : 0;
  for (const raw of exceptions) {
    const entry = String(raw).trim().toLowerCase();
    // DSH treats *.domain, .domain and domain as domain suffixes. CIDR and globs such as
    // 192.168.* or *internal* are not equivalent and must not become broad bypasses.
    const host = entry.replace(/^\*?\./, '').replace(/\.$/, '');
    const bracketed = /^\[([^\]]+)\](?::([1-9]\d{0,4}))?$/.exec(host);
    const domain = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?::([1-9]\d{0,4}))?$/.exec(host);
    const supported = isIP(host) !== 0 || (bracketed && isIP(bracketed[1]) === 6 && (!bracketed[2] || Number(bracketed[2]) <= 65535)) ||
      (domain && (!domain[1] || Number(domain[1]) <= 65535));
    if (entry === '*' || (host && !/[\s,/@?*\\]/.test(host) && supported)) accepted.push(entry);
    else skipped++;
  }
  return { noProxy: [...new Set(accepted)].join(','), skipped };
}

/** Credential-free, literal loopback endpoints are the only automatic proxy destinations. */
function loopbackProxy(endpoint) {
  if (!endpoint?.enabled) return undefined;
  const host = String(endpoint.host ?? '').trim();
  const port = String(endpoint.port ?? '').trim();
  if (!/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535) throw new Error('Invalid enabled macOS HTTP proxy.');
  if ((host.includes('[') || host.includes(']')) && !/^\[[^\[\]]+\]$/.test(host)) throw new Error('Invalid enabled macOS HTTP proxy.');
  const unbracketed = host.replace(/^\[|\]$/g, '');
  const ip = isIP(unbracketed);
  if (host.toLowerCase() !== 'localhost' && ip === 0) throw new Error('macOS HTTP proxy is not a literal loopback endpoint.');
  const address = new URL(`http://${ip === 6 ? `[${unbracketed}]` : host}:${port}`);
  if (address.hostname !== 'localhost' && !/^127\./.test(address.hostname) && address.hostname !== '[::1]') {
    throw new Error('macOS HTTP proxy is not a loopback endpoint.');
  }
  return address.href.replace(/\/$/, '');
}

/** Build a patch without changing the supplied environment or accepting unsafe fallback routes. */
export function systemProxyPatch(settings, { preserveNoProxy = false } = {}) {
  if (!settings.http?.enabled && !settings.https?.enabled) return { patch: {}, status: 'none', messages: [] };
  const http = loopbackProxy(settings.http);
  const https = loopbackProxy(settings.https);
  // Native DSH falls back from HTTPS to HTTP_PROXY and regards empty HTTPS_PROXY as absent.
  // It cannot represent a system HTTP-only setting without silently changing HTTPS routing.
  if (http && !https) return { patch: {}, status: 'unsupported', messages: [
    '[Studio network] HTTP-only system proxy was not imported: DSH also uses HTTP_PROXY for HTTPS. Set explicit proxy environment variables to choose the desired routing.',
  ] };
  const patch = { ...(http ? { HTTP_PROXY: http } : {}), ...(https ? { HTTPS_PROXY: https } : {}) };
  const bypass = preserveNoProxy ? { noProxy: '', skipped: 0 } : convertProxyExceptions(settings.exceptions, settings.excludeSimpleHostnames);
  if (bypass.noProxy) patch.NO_PROXY = bypass.noProxy;
  return { patch, status: 'system', messages: [
    `[Studio network] Imported enabled macOS loopback HTTP proxy for ${http ? 'HTTP and HTTPS' : 'HTTPS'}; explicit proxy configuration takes precedence.`,
    ...(bypass.skipped ? [`[Studio network] ${bypass.skipped} system bypass rule(s) were not imported because DSH does not support CIDR, arbitrary wildcards or simple-hostname rules.`] : []),
  ] };
}

/** Bounded OS query. Never pass a shell command or print scutil output on failure. */
export function readMacSystemProxy({ execute = execFile } = {}) {
  return new Promise((resolve, reject) => {
    execute('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8', timeout: SYSTEM_TIMEOUT_MS, maxBuffer: 64 * 1024 },
      (error, stdout) => error ? reject(new Error('Cannot read macOS proxy settings.')) : resolve(stdout));
  });
}

async function readHomeProxyKeys(home) {
  const file = join(home, '.env');
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > 128 * 1024) throw new Error('Unsupported Harness home environment file.');
    return proxyKeysFromEnvFile(await readFile(file, { encoding: 'utf8', signal: AbortSignal.timeout(1000) }));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error('Cannot inspect Harness home environment file.');
  }
}

/** Resolve a child-only environment; this never mutates process.env, OS settings or home/.env. */
export async function resolveNetworkEnvironment({
  env = process.env, platform = process.platform, home,
  readSystemProxy = readMacSystemProxy, readHomeKeys = readHomeProxyKeys,
} = {}) {
  const childEnv = { ...env };
  let homeNoProxy = false;
  const mode = env.STUDIO_SYSTEM_PROXY;
  if (mode !== undefined && mode !== '0' && mode !== '1') {
    throw new Error('STUDIO_SYSTEM_PROXY must be 0 (disabled) or 1 (automatic; the default).');
  }
  const result = (status, messages = []) => ({ env: childEnv, status, messages, homeNoProxy });
  if (mode === '0') return result('disabled');
  if (platform !== 'darwin') return result('unsupported-platform');
  const inheritedKeys = Object.keys(env).filter(key => env[key] !== undefined);
  if (hasName(inheritedKeys, PROXY_NAMES)) return result('explicit-env');
  let homeKeys;
  try { homeKeys = home ? await readHomeKeys(home) : []; }
  catch { return result('home-env-error', ['[Studio network] Could not inspect Harness home .env; automatic system proxy import was skipped to preserve explicit configuration.']); }
  homeNoProxy = hasName(homeKeys, BYPASS_NAMES);
  if (hasName(homeKeys, PROXY_NAMES)) return result('explicit-home');
  try {
    const settings = parseSystemProxyOutput(await readSystemProxy());
    const resolved = systemProxyPatch(settings, { preserveNoProxy: hasName([...inheritedKeys, ...homeKeys], BYPASS_NAMES) });
    Object.assign(childEnv, resolved.patch);
    return result(resolved.status, resolved.messages);
  } catch {
    return result('system-error', ['[Studio network] macOS manual HTTP proxy settings could not be safely imported. Configure HTTP_PROXY / HTTPS_PROXY explicitly when needed; web security checks remain enabled.']);
  }
}
