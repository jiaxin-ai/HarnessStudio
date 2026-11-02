import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createReadStream, createWriteStream, constants } from 'node:fs';
import { readFile, writeFile, mkdir, readdir, lstat, chmod } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSecretFile } from '../scripts/container-entrypoint.mjs';
import { isDirectInvocation } from '../scripts/release-m6.mjs';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const secretNames = ['mock-seat-token', 'provider.env'];
export function validateProjectName(name) { if (!/^[a-z0-9][a-z0-9_-]{0,62}$/u.test(name || '')) throw new Error('An explicit valid Compose project name is required.'); return name; }
export async function fileSha256(path) {
  if (!(await lstat(path)).isFile() || (await lstat(path)).isSymbolicLink()) throw new Error('Backup input must be an ordinary file.');
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path, { flags: constants.O_RDONLY | constants.O_NOFOLLOW })) hash.update(bytes);
  return hash.digest('hex');
}
async function docker(args, env = process.env) { return (await execute('docker', args, { cwd: root, env, encoding: 'utf8', timeout: 90000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim(); }
async function streamDocker(args, { input, output } = {}) {
  const child = spawn('docker', args, { cwd: root, timeout: 30 * 60 * 1000, stdio: [input ? 'pipe' : 'ignore', output ? 'pipe' : 'ignore', 'ignore'] });
  const ended = new Promise((ready, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? ready() : reject(new Error(`Backup/restore helper exited ${code}.`))); });
  const transfer = input ? pipeline(createReadStream(input, { flags: constants.O_RDONLY | constants.O_NOFOLLOW }), child.stdin) : output ? pipeline(child.stdout, createWriteStream(output, { flags: 'wx', mode: 0o600 })) : Promise.resolve();
  try { await Promise.all([ended, transfer]); } catch (error) { child.kill('SIGTERM'); await ended.catch(() => {}); throw error; }
}
function helperArguments(image, volume, readonly) {
  return ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--cap-add', 'DAC_OVERRIDE', ...(!readonly ? ['--cap-add', 'CHOWN', '--cap-add', 'FOWNER'] : []), '--mount', `type=volume,source=${volume},target=/data${readonly ? ',readonly' : ''}`, '--entrypoint', 'tar', image];
}
async function context({ project, secrets }) {
  project = validateProjectName(project);
  secrets = resolve(secrets || process.env.STUDIO_DEPLOY_SECRETS_DIR || join(root, '.studio/deploy/secrets'));
  const env = { ...process.env, STUDIO_DEPLOY_SECRETS_DIR: secrets };
  const args = ['compose', '-p', project, '-f', join(root, 'deploy/compose.yml')];
  const config = JSON.parse(await docker([...args, 'config', '--format=json'], env));
  const volumes = { studio: config.volumes['studio-data'].name, 'mock-seat': config.volumes['mock-data'].name };
  return { project, secrets, env, args, config, volumes, image: config.services.studio.image };
}
async function privateDirectory(path, { empty = false, create = false } = {}) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Backup or secret directory must be an ordinary directory.');
  if (empty && (await readdir(path)).length) throw new Error('Restore target secret directory is not empty.');
  await chmod(path, 0o700);
}

export async function backupDeployment(options) {
  const ctx = await context(options);
  const directory = resolve(options.directory);
  await mkdir(directory, { mode: 0o700 }); // Existing destinations are never overwritten.
  await privateDirectory(ctx.secrets);
  for (const volume of Object.values(ctx.volumes)) {
    const inspected = JSON.parse(await docker(['volume', 'inspect', volume]));
    if (inspected[0].Labels?.['com.docker.compose.project'] !== ctx.project) throw new Error('Volume does not belong to the explicit Compose project.');
  }
  const running = (await docker([...ctx.args, 'ps', '--status', 'running', '--services'], ctx.env)).split('\n').filter(Boolean);
  if (running.some(name => !['studio', 'mock-seat'].includes(name))) throw new Error('Unexpected service in the requested project.');
  const images = {};
  for (const role of ['studio', 'mock-seat']) {
    const id = await docker([...ctx.args, 'ps', '--all', '--quiet', role], ctx.env);
    if (!id) throw new Error('Both services must exist before a consistent backup.');
    const rows = JSON.parse(await docker(['inspect', id]));
    images[role] = { configured: rows[0].Config.Image, imageId: rows[0].Image };
  }
  let stopped = false;
  try {
    await docker([...ctx.args, 'stop', 'studio', 'mock-seat'], ctx.env); stopped = true;
    await mkdir(join(directory, 'secrets'), { mode: 0o700 });
    const hashes = {};
    for (const name of secretNames) {
      const source = join(ctx.secrets, name);
      await fileSha256(source);
      await writeFile(join(directory, 'secrets', name), await readSecretFile(source, 65536), { mode: 0o600, flag: 'wx' });
      hashes[`secrets/${name}`] = await fileSha256(join(directory, 'secrets', name));
    }
    for (const role of ['studio', 'mock-seat']) {
      const filename = `${role}-data.tar`;
      await streamDocker([...helperArguments(images.studio.imageId, ctx.volumes[role], true), '-cpf', '-', '--numeric-owner', '--exclude=./profiles/*/node_modules', '-C', '/data', '.'], { output: join(directory, filename) });
      hashes[filename] = await fileSha256(join(directory, filename));
    }
    const manifest = { formatVersion: 1, createdAt: new Date().toISOString(), sourceProject: ctx.project, images, buildInputs: JSON.parse(await readFile(join(root, 'deploy/build-inputs.json'), 'utf8')), files: hashes, excludedRebuildableLinks: ['profiles/*/node_modules'] };
    await writeFile(join(directory, 'backup.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    hashes['backup.json'] = await fileSha256(join(directory, 'backup.json'));
    await writeFile(join(directory, 'SHA256SUMS'), Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)).map(([path, hash]) => `${hash}  ${path}`).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
    return directory;
  } finally { if (stopped && running.length) await docker([...ctx.args, 'start', ...running], ctx.env); }
}

export async function restoreDeployment(options) {
  const directory = resolve(options.directory);
  await privateDirectory(directory);
  const text = await readFile(join(directory, 'SHA256SUMS'), 'utf8');
  const expected = new Set(['studio-data.tar', 'mock-seat-data.tar', 'secrets/mock-seat-token', 'secrets/provider.env', 'backup.json']);
  const seen = new Set();
  for (const line of text.trimEnd().split('\n')) {
    const match = /^([0-9a-f]{64})  (.+)$/u.exec(line);
    if (!match || !expected.has(match[2]) || seen.has(match[2]) || await fileSha256(join(directory, match[2])) !== match[1]) throw new Error('Backup hash manifest is invalid or a file changed.');
    seen.add(match[2]);
  }
  if (seen.size !== expected.size) throw new Error('Backup is incomplete.');
  const manifest = JSON.parse(await readFile(join(directory, 'backup.json'), 'utf8'));
  if (manifest.formatVersion !== 1) throw new Error('Unsupported backup format.');
  const ctx = await context(options);
  const containers = await docker(['ps', '--all', '--filter', `label=com.docker.compose.project=${ctx.project}`, '--format', '{{.ID}}']);
  if (containers) throw new Error('Restore requires a new project with no existing containers.');
  await privateDirectory(ctx.secrets, { create: true, empty: true });
  for (const [role, volume] of Object.entries(ctx.volumes)) {
    const names = (await docker(['volume', 'ls', '--format', '{{.Name}}'])).split('\n');
    const inspected = names.includes(volume) ? JSON.parse(await docker(['volume', 'inspect', volume])) : undefined;
    if (inspected && inspected[0].Labels?.['com.docker.compose.project'] !== ctx.project) throw new Error('Existing volume does not belong to the new target project.');
    if (!inspected) await docker(['volume', 'create', '--label', `com.docker.compose.project=${ctx.project}`, '--label', `com.docker.compose.volume=${role === 'studio' ? 'studio-data' : 'mock-data'}`, volume]);
    await docker(['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--cap-add', 'DAC_OVERRIDE', '--mount', `type=volume,source=${volume},target=/data,readonly`, '--entrypoint', 'node', ctx.image, '--input-type=module', '-e', "import {readdir} from 'node:fs/promises';if((await readdir('/data')).length)process.exit(2);"]);
  }
  // Only trusted backups generated above are accepted. Extraction has no
  // network, secrets or other data mount; the container root is read-only.
  for (const role of ['studio', 'mock-seat']) await streamDocker([...helperArguments(ctx.image, ctx.volumes[role], false).slice(0, 1), '--interactive', ...helperArguments(ctx.image, ctx.volumes[role], false).slice(1), '-xpf', '-', '--numeric-owner', '-C', '/data'], { input: join(directory, `${role}-data.tar`) });
  for (const name of secretNames) await writeFile(join(ctx.secrets, name), await readSecretFile(join(directory, 'secrets', name), 65536), { mode: 0o600, flag: 'wx' });
  return { project: ctx.project, images: manifest.images };
}

if (await isDirectInvocation(import.meta.url)) {
  const [action, ...args] = process.argv.slice(2), options = {};
  if (!['backup', 'restore'].includes(action)) throw new Error('Usage: backup|restore --project <name> --directory <path> [--secrets <path>]');
  for (let index = 0; index < args.length; index += 2) {
    if (!['--project', '--directory', '--secrets'].includes(args[index]) || !args[index + 1]) throw new Error('Invalid backup/restore argument.');
    options[args[index].slice(2)] = args[index + 1];
  }
  if (!options.directory) throw new Error('An explicit backup directory is required.');
  validateProjectName(options.project);
  if (action === 'backup') console.log(`Consistent two-volume and secret backup ready: ${await backupDeployment(options)}. Keep it private; original running services were resumed.`);
  else { const result = await restoreDeployment(options); console.log(`Backup restored to new empty project ${result.project}; services have not been started. Use the documented matching image versions.`); }
}
