// End-to-end acceptance of the no-software mode (STUDIO_SEAT_BACKEND=none, cli/设计.md §6) with the smoke model: no software
// platform, vm_manager or external model. Run it in the test image with the backend set:
//   docker run --rm --user node --tmpfs /opt/harnessstudio/.studio:uid=1000,gid=1000,exec -e STUDIO_SEAT_BACKEND=none \
//     --entrypoint node harnessstudio/studio:no-software-test scripts/verify-no-software.mjs
// It starts Studio itself with STUDIO_SEAT_BACKEND=none even when the variable is not set.
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { root } from './prepare.mjs';
import { startApp, stopApp } from './verify-app.mjs';

const model = { provider: 'studio-smoke', model: 'm1-smoke' };
/** What an Agent must not be offered or told without software. */
const VM_WORDS = /虚拟机|virtual machine|\bVMs?\b|studio_vm_|studio_software_|[DF] 盘|drive [DF]:|[DF]:\\/u;
const SOFTWARE_ROUTES = ['catalog', 'seats', 'seat', 'control', 'invoke', 'ack-unknown', 'operation', 'cancel', 'artifact', 'release', 'records', 'recorder', 'events',
  'recordings', 'recording', 'recording-file', 'recording-zip', 'progress', 'start', 'controller', 'license', 'assign', 'resources', 'jobs', 'job-cancel'];

await mkdir(join(root, '.studio'), { recursive: true });
const home = await mkdtemp(join(root, '.studio/no-software-test-'));
process.env.STUDIO_SEAT_BACKEND = 'none';
// A leftover Mock platform address must be ignored, not used.
process.env.STUDIO_SEAT_URL = 'http://127.0.0.1:9/never-called'; process.env.STUDIO_SEAT_TOKEN = 'x'.repeat(48);
let app;

const textOf = content => Array.isArray(content) ? content.filter(block => block.type === 'text').map(block => block.text).join('') : typeof content === 'string' ? content : '';
async function waitFor(read, ready, message, timeout = 60000) {
  const end = Date.now() + timeout; let value;
  while (Date.now() < end) { value = await read(); if (await ready(value)) return value; await delay(150); }
  throw new Error(`${message}\n最后一次读取：${JSON.stringify(value, null, 1)?.slice(0, 4000)}`);
}
const chat = id => app.json(`chat?id=${encodeURIComponent(id)}`);
const replies = history => history.events.filter(event => event.type === 'assistant/message').map(event => textOf(event.data.message.content));
async function send(scope, message, id) {
  const before = id ? (await chat(id)).events.filter(event => event.type === 'turn/end').length : 0;
  const sent = await app.json('chat', { ...scope, ...(id ? { id } : {}), ...model, message });
  const history = await waitFor(() => chat(sent.id), value => value.status === 'idle' && value.events.filter(event => event.type === 'turn/end').length > before, `Turn did not finish: ${message}`, 30000);
  return { id: sent.id, history };
}
/** The tools and system prompt the model received in this conversation's last request (smoke `[tool-probe]`). */
async function probe(scope, id) {
  const { id: chatId, history } = await send(scope, '[tool-probe]', id);
  const text = replies(history).findLast(row => row.startsWith('[tool-probe] '));
  assert.ok(text, `The tool probe did not answer: ${replies(history).at(-1)}`);
  return { chatId, ...JSON.parse(text.slice('[tool-probe] '.length)) };
}
function assertNoSoftware(seen, label) {
  const names = seen.tools.map(tool => tool.name);
  assert.ok(names.length > 5, `${label}: the model sees Studio's tools (${names.join(', ')})`);
  for (const name of names) assert.doesNotMatch(name, /^studio_(software|vm)_/u, `${label}: ${name} must not be offered without software`);
  for (const tool of seen.tools) assert.doesNotMatch(tool.description, VM_WORDS, `${label}: the description of ${tool.name} mentions VMs or software tools`);
  assert.match(seen.system, /这个部署没有接入工业软件/u, `${label}: the no-software prompt section is present`);
  for (const line of seen.system.split('\n')) assert.doesNotMatch(line, VM_WORDS, `${label}: the system prompt mentions VMs: ${line}`);
  assert.doesNotMatch(seen.system, /软件镜像选择与 Bridge|软件虚拟机使用约束/u, `${label}: no Mock or VM software prompt`);
}
/** Entries of the stored ZIP of a project export. */
async function exportFiles(projectId) {
  const response = await fetch(`${app.base}/api/studio/project/export?${new URLSearchParams({ projectId, workspace: '1' })}`, { headers: { origin: app.base } });
  assert.equal(response.status, 200, 'Project export must succeed');
  const zip = Buffer.from(await response.arrayBuffer()), files = new Map();
  let at = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(at + 10); at = zip.readUInt32LE(at + 16);
  for (let index = 0; index < count; index++) {
    const size = zip.readUInt32LE(at + 20), nameLength = zip.readUInt16LE(at + 28), extra = zip.readUInt16LE(at + 30), comment = zip.readUInt16LE(at + 32), local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8'), data = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    files.set(name, zip.subarray(data, data + size)); at += 46 + nameLength + extra + comment;
  }
  return files;
}
const exists = path => lstat(path).then(() => true, () => false);

