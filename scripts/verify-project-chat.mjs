import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, chmod, readdir, lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { root } from './prepare.mjs';
import { startApp, stopApp } from './verify-app.mjs';
import { emptyChatState, foldChatPacket, conversationRows } from '../plugins/ui/lib/chat-state.js';

await mkdir(join(root, '.studio'), { recursive: true });
const home = await mkdtemp(join(root, '.studio/project-chat-test-'));
let app;
const model = { provider: 'studio-smoke', model: 'm1-smoke' };
const text = content => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(block => block.type === 'text').map(block => block.text).join('') : '';
const tempQuery = (id, path) => `chat/temp/file?${new URLSearchParams({ id, path })}`;

async function finished(id, afterTurns = 0) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const chat = await app.json(`chat?id=${id}`);
    if (chat.status === 'idle' && chat.events.filter(event => event.type === 'turn/end').length > afterTurns) return chat;
    await delay(70);
  }
  throw new Error('Project conversation did not finish the controlled test');
}

/** The initial SSE snapshot must carry project identity and replayable history. */
async function snapshot(id) {
  const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 12000);
  const response = await app.call(`chat/stream?id=${id}`);
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  const aborted = new Promise((_, reject) => abort.signal.addEventListener('abort', () => reject(new Error('No project SSE snapshot received')), { once: true }));
  let buffer = '';
  try {
    while (true) {
      const row = await Promise.race([reader.read(), aborted]);
      if (row.done) throw new Error('Project SSE stream ended before snapshot');
      buffer += decoder.decode(row.value, { stream: true });
      let split;
      while ((split = buffer.indexOf('\n\n')) >= 0) {
        const record = buffer.slice(0, split); buffer = buffer.slice(split + 2);
        if (!record.startsWith('data: ')) continue;
        const packet = JSON.parse(record.slice(6));
        if (packet.type === 'error') throw new Error(packet.error);
        if (packet.type === 'snapshot') return packet;
      }
    }
  } finally { clearTimeout(timeout); await reader.cancel(); reader.releaseLock(); }
}

function projectScope(chat, projectId) {
  assert.equal(chat.scope, 'project'); assert.equal(chat.projectId, projectId);
  assert.equal(Object.hasOwn(chat, 'taskId'), false, 'A project chat must not expose a synthetic task identity');
}

function resultFor(chat, name) {
  const call = chat.events.find(event => event.type === 'tool/call' && event.data.name === name);
  assert.ok(call, `Missing native project tool call: ${name}`);
  const result = chat.events.find(event => event.type === 'tool/result' && event.data.message.source.callId === call.data.callId);
  assert.ok(result, `Missing persisted project tool result: ${name}`); return result;
}

async function action(id, operation, extra = {}) {
  const task = await app.json(`task?id=${id}`);
  return app.json('task/action', { id, revision: task.revision, action: operation, ...extra });
}

/** Folders need the same explicit human target confirmation as leaf tasks. */
async function confirmFolder(id) {
  const preview = await app.json(`task/completion?taskId=${id}`);
  assert.deepEqual(preview.blockers, [], 'All immediate children must have valid completed results before their group is confirmed');
  const result = await app.json('task/completion', { taskId: id, revision: preview.taskRevision, workspaceVersion: preview.workspaceVersion,
    childrenVersion: preview.childrenVersion, checkedGoalIds: preview.goals.filter(goal => !goal.system).map(goal => goal.id), confirmWithoutFiles: true });
  assert.equal(result.task.state, 'completed'); return result.task;
}

/** Relax permissions only inside this new fixture, including frozen task directories. */
async function release(path) {
  await chmod(path, 0o700);
  for (const row of await readdir(path, { withFileTypes: true })) if (row.isDirectory() && !row.isSymbolicLink()) await release(join(path, row.name));
}

