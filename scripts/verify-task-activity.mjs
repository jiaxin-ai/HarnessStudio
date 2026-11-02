import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, chmod, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { buildSync } from 'esbuild';
import { startApp, stopApp, finishedChat } from './verify-app.mjs';

const home = await realpath(await mkdtemp(join(tmpdir(), 'studio-task-activity-')));
const preview = process.argv.includes('--preview');
let app;
const model = { provider: 'studio-smoke', model: 'm1-smoke' };
const questions = [{ id: 'route', header: '交付', question: '选择本次交付方式', options: [{ label: '参数说明' }, { label: '参考草图' }] }];
const answers = [{ id: 'route', selected: ['参数说明'] }];
const bundle = buildSync({ entryPoints: ['plugins/ui/src/task-activity.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { aggregateTaskActivity } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
async function waitFor(operation, ready, message) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { const value = await operation(); if (ready(value)) return value; await delay(50); }
  throw new Error(message);
}
async function activity(id, kind) {
  return waitFor(() => app.json('status'), status => status.chats.find(chat => chat.id === id)?.activity?.kind === kind, `Expected activity ${kind}`);
}
async function ask(taskId, marker, timeout) {
  return app.json('chat', { taskId, ...model, message: `[questions-${marker}] ${JSON.stringify({ questions, expectAnswers: answers, ...(timeout === undefined ? {} : { timeout }) })}` });
}
async function release(directory) {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink()) await release(join(directory, entry.name));
}
try {
  app = await startApp(home);
  const project = await app.json('projects', { title: '任务活动灯隔离验证' });
  const parent = await app.json('task/quick', { projectId: project.id, title: '父任务' });
  const nested = await app.json('task/quick', { projectId: project.id, parentId: parent.id, title: '子任务组' });
  const leaf = await app.json('task/quick', { projectId: project.id, parentId: nested.id, title: '确认产物形式' });
  const untouched = await app.json('task/quick', { projectId: project.id, title: '未交谈任务' });
  const hidden = await ask(leaf.id, 'blocking');
  const waiting = await activity(hidden.id, 'question');
  assert.equal(waiting.chats.find(chat => chat.id === hidden.id).status, 'running');
  const directory = await app.json('directory'), lights = aggregateTaskActivity(directory, waiting.chats);
  assert.equal(lights.get(parent.id).attention, 'waiting'); assert.equal(lights.get(nested.id).attention, 'waiting');
  assert.equal(lights.get(untouched.id).attention, 'steady');
  const independent = await app.json('chat', { projectId: project.id, ...model, message: '[project-chat-only]' });
  await finishedChat(app, independent.id);
  assert.equal((await activity(hidden.id, 'question')).chats.find(chat => chat.id === independent.id).activity.kind, 'awaiting-input');
  const question = (await app.json(`chat/questions?id=${hidden.id}`)).pending[0];
  assert.ok(question.canAnswer);
  await app.json('chat/questions/answer', { id: hidden.id, callId: question.callId, answers });
  await finishedChat(app, hidden.id); const answered = await activity(hidden.id, 'awaiting-input');
  assert.equal(aggregateTaskActivity(directory, answered.chats).get(parent.id).attention, 'active');
  assert.equal((await app.json(`task?id=${leaf.id}`)).state, 'unstarted', 'activity cannot advance human completion');

  const timed = await ask(leaf.id, 'timed', 1); const timedDone = await finishedChat(app, timed.id);
  await activity(timed.id, 'question');
  const timedCall = timedDone.events.find(event => event.type === 'tool/call' && event.data.name === 'ask_user_question').data.callId;
  const oldSeqs = timedDone.events.map(event => event.seq);
  await stopApp(app.child); app = undefined; app = await startApp(home);
  for (let index = 0; index < 3; index++) {
    const cold = await app.json('status');
    assert.ok(cold.chats.every(chat => chat.status === 'stored'), 'read-only lights must not resume cold Agents');
    assert.equal(cold.chats.find(chat => chat.id === timed.id).activity.kind, 'question');
    assert.equal(cold.chats.find(chat => chat.id === hidden.id).activity.kind, 'awaiting-input');
  }
  assert.deepEqual((await app.json(`chat?id=${timed.id}`)).events.map(event => event.seq), oldSeqs, 'status reads cannot append Session repair or request events');
  await app.json('chat/questions/answer', { id: timed.id, callId: timedCall, answers });
  await waitFor(() => app.json(`chat?id=${timed.id}`), chat => chat.status === 'idle' && chat.events.length > timedDone.events.length, 'Explicit late reply did not continue the native conversation');
  await activity(timed.id, 'awaiting-input');

  const stopped = await ask(leaf.id, 'stopped'); await activity(stopped.id, 'question');
  await app.json('chat/stop', { id: stopped.id }); await activity(stopped.id, 'awaiting-input');
  console.log('Task activity verified with actual native asks/answers: hidden running question, recursive folder attention, independent project chat, answered/cancelled waits, continued question after restart, repeated cold status reads without Agent resume or Session edits, and unchanged human workflow state. Local synthetic model only.');
  if (preview) {
    const idle = await app.json('task/quick', { projectId: project.id, title: '等待继续输入 · 灰色呼吸灯' });
    const idleChat = await app.json('chat', { taskId: idle.id, ...model, message: '本机合成场景：本轮沟通已结束，等待用户下一次输入。' });
    await finishedChat(app, idleChat.id); await activity(idleChat.id, 'awaiting-input');
    const completed = await app.json('task/quick', { projectId: project.id, title: '已完成并提交 · 绿色常亮' });
    await app.json('file', { taskId: completed.id, path: 'activity-verification.md', content: '本机合成的活动状态展示证据，不是真实工程产物。' });
    const completion = await app.json(`task/completion?taskId=${completed.id}`);
    const submission = await app.json('task/completion/files', { taskId: completed.id, revision: completion.taskRevision,
      workspaceVersion: completion.workspaceVersion, files: [{ path: 'activity-verification.md', description: '活动灯隔离验证的合成证据' }] });
    const completedTask = (await app.json('task/completion', { taskId: completed.id, revision: submission.taskRevision,
      workspaceVersion: submission.workspaceVersion, childrenVersion: submission.childrenVersion,
      checkedGoalIds: submission.goals.filter(goal => !goal.system).map(goal => goal.id), submissionId: submission.submittedFiles.id })).task;
    assert.equal(completedTask.state, 'completed');
    // A timed native question survives as an actionable continued question. The
    // entire preview is then cold-stored: displaying lights cannot run a model.
    const pending = await ask(leaf.id, 'preview', 1);
    await finishedChat(app, pending.id); await activity(pending.id, 'question');
    await stopApp(app.child); app = undefined; app = await startApp(home);
    const cold = await app.json('status'), directory = await app.json('directory');
    assert.ok(cold.chats.every(chat => chat.status === 'stored'));
    const lights = aggregateTaskActivity(directory, cold.chats);
    assert.equal(lights.get(parent.id).attention, 'waiting'); assert.equal(lights.get(nested.id).attention, 'waiting');
    assert.equal(lights.get(leaf.id).attention, 'waiting'); assert.equal(lights.get(idle.id).attention, 'active');
    assert.equal(lights.get(completed.id).base, 'green'); assert.equal(lights.get(completed.id).attention, 'steady');
    assert.equal(lights.get(untouched.id).attention, 'steady');
    console.log(JSON.stringify({ previewURL: app.url, home, verifierPid: process.pid, appPid: app.child.pid, projectId: project.id,
      parentTask: { id: parent.id, code: parent.code, title: parent.title },
      nestedTask: { id: nested.id, code: nested.code, title: nested.title },
      questionTask: { id: leaf.id, code: leaf.code, title: leaf.title, chatId: pending.id },
      idleTask: { id: idle.id, code: idle.code, title: idle.title, chatId: idleChat.id },
      completedTask: { id: completed.id, code: completed.code, title: completed.title },
      untouchedTask: { id: untouched.id, code: untouched.code, title: untouched.title },
      syntheticOnly: true, previewExit: 'SIGTERM or SIGINT stops only this isolated fixture and removes its private home.' }));
    await new Promise(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); });
  }
} catch (error) { console.error(error); process.exitCode = 1; }
finally { if (app) await stopApp(app.child); await release(home); await rm(home, { recursive: true, force: true }); }
