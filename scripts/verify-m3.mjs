import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { root } from './prepare.mjs';
import { startApp, stopApp, finishedChat } from './verify-app.mjs';

// Every request and child process belongs to this disposable test home.
await mkdir(join(root, '.studio'), { recursive: true });
const home = await mkdtemp(join(root, '.studio/m3-http-test-'));
let app;
const query = (route, fields) => `software/${route}?${new URLSearchParams(fields)}`;
const requestId = () => `m3-${randomUUID()}`;
const drawingImage = 'mock-solidworks', simulationImage = 'mock-ansys', draftingImage = 'mock-autocad';
const imageIds = [drawingImage, simulationImage, draftingImage];
const softwareTools = ['studio_software_catalog', 'studio_software_status', 'studio_software_launch', 'studio_software_control', 'studio_software_invoke', 'studio_software_operation', 'studio_software_cancel', 'studio_software_save_artifact'];

async function startFixture() {
  const previous = process.env.STUDIO_MOCK_SEAT_MAX_SEATS;
  process.env.STUDIO_MOCK_SEAT_MAX_SEATS = '16';
  try { return await startApp(home); }
  finally { if (previous === undefined) delete process.env.STUDIO_MOCK_SEAT_MAX_SEATS; else process.env.STUDIO_MOCK_SEAT_MAX_SEATS = previous; }
}

async function until(read, ready, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const value = await read();
    if (ready(value)) return value;
    await delay(30);
  }
  throw new Error(message);
}
async function seats(taskId) { return (await app.json(query('seats', { taskId }))).seats; }
async function seat(taskId, imageId = drawingImage) { return (await app.json(query('seat', { taskId, imageId }))).seat; }
async function readySeat(taskId, imageId = drawingImage) {
  return until(() => seat(taskId, imageId), value => value?.state === 'ready', 'Mock Seat did not become ready');
}
async function control(taskId, action, extra = {}, imageId = drawingImage) {
  return (await app.json('software/control', { taskId, imageId, action, ...extra })).seat;
}
async function operation(taskId, id, imageId = drawingImage) {
  return (await app.json(query('operation', { taskId, imageId, operationId: id }))).operation;
}
async function invoke(taskId, capability, parameters, expectedDocumentRevision, imageId = drawingImage) {
  const { operation: started, imageId: selected } = await app.json('software/invoke', { taskId, imageId, requestId: requestId(), capability, parameters,
    ...(expectedDocumentRevision === undefined ? {} : { expectedDocumentRevision }) });
  assert.equal(selected, imageId, 'Invoke must preserve the explicitly selected image for operation polling');
  return until(() => operation(taskId, started.id, imageId), value => ['succeeded', 'failed', 'canceled', 'unknown'].includes(value.state), 'Mock bridge operation did not settle');
}
async function platformResponse(path, body, method = body === undefined ? 'GET' : 'POST') {
  // Only private configuration from this newly created fixture is read. Never print its token.
  const { url } = JSON.parse(await readFile(join(home, 'mock-seat/runtime.json'), 'utf8'));
  const token = (await readFile(join(home, 'mock-seat/token'), 'utf8')).trim();
  return fetch(`${url}${path}`, { method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function platform(path, body, method) {
  const response = await platformResponse(path, body, method);
  assert.equal(response.status, 200, 'Private fixture platform request failed');
  return response.json();
}
function publicSeat(value, task, project) {
  assert.equal(value.taskId, task.id); assert.equal(value.projectId, project.id);
  assert.equal(value.apiVersion, '1'); assert.equal(value.mock, true); assert.equal(value.software.mock, true);
  assert.deepEqual(Object.keys(value.connection).sort(), ['display', 'eventsPath', 'protocol']);
  if (value.control) assert.deepEqual(Object.keys(value.control).sort(), ['actor', 'expiresAt', 'ownerId', 'revision']);
  assert.ok(!/"(?:token|controlToken|credential)"\s*:/u.test(JSON.stringify(value)), 'Browser Seat JSON must not expose platform or control credentials');
}
async function proxyRefresh(taskId, seatId) {
  const path = query('events', { taskId, imageId: drawingImage });
  const nativeSeat = await platform(`/v1/seats/${seatId}`), connection = await platform(`/v1/seats/${seatId}/connection`);
  const response = await fetch(`${app.base}/api/studio/${path}`, { headers: { origin: app.base } });
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('No anonymous same-origin software refresh event received')), 10000); });
  try {
    while (!buffer.includes('\n\n')) {
      const row = await Promise.race([reader.read(), timeout]);
      assert.equal(row.done, false, 'Software stream ended before a refresh event');
      buffer += decoder.decode(row.value, { stream: true });
    }
    const record = buffer.slice(0, buffer.indexOf('\n\n'));
    assert.match(record, /^event: refresh\ndata: \{\}$/u);
    assert.deepEqual(JSON.parse(record.slice(record.indexOf('data: ') + 6)), {}, 'The proxy must emit refresh notifications without upstream Seat or connection data');
    for (const secret of [nativeSeat.control?.token, connection.credential]) if (secret) assert.ok(!buffer.includes(secret), 'The software proxy must not expose control tokens or connection tickets');
  } finally { clearTimeout(timer); await reader.cancel(); reader.releaseLock(); }
  assert.equal((await seat(taskId)).state, 'ready', 'Closing a browser stream must not release the task Seat');
}
async function denied(path, body, message) { assert.equal((await app.call(path, body)).status, 400, message); }
async function capabilityDenied(taskId, imageId, capability, parameters, revision) {
  const before = (await seat(taskId, imageId)).document;
  const response = await app.call('software/invoke', { taskId, imageId, requestId: requestId(), capability, parameters, expectedDocumentRevision: revision });
  const result = await response.json();
  if (response.status === 200) {
    const failed = await until(() => operation(taskId, result.operation.id, imageId), value => ['failed', 'succeeded'].includes(value.state), 'An unsupported capability did not settle');
    assert.equal(failed.state, 'failed', 'A capability from another image must never execute');
    assert.equal(failed.error.code, 'CAPABILITY_NOT_SUPPORTED');
  } else {
    assert.equal(response.status, 400, 'Unsupported image capabilities must fail at the controlled boundary');
    assert.match(result.error, /CAPABILITY_NOT_SUPPORTED/u, 'A revision or ownership failure must not masquerade as capability isolation');
  }
  assert.deepEqual((await seat(taskId, imageId)).document, before, 'An unsupported capability must not mutate the selected image document');
}
async function release(path) {
  const info = await lstat(path); if (info.isSymbolicLink()) return;
  if (info.isDirectory()) { await chmod(path, 0o700); for (const name of await readdir(path)) await release(join(path, name)); }
  else await chmod(path, 0o600);
}

