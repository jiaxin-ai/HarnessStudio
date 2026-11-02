import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile, readdir, lstat, realpath, rm, chmod } from 'node:fs/promises';
import { resolve, join, dirname, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixed = new Set(['README.md', 'Dockerfile', '.dockerignore', '.gitignore', 'package.json', 'package-lock.json', 'tsconfig.json']);
const extensions = /\.(?:ts|tsx|css|mjs|json|md|mmd|yml|svg|txt|csv)$/u;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const forbidden = new Set(['node_modules', 'deepseek-harness', '.studio', '.git', '.env', '.credentials.yaml']);

/** Node resolves module URLs but argv retains /var or directory-symlink aliases. */
export async function isDirectInvocation(moduleUrl, entry = process.argv[1]) {
  if (!entry) return false;
  try { return await realpath(resolve(entry)) === await realpath(fileURLToPath(moduleUrl)); }
  catch { return false; } // Imported under stdin/eval or another nonexistent entry.
}

export function safeRelativePath(path) {
  if (typeof path !== 'string' || !path || path.includes('\\') || path.includes('\0') || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..' || forbidden.has(part) || part.startsWith('.env'))) return false;
  return !/\.(?:pem|key|p12|pfx)$/iu.test(path);
}

/** Product source only. Reference attachments, generated builds and homes are never inputs. */
export function isReleaseSource(path) {
  if (!safeRelativePath(path)) return false;
  if (fixed.has(path)) return true;
  if (/^(?:scripts\/[^/]+\.mjs|tests\/[^/]+\.mjs|config\/(?:package\.json|[^/]+\.yml)|docs\/[^/]+\.(?:md|mmd)|prompts\/[^/]+\.md)$/u.test(path)) return true;
  if (/^plugins\/(?:studio|ui|smoke)\/(?:package\.json|src\/.+)$/u.test(path)) return extensions.test(path);
  if (path === 'apps/mock-seat/.dockerignore') return true;
  if (/^apps\/mock-seat\/(?:src\/.+|images\/.+)$/u.test(path)) return extensions.test(path) || /\/Dockerfile$/u.test(path);
  if (/^examples\/m6\/.+$/u.test(path)) return extensions.test(path);
  if (/^deploy\/release-licenses\/.+$/u.test(path)) return /(?:^|\/)(?:manifest\.json|license(?:[._-].*)?)$/iu.test(path);
  return /^(?:deploy\/(?:compose\.yml|container\.patch\.yml|build-inputs\.json|nginx\.conf\.example|release-[^/]+\.mjs))$/u.test(path);
}

const compareManifest = (a, b) => a.slice(66) < b.slice(66) ? -1 : a.slice(66) > b.slice(66) ? 1 : 0;
export function isFingerprintSource(path) {
  if (!isReleaseSource(path)) return false;
  if (path.startsWith('examples/m6/')) return true;
  if (path.startsWith('prompts/')) return true;
  return !path.startsWith('deploy/release-licenses/') && path !== 'README.md' && !path.endsWith('.md');
}
const criticalTree = path => /^(?:scripts|tests|config|docs|prompts|plugins(?:\/(?:studio|ui|smoke)(?:\/src(?:\/.*)?)?)?|apps(?:\/mock-seat(?:\/(?:src|images)(?:\/.*)?)?)?|examples(?:\/m6(?:\/.*)?)?|deploy(?:\/release-licenses(?:\/.*)?)?)$/u.test(path);
export async function sourceFingerprint(sourceRoot, files) {
  files ??= await collectReleaseSource(sourceRoot);
  const lines = [];
  for (const path of files.filter(isFingerprintSource).sort()) lines.push(`${sha(await readFile(join(sourceRoot, path)))}  ${path}`);
  return sha(lines.join('\n') + '\n');
}

async function walk(directory, visitor, prefix = '', skipExcluded = true) {
  for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) {
      const excluded = forbidden.has(item.name) || path === 'docs/references' || item.name.startsWith('.');
      if (!skipExcluded && excluded) throw new Error(`Untrusted directory in extracted source: ${path}`);
      if (!excluded) await walk(join(directory, item.name), visitor, path, skipExcluded);
    } else await visitor(path, item);
  }
}