try {
  app = await startApp(home);
  assert.equal((await fetch(`${app.base}/api/studio/chat/stream?id=unknown`)).status, 400);
  const project = await app.json('projects', { title: '无任务的项目规划（测试）' });
  const otherProject = await app.json('projects', { title: '独立项目（测试）' });
  assert.equal(project.goal, ''); assert.equal(project.constraints, ''); assert.equal(project.revision, 0);
  assert.deepEqual((await app.json(`graph?projectId=${project.id}`)).tasks, []);
  const first = await app.json('chat', { projectId: project.id, ...model, message: '[project-chat-only] 项目目标还在讨论' });
  projectScope(first, project.id);
  const planning = await finished(first.id); projectScope(planning, project.id);
  assert.ok(planning.events.some(event => event.type === 'assistant/message' && text(event.data.message.content).includes('without a hidden task')));
  assert.deepEqual((await app.json(`graph?projectId=${project.id}`)).tasks, [], 'Creating and using a project chat must leave the task graph empty');
  assert.ok(!(await app.json('directory')).some(row => row.projectId === project.id));
  const firstPacket = await snapshot(first.id); projectScope(firstPacket.chat, project.id);
  assert.deepEqual(conversationRows(foldChatPacket(emptyChatState(), firstPacket)).map(row => row.role), ['user', 'assistant']);

  for (const scope of [{}, { projectId: project.id, taskId: 'm1-gear' }, { projectId: 'p-missing' }]) {
    assert.equal((await app.call('chat', { ...scope, ...model, message: '[project-chat-only] invalid scope' })).status, 400);
  }
  for (const scope of [{ projectId: otherProject.id }, { taskId: 'm1-gear' }]) {
    assert.equal((await app.call('chat', { ...scope, id: first.id, ...model, message: '[project-chat-only] wrong owner' })).status, 400, 'An existing chat cannot change project or scope');
  }
  const legacyTask = await app.json('task?id=m1-gear'), legacyGraph = await app.json(`graph?projectId=${legacyTask.projectId}`);
  const taskChat = await app.json('chat', { taskId: legacyTask.id, ...model, message: '[task-project-tools] 不得从任务对话修改项目图' });
  assert.equal(taskChat.scope, 'task'); assert.equal(taskChat.projectId, legacyTask.projectId); assert.equal(taskChat.taskId, legacyTask.id);
  const taskHistory = await finished(taskChat.id);
  assert.equal(resultFor(taskHistory, 'studio_project_context').data.message.isError, true, 'Project context must remain unavailable to a task chat');
  const workingChildAttempt = resultFor(taskHistory, 'studio_create_task');
  assert.equal(workingChildAttempt.data.message.isError, true, 'A working parent must reject child creation even though the tool is advertised');
  assert.match(text(workingChildAttempt.data.message.content), /父任务.*工作|父任务.*冻结/, 'Child creation must be denied by parent phase, not by missing tool scope');
  assert.deepEqual((await app.json(`graph?projectId=${legacyTask.projectId}`)).tasks.map(row => row.id), legacyGraph.tasks.map(row => row.id));
  assert.equal((await app.call('chat', { projectId: project.id, id: taskChat.id, ...model, message: '[project-chat-only] wrong scope' })).status, 400);

  await app.json('chat', { projectId: project.id, id: first.id, ...model, message: '[project-ui] 创建具体任务并校验操作边界' });
  const tools = await finished(first.id, 1);
  const projectContext = resultFor(tools, 'studio_project_context');
  assert.equal(projectContext.data.message.isError, false);
  const context = JSON.parse(text(projectContext.data.message.content));
  assert.equal(context.project.id, project.id); assert.deepEqual(context.tasks, []);
  const createdResult = resultFor(tools, 'studio_create_task'); assert.equal(createdResult.data.message.isError, false);
  const task = JSON.parse(text(createdResult.data.message.content));
  assert.equal(task.projectId, project.id); assert.equal(task.state, 'unstarted'); assert.equal(task.rank, 1); assert.match(task.code, /^[0-9A-Za-z]{5}$/);
  assert.equal(task.kind, 'task'); assert.equal(task.criteria[0].unit, 'mm'); assert.equal(task.criteria[0].target, 40);
  assert.equal(JSON.parse(text(resultFor(tools, 'studio_read_temp_file').data.message.content)).content, 'project-chat-only');
  for (const name of ['studio_task_context', 'studio_read_file', 'studio_read_project_file', 'studio_write_file', 'studio_delete_file']) {
    assert.equal(resultFor(tools, name).data.message.isError, true, `${name} must reject a project chat at execution`);
  }
  await assert.rejects(lstat(join(home, 'studio', 'workspaces', task.id)), /ENOENT/, 'Draft task creation must not start its workspace');
  assert.deepEqual((await app.json(`graph?projectId=${otherProject.id}`)).tasks, [], 'Project tool execution must not add another project’s task');

  const second = await app.json('chat', { projectId: project.id, ...model, message: '[project-ui] 第二次独立任务创建' });
  projectScope(second, project.id);
  const secondHistory = await finished(second.id), secondTask = JSON.parse(text(resultFor(secondHistory, 'studio_create_task').data.message.content));
  assert.notEqual(task.id, secondTask.id); assert.notEqual(task.code, secondTask.code); assert.equal(secondTask.rank, 2);
  assert.deepEqual((await app.json(`graph?projectId=${project.id}`)).tasks.map(row => row.id), [task.id, secondTask.id]);
  const third = await app.json('chat', { projectId: otherProject.id, ...model, message: '[project-chat-only] 另一个项目的独立规划' });
  await finished(third.id);
  for (const [chat, content] of [[first, 'first-project-chat'], [second, 'second-project-chat'], [third, 'other-project-chat']]) {
    await app.json('chat/temp/file', { id: chat.id, path: 'scratch.txt', content });
    assert.equal((await app.json(tempQuery(chat.id, 'scratch.txt'))).content, content);
    const projectId = chat.id === third.id ? otherProject.id : project.id;
    assert.equal(await readFile(join(home, 'studio', 'project-workspaces', projectId, '.chat-tmp', chat.id, 'scratch.txt'), 'utf8'), content);
  }
  for (const path of [`../${first.id}/scratch.txt`, `/private/scratch.txt`, `.chat-tmp/${first.id}/scratch.txt`, '..\\scratch.txt']) {
    assert.equal((await app.call(tempQuery(second.id, path))).status, 400);
    assert.equal((await app.call('chat/temp/file', { id: second.id, path, content: 'bad' })).status, 400);
  }
  const summaries = (await app.json('status')).chats;
  for (const chat of [first, second]) projectScope(summaries.find(row => row.id === chat.id), project.id);
  projectScope(summaries.find(row => row.id === third.id), otherProject.id);
  const replay = await snapshot(first.id), rowsBefore = conversationRows(foldChatPacket(emptyChatState(), replay));
  assert.ok(replay.chat.events.some(event => event.type === 'tool/result' && event.data.message.isError));

  const draftProject = await app.json('projects', { title: '任务草稿对话与层级（运行时测试）' });
  const draft = await app.json('task/quick', { projectId: draftProject.id });
  assert.equal(draft.state, 'unstarted'); assert.equal(draft.assignee, undefined);
  assert.equal(draft.title, `任务${draft.code}`); assert.equal(draft.goal, ''); assert.deepEqual(draft.criteria, []);
  assert.ok((await lstat(join(home, 'studio', 'workspaces', draft.id))).isDirectory());
  const draftChat = await app.json('chat', { taskId: draft.id, ...model, message: '[task-draft-chat] 草稿目标和指标尚未补全' });
  assert.equal(draftChat.scope, 'task'); assert.equal(draftChat.taskId, draft.id); assert.equal(draftChat.projectId, draftProject.id);
  const draftHistory = await finished(draftChat.id);
  const draftContext = JSON.parse(text(resultFor(draftHistory, 'studio_task_context').data.message.content));
  assert.equal(draftContext.state, 'unstarted'); assert.deepEqual(draftContext.definitionIssues, [], 'The current name/optional-description/text-checklist metadata needs no numeric indicator form');
  assert.deepEqual(draftContext.children, []); assert.equal(draftContext.childrenTotal, 0); assert.equal(draftContext.childrenTruncated, false);
  assert.deepEqual(draftContext.inputSnapshots, []); assert.equal(draftContext.inputSnapshotsTruncated, false);
  assert.equal(resultFor(draftHistory, 'studio_write_temp_file').data.message.isError, false);
  assert.equal(JSON.parse(text(resultFor(draftHistory, 'studio_read_temp_file').data.message.content)).content, 'allocated-task-private-draft');
  assert.equal(resultFor(draftHistory, 'studio_write_file').data.message.isError, false, 'An editable pending leaf can write ordinary files without Start Work');
  assert.equal(text(resultFor(draftHistory, 'studio_read_file').data.message.content), 'active task owns this file');
  assert.equal(resultFor(draftHistory, 'studio_delete_file').data.message.isError, false, 'An active task can delete its own ordinary workspace file');
  assert.equal((await app.json(`task?id=${draft.id}`)).state, 'unstarted');
  assert.equal((await app.call(`file?taskId=${draft.id}&path=ordinary-draft.md`)).status, 400);
  await app.json('file', { taskId: draft.id, path: 'ordinary-manual.md', content: 'explicit saved work does not change pending state' });
  assert.equal((await app.json(`task?id=${draft.id}`)).state, 'unstarted', 'Artifact writes must leave the editable task pending until human completion');
  await app.json('chat/temp/file', { id: draftChat.id, path: 'planning.txt', content: 'manual-private-draft' });
  assert.equal((await app.json(tempQuery(draftChat.id, 'planning.txt'))).content, 'manual-private-draft');

  const draftSecondChat = await app.json('chat', { taskId: draft.id, ...model, message: '[task-draft-chat] 第二个草稿对话' });
  await finished(draftSecondChat.id);
  assert.equal((await app.json(tempQuery(draftSecondChat.id, 'planning.txt'))).content, 'allocated-task-private-draft');
  assert.equal((await app.json(tempQuery(draftChat.id, 'planning.txt'))).content, 'manual-private-draft', 'Unstarted task conversations must keep same-name scratch files isolated');

  const childChat = await app.json('chat', { taskId: draft.id, ...model, message: '[task-child-create] 在当前任务下创建子任务' });
  const childHistory = await finished(childChat.id);
  const childCalls = childHistory.events.filter(event => event.type === 'tool/call' && event.data.name === 'studio_create_task');
  assert.equal(childCalls.length, 2);
  const childResults = childCalls.map(call => childHistory.events.find(event => event.type === 'tool/result' && event.data.message.source.callId === call.data.callId));
  assert.equal(childResults[0].data.message.isError, false);
  const childTask = JSON.parse(text(childResults[0].data.message.content));
  assert.equal(childTask.parentId, draft.id); assert.equal(childTask.projectId, draftProject.id); assert.equal(childTask.state, 'unstarted');
  assert.equal(childResults[1].data.message.isError, true); assert.match(text(childResults[1].data.message.content), /current task/);
  const folderContext = JSON.parse(text(resultFor(childHistory, 'studio_task_context').data.message.content));
  assert.equal(folderContext.isFolder, true); assert.equal(folderContext.childCount, 1); assert.equal(folderContext.writable, true);
  assert.equal(folderContext.childrenTotal, 1); assert.equal(folderContext.childrenTruncated, false);
  assert.deepEqual(folderContext.children.map(row => row.id), [childTask.id], 'Task context must expose only the current task’s direct children');
  assert.ok(folderContext.children.every(row => row.parentId === draft.id));
  const childSummary = folderContext.children[0];
  assert.equal(childSummary.code, childTask.code); assert.equal(childSummary.title, childTask.title);
  assert.equal(childSummary.goal, childTask.goal); assert.equal(childSummary.state, childTask.state);
  assert.equal(childSummary.isFolder, false); assert.equal(childSummary.leafStats.total, 1); assert.equal(childSummary.completedId, null);
  assert.ok(!folderContext.children.some(row => [task.id, secondTask.id, legacyTask.id, draft.id].includes(row.id)), 'Unrelated same-project, other-project and parent tasks must not appear in child summaries');
  assert.deepEqual(folderContext.inputSnapshots, []);
  assert.equal(resultFor(childHistory, 'studio_write_file').data.message.isError, false, 'An active task folder owns an editable workspace independently of leaf execution');
  assert.equal(text(resultFor(childHistory, 'studio_read_file').data.message.content), 'active task folders own their workspace');
  assert.equal(resultFor(childHistory, 'studio_delete_file').data.message.isError, false);
  assert.equal((await app.call(`file?taskId=${draft.id}&path=folder-summary.md`)).status, 400);
  assert.equal((await app.json(`task?id=${draft.id}`)).state, 'unstarted');
  assert.deepEqual((await app.json(`graph?projectId=${draftProject.id}`)).tasks.map(row => row.id), [draft.id, childTask.id]);
  assert.deepEqual((await app.json(`graph?projectId=${otherProject.id}`)).tasks, []);

  const childDraftChat = await app.json('chat', { taskId: childTask.id, ...model, message: '[task-draft-chat] 子任务可以直接保存工作文件' });
  const childDraftHistory = await finished(childDraftChat.id);
  assert.equal(resultFor(childDraftHistory, 'studio_write_file').data.message.isError, false);
  assert.equal((await app.json(`task?id=${childTask.id}`)).state, 'unstarted', 'Even complete task definitions must not start merely because the model attempts an artifact write');

  const inputProject = await app.json('projects', { title: '正式目录输入上下文（受控测试）' });
  const inputRoot = await app.json('task/quick', { projectId: inputProject.id, title: '上游目录' });
  const inputFolder = await app.json('task/quick', { projectId: inputProject.id, parentId: inputRoot.id, title: '中间目录' });
  const spec = title => ({ projectId: inputProject.id, title, kind: 'task', goal: '核对受控文本证据，不涉及真实工程参数',
    criteria: [{ id: 'proof', label: '证据检查', kind: 'check', method: '读取报告确认测试标记' }], outputs: ['report.md'], unresolved: [] });
  const inputLeaf = await app.json('task', { ...spec('具体输入叶任务'), parentId: inputFolder.id });
  const unrelatedInput = await app.json('task', spec('不属于实际输入的同项目叶任务'));
  for (const [node, content] of [[inputLeaf, 'immutable nested input report'], [unrelatedInput, 'unrelated snapshot must stay private']]) {
    await action(node.id, 'start');
    await app.json('file', { taskId: node.id, path: 'report.md', content });
    await action(node.id, 'complete', { measurements: [{ criterionId: 'proof', observed: true, evidence: 'report.md', note: '受控测试标记' }] });
  }
  assert.notEqual((await app.json(`task?id=${inputFolder.id}`)).state, 'completed', 'Completing a leaf must leave its group awaiting manual confirmation');
  assert.notEqual((await app.json(`task?id=${inputRoot.id}`)).state, 'completed', 'Ready leaf descendants cannot bypass an intermediate group confirmation');
  await confirmFolder(inputFolder.id);
  assert.notEqual((await app.json(`task?id=${inputRoot.id}`)).state, 'completed');
  await confirmFolder(inputRoot.id);
  const inputNodes = await Promise.all([inputRoot, inputFolder, inputLeaf, unrelatedInput].map(node => app.json(`task?id=${node.id}`)));
  const [formalRoot, formalFolder, formalLeaf, formalUnrelated] = inputNodes;
  const consumer = await app.json('task', spec('读取正式目录输入的后继任务'));
  await app.json('dependencies', { id: consumer.id, revision: consumer.revision, dependencies: [inputRoot.id] });
  await action(consumer.id, 'start');
  const inputChat = await app.json('chat', { taskId: consumer.id, ...model,
    message: `[task-input-context] actual nested leaf ${formalLeaf.completedId}; unrelated snapshot ${formalUnrelated.completedId}` });
  const inputHistory = await finished(inputChat.id);
  const inputContext = JSON.parse(text(resultFor(inputHistory, 'studio_task_context').data.message.content));
  assert.equal(inputContext.id, consumer.id); assert.equal(inputContext.projectId, inputProject.id); assert.equal(inputContext.state, 'working');
  assert.deepEqual(inputContext.children, []); assert.equal(inputContext.childrenTotal, 0); assert.equal(inputContext.childrenTruncated, false);
  assert.deepEqual(inputContext.inputs, [{ taskId: inputRoot.id, snapshotId: formalRoot.completedId }]);
  assert.equal(inputContext.inputSnapshotsLimit, 200); assert.equal(inputContext.inputSnapshotsTruncated, false);
  assert.deepEqual(inputContext.inputSnapshots.map(row => row.snapshotId), [formalRoot.completedId, formalFolder.completedId, formalLeaf.completedId]);
  assert.deepEqual(inputContext.inputSnapshots.map(row => row.taskId), [inputRoot.id, inputFolder.id, inputLeaf.id]);
  const [rootManifest, folderManifest, leafManifest] = inputContext.inputSnapshots;
  assert.deepEqual(rootManifest.childrenRefs, [{ taskId: inputFolder.id, snapshotId: formalFolder.completedId }]);
  assert.deepEqual(folderManifest.childrenRefs, [{ taskId: inputLeaf.id, snapshotId: formalLeaf.completedId }]);
  assert.deepEqual(leafManifest.childrenRefs, []); assert.deepEqual(leafManifest.files.map(file => file.path), ['report.md']);
  assert.equal(leafManifest.files[0].bytes, Buffer.byteLength('immutable nested input report')); assert.match(leafManifest.files[0].version, /^[0-9a-f]{64}$/);
  for (const manifest of inputContext.inputSnapshots) {
    assert.ok(manifest.files.length <= 100); assert.equal(manifest.filesTotal, manifest.files.length); assert.equal(manifest.filesTruncated, false);
    assert.ok(manifest.childrenRefs.length <= 200); assert.equal(manifest.childrenRefsTotal, manifest.childrenRefs.length); assert.equal(manifest.childrenRefsTruncated, false);
  }
  assert.ok(!inputContext.inputSnapshots.some(row => row.snapshotId === formalUnrelated.completedId), 'Current project snapshots outside actual input references must not be exposed');
  const inputReads = inputHistory.events.filter(event => event.type === 'tool/call' && event.data.name === 'studio_read_file');
  assert.equal(inputReads.length, 2);
  const readResults = inputReads.map(call => inputHistory.events.find(event => event.type === 'tool/result' && event.data.message.source.callId === call.data.callId));
  assert.equal(readResults[0].data.message.isError, false); assert.equal(text(readResults[0].data.message.content), 'immutable nested input report');
  assert.equal(readResults[1].data.message.isError, true); assert.match(text(readResults[1].data.message.content), /实际输入范围/);

  const oldSnapshots = await Promise.all(inputNodes.map(node => app.json(`snapshot?taskId=${node.id}&id=${node.completedId}`)));
  const slowInputChat = await app.json('chat', { taskId: consumer.id, ...model, message: '[slow]' });
  await action(inputLeaf.id, 'resume');
  assert.equal((await app.json(`task?id=${inputLeaf.id}`)).state, 'working');
  for (const folder of [inputFolder, inputRoot]) assert.equal((await app.json(`task?id=${folder.id}`)).state, 'recheck', 'Completed containing folders must await human review when a leaf resumes');
  assert.equal((await app.json(`task?id=${consumer.id}`)).state, 'unstarted', 'Downstream engineering must stop when an input is resumed');
  assert.equal((await app.json(`chat?id=${slowInputChat.id}`)).status, 'stored', 'Resuming an input must quiesce the downstream Agent');
  assert.equal((await app.call('file', { taskId: consumer.id, path: 'late.md', content: 'must be denied' })).status, 400);
  const consumerBeforeRestart = await app.json(`task?id=${consumer.id}`);
  assert.equal((await app.call('task/action', { id: consumer.id, revision: consumerBeforeRestart.revision, action: 'start' })).status, 400);
  for (let index = 0; index < inputNodes.length; index++) assert.deepEqual((await app.json(`snapshot?taskId=${inputNodes[index].id}&id=${inputNodes[index].completedId}`)).snapshot, oldSnapshots[index].snapshot, 'Resume must preserve every immutable historical snapshot');
  await app.json('file', { taskId: inputLeaf.id, path: 'report.md', content: 'immutable nested input report, version 2' });
  const leafReview = await app.json(`task/completion?taskId=${inputLeaf.id}`);
  const directRecompletion = await app.call('task/action', { id: inputLeaf.id, revision: leafReview.taskRevision, action: 'complete', measurements: [{ criterionId: 'proof', observed: true, evidence: 'report.md', note: 'must not bypass human review' }] });
  assert.equal(directRecompletion.status, 400); assert.match((await directRecompletion.json()).error, /人工确认|复核/u);
  const reviewedFiles = await app.json('task/completion/files', { taskId: inputLeaf.id, revision: leafReview.taskRevision, workspaceVersion: leafReview.workspaceVersion,
    files: [{ path: 'report.md', description: '复核并重新提交嵌套输入任务的第二版报告' }] });
  const reviewedLeaf = await app.json('task/completion', { taskId: inputLeaf.id, revision: reviewedFiles.taskRevision, workspaceVersion: reviewedFiles.workspaceVersion,
    checkedGoalIds: reviewedFiles.goals.filter(goal => !goal.system).map(goal => goal.id), submissionId: reviewedFiles.submittedFiles.id });
  assert.equal(reviewedLeaf.task.state, 'completed');
  assert.notEqual((await app.json(`task?id=${inputFolder.id}`)).state, 'completed', 'A resumed and re-completed leaf must not automatically reconfirm its group');
  await confirmFolder(inputFolder.id); await confirmFolder(inputRoot.id);
  const completedAgain = await app.json(`task?id=${inputRoot.id}`);
  assert.equal(completedAgain.state, 'completed'); assert.notEqual(completedAgain.completedId, formalRoot.completedId);
  await action(consumer.id, 'start');
  assert.deepEqual((await app.json(`task?id=${consumer.id}`)).inputs, [{ taskId: inputRoot.id, snapshotId: completedAgain.completedId }]);
  await app.json('chat', { taskId: consumer.id, id: inputChat.id, ...model, message: '[project-chat-only] 输入重新完成后继续同一对话' });
  await finished(inputChat.id, 1);

  await stopApp(app.child); app = undefined; app = await startApp(home);
  const restored = await app.json(`chat?id=${first.id}`); projectScope(restored, project.id); assert.equal(restored.status, 'stored');
  assert.equal(restored.events.length, tools.events.length);
  const restoredPacket = await snapshot(first.id); projectScope(restoredPacket.chat, project.id);
  assert.deepEqual(conversationRows(foldChatPacket(emptyChatState(), restoredPacket)), rowsBefore, 'SSE history must recover the same conversation after restart');
  for (const [chat, content] of [[first, 'first-project-chat'], [second, 'second-project-chat'], [third, 'other-project-chat']]) assert.equal((await app.json(tempQuery(chat.id, 'scratch.txt'))).content, content);
  assert.deepEqual((await app.json(`graph?projectId=${project.id}`)).tasks.map(row => [row.id, row.code, row.rank]), [task, secondTask].map(row => [row.id, row.code, row.rank]));
  assert.deepEqual((await app.json(`graph?projectId=${otherProject.id}`)).tasks, []);
  for (const [chat, content] of [[draftChat, 'manual-private-draft'], [draftSecondChat, 'allocated-task-private-draft']]) {
    assert.equal((await app.json(`chat?id=${chat.id}`)).status, 'stored');
    assert.equal((await app.json(tempQuery(chat.id, 'planning.txt'))).content, content);
  }
  assert.equal((await app.json(`task?id=${draft.id}`)).isFolder, true);
  assert.equal((await app.json(`task?id=${draft.id}`)).state, 'unstarted');
  assert.equal((await app.json(`task?id=${childTask.id}`)).parentId, draft.id);
  await app.json('chat', { taskId: draft.id, id: draftChat.id, ...model, message: '[project-chat-only] 重启后继续任务规划' });
  await finished(draftChat.id, 1);
  assert.equal((await app.json(`task?id=${draft.id}`)).state, 'unstarted');
  await app.json('chat', { projectId: project.id, id: first.id, ...model, message: '[project-chat-only] 重启后继续规划' });
  await finished(first.id, 2);
  assert.equal((await app.json(`graph?projectId=${project.id}`)).tasks.length, 2, 'Resuming a project conversation must not create a hidden task');
  console.log('Project and task planning verification passed: empty project conversations without hidden nodes, SSE and restart replay, owned project task creation, editable pending tasks with isolated private scratch and direct saved-file work, task-bound child creation with fixed parent and phase guards, bounded direct-child planning context, manually confirmed nested-group input manifests, scoped snapshot file reads, explicit reconfirmation after descendant resume, scope/project isolation and restart/resume persistence. No external model or engineering software called.');
} catch (error) { console.error(error); process.exitCode = 1; }
finally { if (app) await stopApp(app.child); await release(home); await rm(home, { recursive: true, force: true }); }
