import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { collectReleaseSource, createSourceRelease, isDirectInvocation, verifySourceRelease } from './release-m6.mjs';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const expectedArtifacts = ['RESTART_PROMPT.md', 'SOURCE_RELEASE.json', 'references.tar.gz', 'repository.bundle', 'source.tar.gz'];
const expectedTopLevel = [...expectedArtifacts, 'HANDOFF.json', 'SHA256SUMS'].sort();
const allowedReferenceExtension = /\.(?:gif|jpe?g|md|mmd|pdf|png|svg|txt|webp)$/iu;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const forbiddenComponents = new Set(['.git', '.pnpm-store', '.studio', 'deepseek-harness', 'node_modules']);

function assertSafeGitPath(path) {
  const parts = path.split('/');
  const name = parts.at(-1)?.toLowerCase() || '';
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0') || parts.some(part => !part || part === '.' || part === '..' || forbiddenComponents.has(part))) throw new Error(`Forbidden path in release history: ${path}`);
  if (name === '.env' || name.startsWith('.env.') || ['.credentials.yaml', 'credentials.yaml', 'provider.env', 'mock-seat-token', 'id_rsa', 'id_ed25519'].includes(name) || /\.(?:key|p12|pem|pfx)$/iu.test(name) || parts.some(part => part.toLowerCase() === 'secrets')) throw new Error(`Credential-like path in release history: ${path}`);
  return path;
}

export function isSafeReferencePath(path) {
  try { assertSafeGitPath(path); }
  catch { return false; }
  return path.startsWith('docs/references/') && allowedReferenceExtension.test(path);
}

function gitOptions(cwd, extra = {}) {
  return { cwd, timeout: 120_000, maxBuffer: 64 * 1024 * 1024, ...extra };
}

async function git(cwd, args, extra) {
  return execute('git', args, gitOptions(cwd, extra));
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) throw new Error(`Invalid ${label} fields.`);
}

async function fileRecord(path, purpose) {
  const bytes = await readFile(path);
  return { path: basename(path), sha256: sha256(bytes), bytes: bytes.length, purpose };
}

