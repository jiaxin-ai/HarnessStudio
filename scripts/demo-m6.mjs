import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { root } from './prepare.mjs';
import { stopApp } from './verify-app.mjs';

const exampleRoot = join(root, 'examples', 'm6');
const markerName = 'm6-demo-owner.json', stateName = 'm6-demo-state.json', lockName = 'm6-demo.lock';
const missing = error => error?.code === 'ENOENT';
const regular = async path => { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw new Error(`拒绝非普通演示文件：${path}`); };
const within = (base, path) => { const part = relative(base, path); return part && !part.startsWith('..') && !isAbsolute(part); };

/** Persist only a script-owned file; never follow a replacement symlink. */
async function savePrivate(path, value) {
  try { await regular(path); } catch (error) { if (!missing(error)) throw error; }
  const temporary = `${path}.${randomUUID()}.tmp`, writer = await open(temporary, 'wx', 0o600);
  try {
    await writer.writeFile(value); await writer.sync(); await writer.close();
    await rename(temporary, path); await chmod(path, 0o600);
    const directory = await open(dirname(path), 'r'); try { await directory.sync(); } finally { await directory.close(); }
  } finally { await writer.close(); await rm(temporary, { force: true }); }
}
async function readJson(path) { await regular(path); return JSON.parse(await readFile(path, 'utf8')); }

