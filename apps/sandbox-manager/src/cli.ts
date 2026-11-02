import { readFileSync } from 'node:fs';
import { SandboxManager, createSandboxServer } from './server.ts';

const env = process.env;
const number = (name: string, fallback: number) => { const value = env[name] === undefined || env[name] === '' ? fallback : Number(env[name]); if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`); return value; };
const required = (name: string) => { const value = env[name]; if (!value) throw new Error(`${name} is required`); return value; };
const token = (env.SANDBOX_TOKEN_FILE ? readFileSync(env.SANDBOX_TOKEN_FILE, 'utf8') : required('SANDBOX_TOKEN')).trim();
if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new Error('The sandbox token must be 32-128 characters of [A-Za-z0-9_-]');
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const manager = new SandboxManager({
  token, projectsRoot: required('SANDBOX_PROJECTS_ROOT'), image: required('SANDBOX_IMAGE'), runtime: env.SANDBOX_RUNTIME || 'runsc',
  network: required('SANDBOX_NETWORK'), proxy: env.SANDBOX_PROXY ?? '', dockerSocket: env.SANDBOX_DOCKER_SOCKET || '/var/run/docker.sock',
  maxCpus: number('SANDBOX_MAX_CPUS', 4), maxMemoryGb: number('SANDBOX_MAX_MEMORY_GB', 8), maxRunning: Math.floor(number('SANDBOX_MAX_RUNNING', 8)),
  pids: number('SANDBOX_PIDS', 512), tmpMb: number('SANDBOX_TMP_MB', 1024), idleMinutes: number('SANDBOX_IDLE_MINUTES', 30), removeHours: number('SANDBOX_REMOVE_HOURS', 24),
  ...(env.SANDBOX_STUDIO_VOLUME ? { studioVolume: env.SANDBOX_STUDIO_VOLUME, studioSubpath: env.SANDBOX_STUDIO_SUBPATH ?? 'studio' } : {}),
  // Studio without vm_manager: task spaces are in its data volume, mounted read-only here at SANDBOX_FILES_VOLUME_ROOT.
  ...(env.SANDBOX_FILES_VOLUME ? { filesVolume: env.SANDBOX_FILES_VOLUME, filesVolumeRoot: env.SANDBOX_FILES_VOLUME_ROOT || '/var/lib/harnessstudio' } : {}), log,
});
const server = createSandboxServer(manager, token);
const port = number('SANDBOX_PORT', 8100), host = env.SANDBOX_HOST || '0.0.0.0';
server.listen(port, host, () => log(`sandbox_manager listening on ${host}:${port}, runtime ${env.SANDBOX_RUNTIME || 'runsc'}, task spaces ${env.SANDBOX_FILES_VOLUME ? `in volume ${env.SANDBOX_FILES_VOLUME}` : 'on the host'}`));
const timer = setInterval(() => { void manager.reap().catch(error => log(`reap failed: ${error instanceof Error ? error.message : String(error)}`)); }, 60000);
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { clearInterval(timer); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); });
