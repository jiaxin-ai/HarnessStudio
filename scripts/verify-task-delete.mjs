import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, chmod, lstat, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { root } from './prepare.mjs';
import { startApp, stopApp, finishedChat } from './verify-app.mjs';

// This home is allocated exclusively for this disposable fixture. Never use the
// preview's .studio/home, and never select a real Provider or engineering Seat.
await mkdir(join(root, '.studio'), { recursive: true });
const home = await mkdtemp(join(root, '.studio/task-delete-test-'));
const data = join(home, 'studio');
let app;
const spec = title => ({ title, kind: 'task', goal: '核对永久删除边界，不涉及真实工程参数',
  criteria: [{ id: 'proof', label: '受控检查', kind: 'check', method: '核对受控报告标记' }], outputs: ['report.md'], unresolved: [] });
const measurements = [{ criterionId: 'proof', observed: true, evidence: 'report.md', note: '仅验证受控删除数据' }];
const workspace = id => join(data, 'workspaces', id);
const snapshotDirectory = id => join(data, 'snapshots', id);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const args = preview => ({ id: preview.taskId, revision: preview.taskRevision, projectRevision: preview.projectRevision, confirm: true });
const previewRoute = id => `task/delete-preview?${new URLSearchParams({ id })}`;
const preview = id => app.json(previewRoute(id));

