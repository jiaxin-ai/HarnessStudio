import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { root } from './prepare.mjs';
import { startApp, stopApp } from './verify-app.mjs';
import { emptyChatState, foldChatPacket, conversationRows } from '../plugins/ui/lib/chat-state.js';

// Every project, file, model and compaction in this test is isolated from the
// shared preview. The keyless provider is loaded only by the smoke overlay.
await mkdir(join(root, '.studio'), { recursive: true });
const home = await mkdtemp(join(root, '.studio/m4-context-test-'));
let app;
const model = { provider: 'studio-m4-smoke', model: 'm4-smoke' };
const digest = content => createHash('sha256').update(content).digest('hex');
const text = content => typeof content === 'string' ? content : content.filter(block => block.type === 'text').map(block => block.text).join('');
const goalOriginal = 'M4_GOAL_OLD: design from explicitly confirmed CAD constraints, never guessed dimensions.';
const goalCurrent = 'M4_GOAL_CURRENT: compare the reviewed input specification and record remaining design constraints.';
const goalAfterRestart = 'M4_GOAL_RESTART_CURRENT: continue with the latest requirements and the same immutable input basis.';
const checklistCurrent = ['M4_CHECKLIST_CURRENT_1: verify the declared input version', 'M4_CHECKLIST_CURRENT_2: keep unknown parameters unresolved'];
const research = 'M4_RESEARCH_ORIGINAL_PRIVATE_CHAT: trial alloy A, investigation only; source https://fixture.invalid/gear; this is not formally accepted evidence.';
const evidence = 'M4_IMMUTABLE_INPUT_EVIDENCE: explicit human-confirmed test value = 37.25 mm. Controlled fixture, no engineering correctness claim.';
const siblingSecret = 'M4_OUT_OF_SCOPE_SIBLING: must never become the current task context.';
const projectSecret = 'M4_OTHER_PROJECT_SECRET: belongs to a completely separate project.';
const otherResearch = 'M4_OTHER_CHAT_PRIVATE: never read or index this different conversation.';

async function until(predicate, message) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await delay(35); }
  throw new Error(message);
}
const task = id => app.json(`task?id=${id}`);
const graph = projectId => app.json(`graph?projectId=${projectId}`);
const quick = (projectId, title, parentId) => app.json('task/quick', { projectId, title, ...(parentId ? { parentId } : {}) });
async function metadata(id, goal, checklist) {
  const current = await task(id);
  return app.json('task/metadata', { id, revision: current.revision, title: current.title, goal, checklist: checklist.map(value => ({ text: value })) });
}
const completionArgs = preview => ({ taskId: preview.taskId, revision: preview.taskRevision, workspaceVersion: preview.workspaceVersion,
  ...(preview.isFolder ? { childrenVersion: preview.childrenVersion } : {}), checkedGoalIds: preview.goals.filter(goal => !goal.system).map(goal => goal.id) });
async function complete(id, file) {
  const preview = await app.json(`task/completion?taskId=${id}`);
  assert.deepEqual(preview.blockers, []);
  if (!file) return (await app.json('task/completion', { ...completionArgs(preview), confirmWithoutFiles: true })).task;
  const submitted = await app.json('task/completion/files', { taskId: id, revision: preview.taskRevision, workspaceVersion: preview.workspaceVersion,
    files: [{ path: file, description: 'Explicit human fixture confirmation of the immutable specification' }] });
  return (await app.json('task/completion', { ...completionArgs(submitted), submissionId: submitted.submittedFiles.id })).task;
}
async function finished(id, turns) {
  return until(async () => {
    const record = await app.json(`chat?id=${id}`);
    const ended = record.events.filter(event => event.type === 'turn/end');
    if (record.status !== 'idle' || ended.length !== turns) return undefined;
    assert.notEqual(ended.at(-1).data.reason?.kind, 'error', JSON.stringify(ended.at(-1).data.reason));
    return record;
  }, 'M4 native turn did not finish');
}
async function probe(scope, fixture, marker = 'recover', id, padded = false) {
  let message = `[m4-${marker}] ${JSON.stringify(fixture)}\n`;
  if (padded) message += 'M4_HISTORY_TO_BE_SHADOWED: old process discussion, deliberately irrelevant to current authoritative facts.\n'.repeat(240);
  assert.ok(message.length <= 32768);
  const record = await app.json('chat', { ...scope, ...model, ...(id ? { id } : {}), message });
  return record.id;
}

