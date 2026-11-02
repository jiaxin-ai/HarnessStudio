import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { root, upstream, upstreamCommit } from './prepare.mjs';

await mkdir(join(root, '.studio'), { recursive: true });
const home = await mkdtemp(join(root, '.studio', 'm1-test-'));
let server;
const results = [];
const fakeKey = 'studio-test-key-not-a-real-credential';
const wireRequests = [];
const modelServer = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk.toString();
  const data = JSON.parse(body);
  wireRequests.push({ path: request.url, authorization: request.headers.authorization, data });
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: 'chatcmpl-studio-test', object: 'chat.completion.chunk', created: 1,
    model: 'studio-test-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  chunk({ role: 'assistant', content: 'Provider configuration reached the local test endpoint.' });
  chunk({}, 'stop'); response.end('data: [DONE]\n\n');
});
await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
const modelBase = `http://127.0.0.1:${modelServer.address().port}/v1`;
async function start(smoke) {
  const child = spawn(process.execPath, [join(root, 'scripts/start.mjs')], {
    cwd: root, env: { ...process.env, STUDIO_HOME: home, STUDIO_PORT: '0', STUDIO_SMOKE: smoke ? '1' : '0', STUDIO_CONFIG_PATCH: smoke ? '' : join(root, 'config/legacy-test.patch.yml') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server = child;
  let output = '';
  const append = chunk => { output += chunk.toString(); };
  child.stdout.on('data', append); child.stderr.on('data', append);
  const deadline = Date.now() + 20000;
  let url;
  while (Date.now() < deadline) {
    url = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/)/)?.[1];
    if (url) break;
    if (child.exitCode !== null) throw new Error(output);
    await delay(50);
  }
  assert.ok(url, 'DSH failed to become ready');
  assert.doesNotMatch(output, /Failed plugins|startup failed/);
  const base = new URL(url).origin;
  async function call(path, body, extraHeaders = {}) {
    return fetch(`${base}/api/studio/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin: base, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extraHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function json(path, body) {
    const response = await call(path, body);
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  }
  const readyDeadline = Date.now() + 20000;
  while (Date.now() < readyDeadline && (await call('status')).status !== 200) await delay(50);
  assert.equal((await call('status')).status, 200, 'Anonymous Studio routes did not become ready');
  return { child, base, call, json, output: () => output };
}

async function stop(child) {
  if (child.exitCode !== null) return;
  const closed = new Promise(resolve => child.once('close', resolve));
  child.kill('SIGTERM');
  const timed = delay(10000, undefined, { ref: false }).then(() => false);
  if (await Promise.race([closed.then(() => true), timed]) === false) {
    child.kill('SIGKILL'); await closed; throw new Error('DSH did not stop cleanly');
  }
}

async function finished(app, id, previousTurns = 0) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const value = await app.json(`chat?id=${id}`);
    if (value.status === 'idle' && value.events.filter(event => event.type === 'turn/end').length > previousTurns) return value;
    await delay(70);
  }
  throw new Error(`Chat did not finish: ${id}`);
}

async function allEntries(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    paths.push(path);
    if (entry.isDirectory()) paths.push(...await allEntries(path));
  }
  return paths;
}

try {
  let app = await start(false);
  const status = await app.json('status');
  const studioTools = ['ask_user_question', 'studio_apply_graph_patch', 'studio_browser_read', 'studio_create_task', 'studio_delete_file', 'studio_download_temp_file', 'studio_extract_temp_zip', 'studio_graph_context', 'studio_list_project_files', 'studio_list_temp_files', 'studio_retrieve_context', 'studio_project_context', 'studio_read_checklist', 'studio_read_file', 'studio_read_project_file', 'studio_read_temp_file', 'studio_search_temp_file', 'studio_software_cancel', 'studio_software_catalog', 'studio_software_control', 'studio_software_invoke', 'studio_software_launch', 'studio_software_operation', 'studio_software_save_artifact', 'studio_software_status', 'studio_task_context', 'studio_update_checklist', 'studio_write_file', 'studio_write_temp_file', 'web_fetch', 'web_search'];
  assert.deepEqual([...status.tools].sort(), studioTools.toSorted());
  assert.ok(!status.providers.some(provider => provider.id === 'studio-smoke'));
  assert.equal((await fetch(`${app.base}/api/studio/status`)).status, 200);
  assert.equal((await app.call('status', undefined, { origin: 'https://untrusted.invalid' })).status, 403);
  assert.equal((await app.call('m1/purge', { taskId: 'm1-gear' })).status, 404);
  const page = await fetch(app.base, { redirect: 'manual' });
  assert.equal(page.status, 200); assert.deepEqual(page.headers.getSetCookie(), []);
  const html = await page.text();
  assert.match(html, /@harnessstudio\/ui/);
  await app.json('file', { taskId: 'm1-gear', path: 'manual.md', content: 'manual without model' });
  assert.equal((await app.json('file?taskId=m1-gear&path=manual.md')).content, 'manual without model');
  assert.equal((await app.call('file', { taskId: 'm1-gear', path: '../m1-bearing/bad.md', content: 'bad' })).status, 400);
  results.push('Default profile: task and chat-scoped tools plus web access, manual file IO, anonymous same-origin API, Origin check, Client graph, no smoke purge endpoint');

  const originalModels = await app.json('models');
  assert.equal((await fetch(`${app.base}/api/studio/models`)).status, 200);
  const providerInput = { id: 'studio-config-test', name: 'Local configuration test', protocol: 'openai-completions', baseURL: modelBase,
    models: ['studio-test-model'], contextWindow: 8192, maxTokens: 512, revision: originalModels.customRevision, apiKey: fakeKey };
  assert.equal((await app.call('models', { ...providerInput, baseURL: 'https://user:password@example.invalid/v1' })).status, 400);
  const configured = await app.json('models', providerInput);
  assert.ok(!JSON.stringify(configured).includes(fakeKey));
  const storedProvider = configured.providers.find(provider => provider.id === providerInput.id);
  assert.equal(storedProvider.credentialConfigured, true);
  assert.equal(storedProvider.models[0].id, 'studio-test-model');
  assert.equal((await stat(join(home, '.credentials.yaml'))).mode & 0o777, 0o600);
  assert.ok(!(await readFile(join(home, 'profiles', 'studio', 'cordis.patch.yml'), 'utf8')).includes(fakeKey));
  assert.equal((await app.call('models', { ...providerInput, name: 'stale edit' })).status, 400);
  const chosen = await app.json('models/default', { provider: providerInput.id, model: 'studio-test-model', revision: configured.defaultsRevision });
  assert.deepEqual(chosen.defaults, { provider: providerInput.id, model: 'studio-test-model' });
  const configuredChat = await app.json('chat', { taskId: 'm1-bearing', provider: providerInput.id, model: 'studio-test-model', message: 'Verify saved Provider configuration.' });
  const configuredTurn = await finished(app, configuredChat.id);
  assert.ok(configuredTurn.events.some(event => event.type === 'assistant/message' && JSON.stringify(event.data).includes('local test endpoint')));
  assert.equal(wireRequests[0].path, '/v1/chat/completions');
  assert.equal(wireRequests[0].authorization, `Bearer ${fakeKey}`);
  assert.equal(wireRequests[0].data.model, 'studio-test-model');
  const taskTools = studioTools.filter(name => name !== 'studio_project_context').toSorted();
  assert.deepEqual(wireRequests[0].data.tools.map(tool => tool.function.name).sort(), taskTools, 'Task model requests must allow bound child creation and omit project-only context');
  assert.ok(!JSON.stringify(configuredTurn).includes(fakeKey));
  const updated = await app.json('models', { ...providerInput, name: 'Renamed local test', revision: storedProvider.revision, apiKey: undefined });
  assert.equal(updated.providers.find(provider => provider.id === providerInput.id).credentialConfigured, true);
  await app.json('chat', { taskId: 'm1-bearing', id: configuredChat.id, provider: providerInput.id, model: 'studio-test-model', message: 'Verify blank key keeps the existing credential.' });
  await finished(app, configuredChat.id, 1);
  assert.equal(wireRequests.length, 2);
  assert.equal(wireRequests.at(-1).authorization, `Bearer ${fakeKey}`);
  assert.equal((await app.call('chat', { taskId: 'm1-bearing', id: configuredChat.id, provider: 'deepseek-official', model: 'other-model', message: 'Model mismatch' })).status, 400);
  assert.equal((await app.call('models/default', { provider: providerInput.id, model: 'unknown', revision: updated.defaultsRevision })).status, 400);
  assert.ok(!app.output().includes(fakeKey));
  results.push('Provider settings: anonymous same-origin writes, redacted reads, 0600 credentials, stale-edit rejection, default selection, live official pi-ai routing and blank-key preservation');
  await stop(app.child);

  app = await start(true);
  const restoredModels = await app.json('models');
  assert.deepEqual(restoredModels.defaults, { provider: providerInput.id, model: 'studio-test-model' });
  assert.equal(restoredModels.providers.find(provider => provider.id === providerInput.id).name, 'Renamed local test');
  assert.equal(restoredModels.providers.find(provider => provider.id === providerInput.id).credentialConfigured, true);
  assert.deepEqual((await app.json('status')).defaults, restoredModels.defaults);
  await app.json('chat', { taskId: 'm1-bearing', id: configuredChat.id, provider: providerInput.id, model: 'studio-test-model', message: 'Verify saved Provider after restart.' });
  await finished(app, configuredChat.id, 2);
  assert.equal(wireRequests.length, 3);
  assert.equal(wireRequests.at(-1).authorization, `Bearer ${fakeKey}`);
  results.push('Provider endpoint, model catalog, credentials and defaults persist across restart and can resume the original chat');
  const good = await app.json('chat', { taskId: 'm1-gear', provider: 'studio-smoke', model: 'm1-smoke', message: 'Run M1 tool proof' });
  const settled = await finished(app, good.id);
  const calls = settled.events.filter(event => event.type === 'tool/call');
  assert.deepEqual(calls.map(event => event.data.name), ['studio_write_file', 'studio_read_file']);
  assert.equal((await app.json('file?taskId=m1-gear&path=m1-proof.txt')).content, 'M1：通过 DSH 工具调用创建的齿轮参数记录（测试数据）。');
  assert.ok(settled.events.some(event => event.type === 'system/message' && JSON.stringify(event.data).includes('规划与操作')));
  const resultsInLog = settled.events.filter(event => event.type === 'tool/result');
  assert.equal(resultsInLog.length, 2);
  assert.ok(resultsInLog.every(event => !event.data.isError), JSON.stringify(resultsInLog));
  results.push('Official Agent loop executed Studio write/read tools and persisted prompt, calls, results and turn boundaries');

  const escaped = await app.json('chat', { taskId: 'm1-gear', provider: 'studio-smoke', model: 'm1-smoke', message: '[escape]' });
  const denied = await finished(app, escaped.id);
  assert.ok(denied.events.some(event => event.type === 'tool/result' && JSON.stringify(event.data).includes('traversal')));
  assert.equal((await app.call('file?taskId=m1-bearing&path=forbidden.txt')).status, 400);
  results.push('Model-side path traversal rejected through DSH tool execution');

  const kept = await app.json('chat', { taskId: 'm1-bearing', provider: 'studio-smoke', model: 'm1-smoke', message: 'Keep the independent bearing workspace' });
  await finished(app, kept.id);
  const slow = await app.json('chat', { taskId: 'm1-gear', provider: 'studio-smoke', model: 'm1-smoke', message: '[slow]' });
  assert.equal((await app.call('m1/purge', { taskId: 'm1-gear' })).status, 400);
  const preview = await app.json('m1/purge-preview', { taskId: 'm1-gear' });
  await app.json('m1/purge', { taskId: 'm1-gear', confirmation: preview.confirmation });
  assert.equal((await app.call('m1/purge', { taskId: 'm1-gear', confirmation: preview.confirmation })).status, 400);
  for (const id of [good.id, escaped.id, slow.id]) {
    assert.equal((await app.call(`chat?id=${id}`)).status, 400);
    assert.ok(!(await allEntries(join(home, 'studio', 'sessions'))).some(path => path.endsWith(`/${id}`)));
  }
  const removedBindings = await readFile(join(home, 'studio', 'chats.json'), 'utf8');
  for (const id of [good.id, escaped.id, slow.id]) assert.ok(!removedBindings.includes(id));
  assert.equal((await app.call('file?taskId=m1-gear&path=m1-proof.txt')).status, 400);
  assert.equal((await app.json('file?taskId=m1-bearing&path=m1-proof.txt')).content, 'M1：通过 DSH 工具调用创建的齿轮参数记录（测试数据）。');
  await delay(150);
  assert.equal((await app.call('file?taskId=m1-gear&path=m1-proof.txt')).status, 400);
  results.push('Test-only confirmed purge stops a running Agent, removes files/Session directories/bindings, rejects reuse, and preserves another task');
  await stop(app.child);

  app = await start(true);
  const cold = await app.json(`chat?id=${kept.id}`);
  assert.equal(cold.status, 'stored');
  assert.ok(cold.events.some(event => event.type === 'assistant/message'));
  await app.json('chat', { taskId: 'm1-bearing', id: kept.id, provider: 'studio-smoke', model: 'm1-smoke', message: 'Resume persisted chat' });
  const resumed = await finished(app, kept.id);
  assert.ok(resumed.events.length > cold.events.length);
  assert.equal((await app.call('chat', { taskId: 'm1-gear', id: kept.id, provider: 'studio-smoke', model: 'm1-smoke', message: 'Wrong task' })).status, 400);
  results.push('Restart reads persisted Session, resumes its scoped preset, and rejects cross-task chat binding');
  await stop(app.child);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: upstream, encoding: 'utf8' }).trim(), upstreamCommit);
  assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: upstream, encoding: 'utf8' }).trim(), '');
  results.push('Pinned upstream source remains unchanged');
  console.log(JSON.stringify({ milestone: 'M1', results }, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (server?.exitCode === null) await stop(server);
  await new Promise(resolve => modelServer.close(resolve));
  await rm(home, { recursive: true, force: true });
}