/** Only an empty directory or this demo's explicit owner marker can be used. */
export async function prepareDemoHome(selected = join(root, '.studio', 'm6-demo')) {
  const desired = resolve(selected);
  const primaryHome = join(root, '.studio', 'home');
  if (desired === root || desired === join(root, '.studio') || desired === primaryHome || within(primaryHome, desired) || !relative(desired, root).startsWith('..')) throw new Error('请选择独立演示目录，不能使用仓库、主 home、主 home 子目录或其上级目录');
  // Resolve the existing prefix before mkdir, so a parent alias cannot hide a
  // path inside the user's primary home or an ancestor of this installation.
  let existing = desired;
  while (true) { try { await lstat(existing); break; } catch (error) { if (!missing(error)) throw error; existing = dirname(existing); } }
  const prospective = resolve(await realpath(existing), relative(existing, desired)), primaryReal = await realpath(primaryHome).catch(() => primaryHome);
  if (prospective === primaryReal || within(primaryReal, prospective) || prospective === root || !relative(prospective, root).startsWith('..')) throw new Error('演示目录别名指向主 home 或仓库上级，拒绝创建');
  await mkdir(desired, { recursive: true, mode: 0o700 });
  const info = await lstat(desired); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('演示 home 必须是真实目录');
  const home = await realpath(desired), markerPath = join(home, markerName);
  if (home === await realpath(join(root, '.studio', 'home')).catch(() => join(root, '.studio', 'home'))) throw new Error('不能使用主预览 home');
  let marker;
  try { marker = await readJson(markerPath); }
  catch (error) {
    if (!missing(error)) throw error;
    if ((await readdir(home)).length) throw new Error('拒绝导入已有用户 home；首次演示目录必须为空');
    marker = { schemaVersion: 1, demo: 'm6-single-user', ownerId: randomUUID() };
    await savePrivate(markerPath, JSON.stringify(marker) + '\n');
  }
  if (marker.schemaVersion !== 1 || marker.demo !== 'm6-single-user' || typeof marker.ownerId !== 'string' || !/^[0-9a-f-]{36}$/.test(marker.ownerId)) throw new Error('演示 home 的归属标记无效');
  return { home, marker };
}
async function acquireLock(home) {
  const path = join(home, lockName), value = { pid: process.pid, nonce: randomUUID() };
  let writer;
  try { writer = await open(path, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const prior = await readJson(path); if (!Number.isSafeInteger(prior.pid) || prior.pid < 1 || typeof prior.nonce !== 'string') throw new Error('演示锁无效，请人工检查');
    // A dead launcher can still have live descendants. Never steal its home or
    // kill a process merely because a stale PID was written in the lock.
    throw new Error('这个演示 home 已有启动锁；请先确认原 Studio 和 Mock 均已停止。异常退出遗留的锁须人工核对，脚本不会抢占');
  }
  try { await writer.writeFile(JSON.stringify(value) + '\n'); await writer.sync(); } finally { await writer.close(); }
  return async () => { const current = await readJson(path); if (current.nonce !== value.nonce) throw new Error('演示锁已变化，拒绝移除'); await rm(path); };
}

/** Start a real normal Studio Host and its owned Mock, never a smoke Provider. */
export async function startDemoApp(selected, { port = 0 } = {}) {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535 || port === 53983) throw new Error('演示端口须为 0 或有效端口，不能使用主预览 53983');
  const { home, marker } = await prepareDemoHome(selected), unlock = await acquireLock(home);
  const env = { ...process.env };
  // No inherited Provider secret, external platform, deployment overlay or
  // fixed Mock port may turn an independent demo into somebody else's service.
  for (const key of Object.keys(env)) if (/^(DEEPSEEK_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|STUDIO_PROVIDER_)/.test(key) || /^STUDIO_/.test(key) || key === 'DSH_HOME') delete env[key];
  Object.assign(env, { STUDIO_HOME: home, STUDIO_PORT: String(port), STUDIO_SMOKE: '0', STUDIO_WORKFLOW_MODE: 'single-user',
    STUDIO_MOCK_SEAT: '1', STUDIO_SYSTEM_PROXY: '0', STUDIO_CONFIG_PATCH: join(exampleRoot, 'demo.patch.yml') });
  const child = spawn(process.execPath, [join(root, 'scripts', 'start.mjs')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '', spawnError;
  child.stdout.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-32768); });
  child.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-32768); });
  child.once('error', error => { spawnError = error; });
  let stopped = false;
  const stop = async () => { if (stopped) return; stopped = true; try { await stopApp(child); } finally { await unlock(); } };
  try {
    let url; const deadline = Date.now() + 25000;
    while (Date.now() < deadline && child.exitCode === null && !spawnError) {
      url = diagnostics.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/)/)?.[1];
      if (url) break; await delay(50);
    }
    if (!url) throw new Error(`演示启动失败：${String(spawnError ?? diagnostics).replace(/token=[^\s]+/g, 'token=[redacted]')}`);
    const base = new URL(url).origin;
    const call = (path, body) => fetch(`${base}/api/studio/${path}`, { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(15000),
      headers: { origin: base, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const json = async (path, body) => { const response = await call(path, body), source = await response.text(); if (response.status !== 200) throw new Error(`${path}: HTTP ${response.status}: ${source}`); return JSON.parse(source); };
    let ready = false, readiness; const routeDeadline = Date.now() + 20000;
    while (Date.now() < routeDeadline && child.exitCode === null) {
      const [projects, catalog] = await Promise.all([call('projects'), call('software/catalog')]);
      readiness = { projects: projects.status, catalog: catalog.status };
      if (projects.status === 200 && catalog.status === 200) { ready = true; break; } await delay(50);
    }
    if (!ready) throw new Error(`演示业务路由尚未就绪：${JSON.stringify(readiness)}；${diagnostics.slice(-6000).replace(/token=[^\s]+/g, 'token=[redacted]')}`);
    const page = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    if (page.status !== 200 || page.headers.getSetCookie().length) throw new Error('演示首页应无需登录和 Cookie 直接打开');
    return { child, home, marker, base, call, json, stop };
  } catch (error) { await stop(); throw error; }
}

export async function loadScenario() { return readJson(join(exampleRoot, 'scenario.json')); }
export async function exampleContent(file) {
  const path = resolve(exampleRoot, file.source); if (!within(exampleRoot, path)) throw new Error('示例模板路径无效');
  await regular(path); return readFile(path, 'utf8');
}

/** Seed only drafts and eligible files, then preserve every subsequent user edit. */
export async function seedDemo(app) {
  const scenario = await loadScenario(), statePath = join(app.home, stateName);
  let state;
  try { state = await readJson(statePath); }
  catch (error) { if (!missing(error)) throw error; state = { schemaVersion: 1, fixtureVersion: scenario.fixtureVersion, ownerId: app.marker.ownerId, tasks: {}, dependencies: [], files: [], ready: false }; }
  if (state.schemaVersion !== 1 || state.ownerId !== app.marker.ownerId || state.fixtureVersion !== scenario.fixtureVersion || !state.tasks || !Array.isArray(state.dependencies) || !Array.isArray(state.files)) throw new Error('演示状态不兼容；不会覆盖现有资料');
  const reused = state.ready;
  const save = () => savePrivate(statePath, JSON.stringify(state, null, 2) + '\n');
  // A durable pre-request intent prevents a crash between API success and our
  // receipt from silently creating a duplicate on the next invocation.
  if (state.pending) {
    const intent = state.pending;
    if (intent.kind === 'project' || intent.kind === 'task') {
      const rows = intent.kind === 'project' ? await app.json('projects') : (await app.json(`graph?projectId=${state.projectId}`)).tasks;
      const candidates = rows.filter(row => !intent.beforeIds.includes(row.id) && row.title === intent.title && (intent.kind === 'project' || row.parentId === intent.parentId));
      if (candidates.length !== 1) throw new Error('初始化曾在创建请求途中中断；结果不唯一，已停止自动重建。请人工核对演示状态文件');
      if (intent.kind === 'project') state.projectId = candidates[0].id; else state.tasks[intent.key] = candidates[0].id;
    } else if (intent.kind === 'dependencies') {
      const current = await app.json(`task?id=${state.tasks[intent.key]}`);
      if (JSON.stringify(current.dependencies) !== JSON.stringify(intent.ids)) throw new Error('初始化依赖请求结果未明，需人工核对；不会代确认影响或重建图谱');
      state.dependencies.push(intent.key);
    } else if (intent.kind === 'file') {
      const response = await app.call(`file?${new URLSearchParams({ taskId: state.tasks[intent.taskKey], path: intent.path })}`);
      if (response.status !== 200) throw new Error('初始化文件请求结果未明，需人工核对；不会覆盖或自动重试');
      state.files.push(intent.identity);
    } else throw new Error('初始化意图记录无效');
    delete state.pending; await save();
  }
  if (!state.projectId) {
    state.pending = { kind: 'project', title: scenario.project.title, beforeIds: (await app.json('projects')).map(row => row.id) }; await save();
    const project = await app.json('projects', scenario.project); state.projectId = project.id; delete state.pending; await save();
  }
  const projects = await app.json('projects'); if (!projects.some(row => row.id === state.projectId)) throw new Error('原演示项目已被删除；不会自动重建或导入其他项目');
  if (!state.ready) {
    for (const spec of scenario.tasks) {
      if (state.tasks[spec.key]) { await app.json(`task?id=${state.tasks[spec.key]}`); continue; }
      const parentId = spec.parentKey ? state.tasks[spec.parentKey] : undefined;
      if (spec.parentKey && !parentId) throw new Error('示例父节点创建顺序无效');
      state.pending = { kind: 'task', key: spec.key, title: spec.title, ...(parentId ? { parentId } : {}), beforeIds: (await app.json(`graph?projectId=${state.projectId}`)).tasks.map(row => row.id) }; await save();
      const task = await app.json('task', { projectId: state.projectId, ...(parentId ? { parentId } : {}), title: spec.title, kind: 'task', goal: spec.goal, checklist: spec.checklist.map(text => ({ text })) });
      state.tasks[spec.key] = task.id; delete state.pending; await save();
    }
    for (const spec of scenario.tasks.filter(row => row.dependencies?.length)) {
      if (state.dependencies.includes(spec.key)) continue;
      const current = await app.json(`task?id=${state.tasks[spec.key]}`), ids = spec.dependencies.map(key => state.tasks[key]);
      const preview = await app.json('dependencies/preview', { id: current.id, revision: current.revision, dependencies: ids });
      if (preview.requiresConfirmation) throw new Error('初始图谱已含执行历史，须人工确认依赖影响；演示脚本不会代确认');
      state.pending = { kind: 'dependencies', key: spec.key, ids }; await save();
      await app.json('dependencies', { id: current.id, revision: current.revision, dependencies: ids });
      state.dependencies.push(spec.key); delete state.pending; await save();
    }
    for (const file of scenario.files.filter(row => row.seed)) {
      const identity = `${file.taskKey}:${file.path}`; if (state.files.includes(identity)) continue;
      const current = await app.json(`task?id=${state.tasks[file.taskKey]}`); if (!current.writable || current.state !== 'unstarted') throw new Error('预置文件只能写入当前获准执行的初始草稿叶任务');
      state.pending = { kind: 'file', taskKey: file.taskKey, path: file.path, identity }; await save();
      const existing = await app.call(`file?${new URLSearchParams({ taskId: current.id, path: file.path })}`);
      if (existing.status !== 200) await app.json('file', { taskId: current.id, path: file.path, content: await exampleContent(file), createOnly: true });
      state.files.push(identity); delete state.pending; await save();
    }
    state.ready = true; await save();
  }
  const graph = await app.json(`graph?projectId=${state.projectId}`), tasks = scenario.tasks.map(spec => {
    const current = graph.tasks.find(row => row.id === state.tasks[spec.key]); if (!current) throw new Error(`演示节点 ${spec.key} 已被用户删除；不会自动补建`);
    const byId = Object.fromEntries(Object.entries(state.tasks).map(([key, id]) => [id, key]));
    return { key: spec.key, id: current.id, code: current.code, title: current.title, ...(current.parentId ? { parentKey: byId[current.parentId] ?? current.parentId } : {}), dependencies: current.dependencies.map(id => byId[id] ?? id), ...(spec.imageId ? { imageId: spec.imageId } : {}) };
  });
  return { schemaVersion: 1, demo: scenario.id, synthetic: true, home: app.home, url: app.base, project: { id: graph.project.id, title: graph.project.title }, tasks, reused,
    guide: join(root, 'docs', 'm6-demo.md') };
}

async function main() {
  let home = join(root, '.studio', 'm6-demo'), port = 0, outputPath;
  for (let index = 2; index < process.argv.length; index++) {
    const option = process.argv[index], value = process.argv[++index];
    if (!value || !['--home', '--port', '--json'].includes(option)) throw new Error('用法：node scripts/demo-m6.mjs [--home 独立目录] [--port 0] [--json home内清单路径]');
    if (option === '--home') home = resolve(value); else if (option === '--port') { if (!/^\d+$/.test(value)) throw new Error('端口格式无效'); port = Number(value); } else outputPath = resolve(value);
  }
  let app;
  try {
    app = await startDemoApp(home, { port });
    const demo = await seedDemo(app), manifest = outputPath ?? join(app.home, 'm6-demo.json');
    if (dirname(manifest) !== app.home || !/^m6-demo(?:-[A-Za-z0-9_-]+)?\.json$/.test(relative(app.home, manifest))) throw new Error('JSON 输出须为演示 home 根目录的 m6-demo.json 或 m6-demo-名称.json');
    await savePrivate(manifest, JSON.stringify(demo, null, 2) + '\n');
    console.log(JSON.stringify(demo, null, 2));
    console.error(`演示已启动，直接打开 ${demo.url}/，无需登录。Ctrl+C 停止服务并保留全部演示资料。`);
    await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); app.child.once('close', resolve); });
    if (app.child.exitCode !== null && app.child.exitCode !== 0) throw new Error('演示 Host 已意外退出');
  } finally { if (app) await app.stop(); }
}
const invokedPath = process.argv[1] ? await realpath(resolve(process.argv[1])).catch(() => undefined) : undefined;
if (invokedPath === await realpath(fileURLToPath(import.meta.url))) main().catch(error => { console.error(error.message); process.exitCode = 1; });
