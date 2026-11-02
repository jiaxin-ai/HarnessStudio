import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { root } from './prepare.mjs';
import { startApp, stopApp } from './verify-app.mjs';

// All mutations belong to this newly allocated home, never the user preview.
// The real anonymous same-origin Studio routes run on the controlled DSH smoke profile.
await mkdir(join(root, '.studio'), { recursive: true });
const home = await mkdtemp(join(root, '.studio/dependency-review-test-'));
let app;
const digest = content => createHash('sha256').update(content).digest('hex');
const task = id => app.json(`task?id=${id}`);
const graph = projectId => app.json(`graph?projectId=${projectId}`);
const create = (projectId, title, parentId) => app.json('task/quick', { projectId, title, ...(parentId ? { parentId } : {}) });
const completion = id => app.json(`task/completion?taskId=${id}`);
const completionArgs = preview => ({ taskId: preview.taskId, revision: preview.taskRevision, workspaceVersion: preview.workspaceVersion,
  ...(preview.isFolder ? { childrenVersion: preview.childrenVersion } : {}), checkedGoalIds: preview.goals.filter(goal => !goal.system).map(goal => goal.id) });
async function complete(id, file) {
  const preview = await completion(id);
  assert.deepEqual(preview.blockers, [], 'Manual completion must use current, valid predecessor and child results');
  if (!file) return (await app.json('task/completion', { ...completionArgs(preview), confirmWithoutFiles: true })).task;
  const selected = await app.json('task/completion/files', { taskId: id, revision: preview.taskRevision, workspaceVersion: preview.workspaceVersion,
    files: [{ path: file, description: '人工复核后的受控报告' }] });
  return (await app.json('task/completion', { ...completionArgs(selected), submissionId: selected.submittedFiles.id })).task;
}
async function dependencies(id, predecessors) {
  const current = await task(id);
  return app.json('dependencies', { id, revision: current.revision, dependencies: predecessors });
}
function mutationArgs(preview, changes = {}) {
  const { kind, ...request } = preview.request;
  assert.ok(['set', 'reconnect'].includes(kind));
  return { ...request, projectRevision: preview.projectRevision, confirmImpact: true, impactVersion: preview.impactVersion, ...changes };
}
async function deny(path, body, message) {
  const response = await app.call(path, body);
  assert.equal(response.status, 400, message);
  assert.equal(typeof (await response.json()).error, 'string');
}
async function history(id) {
  const current = await task(id), result = await app.json(`snapshot?${new URLSearchParams({ taskId: id, id: current.completedId })}`);
  const directory = join(home, 'studio', 'snapshots', current.completedId);
  return { id, snapshotId: current.completedId, snapshot: result.snapshot,
    manifest: digest(await readFile(join(directory, 'manifest.json'))), files: await Promise.all(result.snapshot.files.map(async file => ({ path: file.path, hash: digest(await readFile(join(directory, 'files', file.path))) }))) };
}
async function assertHistory(value) {
  const result = await app.json(`snapshot?${new URLSearchParams({ taskId: value.id, id: value.snapshotId })}`);
  assert.deepEqual(result.snapshot, value.snapshot, 'Review must preserve the actual inputs and contents of historical results');
  const directory = join(home, 'studio', 'snapshots', value.snapshotId);
  assert.equal(digest(await readFile(join(directory, 'manifest.json'))), value.manifest);
  for (const file of value.files) assert.equal(digest(await readFile(join(directory, 'files', file.path))), file.hash);
}
async function release(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return;
  if (!info.isDirectory()) { await chmod(path, 0o600); return; }
  await chmod(path, 0o700);
  for (const name of await readdir(path)) await release(join(path, name));
}

