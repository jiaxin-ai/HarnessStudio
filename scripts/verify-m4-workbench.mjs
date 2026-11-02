import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { root } from './prepare.mjs';
import { startApp, stopApp } from './verify-app.mjs';
import { emptyChatState, foldChatPacket, conversationRows } from '../plugins/ui/lib/chat-state.js';

// Current single-user workflow, through anonymous same-origin HTTP and real DSH tools.
// The deterministic Provider and ANSYS result are fixtures, not engineering evidence.
await mkdir(join(root, '.studio'), { recursive: true });
const home = await realpath(await mkdtemp(join(root, '.studio/m4-workbench-test-')));
const model = { provider: 'studio-smoke', model: 'm1-smoke' }, imageId = 'mock-ansys';
let app;
const query = (route, fields) => `${route}?${new URLSearchParams(fields)}`;
const graph = id => app.json(query('graph', { projectId: id }));
const task = id => app.json(query('task', { id }));
const completion = taskId => app.json(query('task/completion', { taskId }));
const text = content => content.filter(block => block.type === 'text').map(block => block.text).join('');
const turns = chat => chat.events.filter(event => event.type === 'turn/end').length;

async function until(read, ready, failure) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { const value = await read(); if (ready(value)) return value; await delay(50); }
  throw new Error(failure);
}
async function finished(id, afterTurns = 0) {
  const chat = await until(() => app.json(query('chat', { id })), value => value.status === 'idle' && turns(value) > afterTurns,
    'The native M4 fixture turn did not finish');
  assert.notEqual(chat.events.filter(event => event.type === 'turn/end').at(-1).data.reason?.kind, 'error', 'A failed native model/tool turn cannot count as acceptance');
  return chat;
}
async function send(scope, message, id) {
  const previous = id ? await app.json(query('chat', { id })) : undefined;
  const chat = await app.json('chat', { ...scope, ...model, message, ...(id ? { id } : {}) });
  const history = await finished(chat.id, previous ? turns(previous) : 0);
  return { id: chat.id, history, events: history.events.filter(event => event.seq > (previous?.events.at(-1)?.seq ?? -1)) };
}
function toolResult(events, call) {
  const result = events.find(event => event.type === 'tool/result' && event.data.message.source.callId === call.data.callId);
  assert.ok(result, `Missing durable native result for ${call.data.name}`);
  assert.equal(result.data.message.isError, false, `Native ${call.data.name} failed`);
  return JSON.parse(text(result.data.message.content));
}
async function plan(projectId, patch, chatId) {
  const turn = await send({ projectId }, `[graph-plan-m-four] ${JSON.stringify({ scope: 'project', patch })}`, chatId);
  const calls = turn.events.filter(event => event.type === 'tool/call');
  assert.deepEqual(calls.map(call => call.data.name), ['studio_graph_context', 'studio_apply_graph_patch', 'studio_graph_context']);
  const [before, result, after] = calls.map(call => toolResult(turn.events, call));
  assert.equal(result.revision, before.project.revision + 1);
  assert.equal(after.project.revision, result.revision);
  return { ...turn, result };
}
function created(result, key) {
  const row = result.created.find(row => row.key === key); assert.ok(row, `Missing planned ${key}`); return row;
}
const definition = (title, goal, checklist) => ({ title, goal: `${goal}。仅验证受控工作台流程，不代表真实工程分析。`, checklist: checklist.map(text => ({ text })) });
const args = value => ({ taskId: value.taskId, revision: value.taskRevision, workspaceVersion: value.workspaceVersion,
  ...(value.isFolder ? { childrenVersion: value.childrenVersion } : {}), checkedGoalIds: value.goals.filter(goal => !goal.system).map(goal => goal.id) });
