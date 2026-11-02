import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { root } from './prepare.mjs';
import { startApp, stopApp } from './verify-app.mjs';
import { conversationRows, emptyChatState, foldChatPacket } from '../plugins/ui/lib/chat-state.js';

// All process termination, disk faults, projects and commands below belong to
// this newly allocated disposable home. Never use the shared preview home.
await mkdir(join(root, '.studio'), { recursive: true });
const home = await mkdtemp(join(root, '.studio/m5-recovery-test-'));
let app, subscriptions = [];
const model = { provider: 'studio-smoke', model: 'm1-smoke' };
const imageId = 'mock-solidworks';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const workspace = id => join(home, 'studio', 'workspaces', id);
const file = (id, path, content) => app.json('file', { taskId: id, path, content });
const task = id => app.json(`task?id=${id}`);
const newProject = title => app.json('projects', { title });
const quick = (projectId, title, parentId) => app.json('task/quick', { projectId, title, ...(parentId ? { parentId } : {}) });
const requestId = () => `m5-${randomUUID()}`;

async function until(read, ready, message) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) { const value = await read(); if (ready(value)) return value; await delay(35); }
  throw new Error(message);
}
async function denied(route, body, expected) {
  const response = await app.call(route, body), source = await response.text();
  assert.equal(response.status, 400, `${route}: ${source}`);
  const result = JSON.parse(source); assert.equal(typeof result.error, 'string');
  if (expected) assert.match(result.error, expected);
  return result.error;
}
async function finished(id, count = 1) {
  return until(() => app.json(`chat?id=${id}`), value => value.status === 'idle' && value.events.filter(event => event.type === 'turn/end').length === count, 'M5 native turn did not settle');
}
async function chat(owner, calls = [], delayMs = 0, id) {
  return app.json('chat', { ...owner, ...model, ...(id ? { id } : {}), message: `[m5-recovery] ${JSON.stringify({ calls, delayMs })}` });
}
function checkNative(record, calls) {
  const end = record.events.filter(event => event.type === 'turn/end').at(-1);
  assert.notEqual(end.data.reason.kind, 'error', JSON.stringify(end.data.reason));
  const tools = record.events.filter(event => event.type === 'tool/call');
  assert.deepEqual(tools.map(event => event.data.name), calls.map(call => call.name));
  for (let index = 0; index < tools.length; index++) {
    const result = record.events.find(event => event.type === 'tool/result' && event.data.message.source.callId === tools[index].data.callId);
    assert.ok(result); assert.equal(result.data.message.isError === true, calls[index].error === true);
  }
  assert.ok(record.events.some(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'text' && block.text.includes('M5_NATIVE_RECOVERY_VERIFIED'))));
}
const completionPreview = id => app.json(`task/completion?taskId=${id}`);
const completionArgs = preview => ({ taskId: preview.taskId, revision: preview.taskRevision, workspaceVersion: preview.workspaceVersion,
  checkedGoalIds: preview.goals.filter(goal => !goal.system).map(goal => goal.id), ...(preview.isFolder ? { childrenVersion: preview.childrenVersion } : {}) });
