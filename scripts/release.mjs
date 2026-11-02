// The install package sent to other people: Studio source, the harnessstudio command, the batch client, an install
// guide and licenses. Never vm_manager, VM disk images, secrets, user data, dependencies or the upstream checkout.
// Its receivers only have Docker and bash, so everything they need to check it works with sha256sum.
// See docs/release.md.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir, networkInterfaces, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isDirectInvocation } from './release-m6.mjs';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const byBytes = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** Files every package needs; without them it cannot build or start. */
const requiredFiles = ['Dockerfile', '.dockerignore', 'package.json', 'package-lock.json', 'tsconfig.json', 'deploy/build-inputs.json', 'deploy/release-licenses/manifest.json', 'docs/安装说明.md'];
/** Files from the deploy command and the batch client. A package without them is only a draft (--allow-incomplete). */
const commandFiles = ['bin/harnessstudio', 'cli/package.json', 'examples/tasks.yaml'];
/** Reference docs a receiver can use. Everything else in docs/ is history or development material. */
// docs/vm-manager-seat.md stays out: it records this team's own deployment.
const publicDocs = new Set(['docs/autonomy.md', 'docs/sandbox.md', 'docs/no-software.md', 'docs/deploy-cli.md', 'docs/batch-run.md']);
/** Guides for people who use Studio live in the workspace next to this repository, one per feature, by this name. */
export const isGuideName = name => /^[^/]+使用说明\.md$/u.test(name);
const generatedNames = new Set(['RELEASE.json', 'SHA256SUMS', 'THIRD_PARTY_NOTICES.md', '安装说明.md']);

const deniedDirectories = new Set(['node_modules', 'deepseek-harness', '.studio', '.git', '.pnpm-store', 'vm_manager', 'secrets', 'coverage', 'tmp']);
const generatedDirectory = /^(?:plugins\/[^/]+|apps\/[^/]+|cli)\/(?:lib|dist)$/u;
const junkFile = /(?:^|\/)(?:\.DS_Store|[^/]+\.log|[^/]+\.tsbuildinfo)$/u;

/** A file that holds credentials by its name alone. Names like token-usage.ts stay allowed. */
export function isCredentialName(path) {
  const name = path.split('/').at(-1).toLowerCase();
  return name === '.env' || name.startsWith('.env.') || name === 'provider.env' || name === 'id_rsa' || name === 'id_ed25519' || name === 'id_ecdsa'
    || name.includes('credentials') || name === 'token' || /[-_.]token$/u.test(name) || /\.(?:pem|key|p12|pfx|kdbx)$/u.test(name);
}
export const isDiskImage = path => /\.(?:qcow2?|img|iso|vhdx?|vmdk|vdi|ova|raw)$/iu.test(path);

/** Whether a path belongs in the package. Paths are relative with '/' and were not filtered by a caller. */
export function isPackaged(path) {
  const parts = path.split('/');
  if (parts.some(part => deniedDirectories.has(part)) || junkFile.test(path)) return false;
  if (parts.some((_, index) => generatedDirectory.test(parts.slice(0, index + 1).join('/')))) return false;
  if (['Dockerfile', '.dockerignore', 'package.json', 'package-lock.json', 'tsconfig.json'].includes(path)) return true;
  if (publicDocs.has(path) || path === 'docs/安装说明.md') return true;
  if (/^(?:bin|cli|scripts|config|prompts|deploy|plugins)\//u.test(path)) return true;
  if (/^apps\/[^/]+\/src\//u.test(path)) return true;
  return path.startsWith('examples/') && !path.startsWith('examples/m6/');
}

/** Directories worth walking; skipping them keeps a checkout's big generated trees out of the walk. */
function walkable(path) {
  const parts = path.split('/');
  if (parts.some(part => deniedDirectories.has(part)) || generatedDirectory.test(path)) return false;
  if (parts.length === 1) return ['bin', 'cli', 'scripts', 'config', 'prompts', 'deploy', 'plugins', 'apps', 'examples', 'docs'].includes(path);
  if (parts[0] === 'docs') return false;
  if (path === 'examples/m6') return false;
  return parts[0] !== 'apps' || parts.length === 2 || parts[2] === 'src';
}

async function walk(directory, visit, prefix = '') {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) { if (walkable(path)) await walk(join(directory, item.name), visit, path); }
    else await visit(path, item);
  }
}

