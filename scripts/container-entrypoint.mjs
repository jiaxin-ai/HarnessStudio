import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir, open, lstat, chmod, chown, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const roles = new Set(['studio', 'mock-seat']);
// Kept for existing deployment tooling; this now stores a clean public URL.
export const loginFilename = 'container-login-url';

export function announcedAccessUrl(line) {
  const announced = line.match(/dsh web: (https?:\/\/[^\s)]+)/u)?.[1];
  if (!announced) return undefined;
  const url = new URL(announced);
  if (url.username || url.password) throw new Error('Startup URL must not contain credentials.');
  // Old announcements must not turn a public access file into a login secret.
  url.searchParams.delete('token');
  return url.href;
}

/** Read only bounded ordinary secret files; never interpolate their values in diagnostics. */
export async function readSecretFile(path, maximumBytes = 4096) {
  if (!path) throw new Error('A runtime secret file is required.');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maximumBytes) throw new Error('Runtime secret file is not a bounded ordinary file.');
    const bytes = await file.readFile();
    if (bytes.length > maximumBytes || bytes.includes(0)) throw new Error('Invalid runtime secret file.');
    return bytes.toString('utf8');
  } finally { await file.close(); }
}

async function privateWrite(path, content) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
  try { await rename(temporary, path); } finally { await rm(temporary, { force: true }); }
}

