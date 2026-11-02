import assert from 'node:assert/strict';
import { mkdir, mkdtemp, chmod, readdir, lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { root } from './prepare.mjs';
import { startApp, stopApp } from './verify-app.mjs';
import { emptyChatState, foldChatPacket, conversationRows } from '../plugins/ui/lib/chat-state.js';

await mkdir(join(root, '.studio'), { recursive: true });
const home = await mkdtemp(join(root, '.studio/planning-test-'));
let app;
const model = { provider: 'studio-smoke', model: 'm1-smoke' };
const text = content => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(block => block.type === 'text').map(block => block.text).join('') : '';
const definition = title => ({ title, goal: `核对${title}的受控测试证据`, constraints: '仅验证图谱规划权限，不代表真实工程参数',
  criteria: [{ id: 'proof', label: '测试证据', kind: 'check', method: '读取报告中的受控测试标记' }], outputs: ['report.md'], unresolved: [] });

async function finished(id, afterTurns) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const chat = await app.json(`chat?id=${id}`);
    if (chat.status === 'idle' && chat.events.filter(event => event.type === 'turn/end').length > afterTurns) return chat;
    await delay(70);
  }
  throw new Error('Graph planning conversation did not finish the controlled test');
}

/** Use only the official native tool path; fixtures never invoke domain mutations directly. */
async function plan(scope, marker, fixture, existingId) {
  const before = existingId ? await app.json(`chat?id=${existingId}`) : undefined;
  const afterTurns = before?.events.filter(event => event.type === 'turn/end').length ?? 0;
  const beforeSeq = before?.events.at(-1)?.seq ?? -1;
  const chat = await app.json('chat', { ...scope, ...(existingId ? { id: existingId } : {}), ...model,
    message: `[graph-plan-${marker}] ${JSON.stringify({ scope: scope.taskId ? 'task' : 'project', ...fixture })}` });
  const history = await finished(chat.id, afterTurns);
  const events = history.events.filter(event => event.seq > beforeSeq);
  const ended = events.find(event => event.type === 'turn/end');
  assert.ok(ended, 'Native planning turn must settle');
  assert.notEqual(ended.data.reason?.kind, 'error', 'Smoke schema or transport failures cannot count as planning validation');
  const calls = events.filter(event => event.type === 'tool/call');
  assert.deepEqual(calls.map(event => event.data.name), fixture.patch ? ['studio_graph_context', 'studio_apply_graph_patch', 'studio_graph_context'] : ['studio_graph_context']);
  const results = calls.map(call => {
    const result = events.find(event => event.type === 'tool/result' && event.data.message.source.callId === call.data.callId);
    assert.ok(result, `Missing persisted result for ${call.data.name}`); return result.data.message;
  });
  assert.ok(events.some(event => event.type === 'assistant/message' && text(event.data.message.content).includes('native schemas verified')));
  return { id: chat.id, history, calls, results, context: results[0].isError ? undefined : JSON.parse(text(results[0].content)),
    patch: fixture.patch && !results[1].isError ? JSON.parse(text(results[1].content)) : undefined,
    afterContext: fixture.patch && !results[2].isError ? JSON.parse(text(results[2].content)) : undefined };
}

async function graph(projectId) { return app.json(`graph?projectId=${projectId}`); }
function created(result, key) { const task = result.patch?.created.find(row => row.key === key); assert.ok(task, `Missing created graph key ${key}`); return task; }
function stableTaskIdentity(before, after) {
  for (const field of ['id', 'code', 'rank', 'createdAt', 'projectId']) assert.equal(after[field], before[field], `Planning must preserve ${field}`);
}

async function rejected(scope, marker, patch, existingId, projectId) {
  const before = await graph(projectId);
  const result = await plan(scope, marker, { patch }, existingId);
  assert.equal(result.results[0].isError, false, 'Reading a valid scope must succeed before a rejected patch');
  assert.equal(result.results[1].isError, true, `${marker} must produce a rejected native graph patch`);
  assert.equal(result.results[2].isError, false, 'Graph remains readable after a failed patch');
  assert.deepEqual(await graph(projectId), before, `${marker}: the entire graph, project revision and task ranks must roll back`);
  return result;
}

