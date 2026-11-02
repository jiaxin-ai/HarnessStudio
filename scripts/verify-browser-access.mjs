import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { request as httpRequest } from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, realpath, readFile, readdir, chmod, rm, lstat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { root, upstream } from './prepare.mjs';

// Use the pinned Gateway's actual WebSocket dependency, without adding a new
// package. No cookie jar, login exchange, Authorization or browser token is used.
const WebSocket = createRequire(join(upstream, 'packages/api/gateway/package.json'))('ws');
const home = await realpath(await mkdtemp(join(tmpdir(), 'harnessstudio-anonymous-test-'))), children = new Set(), sockets = new Set();
const fakeKey = `anonymous-fixture-${randomUUID()}`;
let app;
const displayedMessages = events => events.filter(event => ['user/message', 'assistant/message'].includes(event.type)).map(event => {
  const message = event.data.message ?? event.data; return { type: event.type, id: message.id, content: message.content };
});

async function until(read, ready, message, timeout = 25000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) { try { const value = await read(); if (ready(value)) return value; last = undefined; } catch (error) { last = error; } await delay(40); }
  throw new Error(`${message}${last ? `: ${last.message}` : ''}`);
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const closed = new Promise(resolve => child.once('close', resolve)); child.kill('SIGTERM');
  if (!await Promise.race([closed.then(() => true), delay(10000, false, { ref: false })])) { child.kill('SIGKILL'); await closed; throw new Error('Anonymous fixture shutdown did not finish'); }
}
async function start(port = '0', patch = '') {
  const child = spawn(process.execPath, [join(root, 'scripts/start.mjs')], { cwd: root, env: { ...process.env,
    STUDIO_HOME: home, STUDIO_PORT: port, STUDIO_SMOKE: '1', STUDIO_WORKFLOW_MODE: 'single-user', STUDIO_SYSTEM_PROXY: '0',
    STUDIO_CONFIG_PATCH: patch, STUDIO_SEAT_URL: '', STUDIO_SEAT_TOKEN: '', STUDIO_MOCK_SEAT: '1', STUDIO_MOCK_SEAT_PORT: '0',
    DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child); let output = '', processError;
  child.stdout.on('data', bytes => { output = (output + bytes).slice(-131072); }); child.stderr.on('data', bytes => { output = (output + bytes).slice(-131072); }); child.on('error', error => { processError = error; });
  const announced = await until(() => {
    if (processError) throw processError;
    if (child.exitCode !== null) throw new Error('Isolated anonymous Host exited before startup');
    return output.match(/dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/(?:\?[^\s]+)?)/u)?.[1];
  }, Boolean, 'Isolated anonymous Host did not announce its clean URL');
  const url = new URL(announced); assert.equal(url.searchParams.has('token'), false, 'Normal startup must print a clean URL, not a launch token');
  assert.notEqual(url.port, '53983'); assert.notEqual(url.port, '57063');
  const base = url.origin;
  const call = (path, body, headers = {}) => fetch(`${base}/api/studio/${path}`, { signal: AbortSignal.timeout(15000), method: body === undefined ? 'GET' : 'POST',
    headers: { origin: base, ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const json = async (path, body) => { const response = await call(path, body), source = await response.text(); assert.equal(response.status, 200, `${path}: ${source}`); assert.equal(source.includes(fakeKey), false, 'Browser responses must not echo the saved Provider secret'); return JSON.parse(source); };
  await until(() => fetch(`${base}/api/studio/projects`, { signal: AbortSignal.timeout(3000) }).then(response => response.status), value => value === 200, 'Anonymous Studio API did not become ready');
  return { child, base, call, json, output: () => output };
}
async function wrongHost(base, path) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${base}${path}`, { headers: { host: 'alien.invalid', origin: base }, timeout: 5000 }, response => { response.resume(); response.once('end', () => resolve(response.statusCode)); });
    request.once('error', reject); request.once('timeout', () => request.destroy(new Error('Host check timed out'))); request.end();
  });
}
async function readSSE(path, expected) {
  const abort = new AbortController(), timeout = setTimeout(() => abort.abort(new Error('Anonymous SSE did not return a real packet')), 10000);
  const response = await fetch(`${app.base}/api/studio/${path}`, { headers: { origin: app.base }, signal: abort.signal });
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/event-stream/u);
  const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
  try {
    while (true) {
      const row = await reader.read(); if (row.done) throw new Error('Anonymous SSE ended before its packet'); buffer += decoder.decode(row.value, { stream: true });
      let split; while ((split = buffer.indexOf('\n\n')) >= 0) {
        const source = buffer.slice(0, split); buffer = buffer.slice(split + 2);
        const data = source.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) continue; const value = JSON.parse(data);
        if (value.type === 'error') throw new Error(value.error);
        if (expected(value, source)) return value;
      }
    }
  } finally { clearTimeout(timeout); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function websocket(headers = {}, ready = false) {
  if (!ready) return new Promise((resolve, reject) => {
    const outgoing = httpRequest(`${app.base}/api/remote.mux`, { headers: { origin: app.base, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': randomBytes(16).toString('base64'), ...headers }, timeout: 5000 }, response => { response.resume(); response.once('end', () => resolve({ status: response.statusCode })); });
    outgoing.on('error', reject); outgoing.once('timeout', () => outgoing.destroy(new Error('Rejected WebSocket handshake timed out')));
    outgoing.on('upgrade', (response, socket) => { socket.destroy(); resolve({ status: response.statusCode }); }); outgoing.end();
  });
  const url = app.base.replace(/^http/u, 'ws') + '/api/remote.mux', socket = new WebSocket(url, { headers: { origin: app.base, ...headers }, handshakeTimeout: 5000 }); sockets.add(socket);
  const streamId = `anonymous-${randomUUID()}`; let upgradeStatus;
  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { socket.terminate(); reject(new Error('Anonymous WebSocket/Remote stream timed out')); }, 10000);
      const settle = value => { clearTimeout(timeout); resolve(value); };
      socket.on('error', error => { clearTimeout(timeout); reject(error); });
      socket.on('upgrade', response => { upgradeStatus = response.statusCode; });
      socket.on('unexpected-response', (request, response) => { const status = response.statusCode; request.on('error', () => {}); response.resume(); settle({ status }); request.destroy(); });
      socket.on('open', () => { if (!ready) settle({ status: upgradeStatus }); else socket.send(JSON.stringify({ type: 'open', streamId, endpoint: '$events', payload: { args: {} } })); });
      socket.on('message', bytes => {
        try { const frame = JSON.parse(bytes.toString()); if (frame.streamId !== streamId) return;
          if (frame.type === 'error') { clearTimeout(timeout); reject(new Error(`Real Remote stream rejected: ${frame.error?.code}`)); }
          if (frame.type === 'item' && frame.value?.type === 'ready') { assert.equal(typeof frame.value.clientId, 'string'); socket.send(JSON.stringify({ type: 'cancel', streamId })); settle({ status: upgradeStatus, ready: true }); }
        } catch (error) { clearTimeout(timeout); reject(error); }
      });
    });
  } finally {
    socket.on('error', () => {});
    const closed = new Promise(resolve => socket.once('close', resolve));
    if (socket.readyState === WebSocket.OPEN) socket.close(); else socket.terminate();
    if (!await Promise.race([closed.then(() => true), delay(1000, false, { ref: false })])) socket.terminate(); sockets.delete(socket);
  }
}
async function sourceFences(includeWebsocket = false) {
  assert.equal((await app.call('projects', undefined, { origin: 'https://alien.invalid' })).status, 403);
  assert.equal(await wrongHost(app.base, '/api/studio/projects'), 403);
  assert.equal(await wrongHost(app.base, '/'), 403);
  if (includeWebsocket) {
    assert.equal((await websocket({ origin: 'https://alien.invalid' })).status, 403);
    assert.equal((await websocket({ host: 'alien.invalid' })).status, 403);
    assert.deepEqual(await websocket({}, true), { status: 101, ready: true }, 'No-cookie WebSocket must carry a real Gateway logical stream');
  }
}
async function unlock(path) { const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) return; await chmod(path, 0o700); for (const row of await readdir(path)) await unlock(join(path, row)); }

try {
  console.log('Anonymous fixture: starting isolated normal Host.');
  app = await start();
  console.log('Anonymous fixture: checking clean homepage and source fences.');
  const index = await fetch(`${app.base}/`, { redirect: 'manual' }); assert.equal(index.status, 200); assert.equal(index.headers.get('set-cookie'), null); assert.match(await index.text(), /<html|<!doctype/u);
  const legacy = await fetch(`${app.base}/?token=unused-bookmark&view=project`, { redirect: 'manual' }); assert.equal(legacy.status, 303); assert.equal(legacy.headers.get('set-cookie'), null); assert.equal(new URL(legacy.headers.get('location'), app.base).searchParams.has('token'), false);
  await sourceFences();
  console.log('Anonymous fixture: verifying project, file, Provider and stream access.');
  const project = await app.json('projects', { title: '匿名浏览器隔离验收项目' }), task = await app.json('task/quick', { projectId: project.id, title: '匿名文件与软件任务' }), content = 'Anonymous access synthetic fixture, not a CAD deliverable.\n';
  await app.json('file', { taskId: task.id, path: 'proof.txt', content }); assert.equal((await app.json(`file?taskId=${task.id}&path=proof.txt`)).content, content);
  const modelView = await app.json('models'); await app.json('models', { id: 'anonymous-fixture', name: 'Anonymous fixture Provider', protocol: 'openai-completions', baseURL: 'https://example.invalid/v1', models: ['anonymous-test-model'], contextWindow: 8192, maxTokens: 512, revision: modelView.customRevision, apiKey: fakeKey });
  assert.equal((await app.json('models')).providers.find(row => row.id === 'anonymous-fixture').credentialConfigured, true);
  for (const route of ['task?id=unknown', 'chat?id=unknown', 'chat/stream?id=unknown', `software/events?taskId=${task.id}&imageId=mock-solidworks`]) assert.equal((await app.call(route)).status, 400, `${route} must reach business validation without browser authentication`);
  const chat = await app.json('chat', { projectId: project.id, provider: 'studio-smoke', model: 'm1-smoke', message: '[project-chat-only] Anonymous native chat protocol fixture.' });
  const history = await until(() => app.json(`chat?id=${chat.id}`), row => row.status === 'idle' && row.events.some(event => event.type === 'turn/end'), 'Anonymous native chat did not finish');
  const snapshot = await readSSE(`chat/stream?id=${chat.id}`, value => value.type === 'snapshot'); assert.equal(snapshot.chat.id, chat.id); assert.deepEqual(displayedMessages(snapshot.chat.events), displayedMessages(history.events));
  const allocation = await app.json('software/seat', { taskId: task.id, imageId: 'mock-solidworks', requestId: randomUUID() });
  const { seat } = await until(() => app.json(`software/seat?taskId=${task.id}&imageId=mock-solidworks`), value => value.seat?.state === 'ready', 'Anonymous software Seat did not become ready'); assert.equal(seat.id, allocation.seat.id);
  await readSSE(`software/events?taskId=${task.id}&imageId=mock-solidworks`, (_value, source) => source.includes('event: refresh'));
  await app.json('software/control', { taskId: task.id, imageId: 'mock-solidworks', action: 'acquire' });
  const invoked = await app.json('software/invoke', { taskId: task.id, imageId: 'mock-solidworks', requestId: randomUUID(), capability: 'shape.add', parameters: { kind: 'rectangle', x: 1, y: 2, width: 3, height: 4, label: 'Anonymous fixture' }, expectedDocumentRevision: 0 });
  await until(() => app.json(`software/operation?taskId=${task.id}&imageId=mock-solidworks&operationId=${invoked.operation.id}`), value => value.operation.state === 'succeeded', 'Anonymous Bridge did not finish');
  await app.json('software/control', { taskId: task.id, imageId: 'mock-solidworks', action: 'release' });
  const mock = JSON.parse(await readFile(join(home, 'mock-seat/runtime.json'), 'utf8')); assert.equal((await fetch(mock.url + '/v1/images')).status, 401); assert.equal((await fetch(mock.url + '/v1/images', { headers: { authorization: 'Bearer invalid' } })).status, 401);
  const port = new URL(app.base).port; assert.equal(app.output().includes('?token='), false); assert.equal(app.output().includes(fakeKey), false); await stop(app.child); app = await start(port);
  assert.equal((await fetch(`${app.base}/`)).status, 200); await sourceFences();
  assert.ok((await app.json('projects')).some(row => row.id === project.id)); assert.equal((await app.json(`file?taskId=${task.id}&path=proof.txt`)).content, content);
  assert.equal((await app.json('models')).providers.find(row => row.id === 'anonymous-fixture').credentialConfigured, true);
  assert.deepEqual((await app.json(`chat?id=${chat.id}`)).events, history.events); assert.equal((await readSSE(`chat/stream?id=${chat.id}`, value => value.type === 'snapshot')).chat.id, chat.id);
  const restored = (await app.json(`software/seat?taskId=${task.id}&imageId=mock-solidworks`)).seat; assert.equal(restored.id, seat.id); assert.equal(restored.document.shapes[0].label, 'Anonymous fixture'); assert.equal(restored.control, null);
  const restartedMock = JSON.parse(await readFile(join(home, 'mock-seat/runtime.json'), 'utf8')); assert.equal((await fetch(restartedMock.url + '/v1/images')).status, 401);
  console.log('Anonymous ordinary product Host passed without cookies/tokens: homepage, project/task/file/redacted-models, native chat/SSE, software/SSE, HTTP Host/Origin refusals, Mock Bearer boundary and two-process restart persistence.');
  // The minimal product exposes its streams through SSE, not remote.mux. Test
  // compatibility with that official optional WS carrier in a fixture-only
  // overlay, without widening any normal product configuration or RPC surface.
  const overlay = join(home, 'anonymous-ws-carrier.patch.yml');
  await writeFile(overlay, '- insert:\n    - id: anonymous-test-native-registry\n      name: "@deepseek-ai/dsh-typert-registry"\n    - id: anonymous-test-native-gateway\n      name: "@deepseek-ai/dsh-api-gateway"\n    - id: anonymous-test-native-remotes\n      name: "@deepseek-ai/dsh-api-remotes"\n', { mode: 0o600 });
  await stop(app.child); app = await start(port, overlay); await sourceFences(true);
  console.log('Fixture-only official optional WS carrier also passed: actual /api/remote.mux 101 and logical $events ready without cookies/tokens, plus alien Host/Origin 403. No shared config, user projects or preview services were touched. Synthetic Provider was used only for isolated native chat.');
} finally {
  for (const socket of sockets) socket.terminate(); for (const child of children) await stop(child); await unlock(home); await rm(home, { recursive: true, force: true });
}