async function deny(path, body, message) {
  const response = await app.call(path, body); assert.equal(response.status, 400, message);
  assert.equal(typeof (await response.json()).error, 'string');
}
async function complete(id, submissionId) {
  const preview = await completion(id); assert.deepEqual(preview.blockers, [], 'Completion requires current predecessor and immediate-child results');
  const currentSubmission = submissionId ?? preview.submittedFiles?.id;
  const result = await app.json('task/completion', { ...args(preview), ...(currentSubmission ? { submissionId: currentSubmission } : { confirmWithoutFiles: true }) });
  assert.equal(result.task.state, 'completed');
  const snapshot = (await app.json(query('snapshot', { taskId: id }))).snapshot;
  assert.equal(snapshot.id, result.task.completedId);
  assert.deepEqual(snapshot.humanConfirmation.goals.filter(goal => !goal.system).map(goal => goal.id), args(preview).checkedGoalIds);
  if (!currentSubmission) { assert.deepEqual(snapshot.files, []); assert.equal(snapshot.humanConfirmation.withoutSubmittedFiles, true); }
  return { task: result.task, snapshot };
}
async function pending(id, excludeCallId) {
  const view = await until(() => app.json(query('chat/questions', { id })), value => value.pending.some(row => row.canAnswer && row.callId !== excludeCallId),
    'The native guided planning question did not become answerable');
  return view.pending.find(row => row.canAnswer && row.callId !== excludeCallId);
}
async function answer(id, question, answers) {
  assert.deepEqual(await app.json('chat/questions/answer', { id, callId: question.callId, answers }), { accepted: true });
}
async function sseSnapshot(id) {
  const response = await app.call(query('chat/stream', { id }));
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('No M4 conversation snapshot arrived')), 12000); });
  try {
    while (true) {
      const row = await Promise.race([reader.read(), timeout]); assert.equal(row.done, false);
      buffer += decoder.decode(row.value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const record = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        if (!record.startsWith('data: ')) continue;
        const packet = JSON.parse(record.slice(6));
        assert.notEqual(packet.type, 'error'); if (packet.type === 'snapshot') return packet;
      }
    }
  } finally { clearTimeout(timer); await reader.cancel(); reader.releaseLock(); }
}
async function historyUnchanged(original) {
  const value = (await app.json(query('snapshot/manifest', { taskId: original.task.id, snapshotId: original.snapshot.id }))).snapshot;
  assert.deepEqual(value, original.snapshot, 'Rechecking cannot rewrite the old definition, human confirmation or actual input/child references');
}
async function release(path) {
  const info = await lstat(path); if (info.isSymbolicLink()) return;
  if (!info.isDirectory()) { await chmod(path, 0o600); return; }
  await chmod(path, 0o700); for (const name of await readdir(path)) await release(join(path, name));
}

