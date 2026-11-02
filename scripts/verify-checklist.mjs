import assert from 'node:assert/strict';
import { mkdir, mkdtemp, chmod, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { root } from './prepare.mjs';
import { startApp, stopApp } from './verify-app.mjs';
import { emptyChatState, foldChatPacket, conversationRows } from '../plugins/ui/lib/chat-state.js';

await mkdir(join(root, '.studio'), { recursive: true });
const home = await mkdtemp(join(root, '.studio/checklist-test-'));
let app;
const model = { provider: 'studio-smoke', model: 'm1-smoke' };
const text = content => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(block => block.type === 'text').map(block => block.text).join('') : '';
const task = id => app.json(`task?id=${id}`);
const graph = id => app.json(`graph?projectId=${id}`);
const expected = row => ({ id: row.id, title: row.title, description: row.goal, checklistTexts: row.checklist.map(item => item.text) });

async function finished(id, afterTurns) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const chat = await app.json(`chat?id=${id}`);
    if (chat.status === 'idle' && chat.events.filter(event => event.type === 'turn/end').length > afterTurns) return chat;
    await delay(60);
  }
  throw new Error('Native Checklist conversation did not finish the controlled test');
}

/** Mutations under test always travel through DSH native tool calls and persisted tool results. */
async function probe(scope, marker, fixture, existingId) {
  const before = existingId ? await app.json(`chat?id=${existingId}`) : undefined;
  const turns = before?.events.filter(event => event.type === 'turn/end').length ?? 0;
  const sequence = before?.events.at(-1)?.seq ?? -1;
  const chat = await app.json('chat', { ...scope, ...(existingId ? { id: existingId } : {}), ...model,
    message: `[checklist-${marker}] ${JSON.stringify({ scope: scope.taskId ? 'task' : 'project', ...fixture })}` });
  const history = await finished(chat.id, turns), events = history.events.filter(event => event.seq > sequence);
  const ended = events.find(event => event.type === 'turn/end');
  assert.ok(ended, 'Native TODO turn must settle');
  assert.notEqual(ended.data.reason?.kind, 'error', `TODO schema, system prompt or transport probe failed: ${JSON.stringify(ended.data.reason)}`);
  const calls = events.filter(event => event.type === 'tool/call');
  assert.deepEqual(calls.map(event => event.data.name), fixture.items ? ['studio_read_checklist', 'studio_update_checklist', 'studio_read_checklist'] : ['studio_read_checklist']);
  const results = calls.map(call => {
    const result = events.find(event => event.type === 'tool/result' && event.data.message.source.callId === call.data.callId);
    assert.ok(result, `Missing persisted native result for ${call.data.name}`); return result.data.message;
  });
  assert.ok(events.some(event => event.type === 'assistant/message' && text(event.data.message.content).includes('Checklist native schemas and live shared system metadata verified')));
  const values = results.map(result => result.isError ? undefined : JSON.parse(text(result.content)));
  return { id: chat.id, history, calls, results, values };
}

async function metadata(row, changes) {
  return app.json('task/metadata', { id: row.id, revision: row.revision, title: row.title, goal: row.goal, checklist: row.checklist, ...changes });
}
async function quick(projectId, title, parentId) {
  const row = await app.json('task/quick', { projectId, title, ...(parentId ? { parentId } : {}) });
  return metadata(row, { goal: `明确${title}的要求与验收边界；仅为受控插件测试。`, checklist: [{ text: `核对${title}的用户确认要求` }, { text: '记录尚待澄清的事项' }] });
}
async function rejected(scope, marker, fixture, existingId, projectId, readRejected = false) {
  const before = await graph(projectId), result = await probe(scope, marker, fixture, existingId);
  assert.equal(!!result.results[0].isError, readRejected, `${marker}: native read permission must match its scope`);
  assert.equal(!!result.results[1].isError, true, `${marker}: native checklist update must be rejected`);
  assert.deepEqual(await graph(projectId), before, `${marker}: a rejected checklist must not mutate nodes or project revisions`);
  return result;
}
async function release(path) {
  await chmod(path, 0o700);
  for (const row of await readdir(path, { withFileTypes: true })) if (row.isDirectory() && !row.isSymbolicLink()) await release(join(path, row.name));
}

