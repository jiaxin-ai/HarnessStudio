import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { root } from './prepare.mjs';
import { startApp, stopApp } from './verify-app.mjs';
import { emptyChatState, foldChatPacket, conversationRows, pendingToolCalls, webActivities, questionActivities } from '../plugins/ui/lib/chat-state.js';

await mkdir(join(root, '.studio'), { recursive: true });
const home = await mkdtemp(join(root, '.studio/chat-steps-test-'));
const subscriptions = new Set();
let app;

async function until(predicate, message) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await delay(20); }
  throw new Error(message);
}

/** Consume the actual anonymous same-origin SSE and use exactly the browser reducer. */
async function listen(id) {
  const response = await app.call(`chat/stream?id=${encodeURIComponent(id)}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader(), decoder = new TextDecoder(), packets = [];
  let buffer = '', state = emptyChatState(), closed = false, failure;
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
          state = foldChatPacket(state, packet); packets.push(packet);
        }
      }
    } catch (error) { if (!closed) failure = error; }
    finally { reader.releaseLock(); }
  })();
  const subscription = {
    packets,
    state() { if (failure) throw failure; return state; },
    rows() { return conversationRows(this.state()); },
    async close() {
      if (closed) return;
      closed = true; await reader.cancel(); await completed; subscriptions.delete(subscription);
    },
  };
  subscriptions.add(subscription);
  return subscription;
}

const assistants = subscription => subscription.rows().filter(row => row.role === 'assistant');
const lastStep = subscription => assistants(subscription).at(-1)?.steps.at(-1);
// block-start intentionally creates an empty text slot before any delta arrives.
// Observing a nonempty array alone must never count as visible streamed content.
const hasText = blocks => blocks?.some(text => text.trim().length > 0) === true;
const snapshot = subscription => subscription.packets.find(packet => packet.type === 'snapshot');
async function reconnect(id) {
  const subscription = await listen(id);
  await until(() => { subscription.state(); return snapshot(subscription); }, 'No chronological chat reconnect snapshot');
  return subscription;
}
const model = { provider: 'studio-smoke', model: 'm1-smoke' };
async function send(id) {
  return app.json('chat', { taskId: 'm1-gear', ...model, ...(id ? { id } : {}), message: '[chat-step-timeline] Verify independent calls and interleaved evidence' });
}
async function pendingQuestion(id) {
  return until(async () => (await app.json(`chat/questions?id=${id}`)).pending.find(item => item.canAnswer), 'The third native call did not wait for an explicit question answer');
}
async function answer(id, callId) {
  assert.deepEqual(await app.json('chat/questions/answer', { id, callId, answers: [{ id: 'timeline_continue', selected: ['继续演示'] }] }), { accepted: true });
}

function completedTimeline(rows, turns = 1) {
  assert.equal(rows.filter(row => row.role === 'user').length, turns);
  const calls = rows.filter(row => row.role === 'assistant');
  assert.equal(calls.length, turns, 'Each user turn must retain its own assistant timeline');
  for (const call of calls) {
    assert.deepEqual(call.steps.map(step => step.number), [1, 2, 3, 4]);
    assert.equal(new Set(call.steps.map(step => step.id)).size, 4);
    assert.deepEqual(call.steps.map(step => step.tools.map(tool => tool.name)), [['web_search'], ['studio_list_temp_files'], ['ask_user_question'], []]);
    for (const step of call.steps) {
      assert.equal(step.streaming, false);
      assert.equal(step.reasoning.length, 1, 'Reasoning must settle once in its original provider call');
      assert.match(step.reasoning[0], new RegExp(`^步骤 ${step.number} 的公开测试说明`));
      assert.equal(step.text.length, 1, 'Intermediate and final text must each stay with their original call');
      assert.match(step.text[0], new RegExp(`^步骤 ${step.number}：`));
      for (const tool of step.tools) { assert.equal(tool.failed, false); assert.equal(typeof tool.result, 'string'); }
    }
    assert.equal(webActivities([call.steps[0]])[0].status, 'complete');
    assert.equal(webActivities([call.steps[0]])[0].sources.length, 2);
    assert.deepEqual(webActivities(call.steps.slice(1)), [], 'Search cards must remain at call 1');
    const answered = questionActivities([call.steps[2]]);
    assert.equal(answered.length, 1); assert.equal(answered[0].status, 'complete');
    assert.deepEqual(answered[0].questions.map(item => item.selected), [['继续演示']]);
    assert.deepEqual(questionActivities([call.steps[0], call.steps[1], call.steps[3]]), [], 'Question cards must remain at call 3');
  }
  assert.equal(new Set(calls.flatMap(call => call.steps.map(step => step.id))).size, turns * 4, 'Step identifiers must distinguish turns');
}

/** Only release this newly created fixture, never the shared preview home. */
async function release(path) {
  await chmod(path, 0o700);
  for (const row of await readdir(path, { withFileTypes: true })) if (row.isDirectory() && !row.isSymbolicLink()) await release(join(path, row.name));
}

try {
  const environment = { STUDIO_SMOKE_STEP_DELAY_MS: '180', STUDIO_SMOKE_WEB_DELAY_MS: '700' };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  try { app = await startApp(home); }
  finally { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  assert.equal((await fetch(`${app.base}/api/studio/chat/stream?id=unknown`)).status, 400);

  const first = await send();
  const streaming = await listen(first.id);
  await until(() => lastStep(streaming)?.streaming && hasText(lastStep(streaming)?.text) && hasText(lastStep(streaming)?.reasoning), 'Call 1 text and thought were not visible before native settlement');
  assert.deepEqual(assistants(streaming)[0].steps.map(step => step.number), [1]);
  assert.equal(streaming.state().events.some(event => event.type === 'assistant/message'), false, 'Streaming must show an independent call before it is saved');
  await until(() => pendingToolCalls(streaming.state()).some(call => call.name === 'web_search'), 'No native search between calls 1 and 2');
  assert.equal(lastStep(streaming).number, 1); assert.equal(lastStep(streaming).streaming, false);
  assert.match(lastStep(streaming).text[0], /^步骤 1：/);
  assert.equal(webActivities([lastStep(streaming)])[0].status, 'pending');
  await streaming.close();

  const resumed = await reconnect(first.id);
  assert.equal(assistants(resumed)[0].steps[0].tools[0].name, 'web_search');
  await until(() => lastStep(resumed)?.number === 2 && lastStep(resumed)?.streaming && hasText(lastStep(resumed)?.text) && hasText(lastStep(resumed)?.reasoning), 'Call 2 did not receive a separate live thought/output step');
  const two = assistants(resumed)[0].steps;
  assert.deepEqual(two.map(step => step.number), [1, 2]);
  assert.equal(two[0].streaming, false); assert.equal(two[1].streaming, true);
  assert.equal(webActivities([two[0]])[0].status, 'complete');
  assert.match(two[0].text[0], /^步骤 1：/); assert.match(two[1].text[0], /^步骤 2：/);

  const question = await pendingQuestion(first.id);
  await until(() => lastStep(resumed)?.tools.some(tool => tool.id === question.callId), 'Native question call absent from the chronological stream');
  assert.deepEqual(assistants(resumed)[0].steps.map(step => step.number), [1, 2, 3]);
  assert.equal(lastStep(resumed).streaming, false);
  assert.equal(lastStep(resumed).tools[0].name, 'ask_user_question');
  assert.equal(lastStep(resumed).tools[0].result, undefined, 'No question answer may be fabricated while waiting');
  await delay(80);
  assert.equal(lastStep(resumed).number, 3, 'Call 4 must not occur before a real human answer');
  await resumed.close();

  const waiting = await reconnect(first.id);
  assert.equal(lastStep(waiting).number, 3); assert.equal(lastStep(waiting).tools[0].id, question.callId);
  await answer(first.id, question.callId);
  await until(() => lastStep(waiting)?.number === 4 && lastStep(waiting)?.streaming && hasText(lastStep(waiting)?.reasoning), 'No independent final native model call after the explicit answer');
  assert.equal(assistants(waiting)[0].steps[2].streaming, false);
  await until(() => waiting.state().status === 'idle' && waiting.state().events.filter(event => event.type === 'turn/end').length === 1, 'First chronological native turn did not finish');
  completedTimeline(waiting.rows());
  assert.equal(waiting.state().metrics.usage.totalTokens, 520, 'Four real provider calls must retain normal cumulative metering');
  const firstRows = waiting.rows();
  await waiting.close();

  const history = await reconnect(first.id);
  assert.deepEqual(history.rows(), firstRows, 'Saved history and running timeline must render identically');
  let duplicate = history.state();
  for (const event of duplicate.events) duplicate = foldChatPacket(duplicate, { type: 'event', event });
  assert.deepEqual(conversationRows(duplicate), firstRows, 'Duplicated durable events must not duplicate calls, reasoning or evidence');

  await send(first.id);
  const secondQuestion = await pendingQuestion(first.id);
  assert.notEqual(secondQuestion.callId, question.callId);
  await answer(first.id, secondQuestion.callId);
  await until(() => history.state().status === 'idle' && history.state().events.filter(event => event.type === 'turn/end').length === 2, 'Second chronological native turn did not finish');
  completedTimeline(history.rows(), 2);
  assert.equal(history.state().metrics.usage.totalTokens, 1040);
  const twoTurnRows = history.rows();
  await history.close();

  await stopApp(app.child); app = undefined;
  app = await startApp(home);
  const cold = await reconnect(first.id);
  assert.equal(cold.state().status, 'stored', 'Viewing cold history must not launch a model');
  assert.deepEqual(cold.rows(), twoTurnRows, 'Cold restore must preserve independent calls and human answer placement');
  completedTimeline(cold.rows(), 2);
  assert.equal(cold.state().metrics.usage.totalTokens, 1040);
  await cold.close();

  console.log('Chat step timeline verification passed: four independent native model calls with streaming thought/text, interleaved search and scratch tools, real blocking questions and explicit answers, active-call isolation, running reconnect, saved history, duplicate-event replay, two turns and cold restore; normal token metering preserved. Isolated keyless smoke home, no external model or network.');
} catch (error) { console.error(error); process.exitCode = 1; }
finally {
  for (const subscription of subscriptions) await subscription.close();
  if (app) await stopApp(app.child);
  await release(home); await rm(home, { recursive: true, force: true });
}