export async function collectReleaseSource(sourceRoot) {
  const files = [];
  await walk(sourceRoot, async (path, item) => {
    if (item.isSymbolicLink() && (criticalTree(path) || isReleaseSource(path))) throw new Error(`Source tree symlinks cannot be packaged: ${path}`);
    if (!isReleaseSource(path)) return;
    if (!item.isFile() || item.isSymbolicLink()) throw new Error(`Release input must be an ordinary source file: ${path}`);
    const info = await lstat(join(sourceRoot, path));
    if (info.size > 16 * 1024 * 1024) throw new Error(`Source file exceeds the release bound: ${path}`);
    files.push(path);
  });
  return files.sort();
}

export function validateAcceptance(input) {
  if (input === undefined) return { result: 'pending', checks: [], limitations: ['linux/amd64 has not been built/run in this acceptance.', 'Real-certificate HTTPS/WSS has not had end-to-end acceptance.', 'Mock software and synthetic model fixtures do not establish engineering quality.'] };
  if (!input || input.milestone !== 'M6' || !/^[0-9a-f]{64}$/u.test(input.sourceFingerprint) || !['pending', 'passed', 'failed'].includes(input.result) || typeof input.recordedAt !== 'string' || !Number.isFinite(Date.parse(input.recordedAt)) || !Array.isArray(input.checks) || !input.checks.length || !Array.isArray(input.limitations)) throw new Error('Acceptance must be an explicit M6 result with sourceFingerprint, date, checks and limitations.');
  const text = value => typeof value === 'string' && value.length > 0 && value.length <= 2000 && !value.includes('\0');
  if (input.checks.length > 100 || input.limitations.length > 100 || input.limitations.some(value => !text(value))) throw new Error('Invalid acceptance limits.');
  const checks = input.checks.map(row => {
    if (!row || !text(row.id) || !text(row.command) || !text(row.scope) || !['passed', 'failed', 'pending'].includes(row.result)) throw new Error('Each acceptance check needs an ID, command, scope and actual result.');
    return { id: row.id, command: row.command, scope: row.scope, result: row.result };
  });
  if (input.result === 'passed' && checks.some(row => row.result !== 'passed')) throw new Error('Accepted releases cannot contain failed or pending checks.');
  return { result: input.result, sourceFingerprint: input.sourceFingerprint, recordedAt: input.recordedAt, checks, limitations: [...input.limitations] };
}