try {
  app = await startApp(home);
  const project = await app.json('projects', { title: '已完成任务依赖复核 HTTP 验证' });
  const [a, b, c, next] = await Promise.all(['原上游', '正式设计结果', '下游装配结果', '尚未完成的新前驱'].map(title => create(project.id, title)));
  await dependencies(b.id, [a.id]); await dependencies(c.id, [b.id]);
  const metadata = await task(b.id);
  await app.json('task/metadata', { id: b.id, revision: metadata.revision, title: b.title, goal: '依据当前前驱重新核对报告', checklist: [{ text: '已核对当前输入版本' }, { text: '报告结论仍然成立' }] });
  await complete(a.id);
  await app.json('file', { taskId: b.id, path: 'report.md', content: '保留的正式报告工作文件' });
  await app.json('file', { taskId: b.id, path: 'draft.md', content: '保留但不提交的工作草稿' });
  await complete(b.id, 'report.md'); await complete(c.id);
  const originals = await Promise.all([b.id, c.id].map(history));
  const currentB = await task(b.id), request = { id: b.id, revision: currentB.revision, dependencies: [a.id, next.id] };
  const beforePreview = await graph(project.id);
  const preview = await app.json('dependencies/preview', request);
  assert.equal(preview.request.kind, 'set'); assert.equal(preview.requiresConfirmation, true);
  assert.ok(preview.impactVersion); assert.equal(preview.projectRevision, beforePreview.project.revision);
  for (const id of [b.id, c.id]) assert.ok(preview.affected.some(row => row.id === id && row.willRecheck), 'Preview explicitly lists every completed result becoming recheck');
  assert.ok(!preview.affected.some(row => row.id === a.id || row.id === next.id));
  assert.deepEqual(await graph(project.id), beforePreview, 'Preview or cancellation has no state, dependency or revision effects');
  for (const value of originals) await assertHistory(value);
  for (const route of ['dependencies/preview', 'dependencies']) {
    const crossOrigin = await fetch(`${app.base}/api/studio/${route}`, { method: 'POST', headers: { origin: 'https://untrusted.invalid', 'content-type': 'application/json' }, body: JSON.stringify(route.endsWith('preview') ? request : mutationArgs(preview)) });
    assert.equal(crossOrigin.status, 403, 'Anonymous preview and dependency confirmation still reject cross-origin requests');
  }
  await deny('dependencies', request, 'Historical dependency edits require a preview and explicit impact confirmation');
  for (const changes of [{ confirmImpact: false }, { confirmImpact: 'true' }, { impactVersion: 'forged' }, { projectRevision: preview.projectRevision - 1 }]) {
    await deny('dependencies', mutationArgs(preview, changes), 'Invalid confirmation cannot change completed results');
    assert.deepEqual(await graph(project.id), beforePreview);
  }
  await create(project.id, '使预览过期的无关任务');
  const afterConcurrentChange = await graph(project.id);
  await deny('dependencies', mutationArgs(preview), 'A graph change requires a fresh impact preview');
  assert.deepEqual(await graph(project.id), afterConcurrentChange);
  const fresh = await app.json('dependencies/preview', request);
  await app.json('dependencies', mutationArgs(fresh));
  for (const value of originals) {
    const current = await task(value.id);
    assert.equal(current.state, 'recheck'); assert.equal(current.completedId, value.snapshotId);
    await assertHistory(value);
  }
  assert.deepEqual((await task(b.id)).dependencies, [a.id, next.id]);
  assert.equal((await task(next.id)).state, 'unstarted', 'A newly attached unfinished predecessor remains unfinished');
  const blockedB = await completion(b.id), blockedC = await completion(c.id);
  assert.ok(blockedB.blockers.length); assert.ok(blockedC.blockers.length);
  await deny('task/completion', { ...completionArgs(blockedB), confirmWithoutFiles: true }, 'Recheck cannot bypass an unfinished predecessor');
  await deny('task/action', { id: b.id, revision: blockedB.taskRevision, action: 'complete' }, 'Legacy completion cannot bypass human recheck');
  const workspaceReport = await app.json(`project/file?${new URLSearchParams({ projectId: project.id, taskId: b.id, path: 'report.md' })}`);
  assert.equal(workspaceReport.content, '保留的正式报告工作文件');
  const beforeRestart = await graph(project.id);
  await stopApp(app.child); app = await startApp(home);
  assert.deepEqual(await graph(project.id), beforeRestart, 'Recheck status, old result IDs and new dependencies are durable');
  await complete(next.id);
  const ready = await completion(b.id);
  assert.deepEqual(ready.blockers, []);
  await deny('task/completion', { ...completionArgs(ready), checkedGoalIds: [], confirmWithoutFiles: true }, 'Every task goal and Checklist item must be reconfirmed');
  const revisedB = await complete(b.id, 'report.md');
  assert.notEqual(revisedB.completedId, originals[0].snapshotId);
  const revisedBSnapshot = (await app.json(`snapshot?taskId=${b.id}`)).snapshot;
  const currentInputs = await Promise.all([a.id, next.id].map(task));
  assert.deepEqual([...revisedBSnapshot.inputs].sort((left, right) => left.taskId.localeCompare(right.taskId)),
    currentInputs.map(input => ({ taskId: input.id, snapshotId: input.completedId })).sort((left, right) => left.taskId.localeCompare(right.taskId)));
  assert.equal((await task(c.id)).state, 'recheck', 'Upstream reapproval never silently reapproves downstream work');
  const revisedC = await complete(c.id);
  assert.notEqual(revisedC.completedId, originals[1].snapshotId);
  assert.deepEqual((await app.json(`snapshot?taskId=${c.id}`)).snapshot.inputs, [{ taskId: b.id, snapshotId: revisedB.completedId }]);
  for (const value of originals) await assertHistory(value);

  // Running engineering work requires a separate reset warning and a real
  // native-agent drain before an unfinished predecessor can replace its input.
  const working = await create(project.id, '进行中依赖修改'), unfinished = await create(project.id, '进行中任务的新输入');
  await dependencies(working.id, [a.id]);
  const beforeStart = await task(working.id);
  await app.json('task/action', { id: working.id, revision: beforeStart.revision, action: 'start' });
  await app.json('file', { taskId: working.id, path: 'working.md', content: '调整依赖时必须保留的进行中工作文件' });
  const runningChat = await app.json('chat', { taskId: working.id, provider: 'studio-smoke', model: 'm1-smoke', message: '[slow] 受控依赖修订期间暂停工具写入' });
  const runningDeadline = Date.now() + 3000;
  while (Date.now() < runningDeadline && (await app.json(`chat?id=${runningChat.id}`)).status !== 'running') await delay(25);
  assert.equal((await app.json(`chat?id=${runningChat.id}`)).status, 'running');
  const beforeReset = await task(working.id);
  const resetPreview = await app.json('dependencies/preview', { id: working.id, revision: beforeReset.revision, dependencies: [unfinished.id] });
  assert.equal(resetPreview.requiresConfirmation, true);
  assert.ok(resetPreview.affected.some(row => row.id === working.id && row.willResetWork && !row.willRecheck));
  await app.json('dependencies', mutationArgs(resetPreview));
  assert.equal((await task(working.id)).state, 'unstarted');
  assert.deepEqual((await task(working.id)).dependencies, [unfinished.id]);
  assert.notEqual((await app.json(`chat?id=${runningChat.id}`)).status, 'running', 'The endpoint drains active model work before replying');
  assert.ok((await completion(working.id)).blockers.length);
  assert.equal((await app.json(`project/file?${new URLSearchParams({ projectId: project.id, taskId: working.id, path: 'working.md' })}`)).content, '调整依赖时必须保留的进行中工作文件');
  await delay(100);
  await assert.rejects(lstat(join(home, 'studio', 'workspaces', working.id, 'm1-proof.txt')), /ENOENT/, 'A canceled native tool cannot write with the superseded input');

  // Nested summaries must each be independently checked after their descendants.
  const nestedProject = await app.json('projects', { title: '逐层复核汇总 HTTP 验证' });
  const outer = await create(nestedProject.id, '顶层工程汇总'), middle = await create(nestedProject.id, '中间零件组', outer.id);
  const x = await create(nestedProject.id, '原零件输入', middle.id), y = await create(nestedProject.id, '原零件设计', middle.id), z = await create(nestedProject.id, '原零件校核', middle.id);
  await dependencies(y.id, [x.id]); await dependencies(z.id, [y.id]);
  for (const id of [x.id, y.id, z.id, middle.id, outer.id]) await complete(id);
  const nestedHistory = await Promise.all([y.id, z.id, middle.id, outer.id].map(history));
  const nestedGraph = await graph(nestedProject.id);
  const reconnectRequest = { projectId: nestedProject.id, projectRevision: nestedGraph.project.revision,
    edge: { source: x.id, target: y.id }, connection: { source: x.id, target: z.id } };
  const nestedPreview = await app.json('dependencies/reconnect/preview', reconnectRequest);
  assert.equal(nestedPreview.request.kind, 'reconnect'); assert.equal(nestedPreview.requiresConfirmation, true);
  for (const id of [y.id, z.id, middle.id, outer.id]) assert.ok(nestedPreview.affected.some(row => row.id === id && row.willRecheck));
  for (const id of [middle.id, outer.id]) assert.ok(nestedPreview.affected.some(row => row.id === id && row.reason === 'summary'));
  assert.deepEqual(await graph(nestedProject.id), nestedGraph);
  await deny('dependencies/reconnect', reconnectRequest, 'Endpoint replacement involving completed targets requires impact acknowledgement');
  await app.json('dependencies/reconnect', mutationArgs(nestedPreview));
  assert.deepEqual((await task(y.id)).dependencies, []); assert.deepEqual((await task(z.id)).dependencies, [y.id, x.id]);
  for (const value of nestedHistory) { assert.equal((await task(value.id)).state, 'recheck'); await assertHistory(value); }
  const prematureOuter = await completion(outer.id);
  assert.ok(prematureOuter.blockers.length);
  await deny('task/completion', { ...completionArgs(prematureOuter), confirmWithoutFiles: true }, 'A containing group cannot review incomplete direct children');
  await complete(y.id); await complete(z.id);
  assert.equal((await task(middle.id)).state, 'recheck'); assert.equal((await task(outer.id)).state, 'recheck');
  assert.ok((await completion(outer.id)).blockers.length, 'Completed terminal leaves do not replace manual intermediate-group review');
  await complete(middle.id); assert.equal((await task(outer.id)).state, 'recheck'); await complete(outer.id);
  for (const value of nestedHistory) { assert.notEqual((await task(value.id)).completedId, value.snapshotId); await assertHistory(value); }
  await stopApp(app.child); app = await startApp(home);
  for (const id of [b.id, c.id, y.id, z.id, middle.id, outer.id]) assert.equal((await task(id)).state, 'completed');
  for (const value of [...originals, ...nestedHistory]) await assertHistory(value);
  console.log('Dependency review HTTP checks passed: anonymous same-origin read-only impact preview, explicit confirmation and stale/forged rejection; completed target linked to unfinished predecessor; durable recheck propagation; old files and snapshots retained; goal/file acknowledgements and ordered downstream/intermediate-group human review; confirmed working-input reset with real native-agent cancellation; atomic endpoint replacement and restart. Only an independent disposable home and controlled Provider fixture were used, with no external model or engineering software.');
} finally {
  if (app) await stopApp(app.child);
  await release(home); await rm(home, { recursive: true, force: true });
}