/** Every file the package takes from a source tree. A link in a packaged place stops the release: it could point anywhere. */
export async function collectPackageFiles(sourceRoot) {
  const files = [];
  await walk(sourceRoot, async (path, item) => {
    if (!isPackaged(path)) return;
    if (item.isSymbolicLink()) throw new Error(`安装包里不能有软链接：${path}`);
    if (!item.isFile()) throw new Error(`安装包只能包含普通文件：${path}`);
    files.push(path);
  });
  return files.sort(byBytes);
}

const versionInputs = path => ['Dockerfile', 'deploy/build-inputs.json', 'package.json', 'package-lock.json', 'tsconfig.json'].includes(path)
  || /^(?:scripts|config|plugins|prompts|deploy|cli)\//u.test(path) || /^apps\/[^/]+\/src\//u.test(path);

/**
 * Source version of design section 5: the first 12 hex digits of the SHA-256 of `sha256sum`-style lines, one per build
 * input, in byte order of their paths. No git, because a package has none. bin/harnessstudio computes the version the
 * images are tagged with; docs and the install guide stay out so that editing them does not ask for a redeployment.
 */
export async function sourceVersion(sourceRoot, files) {
  files ??= await collectPackageFiles(sourceRoot);
  const lines = [];
  for (const path of files.filter(versionInputs).sort(byBytes)) lines.push(`${sha(await readFile(join(sourceRoot, path)))}  ${path}\n`);
  return sha(lines.join('')).slice(0, 12);
}

const keyShapes = [
  ['私钥', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/u],
  ['API Key', /\b(?:sk-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[baprs]-[A-Za-z0-9-]{20,}|AIza[0-9A-Za-z_-]{30,})\b/u],
];

/** Long key-like words of a secret file: enough to recognise a real value that leaked into a source file. */
function secretWords(text) {
  return [...new Set(text.match(/[A-Za-z0-9_-]{24,}/gu) ?? [])].filter(word => /[0-9]/u.test(word) && /[A-Za-z]/u.test(word));
}

/** This machine's real secrets, held only in memory, so that the check below catches them in any shape of file. */
async function localSecrets(sourceRoot) {
  const words = new Set();
  const read = async path => { try { for (const word of secretWords(await readFile(path, 'utf8'))) words.add(word); } catch { /* Not on this machine. */ } };
  for (const directory of [join(sourceRoot, '.studio/deploy/secrets'), process.env.STUDIO_DEPLOY_SECRETS_DIR].filter(Boolean)) {
    let names = [];
    try { names = await readdir(directory); } catch { /* Not on this machine. */ }
    for (const name of names) await read(join(directory, name));
  }
  await read(join(sourceRoot, '.studio/home/.credentials.yaml'));
  await read(join(sourceRoot, '.studio/home/.env'));
  return [...words];
}

/** Stop on credentials, disk images and oversized files. Messages name the file, never a value. */
export async function assertSafeContents(directory, files, secrets = []) {
  const problems = [];
  let total = 0;
  for (const path of files) {
    if (isCredentialName(path)) { problems.push(`${path}：文件名像密钥或凭据`); continue; }
    if (isDiskImage(path)) { problems.push(`${path}：是磁盘镜像`); continue; }
    const info = await lstat(join(directory, path));
    if (info.isSymbolicLink() || !info.isFile()) { problems.push(`${path}：不是普通文件`); continue; }
    if (info.size > 16 * 1024 * 1024) { problems.push(`${path}：超过 16 MB`); continue; }
    total += info.size;
    const text = (await readFile(join(directory, path))).toString('latin1');
    // Licenses and lockfiles carry no key material, but a key among them is still a key: nothing is exempt.
    for (const [label, shape] of keyShapes) if (shape.test(text)) problems.push(`${path}：内容里有疑似${label}`);
    if (secrets.some(value => text.includes(value))) problems.push(`${path}：内容里有这台机器上的真实密钥`);
  }
  if (total > 128 * 1024 * 1024) problems.push(`安装包内容超过 128 MB（${Math.round(total / 1048576)} MB），不像只有源码`);
  if (problems.length) throw new Error(`安装包检查没有通过，没有生成：\n${problems.map(row => `- ${row}`).join('\n')}`);
}

