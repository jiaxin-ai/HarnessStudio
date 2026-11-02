import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { root } from './prepare.mjs';
import { startDemoApp, seedDemo, loadScenario, exampleContent, prepareDemoHome } from './demo-m6.mjs';

// TEST ONLY: these HTTP requests simulate the human's checkboxes, selected
// submissions and no-file second confirmation. The demo launcher never does so.
await mkdir(join(root, '.studio'), { recursive: true });
const home = await mkdtemp(join(root, '.studio', 'm6-acceptance-test-'));
const hash = text => createHash('sha256').update(text).digest('hex');
const query = (path, fields) => `${path}?${new URLSearchParams(fields)}`;
let app;
const evidence = { schemaVersion: 1, milestone: 'M6', synthetic: true, normalProfile: true, externalModelCalls: 0,
  checks: {}, software: [], snapshots: [], files: [], boundaries: ['Mock only, no real CAD/CAE/EDA validation', 'Human confirmations are simulated by this disposable verification script only'] };
async function until(read, ready, message) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { const result = await read(); if (ready(result)) return result; await delay(60); }
  throw new Error(message);
}
const task = id => app.json(query('task', { id }));
const readFile = (id, path) => app.json(query('file', { taskId: id, path }));
const completion = id => app.json(query('task/completion', { taskId: id }));
const args = preview => ({ taskId: preview.taskId, revision: preview.taskRevision, workspaceVersion: preview.workspaceVersion,
  ...(preview.isFolder ? { childrenVersion: preview.childrenVersion } : {}), checkedGoalIds: preview.goals.filter(goal => !goal.system).map(goal => goal.id) });