/** Public anonymous same-origin history snapshot, closed immediately after receipt. */
async function snapshot(id) {
  const response = await app.call(`chat/stream?id=${encodeURIComponent(id)}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '';
  const deadline = setTimeout(() => { void reader.cancel(); }, 15000);
  try {
    while (true) {
      const row = await reader.read(); if (row.done) throw new Error('No M4 native SSE snapshot');
      buffer += decoder.decode(row.value, { stream: true });
      let split;
      while ((split = buffer.indexOf('\n\n')) >= 0) {
        const record = buffer.slice(0, split); buffer = buffer.slice(split + 2);
        if (!record.startsWith('data: ')) continue;
        const packet = JSON.parse(record.slice(6));
        if (packet.type === 'error') throw new Error(packet.error);
        if (packet.type === 'snapshot') return packet;
      }
    }
  } finally { clearTimeout(deadline); await reader.cancel(); reader.releaseLock(); }
}

function callResults(record, previousTurns = 0) {
  const starts = record.events.filter(event => event.type === 'turn/start');
  const start = starts[previousTurns]; assert.ok(start);
  const events = record.events.filter(event => event.seq >= start.seq);
  const calls = events.filter(event => event.type === 'tool/call');
  return calls.map(call => {
    const result = events.find(event => event.type === 'tool/result' && event.data.message.source.callId === call.data.callId);
    assert.ok(result, `Missing durable result for ${call.data.name}`);
    return { name: call.data.name, args: JSON.parse(call.data.arguments), error: result.data.message.isError === true, text: text(result.data.message.content) };
  });
}
function recoveryVerified(record, fixture, previousTurns) {
  const results = callResults(record, previousTurns);
  assert.deepEqual(results.map(value => [value.name, value.error]), fixture.calls.map(value => [value.name, value.error === true]));
  assert.ok(record.events.some(event => event.type === 'assistant/message' && text(event.data.message.content).includes('M4_RECOVERY_VERIFIED')));
  // The fixture inspects actual provider request messages and real native tool
  // results; this independent HTTP assertion also checks recovered file bytes.
  return results;
}
/** Match the pinned native projection's conversation-assistant samples.
 * Auxiliary compaction usage is durable on its summary, but the upstream
 * tokenUsage projection deliberately does not add it to these chat buckets. */
function verifyNativeUsage(record) {
  const totals = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const event of record.events) if (event.type === 'assistant/message') {
    assert.ok(event.data.usage);
    const sample = event.data.usage;
    totals.uncachedInputTokens += sample.inputTokens; totals.outputTokens += sample.outputTokens;
    totals.cacheReadTokens += sample.cacheReadTokens ?? 0; totals.cacheWriteTokens += sample.cacheWriteTokens ?? 0;
  }
  const inputs = totals.uncachedInputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
  assert.deepEqual(record.metrics.usage, { ...totals, totalTokens: inputs + totals.outputTokens,
    cacheReported: true, cacheHitPercent: totals.cacheReadTokens / inputs * 100 });
  assert.equal(record.metrics.context.capacity, 1000000);
}
async function compact(id, exactValues = []) {
  const result = await app.json('m4/compact', { id });
  assert.ok(result.result, 'The official engine must perform useful compaction');
  assert.equal(result.derived.hadOriginalHistory, true);
  assert.equal(result.derived.hasOriginalHistory, false, 'Original padded user text must be absent from native deriveMessages');
  assert.equal(result.derived.hasCheckpointText, true); assert.equal(result.derived.checkpointCount, 1);
  assert.ok(result.result.shadowedSeqs.length >= 3);
  for (const seq of result.result.shadowedSeqs) { assert.ok(result.before.includes(seq)); assert.ok(!result.after.includes(seq), 'Every officially shadowed source must leave the model-visible surface'); }
  const record = await app.json(`chat?id=${id}`);
  const start = record.events.find(event => event.seq === result.result.startSeq), summary = record.events.find(event => event.seq === result.result.summarySeq), end = record.events.find(event => event.seq === result.result.endSeq);
  assert.equal(start.type, 'compaction/start'); assert.equal(summary.type, 'compaction/summary'); assert.equal(end.type, 'compaction/end');
  assert.equal(start.data.turn, null); assert.equal(end.data.turn, null); assert.equal(end.data.error, undefined);
  assert.equal(start.data.compactionId, result.result.compactionId); assert.equal(summary.data.compactionId, result.result.compactionId); assert.equal(end.data.compactionId, result.result.compactionId);
  assert.ok(start.seq < summary.seq && summary.seq < end.seq);
  assert.equal(summary.data.llmStreamCall, true, 'Summary must be produced by the official one-shot LLM seam');
  assert.equal(summary.data.provider, model.provider); assert.equal(summary.data.model, model.model);
  assert.ok(summary.data.usage.inputTokens > 0); assert.ok(summary.data.rawOutput.length > 0);
  assert.deepEqual(summary.data.shadowedSeqs, result.result.shadowedSeqs);
  const checkpoint = record.events.find(event => event.type === 'user/message' && event.data.source.kind === 'compact-checkpoint' && event.data.source.compactionId === result.result.compactionId);
  assert.ok(checkpoint); assert.equal(checkpoint.seq, summary.seq + 1);
  assert.equal(checkpoint.surfaceOp.op, 'replace');
  assert.equal(checkpoint.surfaceOp.startSeq, result.result.shadowedRange.start); assert.equal(checkpoint.surfaceOp.endSeq, result.result.shadowedRange.end);
  assert.ok(result.after.includes(checkpoint.seq));
  assert.ok(result.result.shadowedSeqs.some(seq => record.events.some(event => event.seq === seq && event.type === 'user/message' && text(event.data.content).includes('M4_HISTORY_TO_BE_SHADOWED'))));
  for (const value of exactValues) assert.ok(!text(summary.data.summary).includes(value), 'Exact engineering facts must be recovered from tools, not copied into the controlled summary');
  return { result, record, summary, checkpoint };
}
async function release(path) {
  const info = await lstat(path); if (info.isSymbolicLink()) return;
  if (!info.isDirectory()) { await chmod(path, 0o600); return; }
  await chmod(path, 0o700);
  for (const name of await readdir(path)) await release(join(path, name));
}

try {
  app = await startApp(home);
  assert.equal((await fetch(`${app.base}/api/studio/m4/compact`, { method: 'POST', headers: { origin: app.base, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'unknown' }) })).status, 400);
  assert.equal((await app.call('m4/compact', { id: 'unknown' })).status, 400);
  const project = await app.json('projects', { title: 'M4 isolated engineering context recovery' });
  const otherProject = await app.json('projects', { title: 'M4 deliberately unrelated project' });
  const sourceFolder = await quick(project.id, 'Human-confirmed immutable input group');
  const sourceLeaf = await quick(project.id, 'Human-confirmed input specification', sourceFolder.id);
  await metadata(sourceLeaf.id, 'Confirm the controlled source specification', ['Verify the fixture specification text']);
  await app.json('file', { taskId: sourceLeaf.id, path: 'report.md', content: evidence });
  const sourceComplete = await complete(sourceLeaf.id, 'report.md');
  const folderComplete = await complete(sourceFolder.id);
  const sourceManifest = (await app.json(`snapshot?taskId=${sourceLeaf.id}`)).snapshot;
  const immutableHash = digest(await readFile(join(home, 'studio', 'snapshots', sourceComplete.completedId, 'files', 'report.md')));
  const current = await quick(project.id, 'Current task after engineering clarification');
  await metadata(current.id, goalOriginal, ['M4_CHECKLIST_OLD: superseded wording must not override later edits']);
  const currentBeforeDeps = await task(current.id);
  await app.json('dependencies', { id: current.id, revision: currentBeforeDeps.revision, dependencies: [sourceFolder.id] });

  const sibling = await quick(project.id, 'Same project sibling outside this task');
  await metadata(sibling.id, siblingSecret, []);
  await app.json('file', { taskId: sibling.id, path: 'report.md', content: siblingSecret });
  const siblingComplete = await complete(sibling.id, 'report.md');
  const outsider = await quick(otherProject.id, 'Other project task');
  await metadata(outsider.id, projectSecret, []);
  await app.json('file', { taskId: outsider.id, path: 'report.md', content: projectSecret });
  const outsiderComplete = await complete(outsider.id, 'report.md');

  const wrongProvider = await app.json('chat', { taskId: current.id, provider: 'studio-smoke', model: 'm1-smoke', message: '[chat-stats-no-cache] wrong-provider route guard' });
  await finished(wrongProvider.id, 1);
  assert.equal((await app.call('m4/compact', { id: wrongProvider.id })).status, 400, 'The test route cannot compact ordinary conversations');
  const independentId = await probe({ taskId: current.id }, { calls: [{ name: 'studio_write_temp_file', args: { path: 'other-private.md', content: otherResearch } }] }, 'seed');
  await finished(independentId, 1);
  const seedFixture = { expectSystem: [goalOriginal], calls: [
    { name: 'studio_write_temp_file', args: { path: 'research/notes.md', content: research }, includes: ['research/notes.md'] },
    { name: 'web_search', args: { queries: ['gear standard'] }, includes: ['https://fixture.invalid/gear'] },
    { name: 'studio_task_context', args: {}, includes: [folderComplete.completedId, sourceComplete.completedId, sourceManifest.files[0].version] },
  ] };
  const id = await probe({ taskId: current.id }, seedFixture, 'seed', undefined, true);
  const seeded = await finished(id, 1);
  verifyNativeUsage(seeded);
  assert.deepEqual((await task(current.id)).inputs, [{ taskId: sourceFolder.id, snapshotId: folderComplete.completedId }]);
  assert.equal((await app.call('m4/compact', { id, taskId: outsider.id })).status, 400, 'Forged owner parameters cannot reach compaction');
  const condensed = await compact(id, [goalOriginal, research, sourceComplete.completedId, sourceManifest.files[0].version, '37.25']);
  verifyNativeUsage(condensed.record);
  assert.ok(condensed.record.metrics.context.tokens < seeded.metrics.context.tokens, 'Native projected occupancy must immediately fall after the official surface replacement');
  assert.deepEqual(condensed.record.metrics.usage, seeded.metrics.usage, 'Official auxiliary summary usage must not be fabricated into the pinned conversation-only projection');
  const condensedHistoryPacket = await snapshot(id);
  const condensedHistory = conversationRows(foldChatPacket(emptyChatState(), condensedHistoryPacket));
  assert.ok(condensedHistory.some(row => row.role === 'user' && row.text.includes('M4_HISTORY_TO_BE_SHADOWED')), 'UI history must retain original human messages even when model-visible surface excludes them');
  assert.ok(condensedHistory.some(row => row.role === 'assistant' && row.steps.some(step => step.text.some(value => value.includes('M4_SEED_READY')))), 'UI history must retain the original assistant record after compaction');

  // Change the authoritative task definition after old text is shadowed, then
  // add descendants. Retrieval must follow the new live definition and scope.
  await metadata(current.id, goalCurrent, checklistCurrent);
  const child1 = await quick(project.id, 'M4 descendant drawing detail', current.id);
  await metadata(child1.id, 'M4_DESCENDANT_ALPHA: inspect a defined drawing interface', ['M4_CHILD_CHECK_ALPHA: keep its uncertainty explicit']);
  const child2 = await quick(project.id, 'M4 descendant verification detail', current.id);
  await metadata(child2.id, 'M4_DESCENDANT_BETA: inspect the stated verification boundary', ['M4_CHILD_CHECK_BETA: identify missing evidence']);
  const currentGraph = await graph(project.id), revision = currentGraph.project.revision;
  const recoveryFixture = { requireCheckpoint: true, forbidHistory: true, expectSystem: [goalCurrent, ...checklistCurrent], forbidSystem: [goalOriginal, projectSecret], calls: [
    { name: 'studio_retrieve_context', args: { category: 'definition', query: 'M4_GOAL_CURRENT', revision }, includes: [goalCurrent, current.id], excludes: [goalOriginal, siblingSecret, projectSecret], total: 1, count: 1 },
    { name: 'studio_retrieve_context', args: { category: 'checklist', query: 'M4_CHECKLIST_CURRENT', revision }, includes: checklistCurrent, total: 2, count: 2 },
    { name: 'studio_retrieve_context', args: { category: 'definition', revision, limit: 1, offset: 0 }, includes: [current.id], kinds: ['definition'], total: 3, count: 1, nextOffset: 1 },
    { name: 'studio_retrieve_context', args: { category: 'definition', revision, limit: 1, offset: 1 }, includes: [child1.id, 'M4_DESCENDANT_ALPHA'], kinds: ['definition'], total: 3, count: 1, nextOffset: 2 },
    { name: 'studio_retrieve_context', args: { category: 'definition', revision, limit: 1, offset: 2 }, includes: [child2.id, 'M4_DESCENDANT_BETA'], kinds: ['definition'], total: 3, count: 1, nextOffset: null },
    { name: 'studio_retrieve_context', args: { category: 'definition', query: siblingSecret, revision }, total: 0, count: 0, excludes: [siblingSecret] },
    { name: 'studio_retrieve_context', args: { query: projectSecret, revision }, total: 0, count: 0, excludes: [projectSecret] },
    { name: 'studio_retrieve_context', args: { category: 'inputs', revision, limit: 100 }, includes: [folderComplete.completedId, sourceComplete.completedId, sourceManifest.files[0].version, 'report.md'], excludes: [evidence, siblingComplete.completedId, outsiderComplete.completedId] },
    { name: 'studio_retrieve_context', args: { taskId: sibling.id }, error: true },
    { name: 'studio_retrieve_context', args: { projectId: otherProject.id }, error: true },
    { name: 'studio_read_file', args: { path: 'report.md', snapshotId: sourceComplete.completedId }, includes: [evidence] },
    { name: 'studio_read_file', args: { path: 'report.md', snapshotId: siblingComplete.completedId }, error: true },
    { name: 'studio_read_file', args: { path: 'report.md', snapshotId: outsiderComplete.completedId }, error: true },
    { name: 'studio_list_temp_files', args: {}, includes: ['research/notes.md', 'web_search'], excludes: ['other-private.md', otherResearch] },
    { name: 'studio_read_temp_file', args: { path: 'research/notes.md', offset: 0, limit: 12000 }, includes: [research], excludes: [otherResearch] },
    { name: 'studio_search_temp_file', args: { path: 'research/notes.md', query: 'M4_RESEARCH_ORIGINAL_PRIVATE_CHAT', limit: 4 }, includes: ['M4_RESEARCH_ORIGINAL_PRIVATE_CHAT'] },
    { name: 'studio_read_temp_file', args: { path: `../${independentId}/other-private.md`, offset: 0, limit: 12000 }, error: true },
  ] };
  await probe({ taskId: current.id }, recoveryFixture, 'recover', id);
  const recovered = await finished(id, 2), recoveredResults = recoveryVerified(recovered, recoveryFixture, 1);
  verifyNativeUsage(recovered);
  assert.ok(recovered.metrics.usage.totalTokens > condensed.record.metrics.usage.totalTokens);
  assert.ok(recoveredResults.find(value => value.name === 'studio_read_file' && !value.error).text.includes('37.25 mm'));
  assert.equal(digest(await readFile(join(home, 'studio', 'snapshots', sourceComplete.completedId, 'files', 'report.md'))), immutableHash, 'Recovery must not alter immutable input bytes');
  assert.equal((await task(current.id)).state, 'unstarted');
  assert.ok(!(await task(current.id)).completedId, 'Model recovery cannot complete a task or folder');
  assert.deepEqual((await task(current.id)).inputs, [{ taskId: sourceFolder.id, snapshotId: folderComplete.completedId }]);
  const livePacket = await snapshot(id), liveRows = conversationRows(foldChatPacket(emptyChatState(), livePacket));
  assert.equal(liveRows.filter(row => row.role === 'user').length, 2, 'A native checkpoint must not become a fake human chat message');

  await stopApp(app.child); app = undefined;
  app = await startApp(home);
  const coldPacket = await snapshot(id);
  assert.equal(coldPacket.chat.status, 'stored');
  assert.deepEqual(conversationRows(foldChatPacket(emptyChatState(), coldPacket)), liveRows, 'Restart must preserve the complete chronological tool evidence');
  const cold = await app.json(`chat?id=${id}`);
  verifyNativeUsage(cold);
  assert.deepEqual(cold.metrics, recovered.metrics, 'Cold projection restore must not add original or summary usage again');
  assert.deepEqual(coldPacket.chat.metrics, recovered.metrics, 'SSE cold snapshot must carry exactly the persisted conversation counters');
  assert.deepEqual(cold.events.find(event => event.seq === condensed.summary.seq), condensed.summary, 'The actual native summary record must persist exactly');
  assert.deepEqual((await app.json(`snapshot?taskId=${sourceLeaf.id}`)).snapshot, sourceManifest);
  assert.equal((await app.json(`chat/temp/file?${new URLSearchParams({ id, path: 'research/notes.md', offset: '0', limit: '12000' })}`)).content, research);
  await metadata(current.id, goalAfterRestart, checklistCurrent);
  const restartRevision = (await graph(project.id)).project.revision;
  const restartFixture = { requireCheckpoint: true, forbidHistory: true, expectSystem: [goalAfterRestart, ...checklistCurrent], forbidSystem: [goalCurrent, projectSecret], calls: [
    { name: 'studio_retrieve_context', args: { category: 'definition', query: 'M4_GOAL_RESTART_CURRENT', revision: restartRevision }, includes: [goalAfterRestart], total: 1, count: 1 },
    { name: 'studio_retrieve_context', args: { category: 'checklist', query: 'M4_CHECKLIST_CURRENT', revision: restartRevision }, includes: checklistCurrent, total: 2, count: 2 },
    { name: 'studio_retrieve_context', args: { category: 'inputs', revision: restartRevision }, includes: [sourceComplete.completedId, sourceManifest.files[0].version], excludes: [evidence] },
    { name: 'studio_retrieve_context', args: { category: 'definition', revision }, error: true },
    { name: 'studio_read_file', args: { path: 'report.md', snapshotId: sourceComplete.completedId }, includes: [evidence] },
    { name: 'studio_read_temp_file', args: { path: 'research/notes.md', offset: 0, limit: 12000 }, includes: [research], excludes: [otherResearch] },
  ] };
  await probe({ taskId: current.id }, restartFixture, 'recover', id);
  const resumedRecord = await finished(id, 3);
  recoveryVerified(resumedRecord, restartFixture, 2); verifyNativeUsage(resumedRecord);
  assert.ok(resumedRecord.metrics.usage.totalTokens > recovered.metrics.usage.totalTokens);
  assert.equal(digest(await readFile(join(home, 'studio', 'snapshots', sourceComplete.completedId, 'files', 'report.md'))), immutableHash);
  assert.equal((await app.json(`chat/temp/file?${new URLSearchParams({ id: independentId, path: 'other-private.md', offset: '0', limit: '12000' })}`)).content, otherResearch);

  const projectFixture = { expectNoFileTools: true, calls: [
    { name: 'studio_retrieve_context', args: { category: 'definition', query: siblingSecret }, includes: [siblingSecret], total: 1, count: 1 },
    { name: 'studio_retrieve_context', args: { category: 'inputs' }, total: 0, count: 0 },
    { name: 'studio_retrieve_context', args: { category: 'definition', query: projectSecret }, total: 0, count: 0, excludes: [projectSecret] },
  ] };
  const projectChat = await probe({ projectId: project.id }, projectFixture);
  recoveryVerified(await finished(projectChat, 1), projectFixture, 0);
  assert.equal((await task(current.id)).state, 'unstarted');

  console.log('M4 context verification passed: real official compactNow, routed purpose=compaction LLM call, native start/summary/checkpoint surface replacement/end and flush, shadowed history absent from next model request, fresh goal/checklist retrieval with pagination/revision guards, immutable nested actual-input evidence, private research recovery, scoped denials, project metadata-only index, cold restart and real native continuation. No upstream edits, external model, real network, automatic completion or industrial correctness claim.');
} catch (error) { console.error(error); process.exitCode = 1; }
finally { if (app) await stopApp(app.child); await release(home); await rm(home, { recursive: true, force: true }); }