async function validateInputs(directory) {
  for (const path of ['Dockerfile', '.dockerignore', '.gitignore', 'package.json', 'package-lock.json', 'tsconfig.json', 'config/package.json', 'config/studio.patch.yml', 'scripts/start.mjs', 'scripts/build.mjs', 'scripts/prepare.mjs', 'scripts/container-build.mjs', 'scripts/container-entrypoint.mjs', 'scripts/demo-m6.mjs', 'scripts/verify-m6.mjs', 'plugins/studio/package.json', 'plugins/studio/src/index.ts', 'plugins/ui/package.json', 'plugins/ui/src/client.tsx', 'plugins/ui/src/workbench.tsx', 'plugins/ui/src/studio.css', 'plugins/smoke/package.json', 'plugins/smoke/src/index.ts', 'apps/mock-seat/src/cli.ts', 'apps/mock-seat/src/server.ts', 'deploy/compose.yml', 'deploy/container.patch.yml', 'docs/m6-release.md', 'examples/m6/demo.patch.yml', 'examples/m6/scenario.json']) {
    const info = await lstat(join(directory, path));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Required source entry is missing or linked: ${path}`);
  }
  const promptPaths = new Set();
  for (const configPath of ['config/studio.patch.yml', 'config/smoke.patch.yml', 'config/legacy-test.patch.yml', 'deploy/container.patch.yml']) {
    const config = await readFile(join(directory, configPath), 'utf8');
    if (/\/docs\/[^'"\n]*prompt[^'"\n]*\.md/iu.test(config)) throw new Error('Runtime prompts must be loaded from the dedicated prompts directory.');
    for (const match of config.matchAll(/\/prompts\/([^/'"\n]+\.md)/gu)) promptPaths.add(`prompts/${match[1]}`);
  }
  if (!promptPaths.size) throw new Error('Runtime prompt configuration is missing.');
  for (const path of promptPaths) await readFile(join(directory, path));
  const scenario = JSON.parse(await readFile(join(directory, 'examples/m6/scenario.json'), 'utf8'));
  if (!Array.isArray(scenario.tasks) || scenario.tasks.length !== 8 || !Array.isArray(scenario.files)) throw new Error('The explicit M6 example must contain its eight nodes and file declarations.');
  for (const file of scenario.files) {
    if (!safeRelativePath(file.source) || !file.source.startsWith('templates/')) throw new Error('Invalid M6 example template source.');
    const info = await lstat(join(directory, 'examples/m6', file.source));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Missing original M6 example template.');
  }
  const inputs = JSON.parse(await readFile(join(directory, 'deploy/build-inputs.json'), 'utf8'));
  if (!/^[0-9a-f]{40}$/u.test(inputs.upstreamCommit) || !/@sha256:[0-9a-f]{64}$/u.test(inputs.nodeImage) || inputs.upstreamBuild !== 'build:official') throw new Error('Release requires fixed official DSH and immutable Node build inputs.');
  const dockerfile = await readFile(join(directory, 'Dockerfile'), 'utf8');
  const prepare = await readFile(join(directory, 'scripts/prepare.mjs'), 'utf8');
  if (!dockerfile.includes(inputs.nodeImage) || !dockerfile.includes(inputs.upstreamCommit) || !prepare.includes(`upstreamCommit = '${inputs.upstreamCommit}'`)) throw new Error('Dockerfile, prepare and fixed build inputs disagree.');
  const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(directory, 'package-lock.json'), 'utf8'));
  for (const key of ['dependencies', 'devDependencies']) if (JSON.stringify(pkg[key] || {}) !== JSON.stringify(lock.packages?.['']?.[key] || {})) throw new Error('Package manifest and lockfile disagree.');
  const notices = JSON.parse(await readFile(join(directory, 'deploy/release-licenses/manifest.json'), 'utf8'));
  if (notices.upstreamCommit !== inputs.upstreamCommit) throw new Error('Official license snapshot is not from the fixed upstream commit.');
  for (const name of [...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})]) {
    const entry = notices.entries.find(row => row.name === name);
    if (!entry || entry.version !== lock.packages?.[`node_modules/${name}`]?.version || !entry.files.length) throw new Error(`License snapshot must match the locked dependency: ${name}`);
  }
  for (const entry of notices.entries) for (const path of entry.files) {
    if (!isReleaseSource(path) || !(await readFile(join(directory, path))).length) throw new Error('Missing original dependency license text.');
  }
  const catalog = JSON.parse(await readFile(join(directory, 'apps/mock-seat/images/manifest.json'), 'utf8'));
  if (catalog.apiVersion !== '1' || !Array.isArray(catalog.images) || catalog.images.length !== 3 || catalog.images.some(row => !row.imageRef.endsWith(':1.0'))) throw new Error('The explicit Mock catalog version must match the shipped 1.0 profiles.');
  return { inputs: { ...inputs, mock: { apiVersion: catalog.apiVersion, softwareVersion: '1.0', imageRefs: catalog.images.map(row => row.imageRef) } }, notices, productVersion: pkg.version };
}

export async function createSourceRelease({ sourceRoot = root, outputRoot = join(root, '.studio/releases'), acceptance, now = new Date() } = {}) {
  sourceRoot = await realpath(sourceRoot);
  const files = await collectReleaseSource(sourceRoot);
  const { inputs, notices, productVersion } = await validateInputs(sourceRoot);
  const fingerprint = await sourceFingerprint(sourceRoot, files);
  const attestation = validateAcceptance(acceptance);
  if (attestation.sourceFingerprint && attestation.sourceFingerprint !== fingerprint) throw new Error('Acceptance evidence belongs to different runnable source/config/locks/build inputs.');
  const stage = await mkdtemp(join(tmpdir(), 'harnessstudio-m6-source-'));
  const payload = join(stage, 'harnessstudio-m6');
  await mkdir(payload);
  try {
    for (const path of files) { await mkdir(dirname(join(payload, path)), { recursive: true }); await writeFile(join(payload, path), await readFile(join(sourceRoot, path)), { mode: 0o644 }); }
    if (await sourceFingerprint(payload, files) !== fingerprint || await sourceFingerprint(sourceRoot, files) !== fingerprint) throw new Error('Runnable source changed while the release snapshot was being created; retry after edits finish.');
    const notice = '# Third-party notices\n\nHarnessStudio source in this delivery has no declared license; this document does not grant a new license.\nThe separate upstream and dependency license texts below retain their original terms.\nDSH source is fetched by its fixed commit during the Linux build and is not bundled.\n\n' + notices.entries.map(row => `- ${row.name} ${row.version}: ${row.license || 'see original text'}; ${row.files.map(path => `[original text](${path})`).join(', ')}.`).join('\n') + '\n\nThis lists the fixed upstream and direct/build dependencies, plus PDF.js font/codec notices and its Node canvas dependency. The installed upstream and transitive packages retain additional notices in their own distributions.\n';
    await writeFile(join(payload, 'THIRD_PARTY_NOTICES.md'), notice);
    await writeFile(join(payload, 'QUICKSTART.md'), '# HarnessStudio M6 source delivery\n\n1. Use Node 24.21.0 and Docker with Compose.\n2. Run `node scripts/release-m6.mjs --verify . --compose`.\n3. Run `node scripts/container-secrets.mjs` and edit the private Provider secret if needed.\n4. Run `docker compose -p harnessstudio-m6 -f deploy/compose.yml up --build --detach --wait`.\n5. Open the clean page address printed at startup; browsers need no token, Cookie or sign-in. Read `docs/m6-release.md` for deployment access.\n\nDeployment, backup, restore, upgrade and rollback commands: [M6 delivery guide](docs/m6-release.md).\nThe source bundle contains no user home or original-workspace symlinks. The normal isolated demo is run from the source workspace; it is not imported into the Docker user home.\n');
    const paths = [...files, 'THIRD_PARTY_NOTICES.md', 'QUICKSTART.md'].sort();
    const hashes = [];
    for (const path of paths) hashes.push(`${sha(await readFile(join(payload, path)))}  ${path}`);
    const sourceDigest = sha(hashes.join('\n') + '\n');
    const metadata = { formatVersion: 1, product: 'HarnessStudio', productVersion, milestone: 'M6', status: attestation.result === 'passed' ? 'accepted' : 'candidate', generatedAt: now.toISOString(), sourceDigest, sourceFingerprint: fingerprint, buildInputs: inputs, acceptance: attestation };
    const serialized = JSON.stringify(metadata, null, 2) + '\n';
    await writeFile(join(payload, 'RELEASE.json'), serialized);
    hashes.push(`${sha(serialized)}  RELEASE.json`);
    const manifest = hashes.sort(compareManifest).join('\n') + '\n';
    await writeFile(join(payload, 'SHA256SUMS'), manifest);
    await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    const directory = join(outputRoot, `harnessstudio-m6-${now.toISOString().replace(/[:.]/gu, '-')}-${sourceDigest.slice(0, 12)}-${randomUUID().slice(0, 4)}`);
    await mkdir(directory, { mode: 0o700 });
    const archive = join(directory, 'source.tar.gz');
    await execute('tar', ['-czf', archive, '-C', stage, 'harnessstudio-m6'], { env: { ...process.env, COPYFILE_DISABLE: '1' }, timeout: 60000 });
    await chmod(archive, 0o600);
    await writeFile(join(directory, 'RELEASE.json'), serialized, { mode: 0o600 });
    await writeFile(join(directory, 'SHA256SUMS'), `${sha(await readFile(archive))}  source.tar.gz\n${sha(serialized)}  RELEASE.json\n`, { mode: 0o600 });
    return { directory, archive, metadata, fileCount: hashes.length };
  } finally { await rm(stage, { recursive: true, force: true }); }
}

export async function verifySourceRelease(directory, { compose = false } = {}) {
  directory = await realpath(directory);
  const content = await readFile(join(directory, 'SHA256SUMS'), 'utf8');
  const expected = new Map();
  for (const line of content.trimEnd().split('\n')) {
    const match = /^([0-9a-f]{64})  (.+)$/u.exec(line);
    if (!match || !safeRelativePath(match[2]) || (!isReleaseSource(match[2]) && !['RELEASE.json', 'QUICKSTART.md', 'THIRD_PARTY_NOTICES.md'].includes(match[2])) || expected.has(match[2])) throw new Error('Invalid or duplicate release hash entry.');
    expected.set(match[2], match[1]);
  }
  const actual = [];
  await walk(directory, async (path, item) => {
    if (!item.isFile() || item.isSymbolicLink() || !safeRelativePath(path)) throw new Error(`Untrusted entry in extracted release: ${path}`);
    actual.push(path);
    if (path === 'SHA256SUMS') return;
    if (!expected.has(path) || sha(await readFile(join(directory, path))) !== expected.get(path)) throw new Error(`Release file changed or unlisted: ${path}`);
  }, '', false);
  if (actual.length !== expected.size + 1 || [...expected.keys()].some(path => !actual.includes(path))) throw new Error('Release is missing listed files.');
  const metadata = JSON.parse(await readFile(join(directory, 'RELEASE.json'), 'utf8'));
  if (metadata.formatVersion !== 1 || metadata.milestone !== 'M6') throw new Error('Not an M6 source release.');
  validateAcceptance(metadata.acceptance.result === 'pending' && !metadata.acceptance.recordedAt ? undefined : { milestone: 'M6', ...metadata.acceptance });
  const sourceLines = [...expected.entries()].filter(([path]) => path !== 'RELEASE.json').map(([path, hash]) => `${hash}  ${path}`).sort(compareManifest);
  if (sha(sourceLines.join('\n') + '\n') !== metadata.sourceDigest) throw new Error('Source digest does not match the file manifest.');
  if (await sourceFingerprint(directory, [...expected.keys()].filter(isReleaseSource)) !== metadata.sourceFingerprint || (metadata.acceptance.sourceFingerprint && metadata.acceptance.sourceFingerprint !== metadata.sourceFingerprint) || (metadata.status === 'accepted') !== (metadata.acceptance.result === 'passed')) throw new Error('Runnable-source fingerprint and acceptance status disagree.');
  const { inputs, productVersion } = await validateInputs(directory);
  if (JSON.stringify(inputs) !== JSON.stringify(metadata.buildInputs) || productVersion !== metadata.productVersion) throw new Error('Release versions or build inputs changed.');
  if (compose) {
    const temporary = await mkdtemp(join(tmpdir(), 'harnessstudio-m6-compose-'));
    try {
      await writeFile(join(temporary, 'mock-seat-token'), 'static-only-placeholder-not-a-service-secret\n', { mode: 0o600 });
      await writeFile(join(temporary, 'provider.env'), '# Static schema check only.\n', { mode: 0o600 });
      const result = await execute('docker', ['compose', '-f', join(directory, 'deploy/compose.yml'), 'config', '--format=json'], { env: { ...process.env, STUDIO_DEPLOY_SECRETS_DIR: temporary }, timeout: 15000, maxBuffer: 1024 * 1024 });
      const config = JSON.parse(result.stdout);
      if (config.services.studio.ports[0].host_ip !== '127.0.0.1' || config.services['mock-seat'].ports || config.services.studio.image !== 'harnessstudio/studio:m6' || config.services['mock-seat'].image !== 'harnessstudio/mock-seat:m6') throw new Error('Release Compose services must use M6 images and private loopback deployment.');
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  return metadata;
}

if (await isDirectInvocation(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === '--fingerprint' && args.length === 1) console.log(await sourceFingerprint(root));
  else if (args[0] === '--verify') {
    if (!args[1] || args.slice(2).some(value => value !== '--compose')) throw new Error('Usage: --verify <extracted-directory> [--compose]');
    const metadata = await verifySourceRelease(resolve(args[1]), { compose: args.includes('--compose') });
    console.log(`M6 source files, original licenses, lockfile and fixed build inputs verified (${metadata.status}).${args.includes('--compose') ? ' Compose schema verified without starting services.' : ''}`);
  } else {
    const options = {};
    for (let index = 0; index < args.length; index += 2) {
      if (!['--output', '--evidence', '--acceptance'].includes(args[index]) || !args[index + 1]) throw new Error('Usage: [--output <directory>] [--evidence <final-evidence.json>]');
      if (args[index] === '--output') options.outputRoot = resolve(args[index + 1]);
      else options.acceptance = JSON.parse(await readFile(resolve(args[index + 1]), 'utf8'));
    }
    const result = await createSourceRelease(options);
    console.log(`M6 ${result.metadata.status} source bundle ready: ${result.archive} (${result.fileCount} hashed files). No homes, credentials, dependency installs or upstream checkout included.`);
  }
}
