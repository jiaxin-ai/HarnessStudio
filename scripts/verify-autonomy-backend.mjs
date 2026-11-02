// Autonomy backend on a real DSH with the smoke model: the goal reaches the orchestrator, the round driver runs it until
// the round budget pauses the run, the run continues after a raised budget, a Studio restart pauses an active run, and
// the HTTP routes refuse stale revisions. Workers and completion are covered by the smoke scripts of verify-autonomy.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { root } from './prepare.mjs';
import { startApp, stopApp } from './verify-app.mjs';

await mkdir(join(root, '.studio'), { recursive: true });
const home = await mkdtemp(join(root, '.studio/autonomy-backend-test-'));
const smoke = { provider: 'studio-smoke', model: 'm1-smoke' };
let app;
async function until(predicate, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await delay(150); }
  throw new Error(`Timed out: ${label}`);
}
const run = id => app.json(`autonomy/run?id=${id}`);
try {
  app = await startApp(home);
  const project = await app.json('projects', { title: '自主运行后端验收' });
  const defaults = await app.json('autonomy/settings');
  assert.deepEqual([defaults.revision, defaults.settings.maxWorkers, defaults.settings.maxVms, defaults.settings.maxHours, defaults.settings.tokenBudget, defaults.settings.maxRounds], [0, 3, 2, 8, 20000000, 200]);
  const refused = await app.call('autonomy/start', { projectId: project.id, objective: '目标', settings: { workerModel: smoke } });
  assert.equal(refused.status, 400); assert.match((await refused.json()).error, /请选择总 Agent 模型/);

  // Three goal rounds, then the driver's round limit pauses the run for a person.
  let detail = await app.json('autonomy/start', { projectId: project.id, objective: '验证自主运行的目标接入', settings: { orchestratorModel: smoke, workerModel: smoke, maxRounds: 3 } });
  const id = detail.id, chatId = detail.orchestratorChatId;
  assert.equal(detail.state, 'running');
  detail = await until(async () => { const value = await run(id); return value.state === 'paused' ? value : undefined; }, 'round budget pause');
  assert.deepEqual([detail.pauseReason, detail.usage.rounds], ['budget-rounds', 3]);
  assert.ok(detail.attention.some(item => item.kind === 'budget' && !item.resolvedAt));
  assert.ok(detail.usage.tokens >= 0 && detail.usage.elapsedMs > 0);
  const status = await app.json('status');
  const orchestrator = status.chats.find(chat => chat.id === chatId);
  assert.deepEqual([orchestrator.role, orchestrator.runId, orchestrator.scope], ['orchestrator', id, 'project']);
  assert.ok(status.chats.filter(chat => !chat.role).every(chat => chat.runId === undefined));
  const chat = await app.json(`chat?id=${chatId}`);
  const sources = chat.events.filter(event => event.type === 'user/message').map(event => event.data.source);
  assert.deepEqual(sources[0], { kind: 'harnessstudio-autonomy', runId: id, from: 'controller' }, 'the first message is a controller notice, not a person');
  assert.equal(sources.filter(source => source.kind === 'goal').length, 3, 'three goal rounds reached the orchestrator');
  assert.ok(!chat.events.some(event => event.type === 'tool/call' && event.data.name === 'create_goal'));

  // A stale page is refused; a raised round budget lets it continue.
  assert.equal((await app.call('autonomy/resume', { id, revision: detail.revision - 1 })).status, 400);
  const blocked = await app.call('autonomy/resume', { id, revision: detail.revision });
  assert.equal(blocked.status, 400); assert.match((await blocked.json()).error, /轮数已到上限/);
  detail = await app.json('autonomy/update', { id, revision: detail.revision, settings: { maxRounds: 5 } });
  detail = await app.json('autonomy/resume', { id, revision: detail.revision });
  assert.equal(detail.state, 'running');
  detail = await until(async () => { const value = await run(id); return value.state === 'paused' ? value : undefined; }, 'second round budget pause');
  assert.deepEqual([detail.pauseReason, detail.usage.rounds], ['budget-rounds', 5]);
  detail = await app.json('autonomy/stop', { id, revision: detail.revision });
  assert.equal(detail.state, 'stopped');
  assert.equal((await app.json('status')).chats.find(item => item.id === chatId).role, 'orchestrator', 'a run conversation keeps its mark after the run');

  // A restart pauses an active run until a person continues it.
  detail = await app.json('autonomy/start', { projectId: project.id, objective: '重启后暂停', settings: { orchestratorModel: smoke, workerModel: smoke, maxRounds: 100000 } });
  const second = detail.id;
  await until(async () => (await run(second)).usage.rounds >= 1, 'the second run is working').catch(async error => {
    const value = await run(second), chat = await app.json(`chat?id=${value.orchestratorChatId}`);
    console.error(JSON.stringify({ state: value.state, usage: value.usage, events: value.events.slice(0, 10), chat: chat.status, sessionEvents: chat.events.map(event => [event.type, event.data?.source?.kind ?? event.data?.reason?.kind ?? event.data?.name ?? '']) }, null, 1).slice(0, 6000));
    throw error;
  });
  await stopApp(app.child);
  app = await startApp(home);
  detail = await run(second);
  assert.deepEqual([detail.state, detail.pauseReason], ['paused', 'restart']);
  const restart = detail.attention.find(item => item.kind === 'restart' && !item.resolvedAt);
  assert.ok(restart, 'a restart item asks a person');
  const rounds = detail.usage.rounds;
  await delay(1500);
  assert.equal((await run(second)).usage.rounds, rounds, 'nothing runs while paused');
  detail = await app.json('autonomy/attention/resolve', { id: second, attentionId: restart.id, action: 'continue' });
  assert.equal(detail.state, 'running');
  await until(async () => (await run(second)).usage.rounds > rounds, 'the goal continues after the person resumed it');
  detail = await app.json('autonomy/pause', { id: second, revision: (await run(second)).revision });
  assert.deepEqual([detail.state, detail.pauseReason], ['paused', 'user']);
  const frozen = (await run(second)).usage.rounds; await delay(1500);
  assert.ok((await run(second)).usage.rounds <= frozen + 1, 'a pause stops the rounds');
  detail = await app.json('autonomy/stop', { id: second, revision: detail.revision });
  assert.equal(detail.state, 'stopped');
  const runs = await app.json(`autonomy/runs?projectId=${project.id}`);
  assert.deepEqual(runs.runs.map(item => [item.id, item.state]), [[second, 'stopped'], [id, 'stopped']]);
  console.log('Autonomy backend verified: goal wiring, round budget, resume, restart pause, stop and revision checks.');
} finally {
  if (app) await stopApp(app.child);
  await rm(home, { recursive: true, force: true });
}