try {
  app = await startApp(home);
  // ---- the backend says it has no software, and its software routes say so -------------------------------
  const status = await app.json('status');
  assert.equal(status.softwareBackend, 'none', 'GET /api/studio/status reports softwareBackend');
  for (const name of status.tools) assert.doesNotMatch(name, /^studio_(software|vm)_/u, `No software or VM tool is registered: ${name}`);
  for (const path of SOFTWARE_ROUTES) for (const method of ['GET', 'POST']) {
    const response = await app.call(`software/${path}?taskId=t-x`, method === 'POST' ? {} : undefined);
    assert.equal(response.status, 404, `${method} software/${path}`);
    const body = await response.json();
    assert.equal(body.code, 'SOFTWARE_NOT_CONFIGURED', `${method} software/${path}`); assert.match(body.error, /没有接入软件/u);
  }

  // ---- a project and a task: the model sees no software tools, files live in Studio's data folder -------
  const project = await app.json('projects', { title: '无软件模式验收' });
  const shared = await app.json(`project/shared/status?${new URLSearchParams({ projectId: project.id })}`);
  assert.equal(shared.enabled, true, 'The project shared folder exists without vm_manager'); assert.equal(shared.drive, undefined, 'No drive letter without VMs');
  await app.json('project/shared/file', { projectId: project.id, path: 'inputs/brief.md', content: '共享资料' });
  const projectChat = await probe({ projectId: project.id });
  assertNoSoftware(projectChat, 'Project conversation');
  for (const name of ['studio_list_project_shared', 'studio_read_project_shared']) assert.ok(projectChat.tools.some(tool => tool.name === name), `${name} is offered for the shared folder`);

  const task = await app.json('task/quick', { projectId: project.id, title: '写一份简报' });
  await app.json('task/metadata', { id: task.id, revision: task.revision, title: task.title, goal: '写出简报文件', checklist: [{ text: '简报文件已写出' }] });
  const taskChat = await probe({ taskId: task.id });
  assertNoSoftware(taskChat, 'Task conversation');
  await app.json('file', { taskId: task.id, path: 'brief.md', content: '# 简报\n\n受控测试内容。\n' });
  const studioFiles = join(home, 'studio', 'files', project.id);
  assert.equal(await readFile(join(studioFiles, 'tasks', task.id, 'brief.md'), 'utf8'), '# 简报\n\n受控测试内容。\n', 'Task files are in <studio data>/files/<project>/tasks/<task>');
  assert.equal(await readFile(join(studioFiles, 'shared', 'inputs', 'brief.md'), 'utf8'), '共享资料', 'Project shared files are in <studio data>/files/<project>/shared');

  // ---- a person completes the task; the export has no vm/ part and no warnings ----------------------------
  const preview = await app.json(`task/completion?taskId=${task.id}`);
  const submitted = await app.json('task/completion/files', { taskId: task.id, revision: preview.taskRevision, workspaceVersion: preview.workspaceVersion, files: [{ path: 'brief.md', description: '简报正文' }] });
  const completed = await app.json('task/completion', { taskId: submitted.taskId, revision: submitted.taskRevision, workspaceVersion: submitted.workspaceVersion, childrenVersion: submitted.childrenVersion,
    checkedGoalIds: submitted.goals.filter(goal => !goal.system).map(goal => goal.id), submissionId: submitted.submittedFiles?.id });
  assert.equal(completed.task.state, 'completed');
  const files = await exportFiles(project.id), names = [...files.keys()];
  assert.equal(names.some(name => /\/vm\//u.test(name)), false, `The export has no vm/ part: ${names.filter(name => /\/vm\//u.test(name)).join(', ')}`);
  const projectJson = JSON.parse(files.get(names.find(name => name.endsWith('/project.json') && name.split('/').length === 2)).toString('utf8'));
  // No VM warnings. The smoke model makes no HTTP calls, so the export notes that its calls have no raw request (③).
  assert.deepEqual(projectJson.warnings.filter(warning => !/没有经过 HTTP（测试模型/u.test(warning)), [], 'The export reports no warnings about VMs or anything else');
  for (const warning of projectJson.warnings) assert.doesNotMatch(warning, VM_WORDS);
  assert.ok(names.some(name => name.endsWith('/workspace/brief.md')), 'The export carries the task files');

  // ---- an autonomy run of the smoke orchestrator and workers completes, with no VM budget ----------------
  const leaf = (key, title) => ({ key, definition: { title, goal: `完成「${title}」（受控测试）`, checklist: [{ text: `${title}的结果文件已写出` }] } });
  const script = { creates: [leaf('A', '资料整理 A'), leaf('B', '资料整理 B')], workers: { '*': { delayMs: 200 } } };
  const runProject = await app.json('projects', { title: '无软件模式：自主运行' });
  const started = await app.json('autonomy/start', { projectId: runProject.id, objective: `受控测试目标（不调用真实模型）\n[autonomy-smoke] ${JSON.stringify(script)}`, settings: { orchestratorModel: model, workerModel: model, maxVms: 2 } });
  assert.equal(started.settings.maxVms, 0, 'Without software the VM limit of a run is 0');
  const final = await waitFor(() => app.json(`autonomy/run?id=${encodeURIComponent(started.id)}`), detail => ['completed', 'failed', 'stopped', 'blocked'].includes(detail.state), 'The autonomy run did not end', 120000);
  assert.equal(final.state, 'completed', `The autonomy run completed (attention: ${JSON.stringify(final.attention)})`);
  assert.equal(final.usage.vms, 0);
  const tasks = (await app.json(`graph?projectId=${encodeURIComponent(runProject.id)}`)).tasks.filter(row => row.title.startsWith('资料整理'));
  assert.equal(tasks.length, 2); for (const row of tasks) { assert.equal(row.state, 'completed'); assert.equal(row.completedBy, 'agent'); }
  const orchestrator = await chat(started.orchestratorChatId), first = orchestrator.events.find(event => event.type === 'user/message');
  assert.doesNotMatch(textOf(first.data.content), VM_WORDS, 'The orchestrator\'s first message has no VM budget');
  for (const event of final.events) assert.doesNotMatch(event.summary ?? '', VM_WORDS, `Run event mentions VMs: ${event.summary}`);

  // ---- clearing a task removes its files from Studio's data folder; deleting the project removes the folder
  const extra = await app.json('task/quick', { projectId: project.id, title: '清空测试' });
  await app.json('file', { taskId: extra.id, path: 'draft.md', content: '草稿' });
  assert.ok(await exists(join(studioFiles, 'tasks', extra.id, 'draft.md')));
  const clearPreview = await app.json(`task/clear-preview?id=${encodeURIComponent(extra.id)}`);
  await app.json('task/clear', { id: extra.id, revision: clearPreview.taskRevision, projectRevision: clearPreview.projectRevision, confirm: true });
  assert.deepEqual(await readdir(join(studioFiles, 'tasks', extra.id)), [], 'Clearing a task empties its task space');
  const graph = await app.json(`graph?projectId=${encodeURIComponent(project.id)}`);
  await app.json('project/delete', { id: project.id, revision: graph.project.revision, confirmationTitle: graph.project.title });
  assert.equal(await exists(studioFiles), false, 'Deleting the project removes its files folder');
  console.log('No-software mode acceptance passed: no software tools, routes or prompts; files in the data folder; completion, export and an autonomy run.');
} finally {
  if (app) await stopApp(app.child);
  const release = async path => { await chmod(path, 0o700).catch(() => {}); for (const row of await readdir(path, { withFileTypes: true }).catch(() => [])) if (row.isDirectory()) await release(join(path, row.name)); };
  await release(home); await rm(home, { recursive: true, force: true });
}