try {
  app = await startApp(home);
  await until(() => app.call('software/catalog'), response => response.status === 200, 'Mock software routes were not ready');
  const project = await app.json('projects', { title: 'M4 当前工作台完整链路（隔离测试）' });
  assert.equal(project.goal, ''); assert.equal(project.constraints, '');
  assert.deepEqual((await graph(project.id)).tasks, [], 'A name-only project must start with an empty graph');
  const guided = await app.json('chat', { projectId: project.id, ...model, message: '我想核查一份支架分析方案，先对齐工况和交付形式。[guided-planning-demo]' });
  const firstQuestion = await pending(guided.id);
  assert.deepEqual(firstQuestion.questions.map(row => row.id), ['demo_domain', 'demo_constraints']);
  assert.deepEqual((await graph(project.id)).tasks, [], 'Unanswered design questions cannot create tasks');
  const independentProject = await send({ projectId: project.id }, '[project-chat-only] 独立项目需求讨论，不改变图谱');
  assert.equal((await pending(guided.id)).callId, firstQuestion.callId, 'A second project conversation must not answer or stop the first');
  await answer(guided.id, firstQuestion, [{ id: 'demo_domain', selected: ['CAE'] }, { id: 'demo_constraints', selected: ['应用场景', '工况'], custom: '载荷尚待确认，不虚构设计值' }]);
  const secondQuestion = await pending(guided.id, firstQuestion.callId);
  await answer(guided.id, secondQuestion, [{ id: 'demo_deliverable', selected: ['分析报告'] }]);
  const approval = await pending(guided.id, secondQuestion.callId);
  assert.deepEqual(approval.questions.map(row => row.id), ['demo_plan_approval']);
  const beforeApproval = await app.json(query('chat', { id: guided.id }));
  assert.match(beforeApproval.events.filter(event => event.type === 'assistant/message').map(event => text(event.data.message.content)).join('\n'), /规划方向：CAE/u);
  assert.deepEqual((await graph(project.id)).tasks, [], 'Engineering answers do not replace explicit graph-planning approval');
  await answer(guided.id, approval, [{ id: 'demo_plan_approval', selected: ['生成任务图谱'] }]);
  const guidedDone = await finished(guided.id);
  assert.deepEqual(guidedDone.events.filter(event => event.type === 'tool/call').map(event => event.data.name), ['ask_user_question', 'ask_user_question', 'ask_user_question', 'studio_create_task']);
  const seed = (await graph(project.id)).tasks[0]; assert.ok(seed); assert.equal(seed.checklist.length, 3);
  assert.match(seed.goal, /载荷尚待确认/u); assert.equal(seed.state, 'unstarted');

  const planned = await plan(project.id, { updates: [{ id: seed.id, changes: { title: '支架静力分析与交付核对', goal: seed.goal } }], creates: [
    { key: 'analysisGroup', parentId: seed.id, definition: definition('支架模拟分析方案', '分别确认模拟分析报告与报告核对结果', ['直属结果都已人工确认', '报告及说明明确标注 Mock']) },
    { key: 'analysis', parentId: '$analysisGroup', definition: definition('配置支架载荷并保存模拟分析报告', '显式选择 ANSYS Mock 并保存测试分析报告', ['所用镜像是 ANSYS Mock', '报告包含 Mock 标记', '载荷和材料参数带单位']) },
    { key: 'verification', parentId: '$analysisGroup', dependencies: ['$analysis'], definition: definition('核对分析报告的 Mock 标记与单位', '依据已提交报告核对测试标记和单位', ['读取前序已完成版本', '区分 Mock 结果与工程质量']) },
    { key: 'bounds', parentId: seed.id, definition: definition('整理支架分析输入边界', '保留真实用户条件及尚未确认的载荷', ['载荷未知保持未知', '记录本轮测试边界']) },
    { key: 'consumer', dependencies: [seed.id], definition: definition('记录支架分析结论与版本引用', '引用人工确认的分析组结果', ['结果引用指向当前已完成版本']) },
  ] }, guided.id);
  const middle = created(planned.result, 'analysisGroup'), analysis = created(planned.result, 'analysis'), verification = created(planned.result, 'verification'), bounds = created(planned.result, 'bounds'), consumer = created(planned.result, 'consumer');
  const tree = await graph(project.id), rootGroup = tree.tasks.find(row => row.id === seed.id);
  assert.equal(rootGroup.isFolder, true); assert.equal(rootGroup.leafStats.total, 3);
  assert.equal(tree.tasks.find(row => row.id === middle.id).leafStats.total, 2);
  assert.deepEqual(tree.tasks.map(row => row.rank), [1, 2, 3, 4, 5, 6]);
  assert.equal(new Set(tree.tasks.map(row => row.code)).size, tree.tasks.length);
  assert.ok(tree.tasks.every(row => /^[0-9A-Za-z]{5}$/.test(row.code) && row.state === 'unstarted' && row.checklist.length > 0));
  assert.equal(rootGroup.code, seed.code); assert.equal(rootGroup.rank, seed.rank);

  const secondaryTask = await send({ taskId: analysis.id }, `[checklist-workbench-read] ${JSON.stringify({ scope: 'task', taskId: analysis.id })}`);
  const softwareTurn = await send({ taskId: analysis.id }, `[software-ui] ${JSON.stringify({ imageId })}`);
  const calls = softwareTurn.events.filter(event => event.type === 'tool/call');
  const business = calls.filter((call, index) => index < 2 || call.data.name !== 'studio_software_status');
  assert.deepEqual(business.map(call => call.data.name), ['studio_software_catalog', 'studio_software_status', 'studio_software_launch', 'studio_software_control', 'studio_software_invoke', 'studio_software_operation', 'studio_software_invoke', 'studio_software_operation', 'studio_software_invoke', 'studio_software_operation', 'studio_software_save_artifact', 'studio_software_control']);
  calls.forEach(call => toolResult(softwareTurn.events, call));
  calls.slice(2).forEach(call => assert.equal(JSON.parse(call.data.arguments).imageId, imageId, 'Every software call must retain the explicitly chosen image'));
  const saved = toolResult(softwareTurn.events, business.find(call => call.data.name === 'studio_software_save_artifact'));
  const seat = (await app.json(query('software/seat', { taskId: analysis.id, imageId }))).seat;
  assert.equal(seat.softwareId, imageId); assert.equal(seat.control, null); assert.equal(seat.document.analysis.result.mock, true);
  const artifactFile = await app.json(query('project/file', { projectId: project.id, taskId: analysis.id, path: saved.path }));
  assert.equal(artifactFile.version, saved.version); assert.equal(JSON.parse(artifactFile.content).mock, true);
  const status = await app.json('status');
  assert.deepEqual(new Set(status.chats.filter(row => row.scope === 'project' && row.projectId === project.id).map(row => row.id)), new Set([guided.id, independentProject.id]));
  assert.deepEqual(new Set(status.chats.filter(row => row.scope !== 'project' && row.taskId === analysis.id).map(row => row.id)), new Set([secondaryTask.id, softwareTurn.id]));
  await deny('chat', { projectId: project.id, ...model, id: softwareTurn.id, message: '不能把任务会话借给项目页' }, 'Project and task conversations must remain independently bound');
  for (const [id, scope] of [[guided.id, 'project'], [independentProject.id, 'project'], [secondaryTask.id, 'task'], [softwareTurn.id, 'task']]) {
    const packet = await sseSnapshot(id); assert.equal(packet.chat.id, id); assert.equal(packet.chat.scope, scope);
    if (scope === 'project') assert.equal(Object.hasOwn(packet.chat, 'taskId'), false); else assert.equal(packet.chat.taskId, analysis.id);
    const projected = conversationRows(foldChatPacket(emptyChatState(), packet));
    const projectedCalls = projected.flatMap(row => row.role === 'assistant' ? row.steps.flatMap(step => step.tools.map(tool => tool.name)) : []);
    assert.deepEqual(projectedCalls, packet.chat.events.filter(event => event.type === 'tool/call').map(event => event.data.name), 'Each conversation replays its native calls in independent step order');
  }

  await app.json('file', { taskId: analysis.id, path: 'notes/unsubmitted.md', content: '工作草稿，未选择提交；真实载荷仍未确定。' });
  const listing = await app.json(query('project/files', { projectId: project.id, taskId: analysis.id }));
  assert.ok(listing.entries.some(row => row.path === 'notes' && row.kind === 'directory'));
  const initialPreview = await completion(analysis.id);
  assert.deepEqual(initialPreview.blockers, []); assert.equal(initialPreview.goals.filter(goal => !goal.system).length, 4);
  await deny('task/completion', { ...args(initialPreview), checkedGoalIds: [], confirmWithoutFiles: true }, 'Checklist and overall goal require separate explicit human confirmations');
  const submitted = await app.json('task/completion/files', { taskId: analysis.id, revision: initialPreview.taskRevision, workspaceVersion: initialPreview.workspaceVersion,
    files: [{ path: saved.path, description: '显式选择 ANSYS Mock 的受控报告；模拟结果不是工程质量证据。' }] });
  assert.equal(submitted.goals.find(goal => goal.system).checked, true);
  assert.deepEqual(submitted.submittedFiles.files.map(row => row.path), [saved.path]);
  const firstAnalysis = await complete(analysis.id, submitted.submittedFiles.id);
  assert.deepEqual(firstAnalysis.snapshot.files.map(row => row.path), [saved.path]);
  assert.equal((await app.json(query('project/file', { projectId: project.id, taskId: analysis.id, path: 'notes/unsubmitted.md' }))).content.includes('工作草稿'), true);
  await app.json('file', { taskId: verification.id, path: 'notes/unsubmitted.md', content: '另一任务的同名草稿，不能混入分析任务。' });
  const noFiles = await completion(verification.id);
  await deny('task/completion', args(noFiles), 'No-submission completion needs an explicit second confirmation, including when workspace files exist');
  const firstVerification = await complete(verification.id), firstBounds = await complete(bounds.id);
  assert.notEqual((await task(middle.id)).state, 'completed', 'Completing every leaf does not confirm the intermediate group');
  const blockedRoot = await completion(seed.id);
  assert.equal((await task(seed.id)).leafStats.states.completed, 3); assert.ok(blockedRoot.blockers.length);
  await deny('task/completion', { ...args(blockedRoot), confirmWithoutFiles: true }, 'Terminal leaf statistics cannot bypass an unconfirmed immediate child group');
  const readyMiddle = await completion(middle.id);
  await deny('task/completion', { ...args(readyMiddle), checkedGoalIds: [], confirmWithoutFiles: true }, 'A ready group still needs its own Checklist and overall goal confirmation');
  const firstMiddle = await complete(middle.id);
  assert.notEqual((await task(seed.id)).state, 'completed', 'Confirming a subgroup cannot silently confirm its parent');
  const firstRoot = await complete(seed.id), firstConsumer = await complete(consumer.id);
  assert.deepEqual(firstMiddle.snapshot.childrenRefs, [{ taskId: analysis.id, snapshotId: firstAnalysis.snapshot.id }, { taskId: verification.id, snapshotId: firstVerification.snapshot.id }]);
  assert.deepEqual(firstRoot.snapshot.childrenRefs, [{ taskId: middle.id, snapshotId: firstMiddle.snapshot.id }, { taskId: bounds.id, snapshotId: firstBounds.snapshot.id }]);
  assert.deepEqual(firstConsumer.snapshot.inputs, [{ taskId: seed.id, snapshotId: firstRoot.snapshot.id }]);
  const originals = [firstAnalysis, firstVerification, firstBounds, firstMiddle, firstRoot, firstConsumer];

  const newPlan = await plan(project.id, { creates: [{ key: 'predecessor', definition: definition('补充支架安装工况依据', '用户要求为既有完成链条增加新的工况输入', ['新增条件已明确记录']) }] }, guided.id);
  const predecessor = created(newPlan.result, 'predecessor'), currentRoot = await task(seed.id);
  const request = { id: seed.id, revision: currentRoot.revision, dependencies: [predecessor.id] }, beforePreview = await graph(project.id);
  const preview = await app.json('dependencies/preview', request);
  assert.equal(preview.requiresConfirmation, true);
  for (const original of originals) assert.ok(preview.affected.some(row => row.id === original.task.id && row.willRecheck), 'The impact preview must include completed descendants, containing groups and downstream results');
  assert.deepEqual(await graph(project.id), beforePreview, 'Canceling by dismissing a read-only preview must leave the entire graph unchanged');
  await deny('dependencies', request, 'A relation that invalidates completed results requires explicit impact acknowledgement');
  assert.deepEqual(await graph(project.id), beforePreview);
  const { kind, ...confirmedRequest } = preview.request; assert.equal(kind, 'set');
  await app.json('dependencies', { ...confirmedRequest, projectRevision: preview.projectRevision, confirmImpact: true, impactVersion: preview.impactVersion });
  for (const original of originals) {
    const current = await task(original.task.id); assert.equal(current.state, 'recheck'); assert.equal(current.completedId, original.snapshot.id); assert.ok(current.recheckReason);
    await historyUnchanged(original);
  }
  const blockedAnalysis = await completion(analysis.id); assert.ok(blockedAnalysis.blockers.length);
  await deny('task/completion', { ...args(blockedAnalysis), submissionId: blockedAnalysis.submittedFiles?.id }, 'Recheck cannot bypass an unfinished inherited predecessor');
  await complete(predecessor.id);
  await deny('task/completion', { ...args(await completion(analysis.id)), checkedGoalIds: [], submissionId: submitted.submittedFiles.id }, 'Recheck must reconfirm every goal instead of inheriting old checkboxes');
  const revisedAnalysis = await complete(analysis.id), revisedVerification = await complete(verification.id), revisedBounds = await complete(bounds.id);
  assert.equal((await task(middle.id)).state, 'recheck'); assert.equal((await task(seed.id)).state, 'recheck');
  assert.ok((await completion(seed.id)).blockers.length, 'A rechecked leaf chain still cannot substitute for manual intermediate-group confirmation');
  const revisedMiddle = await complete(middle.id); assert.equal((await task(seed.id)).state, 'recheck');
  const revisedRoot = await complete(seed.id); assert.equal((await task(consumer.id)).state, 'recheck');
  const revisedConsumer = await complete(consumer.id);
  assert.deepEqual(revisedMiddle.snapshot.childrenRefs, [{ taskId: analysis.id, snapshotId: revisedAnalysis.snapshot.id }, { taskId: verification.id, snapshotId: revisedVerification.snapshot.id }]);
  assert.deepEqual(revisedRoot.snapshot.childrenRefs, [{ taskId: middle.id, snapshotId: revisedMiddle.snapshot.id }, { taskId: bounds.id, snapshotId: revisedBounds.snapshot.id }]);
  assert.deepEqual(revisedConsumer.snapshot.inputs, [{ taskId: seed.id, snapshotId: revisedRoot.snapshot.id }]);
  for (const original of originals) { assert.notEqual((await task(original.task.id)).completedId, original.snapshot.id); await historyUnchanged(original); }
  const originalBytes = await app.json(query('snapshot/preview', { taskId: analysis.id, snapshotId: firstAnalysis.snapshot.id, path: saved.path }));
  assert.equal(originalBytes.content, artifactFile.content, 'The old submitted artifact bytes must remain intact after the full recheck chain');
  assert.ok((await graph(project.id)).tasks.every(row => row.state === 'completed'));
  console.log('M4 current-workbench integration passed: empty project; three native question batches and explicit planning approval; native nested graph/Checklist creation; independently bound project/task conversations and SSE step replay; explicitly selected ANSYS Mock native Bridge export/save; optional-file human completion; direct-child and per-level group confirmation; read-only/canceled dependency preview, confirmed unfinished predecessor, recursive recheck and unchanged historical snapshot references/bytes. Disposable local smoke Provider and synthetic Mock results only; no external model, engineering-quality claim or user-preview data.');
} finally {
  try { if (app) await stopApp(app.child); }
  finally { await release(home); await rm(home, { recursive: true, force: true }); }
}
