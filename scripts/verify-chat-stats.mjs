import assert from 'node:assert/strict';
import { mkdir, mkdtemp, chmod, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { root } from './prepare.mjs';
import { startApp, stopApp } from './verify-app.mjs';
import { emptyChatState, foldChatPacket } from '../plugins/ui/lib/chat-state.js';

await mkdir(join(root, '.studio'), { recursive: true });
const home = await mkdtemp(join(root, '.studio/chat-stats-test-'));
const subscriptions = new Set();
let app;

async function until(predicate, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(20); }
  throw new Error(message);
}

/** Watch actual anonymous same-origin SSE, replacing whole measurements instead of adding them. */
async function listen(id) {
  const response = await app.call(`chat/stream?id=${encodeURIComponent(id)}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader(), decoder = new TextDecoder(), packets = [];
  let buffer = '', state = emptyChatState(), metrics, closed = false, failure;
  const completed = (async () => {
    try {
      while (!closed) {
        const row = await reader.read(); if (row.done) break;
        buffer += decoder.decode(row.value, { stream: true });
        let split;
        while ((split = buffer.indexOf('\n\n')) >= 0) {
          const record = buffer.slice(0, split); buffer = buffer.slice(split + 2);
          if (!record.startsWith('data: ')) continue;
          const packet = JSON.parse(record.slice(6));
          if (packet.type === 'error') throw new Error(packet.error);
          state = foldChatPacket(state, packet);
          if (packet.type === 'snapshot') metrics = packet.chat.metrics;
          else if (packet.type === 'metrics') metrics = packet.metrics;
          packets.push(packet);
        }
      }
    } catch (error) { if (!closed) failure = error; }
    finally { reader.releaseLock(); }
  })();
  const subscription = {
    packets,
    state() { if (failure) throw failure; return state; },
    metrics() { if (failure) throw failure; return metrics; },
    async close() {
      if (closed) return;
      closed = true; await reader.cancel(); await completed;
      subscriptions.delete(subscription);
    },
  };
  subscriptions.add(subscription);
  return subscription;
}

function publicMetrics(metrics) {
  assert.ok(metrics, 'The conversation must contain its native metrics');
  assert.deepEqual(Object.keys(metrics).sort(), ['asOfSeq', 'context', ...(metrics.usage ? ['usage'] : [])].sort());
  assert.ok(Number.isSafeInteger(metrics.asOfSeq) && metrics.asOfSeq >= 0);
  assert.ok(['projected', 'reported', 'unavailable'].includes(metrics.context.basis));
  assert.equal(typeof metrics.context.estimated, 'boolean');
  for (const [key, value] of Object.entries(metrics.context)) {
    assert.ok(['tokens', 'capacity', 'percent', 'basis', 'estimated'].includes(key));
    if (!['basis', 'estimated'].includes(key)) assert.ok(Number.isFinite(value) && value >= 0, `Invalid context ${key}`);
  }
  if (metrics.usage) {
    assert.deepEqual(Object.keys(metrics.usage).sort(), ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens', 'cacheReported', ...(metrics.usage.cacheHitPercent === undefined ? [] : ['cacheHitPercent'])].sort());
    assert.equal(typeof metrics.usage.cacheReported, 'boolean');
    for (const [key, value] of Object.entries(metrics.usage)) if (key !== 'cacheReported') assert.ok(Number.isFinite(value) && value >= 0, `Invalid usage ${key}`);
  }
}

function contextPercent(metrics) {
  publicMetrics(metrics);
  assert.equal(metrics.context.capacity, 64000);
  assert.equal(metrics.context.basis, 'projected');
  assert.equal(metrics.context.estimated, true);
  assert.ok(metrics.context.tokens > 0);
  assert.ok(Math.abs(metrics.context.percent - metrics.context.tokens / 64000 * 100) < 1e-10,
    'Context percentage must measure current projected occupancy, not cumulative billing');
}

function usageForRounds(metrics, rounds) {
  contextPercent(metrics);
  assert.deepEqual(metrics.usage, {
    uncachedInputTokens: 150 * rounds, outputTokens: 40 * rounds,
    cacheReadTokens: 100 * rounds, cacheWriteTokens: 30 * rounds, totalTokens: 320 * rounds,
    cacheReported: true, cacheHitPercent: 100 / 280 * 100,
  }, 'Whole-session counters must sum disjoint provider buckets across tools and turns');
}

/** Private native streams and adapter replay data are never part of the UI's SSE. */
function privateFramesAbsent(packets) {
  for (const packet of packets) {
    const source = JSON.stringify(packet);
    assert.ok(!source.includes('chat-stats-private-provider-envelope'));
    assert.ok(!source.includes('fixture-only-private-credential'));
    const events = packet.type === 'snapshot' ? packet.chat.events : packet.type === 'event' ? [packet.event] : [];
    for (const event of events) if (event.type === 'assistant/message') {
      assert.equal(Object.hasOwn(event.data, 'stream'), false);
      assert.equal(Object.hasOwn(event.data, 'usage'), false);
      assert.equal(Object.hasOwn(event.data.message, 'providerMetadata'), false);
    }
    if (packet.type === 'frame') assert.ok(packet.frame.type !== 'chunk' || ['block-start', 'text-delta', 'reasoning-delta', 'block-end'].includes(packet.frame.chunk.type), 'Raw provider usage chunks must not become UI text frames');
    if (packet.type === 'metrics') publicMetrics(packet.metrics);
    if (packet.type === 'snapshot') publicMetrics(packet.chat.metrics);
  }
}

async function reconnect(id) {
  const subscription = await listen(id);
  await until(() => subscription.packets.some(packet => packet.type === 'snapshot'), 'No native reconnect snapshot');
  return subscription;
}

const snapshot = subscription => subscription.packets.find(packet => packet.type === 'snapshot');
const model = { provider: 'studio-smoke', model: 'm1-smoke' };
async function send(message, id) {
  return app.json('chat', { taskId: 'm1-gear', ...model, ...(id ? { id } : {}), message });
}
async function completed(id, turns) {
  let record;
  await until(async () => {
    record = await app.json(`chat?id=${encodeURIComponent(id)}`);
    return record.status === 'idle' && record.events.filter(event => event.type === 'turn/end').length === turns;
  }, 'Native metered turn did not finish');
  return record;
}

/** Only relax directories in this fresh fixture; no main preview home is touched. */
async function release(path) {
  await chmod(path, 0o700);
  for (const row of await readdir(path, { withFileTypes: true })) if (row.isDirectory() && !row.isSymbolicLink()) await release(join(path, row.name));
}

try {
  const priorDelay = process.env.STUDIO_SMOKE_STATS_DELAY_MS;
  process.env.STUDIO_SMOKE_STATS_DELAY_MS = '1000';
  try { app = await startApp(home); }
  finally {
    if (priorDelay === undefined) delete process.env.STUDIO_SMOKE_STATS_DELAY_MS;
    else process.env.STUDIO_SMOKE_STATS_DELAY_MS = priorDelay;
  }
  assert.equal((await fetch(`${app.base}/api/studio/chat/stream?id=unknown`)).status, 400);

  const first = await send('[chat-stats] Native metering first turn');
  const streaming = await listen(first.id);
  await until(() => streaming.metrics()?.usage?.totalTokens === 170, 'No intermediate provider usage across the native tool step');
  assert.equal(streaming.state().status, 'running');
  assert.ok(!streaming.state().events.some(event => event.type === 'turn/end'));
  await streaming.close();

  const running = await reconnect(first.id);
  assert.equal(snapshot(running).chat.metrics.usage.totalTokens, 170, 'Running reconnect must restore the billed tool step exactly once');
  await until(() => running.metrics()?.usage?.totalTokens === 320 && running.state().status === 'idle', 'No completed live counters');
  const firstHistory = await completed(first.id, 1);
  usageForRounds(firstHistory.metrics, 1);
  assert.deepEqual(running.metrics(), firstHistory.metrics);
  assert.deepEqual(running.state().metrics, firstHistory.metrics, 'Browser SSE folding must retain whole metrics');
  privateFramesAbsent(streaming.packets);
  privateFramesAbsent(running.packets);
  await running.close();

  const history = await reconnect(first.id);
  assert.deepEqual(snapshot(history).chat.metrics, firstHistory.metrics, 'Stored snapshot must not add usage again');
  const resumed = await send('[chat-stats] Native metering second turn', first.id);
  assert.equal(resumed.id, first.id);
  await until(() => history.metrics()?.usage?.totalTokens === 640 && history.state().status === 'idle', 'No accumulated second-turn metrics');
  const secondHistory = await completed(first.id, 2);
  usageForRounds(secondHistory.metrics, 2);
  assert.deepEqual(history.metrics(), secondHistory.metrics);
  assert.deepEqual(history.state().metrics, secondHistory.metrics);
  assert.ok(history.packets.filter(packet => packet.type === 'metrics').length >= 2);
  privateFramesAbsent(history.packets);
  await history.close();

  // Independent chats share a task workspace but never share usage counters.
  const uncached = await send('[chat-stats-no-cache] Provider omitted cache reporting');
  const uncachedHistory = await completed(uncached.id, 1);
  contextPercent(uncachedHistory.metrics);
  assert.deepEqual(uncachedHistory.metrics.usage, { uncachedInputTokens: 120, outputTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 132, cacheReported: false });
  const unknownCache = await reconnect(uncached.id);
  assert.equal(Object.hasOwn(unknownCache.metrics().usage, 'cacheHitPercent'), false, 'Unknown cache reporting must not masquerade as 0%');
  assert.deepEqual(unknownCache.state().metrics, uncachedHistory.metrics);
  privateFramesAbsent(unknownCache.packets);
  await unknownCache.close();
  assert.deepEqual((await app.json(`chat?id=${first.id}`)).metrics, secondHistory.metrics, 'Switching to another chat must not change the first chat counters');

  const zero = await send('[chat-stats-zero-cache] Provider explicitly reported zero');
  const zeroHistory = await completed(zero.id, 1);
  contextPercent(zeroHistory.metrics);
  assert.deepEqual(zeroHistory.metrics.usage, { uncachedInputTokens: 120, outputTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 132, cacheReported: true, cacheHitPercent: 0 });

  await stopApp(app.child);
  app = await startApp(home);
  for (const record of [secondHistory, uncachedHistory, zeroHistory]) {
    const restored = await app.json(`chat?id=${record.id}`);
    assert.equal(restored.status, 'stored', 'History metering must not create an Agent');
    assert.deepEqual(restored.metrics, record.metrics, 'Cold native replay must restore exact complete counters');
    const restoredStream = await reconnect(record.id);
    assert.deepEqual(restoredStream.state().metrics, record.metrics, 'Cold SSE snapshot must restore exact metrics');
    privateFramesAbsent(restoredStream.packets);
    await restoredStream.close();
  }
  await send('[chat-stats] Continue after cold restore', first.id);
  const thirdHistory = await completed(first.id, 3);
  usageForRounds(thirdHistory.metrics, 3);
  assert.deepEqual((await app.json(`chat?id=${uncached.id}`)).metrics, uncachedHistory.metrics);

  console.log('Chat statistics verification passed: exact disjoint multi-step/turn totals, live anonymous same-origin SSE, current context %, reported cache ratio, omitted vs zero cache, reconnect without double counting, per-chat isolation, cold native restore and continuation; private usage streams/provider envelopes absent from UI SSE. Isolated keyless smoke home, no real model or external network.');
} catch (error) { console.error(error); process.exitCode = 1; }
finally {
  for (const subscription of subscriptions) await subscription.close();
  if (app) await stopApp(app.child);
  await release(home);
  await rm(home, { recursive: true, force: true });
}
