import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, chmod, readdir, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { root } from './prepare.mjs';
import { startApp, stopApp, finishedChat } from './verify-app.mjs';

// An isolated keyless fixture proves transport, actual model-readable image bytes and scope ownership.
await mkdir(join(root, '.studio'), { recursive: true });
const home = await mkdtemp(join(root, '.studio/reference-upload-test-'));
const dataRoot = join(home, 'studio'); let app;
const wireRequests = [];
const modelServer = createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += chunk.toString();
  const payload = JSON.parse(body); wireRequests.push({ path: request.url, payload });
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: 'chatcmpl-attachment-fixture', object: 'chat.completion.chunk', created: 1, model: payload.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  chunk({ role: 'assistant', content: 'Actual image bytes reached the local OpenAI-compatible provider endpoint.' }); chunk({}, 'stop'); response.end('data: [DONE]\n\n');
});
const model = { provider: 'studio-vision-smoke', model: 'vision-smoke' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC', 'base64');
const image = name => ({ name, mediaType: 'image/png', data: png.toString('base64') });
const query = (id, attachmentId, page) => `chat/attachment?${new URLSearchParams({ id, attachmentId, ...(page === undefined ? {} : { page: String(page) }) })}`;
const probe = (count, names) => `[attachment-probe] ${JSON.stringify({ expectedImages: count, ...(names ? { expectedNames: names } : {}) })}`;
const messageText = event => (event.data?.message?.content ?? event.data?.content)?.flatMap(block => block.type === 'text' ? [block.text] : []).join('') ?? '';
async function rejected(path, body, expression) { const response = await app.call(path, body); assert.equal(response.status, 400, path); const result = await response.json(); if (expression) assert.match(result.error, expression); return result; }
async function release(path) { await chmod(path, 0o700); for (const row of await readdir(path, { withFileTypes: true })) if (row.isDirectory() && !row.isSymbolicLink()) await release(join(path, row.name)); }
function pdf(pages) {
  const fontId = 3 + 2 * pages;
  const objects = [`<< /Type /Catalog /Pages 2 0 R >>`, `<< /Type /Pages /Count ${pages} /Kids [${Array.from({ length: pages }, (_, n) => `${3 + 2 * n} 0 R`).join(' ')}] >>`];
  for (let n = 0; n < pages; n++) { objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 180] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${4 + n * 2} 0 R >>`); const drawing = '0.2 0.4 0.8 rg 20 20 180 120 re f\n0 0 0 rg BT /F1 14 Tf 20 155 Td (CAD REFERENCE 123) Tj ET\n'; objects.push(`<< /Length ${Buffer.byteLength(drawing)} >>\nstream\n${drawing}endstream`); }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let result = '%PDF-1.4\n', offsets = [0]; objects.forEach((object, n) => { offsets.push(Buffer.byteLength(result)); result += `${n + 1} 0 obj\n${object}\nendobj\n`; }); const xref = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`; return Buffer.from(result);
}
try {
  await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
  app = await startApp(home);
  assert.equal((await fetch(`${app.base}/api/studio/chat/attachments?id=unknown`)).status, 400);
  assert.equal((await fetch(`${app.base}/api/studio/chat/attachment?id=unknown&attachmentId=unknown`)).status, 400);
  const project = await app.json('projects', { title: 'CAD CAE EDA 参考上传隔离验证' });
  const base = { projectId: project.id, ...model };
  const originalModels = await app.json('models'), native = originalModels.providers.find(row => row.id === 'deepseek-official');
  assert.equal(native.models.find(row => row.id === 'deepseek-flash').supportsImages, true, 'Existing official native vision facts must remain truthful');
  assert.equal(native.models.find(row => row.id === 'deepseek-v4-pro').supportsImages, false);
  const provider = { id: 'attachment-wire-test', name: 'Isolated visual capability configuration', protocol: 'openai-completions', baseURL: `http://127.0.0.1:${modelServer.address().port}/v1`,
    models: ['studio-vision-fixture', 'studio-text-fixture'], visionModels: ['studio-vision-fixture'], contextWindow: 8192, maxTokens: 512, revision: originalModels.customRevision, apiKey: 'attachment-fixture-key-not-a-real-credential' };
  await rejected('models', { ...provider, visionModels: ['not-listed'] }, /不重复子集/);
  let configuration = await app.json('models', provider), configuredProvider = configuration.providers.find(row => row.id === provider.id);
  assert.deepEqual(configuredProvider.models.map(row => [row.id, row.supportsImages]), [['studio-vision-fixture', true], ['studio-text-fixture', false]]);
  configuration = await app.json('models', { ...provider, name: 'Older client preserves explicit native input', revision: configuredProvider.revision, visionModels: undefined, apiKey: undefined });
  configuredProvider = configuration.providers.find(row => row.id === provider.id); assert.equal(configuredProvider.models[0].supportsImages, true);
  const wireChat = await app.json('chat', { projectId: project.id, provider: provider.id, model: 'studio-vision-fixture', message: '上传设计草图并核对视觉传输', attachments: [image('wire sketch.png')] });
  const wireHistory = await finishedChat(app, wireChat.id); assert.ok(wireHistory.events.some(event => event.type === 'assistant/message' && /Actual image bytes reached/.test(messageText(event))));
  assert.equal(wireRequests.length, 1); assert.equal(wireRequests[0].path, '/v1/chat/completions');
  const wireImage = wireRequests[0].payload.messages.find(row => row.role === 'user').content.find(part => part.type === 'image_url');
  assert.ok(wireImage.image_url.url.startsWith('data:image/')); assert.ok(Buffer.from(wireImage.image_url.url.split(',')[1], 'base64').length, 'Actual HTTP provider payload must carry image bytes, not filenames');
  await rejected('chat', { projectId: project.id, provider: provider.id, model: 'studio-text-fixture', message: '不能假装读取图', attachments: [image('text-only.png')] }, /支持图片/);
  const officialInput = { id: native.id, name: native.name, protocol: native.protocol, baseURL: native.baseURL, models: native.models.map(row => row.id), contextWindow: 64000, maxTokens: 512, revision: native.revision };
  let officialSaved = await app.json('models', officialInput), officialProvider = officialSaved.providers.find(row => row.id === native.id);
  assert.equal(officialProvider.models.find(row => row.id === 'deepseek-flash').supportsImages, true, 'Editing official model capacities must retain native image and protocol facts');
  officialSaved = await app.json('models', { ...officialInput, revision: officialProvider.revision, visionModels: [] }); officialProvider = officialSaved.providers.find(row => row.id === native.id);
  assert.ok(officialProvider.models.every(row => row.supportsImages === false), 'Explicit native vision deselection must configure text-only models');
  officialSaved = await app.json('models', { ...officialInput, revision: officialProvider.revision }); officialProvider = officialSaved.providers.find(row => row.id === native.id);
  assert.ok(officialProvider.models.every(row => row.supportsImages === false), 'Older clients must preserve a previously saved text-only declaration');
  officialSaved = await app.json('models', { ...officialInput, revision: officialProvider.revision, visionModels: ['deepseek-flash', 'deepseek-v4-pro'] }); officialProvider = officialSaved.providers.find(row => row.id === native.id);
  assert.ok(officialProvider.models.every(row => row.supportsImages === true), 'The native adapter accepts explicit image capability declarations without a home migration');
  officialSaved = await app.json('models', { ...officialInput, revision: officialProvider.revision, visionModels: ['deepseek-flash'] }); officialProvider = officialSaved.providers.find(row => row.id === native.id);
  assert.deepEqual(officialProvider.models.map(row => [row.id, row.supportsImages]), [['deepseek-flash', true], ['deepseek-v4-pro', false]]);
  const before = (await app.json('status')).chats.length;
  await rejected('chat', { ...base, provider: 'studio-smoke', model: 'm1-smoke', message: '请看图', attachments: [image('sketch.png')] }, /支持图片/);
  await rejected('chat', { ...base, message: '假原生CAD', attachments: [{ name: 'model.step', mediaType: 'application/octet-stream', data: 'AAAA' }] }, /CAD\/EDA/);
  assert.equal((await app.json('status')).chats.length, before, 'Rejected attachment admission must not create a chat');

  const sent = await app.json('chat', { ...base, message: probe(1, ['gear sketch.png']), attachments: [image('../../gear sketch.png')] });
  const stored = await finishedChat(app, sent.id), user = stored.events.find(event => event.type === 'user/message');
  assert.equal(user.data.content.filter(block => block.type === 'image').length, 1);
  assert.ok(stored.events.some(event => event.type === 'assistant/message' && /1 actual image blocks, \d+ verified binary bytes/.test(messageText(event))), JSON.stringify(stored.events.filter(event => ['assistant/message', 'turn/end'].includes(event.type)).map(event => ({ type: event.type, text: messageText(event), ...(event.type === 'turn/end' ? { reason: event.data.reason } : {}) }))));
  const list = await app.json(`chat/attachments?id=${sent.id}`); assert.equal(list.id, sent.id); assert.equal(list.attachments.length, 1);
  const [reference] = list.attachments; assert.equal(reference.name, 'gear sketch.png'); assert.equal('originalSha256' in reference, false);
  const original = await app.call(query(sent.id, reference.id)); assert.equal(original.status, 200); assert.equal(original.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), png);
  const preview = await app.call(query(sent.id, reference.id, 1)); assert.equal(preview.status, 200); assert.ok(preview.headers.get('content-type').startsWith('image/')); assert.ok((await preview.arrayBuffer()).byteLength);
  assert.match(preview.headers.get('cache-control') ?? '', /private|no-store/);
  assert.equal((await app.json(`graph?projectId=${project.id}`)).tasks.length, 0, 'Reference upload must not fabricate engineering tasks');
  const untouched = await app.json('chat', { ...base, message: probe(0) }); await finishedChat(app, untouched.id);
  assert.deepEqual((await app.json(`chat/attachments?id=${untouched.id}`)).attachments, []);
  await rejected(query(untouched.id, reference.id), undefined, /不属于/);
  await rejected(query(sent.id, '../manifest.json'), undefined, /标识/);
  await rejected(query(sent.id, reference.id, 0), undefined, /页码/);
  await rejected('chat', { ...base, id: sent.id, message: '复用伪造对象', attachments: [{ id: reference.id }] });
  await rejected('chat', { ...base, id: sent.id, message: '伪装图片', attachments: [{ name: 'fake.png', mediaType: 'image/png', data: Buffer.from('not an image').toString('base64') }] });
  assert.equal((await app.json(`chat/attachments?id=${sent.id}`)).attachments.length, 1);
  const wrongProject = await app.json('projects', { title: '其他项目不能借用会话' });
  await rejected('chat', { projectId: wrongProject.id, ...model, id: sent.id, message: 'cross project upload', attachments: [image('wrong.png')] }, /belong/);

  const task = await app.json('task/quick', { projectId: project.id, title: '只保存私有图纸参考' });
  const taskChat = await app.json('chat', { taskId: task.id, ...model, message: probe(1, ['EDA sketch.png']), attachments: [image('EDA sketch.png')] }); await finishedChat(app, taskChat.id);
  const [taskReference] = (await app.json(`chat/attachments?id=${taskChat.id}`)).attachments;
  await rejected(query(taskChat.id, reference.id), undefined, /不属于/);
  await rejected(query(sent.id, taskReference.id), undefined, /不属于/);
  assert.deepEqual(await readdir(join(dataRoot, 'workspaces', task.id)), ['.chat-tmp'], 'Reference originals stay out of task deliverables');

  const hasRenderer = !spawnSync('pdftoppm', ['-v']).error;
  if (hasRenderer) {
    const source = pdf(2), document = await app.json('chat', { ...base, message: probe(2, ['reference drawing.pdf · 第 1 页', 'reference drawing.pdf · 第 2 页']), attachments: [{ name: 'reference drawing.pdf', mediaType: 'application/pdf', data: source.toString('base64') }] });
    const record = await finishedChat(app, document.id); assert.ok(record.events.some(event => event.type === 'assistant/message' && /2 actual image blocks/.test(messageText(event))));
    const [pdfReference] = (await app.json(`chat/attachments?id=${document.id}`)).attachments; assert.equal(pdfReference.images.length, 2);
    assert.deepEqual(Buffer.from(await (await app.call(query(document.id, pdfReference.id))).arrayBuffer()), source);
    const sharp = createRequire(import.meta.resolve('@deepseek-ai/dsh-attachment-local'))('sharp');
    for (const page of [1, 2]) {
      const response = await app.call(query(document.id, pdfReference.id, page)); assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png');
      const image = Buffer.from(await response.arrayBuffer()), { width, height } = pdfReference.images[page - 1];
      const textRegion = await sharp(image).extract({ left: 0, top: 0, width, height: Math.floor(height / 5) }).flatten({ background: '#fff' }).stats();
      assert.ok(textRegion.channels.some(channel => channel.min < 200), 'The HTTP vision preview must contain PDF Helvetica labels in the top white region');
    }
    await rejected('chat', { ...base, id: document.id, message: '超过页面限制', attachments: [{ name: 'seven.pdf', mediaType: 'application/pdf', data: pdf(7).toString('base64') }] }, /最多 6 页/);
    assert.equal((await app.json(`chat/attachments?id=${document.id}`)).attachments.length, 1);
  }

  await stopApp(app.child); app = await startApp(home);
  const restoredModels = await app.json('models');
  assert.deepEqual(restoredModels.providers.find(row => row.id === provider.id).models.map(row => [row.id, row.supportsImages]), [['studio-vision-fixture', true], ['studio-text-fixture', false]]);
  assert.deepEqual(restoredModels.providers.find(row => row.id === native.id).models.map(row => [row.id, row.supportsImages]), [['deepseek-flash', true], ['deepseek-v4-pro', false]], 'Explicit native declarations must survive restart');
  assert.deepEqual((await app.json(`chat/attachments?id=${sent.id}`)).attachments, list.attachments);
  assert.deepEqual(Buffer.from(await (await app.call(query(sent.id, reference.id))).arrayBuffer()), png);
  const followup = await app.json('chat', { ...base, id: sent.id, message: probe(1, ['bearing sketch.png']), attachments: [image('bearing sketch.png')] });
  assert.equal(followup.id, sent.id); await finishedChat(app, sent.id);
  assert.equal((await app.json(`chat/attachments?id=${sent.id}`)).attachments.length, 2);
  const deletePreview = await app.json(`task/delete-preview?id=${task.id}`);
  await app.json('task/delete', { id: task.id, revision: deletePreview.taskRevision, projectRevision: deletePreview.projectRevision, confirm: true });
  await rejected(`chat/attachments?id=${taskChat.id}`, undefined, /Unknown Studio chat/);
  await assert.rejects(lstat(join(dataRoot, 'chat-attachments', taskChat.id)), { code: 'ENOENT' });
  assert.equal((await app.call(query(sent.id, reference.id, 1))).status, 200, 'Deleting one task must preserve another chat’s shared normalized image');
  const originalPath = join(dataRoot, 'chat-attachments', sent.id, `${reference.id}.original`); assert.deepEqual(await readFile(originalPath), png);
  console.log(`Attachment verification passed: actual OpenAI-compatible HTTP image payload, saved custom/native model capabilities, anonymous same-origin PNG vision bytes, project/task/conversation ownership, private originals, safe preview, no phantom tasks, malformed/model refusals, restart/resume and selected task cleanup${hasRenderer ? ', actual PDF page vision and limits' : ' (optional PDF renderer unavailable)'}.`);
} catch (error) { console.error(error); process.exitCode = 1; }
finally { if (app) await stopApp(app.child); await new Promise(resolve => modelServer.close(resolve)); await release(home); await rm(home, { recursive: true, force: true }); }
