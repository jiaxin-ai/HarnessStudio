import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, chmod, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { root } from './prepare.mjs';
import { startApp, stopApp, finishedChat } from './verify-app.mjs';
import { foldChatPacket, emptyChatState, conversationRows } from '../plugins/ui/lib/chat-state.js';
await mkdir(join(root, '.studio'), { recursive: true }); const home = await mkdtemp(join(root, '.studio/chat-test-'));
let app; const subscriptions = [];
async function listen(id) {
  const abort = new AbortController(), response = await app.call(`chat/stream?id=${id}`);
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader(), decoder = new TextDecoder(), packets = [];
  let text = '', state = emptyChatState();
  const completed = (async () => {
    try { while (!abort.signal.aborted) {
      const result = await reader.read(); if (result.done) break;
      text += decoder.decode(result.value, { stream: true });
      let split; while ((split = text.indexOf('\n\n')) >= 0) {
        const record = text.slice(0, split); text = text.slice(split + 2);
        if (!record.startsWith('data: ')) continue;
        const packet = JSON.parse(record.slice(6)); packets.push(packet); state = foldChatPacket(state, packet);
      }
    } } finally { reader.releaseLock(); }
  })();
  const subscription = { packets, state: () => state, close: async () => { abort.abort(); await reader.cancel(); await completed; } };
  subscriptions.push(subscription); return subscription;
}
async function until(predicate, message) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error(message);
}
async function release(path) { await chmod(path, 0o700); for (const row of await readdir(path, { withFileTypes: true })) if (row.isDirectory()) await release(join(path, row.name)); }
try {
  app = await startApp(home);
  assert.equal((await fetch(`${app.base}/api/studio/chat/stream?id=unknown`)).status, 400);
  assert.equal((await app.call('chat/stream?id=unknown')).status, 400);
  const sent = await app.json('chat', { taskId: 'm1-gear', provider: 'studio-smoke', model: 'm1-smoke', message: '[chat-ui] 仅验证流式与折叠区块' });
  const first = await listen(sent.id);
  await until(() => first.packets.some(packet => packet.type === 'frame' && packet.frame.type === 'chunk' && packet.frame.chunk.type === 'reasoning-delta'), 'No reasoning delta');
  await until(() => conversationRows(first.state()).some(row => row.role === 'assistant' && row.steps.some(step => step.text.some(text => text.includes('已收到')))), 'No visible text prefix');
  assert.equal(first.state().status, 'running'); assert.ok(!first.state().events.some(event => event.type === 'assistant/message'));
  await first.close(); subscriptions.splice(subscriptions.indexOf(first), 1);
  const second = await listen(sent.id); await until(() => second.packets.some(packet => packet.type === 'snapshot'), 'No reconnect snapshot');
  assert.ok(second.state().live.some(attempt => attempt.parts.some(part => part.type === 'text' && part.text.includes('已收到'))));
  const stored = await finishedChat(app, sent.id); await until(() => second.state().status === 'idle', 'No idle status');
  const rows = conversationRows(second.state()); assert.equal(rows.length, 2);
  assert.equal(rows[1].steps[0].text.length, 1); assert.equal(rows[1].steps[0].reasoning.length, 1); assert.match(rows[1].steps[0].text[0], /演示检查项 24/);
  assert.deepEqual(conversationRows(foldChatPacket(emptyChatState(), { type: 'snapshot', chat: stored, live: [] })).map(row => row.role), ['user', 'assistant']);
  const stopped = await app.json('chat', { taskId: 'm1-bearing', provider: 'studio-smoke', model: 'm1-smoke', message: '[chat-ui] 停止测试' });
  const stopping = await listen(stopped.id); await until(() => stopping.state().live.length > 0, 'No live stop target');
  await app.json('chat/stop', { id: stopped.id }); await until(() => stopping.state().status === 'idle', 'Stopped Agent not idle');
  assert.ok((await app.json(`chat?id=${stopped.id}`)).events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'aborted'));
  console.log('Chat verification passed: anonymous same-origin live reasoning/text, output before completion, reconnect without duplication, stored history and stop.');
} catch (error) { console.error(error); process.exitCode = 1; }
finally { for (const sub of subscriptions) await sub.close(); if (app) await stopApp(app.child); await release(home); await rm(home, { recursive: true, force: true }); }
