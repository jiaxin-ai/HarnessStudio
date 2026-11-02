import { execFileSync } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { root, upstream, upstreamCommit } from './prepare.mjs';

const inputs = JSON.parse(await readFile(join(root, 'deploy/build-inputs.json'), 'utf8'));
const phase = process.argv[2] || '--all';
if (!['--all', '--upstream', '--studio'].includes(phase)) throw new Error('Container build phase must be --upstream or --studio.');
if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) throw new Error('Container build requires Linux amd64 or arm64; host modules are never reused.');
if (process.versions.node !== inputs.nodeVersion || inputs.upstreamCommit !== upstreamCommit) throw new Error('Container build inputs differ from the pinned Studio runtime.');
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, CI: 'true' } });
const current = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: upstream, encoding: 'utf8' }).trim();
if (current !== upstreamCommit) throw new Error('Container source is not the pinned DSH commit.');
const pnpm = execFileSync('pnpm', ['--version'], { cwd: upstream, encoding: 'utf8' }).trim();
if (pnpm !== inputs.pnpmVersion) throw new Error('Container package manager differs from the upstream lockfile toolchain.');
if (phase !== '--studio') {
  run('pnpm', ['install', '--frozen-lockfile'], upstream);
  run('pnpm', ['run', inputs.upstreamBuild], upstream);
}
if (phase !== '--upstream') {
  run('npm', ['ci', '--ignore-scripts', '--include=dev']);
  run(process.execPath, ['scripts/build.mjs']);
}
if (execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: upstream, encoding: 'utf8' }).trim()) throw new Error('The official build changed tracked upstream files.');
// prepare() made an empty build-only home; the image contains no runtime home.
if (phase !== '--upstream') await rm(join(root, '.studio'), { recursive: true, force: true });
console.log(`Linux ${phase.slice(2)} build complete; tracked upstream source unchanged.`);
