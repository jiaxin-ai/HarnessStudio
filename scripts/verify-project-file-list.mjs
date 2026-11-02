import assert from 'node:assert/strict';
import { mkdir, mkdtemp, chmod, readdir, rm, writeFile, symlink, lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { root } from './prepare.mjs';
import { startApp, stopApp } from './verify-app.mjs';

await mkdir(join(root, '.studio'), { recursive: true });
const home = await mkdtemp(join(root, '.studio/project-file-list-native-'));
let app;
const model = { provider: 'studio-smoke', model: 'm1-smoke' };
const text = content => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(block => block.type === 'text').map(block => block.text).join('') : '';
const workspace = id => join(home, 'studio', 'workspaces', id);
async function release(path) { await chmod(path, 0o700); for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink()) await release(join(path, entry.name)); }
async function finished(id, turns) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { const chat = await app.json(`chat?id=${id}`); if (chat.status === 'idle' && chat.events.filter(event => event.type === 'turn/end').length > turns) return chat; await delay(60); }
  throw new Error('Project file list native turn did not settle');
}
async function probe(scope, marker, calls, existingId) {
  const before = existingId ? await app.json(`chat?id=${existingId}`) : undefined;
  const turns = before?.events.filter(event => event.type === 'turn/end').length ?? 0, sequence = before?.events.at(-1)?.seq ?? -1;
  const chat = await app.json('chat', { ...scope, ...model, ...(existingId ? { id: existingId } : {}), message: `[project-files-${marker}] ${JSON.stringify({ scope: scope.taskId ? 'task' : 'project', calls })}` });
  const history = await finished(chat.id, turns), events = history.events.filter(event => event.seq > sequence);
  const ended = events.find(event => event.type === 'turn/end'); assert.notEqual(ended?.data.reason?.kind, 'error', JSON.stringify(ended?.data.reason));
  const nativeCalls = events.filter(event => event.type === 'tool/call'); assert.deepEqual(nativeCalls.map(call => call.data.name), calls.map(call => call.name));
  const results = nativeCalls.map(call => { const event = events.find(event => event.type === 'tool/result' && event.data.message.source.callId === call.data.callId); assert.ok(event); return event.data.message; });
  assert.ok(events.some(event => event.type === 'assistant/message' && text(event.data.message.content).includes('Project file listing native schemas')));
  return { id: chat.id, history, results, values: results.map(result => result.isError ? undefined : JSON.parse(text(result.content))) };
}
const list = args => ({ name: 'studio_list_project_files', args });
const readProject = args => ({ name: 'studio_read_project_file', args });
const deleteOwn = args => ({ name: 'studio_delete_file', args });
try {
  app = await startApp(home);
  const project = await app.json('projects', { title: '原生项目文件清单验证' }), other = await app.json('projects', { title: '其他私有项目' });
  const quick = (title, projectId = project.id) => app.json('task/quick', { projectId, title });
  const source = await quick('当前对话任务'), sibling = await quick('同项目兄弟任务'), folder = await quick('有嵌套任务的目录');
  const nested = await app.json('task/quick', { projectId: project.id, title: '嵌套叶任务', parentId: folder.id });
  const draft = await app.json('task', { projectId: project.id, title: '未打开的空草稿', kind: 'task' }), foreign = await quick('不可跨越的外项目任务', other.id);
  const archived = await quick('已归档任务'), archivedChild = await app.json('task/quick', { projectId: project.id, title: '归档目录中的子任务', parentId: archived.id });
  const db = new DatabaseSync(join(home, 'studio/domain.sqlite'));
  const stored = JSON.parse(db.prepare('SELECT value FROM tasks WHERE id=?').get(archived.id).value); db.prepare('UPDATE tasks SET value=? WHERE id=?').run(JSON.stringify({ ...stored, archived: true }), archived.id); db.close();
  await app.json('file', { taskId: sibling.id, path: 'report.md', content: '兄弟任务的受控文件，list 不得返回这段内容。' });
  await app.json('file', { taskId: nested.id, path: 'notes/detail.md', content: '嵌套任务的受控细节，不授予当前任务内容读取权限。' });
  await app.json('file', { taskId: source.id, path: 'own.md', content: '当前任务自己的内容' });
  await app.json('file', { taskId: source.id, path: 'delete-me.md', content: '仅当前任务有权删除' });
  const completedDb = new DatabaseSync(join(home, 'studio/domain.sqlite'));
  const completed = JSON.parse(completedDb.prepare('SELECT value FROM tasks WHERE id=?').get(sibling.id).value);
  completedDb.prepare('UPDATE tasks SET value=? WHERE id=?').run(JSON.stringify({ ...completed, state: 'completed' }), sibling.id); completedDb.close();
  await mkdir(join(workspace(sibling.id), '.CHAT-TMP')); await writeFile(join(workspace(sibling.id), '.CHAT-TMP/private.md'), '不可列出的私有对话数据');
  const before = await app.json(`graph?projectId=${project.id}`), otherBefore = await app.json(`graph?projectId=${other.id}`);
  const calls = [list({ limit: 2 }), list({ offset: 2, limit: 2 }), list({ offset: 4, limit: 2 }), list({ taskId: sibling.id }), list({ taskId: nested.id }), list({ taskId: nested.id, path: 'notes', limit: 1 }), list({ taskId: draft.id })];
  const projectChat = await probe({ projectId: project.id }, 'project-list', calls);
  assert.ok(projectChat.results.every(result => !result.isError));
  assert.deepEqual(projectChat.values.slice(0, 3).flatMap(page => page.tasks.map(task => task.id)), [source.id, sibling.id, folder.id, nested.id, draft.id]);
  assert.equal(projectChat.values[0].nextOffset, 2); assert.equal(projectChat.values[1].nextOffset, 4); assert.equal(projectChat.values[2].nextOffset, undefined);
  assert.equal(projectChat.values[0].total, 5); assert.deepEqual(projectChat.values[3].entries.map(entry => entry.name), ['report.md']);
  assert.deepEqual(projectChat.values[5].entries.map(entry => entry.path), ['notes/detail.md']); assert.deepEqual(projectChat.values[6].entries, []);
  await assert.rejects(lstat(workspace(draft.id)), /ENOENT/);
  assert.ok(!JSON.stringify(projectChat.values).includes('受控细节')); assert.ok(!JSON.stringify(projectChat.values).toLowerCase().includes('.chat-tmp'));
  const taskChat = await probe({ taskId: source.id }, 'task-list', [list({ limit: 100 }), list({ taskId: sibling.id }), list({ taskId: nested.id, path: 'notes' }),
    readProject({ taskId: sibling.id, path: 'report.md' }), readProject({ taskId: nested.id, path: 'notes/detail.md' }), deleteOwn({ path: 'delete-me.md' })]);
  assert.ok(taskChat.results.every(result => !result.isError)); assert.deepEqual(taskChat.values[0].tasks.map(task => task.id), [source.id, sibling.id, folder.id, nested.id, draft.id]);
  assert.equal(taskChat.values[1].projectId, project.id); assert.equal(taskChat.values[2].taskId, nested.id);
  assert.deepEqual({ projectId: taskChat.values[3].projectId, taskId: taskChat.values[3].taskId, taskState: taskChat.values[3].taskState,
    source: taskChat.values[3].source, formalInput: taskChat.values[3].formalInput, status: taskChat.values[3].status, content: taskChat.values[3].content },
  { projectId: project.id, taskId: sibling.id, taskState: 'completed', source: 'task-workspace', formalInput: false, status: 'text', content: '兄弟任务的受控文件，list 不得返回这段内容。' });
  assert.match(taskChat.values[3].version, /^[0-9a-f]{64}$/); assert.equal(taskChat.values[4].content, '嵌套任务的受控细节，不授予当前任务内容读取权限。');
  assert.deepEqual(taskChat.values[5], { path: 'delete-me.md' }); await assert.rejects(lstat(join(workspace(source.id), 'delete-me.md')), /ENOENT/);
  const rejected = await probe({ taskId: source.id }, 'boundaries', [list({ projectId: other.id }), list({ path: '' }), list({ taskId: foreign.id }), list({ taskId: archived.id }), list({ taskId: archivedChild.id }), list({ taskId: nested.code }), list({ taskId: sibling.id, path: '.CHAT-TMP' }), list({ taskId: sibling.id, path: '../other' }), list({ taskId: sibling.id, path: '/etc' }), list({ limit: 101 }), list({ taskId: sibling.id, limit: 201 }), list({ offset: -1 }), list({ offset: 0.5 })], taskChat.id);
  assert.ok(rejected.results.every(result => result.isError), 'Native schemas and bound owner checks must reject all escape attempts');
  await symlink(workspace(source.id), join(workspace(sibling.id), 'linked'));
  const linked = await probe({ taskId: source.id }, 'symlink', [list({ taskId: sibling.id }), list({ taskId: sibling.id, path: 'linked' })], taskChat.id);
  assert.ok(linked.results.every(result => result.isError)); await rm(join(workspace(sibling.id), 'linked'));
  const deniedContent = await probe({ taskId: source.id }, 'content-boundaries', [{ name: 'studio_read_file', args: { path: `../${sibling.id}/report.md` } },
    readProject({ taskId: foreign.id, path: 'report.md' }), readProject({ taskId: archived.id, path: 'report.md' }), readProject({ taskId: sibling.id, path: '.chat-tmp/private.md' }),
    { name: 'studio_write_file', args: { path: `../${sibling.id}/forbidden.md`, content: '必须拒绝的跨任务写入' } }, deleteOwn({ path: `../${sibling.id}/report.md` })], taskChat.id);
  assert.ok(deniedContent.results.every(result => result.isError)); await assert.rejects(lstat(join(workspace(sibling.id), 'forbidden.md')), /ENOENT/);
  assert.equal(await readFile(join(workspace(sibling.id), 'report.md'), 'utf8'), '兄弟任务的受控文件，list 不得返回这段内容。');
  const projectContent = await probe({ projectId: project.id }, 'project-content-denied', [{ name: 'studio_read_file', args: { path: 'report.md' } },
    readProject({ taskId: sibling.id, path: 'report.md' }), { name: 'studio_write_file', args: { path: 'forbidden.md', content: '必须拒绝' } }, deleteOwn({ path: 'report.md' })], projectChat.id);
  assert.ok(projectContent.results.every(result => result.isError));
  assert.equal(await readFile(join(workspace(source.id), 'own.md'), 'utf8'), '当前任务自己的内容');
  assert.deepEqual(await app.json(`graph?projectId=${project.id}`), before, 'File list tools must not change graph states, metadata or revisions');
  assert.deepEqual(await app.json(`graph?projectId=${other.id}`), otherBefore);
  const previousEvents = (await app.json(`chat?id=${taskChat.id}`)).events;
  await stopApp(app.child); app = await startApp(home);
  assert.deepEqual((await app.json(`chat?id=${taskChat.id}`)).events, previousEvents, 'Native list call/result histories must replay exactly');
  const resumed = await probe({ taskId: source.id }, 'restart', [list({ taskId: nested.id, path: 'notes' }), readProject({ taskId: nested.id, path: 'notes/detail.md' })], taskChat.id);
  assert.equal(!!resumed.results[0].isError, false); assert.equal(resumed.values[0].entries[0].path, 'notes/detail.md');
  assert.equal(resumed.values[1].content, '嵌套任务的受控细节，不授予当前任务内容读取权限。'); assert.equal(resumed.values[1].formalInput, false);
  console.log('Project file list native verification passed: native schemas, project/task-bound lists, same-project live content reads with non-formal provenance (including a completed predecessor), own-file deletion, cross-task mutation denial, private/archive/foreign/symlink/path rejection, unchanged graph and snapshot authority, persistence/replay and resume. No external model or service called.');
} finally { if (app) await stopApp(app.child); await release(home); await rm(home, { recursive: true, force: true }); }