// Top-level folders every Linux or macOS machine has: their paths say nothing about this one.
const standardRoots = new Set(['bin', 'boot', 'cdrom', 'dev', 'etc', 'home', 'lib', 'lib32', 'lib64', 'libx32', 'lost+found', 'opt', 'proc', 'root', 'run', 'sbin', 'snap', 'srv', 'sys', 'tmp', 'usr', 'var', 'swapfile', 'swap.img', 'private', 'Applications', 'Library', 'System', 'Users', 'Volumes', 'cores', 'nix']);

/**
 * What only this machine has, read from the machine itself: its LAN addresses (not Docker's bridges), the folders under
 * its own top-level folders and mount points (like /data/<disk>), the home folder and the folder this checkout sits in.
 * A package that names them was written for this deployment, not for other people.
 */
export async function localMarkers(sourceRoot) {
  const markers = new Set();
  for (const [name, rows] of Object.entries(networkInterfaces())) {
    if (/^(?:docker|br-|veth|virbr)/u.test(name)) continue;
    for (const row of rows ?? []) if (row.family === 'IPv4' && !row.internal && !row.address.startsWith('169.254.')) markers.add(row.address);
  }
  for (const top of await readdir('/').catch(() => [])) {
    if (standardRoots.has(top) && !['mnt', 'media'].includes(top)) continue;
    for (const item of await readdir(`/${top}`, { withFileTypes: true }).catch(() => [])) if (item.isDirectory() && item.name !== 'tmp' && !item.name.startsWith('.')) markers.add(`/${top}/${item.name}`);
  }
  for (const top of ['mnt', 'media']) for (const item of await readdir(`/${top}`, { withFileTypes: true }).catch(() => [])) if (item.isDirectory()) markers.add(`/${top}/${item.name}`);
  if (/^\/(?:home|Users)\/[^/]+$/u.test(homedir())) markers.add(homedir());
  if (dirname(sourceRoot) !== '/') markers.add(dirname(sourceRoot));
  return [...markers];
}

/** Files naming any marker, with what they name. An address or path only counts as itself, not inside a longer one. */
export async function findLocalReferences(directory, files, markers) {
  const escape = value => value.replace(/[.*+?^$()|[\]\\{}]/gu, '\\$&');
  // 10.1.2.3 is not inside 110.1.2.34; /data/<disk> is found after ":-" in compose defaults but not inside /data/<disk>-old.
  const shapes = markers.map(marker => [marker, /^\d+\.\d+\.\d+\.\d+$/u.test(marker)
    ? new RegExp(`(?<![\\d.])${escape(marker)}(?!\\d|\\.\\d)`, 'u')
    : new RegExp(`(?<![\\w.])${escape(marker)}(?![\\w-]|\\.\\w)`, 'u')]);
  const found = [];
  for (const path of files) {
    const text = await readFile(join(directory, path), 'utf8');
    const hits = shapes.filter(([, shape]) => shape.test(text)).map(([marker]) => marker);
    if (hits.length) found.push({ file: path, found: hits });
  }
  return found;
}

