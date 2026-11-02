// One-time copy of Studio-managed task and project files into vm_manager storage
// (task spaces = D:, project shared folder = F:). Run inside the Studio container
// of the vm-manager deployment, where both stores are mounted:
//   node scripts/migrate-vm-storage.mjs            # dry run: list what would be copied
//   node scripts/migrate-vm-storage.mjs --apply    # copy, then freeze completed tasks
// Existing files in vm_manager storage are never overwritten; differing files are
// reported as conflicts. Studio's own copies and chat scratch (.chat-tmp) are kept.
import { DatabaseSync } from 'node:sqlite';
import { copyFile, lstat, mkdir, readdir, readFile, utimes } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const apply = process.argv.includes('--apply');
const home = resolve(process.env.STUDIO_HOME || '/var/lib/harnessstudio'), studio = join(home, 'studio');
// Both come from the vm-manager deployment's container environment; no host's own path is assumed.
const projectsRoot = resolve(process.env.STUDIO_VMM_PROJECTS_ROOT || ''), endpoint = (process.env.STUDIO_VMM_URL || '').replace(/\/$/u, '');
if (!endpoint) throw new Error('STUDIO_VMM_URL is required');
if (!process.env.STUDIO_VMM_PROJECTS_ROOT) throw new Error('STUDIO_VMM_PROJECTS_ROOT is required');

async function call(path, method = 'GET', body) {
  const response = await fetch(endpoint + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(200000), redirect: 'error' });
  const value = await response.json();
  if (!response.ok) { const error = new Error(`${value?.error?.code ?? response.status}: ${value?.error?.message ?? 'request failed'}`); error.code = value?.error?.code; throw error; }
  return value.data;
}
async function ensureWorkspace(projectId, taskId) {
  try { return await call('/v1/workspaces', 'POST', { project_id: projectId, task_id: taskId }); }
  catch (error) {
    if (error.code !== 'WORKSPACE_EXISTS') throw error;
    return (await call(`/v1/workspaces?${new URLSearchParams({ project_id: projectId, task_id: taskId })}`)).items[0];
  }
}
const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');
/** Regular files below a directory, without links and without the root .chat-tmp tree. */
async function files(directory, relative = '') {
  let entries; try { entries = await readdir(join(directory, relative), { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const result = [];
  for (const entry of entries) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (!relative && entry.name.toLowerCase() === '.chat-tmp') continue;
    if (entry.isSymbolicLink()) { console.warn(`  skip link ${path}`); continue; }
    if (entry.isDirectory()) result.push(...await files(directory, path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}
/** Copy missing files; identical files count as done, differing files are conflicts. */
async function copyTree(source, target, label) {
  const summary = { copied: 0, same: 0, conflicts: [] };
  for (const path of await files(source)) {
    const from = join(source, path), to = join(target, path);
    const existing = await lstat(to).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (existing) { if (existing.isFile() && await digest(from) === await digest(to)) summary.same++; else summary.conflicts.push(path); continue; }
    summary.copied++;
    if (!apply) continue;
    await mkdir(join(to, '..'), { recursive: true });
    await copyFile(from, to); const info = await lstat(from); await utimes(to, info.atime, info.mtime);
  }
  console.log(`${label}: ${apply ? 'copied' : 'to copy'} ${summary.copied}, already identical ${summary.same}, conflicts ${summary.conflicts.length}${summary.conflicts.length ? ` (${summary.conflicts.join(', ')})` : ''}`);
  return summary;
}

const db = new DatabaseSync(join(studio, 'domain.sqlite'), { readOnly: true });
const tasks = db.prepare('SELECT id, project_id, value FROM tasks ORDER BY rowid').all().map(row => ({ id: String(row.id), projectId: String(row.project_id), task: JSON.parse(String(row.value)) }));
const projects = db.prepare('SELECT id FROM projects').all().map(row => String(row.id));
db.close();
console.log(`${apply ? 'Applying' : 'Dry run'}: ${tasks.length} tasks, ${projects.length} projects; Studio data ${studio}; vm_manager ${endpoint}, ${projectsRoot}`);
let conflicts = 0;
for (const { id, projectId, task } of tasks) {
  const source = join(studio, 'workspaces', id), pending = await files(source);
  if (!pending.length) continue;
  const label = `task ${task.code ?? ''} ${task.title ?? id} (${id}, ${task.state})`;
  let space = (await call(`/v1/workspaces?${new URLSearchParams({ project_id: projectId, task_id: id })}`)).items[0];
  if (space?.status === 'frozen') { console.log(`${label}: task space already frozen, skipped`); continue; }
  if (apply) space = await ensureWorkspace(projectId, id);
  const target = join(projectsRoot, projectId, 'tasks', id);
  if (space && resolve(space.path) !== target) throw new Error(`${label}: vm_manager path ${space.path} differs from ${target}`);
  const summary = await copyTree(source, target, label); conflicts += summary.conflicts.length;
  if (apply && ['completed', 'accepted'].includes(task.state) && !summary.conflicts.length) { await call(`/v1/workspaces/${space.workspace_id}/freeze`, 'POST'); console.log(`${label}: frozen`); }
  else if (['completed', 'accepted'].includes(task.state)) console.log(`${label}: ${apply ? 'not frozen because of conflicts' : 'will be frozen'}`);
}
for (const projectId of projects) {
  const source = join(studio, 'project-workspaces', projectId);
  if (!(await files(source)).length) continue;
  conflicts += (await copyTree(source, join(projectsRoot, projectId, 'shared'), `project ${projectId} → F:`)).conflicts.length;
}
console.log(conflicts ? `Finished with ${conflicts} conflicting files left unchanged.` : 'Finished without conflicts.');
process.exitCode = conflicts ? 2 : 0;
