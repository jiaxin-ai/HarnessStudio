import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startApp, stopApp } from './verify-app.mjs';

// A disposable real Studio Host and native HTTP/SSE model adapter. No external
// provider keys, production projects or engineering claims enter this fixture.
const home = await realpath(await mkdtemp('/private/tmp/studio-file-description-http-'));
const previewMode = process.argv.includes('--preview');
const model = { provider: 'file-description-fixture', model: 'description-only' }, requests = [];
let app;
const server = createServer(async (request, response) => {
  try {
    const pieces = []; let bytes = 0;
    for await (const piece of request) { bytes += piece.length; if (bytes > 64 * 1024) throw new Error('Oversized auxiliary request'); pieces.push(piece); }
    const payload = JSON.parse(Buffer.concat(pieces).toString('utf8'));
    assert.equal(payload.model, model.model);
    assert.ok(!payload.tools?.length, 'Auxiliary generation must never receive executable tools');
    assert.equal(payload.messages.length, 2, 'Only the dedicated system prompt and bounded file data are sent');
    assert.equal(payload.messages[0].role, 'system'); assert.match(payload.messages[0].content, /最多30个字符/);
    assert.equal(payload.messages[1].role, 'user');
    const input = JSON.parse(payload.messages[1].content);
    assert.ok(Buffer.byteLength(input.content, 'utf8') <= 8192);
    assert.ok(!input.content.includes('PRIVATE_CHAT_SENTINEL'));
    requests.push({ payload, input });
    const description = input.content.includes('第二版') ? '第二版报告：更新负载计算与校核结果' : input.path === 'notes.md' ? '记录设计方案与后续待确认事项' : '第一版报告：整理尺寸与材料设计依据'.repeat(3);
    await delay(100);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: `description-fixture-${requests.length}`, object: 'chat.completion.chunk', model: payload.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    response.end(chunk({ role: 'assistant', content: description }) + chunk({}, 'stop') + 'data: [DONE]\n\n');
  } catch (error) { response.writeHead(500); response.end(`Synthetic auxiliary fixture failed: ${error.message}`); }
});
const query = (path, fields) => `${path}?${new URLSearchParams(fields)}`;
async function eventually(read, expected, label = 'background description', timeout = 10000) {
  const deadline = Date.now() + timeout; let value;
  while (Date.now() < deadline) { value = await read(); if (expected(value)) return value; await delay(40); }
  assert.fail(`${label} did not settle: ${JSON.stringify(value)}`);
}
async function release(path) {
  const info = await lstat(path); if (info.isSymbolicLink()) return;
  if (info.isDirectory()) { await chmod(path, 0o700); for (const name of await readdir(path)) await release(join(path, name)); }
  else await chmod(path, 0o600);
}
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  app = await startApp(home);
  const project = await app.json('projects', { title: '自动提交说明验收（合成）' });
  const task = await app.json('task/quick', { projectId: project.id, title: '整理合成设计报告' });
  await app.json('task/metadata', { id: task.id, revision: task.revision, title: task.title, goal: '核对合成报告与人工提交说明', checklist: [{ text: '报告内容与提交说明一致' }] });
  const preview = () => app.json(query('task/completion', { taskId: task.id }));
  const hint = async path => (await preview()).files.find(row => row.path === path)?.submissionDescription;
  const write = (path, content) => app.json('file', { taskId: task.id, path, content });
  const submit = (value, files) => app.json('task/completion/files', { taskId: task.id, revision: value.taskRevision, workspaceVersion: value.workspaceVersion, files });
  const workspace = join(home, 'studio', 'workspaces', task.id);

  // An unconfigured provider has a useful, nonempty immediate fallback.
  await write('baseline.md', '# 原有资料\n不应在启动时批量发起模型请求');
  const fallback = await eventually(() => hint('baseline.md'), value => value?.status === 'fallback');
  assert.ok(fallback.text && Array.from(fallback.text).length <= 30); assert.equal(requests.length, 0);

  const models = await app.json('models');
  const configured = await app.json('models', { id: model.provider, name: 'Isolated synthetic file-description fixture', protocol: 'openai-completions',
    baseURL: `http://127.0.0.1:${server.address().port}/v1`, models: [model.model], apiKey: 'local-fixture-not-a-real-secret', contextWindow: 64000, maxTokens: 512, revision: models.customRevision });
  await app.json('models/default', { ...model, revision: configured.defaultsRevision });
  await stopApp(app.child); app = undefined;
  await writeFile(join(workspace, 'unvisited-old.md'), '旧工作文件在启动时仅保留，不主动调用模型');
  app = await startApp(home); await delay(800);
  assert.equal(requests.length, 0, 'Startup must not bulk-generate descriptions for existing workspaces');
  assert.deepEqual(await hint('baseline.md'), fallback, 'Persisted fallback metadata survives startup');
  // A missing historical hint can be generated lazily when a user asks for a
  // completion preview. This is deliberate and distinct from a startup batch.
  await eventually(() => hint('unvisited-old.md'), value => value?.status === 'generated');
  const baselineCalls = requests.length;

  const saved = await write('report.md', '# 第一版报告\n实际尺寸与材料依据。' + '受控文字'.repeat(3000));
  const first = await preview(), pending = first.files.find(row => row.path === 'report.md').submissionDescription;
  assert.equal(pending.status, 'pending'); assert.equal(pending.version, saved.version); assert.ok(Array.from(pending.text).length <= 30);
  const generated = await eventually(() => hint('report.md'), value => value?.status === 'generated');
  assert.equal(Array.from(generated.text).length, 30, 'Long native output is bounded to 30 Unicode characters');
  assert.equal(requests.length, baselineCalls + 1);
  const reportRequest = requests.findLast(row => row.input.path === 'report.md'); assert.ok(reportRequest.input.content.startsWith('# 第一版报告'));
  const excerptBytes = Buffer.byteLength(reportRequest.input.content, 'utf8');
  assert.ok(excerptBytes >= 8189 && excerptBytes <= 8192, 'UTF-8 excerpt preserves complete characters within the 8 KiB budget');
  await Promise.all(Array.from({ length: 5 }, () => preview())); await delay(600); assert.equal(requests.length, baselineCalls + 1, 'Repeated previews must deduplicate the same file version');
  const untouched = await submit(await preview(), [{ path: 'report.md', description: pending.text }]);
  assert.equal(untouched.submittedFiles.files.find(row => row.path === 'report.md').description, pending.text, 'Untouched textarea submits the exact visible placeholder even if the background has since regenerated it');
  assert.notEqual(pending.text, generated.text, 'The fixture must exercise a genuinely newer background suggestion');
  const originalCommit = untouched.submittedFiles;
  assert.equal(await readFile(join(home, 'studio', 'file-submissions', task.id, originalCommit.id, 'files', 'report.md'), 'utf8'), saved.content);
  const compatible = await submit(await preview(), [{ path: 'report.md' }]);
  assert.equal(compatible.submittedFiles.files.find(row => row.path === 'report.md').description, generated.text, 'API clients that omit description retain current-hint compatibility');

  const old = await preview(); await write('report.md', '# 第二版报告\n更新负载计算与校核结果。');
  assert.equal((await app.call('task/completion/files', { taskId: task.id, revision: old.taskRevision, workspaceVersion: old.workspaceVersion, files: [{ path: 'report.md' }] })).status, 400, 'Changed workspaces reject stale preview submissions');
  const changed = await eventually(() => hint('report.md'), value => value?.status === 'generated' && value.version !== generated.version);
  assert.notEqual(changed.text, generated.text); assert.ok(Array.from(changed.text).length <= 30);
  const automaticRevision = await submit(await preview(), [{ path: 'report.md' }]);
  assert.equal(automaticRevision.submittedFiles.files.find(row => row.path === 'report.md').description, changed.text);
  assert.equal((await readFile(join(home, 'studio', 'file-submissions', task.id, originalCommit.id, 'files', 'report.md'), 'utf8')), saved.content, 'Regeneration never rewrites previous immutable submissions');
  const manual = '用户亲自填写的报告说明';
  const edited = await submit(await preview(), [{ path: 'report.md', description: manual }]);
  assert.equal(edited.submittedFiles.files.find(row => row.path === 'report.md').description, manual, 'Manual text overrides the generated placeholder');
  const current = await preview();
  assert.equal((await app.call('task/completion/files', { taskId: task.id, revision: current.taskRevision, workspaceVersion: current.workspaceVersion, files: [{ path: 'report.md', description: '' }] })).status, 400, 'An intentionally cleared edit must not silently become an automatic description');

  await mkdir(join(workspace, '.chat-tmp', 'private-fixture'), { recursive: true });
  await writeFile(join(workspace, '.chat-tmp', 'private-fixture', 'private.md'), 'PRIVATE_CHAT_SENTINEL');
  await writeFile(join(workspace, 'notes.md'), '# 设计笔记\n软件直接写入的真实受控文本。');
  const notes = await eventually(() => hint('notes.md'), value => value?.status === 'generated');
  assert.equal(notes.text, '记录设计方案与后续待确认事项');
  assert.equal(requests.some(row => row.input.path.includes('.chat-tmp')), false);
  assert.equal((await preview()).files.some(row => row.path.includes('.chat-tmp')), false);
  const finalCalls = requests.length;
  await stopApp(app.child); app = undefined; app = await startApp(home); await delay(800);
  assert.equal(requests.length, finalCalls, 'Restart does not regenerate current cached descriptions');
  assert.deepEqual(await hint('report.md'), changed); assert.deepEqual(await hint('notes.md'), notes);
  assert.equal((await preview()).submittedFiles.files.find(row => row.path === 'report.md').description, manual);
  assert.equal((await app.json('status')).chats.length, 0, 'Auxiliary generation creates neither user conversations nor fake conversation history');
  console.log(`File-description HTTP verification passed: native dedicated bounded request, <=30-character suggestions, immediate fallback, startup baseline, deduplication, current-version refresh and CAS, untouched/manual/empty edit submission, immutable commit preservation, external producer/private-scratch isolation and restart persistence (${requests.length} synthetic model requests).`);
  if (previewMode) {
    console.log(JSON.stringify({ preview: app.url, home, projectId: project.id, taskId: task.id, code: task.code, remainingUnsubmitted: ['baseline.md', 'notes.md', 'unvisited-old.md'] }));
    await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
  }
} finally {
  if (app) await stopApp(app.child);
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await release(home); await rm(home, { recursive: true, force: true });
}
