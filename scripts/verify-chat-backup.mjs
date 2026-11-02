import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, realpath, rm, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startApp, stopApp } from './verify-app.mjs';

// A real local HTTP/SSE adapter and native tool loop; plain readable debug JSON only. No external model.
const home = await realpath(await mkdtemp('/private/tmp/studio-chat-backup-integration-'));
const preview = process.argv.includes('--preview') || process.env.STUDIO_CHAT_BACKUP_PREVIEW === '1';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC', 'base64');
const reference = { name: '真实上传字节-合成草图.png', mediaType: 'image/png', data: png.toString('base64') };
const temporaryPath = 'web/results/证据.md', temporaryContent = '# Synthetic evidence\n实际临时文件逐字恢复。\n';
const model = { provider: 'chat-backup-local', model: 'chat-backup-fixture' }, wires = [];
let app;
let holdNext = false, releaseHeld;
const query = (path, fields) => `${path}?${new URLSearchParams(fields)}`;
const text = event => (event.data?.message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('');
const server = createServer(async (request, response) => {
  try {
    const pieces = []; let size = 0;
    for await (const piece of request) { size += piece.length; if (size > 4 * 1024 * 1024) throw new Error('Synthetic request too large'); pieces.push(piece); }
    const raw = Buffer.concat(pieces).toString('utf8'), payload = JSON.parse(raw), chunks = [];
    const ordinal = wires.length + 1;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finishReason = null) => {
      const encoded = `data: ${JSON.stringify({ id: `chatcmpl-backup-${ordinal}`, object: 'chat.completion.chunk', created: 1, model: payload.model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
      chunks.push(encoded); response.write(encoded);
    };
    wires.push({ request: raw, payload, response: chunks });
    if (holdNext) { holdNext = false; await new Promise(resolve => { releaseHeld = resolve; }); releaseHeld = undefined; }
    if (ordinal === 1) {
      send({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-backup-temp', type: 'function', function: {
        name: 'studio_write_temp_file', arguments: JSON.stringify({ path: temporaryPath, content: temporaryContent }),
      } }] });
      send({}, 'tool_calls');
    } else {
      send({ role: 'assistant', content: ordinal === 2 ? '合成模型：附件与临时检索文件已保存。' : '合成模型：已在恢复后的新任务中继续对话。' });
      send({}, 'stop');
    }
    chunks.push('data: [DONE]\n\n'); response.end('data: [DONE]\n\n');
  } catch { response.writeHead(500); response.end('Synthetic provider fixture failed'); }
});
async function finished(id, previousTurns = 0) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const chat = await app.json(query('chat', { id })), turns = chat.events.filter(event => event.type === 'turn/end');
    if (chat.status === 'idle' && turns.length > previousTurns) {
      assert.notEqual(turns.at(-1).data.reason?.kind, 'error', 'A failed native model call cannot count as acceptance'); return chat;
    }
    await delay(60);
  }
  throw new Error('Native synthetic model turn did not settle');
}
async function requestDetails(chat, userSeq) {
  const index = await app.json(query('chat/requests', { id: chat.id, userSeq }));
  assert.equal(index.id, chat.id); assert.equal(index.userSeq, userSeq);
  return { index, details: await Promise.all(index.requests.map(row => app.json(query('chat/request', { id: chat.id, requestId: row.id })))) };
}

try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  app = await startApp(home);
  const modelView = await app.json('models');
  await app.json('models', { id: model.provider, name: 'Isolated synthetic HTTP backup fixture', protocol: 'openai-completions',
    baseURL: `http://127.0.0.1:${server.address().port}/v1`, models: [model.model], apiKey: 'local-fixture-not-a-real-secret', visionModels: [model.model], contextWindow: 64000, maxTokens: 512, revision: modelView.customRevision });
  const project = await app.json('projects', { title: '对话调试 JSON 导出验收（合成）' });
  const originalTask = await app.json('task/quick', { projectId: project.id, title: '原任务定义' });
  const targetTask = await app.json('task/quick', { projectId: project.id, title: '独立对话隔离验证' });
  const sent = await app.json('chat', { taskId: originalTask.id, ...model, message: '请保存合成参考图和检索证据，用于完整会话备份。', attachments: [reference] });
  const original = await finished(sent.id), userSeq = original.events.find(event => event.type === 'user/message').seq;
  assert.equal(wires.length, 2, 'One native turn should perform two independently captured model requests');
  assert.ok(original.events.some(event => event.type === 'tool/call' && event.data.name === 'studio_write_temp_file'));
  assert.ok(original.events.some(event => event.type === 'tool/result' && !event.data.message.isError));
  assert.ok(original.events.some(event => event.type === 'assistant/message' && /已保存/.test(text(event))));
  const before = await requestDetails(original, userSeq); assert.equal(before.details.length, 2);
  for (const [position, detail] of before.details.entries()) {
    assert.equal(detail.record.sessionId, original.id);
    const transport = detail.record.transports.find(row => row.classification === 'model-json'); assert.ok(transport);
    assert.equal(transport.request.status, 'complete'); assert.equal(transport.response.status, 'complete');
    assert.equal(transport.request.raw, wires[position].request, 'Actual outbound JSON bytes must not be reconstructed from event history');
    assert.equal(transport.response.raw, wires[position].response.join(''), 'Actual received SSE frames must retain their exact byte order');
  }
  const download = await app.call(query('chat/backup', { id: original.id }));
  assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition') ?? '', /\.debug\.json/);
  assert.match(download.headers.get('content-type') ?? '', /^application\/json\b/i);
  const rawDownload = await download.text(), exported = JSON.parse(rawDownload);
  assert.equal(exported.format, 'harnessstudio-chat-debug');
  assert.equal(exported.source.id, original.id);
  assert.deepEqual(exported.sessions[0].events, original.events);
  assert.equal(exported.modelCalls.length, 2);
  assert.equal(exported.completeness.status, 'complete');
  assert.equal(exported.uploadedAttachments.length, 1);
  assert.equal(exported.blobs, undefined, 'Debug traffic is never hidden in encoded archive blobs');
  assert.equal(exported.entries, undefined); assert.equal(exported.manifest, undefined);
  assert.ok(!rawDownload.includes('local-fixture-not-a-real-secret'), 'Provider credentials must never enter debug JSON');
  assert.ok(rawDownload.includes('\n  "modelCalls"'), 'Download is formatted JSON');
  assert.equal(exported.temporaryFiles.find(row => row.path === temporaryPath).text, temporaryContent);
  for (const [position, record] of exported.modelCalls.entries()) {
    const wire = record.transports.find(row => row.classification === 'model-json');
    assert.equal(wire.request.raw, wires[position].request);
    assert.deepEqual(wire.request.body, wires[position].payload);
    assert.equal(wire.response.raw, wires[position].response.join(''));
    assert.ok(Array.isArray(wire.response.events));
    assert.ok(wire.request.body.messages.some(message => message.role === 'system'));
  }
  const otherMessage = '这是另一条独立对话，不应进入原对话导出。';
  const otherSent = await app.json('chat', { taskId: targetTask.id, ...model, message: otherMessage });
  const other = await finished(otherSent.id);
  const isolated = await (await app.call(query('chat/backup', { id: original.id }))).text();
  assert.ok(!isolated.includes(other.id), 'Downloading the current conversation must not mix in another conversation');
  assert.ok(!isolated.includes(otherMessage), 'Downloading the current conversation must not mix in another conversation body');
  const graphBefore = await app.json(query('graph', { projectId: project.id }));
  const rejected = await fetch(`${app.base}/api/studio/${query('chat/restore', { taskId: targetTask.id })}`, {
    method: 'POST', headers: { origin: app.base, 'content-type': 'application/json' }, body: rawDownload,
  });
  assert.equal(rejected.status, 404, 'Restore route must not exist');
  assert.equal((await app.json('status')).chats.length, 2);
  assert.deepEqual(await app.json(query('graph', { projectId: project.id })), graphBefore);
  await stopApp(app.child); app = undefined; app = await startApp(home);
  assert.deepEqual((await app.json(query('chat', { id: original.id }))).events, original.events);
  const again = await app.call(query('chat/backup', { id: original.id }));
  const againExport = await again.json();
  assert.deepEqual(againExport.modelCalls, exported.modelCalls);
  assert.deepEqual(againExport.sessions, exported.sessions);
  holdNext = true;
  await app.json('chat', { id: original.id, taskId: originalTask.id, ...model, message: '暂停合成响应，验证执行中的对话暂不下载。' });
  const holdingDeadline = Date.now() + 15000;
  while (!releaseHeld && Date.now() < holdingDeadline) await delay(30);
  assert.ok(releaseHeld);
  const runningDownload = await app.call(query('chat/backup', { id: original.id }));
  assert.equal(runningDownload.status, 409);
  releaseHeld(); await finished(original.id, original.events.filter(event => event.type === 'turn/end').length);
  console.log('Readable chat debug JSON passed: exact original request/response JSON/SSE, system prompts, image payloads, native history, temporary text, single-conversation isolation, no restore endpoint, restart persistence and running rejection. Synthetic model only.');
  if (preview) {
    const backupFile = join(home, 'synthetic-conversation.debug.json'); await writeFile(backupFile, rawDownload, { mode: 0o600 });
    console.log(JSON.stringify({ previewURL: app.url, home, projectId: project.id, taskId: originalTask.id, chatId: original.id, userSeq, backupFile, syntheticOnly: true }));
    await new Promise(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); });
  }
} finally {
  releaseHeld?.();
  if (app) await stopApp(app.child);
  await new Promise(resolve => server.close(resolve));
  await rm(home, { recursive: true, force: true });
}
