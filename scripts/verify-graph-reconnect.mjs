import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { root } from './prepare.mjs';
import { startApp, stopApp } from './verify-app.mjs';

// Authenticated HTTP and restart checks use only this newly allocated home.
await mkdir(join(root, '.studio'), { recursive: true });
const home = await mkdtemp(join(root, '.studio/graph-reconnect-test-'));
let app;
const spec = title => ({ title, kind: 'task', goal: '验证图谱依赖调整',
  criteria: [{ id: 'proof', label: '连线核对', kind: 'check', method: '核对受控依赖' }], outputs: ['report.md'], unresolved: [] });
async function release(path) {
  await chmod(path, 0o700);
  for (const row of await readdir(path, { withFileTypes: true })) if (row.isDirectory() && !row.isSymbolicLink()) await release(join(path, row.name));
}
try {
  app = await startApp(home);
  const project = await app.json('projects', { title: '图谱拖拽改线（受控验收）' });
  const tasks = [];
  for (const title of ['齿轮载荷', '齿形方案', '轴承方案', '装配检查']) tasks.push(await app.json('task', { projectId: project.id, ...spec(title) }));
  const [a, b, c, d] = tasks;
  await app.json('dependencies', { id: b.id, revision: b.revision, dependencies: [a.id] });
  await app.json('dependencies', { id: d.id, revision: d.revision, dependencies: [b.id] });
  const graph = () => app.json(`graph?projectId=${project.id}`);
  const reconnect = async (edge, connection) => app.json('dependencies/reconnect', { projectId: project.id, projectRevision: (await graph()).project.revision, edge, connection });
  const original = await graph();
  const body = { projectId: project.id, projectRevision: original.project.revision, edge: { source: a.id, target: b.id }, connection: { source: c.id, target: b.id } };
  assert.equal((await fetch(`${app.base}/api/studio/dependencies/reconnect`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://untrusted.invalid' }, body: JSON.stringify(body) })).status, 403);
  let updated = await app.json('dependencies/reconnect', body);
  assert.deepEqual(updated.tasks.find(row => row.id === b.id).dependencies, [c.id]);
  const beforeRejected = await graph();
  const stale = await app.call('dependencies/reconnect', body);
  assert.equal(stale.status, 400); assert.equal(typeof (await stale.json()).error, 'string');
  assert.deepEqual(await graph(), beforeRejected);
  // Retargeting two tasks is one mutation; an invalid new target leaves both intact.
  const cycle = await app.call('dependencies/reconnect', { projectId: project.id, projectRevision: beforeRejected.project.revision, edge: { source: c.id, target: b.id }, connection: { source: d.id, target: b.id } });
  assert.equal(cycle.status, 400); assert.deepEqual(await graph(), beforeRejected);
  updated = await reconnect({ source: c.id, target: b.id }, { source: c.id, target: a.id });
  assert.deepEqual(updated.tasks.find(row => row.id === b.id).dependencies, []);
  assert.deepEqual(updated.tasks.find(row => row.id === a.id).dependencies, [c.id]);
  const start = `graph-start:${project.id}:root`, end = `graph-end:${project.id}:root`;
  updated = await reconnect({ source: c.id, target: a.id }, { source: start, target: a.id });
  assert.deepEqual(updated.tasks.find(row => row.id === a.id).dependencies, []);
  updated = await reconnect({ source: start, target: c.id }, { source: a.id, target: c.id });
  assert.deepEqual(updated.tasks.find(row => row.id === c.id).dependencies, [a.id]);
  updated = await reconnect({ source: d.id, target: end }, { source: d.id, target: c.id });
  assert.deepEqual(updated.tasks.find(row => row.id === c.id).dependencies, [a.id, d.id]);
  updated = await reconnect({ source: d.id, target: c.id }, { source: d.id, target: end });
  assert.deepEqual(updated.tasks.find(row => row.id === c.id).dependencies, [a.id], 'Only the dragged dependency is removed');
  const parent = await app.json('task/quick', { projectId: project.id, title: '齿轮细化' });
  const child = await app.json('task/quick', { projectId: project.id, parentId: parent.id, title: '核对齿宽' });
  const otherChild = await app.json('task/quick', { projectId: project.id, parentId: parent.id, title: '核对齿高' });
  await reconnect({ source: `graph-start:${project.id}:${parent.id}`, target: child.id }, { source: otherChild.id, target: child.id });
  const beforeRestart = await graph();
  for (const task of tasks) {
    const row = beforeRestart.tasks.find(row => row.id === task.id);
    assert.equal(row.code, task.code); assert.equal(row.rank, task.rank); assert.equal(row.state, 'unstarted'); assert.deepEqual(row.inputs, []);
  }
  await stopApp(app.child); app = await startApp(home);
  assert.deepEqual(await graph(), beforeRestart);
  console.log('Graph reconnect HTTP checks passed: anonymous same-origin API with Origin refusal, atomic endpoint changes, cycle/stale rejection, virtual endpoints, nested scope, identity and restart. No external model or preview data used.');
} finally {
  if (app) await stopApp(app.child);
  await release(home); await rm(home, { recursive: true, force: true });
}
