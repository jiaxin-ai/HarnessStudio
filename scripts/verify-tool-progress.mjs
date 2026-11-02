import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { root } from './prepare.mjs';
import { startApp, stopApp } from './verify-app.mjs';
import { emptyChatState, foldChatPacket, pendingToolCalls } from '../plugins/ui/lib/chat-state.js';

await mkdir(join(root, '.studio'), { recursive: true });
const home = await mkdtemp(join(root, '.studio/tool-progress-test-'));
const subscriptions = new Set();
let app;

/** Keep the anonymous same-origin native SSE stream open, including its reconnect snapshot. */
async function listen(id) {
  const response = await app.call(`chat/stream?id=${encodeURIComponent(id)}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader(), decoder = new TextDecoder(), observations = [];
  let buffer = '', state = emptyChatState(), closed = false, failure;
  const completed = (async () => {
    try {
      while (!closed) {
        const row = await reader.read();
        if (row.done) break;
        buffer += decoder.decode(row.value, { stream: true });
        let split;
        while ((split = buffer.indexOf('\n\n')) >= 0) {
          const record = buffer.slice(0, split); buffer = buffer.slice(split + 2);
          if (!record.startsWith('data: ')) continue;
          const packet = JSON.parse(record.slice(6));
          if (packet.type === 'error') throw new Error(packet.error);
          state = foldChatPacket(state, packet);
          observations.push({ packet, pending: pendingToolCalls(state) });
        }
      }
    } catch (error) { if (!closed) failure = error; }
    finally { reader.releaseLock(); }
  })();
  const subscription = {
    observations,
    state() { if (failure) throw failure; return state; },
    async close() {
      if (closed) return;
      closed = true;
      await reader.cancel();
      await completed;
      subscriptions.delete(subscription);
    },
  };
  subscriptions.add(subscription);
  return subscription;
}

async function until(predicate, message) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) { if (predicate()) return; await delay(20); }
  throw new Error(message);
}

const searchCall = subscription => pendingToolCalls(subscription.state()).find(call => call.name === 'web_search');
const resultFor = (subscription, id) => subscription.observations.find(({ packet }) => packet.type === 'event'
  && packet.event.type === 'tool/result' && packet.event.data.message.callId === id);
const snapshotOf = subscription => subscription.observations.find(({ packet }) => packet.type === 'snapshot');
async function reconnect(id) {
  const subscription = await listen(id);
  await until(() => { subscription.state(); return snapshotOf(subscription); }, 'No reconnect snapshot received');
  return subscription;
}
async function send(message) {
  return app.json('chat', { taskId: 'm1-gear', provider: 'studio-smoke', model: 'm1-smoke', message: `[web-ui] ${message}` });
}
async function settled(subscription) {
  await until(() => subscription.state().status === 'idle', 'Agent did not become idle');
  assert.deepEqual(pendingToolCalls(subscription.state()), [], 'An idle Agent must not retain a tool progress indicator');
}

/** Only relax directories inside this newly created fixture before cleanup. */
async function release(path) {
  await chmod(path, 0o700);
  for (const row of await readdir(path, { withFileTypes: true })) if (row.isDirectory() && !row.isSymbolicLink()) await release(join(path, row.name));
}

try {
  // startApp copies the environment to its isolated child; no real provider or home is used.
  const priorDelay = process.env.STUDIO_SMOKE_WEB_DELAY_MS;
  process.env.STUDIO_SMOKE_WEB_DELAY_MS = '1000';
  try { app = await startApp(home); }
  finally {
    if (priorDelay === undefined) delete process.env.STUDIO_SMOKE_WEB_DELAY_MS;
    else process.env.STUDIO_SMOKE_WEB_DELAY_MS = priorDelay;
  }

  const successful = await send('native tool progress success and reconnect');
  const first = await listen(successful.id);
  await until(() => searchCall(first), 'No pending native web_search observed during execution');
  const call = searchCall(first);
  assert.equal(first.state().status, 'running');
  assert.ok(!first.state().events.some(event => event.type === 'tool/result' && event.data.message.callId === call.id), 'Progress must appear before the native tool result');
  await first.close();

  const running = await reconnect(successful.id);
  assert.deepEqual(snapshotOf(running).pending, [call], 'Reconnect must restore the same still-running native call');
  await until(() => resultFor(running, call.id), 'No successful native web_search result received');
  const success = resultFor(running, call.id);
  assert.equal(success.packet.event.data.message.isError, false);
  assert.ok(!success.pending.some(row => row.id === call.id), 'A successful result must immediately remove its progress indicator');
  await settled(running);
  await running.close();
  const completed = await reconnect(successful.id);
  assert.deepEqual(snapshotOf(completed).pending, [], 'Completed history must not revive a progress indicator');
  await completed.close();

  const canceled = await send('native tool progress stop');
  const stopping = await listen(canceled.id);
  await until(() => searchCall(stopping), 'No pending native web_search observed before stop');
  const stoppedCall = searchCall(stopping);
  await app.json('chat/stop', { id: canceled.id });
  await settled(stopping);
  const canceledResult = resultFor(stopping, stoppedCall.id);
  assert.ok(canceledResult, 'Stopping must retain the native tool result for the interrupted call');
  assert.equal(canceledResult.packet.event.data.message.isError, true);
  assert.ok(!canceledResult.pending.some(row => row.id === stoppedCall.id), 'The interrupted tool result must remove its progress indicator');
  assert.ok(stopping.state().events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'aborted'));
  await stopping.close();
  const stopped = await reconnect(canceled.id);
  assert.deepEqual(snapshotOf(stopped).pending, [], 'Stopped history must not revive a progress indicator');
  await stopped.close();

  console.log('Tool progress verification passed: native SSE execution start, success and stop cleanup, running reconnect and completed/stopped snapshots. Isolated smoke home; no real model or external network.');
} catch (error) { console.error(error); process.exitCode = 1; }
finally {
  for (const subscription of subscriptions) await subscription.close();
  if (app) await stopApp(app.child);
  await release(home);
  await rm(home, { recursive: true, force: true });
}
