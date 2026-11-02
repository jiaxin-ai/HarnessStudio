import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile, rm, realpath, readdir, lstat, chmod } from 'node:fs/promises';
import { randomUUID, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { root, upstream, upstreamCommit } from './prepare.mjs';
import { containerHealthy, } from './container-healthcheck.mjs';

const execute = promisify(execFile);
const mode = process.argv[2] || '--static';
assert.ok(['--static', '--runtime', '--docker'].includes(mode), 'Use --static, --runtime or --docker');
// Outside the checkout: ancestor node_modules must not conceal a missing
// self-owned profile link when a Linux data volume lives outside /opt.
const fixture = await realpath(await mkdtemp(join(tmpdir(), 'harnessstudio-m5-container-test-')));
const secrets = join(fixture, 'secrets');
const projectName = `studio-m5-test-${randomUUID().slice(0, 8)}`;
const token = randomBytes(32).toString('base64url');
const fakeProviderKey = `m5-fake-${randomUUID()}`;
const children = new Set();
let dockerCreated = false;

async function capture(command, args, options = {}) {
  const result = await execute(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000, ...options });
  return result.stdout.trim();
}
async function command(command, args, options = {}) {
  await new Promise((ready, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', ...options });
    child.once('error', reject); child.once('close', code => code === 0 ? ready() : reject(new Error(`${command} exited ${code}`)));
  });
}
const composeEnv = { ...process.env, STUDIO_DEPLOY_SECRETS_DIR: secrets, STUDIO_PUBLISHED_PORT: '0', STUDIO_PUBLIC_URL: 'http://127.0.0.1:3080/', STUDIO_TRUSTED_HOSTS: '' };
const composeArgs = ['compose', '-p', projectName, '-f', join(root, 'deploy/compose.yml')];
const compose = (args, options = {}) => capture('docker', [...composeArgs, ...args], { env: composeEnv, ...options });

async function until(operation, accepts, message, milliseconds = 30000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) { try { const value = await operation(); if (accepts(value)) return value; } catch { /* bounded readiness polling */ } await delay(100); }
  throw new Error(message);
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const ended = new Promise(ready => child.once('close', ready));
  child.kill('SIGTERM');
  if (!await Promise.race([ended.then(() => true), delay(15000, false, { ref: false })])) { child.kill('SIGKILL'); await ended; throw new Error('Isolated container-entrypoint shutdown timed out.'); }
}
async function availableLoopbackPort() {
  const server = createServer();
  await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise((ready, reject) => server.close(error => error ? reject(error) : ready()));
  return address.port;
}
async function unlock(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) return;
  await chmod(directory, 0o700);
  for (const name of await readdir(directory)) await unlock(join(directory, name));
}