try {
  app = await startApp(home);
  const project = await app.json('projects', { title: '任务文字清单原生工具验证' }), otherProject = await app.json('projects', { title: 'TODO 作用域隔离项目' });
  let parent = await quick(project.id, '规划传动机构'), child = await quick(project.id, '设计驱动齿轮', parent.id), grandchild = await quick(project.id, '核对齿形要求', child.id);
  const sibling = await quick(project.id, '设计机架'), foreign = await quick(otherProject.id, '其他项目的轴承');
  const foreignBefore = await graph(otherProject.id), projectScope = { projectId: project.id }, localScope = { taskId: parent.id };

  const projectEdit = await probe(projectScope, 'project-edit', { taskId: child.id, items: [{ ...child.checklist[0], text: '核对用户确认的齿轮模数与齿数要求' }, { text: '标注设计依据及尚待澄清的信息' }] });
  assert.equal(projectEdit.history.scope, 'project'); assert.equal(projectEdit.history.projectId, project.id); assert.equal(Object.hasOwn(projectEdit.history, 'taskId'), false);
  assert.equal(!!projectEdit.results[1].isError, false); assert.equal(projectEdit.values[0].canEditMetadata, true);
  child = await task(child.id);
  assert.equal(child.checklist[0].id, projectEdit.values[0].checklist[0].id, 'A revised retained requirement must preserve its stable ID');
  assert.notEqual(child.checklist[1].id, projectEdit.values[0].checklist[1].id, 'A replacement new requirement must receive a fresh server ID');
  assert.deepEqual(projectEdit.values[1].checklist, child.checklist); assert.deepEqual(projectEdit.values[2].checklist, child.checklist);
  assert.equal(child.state, 'unstarted', 'TODO tools must not start or complete a task');
  assert.equal(child.title, projectEdit.values[0].title); assert.ok(child.goal.includes('受控插件测试'));

  parent = await task(parent.id);
  const rootItems = [{ ...parent.checklist[1], text: '整理需求、边界与未确认的问题' }, parent.checklist[0], { text: '将交付文件与验收要求对应起来' }];
  const rootEdit = await probe(localScope, 'own-task-edit', { taskId: parent.id, items: rootItems, expectTask: expected(parent),
    expectAfter: { ...expected(parent), checklistTexts: rootItems.map(item => item.text) } });
  assert.equal(rootEdit.history.scope, 'task'); assert.equal(rootEdit.history.taskId, parent.id); assert.equal(!!rootEdit.results[1].isError, false);
  parent = await task(parent.id);
  assert.equal(parent.checklist[0].id, rootItems[0].id); assert.equal(parent.checklist[1].id, rootItems[1].id, 'Reordering requirements must keep their IDs');
  const descendantEdit = await probe(localScope, 'descendant-edit', { taskId: grandchild.id, items: [{ ...grandchild.checklist[0], text: '核对已确认齿形与制造限制' }], expectTask: expected(parent) }, rootEdit.id);
  assert.equal(!!descendantEdit.results[1].isError, false); grandchild = await task(grandchild.id);
  assert.equal(grandchild.checklist.length, 1); assert.equal(grandchild.checklist[0].id, descendantEdit.values[0].checklist[0].id);

  await rejected(projectScope, 'foreign-project', { taskId: foreign.id, revision: foreign.revision, items: [{ text: '越权要求不得保存' }] }, projectEdit.id, project.id, true);
  assert.deepEqual(await graph(otherProject.id), foreignBefore, 'Native tools must leave a different project untouched');
  await rejected(localScope, 'outside-sibling', { taskId: sibling.id, revision: sibling.revision, items: [{ text: '越权兄弟任务要求不得保存' }], expectTask: expected(parent) }, rootEdit.id, project.id, true);
  await rejected(localScope, 'display-code', { taskId: grandchild.code, revision: grandchild.revision, items: [{ text: '不能用公开编号代替内部任务引用' }], expectTask: expected(parent) }, rootEdit.id, project.id, true);
  await rejected(localScope, 'stale-revision', { taskId: grandchild.id, revision: descendantEdit.values[0].revision, items: [{ text: '旧版本不得覆盖最新清单' }], expectTask: expected(parent) }, rootEdit.id, project.id);
  await rejected(localScope, 'foreign-item-id', { taskId: grandchild.id, items: [{ id: sibling.checklist[0].id, text: '别的任务的条目编号不能挪用' }], expectTask: expected(parent) }, rootEdit.id, project.id);
  await rejected(localScope, 'fake-checked-field', { taskId: grandchild.id, items: [{ ...grandchild.checklist[0], checked: true }], expectTask: expected(parent) }, rootEdit.id, project.id);

  const secondChat = await probe(localScope, 'second-conversation', { taskId: parent.id, expectTask: expected(parent) });
  const earlierTitle = parent.title, earlierDescription = parent.goal;
  parent = await metadata(parent, { title: '规划精修传动机构', goal: '共享的新描述：明确齿轮传动边界、设计依据和应交付的文件，不编造参数。',
    checklist: [{ ...parent.checklist[0], text: '核对新的用户约束与设计依据' }, parent.checklist[1]] });
  assert.notEqual(parent.title, earlierTitle); assert.notEqual(parent.goal, earlierDescription);
  await probe(localScope, 'same-chat-live-metadata', { taskId: parent.id, expectTask: expected(parent) }, rootEdit.id);
  await probe(localScope, 'other-chat-live-metadata', { taskId: parent.id, expectTask: expected(parent) }, secondChat.id);
  const thirdChat = await probe(localScope, 'new-chat-live-metadata', { taskId: parent.id, expectTask: expected(parent) });
  const clear = await probe(localScope, 'clear-checklist', { taskId: parent.id, items: [], expectTask: expected(parent), expectAfter: { ...expected(parent), checklistTexts: [] } }, thirdChat.id);
  assert.equal(!!clear.results[1].isError, false); parent = await task(parent.id); assert.deepEqual(parent.checklist, []);
  await probe(localScope, 'shared-empty-checklist', { taskId: parent.id, expectTask: expected(parent) }, secondChat.id);
  const restored = await probe(localScope, 'restore-checklist', { taskId: parent.id, items: [{ text: '最终确认用户已澄清的传动要求' }], expectTask: expected(parent), expectAfter: { ...expected(parent), checklistTexts: ['最终确认用户已澄清的传动要求'] } }, rootEdit.id);
  assert.equal(!!restored.results[1].isError, false); parent = await task(parent.id);

  const immutableTask = await quick(project.id, '正式完成结果的清单保护');
  await app.json('file', { taskId: immutableTask.id, path: 'report.md', content: '原生 TODO 插件测试的受控文件，非真实工程成果。' });
  const preview = await app.json(`task/completion?taskId=${immutableTask.id}`);
  const submitted = await app.json('task/completion/files', { taskId: immutableTask.id, revision: preview.taskRevision, workspaceVersion: preview.workspaceVersion, files: [{ path: 'report.md', description: 'TODO 插件完成结果保护的受控证据' }] });
  const completion = await app.json('task/completion', { taskId: immutableTask.id, revision: submitted.taskRevision, workspaceVersion: submitted.workspaceVersion,
    checkedGoalIds: submitted.goals.filter(goal => !goal.system).map(goal => goal.id), submissionId: submitted.submittedFiles.id });
  assert.equal(completion.task.state, 'completed');
  const snapshot = await app.json(`snapshot?taskId=${immutableTask.id}&id=${completion.task.completedId}`);
  const completedReject = await rejected(projectScope, 'completed-task', { taskId: immutableTask.id, items: [{ text: '不能静默改正式完成结果' }] }, projectEdit.id, project.id);
  assert.equal(completedReject.values[0].canEditMetadata, false);
  assert.deepEqual(await app.json(`snapshot?taskId=${immutableTask.id}&id=${completion.task.completedId}`), snapshot, 'A rejected TODO edit must not rewrite immutable result metadata or files');

  const beforeRestart = await graph(project.id), projectHistory = await app.json(`chat?id=${projectEdit.id}`), localHistory = await app.json(`chat?id=${rootEdit.id}`);
  const rows = conversationRows(foldChatPacket(emptyChatState(), { type: 'snapshot', chat: localHistory, live: [] }));
  await stopApp(app.child); app = undefined; app = await startApp(home);
  assert.deepEqual(await graph(project.id), beforeRestart, 'Names, shared descriptions, checklist texts/IDs and task/project revisions must recover exactly');
  const recoveredProject = await app.json(`chat?id=${projectEdit.id}`), recoveredLocal = await app.json(`chat?id=${rootEdit.id}`);
  assert.deepEqual(recoveredProject.events, projectHistory.events); assert.deepEqual(recoveredLocal.events, localHistory.events);
  assert.deepEqual(conversationRows(foldChatPacket(emptyChatState(), { type: 'snapshot', chat: recoveredLocal, live: [] })), rows, 'Stored native checklist calls/results must replay into the identical conversation');
  const resumed = await probe(localScope, 'restart-resume-live-metadata', { taskId: parent.id, expectTask: expected(parent) }, rootEdit.id);
  assert.deepEqual(resumed.values[0].checklist, parent.checklist);
  await probe(localScope, 'restart-new-conversation', { taskId: parent.id, expectTask: expected(parent) });
  assert.deepEqual(await graph(otherProject.id), foreignBefore);
  console.log('Checklist verification passed: actual DSH TODO plugin/native schemas and instructions, project/current-task/recursive-descendant edits, stable server item IDs and reorder/removal, cross-project/sibling/display-code/stale-revision/foreign-item/fake-status rejections, live shared title/description/checklist in existing/new model requests and within a tool turn, immutable completed result guards, persistence, exact event replay and restart/resume. No external model, network or industrial software called.');
} catch (error) { console.error(error); process.exitCode = 1; }
finally { if (app) await stopApp(app.child); await release(home); await rm(home, { recursive: true, force: true }); }