async function action(id, operation, extra = {}) {
  const task = await app.json(`task?id=${id}`);
  return app.json('task/action', { id, revision: task.revision, action: operation, ...extra });
}

/** Relax permissions only inside the owned fixture, including completed task directories. */
async function release(path) {
  await chmod(path, 0o700);
  for (const row of await readdir(path, { withFileTypes: true })) if (row.isDirectory() && !row.isSymbolicLink()) await release(join(path, row.name));
}

try {
  app = await startApp(home);
  const project = await app.json('projects', { title: '聊天规划齿轮与轴承（受控测试）', goal: '验证原生工具驱动的项目图谱批量规划' });
  const foreignProject = await app.json('projects', { title: '隔离项目（受控测试）' });
  const foreign = await app.json('task/quick', { projectId: foreignProject.id, title: '禁止从其他项目规划的任务' });
  const foreignBefore = await graph(foreignProject.id);
  const projectScope = { projectId: project.id };

  const initial = await plan(projectScope, 'create', { query: { offset: 0, limit: 2 }, patch: { creates: [
    { key: 'train', definition: definition('齿轮传动组件') },
    { key: 'gear', parentId: '$train', definition: { ...definition('驱动齿轮齿宽校核'), criteria: [{ id: 'width', label: '齿宽', kind: 'numeric', rule: 'eq', target: 40, tolerance: 0.1, unit: 'mm', method: '读取受控尺寸报告' }] } },
    { key: 'bearing', parentId: '$train', dependencies: ['$gear'], definition: definition('支承轴承接口校核') },
    { key: 'alternative', definition: definition('备用轴系分支') },
  ] } });
  assert.equal(initial.history.scope, 'project'); assert.equal(initial.history.projectId, project.id);
  assert.equal(Object.hasOwn(initial.history, 'taskId'), false, 'Project planning must not invent a hidden task');
  assert.equal(initial.context.scope.projectId, project.id); assert.equal(Object.hasOwn(initial.context.scope, 'taskId'), false);
  assert.equal(initial.context.project.revision, project.revision); assert.equal(initial.context.total, 0);
  assert.deepEqual(initial.context.tasks, []); assert.equal(initial.context.truncated, false);
  assert.equal(initial.results[1].isError, false); assert.equal(initial.patch.revision, project.revision + 1, 'One batch must advance the project revision exactly once');
  const train = created(initial, 'train'), gear = created(initial, 'gear'), bearing = created(initial, 'bearing'), alternative = created(initial, 'alternative');
  assert.equal(gear.parentId, train.id); assert.equal(bearing.parentId, train.id); assert.deepEqual(bearing.dependencies, [gear.id]);
  assert.deepEqual([train, gear, bearing, alternative].map(task => task.rank), [1, 2, 3, 4]);
  for (const task of [train, gear, bearing, alternative]) {
    assert.equal(task.state, 'unstarted'); assert.equal(task.projectId, project.id); assert.match(task.code, /^[0-9A-Za-z]{5}$/);
    await assert.rejects(lstat(join(home, 'studio', 'workspaces', task.id)), /ENOENT/, 'Graph planning cannot initialize an engineering workspace');
  }
  assert.equal((await graph(project.id)).tasks.find(task => task.id === train.id).isFolder, true);
  assert.equal(initial.afterContext.total, 4); assert.equal(initial.afterContext.offset, 0); assert.equal(initial.afterContext.limit, 2);
  assert.equal(initial.afterContext.tasks.length, 2); assert.equal(initial.afterContext.nextOffset, 2); assert.equal(initial.afterContext.truncated, true);
  for (const task of initial.afterContext.tasks) {
    assert.equal(typeof task.canUpdateDefinition, 'boolean'); assert.equal(typeof task.canMove, 'boolean');
    assert.equal(typeof task.canSetDependencies, 'boolean'); assert.equal(typeof task.canRemove, 'boolean'); assert.ok(Array.isArray(task.planningBlockers));
  }
  const page = await plan(projectScope, 'page', { query: { offset: 2, limit: 2 } }, initial.id);
  assert.equal(page.context.total, 4); assert.equal(page.context.offset, 2); assert.equal(page.context.truncated, false);
  assert.deepEqual([...initial.afterContext.tasks, ...page.context.tasks].map(task => task.id), [train, gear, bearing, alternative].map(task => task.id));

  const correctionBefore = await graph(project.id);
  const correction = await plan(projectScope, 'correct', { patch: {
    updates: [{ id: gear.id, changes: { title: '驱动齿轮模数校核', goal: '核对模数、齿宽与尺寸报告的一致性' } }, { id: bearing.id, changes: { goal: '先核对轴承接口，再作为齿轮校核输入' } }],
    moves: [{ id: gear.id, parentId: alternative.id }, { id: bearing.id, parentId: alternative.id }],
    dependencies: [{ id: bearing.id, dependencies: [] }, { id: gear.id, dependencies: [bearing.id] }],
  } }, initial.id);
  assert.equal(correction.results[1].isError, false); assert.equal(correction.patch.revision, correctionBefore.project.revision + 1);
  const correctedGraph = await graph(project.id), correctedGear = correctedGraph.tasks.find(task => task.id === gear.id), correctedBearing = correctedGraph.tasks.find(task => task.id === bearing.id);
  stableTaskIdentity(gear, correctedGear); stableTaskIdentity(bearing, correctedBearing);
  assert.equal(correctedGear.title, '驱动齿轮模数校核'); assert.equal(correctedGear.goal, '核对模数、齿宽与尺寸报告的一致性');
  assert.equal(correctedGear.parentId, alternative.id); assert.equal(correctedBearing.parentId, alternative.id);
  assert.deepEqual(correctedGear.dependencies, [bearing.id]); assert.deepEqual(correctedBearing.dependencies, []);
  assert.deepEqual(correctedGear.criteria, gear.criteria); assert.ok(correctedGear.revision > gear.revision);
  assert.equal(correction.patch.created.length, 0); assert.deepEqual(new Set(correction.patch.updated.map(task => task.id)), new Set([gear.id, bearing.id]));
  assert.deepEqual(new Set(correction.patch.moved.map(task => task.id)), new Set([gear.id, bearing.id]));
  assert.deepEqual(new Set(correction.patch.dependencies.map(task => task.id)), new Set([gear.id, bearing.id]));

  const legalCreate = label => ({ key: 'mustRollback', definition: definition(`不应留下的${label}节点`) });
  await rejected(projectScope, 'foreign-project', { creates: [legalCreate('跨项目')], updates: [{ id: foreign.id, changes: { title: '越权改名' } }] }, initial.id, project.id);
  assert.deepEqual(await graph(foreignProject.id), foreignBefore, 'Foreign project graph must remain untouched');
  await rejected(projectScope, 'cycle', { creates: [legalCreate('依赖循环')], dependencies: [{ id: gear.id, dependencies: [bearing.id] }, { id: bearing.id, dependencies: [gear.id] }] }, initial.id, project.id);
  await rejected(projectScope, 'stale', { revision: initial.context.project.revision, creates: [legalCreate('过期版本')] }, initial.id, project.id);
  await rejected(projectScope, 'lifecycle-field', { creates: [legalCreate('非法状态')], updates: [{ id: gear.id, changes: { state: 'completed' } }] }, initial.id, project.id);

  const localScope = { taskId: alternative.id };
  const localBefore = await graph(project.id);
  const nested = await plan(localScope, 'nested', { patch: { creates: [
    { key: 'nested', definition: definition('轴承定位详细子图') },
    { key: 'pin', parentId: '$nested', definition: definition('定位销直径校核') },
    { key: 'seat', parentId: '$nested', dependencies: ['$pin'], definition: definition('轴承座定位孔校核') },
  ] } });
  assert.equal(nested.results[1].isError, false); assert.equal(nested.patch.revision, localBefore.project.revision + 1);
  assert.equal(nested.history.scope, 'task'); assert.equal(nested.history.taskId, alternative.id);
  assert.equal(nested.context.scope.taskId, alternative.id); assert.equal(nested.context.currentTask.id, alternative.id);
  assert.ok(nested.context.breadcrumb.some(row => row.id === alternative.id));
  const folder = created(nested, 'nested'), pin = created(nested, 'pin'), seat = created(nested, 'seat');
  assert.equal(folder.parentId, alternative.id); assert.equal(pin.parentId, folder.id); assert.equal(seat.parentId, folder.id);
  assert.deepEqual(seat.dependencies, [pin.id]); assert.deepEqual([folder, pin, seat].map(task => task.rank), [5, 6, 7]);
  for (const task of [folder, pin, seat]) await assert.rejects(lstat(join(home, 'studio', 'workspaces', task.id)), /ENOENT/);
  const localGraphIds = new Set(nested.afterContext.tasks.map(task => task.id));
  assert.ok(!localGraphIds.has(foreign.id), 'Task graph context must still omit every other project');
  assert.ok([train.id, gear.id, bearing.id, alternative.id, folder.id, pin.id, seat.id].every(id => localGraphIds.has(id)), 'Task graph context must include the complete owned project, not only recursive descendants');

  const expanded = await plan(localScope, 'same-project-expansion', { patch: {
    creates: [
      { key: 'underTrain', parentId: train.id, definition: definition('任务对话在同项目兄弟目录下新建') },
      { key: 'atRoot', parentId: null, definition: definition('任务对话在项目根新建') },
    ],
    updates: [{ id: train.id, changes: { title: '任务对话已修正同项目目录' } }],
    moves: [{ id: alternative.id, parentId: train.id }],
  } }, nested.id);
  assert.equal(expanded.results[1].isError, false, 'A task conversation may revise and reorganize pure drafts anywhere in its project');
  const underTrain = created(expanded, 'underTrain'), atRoot = created(expanded, 'atRoot');
  assert.equal(underTrain.parentId, train.id); assert.equal(atRoot.parentId, undefined);
  assert.equal((await app.json(`task?id=${alternative.id}`)).parentId, train.id, 'The bound task itself may move while its stable chat ownership remains by task id');
  assert.equal((await app.json(`task?id=${train.id}`)).title, '任务对话已修正同项目目录');
  assert.deepEqual(expanded.afterContext.breadcrumb.map(row => row.id), [project.id, train.id, alternative.id]);
  const removal = await plan(localScope, 'remove-pure-draft', { patch: { removes: [{ id: atRoot.id }] } }, nested.id);
  assert.equal(removal.results[1].isError, false); assert.deepEqual(removal.patch.removed.map(task => task.id), [atRoot.id]);
  assert.equal((await app.json(`task?id=${atRoot.id}`)).archived, true, 'Model graph removal must be recoverable rather than hard deletion');
  assert.ok(!removal.afterContext.tasks.some(task => task.id === atRoot.id), 'Archived drafts leave the active planning context');

  await rejected(localScope, 'cross-level-dependency', { creates: [legalCreate('跨层依赖')], dependencies: [{ id: pin.id, dependencies: [train.id] }] }, nested.id, project.id);
  await rejected(localScope, 'hierarchy-cycle', { creates: [legalCreate('层级循环')], moves: [{ id: folder.id, parentId: pin.id }] }, nested.id, project.id);
  const queryFailure = await plan(localScope, 'invalid-query', { query: { offset: 0, limit: 101 } }, nested.id);
  assert.equal(queryFailure.results[0].isError, true, 'Graph context must reject a limit exceeding its documented maximum');
  const localCorrection = await plan(localScope, 'local-correct', { patch: {
    updates: [{ id: alternative.id, changes: { title: '精修备用轴系分支' } }, { id: pin.id, changes: { goal: '先核对定位销直径报告，再明确配合公差' } }],
    dependencies: [{ id: seat.id, dependencies: [] }],
  } }, nested.id);
  assert.equal(localCorrection.results[1].isError, false, 'A task conversation can refine its own root and descendants');
  const editedRoot = await app.json(`task?id=${alternative.id}`), editedPin = await app.json(`task?id=${pin.id}`), editedSeat = await app.json(`task?id=${seat.id}`);
  stableTaskIdentity(alternative, editedRoot); stableTaskIdentity(pin, editedPin); stableTaskIdentity(seat, editedSeat);
  assert.equal(editedRoot.title, '精修备用轴系分支'); assert.equal(editedPin.goal, '先核对定位销直径报告，再明确配合公差');
  assert.deepEqual(editedSeat.dependencies, []); assert.equal(localCorrection.patch.created.length, 0);

  await action(pin.id, 'start');
  await app.json('file', { taskId: pin.id, path: 'report.md', content: 'controlled graph planning completion proof' });
  await action(pin.id, 'complete', { measurements: [{ criterionId: 'proof', observed: true, evidence: 'report.md', note: '受控证据标记已读取' }] });
  const completed = await app.json(`task?id=${pin.id}`), immutable = await app.json(`snapshot?taskId=${pin.id}&id=${completed.completedId}`);
  assert.equal(completed.state, 'completed');
  const contextAfterComplete = await plan(projectScope, 'completed-context', {}, initial.id);
  const completedContext = contextAfterComplete.context.tasks.find(task => task.id === pin.id);
  assert.ok(completedContext); assert.equal(completedContext.canUpdateDefinition, false); assert.equal(completedContext.canMove, false); assert.equal(completedContext.canSetDependencies, false);
  await rejected(projectScope, 'completed-update', { creates: [legalCreate('修改已完成任务')], updates: [{ id: pin.id, changes: { title: '不能静默改已完成成果' } }] }, initial.id, project.id);
  await rejected(localScope, 'completed-child', { updates: [{ id: pin.id, changes: { goal: '不能从父任务修改已完成子任务' } }] }, nested.id, project.id);
  assert.equal((await app.call('chat', { taskId: pin.id, ...model, message: '[graph-plan-forbidden-completed] {}' })).status, 400, 'Completed tasks cannot open new writable planning conversations');
  assert.deepEqual((await app.json(`snapshot?taskId=${pin.id}&id=${completed.completedId}`)).snapshot, immutable.snapshot, 'Rejected graph patches must not alter formal result snapshots');

  const beforeRestart = await graph(project.id);
  const projectHistory = await app.json(`chat?id=${initial.id}`), localHistory = await app.json(`chat?id=${nested.id}`);
  const rowsBefore = conversationRows(foldChatPacket(emptyChatState(), { type: 'snapshot', chat: projectHistory, live: [] }));
  await stopApp(app.child); app = undefined; app = await startApp(home);
  assert.deepEqual(await graph(project.id), beforeRestart, 'Project hierarchy, dependencies, IDs, ranks and revisions must recover exactly');
  const restoredProject = await app.json(`chat?id=${initial.id}`), restoredLocal = await app.json(`chat?id=${nested.id}`);
  assert.equal(restoredProject.status, 'stored'); assert.equal(restoredLocal.status, 'stored');
  assert.deepEqual(restoredProject.events, projectHistory.events); assert.deepEqual(restoredLocal.events, localHistory.events);
  assert.deepEqual(conversationRows(foldChatPacket(emptyChatState(), { type: 'snapshot', chat: restoredProject, live: [] })), rowsBefore, 'Native planning tool calls and results must replay into the same conversation');
  assert.deepEqual((await app.json(`snapshot?taskId=${pin.id}&id=${completed.completedId}`)).snapshot, immutable.snapshot);
  const resumed = await plan(projectScope, 'resumed', { patch: { creates: [{ key: 'resumed', definition: definition('重启后继续规划齿轮倒角') }] } }, initial.id);
  assert.equal(resumed.results[1].isError, false); assert.equal(resumed.context.project.revision, beforeRestart.project.revision);
  const resumedTask = created(resumed, 'resumed'); assert.equal(resumedTask.rank, 10, 'Rejected batches must not consume project ranks');
  assert.equal(resumedTask.state, 'unstarted'); assert.equal(resumed.patch.revision, beforeRestart.project.revision + 1);
  assert.deepEqual(await graph(foreignProject.id), foreignBefore);
  const allCodes = (await app.json('directory')).map(task => task.code); assert.equal(new Set(allCodes).size, allCodes.length);
  console.log('Graph planning verification passed: native graph context/patch schemas, project batch creation with temporary keys and concrete measurable tasks, graph pagination, same-chat correction/update/move/dependency rewiring, task-chat full-project planning with explicit root creation, movable anchors and recoverable pure-draft removal, same-layer DAG enforcement, atomic rollback for foreign projects/cycles/stale revisions/lifecycle fields, completed-result guards, immutable evidence, stable IDs/ranks and restart/replay/resume. No external model, network search or engineering software called.');
} catch (error) { console.error(error); process.exitCode = 1; }
finally { if (app) await stopApp(app.child); await release(home); await rm(home, { recursive: true, force: true }); }