try {
  app = await startFixture();
  await until(() => app.call('software/catalog'), value => value.status === 200, 'Software plugin routes did not become ready');
  assert.equal((await fetch(`${app.base}/api/studio/software/catalog`)).status, 200);
  assert.equal((await fetch(`${app.base}/api/studio/software/seat`, { method: 'POST', headers: { origin: app.base, 'content-type': 'application/json' },
    body: JSON.stringify({ taskId: 'unknown', softwareId: 'mock-cad', requestId: requestId() }) })).status, 400);
  const { url: fixturePlatformUrl } = JSON.parse(await readFile(join(home, 'mock-seat/runtime.json'), 'utf8'));
  assert.equal((await fetch(`${fixturePlatformUrl}/v1/images`)).status, 401, 'Anonymous browser access must not remove platform service authentication');
  const { images, software } = await app.json('software/catalog');
  assert.deepEqual(images.map(item => item.id).sort(), [...imageIds].sort());
  assert.deepEqual(software, images, 'The compatibility catalog must retain the installed image list');
  assert.deepEqual((await platform('/v1/images')).images, images);
  assert.ok(images.every(item => item.mock === true && typeof item.imageRef === 'string' && item.imageRef.length > 0));
  const cad = images.find(item => item.id === drawingImage);
  assert.ok(cad); assert.equal(cad.mock, true);
  assert.ok(cad.capabilities.some(item => item.mutates), 'Mock software must declare an editable bridge capability');
  const status = await app.json('status');
  assert.ok(softwareTools.every(name => status.tools.includes(name)), 'Every restricted software tool must be registered with the native runtime');
  const project = await app.json('projects', { title: 'M3 Mock Seat 隔离集成验证' });
  const otherProject = await app.json('projects', { title: 'M3 独立项目' });
  const task = await app.json('task/quick', { projectId: project.id, title: '受控 Mock CAD 文档' });
  const otherTask = await app.json('task/quick', { projectId: otherProject.id, title: '跨项目隔离任务' });
  assert.equal(await seat(task.id), null); assert.equal(await seat(otherTask.id), null);
  await denied('software/control', { taskId: task.id, imageId: drawingImage, action: 'acquire' }, 'Control must not silently launch a default CAD image');
  assert.deepEqual(await seats(task.id), []);
  await denied('software/seat', { taskId: task.id, imageId: 'unknown', requestId: requestId() }, 'Unknown images must not allocate a Seat');
  assert.deepEqual(await seats(task.id), []);
  const allocationId = requestId();
  const allocation = await app.json('software/seat', { taskId: task.id, softwareId: 'mock-cad', requestId: allocationId });
  const allocated = await readySeat(task.id);
  assert.equal(allocated.softwareId, drawingImage, 'Legacy mock-cad must resolve to the canonical SolidWorks Mock image');
  publicSeat(allocated, task, project);
  assert.equal((await app.json('software/seat', { taskId: task.id, softwareId: 'mock-cad', requestId: allocationId })).seat.id, allocation.seat.id, 'Allocation retries must not create a second Seat');
  assert.equal(await seat(otherTask.id), null, 'Allocating a Seat must not affect another task');
  await app.json('software/seat', { taskId: otherTask.id, imageId: drawingImage, requestId: requestId() });
  const other = await readySeat(otherTask.id);
  publicSeat(other, otherTask, otherProject); assert.notEqual(other.id, allocated.id);
  const held = await control(task.id, 'acquire');
  publicSeat(held, task, project); assert.equal(held.control.actor, 'human');
  await proxyRefresh(task.id, held.id);
  await app.json('software/recorder', { taskId: task.id, imageId: drawingImage, enabled: true });
  const added = await invoke(task.id, 'shape.add', { kind: 'rectangle', x: 5, y: 7, width: 20, height: 12, label: 'M3 controlled shape' }, held.document.revision);
  assert.equal(added.state, 'succeeded'); assert.equal(typeof added.result.shapeId, 'string');
  const edited = await seat(task.id);
  assert.equal(edited.document.revision, held.document.revision + 1);
  assert.equal(edited.document.shapes.length, 1); assert.equal(edited.document.shapes[0].label, 'M3 controlled shape');
  assert.deepEqual((await seat(otherTask.id)).document.shapes, [], 'Editing one Seat must not modify another project\'s document');
  await denied(query('operation', { taskId: otherTask.id, imageId: drawingImage, operationId: added.id }), undefined, 'Operations must remain bound to their own task Seat');

  const conflict = await app.call('software/invoke', { taskId: task.id, imageId: drawingImage, requestId: requestId(), capability: 'shape.add',
    parameters: { kind: 'circle', x: 0, y: 0, width: 10, height: 10, label: 'stale revision must fail' }, expectedDocumentRevision: held.document.revision });
  const conflictBody = await conflict.json();
  if (conflict.status === 200) {
    const result = await until(() => operation(task.id, conflictBody.operation.id), value => ['failed', 'succeeded'].includes(value.state), 'CAS conflict did not settle');
    assert.equal(result.state, 'failed'); assert.match(result.error.code, /REVISION|CONFLICT/);
  } else { assert.equal(conflict.status, 400); assert.match(JSON.stringify(conflictBody), /revision|版本|冲突|CONFLICT/i); }
  assert.deepEqual((await seat(task.id)).document, edited.document, 'A stale document revision must not write anything');

  const { operation: cancelTarget } = await app.json('software/invoke', { taskId: task.id, imageId: drawingImage, requestId: requestId(), capability: 'shape.add',
    parameters: { kind: 'rectangle', x: 30, y: 0, width: 10, height: 8, label: 'canceled shape' }, expectedDocumentRevision: edited.document.revision });
  await app.json('software/cancel', { taskId: task.id, imageId: drawingImage, operationId: cancelTarget.id });
  const canceled = await until(() => operation(task.id, cancelTarget.id), value => value.state === 'canceled', 'Canceled operation did not settle');
  assert.equal(canceled.state, 'canceled');
  assert.deepEqual((await seat(task.id)).document, edited.document, 'A canceled operation must not mutate its document');

  const exported = await invoke(task.id, 'document.export', { format: 'svg', name: 'm3-controlled.svg' }, edited.document.revision);
  assert.equal(exported.state, 'succeeded'); assert.equal(typeof exported.result.artifactId, 'string');
  await denied('software/artifact', { taskId: otherTask.id, imageId: drawingImage, artifactId: exported.result.artifactId }, 'Artifacts must not cross project/task Seat boundaries');
  const saved = await app.json('software/artifact', { taskId: task.id, imageId: drawingImage, artifactId: exported.result.artifactId });
  const file = await app.json(`file?${new URLSearchParams({ taskId: task.id, path: saved.path })}`);
  assert.equal(typeof file.content, 'string'); assert.equal(file.version, saved.version); assert.match(file.content, /<svg/); assert.match(file.content, /M3 controlled shape/);
  const artifact = await platform(`/v1/seats/${allocated.id}/artifacts/${exported.result.artifactId}`);
  assert.equal(file.content, artifact.content); assert.equal(saved.version, artifact.sha256);
  const { records } = await app.json(query('records', { taskId: task.id, imageId: drawingImage }));
  assert.ok(records.some(row => row.operationId === added.id), 'Enabled recorder must retain the actual bridge operation');
  assert.ok(records.every(row => typeof row.timestamp === 'string' && Number.isSafeInteger(row.sequence)));
  await app.json('software/recorder', { taskId: task.id, imageId: drawingImage, enabled: false });
  assert.equal((await seat(task.id)).recorderEnabled, false);
  const imageAllocations = [{ imageId: drawingImage, seatId: allocated.id, requestId: allocationId }];
  for (const imageId of [simulationImage, draftingImage]) {
    const createRequest = requestId();
    await app.json('software/seat', { taskId: task.id, imageId, requestId: createRequest });
    const launched = await readySeat(task.id, imageId); publicSeat(launched, task, project);
    assert.equal(launched.softwareId, imageId);
    assert.equal((await app.json('software/seat', { taskId: task.id, imageId, requestId: createRequest })).seat.id, launched.id);
    imageAllocations.push({ imageId, seatId: launched.id, requestId: createRequest });
  }
  assert.equal(new Set((await seats(task.id)).map(value => value.id)).size, 3, 'Each installed image must have its own Seat in one task');
  const multiple = await app.json(query('seat', { taskId: task.id }));
  assert.equal(multiple.seat, null); assert.equal(multiple.seats.length, 3, 'A multi-image status must not silently select an application');
  for (const [path, body] of [
    ['software/control', { taskId: task.id, action: 'acquire' }],
    ['software/invoke', { taskId: task.id, requestId: requestId(), capability: 'document.inspect', parameters: {}, expectedDocumentRevision: edited.document.revision }],
    [query('operation', { taskId: task.id, operationId: added.id }), undefined],
    ['software/cancel', { taskId: task.id, operationId: added.id }],
    ['software/artifact', { taskId: task.id, artifactId: exported.result.artifactId }],
    ['software/release', { taskId: task.id, confirm: true }],
  ]) await denied(path, body, 'A multi-image request must require an explicit image selection');

  const analysisControl = await control(task.id, 'acquire', {}, simulationImage);
  const draftingControl = await control(task.id, 'acquire', {}, draftingImage);
  assert.equal(analysisControl.control.actor, 'human'); assert.equal(draftingControl.control.actor, 'human');
  assert.equal((await seat(task.id)).control.actor, 'human', 'Acquiring another image must retain the drawing image control');
  await control(task.id, 'release', {}, simulationImage);
  assert.equal((await seat(task.id, simulationImage)).control, null);
  assert.equal((await seat(task.id, draftingImage)).control.actor, 'human'); assert.equal((await seat(task.id)).control.actor, 'human');
  await control(task.id, 'acquire', {}, simulationImage);
  await capabilityDenied(task.id, simulationImage, 'shape.add', { kind: 'circle', x: 0, y: 0, width: 2, height: 2 }, analysisControl.document.revision);
  await capabilityDenied(task.id, drawingImage, 'analysis.run', {}, edited.document.revision);
  const configured = await invoke(task.id, 'analysis.configure', { type: 'static', loadN: 120, elasticModulusMPa: 210000, meshSizeMm: 5 }, analysisControl.document.revision, simulationImage);
  assert.equal(configured.state, 'succeeded');
  const analyzed = await invoke(task.id, 'analysis.run', {}, configured.result.documentRevision, simulationImage);
  assert.equal(analyzed.state, 'succeeded');
  const analysisSeat = await seat(task.id, simulationImage);
  assert.deepEqual(analysisSeat.document.shapes, []); assert.equal(analysisSeat.document.analysis.result.mock, true);
  assert.ok(Number.isFinite(analysisSeat.document.analysis.result.maxDisplacementMm));
  const drafted = await invoke(task.id, 'shape.add', { kind: 'circle', x: 10, y: 15, width: 25, height: 25, label: 'isolated AutoCAD Mock shape' }, draftingControl.document.revision, draftingImage);
  assert.equal(drafted.state, 'succeeded');
  const draftingSeat = await seat(task.id, draftingImage);
  assert.equal(draftingSeat.document.shapes.length, 1);
  assert.deepEqual((await seat(task.id)).document, edited.document, 'Other image operations must not change the SolidWorks Mock document');
  const analysisExport = await invoke(task.id, 'document.export', { format: 'json', name: 'm3-analysis.json' }, analysisSeat.document.revision, simulationImage);
  assert.equal(analysisExport.state, 'succeeded');
  await denied(query('operation', { taskId: task.id, imageId: draftingImage, operationId: analyzed.id }), undefined, 'Operation identities must not cross image boundaries within a task');
  await denied('software/artifact', { taskId: task.id, imageId: draftingImage, artifactId: analysisExport.result.artifactId }, 'Artifacts must remain bound to their producing image');
  const analysisSaved = await app.json('software/artifact', { taskId: task.id, imageId: simulationImage, artifactId: analysisExport.result.artifactId });
  const analysisFile = await app.json(`file?${new URLSearchParams({ taskId: task.id, path: analysisSaved.path })}`);
  const analysisArtifact = JSON.parse(analysisFile.content), analysisDocument = analysisArtifact.document;
  assert.equal(analysisArtifact.mock, true);
  assert.equal(analysisDocument.analysis.result.mock, true); assert.deepEqual(analysisDocument.shapes, []);
  assert.equal(analysisFile.version, analysisSaved.version);
  const retiredDrafting = imageAllocations.find(value => value.imageId === draftingImage);
  await app.json('software/release', { taskId: task.id, imageId: draftingImage, confirm: true });
  assert.equal(await seat(task.id, draftingImage), null); assert.equal((await seats(task.id)).length, 2);
  assert.equal((await platform(`/v1/seats/${retiredDrafting.seatId}`)).state, 'released');
  const staleLaunch = await app.call('software/seat', { taskId: task.id, imageId: draftingImage, requestId: retiredDrafting.requestId });
  assert.equal(staleLaunch.status, 400); assert.match((await staleLaunch.json()).error, /新.*requestId/u);
  assert.equal(await seat(task.id, draftingImage), null, 'An old release ACK must not leave a broken Seat mapping');
  const replacementRequest = requestId();
  await app.json('software/seat', { taskId: task.id, imageId: draftingImage, requestId: replacementRequest });
  const replacementDrafting = await readySeat(task.id, draftingImage);
  assert.notEqual(replacementDrafting.id, retiredDrafting.seatId); assert.deepEqual(replacementDrafting.document.shapes, []);
  imageAllocations.push({ imageId: draftingImage, seatId: replacementDrafting.id, requestId: replacementRequest });
  assert.equal((await seats(task.id)).length, 3);
  assert.deepEqual((await seat(task.id)).document, edited.document); assert.deepEqual((await seat(task.id, simulationImage)).document, analysisSeat.document);
  assert.equal((await seat(task.id)).control.actor, 'human'); assert.equal((await seat(task.id, simulationImage)).control.actor, 'human', 'Releasing one image must preserve the other image control fences');
  await control(task.id, 'acquire', {}, draftingImage);
  await control(otherTask.id, 'acquire');

  await stopApp(app.child); app = undefined;
  app = await startFixture();
  await until(() => app.call('software/catalog'), value => value.status === 200, 'Restarted software routes did not become ready');
  const recovered = await readySeat(task.id), recoveredOther = await readySeat(otherTask.id);
  assert.equal(recovered.id, allocated.id); assert.equal(recoveredOther.id, other.id);
  assert.deepEqual(recovered.document, edited.document, 'Restart must recover the task Seat mapping and saved document');
  assert.equal(recovered.control, null); assert.equal(recoveredOther.control, null, 'Control leases must not survive process restart');
  const allRecovered = await seats(task.id);
  assert.equal(allRecovered.length, 3); assert.ok(allRecovered.every(value => value.control === null));
  assert.deepEqual((await seat(task.id, simulationImage)).document, analysisSeat.document);
  assert.equal((await seat(task.id, draftingImage)).id, replacementDrafting.id);
  assert.deepEqual((await seat(task.id, draftingImage)).document, replacementDrafting.document);
  assert.ok(recovered.artifacts.some(row => row.id === exported.result.artifactId));
  assert.equal((await app.json(`file?${new URLSearchParams({ taskId: task.id, path: saved.path })}`)).content, file.content);

  const nativeTask = await app.json('task/quick', { projectId: project.id, title: 'DSH 原生软件工具验证' });
  const unknownNative = await app.json('chat', { taskId: nativeTask.id, provider: 'studio-smoke', model: 'm1-smoke',
    message: `[project-files-task] ${JSON.stringify({ scope: 'task', calls: [{ name: 'studio_software_launch', args: { imageId: 'unknown', requestId: requestId() } }] })}` });
  const unknownHistory = await finishedChat(app, unknownNative.id);
  assert.equal(unknownHistory.events.find(event => event.type === 'tool/result').data.message.isError, true);
  assert.deepEqual(await seats(nativeTask.id), [], 'An invalid native image choice must not create a default Seat');
  for (const imageId of imageIds) {
    const nativeChat = await app.json('chat', { taskId: nativeTask.id, provider: 'studio-smoke', model: 'm1-smoke', message: `[software-ui] ${JSON.stringify({ imageId })}` });
    const history = await finishedChat(app, nativeChat.id), calls = history.events.filter(event => event.type === 'tool/call');
    const businessCalls = calls.filter((event, index) => index < 2 || event.data.name !== 'studio_software_status');
    assert.deepEqual(businessCalls.map(event => event.data.name), ['studio_software_catalog', 'studio_software_status', 'studio_software_launch', 'studio_software_control', 'studio_software_invoke', 'studio_software_operation',
      ...(imageId === simulationImage ? ['studio_software_invoke', 'studio_software_operation'] : []), 'studio_software_invoke', 'studio_software_operation', 'studio_software_save_artifact', 'studio_software_control']);
    const allResults = calls.map(call => history.events.find(event => event.type === 'tool/result' && event.data.message.source.callId === call.data.callId));
    assert.ok(allResults.every(result => result && !result.data.message.isError), 'Native image provisioning polls and business tools must all succeed');
    const results = businessCalls.map(call => history.events.find(event => event.type === 'tool/result' && event.data.message.source.callId === call.data.callId));
    assert.ok(results.every(result => result && !result.data.message.isError), 'Every explicitly selected native image tool must succeed');
    const initialStatus = JSON.parse(results[1].data.message.content.filter(block => block.type === 'text').map(block => block.text).join(''));
    assert.equal(initialStatus.seats.length, imageIds.indexOf(imageId), 'Native status without an image must list every previously launched task Seat');
    if (initialStatus.seats.length !== 1) assert.equal(initialStatus.seat, null);
    for (const call of calls.slice(2)) assert.equal(JSON.parse(call.data.arguments).imageId, imageId, 'Native write, poll and export calls must retain their selected image');
    const nativeSeat = await seat(nativeTask.id, imageId); assert.equal(nativeSeat.softwareId, imageId); assert.equal(nativeSeat.control, null);
    const launchReceipt = JSON.parse(results[2].data.message.content.filter(block => block.type === 'text').map(block => block.text).join(''));
    assert.equal(nativeSeat.id, launchReceipt.seat.id);
    if (imageId === simulationImage) { assert.deepEqual(nativeSeat.document.shapes, []); assert.equal(nativeSeat.document.analysis.result.mock, true); }
    else { assert.equal(nativeSeat.document.shapes.length, 1); assert.match(nativeSeat.document.shapes[0].label, new RegExp(imageId)); }
    const nativeSave = JSON.parse(results.at(-2).data.message.content.filter(block => block.type === 'text').map(block => block.text).join(''));
    const savedFile = await app.json(`file?${new URLSearchParams({ taskId: nativeTask.id, path: nativeSave.path })}`);
    const savedArtifact = JSON.parse(savedFile.content);
    assert.equal(savedFile.version, nativeSave.version); assert.equal(savedArtifact.mock, true); assert.deepEqual(savedArtifact.document, nativeSeat.document);
  }
  assert.equal((await seats(nativeTask.id)).length, 3, 'Native image selection must launch all three isolated task Seats');
  assert.ok((await seats(nativeTask.id)).every(value => value.control === null));

  const stoppedTask = await app.json('task/quick', { projectId: project.id, title: '停止原生 Agent 的真实外部写入' });
  await app.json('software/seat', { taskId: stoppedTask.id, imageId: drawingImage, requestId: requestId() });
  const stoppedSeat = await readySeat(stoppedTask.id), slowDelay = 2000;
  await platform(`/v1/seats/${stoppedSeat.id}/fault`, { mode: 'none', delayMs: slowDelay });
  try {
    const stoppedChat = await app.json('chat', { taskId: stoppedTask.id, provider: 'studio-smoke', model: 'm1-smoke',
      message: '[software-ui] Stop the actual native Agent during a delayed Mock document write' });
    const inFlight = await until(() => platform(`/v1/seats/${stoppedSeat.id}/operations`), value => value.operations.some(row => row.capability === 'shape.add' && ['queued', 'running'].includes(row.state)), 'No real delayed native shape operation observed');
    const slowOperation = inFlight.operations.find(row => row.capability === 'shape.add' && ['queued', 'running'].includes(row.state));
    assert.equal((await seat(stoppedTask.id)).control.actor, 'agent', 'The native conversation must own the actual external write');
    await app.json('chat/stop', { id: stoppedChat.id });
    const stoppedHistory = await finishedChat(app, stoppedChat.id);
    assert.ok(stoppedHistory.events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'aborted'));
    await until(() => seat(stoppedTask.id), value => value.control === null, 'Stopping the native Agent did not release its platform control fence');
    await until(() => operation(stoppedTask.id, slowOperation.id), value => value.state === 'canceled', 'Stopping the native Agent did not cancel its real external operation');
    // A normal delayed write would succeed without cancellation; wait beyond its original timer.
    await delay(slowDelay + 150);
    assert.deepEqual((await seat(stoppedTask.id)).document, stoppedSeat.document, 'A stopped native Agent must not leave a late external document mutation');
  } finally { await platform(`/v1/seats/${stoppedSeat.id}/fault`, { mode: 'none' }); }

  // A later grant for the same conversation owner is still a different fence.
  // Keep the old turn open on a real unanswered question after replacing its lease.
  const renewedRequestId = requestId();
  let renewedLease;
  await platform(`/v1/seats/${stoppedSeat.id}/fault`, { mode: 'none', delayMs: slowDelay });
  try {
    const renewedCalls = [
      { name: 'studio_software_control', args: { imageId: drawingImage, action: 'acquire' } },
      { name: 'studio_software_invoke', args: { imageId: drawingImage, requestId: renewedRequestId, capability: 'shape.add', parameters: JSON.stringify({ kind: 'rectangle', x: 0, y: 0, width: 2, height: 2, label: 'superseded native fence' }), expectedDocumentRevision: stoppedSeat.document.revision } },
      { name: 'ask_user_question', args: { questions: [{ id: 'hold_old_turn', question: '保持隔离测试回合等待；验证旧控制权取消不影响新控制权。' }] } },
    ];
    const renewedChat = await app.json('chat', { taskId: stoppedTask.id, provider: 'studio-smoke', model: 'm1-smoke',
      message: `[project-files-task] ${JSON.stringify({ scope: 'task', calls: renewedCalls })}` });
    const inFlight = await until(() => platform(`/v1/seats/${stoppedSeat.id}/operations`), value => value.operations.some(row => row.requestId === renewedRequestId && ['queued', 'running'].includes(row.state)), 'No native operation observed before replacing its control grant');
    const superseded = inFlight.operations.find(row => row.requestId === renewedRequestId);
    const oldLease = (await platform(`/v1/seats/${stoppedSeat.id}`)).control;
    assert.equal(oldLease.actor, 'agent');
    renewedLease = await platform(`/v1/seats/${stoppedSeat.id}/control`, { actor: oldLease.actor, ownerId: oldLease.ownerId, ttlMs: 60000 });
    assert.ok(renewedLease.token !== oldLease.token, 'A replacement grant must have a new private control token');
    assert.equal(renewedLease.revision, oldLease.revision + 1);
    assert.equal(renewedLease.actor, oldLease.actor); assert.equal(renewedLease.ownerId, oldLease.ownerId);
    await until(() => app.json(`chat/questions?id=${renewedChat.id}`), value => value.pending.some(row => row.canAnswer), 'The superseded native turn did not reach its question wait');
    const waiting = await app.json(`chat?id=${renewedChat.id}`);
    assert.notEqual(waiting.status, 'idle');
    assert.ok(!waiting.events.some(event => event.type === 'turn/end'), 'The old native turn must still be active before stopping it');
    await app.json('chat/stop', { id: renewedChat.id });
    const stopped = await finishedChat(app, renewedChat.id);
    assert.ok(stopped.events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'aborted'));
    assert.equal((await operation(stoppedTask.id, superseded.id)).state, 'canceled');
    // Abort cleanup is asynchronous. Observe beyond the old worker timer, then
    // verify the current lease by token as well as owner, without exposing tokens.
    await delay(slowDelay + 150);
    const afterStop = await platform(`/v1/seats/${stoppedSeat.id}`);
    assert.ok(afterStop.control?.token === renewedLease.token, 'Stopping an old native turn must preserve a newer grant for the same owner');
    assert.equal(afterStop.control.revision, renewedLease.revision);
    assert.equal(afterStop.control.actor, renewedLease.actor); assert.equal(afterStop.control.ownerId, renewedLease.ownerId);
    assert.deepEqual(afterStop.document, stoppedSeat.document, 'A superseded native fence must not leave a late document mutation');
  } finally {
    const cleanup = await Promise.allSettled([
      renewedLease ? platformResponse(`/v1/seats/${stoppedSeat.id}/control`, { token: renewedLease.token }, 'DELETE').then(async response => {
        await response.body?.cancel();
        assert.ok([200, 409].includes(response.status), 'Replacement control grant cleanup failed');
      }) : Promise.resolve(),
      platform(`/v1/seats/${stoppedSeat.id}/fault`, { mode: 'none' }),
    ]);
    for (const result of cleanup) if (result.status === 'rejected') throw result.reason;
  }

  // Reuse the deterministic arbitrary-call fixture to exercise every forbidden task-only tool.
  const projectCalls = softwareTools.filter(name => name !== 'studio_software_catalog').map(name => ({ name, args: {
    studio_software_status: {}, studio_software_launch: { imageId: drawingImage, requestId: requestId() }, studio_software_control: { imageId: drawingImage, action: 'acquire' },
    studio_software_invoke: { imageId: drawingImage, requestId: requestId(), capability: 'shape.add', parameters: JSON.stringify({ kind: 'rectangle', x: 0, y: 0, width: 1, height: 1, label: 'forbidden project write' }), expectedDocumentRevision: 0 },
    studio_software_operation: { imageId: drawingImage, operationId: added.id }, studio_software_cancel: { imageId: drawingImage, operationId: added.id },
    studio_software_save_artifact: { imageId: drawingImage, artifactId: exported.result.artifactId },
  }[name] }));
  const forbiddenChat = await app.json('chat', { projectId: project.id, provider: 'studio-smoke', model: 'm1-smoke',
    message: `[project-files-project] ${JSON.stringify({ scope: 'project', calls: projectCalls })}` });
  const forbiddenHistory = await finishedChat(app, forbiddenChat.id);
  const forbiddenCalls = forbiddenHistory.events.filter(event => event.type === 'tool/call');
  assert.deepEqual(forbiddenCalls.map(event => event.data.name), projectCalls.map(call => call.name));
  for (const call of forbiddenCalls) assert.equal(forbiddenHistory.events.find(event => event.type === 'tool/result' && event.data.message.source.callId === call.data.callId).data.message.isError, true);
  assert.ok((await seats(nativeTask.id)).every(value => value.control === null), 'Project tool calls must not acquire any task image control lease');

  const freezeOperations = [], freezeDelay = 4000;
  for (const imageId of imageIds) {
    const held = await control(task.id, 'acquire', {}, imageId);
    await platform(`/v1/seats/${held.id}/fault`, { mode: 'none', delayMs: freezeDelay });
    const { operation: queued } = await app.json('software/invoke', { taskId: task.id, imageId, requestId: requestId(),
      capability: imageId === simulationImage ? 'analysis.run' : 'shape.add',
      parameters: imageId === simulationImage ? {} : { kind: 'rectangle', x: 0, y: 0, width: 1, height: 1, label: 'must stop when all images freeze' }, expectedDocumentRevision: held.document.revision });
    assert.ok(['queued', 'running'].includes(queued.state), 'Every image producer must still be in flight before freezing');
    freezeOperations.push({ imageId, id: queued.id, document: held.document });
  }
  const preview = await app.json(`task/completion?${new URLSearchParams({ taskId: task.id })}`);
  const submission = await app.json('task/completion/files', { taskId: task.id, revision: preview.taskRevision, workspaceVersion: preview.workspaceVersion,
    files: [{ path: saved.path, description: 'M3 受控 Mock CAD 导出；不代表真实 CAD 工程成果' }] });
  for (const pending of freezeOperations) assert.ok(['queued', 'running'].includes((await operation(task.id, pending.id, pending.imageId)).state), 'All three producers must still be active at human completion confirmation');
  const completion = await app.json('task/completion', { taskId: task.id, revision: submission.taskRevision, workspaceVersion: submission.workspaceVersion,
    checkedGoalIds: submission.goals.filter(goal => !goal.system).map(goal => goal.id), submissionId: submission.submittedFiles.id });
  assert.equal(completion.task.state, 'completed'); assert.ok((await seats(task.id)).every(value => value.control === null), 'Task freezing must release control for every image');
  for (const pending of freezeOperations) await until(() => operation(task.id, pending.id, pending.imageId), value => value.state === 'canceled', 'Task freezing must cancel every image producer');
  await delay(freezeDelay + 150);
  for (const pending of freezeOperations) assert.deepEqual((await seat(task.id, pending.imageId)).document, pending.document, 'An image producer must not mutate its document after task freezing');
  for (const imageId of imageIds) await denied('software/control', { taskId: task.id, imageId, action: 'acquire' }, 'Completed tasks cannot regain any image write control');
  await denied('software/seat', { taskId: task.id, imageId: drawingImage, requestId: requestId() }, 'Completed tasks cannot launch another software producer');
  await denied('software/invoke', { taskId: task.id, imageId: drawingImage, requestId: requestId(), capability: 'shape.add',
    parameters: { kind: 'rectangle', x: 0, y: 0, width: 5, height: 5, label: 'frozen write' }, expectedDocumentRevision: edited.document.revision }, 'Completed tasks must reject software document writes');
  await denied('software/artifact', { taskId: task.id, imageId: drawingImage, artifactId: exported.result.artifactId }, 'Completed tasks must reject another workspace artifact save');

  const folderControl = await control(otherTask.id, 'acquire');
  const { operation: folderWrite } = await app.json('software/invoke', { taskId: otherTask.id, imageId: drawingImage, requestId: requestId(), capability: 'shape.add',
    parameters: { kind: 'rectangle', x: 0, y: 0, width: 8, height: 6, label: 'must stop before becoming a folder' }, expectedDocumentRevision: folderControl.document.revision });
  assert.ok(['queued', 'running'].includes(folderWrite.state), 'The external producer must still be in flight before folder conversion');
  await app.json('task/quick', { projectId: otherProject.id, parentId: otherTask.id, title: '停止父节点软件写入后新增的子任务' });
  assert.equal((await app.json(`task?id=${otherTask.id}`)).isFolder, true);
  assert.equal((await seat(otherTask.id)).control, null, 'Folder conversion must release the former leaf\'s software control');
  await until(() => operation(otherTask.id, folderWrite.id), value => value.state === 'canceled', 'Folder conversion did not cancel the queued external write');
  // Let the real Mock worker's original 300 ms timer expire before checking its fence.
  await delay(450);
  assert.deepEqual((await seat(otherTask.id)).document, folderControl.document, 'An operation canceled by folder conversion must not make a late document change');
  await denied('software/release', { taskId: otherTask.id, imageId: drawingImage, confirm: false }, 'Releasing a Seat must require explicit confirmation');
  await app.json('software/release', { taskId: otherTask.id, imageId: drawingImage, confirm: true });
  assert.equal((await platform(`/v1/seats/${other.id}`)).state, 'released', 'A folder must still allow explicit cleanup of its former leaf Seat');
  const deletion = await app.json(`task/delete-preview?${new URLSearchParams({ id: task.id })}`);
  await app.json('task/delete', { id: task.id, revision: deletion.taskRevision, projectRevision: deletion.projectRevision, confirm: true });
  await denied(query('seats', { taskId: task.id }), undefined, 'Deleted tasks must have no software scope');
  for (const allocation of imageAllocations) {
    const purged = await platformResponse(`/v1/seats/${allocation.seatId}`);
    assert.equal(purged.status, 404, 'Task deletion must remove every image Seat rather than retain released history');
    await purged.body?.cancel();
  }
  const platformState = await readFile(join(home, 'mock-seat/data/state.json'), 'utf8');
  for (const id of [task.id, ...imageAllocations.flatMap(value => [value.seatId, value.requestId])]) assert.ok(!platformState.includes(id), 'Task deletion must purge every task, image Seat and allocation-request identity from platform persistence');
  assert.ok(platformState.includes(other.id), 'A normally released unrelated Seat may retain its own history');
  console.log('M3 verification passed: three installed Mock images and legacy alias, same-task Seat/document/capability/control isolation, explicit human and native image selection, synthetic analysis JSON export, credential-free anonymous same-origin SSE, CAS/cancellation/recorder/artifact save, project tool denial, Agent stop and replacement-grant fencing, restart with expired leases, all-image completion freezing and permanent task purge, plus leaf-to-folder producer cleanup. No real model, engineering engine or Docker daemon used.');
} finally {
  if (app) await stopApp(app.child);
  await release(home); await rm(home, { recursive: true, force: true });
}