/** Every dependency we name must come with its original license text, at the locked version. */
async function licenseNotices(sourceRoot) {
  const notices = JSON.parse(await readFile(join(sourceRoot, 'deploy/release-licenses/manifest.json'), 'utf8'));
  const inputs = JSON.parse(await readFile(join(sourceRoot, 'deploy/build-inputs.json'), 'utf8'));
  if (notices.upstreamCommit !== inputs.upstreamCommit) throw new Error('第三方许可的 DSH 版本与 deploy/build-inputs.json 不一致。');
  const manifests = [['package.json', 'package-lock.json']];
  try { await lstat(join(sourceRoot, 'cli/package.json')); manifests.push(['cli/package.json', 'cli/package-lock.json']); } catch { /* No batch client yet. */ }
  for (const [manifest, lockfile] of manifests) {
    const pkg = JSON.parse(await readFile(join(sourceRoot, manifest), 'utf8')), lock = JSON.parse(await readFile(join(sourceRoot, lockfile), 'utf8'));
    for (const name of [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]) {
      const entry = notices.entries.find(row => row.name === name);
      if (!entry || entry.version !== lock.packages?.[`node_modules/${name}`]?.version || !entry.files?.length) throw new Error(`deploy/release-licenses 缺少依赖 ${name} 当前锁定版本的许可原文（${manifest}）。`);
    }
  }
  for (const entry of notices.entries) for (const path of entry.files) if (!(await readFile(join(sourceRoot, path))).length) throw new Error(`许可原文是空的：${path}`);
  return `# 第三方许可\n\nHarnessStudio 本身没有声明开源许可；本文件不授予新的许可。下面的上游和依赖保留各自原来的条款。DeepSeek Harness 的源码不在安装包里，构建时按固定的 commit 下载。\n\n${notices.entries.map(row => `- ${row.name} ${row.version}：${row.license || '见原文'}；${row.files.map(path => `[原文](${path})`).join('，')}`).join('\n')}\n\n这里列出固定的上游和直接依赖，以及 PDF.js 的字体和解码器声明。安装在镜像里的间接依赖的声明保留在它们各自的发行包里。\n`;
}

/** Uncommitted work must not reach other people unnoticed, and ignored files must not ride along. No repository: no check. */
async function gitIdentity(sourceRoot, files, allowDirty) {
  const git = args => execute('git', args, { cwd: sourceRoot, maxBuffer: 64 * 1024 * 1024 }).then(row => row.stdout.trim());
  let top;
  try { top = await realpath(await git(['rev-parse', '--show-toplevel'])); } catch { return null; }
  if (top !== sourceRoot) return null;
  const roots = [...new Set(files.map(path => path.split('/')[0]))];
  // Only changes to packaged paths count, including deleted files; work elsewhere in the checkout does not block.
  // Untrimmed: each entry starts with a two-letter status that may begin with a space.
  const status = (await execute('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...roots], { cwd: sourceRoot, maxBuffer: 64 * 1024 * 1024 })).stdout;
  const dirty = status.split('\0').filter(Boolean).map(row => row.slice(3)).some(isPackaged);
  if (dirty && !allowDirty) throw new Error('源码有未提交的改动，不能发给别人。先提交；只是试打包时加 --allow-dirty。');
  if (!dirty) {
    const tracked = new Set((await git(['ls-files', '-z', '--', ...roots])).split('\0'));
    const untracked = files.filter(path => !tracked.has(path));
    if (untracked.length) throw new Error(`这些文件没有进 git，却会被打进安装包：\n${untracked.map(path => `- ${path}`).join('\n')}`);
  }
  return { commit: await git(['rev-parse', 'HEAD']), dirty };
}

/** Exact file modes matter: bin/harnessstudio must run right after unpacking. */
async function copyInto(sourceRoot, payload, path, target = path) {
  const mode = (await lstat(join(sourceRoot, path))).mode & 0o111 || path.startsWith('bin/') ? 0o755 : 0o644;
  await mkdir(dirname(join(payload, target)), { recursive: true });
  await writeFile(join(payload, target), await readFile(join(sourceRoot, path)));
  await chmod(join(payload, target), mode); // writeFile's mode is filtered by the umask and ignored for existing files.
}

async function listPayload(directory, prefix = '') {
  const files = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) files.push(...await listPayload(join(directory, item.name), path));
    else if (item.isFile()) files.push(path);
    else throw new Error(`安装包里有不是普通文件的条目：${path}`);
  }
  return files.sort(byBytes);
}