async function assertCleanCommittedSource(sourceRoot, ref) {
  const repositoryRoot = await realpath((await git(sourceRoot, ['rev-parse', '--show-toplevel'])).stdout.trim());
  if (repositoryRoot !== sourceRoot) throw new Error('The handoff source must be the Git worktree root.');
  if ((await git(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=no'])).stdout.length) throw new Error('Refusing to release a dirty Git worktree; commit or remove every tracked/untracked change first.');
  if (typeof ref !== 'string' || !ref || ref.startsWith('-') || /[\0-\x20~^:?*[\\]/u.test(ref)) throw new Error('A safe named Git ref or tag is required.');
  const canonicalRef = (await git(sourceRoot, ['rev-parse', '--symbolic-full-name', '--verify', ref])).stdout.trim();
  if (!/^refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+$/u.test(canonicalRef)) throw new Error('The release ref must be a named branch or tag (HEAD is allowed on a branch).');
  const commit = (await git(sourceRoot, ['rev-parse', '--verify', `${canonicalRef}^{commit}`])).stdout.trim();
  const head = (await git(sourceRoot, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim();
  if (commit !== head) throw new Error('The selected release ref must point at the checked-out HEAD commit.');
  const headRef = (await git(sourceRoot, ['symbolic-ref', '--quiet', 'HEAD'])).stdout.trim();
  if (!/^refs\/heads\/[A-Za-z0-9._/-]+$/u.test(headRef)) throw new Error('The handoff must be created from a checked-out branch, not detached HEAD.');
  const bundleRefs = [...new Set([headRef, canonicalRef])].sort();

  const historyNames = (await git(sourceRoot, ['log', '--format=', '--name-only', '-z', canonicalRef, '--'])).stdout.split('\0').filter(Boolean);
  for (const path of historyNames) assertSafeGitPath(path);

  const sourceFiles = await collectReleaseSource(sourceRoot);
  await git(sourceRoot, ['ls-files', '--error-unmatch', '--', ...sourceFiles]);
  await git(sourceRoot, ['diff', '--quiet', commit, '--', ...sourceFiles]);
  return { canonicalRef, headRef, bundleRefs, commit, sourceFiles };
}

async function committedReferences(sourceRoot, commit) {
  const output = (await git(sourceRoot, ['ls-tree', '-r', '-z', '-l', commit, '--', 'docs/references'])).stdout;
  const records = [];
  for (const entry of output.split('\0').filter(Boolean)) {
    const match = /^(\d+) blob ([0-9a-f]+)\s+(\d+)\t(.+)$/u.exec(entry);
    if (!match || match[1] !== '100644' || !isSafeReferencePath(match[4])) throw new Error(`References must be committed ordinary allowlisted files: ${entry}`);
    const blob = (await git(sourceRoot, ['cat-file', 'blob', match[2]], { encoding: null })).stdout;
    records.push({ path: match[4], sha256: sha256(blob), bytes: Number(match[3]) });
  }
  if (!records.length) throw new Error('The committed ref contains no docs/references files to package.');
  if (records.some(row => !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > 64 * 1024 * 1024) || records.reduce((sum, row) => sum + row.bytes, 0) > 256 * 1024 * 1024) throw new Error('Reference material exceeds the handoff size bounds.');
  return records.sort((a, b) => a.path.localeCompare(b.path));
}

function restartPrompt({ canonicalRef, headRef, commit, sourceFingerprint, savedPrompt }) {
  return `# HarnessStudio 续研重启 Prompt（版本绑定）\n\n- Git ref: \`${canonicalRef}\`\n- Default branch: \`${headRef}\`\n- Commit: \`${commit}\`\n- Source fingerprint: \`${sourceFingerprint}\`\n- Clone: \`git clone repository.bundle HarnessStudio_dsh\`，然后核对并检出上面的 ref。\n\n以下是仓库内已提交的完整续研 Prompt；版本绑定头部优先于其中任何旧的版本提示。\n\n---\n\n${savedPrompt.trimEnd()}\n`;
}

async function inspectTar(archive, allowedFile) {
  const listed = (await execute('tar', ['-tzf', archive], { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 })).stdout.trimEnd().split('\n').filter(Boolean);
  const verbose = (await execute('tar', ['-tvzf', archive], { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 })).stdout.trimEnd().split('\n').filter(Boolean);
  if (listed.length !== verbose.length || verbose.some(line => !['-', 'd'].includes(line[0]))) throw new Error('Archive contains links or unsupported entries.');
  for (const path of listed) {
    if (path.startsWith('/') || path.includes('\\') || path.includes('\0') || path.split('/').filter(Boolean).some(part => part === '.' || part === '..') || !allowedFile(path)) throw new Error(`Unsafe or unexpected archive member: ${path}`);
  }
  return listed;
}

export async function createDevelopmentHandoff({ sourceRoot = root, outputRoot = join(root, '.studio/releases'), ref, acceptance, now = new Date() } = {}) {
  sourceRoot = await realpath(sourceRoot);
  const { canonicalRef, headRef, bundleRefs, commit } = await assertCleanCommittedSource(sourceRoot, ref);
  const references = await committedReferences(sourceRoot, commit);
  const savedPrompt = await readFile(join(sourceRoot, 'docs/restart-development-prompt.md'), 'utf8');
  outputRoot = resolve(outputRoot);
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const work = await mkdtemp(join(tmpdir(), 'harnessstudio-handoff-build-'));
  const stage = await mkdtemp(join(outputRoot, '.handoff-stage-'));
  let completed = false;
  try {
    const sourceRelease = await createSourceRelease({ sourceRoot, outputRoot: join(work, 'source-release'), acceptance, now });
    await copyFile(sourceRelease.archive, join(stage, 'source.tar.gz'));
    await copyFile(join(sourceRelease.directory, 'RELEASE.json'), join(stage, 'SOURCE_RELEASE.json'));
    await git(sourceRoot, ['bundle', 'create', join(stage, 'repository.bundle'), ...bundleRefs]);
    await git(sourceRoot, ['archive', '--format=tar.gz', `--output=${join(stage, 'references.tar.gz')}`, commit, '--', 'docs/references']);
    await writeFile(join(stage, 'RESTART_PROMPT.md'), restartPrompt({ canonicalRef, headRef, commit, sourceFingerprint: sourceRelease.metadata.sourceFingerprint, savedPrompt }), { mode: 0o600 });
    for (const name of expectedArtifacts) await chmod(join(stage, name), 0o600);

    const purposes = {
      'RESTART_PROMPT.md': 'Copy/paste prompt for resuming development without hidden chat context.',
      'SOURCE_RELEASE.json': 'Metadata copied from the independently verifiable M6 source release.',
      'references.tar.gz': 'Committed docs/references material, kept separate from runnable source.',
      'repository.bundle': 'Cloneable Git history for the checked-out branch and selected release ref.',
      'source.tar.gz': 'M6 source release with no dependencies, private state, upstream checkout or references.',
    };
    const artifacts = [];
    for (const name of expectedArtifacts) artifacts.push(await fileRecord(join(stage, name), purposes[name]));
    const handoff = {
      formatVersion: 1,
      product: 'HarnessStudio',
      productVersion: sourceRelease.metadata.productVersion,
      releaseKind: 'development-handoff',
      generatedAt: now.toISOString(),
      git: { requestedRef: ref, canonicalRef, headRef, bundleRefs, commit },
      sourceRelease: {
        milestone: sourceRelease.metadata.milestone,
        status: sourceRelease.metadata.status,
        sourceDigest: sourceRelease.metadata.sourceDigest,
        sourceFingerprint: sourceRelease.metadata.sourceFingerprint,
      },
      references,
      artifacts,
      exclusions: ['.studio/', 'node_modules/', '.pnpm-store/', 'deepseek-harness/', 'credentials and deployment secrets'],
    };
    const handoffText = `${JSON.stringify(handoff, null, 2)}\n`;
    await writeFile(join(stage, 'HANDOFF.json'), handoffText, { mode: 0o600 });
    const sums = [...artifacts, { path: 'HANDOFF.json', sha256: sha256(handoffText) }]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map(row => `${row.sha256}  ${row.path}`).join('\n') + '\n';
    await writeFile(join(stage, 'SHA256SUMS'), sums, { mode: 0o600 });

    if ((await git(sourceRoot, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim() !== commit || (await git(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=no'])).stdout.length) throw new Error('Git source changed while the handoff was being assembled; retry from a clean checkout.');
    const finalDirectory = join(outputRoot, `harnessstudio-handoff-${now.toISOString().replace(/[:.]/gu, '-')}-${commit.slice(0, 12)}-${randomUUID().slice(0, 4)}`);
    await rename(stage, finalDirectory);
    completed = true;
    return { directory: finalDirectory, metadata: handoff };
  } finally {
    await rm(work, { recursive: true, force: true });
    if (!completed) await rm(stage, { recursive: true, force: true });
  }
}

function parseSums(content) {
  if (!content.endsWith('\n')) throw new Error('SHA256SUMS must end with one newline.');
  const entries = new Map();
  for (const line of content.slice(0, -1).split('\n')) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9._-]+)$/u.exec(line);
    if (!match || entries.has(match[2])) throw new Error('Invalid or duplicate handoff checksum entry.');
    entries.set(match[2], match[1]);
  }
  return entries;
}

export async function verifyDevelopmentHandoff(directory) {
  directory = await realpath(directory);
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.some(entry => !entry.isFile() || entry.isSymbolicLink()) || entries.map(entry => entry.name).sort().join('\0') !== expectedTopLevel.join('\0')) throw new Error('Handoff must contain exactly the documented top-level ordinary files.');
  const sums = parseSums(await readFile(join(directory, 'SHA256SUMS'), 'utf8'));
  const hashedNames = [...expectedArtifacts, 'HANDOFF.json'].sort();
  if ([...sums.keys()].sort().join('\0') !== hashedNames.join('\0')) throw new Error('Handoff checksum manifest is incomplete or has extra entries.');
  for (const [name, expected] of sums) if (sha256(await readFile(join(directory, name))) !== expected) throw new Error(`Handoff artifact changed: ${name}`);

  const metadata = JSON.parse(await readFile(join(directory, 'HANDOFF.json'), 'utf8'));
  exactKeys(metadata, ['formatVersion', 'product', 'productVersion', 'releaseKind', 'generatedAt', 'git', 'sourceRelease', 'references', 'artifacts', 'exclusions'], 'HANDOFF.json');
  if (metadata.formatVersion !== 1 || metadata.product !== 'HarnessStudio' || typeof metadata.productVersion !== 'string' || !metadata.productVersion || metadata.releaseKind !== 'development-handoff' || typeof metadata.generatedAt !== 'string' || !Number.isFinite(Date.parse(metadata.generatedAt))) throw new Error('Not a supported HarnessStudio development handoff.');
  exactKeys(metadata.git, ['requestedRef', 'canonicalRef', 'headRef', 'bundleRefs', 'commit'], 'Git identity');
  if (typeof metadata.git.requestedRef !== 'string' || !metadata.git.requestedRef || metadata.git.requestedRef.startsWith('-') || !/^refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+$/u.test(metadata.git.canonicalRef) || !/^refs\/heads\/[A-Za-z0-9._/-]+$/u.test(metadata.git.headRef) || !Array.isArray(metadata.git.bundleRefs) || metadata.git.bundleRefs.some(value => typeof value !== 'string') || metadata.git.bundleRefs.join('\0') !== [...new Set([metadata.git.headRef, metadata.git.canonicalRef])].sort().join('\0') || !/^[0-9a-f]{40,64}$/u.test(metadata.git.commit)) throw new Error('Invalid Git identity in handoff.');
  exactKeys(metadata.sourceRelease, ['milestone', 'status', 'sourceDigest', 'sourceFingerprint'], 'source release identity');
  if (metadata.sourceRelease.milestone !== 'M6' || !['candidate', 'accepted'].includes(metadata.sourceRelease.status) || !/^[0-9a-f]{64}$/u.test(metadata.sourceRelease.sourceDigest) || !/^[0-9a-f]{64}$/u.test(metadata.sourceRelease.sourceFingerprint)) throw new Error('Invalid source release identity in handoff.');
  const requiredExclusions = ['.studio/', 'node_modules/', '.pnpm-store/', 'deepseek-harness/', 'credentials and deployment secrets'];
  if (!Array.isArray(metadata.exclusions) || metadata.exclusions.join('\0') !== requiredExclusions.join('\0')) throw new Error('Handoff privacy exclusions are incomplete.');

  if (!Array.isArray(metadata.artifacts) || metadata.artifacts.length !== expectedArtifacts.length) throw new Error('Invalid artifact inventory.');
  for (const artifact of metadata.artifacts) {
    exactKeys(artifact, ['path', 'sha256', 'bytes', 'purpose'], 'artifact');
    if (!expectedArtifacts.includes(artifact.path) || artifact.sha256 !== sums.get(artifact.path) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes !== (await stat(join(directory, artifact.path))).size || typeof artifact.purpose !== 'string' || !artifact.purpose) throw new Error(`Invalid artifact record: ${artifact.path}`);
  }
  if (new Set(metadata.artifacts.map(row => row.path)).size !== expectedArtifacts.length) throw new Error('Duplicate artifact inventory entries.');

  const sourceMetadata = JSON.parse(await readFile(join(directory, 'SOURCE_RELEASE.json'), 'utf8'));
  for (const key of ['productVersion', 'milestone', 'status', 'sourceDigest', 'sourceFingerprint']) {
    const expected = key === 'productVersion' ? metadata.productVersion : metadata.sourceRelease[key];
    if (sourceMetadata[key] !== expected) throw new Error(`Source release metadata mismatch: ${key}`);
  }
  const temporary = await mkdtemp(join(tmpdir(), 'harnessstudio-handoff-verify-'));
  let committedPrompt = '';
  try {
    const sourceMembers = await inspectTar(join(directory, 'source.tar.gz'), path => path === 'harnessstudio-m6/' || path.startsWith('harnessstudio-m6/'));
    if (!sourceMembers.some(path => path === 'harnessstudio-m6/RELEASE.json')) throw new Error('Source archive payload is incomplete.');
    await execute('tar', ['-xzf', join(directory, 'source.tar.gz'), '-C', temporary], { timeout: 60_000 });
    const verifiedSource = await verifySourceRelease(join(temporary, 'harnessstudio-m6'));
    if (verifiedSource.sourceFingerprint !== metadata.sourceRelease.sourceFingerprint || verifiedSource.sourceDigest !== metadata.sourceRelease.sourceDigest) throw new Error('Extracted source identity does not match the handoff.');
    committedPrompt = await readFile(join(temporary, 'harnessstudio-m6/docs/restart-development-prompt.md'), 'utf8');

    if (!Array.isArray(metadata.references) || !metadata.references.length) throw new Error('Reference inventory is empty.');
    const expectedReferences = new Map();
    for (const row of metadata.references) {
      exactKeys(row, ['path', 'sha256', 'bytes'], 'reference');
      if (!isSafeReferencePath(row.path) || !/^[0-9a-f]{64}$/u.test(row.sha256) || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || expectedReferences.has(row.path)) throw new Error('Invalid reference inventory.');
      expectedReferences.set(row.path, row);
    }
    if ([...expectedReferences.values()].some(row => row.bytes > 64 * 1024 * 1024) || [...expectedReferences.values()].reduce((sum, row) => sum + row.bytes, 0) > 256 * 1024 * 1024) throw new Error('Reference inventory exceeds the handoff size bounds.');
    const referenceMembers = await inspectTar(join(directory, 'references.tar.gz'), path => path === 'docs/' || path === 'docs/references/' || expectedReferences.has(path));
    const archivedReferences = referenceMembers.filter(path => !path.endsWith('/'));
    if (archivedReferences.sort().join('\0') !== [...expectedReferences.keys()].sort().join('\0')) throw new Error('Reference archive inventory does not match HANDOFF.json.');
    const referenceRoot = join(temporary, 'references'); await mkdir(referenceRoot);
    await execute('tar', ['-xzf', join(directory, 'references.tar.gz'), '-C', referenceRoot], { timeout: 60_000 });
    for (const [path, row] of expectedReferences) {
      const info = await lstat(join(referenceRoot, path));
      if (!info.isFile() || info.isSymbolicLink() || info.size !== row.bytes || sha256(await readFile(join(referenceRoot, path))) !== row.sha256) throw new Error(`Reference changed: ${path}`);
    }

    const bare = join(temporary, 'bundle-check.git');
    await git(temporary, ['init', '--bare', bare]);
    await git(bare, ['bundle', 'verify', join(directory, 'repository.bundle')]);
    const heads = (await git(bare, ['bundle', 'list-heads', join(directory, 'repository.bundle')])).stdout.trim().split('\n').filter(Boolean);
    const advertisedRefs = heads.map(line => line.slice(line.indexOf(' ') + 1)).sort();
    if (advertisedRefs.join('\0') !== metadata.git.bundleRefs.join('\0')) throw new Error('Git bundle exposes an unexpected ref set.');
    for (let index = 0; index < metadata.git.bundleRefs.length; index += 1) {
      const sourceRef = metadata.git.bundleRefs[index];
      const target = sourceRef.startsWith('refs/tags/') ? `refs/tags/handoff-verify-${index}` : `refs/heads/handoff-verify-${index}`;
      await git(bare, ['fetch', '--no-tags', join(directory, 'repository.bundle'), `${sourceRef}:${target}`]);
      if ((await git(bare, ['rev-parse', '--verify', `${target}^{commit}`])).stdout.trim() !== metadata.git.commit) throw new Error('Git bundle commit does not match HANDOFF.json.');
      const historyNames = (await git(bare, ['log', '--format=', '--name-only', '-z', target, '--'])).stdout.split('\0').filter(Boolean);
      for (const path of historyNames) assertSafeGitPath(path);
    }
    await git(bare, ['fsck', '--full', '--strict']);
  } finally { await rm(temporary, { recursive: true, force: true }); }

  const prompt = await readFile(join(directory, 'RESTART_PROMPT.md'), 'utf8');
  if (!prompt.includes(metadata.git.commit) || !prompt.includes(metadata.git.canonicalRef) || !prompt.includes(metadata.git.headRef) || !prompt.includes(metadata.sourceRelease.sourceFingerprint) || !prompt.endsWith(`${committedPrompt.trimEnd()}\n`)) throw new Error('Restart prompt is not bound to this handoff or omits the committed prompt body.');
  return metadata;
}

if (await isDirectInvocation(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === '--verify') {
    if (args.length !== 2) throw new Error('Usage: --verify <handoff-directory>');
    const metadata = await verifyDevelopmentHandoff(resolve(args[1]));
    console.log(`Development handoff verified: ${metadata.git.canonicalRef} @ ${metadata.git.commit}. Source, references, prompt and cloneable Git bundle are intact.`);
  } else {
    const options = {};
    for (let index = 0; index < args.length; index += 2) {
      if (!['--ref', '--output', '--evidence', '--acceptance'].includes(args[index]) || !args[index + 1]) throw new Error('Usage: --ref <branch-or-tag> [--output <directory>] [--evidence <final-evidence.json>]');
      if (args[index] === '--ref') options.ref = args[index + 1];
      else if (args[index] === '--output') options.outputRoot = resolve(args[index + 1]);
      else options.acceptance = JSON.parse(await readFile(resolve(args[index + 1]), 'utf8'));
    }
    if (!options.ref) throw new Error('Usage: --ref <branch-or-tag> [--output <directory>] [--evidence <final-evidence.json>]');
    const result = await createDevelopmentHandoff(options);
    console.log(`Development handoff ready: ${result.directory}\nRun: node scripts/release-handoff.mjs --verify ${JSON.stringify(result.directory)}`);
  }
}