function validatePublicUrl(value) {
  if (!value) return;
  let url;
  try { url = new URL(value); } catch { throw new Error('STUDIO_PUBLIC_URL must be an absolute HTTP(S) root.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('STUDIO_PUBLIC_URL must be an HTTP(S) origin root without credentials, query or path prefix.');
  }
}

/** A mounted deployment home is private; services subsequently run as node (1000). */
async function prepareMount(directory, defaultDirectory) {
  const privileged = process.platform === 'linux' && process.getuid?.() === 0;
  if (privileged && directory !== defaultDirectory) throw new Error('Root bootstrap accepts only the declared container volume mount.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Container data root must be an ordinary directory.');
  await chmod(directory, 0o700);
  if (privileged) {
    // Do not recursively take ownership of an existing user's data. A volume
    // imported from another UID needs an explicit operator migration first.
    await chown(directory, 1000, 1000);
  }
  return privileged;
}

function dropPrivileges(privileged, keepRoot = false) {
  if (!privileged || keepRoot) return;
  process.setgroups([]);
  process.setgid(1000);
  process.setuid(1000);
  if (process.getuid() !== 1000 || process.getgid() !== 1000) throw new Error('Could not drop container bootstrap privileges.');
}

/** Compose secrets stay out of image/config; only the owning service child receives its token. */
export async function runContainer(role, environment = process.env) {
  if (!roles.has(role)) throw new Error('Container role must be studio or mock-seat.');
  const env = { ...environment };
  // Without software (STUDIO_SEAT_BACKEND=none) Studio talks to no software platform: no Mock credential or URL is needed.
  const noSoftware = role === 'studio' && env.STUDIO_SEAT_BACKEND === 'none';
  const tokenPath = role === 'studio' ? env.STUDIO_SEAT_TOKEN_FILE : env.STUDIO_MOCK_SEAT_TOKEN_FILE;
  const token = noSoftware ? '' : (await readSecretFile(tokenPath)).trim();
  if (!noSoftware && !/^[A-Za-z0-9_-]{40,128}$/u.test(token)) throw new Error('Invalid Mock service credential file.');
  const defaultDirectory = role === 'studio' ? '/var/lib/harnessstudio' : '/var/lib/mock-seat';
  const directory = resolve((role === 'studio' ? env.STUDIO_HOME : env.STUDIO_MOCK_SEAT_ROOT) || defaultDirectory);
  const privileged = await prepareMount(directory, defaultDirectory);
  // Read provider input while the bootstrap can read a root-owned Compose
  // secret. Keep it in the official user-env layer rather than flattening it
  // into the process environment, so Provider edits retain their precedence.
  const provider = role === 'studio' && env.STUDIO_PROVIDER_ENV_FILE ? await readSecretFile(env.STUDIO_PROVIDER_ENV_FILE, 65536) : undefined;
  if (role === 'studio') validatePublicUrl(env.STUDIO_PUBLIC_URL);
  // vm_manager task spaces are written by root (VM Samba and vm_manager). Only that deployment overlay
  // keeps Studio as root; the container's capability set still excludes CAP_LINUX_IMMUTABLE, so frozen
  // (chattr +i) task spaces stay read-only.
  const keepRoot = role === 'studio' && env.STUDIO_SERVICE_USER === 'root';
  if (env.STUDIO_SERVICE_USER !== undefined && !keepRoot && env.STUDIO_SERVICE_USER !== 'node') throw new Error('STUDIO_SERVICE_USER must be node or root (studio only).');
  delete env.STUDIO_SERVICE_USER;
  if (keepRoot) {
    // The image is owned by node; git refuses a root caller there unless this exact checkout is trusted.
    const index = Number(env.GIT_CONFIG_COUNT ?? 0);
    if (!Number.isSafeInteger(index) || index < 0) throw new Error('Invalid GIT_CONFIG_COUNT.');
    env[`GIT_CONFIG_KEY_${index}`] = 'safe.directory';
    env[`GIT_CONFIG_VALUE_${index}`] = join(root, 'deepseek-harness');
    env.GIT_CONFIG_COUNT = String(index + 1);
  }
  dropPrivileges(privileged, keepRoot);
  if (provider !== undefined) await privateWrite(join(directory, '.env'), provider);
  if (role === 'studio') {
    env.STUDIO_HOME = directory;
    env.STUDIO_MOCK_SEAT = '0';
    if (noSoftware) { delete env.STUDIO_SEAT_TOKEN; delete env.STUDIO_SEAT_URL; }
    else {
      env.STUDIO_SEAT_TOKEN = token;
      if (!env.STUDIO_SEAT_URL) throw new Error('STUDIO_SEAT_URL is required for the independent software platform.');
    }
    env.STUDIO_CONFIG_PATCH = join(root, 'deploy/container.patch.yml');
    await rm(join(directory, loginFilename), { force: true });
  } else {
    env.STUDIO_MOCK_SEAT_ROOT = directory;
    env.STUDIO_MOCK_SEAT_TOKEN = token;
  }
  // File paths are not service configuration, and the platform never needs
  // Studio's Provider-file location. No token reaches command-line arguments.
  delete env.STUDIO_PROVIDER_ENV_FILE;
  delete env.STUDIO_SEAT_TOKEN_FILE;
  delete env.STUDIO_MOCK_SEAT_TOKEN_FILE;
  const entry = role === 'studio' ? 'scripts/start.mjs' : 'apps/mock-seat/lib/cli.js';
  const child = spawn(process.execPath, [join(root, entry)], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let writes = Promise.resolve(), outputFailed = false;
  const filter = (stream, destination) => {
    const decoder = new StringDecoder('utf8');
    let pending = '';
    const emit = line => {
      writes = writes.then(async () => {
        if (outputFailed) return;
        if (role === 'studio') {
          const announced = announcedAccessUrl(line);
          if (announced) await privateWrite(join(directory, loginFilename), announced + '\n');
        }
        // Preserve redaction for legacy lines and service credentials even
        // though Studio's current browser policy announces a token-free URL.
        destination.write(line.replaceAll(token, '[redacted]').replace(/([?&]token=)[^\s)]+/gu, '$1[redacted]') + '\n');
      }).catch(() => {
        outputFailed = true;
        console.error('Container could not persist its startup access URL; stopping the service.');
        child.kill('SIGTERM');
      });
    };
    stream.on('data', chunk => {
      pending += decoder.write(chunk);
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) { emit(pending.slice(0, newline)); pending = pending.slice(newline + 1); }
      if (pending.length > 65536) { emit(pending.slice(0, 65536)); pending = pending.slice(65536); }
    });
    stream.on('end', () => { pending += decoder.end(); if (pending) emit(pending); });
  };
  filter(child.stdout, process.stdout);
  filter(child.stderr, process.stderr);
  let requestedSignal;
  const handlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => { requestedSignal ??= signal; child.kill(signal); }]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const exitCode = await new Promise((ready, reject) => { child.once('error', reject); child.once('close', (code, signal) => ready(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1))); });
  for (const [signal, handler] of handlers) process.off(signal, handler);
  await writes;
  return outputFailed ? 1 : requestedSignal ? requestedSignal === 'SIGINT' ? 130 : 143 : exitCode;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await runContainer(process.argv[2] || 'studio'); }
  catch (error) { console.error(`Container startup failed: ${error.code || error.message}`); process.exitCode = 1; }
}