async function action(id, operation, extra = {}) {
  const task = await app.json(`task?id=${id}`);
  return app.json('task/action', { id, revision: task.revision, action: operation, ...extra });
}
async function dependencies(id, ids) {
  const task = await app.json(`task?id=${id}`);
  const preview = await app.json('dependencies/preview', { id, revision: task.revision, dependencies: ids }), { kind, ...request } = preview.request;
  return app.json('dependencies', { ...request, confirmImpact: true, impactVersion: preview.impactVersion });
}
async function confirmLeaf(id) {
  const preview = await app.json(`task/completion?taskId=${id}`);
  assert.deepEqual(preview.blockers, []);
  const submitted = await app.json('task/completion/files', { taskId: id, revision: preview.taskRevision, workspaceVersion: preview.workspaceVersion,
    files: [{ path: 'report.md', description: '删除回归测试中人工重新核对的受控报告' }] });
  return (await app.json('task/completion', { taskId: id, revision: submitted.taskRevision, workspaceVersion: submitted.workspaceVersion,
    checkedGoalIds: submitted.goals.filter(goal => !goal.system).map(goal => goal.id), submissionId: submitted.submittedFiles.id })).task;
}
async function complete(id, content) {
  await action(id, 'start');
  await app.json('file', { taskId: id, path: 'report.md', content });
  if ((await app.json(`task?id=${id}`)).completedId) await confirmLeaf(id); else await action(id, 'complete', { measurements });
  return app.json(`task?id=${id}`);
}
async function confirmFolder(id) {
  const preview = await app.json(`task/completion?taskId=${id}`);
  assert.deepEqual(preview.blockers, [], 'A group is confirmed only after all direct child results are valid');
  return (await app.json('task/completion', { taskId: id, revision: preview.taskRevision, workspaceVersion: preview.workspaceVersion,
    childrenVersion: preview.childrenVersion, checkedGoalIds: preview.goals.filter(goal => !goal.system).map(goal => goal.id), confirmWithoutFiles: true })).task;
}
async function chat(owner, message = '[project-chat-only] 受控聊天数据') {
  const sent = await app.json('chat', { ...owner, provider: 'studio-smoke', model: 'm1-smoke', message });
  if (!message.includes('[slow]')) await finishedChat(app, sent.id);
  return sent;
}
async function denied(route, body, label) {
  const response = await app.call(route, body), text = await response.text();
  assert.equal(response.status, 400, `${label}: ${route}: ${text}`);
  const value = JSON.parse(text);
  assert.equal(response.status, 400, `${label}: ${JSON.stringify(value)}`);
  assert.equal(typeof value.error, 'string', label);
  return value.error;
}
function database(operation, readonly = true) {
  const db = new DatabaseSync(join(data, 'domain.sqlite'), { readOnly: readonly });
  try { return operation(db); } finally { db.close(); }
}
function rows(table, condition = '', params = []) {
  return database(db => db.prepare(`SELECT * FROM ${table} ${condition} ORDER BY rowid`).all(...params).map(row => ({ ...row })));
}
async function diskTree(directory) {
  let info;
  try { info = await lstat(directory); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  assert.equal(info.isSymbolicLink(), false, 'The fixture cannot follow symbolic links');
  assert.ok(info.isDirectory(), 'Expected fixture directory');
  const found = [];
  async function visit(path, relative = '') {
    for (const row of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(path, row.name), name = relative ? `${relative}/${row.name}` : row.name;
      assert.equal(row.isSymbolicLink(), false, 'The fixture cannot follow symbolic links');
      if (row.isDirectory()) { found.push({ path: name, kind: 'directory' }); await visit(child, name); }
      else if (row.isFile()) found.push({ path: name, kind: 'file', hash: hash(await readFile(child)) });
      else throw new Error('Unexpected special file in controlled fixture');
    }
  }
  await visit(directory); return found;
}
async function sessionPaths(id) {
  const sessions = join(data, 'sessions');
  let parents;
  try { parents = await readdir(sessions, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const found = [];
  for (const parent of parents) {
    assert.equal(parent.isSymbolicLink(), false);
    if (!parent.isDirectory()) continue;
    const path = join(sessions, parent.name, id);
    try { if ((await lstat(path)).isDirectory()) found.push(path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return found;
}
async function checkpoint(projectId, ids) {
  return {
    graph: await app.json(`graph?projectId=${projectId}`),
    chats: (await app.json('status')).chats,
    tasks: rows('tasks'), dependencies: rows('dependencies'), snapshots: rows('snapshots'), reviews: rows('reviews'), deletionJobs: rows('deletion_jobs'),
    workspaces: await Promise.all(ids.map(async id => [id, await diskTree(workspace(id))])),
  };
}
async function assertGone(task, chats, snapshots) {
  await denied(`task?id=${task.id}`, undefined, 'Deleted task cannot be read');
  await denied(`file?taskId=${task.id}&path=report.md`, undefined, 'Deleted workspace cannot be read');
  await denied('file', { taskId: task.id, path: 'report.md', content: 'cannot recreate' }, 'Deleted workspace cannot be written');
  await denied(`project/files?projectId=${task.projectId}&taskId=${task.id}`, undefined, 'Deleted task cannot reallocate through project browsing');
  await denied(`project/file?projectId=${task.projectId}&taskId=${task.id}&path=report.md`, undefined, 'Deleted project preview cannot read old files');
  await denied('chat', { taskId: task.id, provider: 'studio-smoke', model: 'm1-smoke', message: 'cannot recreate' }, 'Deleted task cannot create a conversation');
  await denied(previewRoute(task.id), undefined, 'Deleted task cannot be previewed again');
  await assert.rejects(lstat(workspace(task.id)), /ENOENT/, 'Workspace must be removed, never recreated empty');
  for (const id of chats) {
    await denied(`chat?id=${id}`, undefined, 'Deleted chat cannot be read');
    await denied(`chat/stream?id=${id}`, undefined, 'Deleted chat cannot reconnect to an SSE stream');
    await denied(`chat/temp?id=${id}`, undefined, 'Deleted chat scratch cannot be listed');
    await denied(`chat/temp/file?id=${id}&path=proof.txt`, undefined, 'Deleted chat scratch cannot be read');
    await denied('chat/temp/file', { id, path: 'proof.txt', content: 'cannot recreate' }, 'Deleted chat scratch cannot be written');
    assert.deepEqual(await sessionPaths(id), [], 'Every deleted chat native session directory must be removed');
  }
  const status = await app.json('status'), bindings = JSON.parse(await readFile(join(data, 'chats.json'), 'utf8'));
  assert.ok(status.chats.every(row => row.taskId !== task.id && !chats.includes(row.id)), 'Live bindings must forget deleted chats');
  assert.ok(bindings.every(row => row.taskId !== task.id && !chats.includes(row.id)), 'Stored bindings must forget deleted chats');
  assert.deepEqual(rows('tasks', 'WHERE id=?', [task.id]), []);
  assert.deepEqual(rows('dependencies', 'WHERE source=? OR target=?', [task.id, task.id]), []);
  assert.deepEqual(rows('snapshots', 'WHERE task_id=?', [task.id]), []);
  assert.deepEqual(rows('reviews', 'WHERE task_id=?', [task.id]), []);
  assert.deepEqual(rows('deletion_jobs', 'WHERE task_id=?', [task.id]), [], 'Finished deletion must not leave a tombstone or job history');
  for (const id of snapshots) {
    await assert.rejects(lstat(snapshotDirectory(id)), /ENOENT/, 'Every target snapshot directory must be removed');
    await denied(`snapshot?taskId=${task.id}&id=${id}`, undefined, 'Deleted snapshots cannot be read');
  }
}
/** Relax only real directories belonging to this isolated disposable fixture. */
async function release(path) {
  await chmod(path, 0o700);
  for (const row of await readdir(path, { withFileTypes: true })) if (row.isDirectory() && !row.isSymbolicLink()) await release(join(path, row.name));
}

try {
  app = await startApp(home);
  const project = await app.json('projects', { title: '永久删除验收（隔离受控数据）' });
  const otherProject = await app.json('projects', { title: '必须保留的其他项目（隔离受控数据）' });
  const protectedParent = await app.json('task', { projectId: project.id, ...spec('仍有真实子任务的父节点') });
  const protectedChild = await app.json('task', { projectId: project.id, parentId: protectedParent.id, ...spec('普通子任务') });
  const archivedParent = await app.json('task', { projectId: project.id, ...spec('仍有归档子任务的父节点') });
  const archivedChild = await app.json('task', { projectId: project.id, parentId: archivedParent.id, ...spec('归档子任务') });
  const folder = await app.json('task', { projectId: project.id, ...spec('固定子任务结果的父目录') });
  const target = await app.json('task', { projectId: project.id, parentId: folder.id, ...spec('即将删除的已完成齿轮') });
  const direct = await app.json('task', { projectId: project.id, parentId: folder.id, ...spec('直接依赖齿轮的轴承') });
  const indirect = await app.json('task', { projectId: project.id, parentId: folder.id, ...spec('间接依赖齿轮的寿命报告') });
  const neighbor = await app.json('task', { projectId: project.id, ...spec('不受删除影响的相邻任务') });
  const running = await app.json('task', { projectId: project.id, ...spec('可删除的正在执行叶节点') });
  const foreign = await app.json('task', { projectId: otherProject.id, ...spec('不能删除的其他项目工作空间') });
  await dependencies(direct.id, [target.id]); await dependencies(indirect.id, [direct.id]);

  const projectChat = await chat({ projectId: project.id });
  await app.json('chat/temp/file', { id: projectChat.id, path: 'proof.txt', content: 'keep project planning temp' });
  const foreignChat = await chat({ taskId: foreign.id });
  await app.json('chat/temp/file', { id: foreignChat.id, path: 'proof.txt', content: 'keep other project chat temp' });
  await complete(foreign.id, 'keep foreign report');
  await complete(neighbor.id, 'keep neighboring report');
  const firstChat = await chat({ taskId: target.id });
  const secondChat = await chat({ taskId: target.id });
  await app.json('chat/temp/file', { id: firstChat.id, path: 'proof.txt', content: 'delete first private chat temp' });
  await app.json('chat/temp/file', { id: secondChat.id, path: 'proof.txt', content: 'delete second private chat temp' });
  const firstResult = await complete(target.id, 'delete target historical report v1');
  await action(target.id, 'resume');
  await app.json('file', { taskId: target.id, path: 'report.md', content: 'delete target historical report v2' });
  await confirmLeaf(target.id);
  const completedTarget = await app.json(`task?id=${target.id}`);
  await complete(direct.id, 'preserve direct downstream historical report');
  await complete(indirect.id, 'preserve indirect downstream historical report');
  assert.notEqual((await app.json(`task?id=${folder.id}`)).state, 'completed', 'Child completion cannot create an automatic parent summary');
  await confirmFolder(folder.id);
  assert.equal((await app.json(`task?id=${folder.id}`)).state, 'completed');
  const targetSnapshots = [firstResult.completedId, completedTarget.completedId];
  assert.equal(new Set(targetSnapshots).size, 2, 'The target must have multiple immutable historical snapshots');

  // Offline controlled fixtures model historical data without exposing a new
  // production archive/review API or mutating a live domain service's cache.
  await stopApp(app.child); app = undefined;
  database(db => {
    const archived = JSON.parse(String(db.prepare('SELECT value FROM tasks WHERE id=?').get(archivedChild.id).value));
    archived.archived = true; archived.revision++;
    db.prepare('UPDATE tasks SET value=? WHERE id=?').run(JSON.stringify(archived), archived.id);
    for (const task of [target, neighbor]) {
      const stored = JSON.parse(String(db.prepare('SELECT value FROM tasks WHERE id=?').get(task.id).value));
      const review = { id: `r-${randomUUID()}`, taskId: task.id, snapshotId: stored.completedId, action: 'accept',
        reason: '仅为删除测试保留的合法历史复核记录', actor: 'controlled-fixture', inputs: [], createdAt: new Date().toISOString() };
      db.prepare('INSERT INTO reviews VALUES(?,?,?)').run(review.id, review.taskId, JSON.stringify(review));
    }
  }, false);
  // Simulate a crash after native session/scratch persistence but before the
  // Studio binding was saved. Public persistence metadata must still identify
  // and purge this task-owned orphan without deleting another owner's session.
  const bindingPath = join(data, 'chats.json');
  const savedBindings = JSON.parse(await readFile(bindingPath, 'utf8'));
  assert.equal(savedBindings.filter(row => row.id === secondChat.id).length, 1);
  await writeFile(bindingPath, JSON.stringify(savedBindings.filter(row => row.id !== secondChat.id)) + '\n', { mode: 0o600 });
  app = await startApp(home);
  assert.ok((await app.json('status')).chats.every(row => row.id !== secondChat.id), 'The orphan fixture must have no Studio binding');
  assert.ok((await sessionPaths(secondChat.id)).length > 0, 'The orphan fixture must retain a native disk session');
  assert.equal(await readFile(join(workspace(target.id), '.chat-tmp', secondChat.id, 'proof.txt'), 'utf8'), 'delete second private chat temp');
  assert.equal((await app.json(`task?id=${archivedChild.id}`)).archived, true);
  assert.equal((await app.json(`task?id=${archivedParent.id}`)).childCount, 1);
  for (const task of [protectedParent, archivedParent]) {
    const before = await checkpoint(project.id, [task.id, protectedChild.id, archivedChild.id, target.id]);
    await denied(previewRoute(task.id), undefined, 'A parent with any real child cannot be previewed for deletion');
    const current = await app.json(`task?id=${task.id}`), graph = await app.json(`graph?projectId=${project.id}`);
    await denied('task/delete', { id: task.id, revision: current.revision, projectRevision: graph.project.revision, confirm: true }, 'A parent with any real child cannot be deleted');
    assert.deepEqual(await checkpoint(project.id, [task.id, protectedChild.id, archivedChild.id, target.id]), before, 'Rejected non-leaf deletion must have zero state or filesystem effects');
  }

  assert.equal((await fetch(`${app.base}/api/studio/${previewRoute(target.id)}`)).status, 200);
  assert.equal((await fetch(`${app.base}/api/studio/task/delete`, { method: 'POST', headers: { 'content-type': 'application/json', origin: app.base }, body: JSON.stringify({ id: target.id, confirm: true }) })).status, 400, 'Anonymous deletion still requires current task and project revisions');
  const deletion = await preview(target.id);
  assert.equal(deletion.taskId, target.id); assert.equal(deletion.projectId, project.id); assert.equal(deletion.workspace, true);
  assert.equal(deletion.snapshotCount, 2); assert.equal(deletion.reviewCount, 1); assert.equal(deletion.retry, false);
  assert.ok(deletion.affected.some(row => row.id === direct.id && row.reason === 'dependency'));
  assert.ok(deletion.affected.some(row => row.id === indirect.id && row.reason === 'dependency'));
  assert.ok(deletion.affected.some(row => row.id === folder.id && row.reason === 'summary'));
  assert.ok(!deletion.affected.some(row => [neighbor.id, foreign.id, protectedParent.id].includes(row.id)));
  const beforeRefusal = await checkpoint(project.id, [target.id, direct.id, indirect.id, neighbor.id]);
  for (const changes of [{ confirm: undefined }, { confirm: false }, { confirm: 'true' }, { confirm: 1 }, { revision: String(deletion.taskRevision) }, { revision: deletion.taskRevision - 1 }, { projectRevision: deletion.projectRevision - 1 }, { projectRevision: String(deletion.projectRevision) }, { extra: 'must not be accepted' }]) {
    await denied('task/delete', { ...args(deletion), ...changes }, 'Deletion requires exact boolean confirmation and fresh revisions');
    assert.deepEqual(await checkpoint(project.id, [target.id, direct.id, indirect.id, neighbor.id]), beforeRefusal, 'Rejected deletion cannot stop chats, modify records or remove files');
  }
  const staleProjectPreview = await preview(target.id);
  const late = await app.json('task', { projectId: project.id, ...spec('使预览失效但应保留的新任务') });
  const beforeStaleProject = await checkpoint(project.id, [target.id, late.id]);
  await denied('task/delete', args(staleProjectPreview), 'A real graph update requires a new confirmation preview');
  assert.deepEqual(await checkpoint(project.id, [target.id, late.id]), beforeStaleProject);
  const staleTaskPreview = await preview(running.id);
  await action(running.id, 'start');
  const beforeStaleTask = await checkpoint(project.id, [running.id, target.id]);
  await denied('task/delete', args(staleTaskPreview), 'A real lifecycle update invalidates the old task revision');
  assert.deepEqual(await checkpoint(project.id, [running.id, target.id]), beforeStaleTask);

  const identities = new Map((await app.json(`graph?projectId=${project.id}`)).tasks.filter(row => row.id !== target.id).map(row => [row.id, [row.code, row.rank]]));
  const keepSnapshots = [];
  for (const task of [direct, indirect, folder, neighbor, foreign]) {
    const current = await app.json(`task?id=${task.id}`), id = current.completedId;
    keepSnapshots.push({ taskId: task.id, id, value: await app.json(`snapshot?taskId=${task.id}&id=${id}`), disk: await diskTree(snapshotDirectory(id)) });
  }
  const preserved = {
    neighbor: await diskTree(workspace(neighbor.id)), foreign: await diskTree(workspace(foreign.id)),
    direct: await diskTree(workspace(direct.id)), indirect: await diskTree(workspace(indirect.id)),
    otherGraph: await app.json(`graph?projectId=${otherProject.id}`),
    projectChat: await app.json(`chat?id=${projectChat.id}`), foreignChat: await app.json(`chat?id=${foreignChat.id}`),
    projectTemp: await app.json(`chat/temp/file?id=${projectChat.id}&path=proof.txt`), foreignTemp: await app.json(`chat/temp/file?id=${foreignChat.id}&path=proof.txt`),
  };
  async function assertPreservedSnapshot(value) {
    const current = await app.json(`snapshot?taskId=${value.taskId}&id=${value.id}`);
    assert.deepEqual(current.snapshot, value.value.snapshot, 'Surviving historical snapshot records must not be rewritten');
    assert.deepEqual(current.reviews, value.value.reviews, 'Surviving historical review records must not be rewritten');
    if ([direct.id, indirect.id, folder.id].includes(value.taskId)) {
      assert.ok(current.unavailableRefs.some(ref => ref.taskId === target.id && targetSnapshots.includes(ref.snapshotId)), 'Historical views must declare deleted input references unavailable');
    } else assert.deepEqual(current.unavailableRefs, []);
  }
  for (const id of [firstChat.id, secondChat.id]) assert.ok((await sessionPaths(id)).length > 0, 'Target chat fixture must contain a real native disk session');
  const result = await app.json('task/delete', args(await preview(target.id)));
  assert.equal(result.taskId, target.id); assert.equal(result.projectId, project.id);
  await assertGone(target, [firstChat.id, secondChat.id], targetSnapshots);
  for (const task of [direct, indirect, folder]) {
    const current = await app.json(`task?id=${task.id}`);
    assert.equal(current.state, 'recheck', 'Deleting a predecessor revokes the validity of a completed result without discarding its history');
    assert.equal(current.dependencyRepairRequired, true);
    assert.ok(current.blockers.length, 'Missing results must block execution until explicit human repair');
    assert.equal(current.writable, false); assert.equal(current.canDiscuss, false);
    await denied('task/action', { id: task.id, revision: current.revision, action: 'start' }, 'Deletion cannot silently release downstream work');
    await denied('file', { taskId: task.id, path: 'report.md', content: 'must stay blocked' }, 'Affected workspaces remain unwritable');
  }
  assert.deepEqual(await diskTree(workspace(neighbor.id)), preserved.neighbor);
  assert.deepEqual(await diskTree(workspace(foreign.id)), preserved.foreign);
  assert.deepEqual(await diskTree(workspace(direct.id)), preserved.direct, 'Invalidation cannot delete a downstream task workspace');
  assert.deepEqual(await diskTree(workspace(indirect.id)), preserved.indirect, 'Invalidation cannot delete an indirect downstream workspace');
  assert.deepEqual(await app.json(`graph?projectId=${otherProject.id}`), preserved.otherGraph);
  assert.deepEqual(await app.json(`chat?id=${projectChat.id}`), preserved.projectChat);
  assert.deepEqual(await app.json(`chat?id=${foreignChat.id}`), preserved.foreignChat);
  assert.deepEqual(await app.json(`chat/temp/file?id=${projectChat.id}&path=proof.txt`), preserved.projectTemp);
  assert.deepEqual(await app.json(`chat/temp/file?id=${foreignChat.id}&path=proof.txt`), preserved.foreignTemp);
  for (const value of keepSnapshots) {
    await assertPreservedSnapshot(value);
    assert.deepEqual(await diskTree(snapshotDirectory(value.id)), value.disk, 'Surviving immutable snapshot bytes must be retained');
  }
  for (const row of (await app.json(`graph?projectId=${project.id}`)).tasks) assert.deepEqual([row.code, row.rank], identities.get(row.id), 'Surviving IDs and creation ranks remain stable');

  // A live controlled adapter sleeps before its first tool call. Deletion must
  // cancel and drain it, then remove its session and scratch before replying.
  const live = await chat({ taskId: running.id }, '[slow] 删除期间不允许迟到写入');
  const liveDeadline = Date.now() + 3000;
  while (Date.now() < liveDeadline && (await app.json(`chat?id=${live.id}`)).status !== 'running') await delay(25);
  assert.equal((await app.json(`chat?id=${live.id}`)).status, 'running');
  await app.json('chat/temp/file', { id: live.id, path: 'proof.txt', content: 'delete running conversation scratch' });
  const runningDeletion = await preview(running.id);
  assert.equal(runningDeletion.state, 'working'); assert.deepEqual(runningDeletion.affected, []);
  await app.json('task/delete', args(runningDeletion));
  await assertGone(running, [live.id], []);
  await delay(100); // Observe any improperly retained asynchronous continuation.
  await assert.rejects(lstat(workspace(running.id)), /ENOENT/);

  await stopApp(app.child); app = await startApp(home);
  await assertGone(target, [firstChat.id, secondChat.id], targetSnapshots);
  await assertGone(running, [live.id], []);
  assert.deepEqual(rows('deletion_jobs'), []);
  for (const task of [direct, indirect, folder]) {
    const current = await app.json(`task?id=${task.id}`);
    assert.equal(current.state, 'recheck', 'Completed consumers and ancestor summaries must remain pending human review after restart');
    assert.equal(current.dependencyRepairRequired, true, 'Missing dependency marker survives restart');
    assert.equal(current.writable, false); assert.equal(current.canDiscuss, false);
  }
  for (const value of keepSnapshots) await assertPreservedSnapshot(value);
  assert.deepEqual((await app.json(`chat?id=${projectChat.id}`)).events, preserved.projectChat.events);
  assert.deepEqual((await app.json(`chat?id=${foreignChat.id}`)).events, preserved.foreignChat.events);
  const directory = await app.json('directory');
  assert.ok(directory.every(row => ![target.id, running.id].includes(row.id)));
  for (const row of directory.filter(row => row.projectId === project.id)) assert.deepEqual([row.code, row.rank], identities.get(row.id));

  // Removing an edge during deletion must not count as a repair. Setting the
  // same remaining dependency list explicitly is the human repair operation.
  await dependencies(direct.id, []);
  assert.equal((await app.json(`task?id=${direct.id}`)).dependencyRepairRequired, true, 'A repaired child remains blocked until its invalidated parent summary is explicitly repaired');
  assert.equal((await app.json(`task?id=${folder.id}`)).dependencyRepairRequired, true, 'Repairing a predecessor does not silently approve an old parent summary');
  await dependencies(folder.id, []);
  assert.equal((await app.json(`task?id=${folder.id}`)).dependencyRepairRequired, undefined);
  for (const task of [direct, indirect]) assert.equal((await app.json(`task?id=${task.id}`)).dependencyRepairRequired, undefined, 'Explicit parent summary repair clears the inherited missing-result marker');
  // Completed results are reviewed in place after explicit graph repair. A
  // recheck is a human completion confirmation, not a new start/edit action.
  const repairedDirect = await confirmLeaf(direct.id);
  assert.deepEqual(repairedDirect.inputs, []);
  const repairedIndirect = await confirmLeaf(indirect.id);
  assert.deepEqual(repairedIndirect.inputs, [{ taskId: direct.id, snapshotId: repairedDirect.completedId }]);
  assert.notEqual((await app.json(`task?id=${folder.id}`)).state, 'completed', 'Dependency repair and child completion still require a new human group confirmation');
  await confirmFolder(folder.id);
  assert.equal((await app.json(`task?id=${folder.id}`)).state, 'completed');
  for (const value of keepSnapshots) await assertPreservedSnapshot(value);
  const next = await app.json('task', { projectId: project.id, ...spec('删除后新建的任务') });
  assert.ok(next.rank > Math.max(...[...identities.values()].map(([, rank]) => rank)), 'Deleting a task must not recycle the project creation rank');
  assert.ok(![target.code, running.code].includes(next.code), 'The controlled creation must obtain a fresh unique public code');
  console.log('Task deletion verification passed: anonymous same-origin leaf-only deletion including archived-child protection; strict confirmation and real task/project revision conflicts with zero side effects; multiple chat sessions including an unbound native-session crash fixture and private temp, workspace, all target snapshot/review/dependency rows permanently removed; running Agent cancellation; surviving projects, chats, task IDs/ranks and immutable downstream/parent snapshots preserved; missing dependency blocking across restart and explicit dependency repair. Independent disposable home only; no external model or engineering software called.');
} catch (error) { console.error(error); process.exitCode = 1; }
finally { if (app) await stopApp(app.child); await release(home); await rm(home, { recursive: true, force: true }); }
