import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, symlink, unlink, chmod, readdir, lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { root } from './prepare.mjs';
import { startApp, stopApp } from './verify-app.mjs';

// Every filesystem fixture lives in this newly allocated home. This script never
// writes to the user's preview home and never starts an external model.
await mkdir(join(root, '.studio'), { recursive: true });
const home = await mkdtemp(join(root, '.studio/project-files-test-'));
let app;
const maxPreviewBytes = 262144; // The product's composed maxFileBytes setting.
const spec = title => ({ title, kind: 'task', goal: '核对受控文件浏览证据，不涉及真实工程参数',
  criteria: [{ id: 'proof', label: '文件检查', kind: 'check', method: '读取报告中的受控标记' }], outputs: ['report.md'], unresolved: [] });
const query = (route, projectId, taskId, path = '', extra = {}) => `${route}?${new URLSearchParams({ projectId, taskId, path, ...extra })}`;
const listQuery = (projectId, taskId, path = '', extra) => query('project/files', projectId, taskId, path, extra);
const fileQuery = (projectId, taskId, path) => query('project/file', projectId, taskId, path);
const workspace = id => join(home, 'studio', 'workspaces', id);

async function action(id, operation, extra = {}) {
  const task = await app.json(`task?id=${id}`);
  return app.json('task/action', { id, revision: task.revision, action: operation, ...extra });
}
async function denied(path, label) {
  const response = await app.call(path), value = await response.json();
  assert.equal(response.status, 400, `${label}: ${JSON.stringify(value)}`);
  assert.equal(typeof value.error, 'string');
}
function textPreview(value, projectId, taskId, path, content) {
  assert.equal(value.projectId, projectId); assert.equal(value.taskId, taskId); assert.equal(value.path, path);
  assert.equal(value.status, 'text'); assert.equal(value.content, content);
  assert.equal(value.bytes, Buffer.byteLength(content));
  assert.equal(value.version, createHash('sha256').update(content).digest('hex'));
}
function unavailablePreview(value, status, bytes) {
  assert.equal(value.status, status); assert.equal(value.bytes, bytes);
  assert.equal(Object.hasOwn(value, 'content'), false, 'Unsupported previews must not emit replacement characters or partial binary content');
  assert.equal(Object.hasOwn(value, 'version'), false, 'A refused preview must not imply it read or hashed the entire file');
}
/** Relax only this owned fixture's real directories, including frozen results. */
async function release(path) {
  await chmod(path, 0o700);
  for (const row of await readdir(path, { withFileTypes: true })) if (row.isDirectory() && !row.isSymbolicLink()) await release(join(path, row.name));
}

