import { mkdir, readdir, readFile, symlink, lstat, realpath, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const upstream = join(root, 'deepseek-harness');
export const upstreamCommit = '5badb15009ae1756c3afe0ae0cef1faafc290ccc';

/** Link local built packages without editing their source or dependency manifests. */
async function linkPackage(directory, destinationRoot) {
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  await linkNamedPackage(directory, destinationRoot, manifest.name);
}

async function linkNamedPackage(directory, destinationRoot, name, preserveExisting = false) {
  const destination = join(destinationRoot, name);
  await mkdir(dirname(destination), { recursive: true });
  try {
    const info = await lstat(destination);
    if (preserveExisting) return;
    if (!info.isSymbolicLink() || await realpath(destination) !== await realpath(directory)) {
      throw new Error(`Refusing to replace existing package: ${destination}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await symlink(directory, destination, 'dir');
  }
}

/** Materialize a workspace-owned Harness home and resolve the pinned source installation. */
export async function prepare(home = join(root, '.studio', 'home')) {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: upstream, encoding: 'utf8' }).trim();
  if (commit !== upstreamCommit) throw new Error(`Expected DSH ${upstreamCommit}; found ${commit}`);
  if (execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: upstream, encoding: 'utf8' }).trim()) {
    throw new Error('Pinned DSH has tracked changes; Studio never patches upstream source.');
  }
  const modules = join(root, 'node_modules');
  const workspacePackages = [];
  for (const group of await readdir(join(upstream, 'packages'), { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    for (const entry of await readdir(join(upstream, 'packages', group.name), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = join(upstream, 'packages', group.name, entry.name);
      workspacePackages.push(directory);
      try { await linkPackage(directory, modules); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  for (const entry of await readdir(join(upstream, 'vendor'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(upstream, 'vendor', entry.name);
    workspacePackages.push(directory);
    try { await linkPackage(directory, modules); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const entry of await readdir(join(upstream, 'apps'), { withFileTypes: true })) {
    if (entry.isDirectory()) workspacePackages.push(join(upstream, 'apps', entry.name));
  }
  const nativeSystem = join(upstream, 'native', 'system');
  workspacePackages.push(nativeSystem);
  for (const entry of await readdir(join(nativeSystem, 'packages'), { withFileTypes: true })) {
    if (entry.isDirectory()) workspacePackages.push(join(nativeSystem, 'packages', entry.name));
  }
  workspacePackages.push(join(upstream, 'benchmarks'), join(upstream, 'website'), join(upstream, 'python', 'sdk-runtime'));
  // npm manages this repository's direct dependencies and may prune the
  // upstream workspace's previously hoisted external links. Re-link only the
  // external runtime packages required by the pinned source packages we expose.
  const externalLinks = [
    {
      name: 'sharp',
      destinations: [modules, join(upstream, 'packages', 'attachment', 'attachment-local', 'node_modules')],
    },
    {
      name: 'eventsource-parser',
      destinations: [modules, join(upstream, 'packages', 'llm', 'llm-deepseek', 'node_modules')],
    },
    {
      name: '@earendil-works/pi-ai',
      destinations: [modules, join(upstream, 'packages', 'llm', 'llm-pi-ai', 'node_modules')],
    },
    {
      name: 'resolve.exports',
      destinations: [modules, join(upstream, 'packages', 'boot', 'app-boot', 'node_modules')],
    },
  ];
  for (const { name, destinations } of externalLinks) {
    const directory = await realpath(join(upstream, 'node_modules', '.pnpm', 'node_modules', name));
    for (const destination of destinations) await linkPackage(directory, destination);
  }
  // A root npm install can prune pnpm's package-local symlinks inside the
  // pinned source checkout. Rebuild missing runtime links from the intact
  // virtual store while preserving every link a normal pnpm install supplied.
  const packageByName = new Map();
  for (const directory of workspacePackages) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      if (typeof manifest.name === 'string') packageByName.set(manifest.name, directory);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const virtualHoist = join(upstream, 'node_modules', '.pnpm', 'node_modules');
  for (const directory of workspacePackages) {
    let manifest;
    try { manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const runtimeDependencies = { ...manifest.peerDependencies, ...manifest.optionalDependencies, ...manifest.dependencies };
    for (const name of Object.keys(runtimeDependencies).sort()) {
      const local = packageByName.get(name);
      if (local !== undefined) {
        await linkNamedPackage(local, join(directory, 'node_modules'), name, true);
        continue;
      }
      try {
        let installed;
        for (const candidate of [join(upstream, 'node_modules', name), join(virtualHoist, name), join(modules, name)]) {
          try { installed = await realpath(candidate); break; }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        if (installed === undefined) {
          const missing = new Error(`Pinned runtime dependency is not installed: ${name}`);
          missing.code = 'ENOENT'; throw missing;
        }
        await linkNamedPackage(installed, join(directory, 'node_modules'), name, true);
      } catch (error) {
        // Optional and peer dependencies can be absent on this host. A direct
        // runtime dependency missing from the pinned virtual store is corrupt.
        if (error.code === 'ENOENT' && (Object.hasOwn(manifest.optionalDependencies ?? {}, name)
          || Object.hasOwn(manifest.peerDependencies ?? {}, name))) continue;
        throw error;
      }
    }
  }
  await linkPackage(join(upstream, 'apps', 'cli'), modules);
  for (const name of ['studio', 'ui', 'smoke']) await linkPackage(join(root, 'plugins', name), modules);
  await linkPackage(join(root, 'config'), modules);
  const profile = join(home, 'profiles', 'studio');
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await linkPackage(join(root, 'config'), join(profile, 'node_modules'));
  // Loader imports a flattened bundle's rows relative to the profile patch.
  // A home outside the installation cannot inherit root/node_modules through
  // ancestor lookup, so explicitly install the self-owned plugin links here.
  for (const name of ['studio', 'ui', 'smoke']) {
    await linkPackage(join(root, 'plugins', name), join(profile, 'node_modules'));
  }
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'harnessstudio-profile', private: true, type: 'module',
    dsh: { profile: { bundles: ['@harnessstudio/bundle'] } },
  }, null, 2) + '\n', { mode: 0o600 });
  // The Settings service persists user Provider edits here. Never reset them on build/start.
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n', { mode: 0o600, flag: 'wx' }).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
  return home;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(`Studio profile ready: ${await prepare()}`);
}