async function denied(path, body) { const response = await app.call(path, body); assert.equal(response.status, 400, `${path} should be rejected: ${await response.clone().text()}`); }
async function submit(id, paths) {
  const preview = await completion(id);
  return app.json('task/completion/files', { taskId: id, revision: preview.taskRevision, workspaceVersion: preview.workspaceVersion,
    files: paths.map(path => ({ path, description: 'TEST ONLY：人工选择的合成流程演示文件；不代表工程质量。' })) });
}
async function complete(id) {
  const preview = await completion(id); assert.deepEqual(preview.blockers, []);
  assert.ok(preview.goals.filter(goal => !goal.system).length > 1, 'Sample has a detailed goal and multiple human requirements');
  const response = await app.json('task/completion', { ...args(preview), ...(preview.submittedFiles ? { submissionId: preview.submittedFiles.id } : { confirmWithoutFiles: true }) });
  assert.equal(response.task.state, 'completed');
  const snapshot = (await app.json(query('snapshot/manifest', { taskId: id, snapshotId: response.task.completedId }))).snapshot;
  assert.deepEqual(snapshot.humanConfirmation.goals.filter(goal => !goal.system).map(goal => goal.id), args(preview).checkedGoalIds);
  if (!preview.submittedFiles) { assert.equal(snapshot.humanConfirmation.withoutSubmittedFiles, true); assert.deepEqual(snapshot.files, []); }
  evidence.snapshots.push({ taskId: id, snapshotId: snapshot.id, inputs: snapshot.inputs, childrenRefs: snapshot.childrenRefs ?? [],
    files: snapshot.files.map(file => ({ path: file.path, bytes: file.bytes, sha256: file.version })), withoutSubmittedFiles: snapshot.humanConfirmation.withoutSubmittedFiles ?? false });
  return snapshot;
}
async function materialize(scenario, key, id) {
  for (const file of scenario.files.filter(row => row.taskKey === key && !row.seed)) await app.json('file', { taskId: id, path: file.path, content: await exampleContent(file), createOnly: true });
}
async function mockSoftware(id, imageId) {
  assert.deepEqual((await app.json(query('software/seats', { taskId: id }))).seats, [], 'Software must not be launched by seeding or merely opening the task');
  const launched = (await app.json('software/seat', { taskId: id, imageId, requestId: randomUUID() })).seat;
  let seat = await until(() => app.json(query('software/seat', { taskId: id, imageId })), value => value.seat?.state === 'ready', 'Explicit Mock image did not become ready').then(value => value.seat);
  assert.equal(seat.id, launched.id); assert.equal(seat.softwareId, imageId);
  await app.json('software/control', { taskId: id, imageId, action: 'acquire' });
  async function invoke(capability, parameters) {
    const requestId = randomUUID();
    const posted = await app.json('software/invoke', { taskId: id, imageId, requestId, capability, parameters, expectedDocumentRevision: seat.document.revision });
    const operation = await until(() => app.json(query('software/operation', { taskId: id, imageId, operationId: posted.operation.id })), value => !['queued', 'running'].includes(value.operation.state), 'Synthetic Mock operation did not settle').then(value => value.operation);
    assert.equal(operation.state, 'succeeded', JSON.stringify(operation.error));
    seat = (await app.json(query('software/seat', { taskId: id, imageId }))).seat; return operation;
  }
  if (imageId === 'mock-ansys') {
    await invoke('analysis.configure', { type: 'static', loadN: 100, elasticModulusMPa: 210000, meshSizeMm: 5 });
    await invoke('analysis.run', {}); assert.equal(seat.document.analysis.result.mock, true);
  } else await invoke('shape.add', { kind: 'rectangle', x: 0, y: 0, width: 80, height: 50, label: 'synthetic bracket, not engineering geometry' });
  const exported = await invoke('document.export', { format: 'json', name: `m6-${imageId}-synthetic.json` });
  const saved = await app.json('software/artifact', { taskId: id, imageId, artifactId: exported.result.artifactId });
  const file = await readFile(id, saved.path); assert.equal(JSON.parse(file.content).mock, true); assert.equal(file.version, saved.version);
  await app.json('software/control', { taskId: id, imageId, action: 'release' });
  evidence.software.push({ taskId: id, imageId, seatId: seat.id, documentRevision: seat.document.revision, artifactPath: saved.path, sha256: file.version, mock: true });
  return saved;
}
async function release(directory) {
  const info = await lstat(directory); if (info.isSymbolicLink()) return;
  if (!info.isDirectory()) { await chmod(directory, 0o600); return; }
  await chmod(directory, 0o700); for (const name of await readdir(directory)) await release(join(directory, name));
}