try {
  app = await startApp(home);
  const project = await app.json('projects', { title: '项目全部任务文件树（受控测试）' });
  const otherProject = await app.json('projects', { title: '不应跨越的项目（受控测试）' });
  const parent = await app.json('task', { projectId: project.id, ...spec('齿轮传动任务目录') });
  const first = await app.json('task', { projectId: project.id, ...spec('驱动齿轮报告') });
  const second = await app.json('task', { projectId: project.id, ...spec('支承轴承报告') });
  const nested = await app.json('task', { projectId: project.id, parentId: parent.id, ...spec('嵌套任务尺寸报告') });
  const unallocated = await app.json('task', { projectId: project.id, ...spec('尚未打开的草稿工作空间') });
  const empty = await app.json('task/quick', { projectId: project.id, title: '已分配目录但尚无文件的任务' });
  const foreign = await app.json('task', { projectId: otherProject.id, ...spec('其他项目的私有文件') });
  const group = await app.json('task', { projectId: project.id, title: '旧版任务组', kind: 'group' });

  assert.equal((await fetch(`${app.base}/api/studio/${query('project/files', project.id, first.id, '')}`)).status, 200, 'A project directory is readable without a browser Cookie');
  for (const route of ['project/files', 'project/file']) {
    const path = query(route, project.id, first.id, 'report.md');
    assert.equal((await fetch(`${app.base}/api/studio/${path}`)).status, 400, `${route} is anonymous but still validates a missing directory or file`);
    await denied(query(route, otherProject.id, first.id, 'report.md'), 'Project identity cannot be used to read another project’s task');
    await denied(query(route, project.id, foreign.id, 'report.md'), 'Task identity cannot bypass project ownership');
    await denied(query(route, project.id, 't-missing', 'report.md'), 'Unknown task');
    await denied(query(route, 'p-missing', first.id, 'report.md'), 'Unknown project');
    await denied(query(route, project.id, group.id, 'report.md'), 'Non-workspace task groups');
  }

  const beforeEmptyReads = await app.json(`graph?projectId=${project.id}`);
  await assert.rejects(lstat(workspace(unallocated.id)), /ENOENT/);
  const unallocatedRoot = await app.json(listQuery(project.id, unallocated.id));
  assert.equal(unallocatedRoot.path, ''); assert.deepEqual(unallocatedRoot.entries, []); assert.equal(unallocatedRoot.total, 0);
  assert.equal(unallocatedRoot.offset, 0); assert.equal(unallocatedRoot.limit, 100); assert.equal(unallocatedRoot.nextOffset, undefined);
  await denied(listQuery(project.id, unallocated.id, 'missing'), 'Missing directory');
  await denied(fileQuery(project.id, unallocated.id, 'report.md'), 'Unallocated file');
  await assert.rejects(lstat(workspace(unallocated.id)), /ENOENT/, 'Browsing a draft must not allocate its workspace');
  const emptyRoot = await app.json(listQuery(project.id, empty.id, '', { limit: 1 }));
  assert.deepEqual(emptyRoot.entries, []); assert.equal(emptyRoot.total, 0); assert.equal(emptyRoot.limit, 1);
  assert.deepEqual(await app.json(`graph?projectId=${project.id}`), beforeEmptyReads, 'Empty-directory reads cannot change task states or graph revisions');

  for (const task of [first, second, nested]) await action(task.id, 'start');
  const firstContent = '驱动齿轮受控报告\n齿宽：仅演示文件浏览，不代表工程参数。\n';
  const secondContent = '支承轴承受控报告\n同名文件只属于轴承任务。\n';
  const nestedContent = '嵌套任务真实工作空间的尺寸报告。';
  const written = new Map([
    ['report.md', firstContent], ['a-file.txt', 'first alphabetic file'], ['b-file.txt', 'second alphabetic file'], ['zero.txt', ''],
    ['alpha/a.md', 'alpha directory'], ['notes/gear/尺寸.md', '中文目录中的 UTF-8 内容'], ['zeta/z.md', 'zeta directory'],
  ]);
  for (const [path, content] of written) await app.json('file', { taskId: first.id, path, content });
  await app.json('file', { taskId: second.id, path: 'report.md', content: secondContent });
  await app.json('file', { taskId: nested.id, path: 'report.md', content: nestedContent });
  const binary = Buffer.from([0x44, 0x53, 0x48, 0x00, 0xff]), invalidUTF8 = Buffer.from([0xc3, 0x28]);
  await writeFile(join(workspace(first.id), 'cad.bin'), binary);
  await writeFile(join(workspace(first.id), 'invalid.txt'), invalidUTF8);
  await writeFile(join(workspace(first.id), 'large.txt'), Buffer.alloc(maxPreviewBytes + 1, 0x61));
  for (const name of ['.chat-tmp', '.CHAT-TMP']) {
    await mkdir(join(workspace(first.id), name), { recursive: true });
    await writeFile(join(workspace(first.id), name, 'private-chat.txt'), 'private content must never appear in project file browsing');
  }

  const beforeReads = await app.json(`graph?projectId=${project.id}`), otherBeforeReads = await app.json(`graph?projectId=${otherProject.id}`);
  const firstRoot = await app.json(listQuery(project.id, first.id));
  const expectedNames = ['alpha', 'notes', 'zeta', 'a-file.txt', 'b-file.txt', 'cad.bin', 'invalid.txt', 'large.txt', 'report.md', 'zero.txt'];
  assert.equal(firstRoot.projectId, project.id); assert.equal(firstRoot.taskId, first.id); assert.equal(firstRoot.path, '');
  assert.deepEqual(firstRoot.entries.map(row => row.name), expectedNames, 'Directories must appear first, followed by consistently name-sorted files');
  assert.equal(firstRoot.total, expectedNames.length); assert.equal(firstRoot.nextOffset, undefined);
  for (const [index, entry] of firstRoot.entries.entries()) {
    assert.equal(entry.path, entry.name); assert.equal(entry.kind, index < 3 ? 'directory' : 'file');
    assert.ok(Number.isFinite(Date.parse(entry.modifiedAt)), 'Directory and file metadata must include a parseable modification time');
    if (entry.kind === 'file') assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0);
  }
  assert.ok(!JSON.stringify(firstRoot).toLowerCase().includes('.chat-tmp'), 'Private per-chat scratch must be omitted from the public tree');
  const pagedNames = [];
  for (let offset = 0; offset < expectedNames.length; offset += 3) {
    const page = await app.json(listQuery(project.id, first.id, '', { offset, limit: 3 }));
    assert.equal(page.offset, offset); assert.equal(page.limit, 3); assert.equal(page.total, expectedNames.length);
    assert.equal(page.nextOffset, offset + page.entries.length < expectedNames.length ? offset + page.entries.length : undefined);
    pagedNames.push(...page.entries.map(row => row.name));
  }
  assert.deepEqual(pagedNames, expectedNames, 'Pagination must not skip or repeat entries');
  assert.deepEqual((await app.json(listQuery(project.id, first.id, '', { offset: 100, limit: 3 }))).entries, []);
  for (const extra of [{ offset: '-1' }, { offset: '1.5' }, { offset: 'NaN' }, { limit: '0' }, { limit: '201' }, { limit: '1.5' }]) await denied(listQuery(project.id, first.id, '', extra), 'Invalid directory pagination');
  const notes = await app.json(listQuery(project.id, first.id, 'notes'));
  assert.deepEqual(notes.entries.map(({ name, path, kind }) => ({ name, path, kind })), [{ name: 'gear', path: 'notes/gear', kind: 'directory' }]);
  const gear = await app.json(listQuery(project.id, first.id, 'notes/gear'));
  assert.deepEqual(gear.entries.map(({ name, path, kind }) => ({ name, path, kind })), [{ name: '尺寸.md', path: 'notes/gear/尺寸.md', kind: 'file' }]);
  await denied(listQuery(project.id, first.id, 'report.md'), 'Files cannot be listed as directories');
  await denied(fileQuery(project.id, first.id, 'notes'), 'Directories cannot be previewed as files');
  await denied(listQuery(project.id, first.id, 'new-directory'), 'Reads cannot create missing directories');
  await assert.rejects(lstat(join(workspace(first.id), 'new-directory')), /ENOENT/);
  for (const [path, content] of written) textPreview(await app.json(fileQuery(project.id, first.id, path)), project.id, first.id, path, content);
  textPreview(await app.json(fileQuery(project.id, second.id, 'report.md')), project.id, second.id, 'report.md', secondContent);
  textPreview(await app.json(fileQuery(project.id, nested.id, 'report.md')), project.id, nested.id, 'report.md', nestedContent);
  unavailablePreview(await app.json(fileQuery(project.id, first.id, 'cad.bin')), 'binary', binary.length);
  unavailablePreview(await app.json(fileQuery(project.id, first.id, 'invalid.txt')), 'binary', invalidUTF8.length);
  unavailablePreview(await app.json(fileQuery(project.id, first.id, 'large.txt')), 'tooLarge', maxPreviewBytes + 1);
  for (const path of ['..', '../report.md', '/private/report.md', '..\\report.md', 'notes/../report.md', 'notes//gear', './report.md', 'notes/\0secret', '.chat-tmp', '.chat-tmp/private-chat.txt', '.CHAT-TMP/private-chat.txt']) {
    await denied(listQuery(project.id, first.id, path), 'Unsafe or private directory path');
    await denied(fileQuery(project.id, first.id, path), 'Unsafe or private file path');
  }

  const outside = join(home, 'outside-target');
  await mkdir(outside); await writeFile(join(outside, 'secret.txt'), 'outside the task capability');
  const fileLink = join(workspace(first.id), 'linked.txt'), directoryLink = join(workspace(first.id), 'linked-directory');
  await symlink(join(outside, 'secret.txt'), fileLink); await symlink(outside, directoryLink);
  await denied(listQuery(project.id, first.id), 'Root listing rejects symbolic links instead of exposing linked entries');
  await denied(fileQuery(project.id, first.id, 'linked.txt'), 'Linked files');
  await denied(listQuery(project.id, first.id, 'linked-directory'), 'Linked directories');
  await denied(fileQuery(project.id, first.id, 'linked-directory/secret.txt'), 'Traversal through a linked directory');
  await unlink(fileLink); await unlink(directoryLink);
  await symlink(outside, join(workspace(first.id), '.chat-tmp', 'private-linked-directory'));
  assert.deepEqual((await app.json(listQuery(project.id, first.id))).entries.map(row => row.name), expectedNames, 'Private scratch internals must not be traversed while listing ordinary task files');
  assert.deepEqual(await app.json(`graph?projectId=${project.id}`), beforeReads, 'Directory queries, previews and rejected paths cannot mutate graph state');
  assert.deepEqual(await app.json(`graph?projectId=${otherProject.id}`), otherBeforeReads);

  await action(first.id, 'complete', { measurements: [{ criterionId: 'proof', observed: true, evidence: 'report.md', note: '受控报告已核对' }] });
  const completed = await app.json(`task?id=${first.id}`);
  assert.equal(completed.state, 'completed'); assert.ok(completed.completedId);
  assert.equal(completed.writable, false, 'Completed workspaces revoke ordinary task artifact writes');
  assert.equal((await lstat(join(home, 'studio', 'snapshots', completed.completedId))).mode & 0o222, 0, 'The captured result directory remains physically immutable');
  const frozenGraph = await app.json(`graph?projectId=${project.id}`), frozenSnapshot = await app.json(`snapshot?taskId=${first.id}&id=${completed.completedId}`);
  assert.ok(frozenSnapshot.snapshot.files.some(row => row.path === 'notes/gear/尺寸.md'));
  assert.ok(frozenSnapshot.snapshot.files.every(row => !row.path.toLowerCase().startsWith('.chat-tmp/')));
  assert.deepEqual((await app.json(listQuery(project.id, first.id))).entries.map(row => row.name), expectedNames);
  textPreview(await app.json(fileQuery(project.id, first.id, 'report.md')), project.id, first.id, 'report.md', firstContent);
  textPreview(await app.json(fileQuery(project.id, first.id, 'notes/gear/尺寸.md')), project.id, first.id, 'notes/gear/尺寸.md', written.get('notes/gear/尺寸.md'));
  unavailablePreview(await app.json(fileQuery(project.id, first.id, 'cad.bin')), 'binary', binary.length);
  unavailablePreview(await app.json(fileQuery(project.id, first.id, 'large.txt')), 'tooLarge', maxPreviewBytes + 1);
  assert.equal((await app.call('file', { taskId: first.id, path: 'report.md', content: 'must not change a completed result' })).status, 400);
  assert.deepEqual(await app.json(`graph?projectId=${project.id}`), frozenGraph, 'Browsing a completed result cannot reopen its workspace');
  assert.deepEqual(await app.json(`snapshot?taskId=${first.id}&id=${completed.completedId}`), frozenSnapshot, 'Project browsing must preserve immutable snapshot content and review records');
  console.log('Project file browsing verification passed: anonymous same-origin project/task ownership, flat task scopes including nested tasks, real directory trees and stable pagination, unallocated drafts without side effects, UTF-8 and same-name task isolation, binary/oversize preview statuses, private scratch and symlink denial, frozen completed workspace browsing, unchanged graph revisions and immutable snapshots. No external model or engineering software called.');
} catch (error) { console.error(error); process.exitCode = 1; }
finally { if (app) await stopApp(app.child); await release(home); await rm(home, { recursive: true, force: true }); }
