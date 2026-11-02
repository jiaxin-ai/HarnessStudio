import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { root, upstream, prepare } from './prepare.mjs';
import { resolveNetworkEnvironment } from './network-env.mjs';
import { startMockSeat } from './mock-seat-process.mjs';

const home = await prepare(process.env.STUDIO_HOME || join(root, '.studio', 'home'));
// Only the Mock backend uses the Mock platform; vm-manager has vm_manager and none has no software at all.
const platform = !['vm-manager', 'none'].includes(process.env.STUDIO_SEAT_BACKEND ?? '') && !process.env.STUDIO_SEAT_URL && process.env.STUDIO_MOCK_SEAT !== '0' ? await startMockSeat(home) : undefined;
const network = await resolveNetworkEnvironment({ home });
for (const message of network.messages) console.error(message);
// This provenance lets the Studio network plugin refresh only automatically managed routes.
// Keep the user's original bypass list separate from the system list/native normalization.
const managed = ['system', 'none', 'unsupported', 'system-error'].includes(network.status);
network.env.STUDIO_SYSTEM_PROXY_MANAGED = managed ? '1' : '0';
if (managed) network.env.STUDIO_SYSTEM_PROXY_NO_PROXY_BASELINE = JSON.stringify(Object.fromEntries(
  Object.entries(process.env).filter(([key, value]) => key.toUpperCase() === 'NO_PROXY' && value !== undefined),
));
else delete network.env.STUDIO_SYSTEM_PROXY_NO_PROXY_BASELINE;
if (managed) network.env.STUDIO_SYSTEM_PROXY_HOME_NO_PROXY = network.homeNoProxy ? '1' : '0';
else delete network.env.STUDIO_SYSTEM_PROXY_HOME_NO_PROXY;
const args = ['--profile', 'studio'];
if (process.env.STUDIO_SMOKE === '1') args.push('--patch', join(root, 'config', 'smoke.patch.yml'));
// Deployment overlays belong to Studio, and precede the app's flags so the
// official launcher treats them as config rather than forwarded web arguments.
if (process.env.STUDIO_CONFIG_PATCH) args.push('--patch', process.env.STUDIO_CONFIG_PATCH);
args.push('--no-open', '--port', process.env.STUDIO_PORT || '3080', ...process.argv.slice(2));
const child = spawn(process.execPath, [join(upstream, 'apps/cli/lib/bin.js'), ...args], {
  cwd: root, stdio: 'inherit', env: { ...network.env, ...(platform ? { STUDIO_SEAT_URL: platform.url, STUDIO_SEAT_TOKEN: platform.token } : {}), DSH_HOME: home, STUDIO_ROOT: root },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error); process.exitCode = 1; void platform?.stop(); });
child.on('exit', async code => { await platform?.stop(); process.exitCode = code ?? 1; });
platform?.child.on('exit', () => { if (child.exitCode === null) console.error('Mock 软件平台已停止；Studio 保持在线，软件请求将显示连接错误。'); });