async function complete(id, path) {
  let preview = await completionPreview(id); assert.deepEqual(preview.blockers, []);
  if (path) {
    preview = await app.json('task/completion/files', { taskId: id, revision: preview.taskRevision, workspaceVersion: preview.workspaceVersion,
      files: [{ path, description: 'Explicit human verification of controlled M5 fixture bytes' }] });
    return (await app.json('task/completion', { ...completionArgs(preview), submissionId: preview.submittedFiles.id })).task;
  }
  return (await app.json('task/completion', { ...completionArgs(preview), confirmWithoutFiles: true })).task;
}
const deletePreview = id => app.json(`task/delete-preview?id=${id}`);
const clearPreview = id => app.json(`task/clear-preview?id=${id}`);
const destructiveArgs = preview => ({ id: preview.taskId, revision: preview.taskRevision, projectRevision: preview.projectRevision, confirm: true });
async function dependencyPreview(id, dependencies) { return app.json('dependencies/preview', { id, revision: (await task(id)).revision, dependencies }); }
const dependencyArgs = preview => { const { kind, ...request } = preview.request; return { ...request, confirmImpact: true, impactVersion: preview.impactVersion }; };
const fault = id => app.json('m5/fault', { taskId: id, enabled: true });
async function assertFrozen(id, action) {
  const value = await task(id);
  assert.equal(value.pendingAction, action); assert.equal(value.writable, false); assert.equal(value.canDiscuss, false);
  await denied('file', { taskId: id, path: 'late.md', content: 'must not appear' });
  await denied('chat', { taskId: id, ...model, message: '[m5-recovery] {"calls":[]}' });
  await denied('task/action', { id, revision: value.revision, action: 'resume' });
}
async function listen(id) {
  const response = await app.call(`chat/stream?id=${id}`);
  assert.equal(response.status, 200); const reader = response.body.getReader(), decoder = new TextDecoder();
  let state = emptyChatState(), buffer = '', closed = false;
  const packets = [];
  const read = (async () => {
    try { while (!closed) {
      const chunk = await reader.read(); if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true }); let split;
      while ((split = buffer.indexOf('\n\n')) >= 0) {
        const entry = buffer.slice(0, split); buffer = buffer.slice(split + 2);
        if (!entry.startsWith('data: ')) continue;
        const packet = JSON.parse(entry.slice(6)); packets.push(packet); state = foldChatPacket(state, packet);
      }
    } } finally { reader.releaseLock(); }
  })();
  const sub = { state: () => state, packets, close: async () => { if (closed) return; closed = true; await reader.cancel(); await read; subscriptions = subscriptions.filter(value => value !== sub); } };
  subscriptions.push(sub); return sub;
}
async function restart() {
  for (const sub of [...subscriptions]) await sub.close();
  await stopApp(app.child); app = undefined; app = await startApp(home); await probeReady();
}
async function probeReady() {
  await until(async () => {
    const response = await app.call('m5/fault', { taskId: 'unknown', enabled: false });
    await response.body?.cancel(); return response.status;
  }, status => status === 400, 'The explicit smoke-only M5 routes did not become ready');
}
async function platform(path, body, method = body === undefined ? 'GET' : 'POST') {
  const runtime = JSON.parse(await readFile(join(home, 'mock-seat', 'runtime.json'), 'utf8'));
  const token = (await readFile(join(home, 'mock-seat', 'token'), 'utf8')).trim();
  const response = await fetch(runtime.url + path, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal(response.status, 200, 'Owned Mock platform fixture call failed'); return response.json();
}
const softwareQuery = (route, fields) => `software/${route}?${new URLSearchParams(fields)}`;
async function seat(id) { return (await app.json(softwareQuery('seat', { taskId: id, imageId }))).seat; }
async function launch(id) {
  await app.json('software/seat', { taskId: id, imageId, requestId: requestId() });
  return until(() => seat(id), value => value?.state === 'ready', 'M5 fixture Seat did not become ready');
}
async function release(path) {
  const info = await lstat(path); if (info.isSymbolicLink()) return;
  if (info.isDirectory()) { await chmod(path, 0o700); for (const name of await readdir(path)) await release(join(path, name)); }
  else await chmod(path, 0o600);
}

try {
  app = await startApp(home);
  await probeReady();
  assert.equal((await fetch(`${app.base}/api/studio/m5/fault`, { method: 'POST', headers: { origin: app.base, 'content-type': 'application/json' }, body: JSON.stringify({ taskId: 'unknown', enabled: true }) })).status, 400);
  // With anonymous browser access, true confirmation would actually crash this
  // fixture. A refused confirmation must leave the Host alive and readable.
  assert.equal((await fetch(`${app.base}/api/studio/m5/crash`, { method: 'POST', headers: { origin: app.base, 'content-type': 'application/json' }, body: JSON.stringify({ confirm: false }) })).status, 400);
  assert.equal((await app.call('status')).status, 200);
  await denied('m5/fault', { taskId: 'unknown', enabled: true });
  await denied('m5/crash', { confirm: 'true' });

  // Model authority is enforced by native schemas and dispatcher, including an
  // attempted invented destructive tool and a graph patch with hidden state.
  const permissionsProject = await newProject('M5 scoped model authority');
  const owner = await quick(permissionsProject.id, 'Model-owned editable task');
  const sibling = await quick(permissionsProject.id, 'Sibling must remain unchanged');
  await file(sibling.id, 'secret.md', 'M5_OTHER_WORKSPACE_BYTES');
  const siblingBefore = await task(sibling.id);
  const permissionsCalls = [
    { name: 'studio_complete_task', args: { taskId: owner.id, confirm: true }, error: true },
    { name: 'studio_clear_task', args: { taskId: owner.id, confirm: true }, error: true },
    { name: 'studio_delete_task', args: { taskId: sibling.id, confirm: true }, error: true },
    { name: 'studio_software_ack_unknown', args: { taskId: owner.id, imageId, operationIds: [], expectedDocumentRevision: 0 }, error: true },
    { name: 'studio_read_file', args: { path: `../${sibling.id}/secret.md` }, error: true },
    { name: 'studio_write_file', args: { path: '.chat-tmp/forged/private.md', content: 'not allowed' }, error: true },
    { name: 'studio_project_context', args: {}, error: true },
    { name: 'studio_apply_graph_patch', args: { patch: JSON.stringify({ revision: (await app.json(`graph?projectId=${permissionsProject.id}`)).project.revision, updates: [{ id: owner.id, changes: { state: 'completed' } }] }) }, error: true },
    { name: 'studio_write_file', args: { path: 'allowed.md', content: 'M5_BOUND_NATIVE_WRITE' } },
  ];
  const permissionChat = await chat({ taskId: owner.id }, permissionsCalls);
  checkNative(await finished(permissionChat.id), permissionsCalls);
  assert.deepEqual(await task(sibling.id), siblingBefore); assert.equal((await task(owner.id)).state, 'unstarted');
  assert.equal((await app.json(`file?taskId=${owner.id}&path=allowed.md`)).content, 'M5_BOUND_NATIVE_WRITE');

  // Loss of a browser subscription must not cancel admitted backend work. A
  // real native tool writes after disconnect, then reconnect is an exact replay.
  const background = await quick(permissionsProject.id, 'Continue after browser disconnect');
  const backgroundCalls = [{ name: 'studio_write_file', args: { path: 'background.md', content: 'M5_BACKGROUND_CONTINUED' } }];
  const backgroundChat = await chat({ taskId: background.id }, backgroundCalls, 1000);
  const stream = await listen(backgroundChat.id);
  await until(() => stream.state(), value => value.status === 'running', 'No live M5 subscription');
  await stream.close();
  const backgroundRecord = await finished(backgroundChat.id); checkNative(backgroundRecord, backgroundCalls);
  assert.equal((await app.json(`file?taskId=${background.id}&path=background.md`)).content, 'M5_BACKGROUND_CONTINUED');
  const reconnected = await listen(backgroundChat.id);
  await until(() => reconnected.packets, packets => packets.some(packet => packet.type === 'snapshot'), 'No M5 reconnect snapshot');
  const backgroundRows = conversationRows(reconnected.state());
  assert.equal(backgroundRows.filter(row => row.role === 'user').length, 1);
  const backgroundTrace = backgroundRows.flatMap(row => row.role === 'assistant' ? row.steps.flatMap(step => step.tools) : []).find(tool => tool.name === 'studio_write_file');
  assert.ok(backgroundTrace && backgroundTrace.failed === false && backgroundTrace.result === hash('M5_BACKGROUND_CONTINUED'));
  await reconnected.close();

  // Existing committed bytes remain published if writing the next submission
  // fails. Only this fixture owner's directory is temporarily made unwritable.
  const submissionTask = await quick(permissionsProject.id, 'Submission write failure is atomic');
  await file(submissionTask.id, 'report.md', 'M5_SUBMITTED_ORIGINAL');
  const submissionPreview = await completionPreview(submissionTask.id);
  const initialSubmission = await app.json('task/completion/files', { taskId: submissionTask.id, revision: submissionPreview.taskRevision, workspaceVersion: submissionPreview.workspaceVersion,
    files: [{ path: 'report.md', description: 'Controlled original submitted bytes' }] });
  const commit = initialSubmission.submittedFiles;
  const commitBytes = join(home, 'studio', 'file-submissions', submissionTask.id, commit.id, 'files', 'report.md');
  const originalCommitHash = hash(await readFile(commitBytes));
  await file(submissionTask.id, 'report.md', 'M5_UNPUBLISHED_UPDATE');
  const changedPreview = await completionPreview(submissionTask.id), submissionOwner = join(home, 'studio', 'file-submissions', submissionTask.id);
  await chmod(submissionOwner, 0o500);
  try { await denied('task/completion/files', { taskId: submissionTask.id, revision: changedPreview.taskRevision, workspaceVersion: changedPreview.workspaceVersion,
    files: [{ path: 'report.md', description: 'Must fail before publishing this new commit' }] }); }
  finally { await chmod(submissionOwner, 0o700); }
  assert.deepEqual((await completionPreview(submissionTask.id)).submittedFiles, commit);
  assert.deepEqual(await readdir(submissionOwner), [commit.id], 'Failed submission must leave no published or temporary extra commit');
  assert.equal(hash(await readFile(commitBytes)), originalCommitHash); assert.equal((await task(submissionTask.id)).writable, true);

  // Four independent projects avoid coupling their pending recovery journals.
  const completeProject = await newProject('M5 failed completion recovery');
  const completeTask = await quick(completeProject.id, 'Frozen completion needs fresh manual checks');
  await file(completeTask.id, 'retained.md', 'M5_COMPLETION_WORKSPACE_PRESERVED');
  const completeChat = await chat({ taskId: completeTask.id }); await finished(completeChat.id);
  const completeBefore = await completionPreview(completeTask.id);
  await fault(completeTask.id);
  await denied('task/completion', { ...completionArgs(completeBefore), confirmWithoutFiles: true }, /M5_CONTROLLED_QUIESCE_FAILURE/u);
  await assertFrozen(completeTask.id, 'complete');
  assert.equal((await task(completeTask.id)).completedId, undefined);

  const ioProject = await newProject('M5 actual snapshot disk failure');
  const ioTask = await quick(ioProject.id, 'Formal snapshot failure remains pending');
  const snapshotRoot = join(home, 'studio', 'snapshots'); await mkdir(snapshotRoot, { recursive: true });
  const ioPreview = await completionPreview(ioTask.id);
  await chmod(snapshotRoot, 0o500);
  try { await denied('task/completion', { ...completionArgs(ioPreview), confirmWithoutFiles: true }); }
  finally { await chmod(snapshotRoot, 0o700); }
  await assertFrozen(ioTask.id, 'complete');

  const deleteProject = await newProject('M5 journaled deletion recovery');
  const deleteTask = await quick(deleteProject.id, 'Delete only after exact retry confirmation');
  await file(deleteTask.id, 'report.md', 'M5_DELETE_TARGET');
  const deleteChat = await chat({ taskId: deleteTask.id }); await finished(deleteChat.id);
  const deleteCompleted = await complete(deleteTask.id, 'report.md');
  const deletionBefore = await deletePreview(deleteTask.id);
  await fault(deleteTask.id);
  await denied('task/delete', destructiveArgs(deletionBefore), /M5_CONTROLLED_QUIESCE_FAILURE/u);
  await assertFrozen(deleteTask.id, 'delete');
  assert.equal((await app.json(`snapshot?taskId=${deleteTask.id}`)).snapshot.id, deleteCompleted.completedId);

  const depsProject = await newProject('M5 dependency journal recovery');
  const source = await quick(depsProject.id, 'New incomplete predecessor');
  const target = await quick(depsProject.id, 'Completed result to recheck');
  const downstream = await quick(depsProject.id, 'Completed downstream to recheck');
  await app.json('dependencies', { id: downstream.id, revision: downstream.revision, dependencies: [target.id] });
  const targetCompleted = await complete(target.id), downstreamCompleted = await complete(downstream.id);
  const dependencyBefore = await dependencyPreview(target.id, [source.id]);
  assert.equal(dependencyBefore.requiresConfirmation, true);
  await fault(target.id);
  await denied('dependencies', dependencyArgs(dependencyBefore), /M5_CONTROLLED_QUIESCE_FAILURE/u);
  for (const id of [target.id, downstream.id]) await assertFrozen(id, 'dependencies');
  assert.deepEqual((await task(target.id)).dependencies, []);

  const clearProject = await newProject('M5 journaled progress reset recovery');
  const clearParent = await quick(clearProject.id, 'Containing group retains its historical result');
  const clearLeaf = await quick(clearProject.id, 'Clear self-owned data and keep task definition', clearParent.id);
  await app.json('task/metadata', { id: clearLeaf.id, revision: clearLeaf.revision, title: clearLeaf.title,
    goal: 'M5_CLEAR_KEEP_DEFINITION: preserve explicitly described engineering intent without retaining result history',
    checklist: [{ text: 'M5_CLEAR_KEEP_CHECKLIST: retain the human acceptance requirement' }, { text: 'M5_CLEAR_KEEP_CHECKLIST_2: keep unresolved constraints visible' }] });
  const preservedLeaf = await quick(clearProject.id, 'Preserve sibling result and bytes', clearParent.id);
  const clearConsumer = await quick(clearProject.id, 'Downstream must manually recheck after clear');
  await file(clearLeaf.id, 'report.md', 'M5_CLEAR_OWNED_FORMAL_BYTES');
  const clearChat = await chat({ taskId: clearLeaf.id }, [{ name: 'studio_write_temp_file', args: { path: 'notes.md', content: 'M5_CLEAR_PRIVATE_CHAT_BYTES' } }]);
  await finished(clearChat.id);
  const clearCompleted = await complete(clearLeaf.id, 'report.md');
  await file(preservedLeaf.id, 'kept.md', 'M5_CLEAR_SIBLING_PRESERVED');
  const preservedComplete = await complete(preservedLeaf.id, 'kept.md');
  const parentComplete = await complete(clearParent.id);
  await app.json('dependencies', { id: clearConsumer.id, revision: clearConsumer.revision, dependencies: [clearParent.id] });
  const consumerComplete = await complete(clearConsumer.id);
  const clearDefinition = await task(clearLeaf.id), clearBefore = await clearPreview(clearLeaf.id);
  assert.equal(clearBefore.preservedChildren, true);
  assert.ok(clearBefore.affected.some(value => value.id === clearParent.id));
  assert.ok(clearBefore.affected.some(value => value.id === clearConsumer.id));
  for (const confirm of [undefined, false, 'true']) await denied('task/clear', { ...destructiveArgs(clearBefore), confirm });
  assert.deepEqual(await task(clearLeaf.id), clearDefinition, 'Rejected clear confirmation has no domain side effects');
  await fault(clearLeaf.id);
  await denied('task/clear', destructiveArgs(clearBefore), /M5_CONTROLLED_QUIESCE_FAILURE/u);
  for (const id of [clearLeaf.id, clearParent.id, clearConsumer.id]) await assertFrozen(id, 'clear');
  assert.equal((await task(preservedLeaf.id)).pending, undefined, 'Clearing a leaf must not freeze an unaffected sibling');

  await restart();
  for (const [id, action] of [[completeTask.id, 'complete'], [ioTask.id, 'complete'], [deleteTask.id, 'delete'], [target.id, 'dependencies'], [downstream.id, 'dependencies']]) await assertFrozen(id, action);
  assert.deepEqual((await completionPreview(submissionTask.id)).submittedFiles, commit);
  assert.equal(hash(await readFile(commitBytes)), originalCommitHash);
  const resubmitPreview = await completionPreview(submissionTask.id);
  const resubmitted = await app.json('task/completion/files', { taskId: submissionTask.id, revision: resubmitPreview.taskRevision, workspaceVersion: resubmitPreview.workspaceVersion,
    files: [{ path: 'report.md', description: 'New explicit submission after storage recovery' }] });
  assert.notEqual(resubmitted.submittedFiles.id, commit.id);
  assert.equal(hash(await readFile(commitBytes)), originalCommitHash, 'Storage recovery cannot rewrite previous submitted bytes');
  const coldBackground = await listen(backgroundChat.id);
  await until(() => coldBackground.packets, packets => packets.some(packet => packet.type === 'snapshot'), 'No cold M5 native SSE snapshot');
  assert.deepEqual(conversationRows(coldBackground.state()), backgroundRows, 'Authenticated native SSE projection is stable across restart');
  await coldBackground.close();
  await denied('task/completion', { ...completionArgs(completeBefore), confirmWithoutFiles: true });
  const completeRetry = await completionPreview(completeTask.id); assert.equal(completeRetry.retry, true);
  await denied('task/completion', { ...completionArgs(completeRetry), checkedGoalIds: [], confirmWithoutFiles: true });
  await complete(completeTask.id); await complete(ioTask.id);
  assert.equal(await readFile(join(workspace(completeTask.id), 'retained.md'), 'utf8'), 'M5_COMPLETION_WORKSPACE_PRESERVED');
  await denied('task/delete', destructiveArgs(deletionBefore));
  const deletionRetry = await deletePreview(deleteTask.id); assert.equal(deletionRetry.retry, true);
  await app.json('task/delete', destructiveArgs(deletionRetry));
  await denied(`task?id=${deleteTask.id}`); await denied(`chat?id=${deleteChat.id}`);
  await assert.rejects(lstat(workspace(deleteTask.id)), { code: 'ENOENT' });
  await assert.rejects(lstat(join(home, 'studio', 'snapshots', deleteCompleted.completedId)), { code: 'ENOENT' });
  const dependencyRetry = await dependencyPreview(target.id, [source.id]); assert.equal(dependencyRetry.retry, true);
  await denied('dependencies', { ...dependencyArgs(dependencyRetry), impactVersion: dependencyBefore.impactVersion });
  await app.json('dependencies', dependencyArgs(dependencyRetry));
  for (const [id, historical] of [[target.id, targetCompleted.completedId], [downstream.id, downstreamCompleted.completedId]]) {
    const value = await task(id); assert.equal(value.state, 'recheck'); assert.equal(value.pending, undefined); assert.equal(value.completedId, historical);
  }
  assert.deepEqual((await task(target.id)).dependencies, [source.id]);
  await assertFrozen(clearLeaf.id, 'clear');
  await denied('task/clear', destructiveArgs(clearBefore));
  const clearRetry = await clearPreview(clearLeaf.id); assert.equal(clearRetry.retry, true);
  await app.json('task/clear', destructiveArgs(clearRetry));
  const cleared = await task(clearLeaf.id);
  assert.equal(cleared.state, 'unstarted'); assert.equal(cleared.pending, undefined);
  assert.deepEqual([cleared.id, cleared.code, cleared.rank, cleared.title, cleared.goal, cleared.checklist, cleared.parentId],
    [clearDefinition.id, clearDefinition.code, clearDefinition.rank, clearDefinition.title, clearDefinition.goal, clearDefinition.checklist, clearDefinition.parentId]);
  assert.equal(cleared.dataGeneration, (clearDefinition.dataGeneration ?? 0) + 1);
  assert.deepEqual(cleared.inputs, []); assert.equal(cleared.completedId, undefined); assert.equal(cleared.completionSubmission, undefined);
  assert.deepEqual((await completionPreview(clearLeaf.id)).files, []);
  await denied(`chat?id=${clearChat.id}`); await denied(`chat/stream?id=${clearChat.id}`);
  await denied(`chat/temp?id=${clearChat.id}`);
  await denied('chat', { id: clearChat.id, taskId: clearLeaf.id, ...model, message: '[m5-recovery] {"calls":[]}' });
  await denied(`snapshot?taskId=${clearLeaf.id}&id=${clearCompleted.completedId}`);
  await assert.rejects(lstat(join(home, 'studio', 'snapshots', clearCompleted.completedId)), { code: 'ENOENT' });
  await assert.rejects(lstat(join(home, 'studio', 'file-submissions', clearLeaf.id)), { code: 'ENOENT' });
  assert.equal((await task(preservedLeaf.id)).state, 'completed'); assert.equal((await task(preservedLeaf.id)).completedId, preservedComplete.completedId);
  assert.equal(await readFile(join(workspace(preservedLeaf.id), 'kept.md'), 'utf8'), 'M5_CLEAR_SIBLING_PRESERVED');
  for (const [id, historical] of [[clearParent.id, parentComplete.completedId], [clearConsumer.id, consumerComplete.completedId]]) {
    const value = await task(id); assert.equal(value.state, 'recheck'); assert.equal(value.completedId, historical);
    assert.equal((await app.json(`snapshot?taskId=${id}&id=${historical}`)).snapshot.id, historical);
  }
  const freshClearChat = await chat({ taskId: clearLeaf.id }); await finished(freshClearChat.id);
  assert.notEqual(freshClearChat.id, clearChat.id);

  // Clearing a nonempty folder removes only its own artifacts/conversations.
  // All child results and conversations survive, including after a restart.
  const clearFolder = await quick(clearProject.id, 'Clear folder while preserving actual children');
  await file(clearFolder.id, 'folder-draft.md', 'M5_CLEAR_FOLDER_SELF_OWNED');
  const keptChild = await quick(clearProject.id, 'Folder child keeps its own progress', clearFolder.id);
  await file(keptChild.id, 'child.md', 'M5_CLEAR_CHILD_OWNED');
  const childChat = await chat({ taskId: keptChild.id }); const childChatRecord = await finished(childChat.id);
  const childCompleted = await complete(keptChild.id, 'child.md');
  const folderChat = await chat({ taskId: clearFolder.id }); await finished(folderChat.id);
  await complete(clearFolder.id);
  const folderClear = await clearPreview(clearFolder.id); assert.equal(folderClear.childCount, 1);
  await app.json('task/clear', destructiveArgs(folderClear));
  assert.equal((await task(clearFolder.id)).state, 'unstarted'); assert.equal((await task(clearFolder.id)).childCount, 1);
  assert.equal((await task(keptChild.id)).completedId, childCompleted.completedId);
  assert.equal(await readFile(join(workspace(keptChild.id), 'child.md'), 'utf8'), 'M5_CLEAR_CHILD_OWNED');
  assert.deepEqual((await app.json(`chat?id=${childChat.id}`)).events, childChatRecord.events);
  await denied(`chat?id=${folderChat.id}`);
  await restart();
  assert.equal((await task(clearFolder.id)).state, 'unstarted', 'Child completion cannot implicitly restore cleared folder progress');
  assert.equal((await task(keptChild.id)).completedId, childCompleted.completedId);
  assert.deepEqual((await app.json(`chat?id=${childChat.id}`)).events, childChatRecord.events);
  await denied(`chat?id=${clearChat.id}`); await denied(`chat?id=${folderChat.id}`);

  // A confirmed live clear must drain native file writers and erase the owned
  // external Seat before returning. An old chat cannot recreate either store.
  const liveClear = await quick(clearProject.id, 'Clear an active native and software producer');
  const liveClearSeat = await launch(liveClear.id);
  await app.json('software/recorder', { taskId: liveClear.id, imageId, enabled: true });
  await app.json('software/control', { taskId: liveClear.id, imageId, action: 'acquire' });
  await platform(`/v1/seats/${liveClearSeat.id}/fault`, { mode: 'none', delayMs: 1500 });
  const liveClearRequest = requestId();
  const liveClearOperation = (await app.json('software/invoke', { taskId: liveClear.id, imageId, requestId: liveClearRequest, capability: 'shape.add',
    parameters: { kind: 'rectangle', x: 0, y: 0, width: 2, height: 2, label: 'clear cancels owned work' }, expectedDocumentRevision: liveClearSeat.document.revision })).operation;
  assert.ok(['queued', 'running'].includes(liveClearOperation.state));
  const liveClearChat = await chat({ taskId: liveClear.id }, [{ name: 'studio_write_file', args: { path: 'late.md', content: 'M5_CLEAR_LATE_NATIVE_WRITE' } }], 1500);
  await until(() => app.json(`chat?id=${liveClearChat.id}`), value => value.status === 'running', 'Live clear fixture did not admit the model');
  await app.json('task/clear', destructiveArgs(await clearPreview(liveClear.id)));
  assert.equal((await task(liveClear.id)).state, 'unstarted');
  assert.deepEqual((await app.json(softwareQuery('seats', { taskId: liveClear.id }))).seats, []);
  await denied(`chat?id=${liveClearChat.id}`);
  await delay(1700);
  await assert.rejects(lstat(join(workspace(liveClear.id), 'late.md')), { code: 'ENOENT' });
  const afterClearPlatform = await readFile(join(home, 'mock-seat', 'data', 'state.json'), 'utf8');
  for (const value of [liveClearSeat.id, liveClearOperation.id, liveClearRequest]) assert.ok(!afterClearPlatform.includes(value), 'Confirmed clear must erase owned Seat/operation/recorder history');

  // A known unknown receipt is inspected and retried with the *same* request,
  // never reissued with a new identity or turned into success by a restart.
  const softwareTask = await quick(permissionsProject.id, 'Unknown software result never replays');
  const initialSeat = await launch(softwareTask.id);
  await app.json('software/control', { taskId: softwareTask.id, imageId, action: 'acquire' });
  await platform(`/v1/seats/${initialSeat.id}/fault`, { mode: 'unknown', delayMs: 120 });
  const command = { taskId: softwareTask.id, imageId, requestId: requestId(), capability: 'shape.add', parameters: { kind: 'rectangle', x: 0, y: 0, width: 2, height: 2, label: 'must not blindly replay' }, expectedDocumentRevision: initialSeat.document.revision };
  const unknownReceipt = (await app.json('software/invoke', command)).operation;
  const unknown = await until(() => app.json(softwareQuery('operation', { taskId: softwareTask.id, imageId, operationId: unknownReceipt.id })), value => value.operation.state === 'unknown', 'No controlled unknown command receipt');
  assert.equal(unknown.operation.error.retryable, false);
  assert.deepEqual((await seat(softwareTask.id)).document, initialSeat.document);
  await platform(`/v1/seats/${initialSeat.id}/fault`, { mode: 'none' });
  assert.equal((await app.json('software/invoke', command)).operation.id, unknownReceipt.id);
  assert.equal((await seat(softwareTask.id)).operations.length, 1);
  assert.deepEqual((await seat(softwareTask.id)).unacknowledgedUnknownIds, [unknownReceipt.id]);
  await denied('software/invoke', { ...command, requestId: requestId() }, /unknown|未知|核对/u);
  await app.json('software/control', { taskId: softwareTask.id, imageId, action: 'release' });
  const unknownAgentCalls = [
    { name: 'studio_software_control', args: { imageId, action: 'acquire' } },
    { name: 'studio_software_invoke', args: { imageId, requestId: requestId(), capability: command.capability, parameters: JSON.stringify(command.parameters), expectedDocumentRevision: command.expectedDocumentRevision }, error: true },
    { name: 'studio_software_control', args: { imageId, action: 'release' } },
  ];
  const unknownAgent = await chat({ taskId: softwareTask.id }, unknownAgentCalls);
  checkNative(await finished(unknownAgent.id), unknownAgentCalls);
  assert.equal((await seat(softwareTask.id)).operations.length, 1, 'Agent cannot create a fresh operation before human reconciliation');

  // Kill the actual owned Host while a native delayed write is admitted. The
  // wrapper cleans its owned platform. Restart must not replay the lost call.
  const interruptedTask = await quick(permissionsProject.id, 'Native model crash cannot replay a write');
  const interruptedCalls = [{ name: 'studio_write_file', args: { path: 'late.md', content: 'M5_CRASHED_MODEL_WRITE' } }];
  const interrupted = await chat({ taskId: interruptedTask.id }, interruptedCalls, 5000);
  await until(() => app.json(`chat?id=${interrupted.id}`), value => value.status === 'running', 'Interrupted model was not running');
  const softwareBeforeCrash = await launch(interruptedTask.id);
  await platform(`/v1/seats/${softwareBeforeCrash.id}/fault`, { mode: 'none', delayMs: 5000 });
  const queuedBody = { taskId: interruptedTask.id, imageId, requestId: requestId(), capability: 'shape.add', parameters: { kind: 'rectangle', x: 4, y: 0, width: 2, height: 2 }, expectedDocumentRevision: softwareBeforeCrash.document.revision };
  const bridgeCalls = [
    { name: 'studio_software_control', args: { imageId, action: 'acquire' } },
    { name: 'studio_software_invoke', args: { imageId, requestId: queuedBody.requestId, capability: queuedBody.capability, parameters: JSON.stringify(queuedBody.parameters), expectedDocumentRevision: queuedBody.expectedDocumentRevision } },
  ];
  const interruptedBridge = await chat({ taskId: interruptedTask.id }, bridgeCalls);
  const queued = await until(() => seat(interruptedTask.id), value => value.operations.some(row => row.requestId === queuedBody.requestId), 'No actual in-flight native Bridge operation before Host crash')
    .then(value => value.operations.find(row => row.requestId === queuedBody.requestId));
  assert.ok(['queued', 'running'].includes(queued.state));
  const openBridge = await app.json(`chat?id=${interruptedBridge.id}`);
  const openCall = openBridge.events.find(event => event.type === 'tool/call' && event.data.name === 'studio_software_invoke');
  assert.ok(openCall, 'The external command must follow a durable native tool call checkpoint');
  assert.ok(!openBridge.events.some(event => event.type === 'tool/result' && event.data.message.source.callId === openCall.data.callId));
  await app.json('m5/crash', { confirm: true });
  await until(() => app.child.exitCode, value => value !== null, 'Owned crashed Host wrapper did not exit');
  app = undefined; app = await startApp(home); await probeReady();
  const recoveredModel = await app.json(`chat?id=${interrupted.id}`);
  assert.equal(recoveredModel.status, 'stored');
  await assert.rejects(lstat(join(workspace(interruptedTask.id), 'late.md')), { code: 'ENOENT' });
  const recoveredSoftware = await seat(interruptedTask.id);
  assert.equal(recoveredSoftware.control, null);
  assert.deepEqual(recoveredSoftware.document, softwareBeforeCrash.document);
  const restartedUnknown = await app.json(softwareQuery('operation', { taskId: interruptedTask.id, imageId, operationId: queued.id }));
  assert.equal(restartedUnknown.operation.state, 'unknown'); assert.equal(restartedUnknown.operation.error.retryable, false);
  const coldBridge = await app.json(`chat?id=${interruptedBridge.id}`);
  assert.equal(coldBridge.status, 'stored');
  assert.ok(coldBridge.events.some(event => event.type === 'tool/call' && event.data.callId === openCall.data.callId));
  assert.ok(!coldBridge.events.some(event => event.type === 'tool/result' && event.data.message.source.callId === openCall.data.callId), 'A read-only raw history route must not invent a successful operation result');
  assert.equal((await seat(softwareTask.id)).operations.length, 1);
  assert.equal((await app.json(softwareQuery('operation', { taskId: softwareTask.id, imageId, operationId: unknownReceipt.id }))).operation.state, 'unknown');
  await app.json('software/control', { taskId: interruptedTask.id, imageId, action: 'acquire' });
  assert.equal((await app.json('software/invoke', queuedBody)).operation.id, queued.id);
  assert.equal((await seat(interruptedTask.id)).operations.length, 1);
  assert.deepEqual((await seat(interruptedTask.id)).unacknowledgedUnknownIds, [queued.id]);
  await denied('software/invoke', { ...queuedBody, requestId: requestId() }, /unknown|未知|核对/u);

  // The explicit reconciliation action belongs only to the human API and binds
  // the entire unresolved receipt set plus the current document version/control.
  const unknownSeatAfterRestart = await seat(softwareTask.id);
  assert.deepEqual(unknownSeatAfterRestart.unacknowledgedUnknownIds, [unknownReceipt.id], 'The unknown-operation hard gate survives Host/platform restart');
  await app.json('software/control', { taskId: softwareTask.id, imageId, action: 'acquire' });
  const acknowledge = { taskId: softwareTask.id, imageId, operationIds: [unknownReceipt.id], expectedDocumentRevision: unknownSeatAfterRestart.document.revision };
  await denied('software/ack-unknown', { ...acknowledge, operationIds: [] });
  await denied('software/ack-unknown', { ...acknowledge, operationIds: [queued.id] });
  await denied('software/ack-unknown', { ...acknowledge, expectedDocumentRevision: acknowledge.expectedDocumentRevision + 1 });
  const acknowledged = (await app.json('software/ack-unknown', acknowledge)).seat;
  assert.deepEqual(acknowledged.unacknowledgedUnknownIds, []);
  assert.equal((await app.json(softwareQuery('operation', { taskId: softwareTask.id, imageId, operationId: unknownReceipt.id }))).operation.state, 'unknown', 'Human acknowledgment cannot fabricate a successful receipt');
  const acknowledgedWrite = (await app.json('software/invoke', { ...command, requestId: requestId() })).operation;
  await until(() => app.json(softwareQuery('operation', { taskId: softwareTask.id, imageId, operationId: acknowledgedWrite.id })), value => value.operation.state === 'succeeded', 'New explicit write after human reconciliation did not settle');
  assert.equal((await seat(softwareTask.id)).operations.length, 2);
  const resumed = await chat({ taskId: interruptedTask.id }, [], 0, interrupted.id);
  const resumedRecord = await finished(resumed.id, 2);
  assert.ok(resumedRecord.events.some(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'text' && block.text.includes('M5_NATIVE_RECOVERY_VERIFIED'))));
  await assert.rejects(lstat(join(workspace(interruptedTask.id), 'late.md')), { code: 'ENOENT' });
  const resumedBridge = await chat({ taskId: interruptedTask.id }, [], 0, interruptedBridge.id);
  const resumedBridgeRecord = await finished(resumedBridge.id, 2);
  const durableUnknownTool = resumedBridgeRecord.events.find(event => event.type === 'tool/result' && event.data.message.source.callId === openCall.data.callId);
  assert.ok(durableUnknownTool.data.message.isError && JSON.stringify(durableUnknownTool.data).includes('TOOL_OUTCOME_UNKNOWN'));
  assert.equal((await seat(interruptedTask.id)).operations.length, 1, 'Native continuation cannot automatically reissue the interrupted operation');

  console.log('M5 recovery verification passed: real Host failure journals and fresh human recovery for completion/snapshot/dependency/deletion/clear; immutable submission preservation on disk failure; clear self-owned data and obsolete-chat fencing with child/sibling/historical downstream preservation; native model authority denials; disconnect/background execution/exact SSE replay; true owned Host crash, lost model write not replayed, software unknown receipts and same-request idempotent inspection. No real Provider, user data or industrial software used.');
} catch (error) { console.error(error); process.exitCode = 1; }
finally {
  for (const sub of [...subscriptions]) await sub.close();
  if (app) await stopApp(app.child);
  await release(home); await rm(home, { recursive: true, force: true });
}