try {
  await assert.rejects(startDemoApp(home, { port: 53983 }), /53983/);
  await assert.rejects(prepareDemoHome(join(root, '.studio', 'home')), /主 home/);
  const foreignHome = await mkdtemp(join(root, '.studio', 'm6-rejected-home-'));
  try { await writeFile(join(foreignHome, 'user-file.txt'), 'must remain untouched'); await assert.rejects(prepareDemoHome(foreignHome), /已有用户 home/); }
  finally { await rm(foreignHome, { recursive: true, force: true }); }
  // Only the alias is created in a disposable fixture. The primary home is
  // never written: canonical rejection must happen before any mkdir there.
  const aliasFixture = await mkdtemp(join(root, '.studio', 'm6-alias-guard-test-'));
  try {
    const alias = join(aliasFixture, 'primary-alias'), candidate = `m6-must-not-create-${randomUUID()}`;
    await symlink(join(root, '.studio', 'home'), alias, 'dir');
    await assert.rejects(prepareDemoHome(join(alias, candidate)), /别名指向主 home/);
    await assert.rejects(lstat(join(alias, candidate)), { code: 'ENOENT' });
    await assert.rejects(prepareDemoHome(join(root, '.studio', 'home', candidate)), /主 home/);
  } finally { await rm(aliasFixture, { recursive: true, force: true }); }
  app = await startDemoApp(home); assert.deepEqual(await app.json('projects'), [], 'Fresh normal composition has no legacy demo project');
  const models = await app.json('models'); assert.ok(models.providers.every(row => row.credentialConfigured === false), 'No inherited real Provider key is needed for the manual path');
  const providerNames = (await app.json('status')).providers.map(row => typeof row === 'string' ? row : row.id);
  assert.ok(providerNames.every(name => !String(name).includes('smoke'))); assert.deepEqual((await app.json('status')).chats, []);
  assert.equal((await app.call('m5/crash', { confirm: true })).status, 404, 'Normal composition must not register smoke crash probes');
  const demo = await seedDemo(app), scenario = await loadScenario(); assert.equal(demo.reused, false); assert.equal(demo.tasks.length, 8);
  assert.equal(JSON.stringify(demo).includes('token='), false); assert.equal((await app.json('projects')).length, 1);
  const ids = Object.fromEntries(demo.tasks.map(row => [row.key, row.id]));
  const graphBefore = await app.json(query('graph', { projectId: demo.project.id }));
  assert.equal(new Set(graphBefore.tasks.map(row => row.code)).size, 8); assert.ok(graphBefore.tasks.every(row => /^[0-9A-Za-z]{5}$/.test(row.code) && row.checklist.length >= 3));
  assert.equal(graphBefore.tasks.find(row => row.id === ids.assembly).leafStats.total, 4);
  for (const key of ['autocad', 'ansys', 'verification', 'delivery']) { assert.equal((await task(ids[key])).writable, false); assert.deepEqual((await completion(ids[key])).files, []); }
  const sw = await task(ids.solidworks); await app.json('task/metadata', { id: sw.id, revision: sw.revision, title: `${sw.title}（用户保留修改）`, goal: sw.goal + '\n用户补充的合成演示记录，重复启动不能覆盖。', checklist: [...sw.checklist, { text: '用户新增检查项也要保留' }] });
  const notePath = 'notes/geometry-notes.md', originalNote = await readFile(sw.id, notePath), editedNote = originalNote.content + '\n用户后续编辑；必须保留。\n';
  await app.json('file', { taskId: sw.id, path: notePath, content: editedNote, expectedVersion: originalNote.version });
  const graphEdited = await app.json(query('graph', { projectId: demo.project.id })), repeated = await seedDemo(app);
  assert.equal(repeated.reused, true); assert.deepEqual(repeated.tasks.map(row => row.id), demo.tasks.map(row => row.id));
  assert.deepEqual(await app.json(query('graph', { projectId: demo.project.id })), graphEdited); assert.equal((await readFile(sw.id, notePath)).content, editedNote);
  evidence.checks.idempotentSeedPreservesUserEdits = true; evidence.checks.noSmokeOrModelCall = true;

  await mockSoftware(ids.solidworks, 'mock-solidworks');
  const parameterPath = 'geometry/parameters.json', firstParameters = await readFile(ids.solidworks, parameterPath);
  const submission = await submit(ids.solidworks, [parameterPath]);
  assert.equal(submission.submittedFiles.files.length, 1);
  const revisedParameters = JSON.stringify({ ...JSON.parse(firstParameters.content), revisionNote: 'Edited working copy after submission; original submitted bytes must remain immutable.' }, null, 2) + '\n';
  await app.json('file', { taskId: ids.solidworks, path: parameterPath, content: revisedParameters, expectedVersion: firstParameters.version });
  const unchecked = await completion(ids.solidworks); await denied('task/completion', { ...args(unchecked), checkedGoalIds: [], submissionId: unchecked.submittedFiles.id });
  const first = {}; first.solidworks = await complete(ids.solidworks);
  const immutableParameters = await app.json(query('snapshot/preview', { taskId: ids.solidworks, snapshotId: first.solidworks.id, path: parameterPath }));
  assert.equal(immutableParameters.content, firstParameters.content); assert.equal((await readFile(ids.solidworks, parameterPath)).content, revisedParameters);
  assert.deepEqual(first.solidworks.files.map(row => row.path), [parameterPath]);
  assert.equal((await readFile(ids.solidworks, notePath)).content, editedNote);
  evidence.files.push({ taskId: ids.solidworks, path: parameterPath, submittedSha256: hash(firstParameters.content), workingSha256: hash(revisedParameters), differentAfterSubmission: true });
  await materialize(scenario, 'autocad', ids.autocad); await mockSoftware(ids.autocad, 'mock-autocad');
  const withoutFiles = await completion(ids.autocad); await denied('task/completion', args(withoutFiles));
  first.autocad = await complete(ids.autocad); assert.equal((await readFile(ids.autocad, 'drawing/drawing-notes.md')).content.includes('synthetic=true'), true);
  assert.notEqual((await task(ids.geometry)).state, 'completed');
  const readyGeometry = await completion(ids.geometry); await denied('task/completion', { ...args(readyGeometry), checkedGoalIds: [], confirmWithoutFiles: true });
  first.geometry = await complete(ids.geometry);
  assert.deepEqual(first.geometry.childrenRefs, [{ taskId: ids.solidworks, snapshotId: first.solidworks.id }, { taskId: ids.autocad, snapshotId: first.autocad.id }]);

  await materialize(scenario, 'ansys', ids.ansys); const ansysArtifact = await mockSoftware(ids.ansys, 'mock-ansys');
  await submit(ids.ansys, [ansysArtifact.path]); first.ansys = await complete(ids.ansys);
  assert.deepEqual(first.ansys.inputs, [{ taskId: ids.geometry, snapshotId: first.geometry.id }]);
  await materialize(scenario, 'verification', ids.verification); first.verification = await complete(ids.verification);
  assert.deepEqual(first.verification.inputs, [{ taskId: ids.ansys, snapshotId: first.ansys.id }, { taskId: ids.geometry, snapshotId: first.geometry.id }]);
  assert.notEqual((await task(ids.simulation)).state, 'completed'); assert.notEqual((await task(ids.assembly)).state, 'completed');
  const earlyAssembly = await completion(ids.assembly); assert.ok(earlyAssembly.blockers.length); await denied('task/completion', { ...args(earlyAssembly), confirmWithoutFiles: true });
  first.simulation = await complete(ids.simulation); assert.notEqual((await task(ids.assembly)).state, 'completed');
  first.assembly = await complete(ids.assembly); await materialize(scenario, 'delivery', ids.delivery); first.delivery = await complete(ids.delivery);
  assert.deepEqual(first.delivery.inputs, [{ taskId: ids.assembly, snapshotId: first.assembly.id }]);
  evidence.checks.optionalSubmissionAndExplicitNoFileConfirmation = true; evidence.checks.perLevelHumanCompletion = true;

  const originalSnapshots = Object.values(first);
  const completedSW = await task(ids.solidworks); await app.json('task/action', { id: completedSW.id, revision: completedSW.revision, action: 'resume' });
  assert.equal((await task(ids.solidworks)).state, 'working');
  for (const key of Object.keys(first).filter(key => key !== 'solidworks')) {
    const current = await task(ids[key]); assert.equal(current.state, 'recheck', `${key} must await manual review after predecessor modification`); assert.equal(current.completedId, first[key].id); assert.ok(current.recheckReason);
  }
  const blockedDelivery = await completion(ids.delivery); assert.ok(blockedDelivery.blockers.length); await denied('task/completion', { ...args(blockedDelivery), confirmWithoutFiles: true });
  const liveParameters = await readFile(ids.solidworks, parameterPath), secondParameters = JSON.stringify({ ...JSON.parse(liveParameters.content), revisionNote: 'Second explicitly reviewed synthetic working version.' }, null, 2) + '\n';
  await app.json('file', { taskId: ids.solidworks, path: parameterPath, content: secondParameters, expectedVersion: liveParameters.version });
  await submit(ids.solidworks, [parameterPath]);
  const second = {}; second.solidworks = await complete(ids.solidworks); second.autocad = await complete(ids.autocad);
  assert.equal((await task(ids.geometry)).state, 'recheck'); second.geometry = await complete(ids.geometry);
  second.ansys = await complete(ids.ansys); second.verification = await complete(ids.verification);
  assert.equal((await task(ids.simulation)).state, 'recheck'); second.simulation = await complete(ids.simulation);
  assert.equal((await task(ids.assembly)).state, 'recheck'); second.assembly = await complete(ids.assembly);
  assert.equal((await task(ids.delivery)).state, 'recheck'); second.delivery = await complete(ids.delivery);
  assert.deepEqual(second.delivery.inputs, [{ taskId: ids.assembly, snapshotId: second.assembly.id }]);
  for (const snapshot of originalSnapshots) assert.deepEqual((await app.json(query('snapshot/manifest', { taskId: snapshot.taskId, snapshotId: snapshot.id }))).snapshot, snapshot);
  assert.equal((await app.json(query('snapshot/preview', { taskId: ids.solidworks, snapshotId: first.solidworks.id, path: parameterPath }))).content, firstParameters.content);
  assert.equal((await app.json(query('snapshot/preview', { taskId: ids.solidworks, snapshotId: second.solidworks.id, path: parameterPath }))).content, secondParameters);
  evidence.checks.predecessorModificationPropagatesRecheck = true; evidence.checks.immutableHistoricalBytesAndReferences = true;

  const finalGraph = await app.json(query('graph', { projectId: demo.project.id })); assert.ok(finalGraph.tasks.every(row => row.state === 'completed'));
  const savedDocuments = await Promise.all(evidence.software.map(async row => ({ imageId: row.imageId, taskId: row.taskId, seat: (await app.json(query('software/seat', { taskId: row.taskId, imageId: row.imageId }))).seat })));
  await app.stop(); app = await startDemoApp(home); const recovered = await seedDemo(app);
  assert.equal(recovered.reused, true); assert.deepEqual(await app.json(query('graph', { projectId: demo.project.id })), finalGraph);
  assert.equal((await readFile(ids.solidworks, notePath)).content, editedNote); assert.equal((await readFile(ids.solidworks, parameterPath)).content, secondParameters);
  for (const { imageId, taskId, seat } of savedDocuments) { const restored = (await app.json(query('software/seat', { taskId, imageId }))).seat; assert.equal(restored.id, seat.id); assert.deepEqual(restored.document, seat.document); assert.equal(restored.control, null); }
  for (const snapshot of [...originalSnapshots, ...Object.values(second)]) assert.deepEqual((await app.json(query('snapshot/manifest', { taskId: snapshot.taskId, snapshotId: snapshot.id }))).snapshot, snapshot);
  assert.deepEqual((await app.json('status')).chats, []); assert.equal((await app.json('projects')).length, 1);
  evidence.checks.restartRestoresGraphFilesSnapshotsAndMockDocuments = true;
  evidence.projectId = demo.project.id; evidence.tasks = demo.tasks.map(row => ({ key: row.key, id: row.id, code: row.code })); evidence.passed = true;
  await writeFile(join(root, '.studio', 'm6-demo-acceptance.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  console.log('M6 normal-profile acceptance passed: isolated model-free manual workflow, exact eight-node nested DAG, idempotent seed preserving user edits, three explicitly selected Mock images, optional immutable submissions and explicit no-file confirmation, per-level human completion, predecessor recheck chain, unchanged historical snapshots, and real restart recovery. No smoke Provider, external model or user preview data; confirmation requests are test-only human simulations. Sanitized evidence: .studio/m6-demo-acceptance.json');
} finally {
  try { if (app) await app.stop(); }
  finally { await release(home); await rm(home, { recursive: true, force: true }); }
}