/**
 * Build the package. `guides` is the folder holding the user guides, by default the workspace around this repository:
 * every `*使用说明.md` there goes in, so a new guide needs no change here. `markers` replaces what localMarkers() finds,
 * for tests. A draft (allowIncomplete or allowDirty) only warns about local references; a real package refuses them.
 */
export async function createRelease({ sourceRoot = root, outputRoot, guides, allowIncomplete = false, allowDirty = false, markers, now = new Date() } = {}) {
  sourceRoot = await realpath(sourceRoot);
  outputRoot = resolve(outputRoot ?? join(sourceRoot, '.studio/releases'));
  guides = resolve(guides ?? join(sourceRoot, '..'));
  for (const path of requiredFiles) await lstat(join(sourceRoot, path)).catch(() => { throw new Error(`缺少安装包必需的文件：${path}`); });
  const incomplete = [];
  for (const path of commandFiles) await lstat(join(sourceRoot, path)).catch(() => incomplete.push(path));
  if (incomplete.length && !allowIncomplete) throw new Error(`缺少部署命令或批量命令的文件，安装包还不能用：${incomplete.join('、')}。只是试打包时加 --allow-incomplete。`);
  const files = await collectPackageFiles(sourceRoot);
  const git = await gitIdentity(sourceRoot, files, allowDirty);
  const notices = await licenseNotices(sourceRoot);
  const version = await sourceVersion(sourceRoot, files);
  const name = `harnessstudio-${version}`;
  const archive = join(outputRoot, `${name}.tar.gz`), checksum = `${archive}.sha256`;
  if (await lstat(archive).then(() => true, () => false)) throw new Error(`已经有这个版本的安装包：${archive}。文档改动不会改变版本，要重新生成就先删掉它。`);

  const stage = await mkdtemp(join(tmpdir(), 'harnessstudio-release-'));
  const payload = join(stage, name);
  await mkdir(payload);
  try {
    for (const path of files) await copyInto(sourceRoot, payload, path);
    await copyInto(sourceRoot, payload, 'docs/安装说明.md', '安装说明.md');
    await rm(join(payload, 'docs/安装说明.md'));
    await writeFile(join(payload, 'THIRD_PARTY_NOTICES.md'), notices, { mode: 0o644 });
    const guideFiles = [];
    for (const item of await readdir(guides, { withFileTypes: true }).catch(() => [])) if (item.isFile() && isGuideName(item.name)) guideFiles.push(item.name);
    guideFiles.sort(byBytes);
    for (const guide of guideFiles) await copyInto(guides, payload, guide, `使用说明/${guide}`);
    // The install guide sends readers to some guides by name; a package without them would send them nowhere.
    const named = [...new Set((await readFile(join(payload, '安装说明.md'), 'utf8')).match(/[^\s`/（《「]+使用说明\.md/gu) ?? [])];
    const missing = named.filter(guide => !guideFiles.includes(guide));
    if (missing.length) throw new Error(`安装说明提到的使用说明在 ${guides} 里找不到：${missing.join('、')}。用 --guides 指定放使用说明的文件夹。`);
    const brokenExamples = await missingExampleInputs(payload);
    if (brokenExamples.length) throw new Error(`示例清单引用的输入文件不在安装包里：\n${brokenExamples.map(row => `- ${row}`).join('\n')}\n把文件放进 examples/ 下（通常是 examples/inputs/），或者改清单里的 files。`);
    if (await sourceVersion(payload) !== version) throw new Error('源码在打包过程中变了，请等改动结束后重试。');
    const packaged = await listPayload(payload);
    await assertSafeContents(payload, packaged, await localSecrets(sourceRoot));
    const local = await findLocalReferences(payload, packaged, markers ?? await localMarkers(sourceRoot));
    if (local.length && !allowIncomplete && !allowDirty) throw new Error(`安装包里有这台机器的局域网地址或本机路径，不能发给别人：\n${local.map(row => `- ${row.file}：${row.found.join('、')}`).join('\n')}\n改成通用写法（例如 http://<服务器地址>:端口）后重试；只是试打包时加 --allow-incomplete 或 --allow-dirty，这些会作为警告列出。`);

    const lines = [];
    for (const path of packaged) lines.push(`${sha(await readFile(join(payload, path)))}  ${path}`);
    const metadata = { formatVersion: 1, product: 'HarnessStudio', version, productVersion: JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8')).version, generatedAt: now.toISOString(), source: git, buildInputs: JSON.parse(await readFile(join(sourceRoot, 'deploy/build-inputs.json'), 'utf8')), incomplete, guides: guideFiles, localReferences: local };
    const serialized = `${JSON.stringify(metadata, null, 2)}\n`;
    await writeFile(join(payload, 'RELEASE.json'), serialized, { mode: 0o644 });
    lines.push(`${sha(serialized)}  RELEASE.json`);
    await writeFile(join(payload, 'SHA256SUMS'), `${lines.sort((a, b) => byBytes(a.slice(66), b.slice(66))).join('\n')}\n`, { mode: 0o644 });

    await mkdir(outputRoot, { recursive: true });
    const partial = `${archive}.partial-${process.pid}`;
    await execute('tar', ['--sort=name', '--owner=0', '--group=0', '--numeric-owner', '-czf', partial, '-C', stage, name], { timeout: 300_000 });
    await inspectArchive(partial, name);
    const bytes = await readFile(partial);
    await rename(partial, archive);
    await writeFile(checksum, `${sha(bytes)}  ${name}.tar.gz\n`, { mode: 0o644 });
    return { archive, checksum, metadata, fileCount: lines.length, bytes: bytes.length };
  } finally { await rm(stage, { recursive: true, force: true }); await rm(`${archive}.partial-${process.pid}`, { force: true }); }
}

/**
 * Input files the example manifests name, as `files: [a, b]` or a `files:` block list, that the package lacks or that
 * point outside examples/. Receivers run the examples as shipped; one missing input fails the whole batch check.
 * Only the two YAML shapes the examples use are read: this guards our own examples, it does not validate manifests.
 */
export async function missingExampleInputs(payload) {
  const problems = [];
  const manifests = (await listPayload(join(payload, 'examples')).catch(() => [])).filter(path => /\.ya?ml$/u.test(path));
  for (const manifest of manifests) {
    const lines = (await readFile(join(payload, 'examples', manifest), 'utf8')).split('\n').map(line => line.replace(/\s+#.*$|^\s*#.*$/u, ''));
    const named = [];
    for (let index = 0; index < lines.length; index += 1) {
      const inline = /^\s*(?:-\s+)?files:\s*\[(.*)\]\s*$/u.exec(lines[index]);
      if (inline) named.push(...inline[1].split(',').map(value => value.trim()).filter(Boolean));
      else if (/^\s*(?:-\s+)?files:\s*$/u.test(lines[index])) {
        for (index += 1; index < lines.length && /^\s*-\s+\S/u.test(lines[index]); index += 1) named.push(lines[index].replace(/^\s*-\s+/u, '').trim());
        index -= 1; // The line that ended the list is read again by the outer loop.
      }
    }
    for (const value of named.map(row => row.replace(/^(['"])(.*)\1$/u, '$2'))) {
      const path = join(dirname(join('examples', manifest)), value).replaceAll('\\', '/');
      if (!path.startsWith('examples/') || !(await lstat(join(payload, path)).then(info => info.isFile(), () => false))) problems.push(`examples/${manifest}：${value}`);
    }
  }
  return problems;
}

/** What actually went into the archive, read back from it: one top folder, ordinary files, no denied place. */
export async function inspectArchive(archive, name) {
  const listed = (await execute('tar', ['-tvzf', archive], { maxBuffer: 64 * 1024 * 1024, timeout: 120_000, env: { ...process.env, LC_ALL: 'C' } })).stdout.trimEnd().split('\n');
  const names = (await execute('tar', ['-tzf', archive], { maxBuffer: 64 * 1024 * 1024, timeout: 120_000 })).stdout.trimEnd().split('\n');
  if (listed.length !== names.length || listed.some(line => !['-', 'd'].includes(line[0]))) throw new Error('安装包里有软链接或特殊文件。');
  for (const path of names) {
    const parts = path.replace(/\/$/u, '').split('/');
    if (parts[0] !== name || path.startsWith('/') || parts.includes('..') || parts.some(part => deniedDirectories.has(part))) throw new Error(`安装包里有不该有的路径：${path}`);
    if (!path.endsWith('/') && (isCredentialName(path) || isDiskImage(path))) throw new Error(`安装包里有不该有的文件：${path}`);
  }
  return names;
}

/** The maintainer's check of an unpacked package; receivers use sha256sum, which needs no Node. */
export async function verifyRelease(directory) {
  directory = await realpath(directory);
  const expected = new Map();
  for (const line of (await readFile(join(directory, 'SHA256SUMS'), 'utf8')).trimEnd().split('\n')) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/u.exec(line);
    if (!match || expected.has(match[2])) throw new Error('SHA256SUMS 的格式不对或有重复。');
    expected.set(match[2], match[1]);
  }
  const actual = await listPayload(directory);
  for (const path of actual) {
    if (path === 'SHA256SUMS') continue;
    if (!expected.has(path)) throw new Error(`安装包里多了清单上没有的文件：${path}`);
    if (sha(await readFile(join(directory, path))) !== expected.get(path)) throw new Error(`文件被改动过：${path}`);
  }
  for (const path of expected.keys()) if (!actual.includes(path)) throw new Error(`清单上的文件缺失：${path}`);
  await assertSafeContents(directory, actual);
  const metadata = JSON.parse(await readFile(join(directory, 'RELEASE.json'), 'utf8'));
  if (metadata.formatVersion !== 1 || metadata.product !== 'HarnessStudio') throw new Error('这不是 HarnessStudio 的安装包。');
  if (await sourceVersion(directory) !== metadata.version) throw new Error('源码版本和 RELEASE.json 不一致。');
  for (const name of generatedNames) if (!actual.includes(name)) throw new Error(`安装包缺少 ${name}。`);
  return metadata;
}

if (await isDirectInvocation(import.meta.url)) {
  const args = process.argv.slice(2), usage = '用法：node scripts/release.mjs [--output 目录] [--guides 目录] [--allow-incomplete] [--allow-dirty]；或 --version；或 --verify 解压后的目录';
  if (args[0] === '--version' && args.length === 1) console.log(await sourceVersion(root));
  else if (args[0] === '--verify') {
    if (args.length !== 2) throw new Error(usage);
    const metadata = await verifyRelease(resolve(args[1]));
    console.log(`安装包校验通过：版本 ${metadata.version}。${metadata.incomplete.length ? `注意：这是试打包，缺少 ${metadata.incomplete.join('、')}。` : ''}`);
  } else {
    const options = {};
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === '--allow-incomplete') options.allowIncomplete = true;
      else if (args[index] === '--allow-dirty') options.allowDirty = true;
      else if (['--output', '--guides'].includes(args[index]) && args[index + 1]) options[args[index] === '--output' ? 'outputRoot' : 'guides'] = args[++index];
      else throw new Error(usage);
    }
    const result = await createRelease(options);
    console.log(`安装包已生成：${result.archive}\n校验清单：${result.checksum}\n版本 ${result.metadata.version}，${result.fileCount} 个文件，${(result.bytes / 1048576).toFixed(1)} MB。`);
    for (const row of [result.metadata.incomplete.length && `这是试打包，不能发给别人：缺少 ${result.metadata.incomplete.join('、')}`, result.metadata.source?.dirty && '源码有未提交的改动，不能发给别人', !result.metadata.guides.length && '没有找到任何使用说明', result.metadata.localReferences.length && `这些文件里有这台机器的局域网地址或本机路径，正式打包时会被拒绝：\n${result.metadata.localReferences.map(row => `  - ${row.file}：${row.found.join('、')}`).join('\n')}`]) if (row) console.log(`注意：${row}`);
  }
}
