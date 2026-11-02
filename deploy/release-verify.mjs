import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { randomUUID, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createSourceRelease, isDirectInvocation } from '../scripts/release-m6.mjs';

if (await isDirectInvocation(import.meta.url)) {
if (process.argv.length !== 2) throw new Error('Usage: node deploy/release-verify.mjs (isolated Docker verification)');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), execute = promisify(execFile);
const fixture = await realpath(await mkdtemp(join(tmpdir(), 'harnessstudio-m6-delivery-')));
const suffix = randomUUID().slice(0, 8), sourceProject = `studio-m6-source-${suffix}`, restoreProject = `studio-m6-restored-${suffix}`;
let payload;
const contexts = [];
async function command(command, args, env, cwd = payload) {
  await new Promise((ready, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: 'inherit' });
    child.once('error', reject); child.once('close', code => code === 0 ? ready() : reject(new Error(`${command} exited ${code}`)));
  });
}
async function capture(command, args, env, cwd = payload) { return (await execute(command, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 90000, maxBuffer: 8 * 1024 * 1024 })).stdout.trim(); }
async function freePort() {
  const server = createServer(); await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready); });
  const port = server.address().port; await new Promise(ready => server.close(ready)); return port;
}
async function until(operation, accepts, label, limit = 60000) {
  const deadline = Date.now() + limit; while (Date.now() < deadline) { try { const value = await operation(); if (accepts(value)) return value; } catch { /* bounded readiness */ } await delay(150); } throw new Error(label);
}
async function context(project, secrets) {
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const env = { STUDIO_DEPLOY_SECRETS_DIR: secrets, STUDIO_PUBLISHED_PORT: String(port), STUDIO_PUBLIC_URL: `${base}/`, STUDIO_TRUSTED_HOSTS: '' };
  const args = ['compose', '-p', project, '-f', join(payload, 'deploy/compose.yml')];
  const result = { project, secrets, env, args, base, compose: (args2, options = {}) => capture('docker', [...args, ...args2], { ...env, ...options }) };
  contexts.push(result); return result;
}
async function openBrowser(ctx) {
  const announced = await ctx.compose(['exec', '-T', 'studio', 'cat', '/var/lib/harnessstudio/container-login-url']);
  assert.equal(new URL(announced).searchParams.has('token'), false);
  const page = await fetch(`${ctx.base}/`, { redirect: 'error', signal: AbortSignal.timeout(5000) }); assert.equal(page.status, 200); assert.equal(page.headers.get('set-cookie'), null); await page.body?.cancel();
  return { async json(path, body) { const response = await fetch(`${ctx.base}/api/studio/${path}`, { signal: AbortSignal.timeout(10000), method: body === undefined ? 'GET' : 'POST', headers: { origin: ctx.base, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`); return response.json(); } };
}
async function operation(app, taskId, capability, parameters, revision) {
  const { operation } = await app.json('software/invoke', { taskId, imageId: 'mock-solidworks', requestId: randomUUID(), capability, parameters, expectedDocumentRevision: revision });
  const settled = await until(() => app.json(`software/operation?taskId=${taskId}&imageId=mock-solidworks&operationId=${operation.id}`), result => !['queued', 'running'].includes(result.operation.state), 'Mock operation did not settle');
  assert.equal(settled.operation.state, 'succeeded', `Mock ${capability} did not succeed`); return settled.operation;
}

try {
  const release = await createSourceRelease({ sourceRoot: root, outputRoot: join(fixture, 'releases') }); assert.equal(release.metadata.status, 'candidate');
  await mkdir(join(fixture, 'unpacked')); await capture('tar', ['-xzf', release.archive, '-C', join(fixture, 'unpacked')], {}, root);
  payload = join(fixture, 'unpacked/harnessstudio-m6');
  const alias = join(fixture, 'source-directory-alias'); await symlink(payload, alias, 'dir');
  const verified = await capture(process.execPath, [join(alias, 'scripts/release-m6.mjs'), '--verify', alias, '--compose'], {});
  assert.match(verified, /M6 source files.+Compose schema verified/u, 'Actual CLI through an alias must execute the independent static checks');
  await assert.rejects(readFile(join(payload, 'node_modules/react/package.json'))); await assert.rejects(readFile(join(payload, 'deepseek-harness/LICENSE')));
  console.log(`Independent M6 candidate unpacked and verified (${release.fileCount} hashed files; product ${release.metadata.productVersion}, Mock ${release.metadata.buildInputs.mock.softwareVersion}).`);
  const secrets = join(fixture, 'source-secrets'); await mkdir(secrets, { mode: 0o700 });
  const token = randomBytes(32).toString('base64url'), fakeCredential = `m6-not-real-${randomUUID()}`;
  await writeFile(join(secrets, 'mock-seat-token'), token + '\n', { mode: 0o600 }); await writeFile(join(secrets, 'provider.env'), '# No actual model credential or request.\n', { mode: 0o600 });
  const source = await context(sourceProject, secrets);
  await command('docker', [...source.args, 'up', '--build', '--detach', '--wait', '--wait-timeout', '120'], source.env);
  let app = await openBrowser(source);
  assert.deepEqual(await app.json('projects'), [], 'Normal container must start with no legacy seed');
  assert.deepEqual((await app.json('status')).chats, []);
  const project = await app.json('projects', { title: 'M6 source delivery isolated proof' });
  const task = await app.json('task/quick', { projectId: project.id, title: '人工确认合成部署文件' });
  const proofText = 'M6 synthetic delivery proof; not an engineering deliverable.\n';
  await app.json('file', { taskId: task.id, path: 'proof.txt', content: proofText });
  const view = await app.json('models');
  await app.json('models', { id: 'm6-delivery', name: 'M6 fake provider for persistence only', protocol: 'openai-completions', baseURL: 'https://example.invalid/v1', models: ['m6-not-used'], contextWindow: 8192, maxTokens: 512, revision: view.customRevision, apiKey: fakeCredential });
  assert.deepEqual((await app.json(`software/seats?taskId=${task.id}`)).seats, []);
  await app.json('software/seat', { taskId: task.id, imageId: 'mock-solidworks', requestId: randomUUID() });
  const initial = await until(() => app.json(`software/seat?taskId=${task.id}&imageId=mock-solidworks`), result => result.seat?.state === 'ready', 'Explicit Mock did not become ready').then(result => result.seat);
  assert.equal(initial.unknownOperationIndexComplete, true);
  await app.json('software/control', { taskId: task.id, imageId: 'mock-solidworks', action: 'acquire' });
  await operation(app, task.id, 'shape.add', { kind: 'rectangle', x: 10, y: 10, width: 80, height: 50, label: 'synthetic M6 delivery shape' }, 0);
  const exported = await operation(app, task.id, 'document.export', { format: 'json', name: 'm6-delivery-mock.json' }, 1);
  const saved = await app.json('software/artifact', { taskId: task.id, imageId: 'mock-solidworks', artifactId: exported.result.artifactId });
  await app.json('software/control', { taskId: task.id, imageId: 'mock-solidworks', action: 'release' });
  let preview = await app.json(`task/completion?taskId=${task.id}`);
  preview = await app.json('task/completion/files', { taskId: task.id, revision: preview.taskRevision, workspaceVersion: preview.workspaceVersion, files: [{ path: 'proof.txt', description: '合成部署验收文件' }, { path: saved.path, description: '仅为 Mock 流程的 JSON 产物' }] });
  const completed = (await app.json('task/completion', { taskId: task.id, revision: preview.taskRevision, workspaceVersion: preview.workspaceVersion, ...(preview.isFolder ? { childrenVersion: preview.childrenVersion } : {}), checkedGoalIds: preview.goals.filter(row => !row.system).map(row => row.id), submissionId: preview.submittedFiles.id })).task;
  const snapshot = (await app.json(`snapshot/manifest?taskId=${task.id}&snapshotId=${completed.completedId}`)).snapshot;
  const backup = join(fixture, 'backup');
  await command(process.execPath, [join(alias, 'deploy/release-ops.mjs'), 'backup', '--project', sourceProject, '--directory', backup, '--secrets', secrets], source.env);
  await until(() => app.json('projects'), result => result.some(row => row.id === project.id), 'Backup did not resume anonymous access to the original service');
  const restoreSecrets = join(fixture, 'restore-secrets'), target = await context(restoreProject, restoreSecrets);
  await command(process.execPath, [join(alias, 'deploy/release-ops.mjs'), 'restore', '--project', restoreProject, '--directory', backup, '--secrets', restoreSecrets], target.env);
  await command('docker', [...target.args, 'up', '--detach', '--wait', '--no-build', '--wait-timeout', '120'], target.env);
  app = await openBrowser(target);
  assert.equal((await app.json('projects')).some(row => row.id === project.id), true);
  assert.equal((await app.json(`file?taskId=${task.id}&path=proof.txt`)).content, proofText);
  assert.equal((await app.json('models')).providers.find(row => row.id === 'm6-delivery').credentialConfigured, true);
  assert.deepEqual((await app.json(`snapshot/manifest?taskId=${task.id}&snapshotId=${completed.completedId}`)).snapshot, snapshot, 'Immutable submitted snapshot must restore unchanged');
  const restoredSeat = (await app.json(`software/seat?taskId=${task.id}&imageId=mock-solidworks`)).seat;
  assert.equal(restoredSeat.id, initial.id); assert.equal(restoredSeat.document.shapes.length, 1); assert.equal(restoredSeat.unknownOperationIndexComplete, true); assert.equal(restoredSeat.control, null);
  for (const ctx of contexts) { const logs = await ctx.compose(['logs', '--no-color']); assert.equal(logs.includes(token), false); assert.equal(logs.includes(fakeCredential), false); }
  console.log('M6 independent source delivery passed: Linux build, normal anonymous installation, explicit current Mock protocol, annotated submission snapshot, stopped two-volume/secret backup, anonymous resume, and new empty-project restore of Provider/files/snapshot/Mock document. No real model or industrial software used.');
} finally {
  const failures = [];
  for (const ctx of contexts.reverse()) {
    assert.ok(ctx.project.startsWith('studio-m6-'));
    try { await capture('docker', [...ctx.args, 'down', '--volumes', '--remove-orphans'], ctx.env); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, `Could not clean only the M6 delivery fixtures; retained their private configuration at ${fixture}.`);
  await rm(fixture, { recursive: true, force: true });
}
}