async function openBrowser(base, accessUrl) {
  assert.equal(new URL(accessUrl).searchParams.has('token'), false, 'Startup access URL must be clean');
  const page = await fetch(`${base}/`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  assert.equal(page.status, 200, 'A fresh browser must directly open Studio without token or cookie');
  assert.equal(page.headers.get('set-cookie'), null); await page.body?.cancel();
  return {
    base,
    async call(path, body, extraHeaders = {}) {
      return fetch(`${base}/api/studio/${path}`, { signal: AbortSignal.timeout(10000), method: body === undefined ? 'GET' : 'POST', headers: { origin: base, ...extraHeaders, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    },
    async json(path, body) { const response = await this.call(path, body); assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`); return response.json(); },
  };
}
async function exercise(app) {
  assert.equal((await fetch(`${app.base}/api/studio/projects`)).status, 200, 'Anonymous Studio access requires no browser identity');
  assert.equal((await app.call('projects', undefined, { origin: 'https://evil.example' })).status, 403, 'Cross-origin browser requests must stay refused');
  // fetch owns its Host header; use the real Node HTTP carrier to test a
  // deliberately different authority rather than a silently ignored override.
  const wrongHost = await new Promise((ready, reject) => {
    const outgoing = request(`${app.base}/api/studio/projects`, { headers: { host: 'untrusted.example', origin: 'http://untrusted.example' }, timeout: 5000 }, response => { response.resume(); response.once('end', () => ready(response.statusCode)); });
    outgoing.once('error', reject); outgoing.once('timeout', () => outgoing.destroy(new Error('Host-fence check timed out'))); outgoing.end();
  });
  assert.equal(wrongHost, 403, 'A public URL is not an implicit trusted Host');
  const project = await app.json('projects', { title: 'M5 isolated deployment fixture' });
  const task = await app.json('task/quick', { projectId: project.id, title: '受控容器持久化任务' });
  const content = 'M5 synthetic deployment proof, not an engineering deliverable.\n';
  await app.json('file', { taskId: task.id, path: 'proof.txt', content });
  const modelView = await app.json('models');
  await app.json('models', { id: 'm5-test', name: 'M5 fake provider', protocol: 'openai-completions', baseURL: 'https://example.invalid/v1',
    models: ['m5-test-model'], contextWindow: 8192, maxTokens: 512, revision: modelView.customRevision, apiKey: fakeProviderKey });
  const chat = await app.json('chat', { projectId: project.id, provider: 'studio-smoke', model: 'm1-smoke', message: '[project-chat-only] Container persistence probe.' });
  const history = await until(() => app.json(`chat?id=${chat.id}`), row => row.status === 'idle' && row.events.some(event => event.type === 'turn/end'), 'Controlled container chat did not finish');
  const images = (await app.json('software/catalog')).images;
  assert.deepEqual(images.map(row => row.id).sort(), ['mock-ansys', 'mock-autocad', 'mock-solidworks']);
  assert.equal((await app.json(`software/seats?taskId=${task.id}`)).seats.length, 0, 'Opening the directory must not auto-select or launch software');
  const allocation = await app.json('software/seat', { taskId: task.id, imageId: 'mock-solidworks', requestId: randomUUID() });
  const seat = await until(() => app.json(`software/seat?taskId=${task.id}&imageId=mock-solidworks`), value => value.seat?.state === 'ready', 'Independent Mock Seat did not become ready');
  assert.equal(seat.seat.id, allocation.seat.id);
  await app.json('software/control', { taskId: task.id, imageId: 'mock-solidworks', action: 'acquire' });
  const invoked = await app.json('software/invoke', { taskId: task.id, imageId: 'mock-solidworks', requestId: randomUUID(), capability: 'shape.add',
    parameters: { kind: 'rectangle', x: 20, y: 30, width: 100, height: 60, label: 'M5 synthetic shape' }, expectedDocumentRevision: 0 });
  await until(() => app.json(`software/operation?taskId=${task.id}&imageId=mock-solidworks&operationId=${invoked.operation.id}`), value => value.operation.state === 'succeeded', 'Independent platform operation did not finish');
  await app.json('software/control', { taskId: task.id, imageId: 'mock-solidworks', action: 'release' });
  return { project, task, content, chatId: chat.id, history, seatId: seat.seat.id };
}
async function recovered(app, proof) {
  assert.equal((await app.json('projects')).some(row => row.id === proof.project.id), true);
  assert.equal((await app.json(`file?taskId=${proof.task.id}&path=proof.txt`)).content, proof.content);
  const models = await app.json('models'), provider = models.providers.find(row => row.id === 'm5-test');
  assert.equal(provider?.credentialConfigured, true); assert.equal(provider?.name, 'M5 fake provider');
  assert.deepEqual((await app.json(`chat?id=${proof.chatId}`)).events, proof.history.events, 'Native Session log must survive both service restarts');
  const { seat } = await app.json(`software/seat?taskId=${proof.task.id}&imageId=mock-solidworks`);
  assert.equal(seat.id, proof.seatId); assert.equal(seat.document.shapes.length, 1); assert.equal(seat.document.shapes[0].label, 'M5 synthetic shape'); assert.equal(seat.control, null);
}
async function localStart(role, env) {
  const child = spawn(process.execPath, [join(root, 'scripts/container-entrypoint.mjs'), role], { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let output = ''; child.stdout.on('data', bytes => { output = (output + bytes).slice(-65536); }); child.stderr.on('data', bytes => { output = (output + bytes).slice(-65536); });
  child.on('error', () => {});
  return { child, output: () => output };
}

try {
  await mkdir(secrets, { mode: 0o700 });
  await writeFile(join(secrets, 'mock-seat-token'), token + '\n', { mode: 0o600 });
  await writeFile(join(secrets, 'provider.env'), '# Intentionally no real credentials.\n', { mode: 0o600 });
  const inputs = JSON.parse(await readFile(join(root, 'deploy/build-inputs.json'), 'utf8'));
  assert.equal(inputs.upstreamCommit, upstreamCommit);
  const dockerfile = await readFile(join(root, 'Dockerfile'), 'utf8');
  assert.ok(dockerfile.includes(inputs.upstreamCommit)); assert.ok(dockerfile.includes(inputs.nodeImage));
  assert.equal(await capture('git', ['rev-parse', 'HEAD'], { cwd: upstream }), upstreamCommit);
  assert.equal(await capture('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: upstream }), '');
  const composed = JSON.parse(await compose(['config', '--format=json']));
  assert.equal(composed.services.studio.ports[0].host_ip, '127.0.0.1');
  assert.equal(composed.services['mock-seat'].ports, undefined);
  assert.equal(composed.services.studio.read_only, true);
  assert.equal(composed.services.studio.init, true);
  assert.ok(composed.services.studio.cap_add.includes('KILL'), 'Root init must forward shutdown signals to the unprivileged service UID');
  assert.equal(composed.services.studio.environment.STUDIO_SEAT_URL, 'http://mock-seat:8080');
  const overlay = await readFile(join(root, 'deploy/container.patch.yml'), 'utf8');
  assert.match(overlay, /trustedHttpOrigins:\s*\['http:\/\/mock-seat:8080'\]/u, 'Only the exact private Compose service origin opts into HTTP');
  assert.notEqual(composed.services.studio.volumes[0].source, composed.services['mock-seat'].volumes[0].source);
  assert.equal(Object.hasOwn(composed.services.studio.environment, 'STUDIO_SEAT_TOKEN'), false);
  console.log('Container build pins, Compose schema, loopback publishing, independent volumes and file-secret configuration verified.');
  if (mode === '--runtime') {
    const mockHome = join(fixture, 'mock'), studioHome = join(fixture, 'studio');
    const mockEnv = { STUDIO_MOCK_SEAT_ROOT: mockHome, STUDIO_MOCK_SEAT_TOKEN_FILE: join(secrets, 'mock-seat-token'), STUDIO_MOCK_SEAT_HOST: '127.0.0.1', STUDIO_MOCK_SEAT_PORT: '0' };
    let mock = await localStart('mock-seat', mockEnv);
    const mockUrl = await until(() => mock.output().match(/Mock Seat ready at (http:\/\/127\.0\.0\.1:\d+)/u)?.[1], Boolean, 'Mock container entrypoint did not start');
    const mockPort = new URL(mockUrl).port;
    assert.equal(await containerHealthy('mock-seat', { ...mockEnv, STUDIO_MOCK_SEAT_PORT: mockPort }), true);
    const studioEnv = { STUDIO_HOME: studioHome, STUDIO_SEAT_TOKEN_FILE: join(secrets, 'mock-seat-token'), STUDIO_SEAT_URL: mockUrl, STUDIO_PROVIDER_ENV_FILE: join(secrets, 'provider.env'),
      STUDIO_BIND_HOST: '127.0.0.1', STUDIO_PORT: '0', STUDIO_PUBLIC_URL: '', STUDIO_TRUSTED_HOSTS: '', STUDIO_SMOKE: '1', STUDIO_SYSTEM_PROXY: '0' };
    let studio = await localStart('studio', studioEnv);
    const accessUrl = await until(() => readFile(join(studioHome, 'container-login-url'), 'utf8'), value => { try { return new URL(value).protocol === 'http:'; } catch { return false; } }, 'Studio did not persist its clean startup access URL');
    const base = new URL(accessUrl).origin, app = await openBrowser(base, accessUrl);
    assert.equal(await containerHealthy('studio', { ...studioEnv, STUDIO_PORT: new URL(base).port }), true);
    const proof = await exercise(app);
    assert.equal(studio.output().includes('?token='), false, 'Studio should announce a clean browser URL');
    assert.equal(studio.output().includes(token), false);
    await stop(studio.child); await stop(mock.child);
    mock = await localStart('mock-seat', { ...mockEnv, STUDIO_MOCK_SEAT_PORT: mockPort });
    await until(() => containerHealthy('mock-seat', { ...mockEnv, STUDIO_MOCK_SEAT_PORT: mockPort }), Boolean, 'Mock restart was not healthy');
    studio = await localStart('studio', { ...studioEnv, STUDIO_PORT: new URL(base).port });
    await until(() => containerHealthy('studio', { ...studioEnv, STUDIO_PORT: new URL(base).port }), Boolean, 'Studio restart was not healthy');
    await recovered(await openBrowser(base, accessUrl), proof); // a second clean browser after restart.
    console.log('Isolated local container entrypoints: anonymous browser/Host/Origin, health, explicit Seat, file/Provider/Session/Mock-document restart persistence and service-secret log redaction passed. This is not a Linux image build.');
  }
  if (mode === '--docker') {
    await capture('docker', ['info', '--format={{.ServerVersion}}']);
    // Docker reallocates a host port configured as zero on restart. Reserve a
    // test-only fixed port so readiness probes keep the same reachable address.
    const publishedPort = await availableLoopbackPort();
    composeEnv.STUDIO_PUBLISHED_PORT = String(publishedPort);
    composeEnv.STUDIO_PUBLIC_URL = `http://127.0.0.1:${publishedPort}/`;
    const override = join(fixture, 'smoke.compose.yml');
    await writeFile(override, 'services:\n  studio:\n    environment:\n      STUDIO_SMOKE: "1"\n');
    composeArgs.push('-f', override);
    dockerCreated = true;
    await command('docker', [...composeArgs, 'up', '--build', '--detach', '--wait', '--wait-timeout', '120'], { env: composeEnv });
    const mapped = await compose(['port', 'studio', '3080']);
    assert.equal(mapped, `127.0.0.1:${publishedPort}`);
    const base = `http://${mapped}`;
    const accessUrl = await compose(['exec', '-T', 'studio', 'cat', '/var/lib/harnessstudio/container-login-url']);
    const app = await openBrowser(base, accessUrl), proof = await exercise(app);
    await compose(['restart', 'studio', 'mock-seat'], { timeout: 90000 });
    assert.equal(await compose(['port', 'studio', '3080']), mapped, 'Published authority must remain stable across restart');
    for (const role of ['mock-seat', 'studio']) {
      await until(async () => {
        await compose(['exec', '-T', role, 'node', 'scripts/container-healthcheck.mjs', role], { timeout: 10000 });
        return true;
      }, Boolean, `Restarted ${role} did not pass its real container health check`, 60000);
    }
    await until(async () => (await app.call('projects')).status, value => value === 200, 'Restarted Studio did not retain anonymous readiness', 60000);
    await until(async () => (await app.json(`software/seat?taskId=${proof.task.id}&imageId=mock-solidworks`)).seat?.document.shapes.length, value => value === 1, 'Restarted independent platform did not retain the document', 60000);
    await recovered(await openBrowser(base, accessUrl), proof);
    const logs = await compose(['logs', '--no-color', 'studio', 'mock-seat']);
    assert.equal(logs.includes('Unexpected error when forwarding signal'), false, 'Init must forward stop signals without a cross-UID permission failure');
    assert.equal(logs.includes(token), false); assert.equal(logs.includes(fakeProviderKey), false); assert.equal(logs.includes('?token='), false);
    console.log('Actual isolated Linux Compose build/run/restart passed: two services, anonymous browser with Host/Origin fence, explicit three-image directory, durable file/Provider/Session/Mock document and redacted service credentials.');
  }
} catch (error) {
  if (mode === '--docker' && dockerCreated) {
    try {
      const logs = await compose(['logs', '--no-color', '--tail', '80', 'studio', 'mock-seat']);
      console.error(logs.replaceAll(token, '[redacted]').replaceAll(fakeProviderKey, '[redacted]').replace(/([?&]token=)[^\s)]+/gu, '$1[redacted]'));
    } catch { console.error('Could not read isolated container diagnostics.'); }
  }
  throw error;
} finally {
  for (const child of children) await stop(child);
  if (dockerCreated) {
    assert.ok(projectName.startsWith('studio-m5-test-'));
    await compose(['down', '--volumes', '--remove-orphans'], { timeout: 90000 });
  }
  await unlock(fixture); await rm(fixture, { recursive: true, force: true });
}
