import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { root, upstream } from './prepare.mjs';
import { startApp, stopApp } from './verify-app.mjs';

await mkdir(join(root, '.studio'), { recursive: true });
const home = await mkdtemp(join(root, '.studio/questions-test-'));
let app;
const model = { provider: 'studio-smoke', model: 'm1-smoke' };
const questions = [
  { id: 'domain', header: '方向', question: '本次工作的主要类型？', options: [{ label: 'CAD 设计', description: '先明确几何与装配要求' }, { label: 'CAE 分析', description: '先明确工况与判定标准' }, { label: 'EDA 电路', description: '先明确接口与电气约束' }] },
  { id: 'bounds', header: '约束', question: '目前已经确定哪些边界？', multi_select: true, options: [{ label: '使用场景' }, { label: '尺寸空间' }, { label: '预算' }] },
  { id: 'result', header: '产物', question: '希望最终得到什么产物？' },
];
const answers = [
  { id: 'domain', selected: ['CAE 分析'] },
  { id: 'bounds', selected: ['使用场景', '尺寸空间'], custom: '还要便于维护' },
  { id: 'result', selected: [], custom: '暂不确定，待后续明确' },
];
const text = content => content.filter(block => block.type === 'text').map(block => block.text).join('');
async function waitFor(operation, ready, message) {
  const end = Date.now() + 20000;
  while (Date.now() < end) { const value = await operation(); if (ready(value)) return value; await delay(50); }
  throw new Error(message);
}
async function pending(id) {
  return waitFor(() => app.json(`chat/questions?id=${id}`), view => view.pending.some(item => item.canAnswer), 'Native question wait did not become answerable');
}
async function finished(id, turns = 0) {
  return waitFor(() => app.json(`chat?id=${id}`), chat => chat.status === 'idle' && chat.events.filter(event => event.type === 'turn/end').length > turns, 'Native question continuation did not finish');
}
async function ask(scope, marker, extra = {}, id) {
  return app.json('chat', { ...scope, ...model, ...(id ? { id } : {}), message: `[questions-${marker}] ${JSON.stringify({ questions, expectAnswers: answers, ...extra })}` });
}
async function release(directory) {
  await chmod(directory, 0o700);
  for (const row of await readdir(directory, { withFileTypes: true })) if (row.isDirectory() && !row.isSymbolicLink()) await release(join(directory, row.name));
}
try {
  app = await startApp(home);
  const project = await app.json('projects', { title: '通用引导问答（隔离验证）' });
  const scope = { projectId: project.id };
  const initial = await ask(scope, 'blocking', { after: 'graph' });
  const view = await pending(initial.id), callId = view.pending[0].callId;
  assert.equal(view.pending[0].state, 'open'); assert.equal(view.settled.length, 0);
  assert.deepEqual(view.pending[0].questions.map(item => [item.id, item.multiSelect ?? false]), [['domain', false], ['bounds', true], ['result', false]]);
  const before = await app.json(`graph?projectId=${project.id}`);
  assert.equal(before.tasks.length, 0, 'Question wait cannot decompose the project before an explicit answer');
  await delay(150);
  const waitingChat = await app.json(`chat?id=${initial.id}`);
  assert.notEqual(waitingChat.status, 'idle'); assert.equal(waitingChat.events.filter(event => event.type === 'tool/call').length, 1);
  assert.equal(waitingChat.events.some(event => event.type === 'tool/result'), false, 'Default -1 question wait must not auto-return skipped/permission answers');
  const anonymous = await fetch(`${app.base}/api/studio/chat/questions?id=${initial.id}`);
  assert.equal(anonymous.status, 200, 'Native question routes are usable without a browser identity');
  assert.equal((await anonymous.json()).pending[0].callId, callId);
  for (const invalid of [[], [{ ...answers[0], selected: [] }, ...answers.slice(1)], [{ ...answers[0], selected: ['机械臂专属假定'] }, ...answers.slice(1)], [{ ...answers[0], selected: ['CAD 设计', 'CAE 分析'] }, ...answers.slice(1)], [answers[0], answers[1], { ...answers[2], id: 'domain' }]]) {
    assert.equal((await app.call('chat/questions/answer', { id: initial.id, callId, answers: invalid })).status, 400);
    assert.equal((await pending(initial.id)).pending[0].callId, callId);
  }
  // A hidden waiting chat must not prevent another owned chat from running.
  const independent = await app.json('chat', { ...scope, ...model, message: '[project-chat-only]' });
  await finished(independent.id);
  assert.equal((await app.call('chat/questions/answer', { id: independent.id, callId, answers })).status, 409);
  assert.deepEqual(await app.json('chat/questions/answer', { id: initial.id, callId, answers }), { accepted: true });
  const resumed = await finished(initial.id);
  const calls = resumed.events.filter(event => event.type === 'tool/call');
  assert.deepEqual(calls.map(event => event.data.name), ['ask_user_question', 'studio_create_task']);
  const questionResult = resumed.events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === callId);
  assert.ok(questionResult); assert.equal(questionResult.data.message.isError, false); assert.deepEqual(JSON.parse(text(questionResult.data.message.content)), { answers });
  assert.equal((await app.json(`graph?projectId=${project.id}`)).tasks.length, 1);
  const settled = await app.json(`chat/questions?id=${initial.id}`);
  assert.equal(settled.pending.length, 0); assert.deepEqual(settled.settled[0].answers, answers);
  assert.equal((await app.call('chat/questions/answer', { id: initial.id, callId, answers })).status, 409, 'Settled calls cannot accept duplicate answers');

  // Explicit timeout is not consent: the next native graph mutation is denied.
  const timed = await ask(scope, 'timed', { timeout: 1, after: 'graph' });
  const continued = await waitFor(() => app.json(`chat/questions?id=${timed.id}`), value => value.pending[0]?.state === 'continued', 'Timed question did not remain pending');
  const timedIdle = await finished(timed.id), timedCall = continued.pending[0].callId;
  const deniedCall = timedIdle.events.find(event => event.type === 'tool/call' && event.data.name === 'studio_create_task');
  assert.ok(deniedCall);
  assert.equal(timedIdle.events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === deniedCall.data.callId)?.data.message.isError, true);
  assert.equal((await app.json(`graph?projectId=${project.id}`)).tasks.length, 1, 'Timeout cannot create graph nodes');
  const timedTurns = timedIdle.events.filter(event => event.type === 'turn/end').length;
  await app.json('chat/questions/answer', { id: timed.id, callId: timedCall, answers });
  const late = await finished(timed.id, timedTurns);
  assert.ok(late.events.some(event => event.type === 'user/message' && event.data.source.kind === 'user-question-reply'));
  assert.equal((await app.json(`graph?projectId=${project.id}`)).tasks.length, 2, 'Official late reply permits native model continuation');

  // User stop cancels the native wait without fabricating an empty answer.
  const stopped = await ask(scope, 'stopped'); const stoppedQuestion = (await pending(stopped.id)).pending[0];
  await app.json('chat/stop', { id: stopped.id });
  assert.equal((await app.json(`chat/questions?id=${stopped.id}`)).pending.length, 0);
  assert.equal((await app.call('chat/questions/answer', { id: stopped.id, callId: stoppedQuestion.callId, answers })).status, 409);

  // Task-local guided questions have the same UI seam and retain nested ownership.
  const task = await app.json('task/quick', { projectId: project.id, title: '电气接口澄清（隔离验证）' });
  const local = await ask({ taskId: task.id }, 'nested', { after: 'graph' }); const localQuestion = (await pending(local.id)).pending[0];
  await app.json('chat/questions/answer', { id: local.id, callId: localQuestion.callId, answers }); await finished(local.id);
  const nested = (await app.json(`graph?projectId=${project.id}`)).tasks.filter(row => row.parentId === task.id);
  assert.equal(nested.length, 1);

  // A real process crash leaves a native unfinished call. Official Session resume
  // repairs it as continued; the same recorded question is answered through inbox.
  const crashed = await ask(scope, 'crashed', { after: 'graph' }); const crashedQuestion = (await pending(crashed.id)).pending[0];
  const crashedExit = new Promise(resolve => app.child.once('close', resolve));
  const { stdout } = await promisify(execFile)('pgrep', ['-P', String(app.child.pid)]);
  const ownedChildren = stdout.trim().split(/\s+/).map(Number);
  assert.ok(ownedChildren.every(pid => Number.isSafeInteger(pid) && pid > 0));
  // start.mjs also owns the Mock platform. Identify the actual Harness CLI only
  // among this disposable wrapper's children, so the crash leaves no unrelated
  // process at risk and does not mistake the Mock process for the native Agent.
  const { stdout: commands } = await promisify(execFile)('ps', ['-p', ownedChildren.join(','), '-o', 'pid=,command=']);
  const dshChildren = commands.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line);
    return match && ownedChildren.includes(Number(match[1])) && match[2].includes(join(upstream, 'apps/cli/lib/bin.js')) ? [Number(match[1])] : [];
  });
  assert.equal(dshChildren.length, 1, 'The isolated wrapper must own exactly one identifiable DSH CLI child');
  // Kill the actual Harness child, rather than orphaning it by killing its wrapper.
  process.kill(dshChildren[0], 'SIGKILL'); await crashedExit; app = undefined;
  app = await startApp(home);
  const restored = await pending(crashed.id);
  assert.equal(restored.pending[0].callId, crashedQuestion.callId); assert.equal(restored.pending[0].state, 'continued');
  assert.deepEqual(restored.pending[0].questions, crashedQuestion.questions);
  const afterRepair = await app.json(`chat?id=${crashed.id}`), repairTurns = afterRepair.events.filter(event => event.type === 'turn/end').length;
  await app.json('chat/questions/answer', { id: crashed.id, callId: crashedQuestion.callId, answers });
  const recovered = await finished(crashed.id, repairTurns);
  assert.ok(recovered.events.some(event => event.type === 'user/message' && event.data.source.kind === 'user-question-reply'));
  assert.equal((await app.json(`chat/questions?id=${crashed.id}`)).pending.length, 0);
  assert.equal((await app.json(`chat/questions?id=${initial.id}`)).settled[0].callId, callId);

  // Natural-language browser demo: three actual native batches in one turn,
  // requiring a distinct explicit graph-planning decision after the summary.
  for (const decision of ['生成任务图谱', '修正条件', '继续澄清']) {
    const demoProject = await app.json('projects', { title: `引导规划 ${decision}（隔离验证）` });
    const demo = await app.json('chat', { projectId: demoProject.id, ...model, message: '我想规划一项工程设计，具体交付形式还没有确定。[guided-planning-demo]' });
    const first = (await pending(demo.id)).pending[0];
    assert.deepEqual(first.questions.map(row => row.id), ['demo_domain', 'demo_constraints']);
    await app.json('chat/questions/answer', { id: demo.id, callId: first.callId, answers: [
      { id: 'demo_domain', selected: ['EDA'] }, { id: 'demo_constraints', selected: ['应用场景', '尺寸空间'], custom: '已有接口资料' },
    ] });
    const second = (await pending(demo.id)).pending[0];
    assert.notEqual(second.callId, first.callId); assert.deepEqual(second.questions.map(row => row.id), ['demo_deliverable']);
    await app.json('chat/questions/answer', { id: demo.id, callId: second.callId, answers: [{ id: 'demo_deliverable', selected: [], custom: '暂不确定，待后续明确' }] });
    const third = (await pending(demo.id)).pending[0];
    assert.notEqual(third.callId, second.callId); assert.deepEqual(third.questions.map(row => row.id), ['demo_plan_approval']);
    const beforeApproval = await app.json(`chat?id=${demo.id}`);
    const displayedSummary = beforeApproval.events.filter(event => event.type === 'assistant/message').map(event => text(event.data.message.content)).join('\n');
    assert.match(displayedSummary, /规划方向：EDA/u); assert.match(displayedSummary, /已有接口资料/u); assert.match(displayedSummary, /交付格式与验收方式仍待明确/u);
    assert.equal((await app.json(`graph?projectId=${demoProject.id}`)).tasks.length, 0, 'Answered engineering choices alone are not graph approval');
    await app.json('chat/questions/answer', { id: demo.id, callId: third.callId, answers: [{ id: 'demo_plan_approval', selected: [decision] }] });
    const demoDone = await finished(demo.id), demoGraph = await app.json(`graph?projectId=${demoProject.id}`);
    assert.deepEqual(demoDone.events.filter(event => event.type === 'tool/call').map(event => event.data.name), decision === '生成任务图谱' ? ['ask_user_question', 'ask_user_question', 'ask_user_question', 'studio_create_task'] : ['ask_user_question', 'ask_user_question', 'ask_user_question']);
    assert.equal(demoDone.events.filter(event => event.type === 'turn/start').length, 1, 'Demo stages continue in the actual same native turn');
    assert.equal(demoGraph.tasks.length, decision === '生成任务图谱' ? 1 : 0);
    if (demoGraph.tasks.length) {
      assert.equal(demoGraph.tasks[0].state, 'unstarted'); assert.match(demoGraph.tasks[0].goal, /已有接口资料/u);
      assert.match(demoGraph.tasks[0].goal, /暂不确定，待后续明确/u);
    }
  }
  console.log('Native planning questions verified: exact single/multiple/free/uncertain answers, no default or timeout consent, anonymous same-origin scoped question routes, independent hidden chats, native suspended tool/answer continuation, pending graph mutation guard, cancellation/stale rejection, task-local child ownership, persisted native questions and crash/restart late-answer continuation; natural-language guided demo performs three native batches, summarizes actual EDA answers/unknown deliverable, and creates only after explicit graph approval. No external model or industrial software invoked.');
} catch (error) { console.error(error); process.exitCode = 1; }
finally { if (app) await stopApp(app.child); await release(home); await rm(home, { recursive: true, force: true }); }
