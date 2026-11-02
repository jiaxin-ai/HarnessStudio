// Acceptance of the project trajectory export (cli/设计.md §8) against the deterministic smoke model, whose calls cross a
// loopback HTTP exchange here (STUDIO_SMOKE_WIRE=1) so the conversation audit records them as it does real providers.
// Run it in the test image so the image's own plugins are exercised:
//   docker run --rm --user node --tmpfs /opt/harnessstudio/.studio:uid=1000,gid=1000,exec --entrypoint node \
//     harnessstudio/studio:trajectory-export-test scripts/verify-trajectory-export.mjs
// TRAJECTORY_CASES=trajectory,large runs a subset; TRAJECTORY_LARGE_MB sizes the large workspace file (default 400).
import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { crc32 } from 'node:zlib';
import yauzl from 'yauzl';
import { root } from './prepare.mjs';
import { startApp, stopApp } from './verify-app.mjs';

process.env.STUDIO_SMOKE_WIRE = '1';
const model = { provider: 'studio-smoke', model: 'm1-smoke' };
const selected = process.env.TRAJECTORY_CASES?.split(',').map(name => name.trim()).filter(Boolean);
const LARGE_MB = Number(process.env.TRAJECTORY_LARGE_MB ?? 400);
const BATCH_QUERY = { snapshots: '1', video: '1', workspace: '1' };

await mkdir(join(root, '.studio'), { recursive: true });
const home = await mkdtemp(join(root, '.studio/trajectory-test-')), scratch = await mkdtemp(join(tmpdir(), 'trajectory-zips-'));
let app;

// ---- helpers --------------------------------------------------------------------------------------------------
async function waitFor(read, ready, message, timeout = 60000) {
  const end = Date.now() + timeout; let value;
  while (Date.now() < end) { value = await read(); if (await ready(value)) return value; await delay(150); }
  throw new Error(`${message}\n最后一次读取：${JSON.stringify(value, null, 1)?.slice(0, 3000)}`);
}
const run = id => app.json(`autonomy/run?id=${encodeURIComponent(id)}`);
const leaf = (key, title, extra = {}) => ({ key, ...extra, definition: { title, goal: `完成「${title}」（受控测试）`, checklist: [{ text: `${title}的结果文件已写出` }] } });
const objective = script => `受控测试目标（不调用真实模型）\n[autonomy-smoke] ${JSON.stringify(script)}`;
/** Save one export to a file as the batch command does; returns its path and size. */
async function download(projectId, name, query = BATCH_QUERY, signal) {
  const response = await fetch(`${app.base}/api/studio/project/export?${new URLSearchParams({ projectId, ...query })}`, { headers: { origin: app.base }, ...(signal ? { signal } : {}) });
  assert.equal(response.status, 200, 'Project export must succeed');
  const file = join(scratch, `${name}.zip`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(file));
  return { file, bytes: (await stat(file)).size };
}
/** Every entry of a ZIP; entries larger than `inline` are checked by size and CRC only. */
async function entries(file, inline = 16 * 1024 * 1024) {
  const zip = await new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true, validateEntrySizes: true }, (error, value) => error ? reject(error) : resolve(value)));
  const files = new Map();
  await new Promise((resolve, reject) => {
    zip.on('entry', entry => zip.openReadStream(entry, async (error, stream) => {
      if (error) return reject(error);
      try {
        let checksum = 0, size = 0; const parts = [];
        for await (const part of stream) { checksum = crc32(part, checksum); size += part.length; if (entry.uncompressedSize <= inline) parts.push(part); }
        assert.equal(checksum >>> 0, entry.crc32 >>> 0, `CRC of ${entry.fileName}`);
        files.set(entry.fileName, { size, data: entry.uncompressedSize <= inline ? Buffer.concat(parts) : undefined });
        zip.readEntry();
      } catch (failure) { reject(failure); }
    }));
    zip.on('end', resolve); zip.on('error', reject); zip.readEntry();
  });
  zip.close();
  return files;
}
const jsonOf = (files, suffix) => { const name = [...files.keys()].find(key => key.endsWith(suffix)); assert.ok(name, `${suffix} is exported`); return JSON.parse(files.get(name).data.toString('utf8')); };
/** The Studio server and its children: the app's process tree. */
async function tree(pid) {
  const parents = new Map();
  for (const name of await readdir('/proc')) if (/^\d+$/.test(name)) try { const stat = await readFile(`/proc/${name}/stat`, 'utf8'); parents.set(Number(name), Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])); } catch { /* exited */ }
  const result = [pid];
  for (let index = 0; index < result.length; index++) for (const [child, parent] of parents) if (parent === result[index]) result.push(child);
  return result;
}
async function rss(pids) {
  let total = 0;
  for (const pid of pids) try { total += Number(/VmRSS:\s+(\d+)/.exec(await readFile(`/proc/${pid}/status`, 'utf8'))?.[1] ?? 0) * 1024; } catch { /* exited */ }
  return total;
}
async function handlesTo(pids, path) {
  let count = 0;
  for (const pid of pids) for (const fd of await readdir(`/proc/${pid}/fd`).catch(() => [])) if (await readlink(`/proc/${pid}/fd/${fd}`).catch(() => '') === path) count++;
  return count;
}
const mib = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
/** Snapshot folders are read-only on purpose; open up only this fixture before removing it. */
async function release(path) {
  const walk = async target => { const info = await lstat(target).catch(() => undefined); if (!info || info.isSymbolicLink()) return; if (info.isDirectory()) { await chmod(target, 0o700); for (const name of await readdir(target)) await walk(join(target, name)); } else await chmod(target, 0o600); };
  await walk(path); await rm(path, { recursive: true, force: true });
}

// ---- cases ----------------------------------------------------------------------------------------------------
const cases = {
  async trajectory() {
    const project = await app.json('projects', { title: '轨迹导出：自主运行' });
    const ask = { name: 'ask_user_question', args: { questions: [{ id: 'scope', header: '范围', question: '受控测试：按哪个标准？', options: [{ label: 'GB', description: '测试选项' }, { label: 'ISO', description: '测试选项' }] }] } };
    const script = { before: [ask], creates: [leaf('A', '检索任务 A'), leaf('B', '下游任务 B', { dependencies: ['$A'] })],
      workers: { A: { before: [{ name: 'web_search', args: { queries: ['gear standard'] } }] }, B: { delayMs: 300 } } };
    const started = await app.json('autonomy/start', { projectId: project.id, objective: objective(script), settings: { orchestratorModel: model, workerModel: model } });
    // A question is answered by a person; the run continues.
    const pending = await waitFor(() => app.json(`chat/questions?id=${started.orchestratorChatId}`), value => value.pending.some(item => item.canAnswer), 'The orchestrator question did not become answerable');
    const question = pending.pending[0];
    await app.json('chat/questions/answer', { id: started.orchestratorChatId, callId: question.callId, answers: [{ id: question.questions[0].id, selected: ['GB'] }] });
    const final = await waitFor(() => run(started.id), value => value.state === 'completed', 'The run did not complete', 120000);
    // Exported at once, as the batch command does after a run ends: the orchestrator may still be writing its last reply.
    const { file, bytes } = await download(project.id, 'trajectory');
    const files = await entries(file), names = [...files.keys()], root = names[0].split('/')[0];
    const info = jsonOf(files, '/project.json');
    assert.deepEqual(info.warnings, [], `No warnings for a complete run: ${info.warnings.join('\n')}`);
    assert.deepEqual(info.options, { video: true, snapshots: true, workspace: true, shared: true }, 'shared follows workspace when the batch command does not send it');
    // Every conversation with every model call complete.
    const chats = (await app.json('status')).chats.filter(row => row.projectId === project.id);
    assert.equal(chats.length, 3, 'An orchestrator and two workers');
    assert.ok(!names.some(name => name.endsWith('/ERROR.txt')), 'No conversation failed to export');
    let calls = 0;
    for (const chat of chats) {
      const value = jsonOf(files, `/${chat.id}/chat.json`);
      assert.ok(value.modelCalls.length >= 1, `${chat.id} has model calls`);
      for (const call of value.modelCalls) {
        assert.equal(call.status, 'completed', `${chat.id} ${call.recordId} status`); assert.equal(call.wireStatus, 'available', `${chat.id} ${call.recordId} wire`);
        assert.ok(call.transports.length >= 1 && call.transports.every(row => row.request.status === 'complete' && row.response.status === 'complete'), `${chat.id} ${call.recordId} complete bodies`);
        assert.ok(call.transports[0].request.body.messages, 'The raw request is the model request');
      }
      assert.equal(value.completeness.status, 'complete', `${chat.id}: ${JSON.stringify(value.completeness)}`);
      assert.deepEqual(value.completeness.missing, []); assert.equal(value.completeness.calls, value.modelCalls.length);
      calls += value.modelCalls.length;
    }
    assert.deepEqual({ total: info.modelCalls.total, complete: info.modelCalls.complete, incomplete: info.modelCalls.incomplete, unrecorded: info.modelCalls.unrecorded }, { total: calls, complete: calls, incomplete: 0, unrecorded: 0 });
    // The search model call inside web_search is recorded beside the conversation's own calls.
    const graph = await app.json(`graph?projectId=${project.id}`), A = graph.tasks.find(row => row.title === '检索任务 A');
    const workerA = jsonOf(files, `/${final.workers.find(row => row.taskId === A.id).chatId}/chat.json`);
    const search = workerA.modelCalls.filter(call => call.purpose === 'web-search');
    assert.equal(search.length, 1, 'One search call'); assert.equal(search[0].transports[0].request.body.model, 'smoke-web-search');
    assert.ok(workerA.sessions[0].events.some(event => event.type === 'tool/call' && event.data.callId === search[0].toolCallId && event.data.name === 'web_search'), 'toolCallId names the web_search call');
    // The run: every event, attention with its handling, workers, settings and usage.
    const runFile = `${root}/autonomy/${started.id}/run.json`; assert.ok(files.has(runFile));
    const exported = JSON.parse(files.get(runFile).data);
    const database = new DatabaseSync(join(home, 'studio', 'autonomy.sqlite'), { readOnly: true });
    const stored = Number(database.prepare('SELECT COUNT(*) AS count FROM events WHERE run_id=?').get(started.id).count); database.close();
    assert.equal(exported.events.length, stored, 'run.json has every event of the run'); assert.ok(stored > 10);
    assert.equal(exported.state, 'completed'); assert.equal(exported.settings.cacheReadWeight, 0.1); assert.deepEqual(exported.settings.orchestratorModel, model);
    assert.ok(exported.usage.weightedTokens > 0); assert.ok(exported.usage.tokenBreakdown.output > 0);
    assert.deepEqual(exported.workers.map(row => row.chatId).sort(), final.workers.map(row => row.chatId).sort());
    assert.ok(exported.workers.every(row => row.model === model.model && row.state === 'done' && typeof row.nudges === 'number' && row.code));
    const asked = exported.attention.find(item => item.kind === 'question');
    assert.ok(asked && asked.resolution === 'answered' && asked.resolvedAt, `The question item and how it closed: ${JSON.stringify(exported.attention)}`);
    assert.ok(exported.events.some(event => event.page && event.page !== event.summary), 'Both the orchestrator’s and the page’s texts are kept');
    assert.deepEqual(info.autonomyRuns.map(row => [row.id, row.events]), [[started.id, stored]]);
    // The timeline: start, workers, the question, its answer, the end and the Agent completions, each once.
    const timeline = files.get(`${root}/timeline/timeline.jsonl`).data.toString('utf8').trim().split('\n').map(line => JSON.parse(line));
    const count = type => timeline.filter(row => row.type === type).length;
    assert.equal(count('web.autonomy/start') + count('autonomy.started'), 1, 'The start appears once');
    assert.equal(count('agent.autonomy/start-worker') + count('autonomy.worker-started'), 2, 'Each dispatch appears once');
    assert.equal(count('agent.autonomy/attention') + count('autonomy.attention-opened'), 1, 'The question item appears once');
    assert.equal(count('autonomy.attention-resolved'), 1, 'Its answer closes it, from run.json');
    assert.equal(count('agent.autonomy/complete') + count('autonomy.completed'), 1, 'The end appears once');
    assert.ok(count('autonomy.worker-settled') >= 2, 'Worker turns that ended come from run.json');
    assert.equal(timeline.filter(row => row.type === 'task.completed' && row.actor === 'agent').length, 2, 'Both tasks were completed by Agents');
    assert.ok(count('agent.task/agent-complete') >= 2);
    assert.ok(timeline.some(row => row.type === 'chat.question_answer'), 'The person’s answer is in the timeline');
    assert.ok(timeline.filter(row => row.type.startsWith('autonomy.')).every(row => row.ref.file === `autonomy/${started.id}/run.json` && Number.isInteger(row.ref.seq)));
    // README explains the new parts.
    const readme = files.get(`${root}/README.md`).data.toString('utf8');
    for (const text of ['## 自主运行（autonomy/<运行 ID>/run.json）', '## chat.json', '怎么找到某次模型调用的原始请求', 'jq ', '## 模型调用记录完整吗']) assert.ok(readme.includes(text), `README: ${text}`);
    console.log(`  trajectory: ${mib(bytes)}, ${names.length} files, ${calls} model calls all complete, ${stored} run events, timeline ${timeline.length} events`);
  },

  async shared() {
    // The project shared folder (Mock's project folder here; verify-cli-run covers vm_manager's F: and the no-software space).
    // The batch command asks for workspace=1 and says nothing about shared, and its input files must come along.
    const project = await app.json('projects', { title: '轨迹导出：共享盘' });
    const directory = join(home, 'studio', 'project-workspaces', project.id);
    await mkdir(join(directory, 'inputs'), { recursive: true }); await mkdir(join(directory, '.chat-tmp', 'c'), { recursive: true });
    await writeFile(join(directory, '箱体草图.txt'), '输入文件\n'); await writeFile(join(directory, 'inputs', '工况.csv'), '工况,载荷\n额定,5600\n'); await writeFile(join(directory, '.chat-tmp', 'c', 'scratch.txt'), 'private');
    const exported = async (name, query) => {
      const files = await entries((await download(project.id, name, query)).file);
      return { files, info: jsonOf(files, '/project.json'), shared: [...files.keys()].filter(key => key.includes('/shared/')).map(key => key.slice(key.indexOf('/shared/') + '/shared/'.length)).sort() };
    };
    const batch = await exported('shared-batch', BATCH_QUERY);
    assert.deepEqual(batch.shared, ['inputs/工况.csv', '箱体草图.txt'], 'The shared folder is exported without the conversations private folder');
    assert.equal(batch.files.get([...batch.files.keys()].find(key => key.endsWith('/shared/箱体草图.txt'))).data.toString('utf8'), '输入文件\n');
    assert.equal(batch.info.options.shared, true); assert.deepEqual(batch.info.warnings, []);
    assert.ok([...batch.files].find(([key]) => key.endsWith('/README.md'))[1].data.toString('utf8').includes('shared/：项目共享盘'), 'README explains shared/');
    const off = await exported('shared-off', { ...BATCH_QUERY, shared: '0' });
    assert.deepEqual(off.shared, []); assert.equal(off.info.options.shared, false);
    const only = await exported('shared-only', { snapshots: '1', video: '0', workspace: '0', shared: '1' });
    assert.deepEqual(only.shared, batch.shared);
    const page = await exported('shared-page', { snapshots: '1', video: '0' });
    assert.deepEqual(page.shared, [], 'The old request of the page, without workspace or shared, is unchanged');
    console.log(`  shared: ${batch.shared.join(', ')} exported by the batch request; left out with shared=0 and by the old page request`);
  },

  async large() {
    const projects = [];
    for (const title of ['轨迹导出：大文件甲', '轨迹导出：大文件乙']) {
      const project = await app.json('projects', { title }), task = await app.json('task/quick', { projectId: project.id, title: '大文件任务' });
      const directory = join(home, 'studio', 'workspaces', task.id); await mkdir(directory, { recursive: true });
      const path = join(directory, 'model.step'), handle = await open(path, 'w'), block = Buffer.alloc(1024 * 1024);
      for (let index = 0; index < block.length; index++) block[index] = (index * 31 + LARGE_MB) & 0xff;
      try { for (let index = 0; index < LARGE_MB; index++) await handle.write(block); } finally { await handle.close(); }
      projects.push({ project, task, path });
    }
    const server = await tree(app.child.pid), before = await rss(server);
    let peak = before, sampling = true;
    const sampler = (async () => { while (sampling) { peak = Math.max(peak, await rss(server)); await delay(100); } })();
    const first = await download(projects[0].project.id, 'large');
    sampling = false; await sampler;
    const files = await entries(first.file), big = [...files].find(([name]) => name.endsWith('/workspace/model.step'));
    assert.ok(big, 'The workspace file is exported'); assert.equal(big[1].size, LARGE_MB * 1024 * 1024);
    assert.ok(first.bytes > LARGE_MB * 1024 * 1024);
    const growth = peak - before;
    console.log(`  large: ${mib(first.bytes)} exported; Studio RSS ${mib(before)} → peak ${mib(peak)} (+${mib(growth)})`);
    assert.ok(growth < 160 * 1024 * 1024, `Memory must not grow with the export size: +${mib(growth)} for ${mib(first.bytes)}`);
    // A client that goes away: the server stops reading the file and keeps serving.
    const controller = new AbortController();
    const response = await fetch(`${app.base}/api/studio/project/export?${new URLSearchParams({ projectId: projects[0].project.id, ...BATCH_QUERY })}`, { headers: { origin: app.base }, signal: controller.signal });
    const reader = response.body.getReader(); let read = 0;
    while (read < 20 * 1024 * 1024) { const part = await reader.read(); if (part.done) break; read += part.value.byteLength; }
    assert.ok(await handlesTo(await tree(app.child.pid), projects[0].path) >= 1, 'The file is open while it is sent');
    controller.abort(); await reader.cancel().catch(() => {});
    await waitFor(async () => handlesTo(await tree(app.child.pid), projects[0].path), open => open === 0, 'The server kept the file open after the client left', 10000);
    assert.equal((await app.call('projects')).status, 200, 'Studio keeps serving');
    // Three exports at once, of two projects: each complete and unaffected by the others.
    const results = await Promise.all([download(projects[0].project.id, 'parallel-1'), download(projects[1].project.id, 'parallel-2'), download(projects[0].project.id, 'parallel-3', { snapshots: '1', video: '0', workspace: '1' })]);
    for (const [index, result] of results.entries()) {
      const content = await entries(result.file), file = [...content].find(([name]) => name.endsWith('/workspace/model.step'));
      assert.equal(file?.[1].size, LARGE_MB * 1024 * 1024, `parallel export ${index + 1}`);
      assert.deepEqual(jsonOf(content, '/project.json').warnings, []);
    }
    console.log(`  large: client disconnect released the file; 3 parallel exports (${results.map(row => mib(row.bytes)).join(', ')}) complete`);
  },
};

const order = ['trajectory', 'shared', 'large'], passed = [];
try {
  app = await startApp(home);
  for (const name of order.filter(name => !selected || selected.includes(name))) {
    const began = Date.now();
    try { await cases[name](); } catch (error) { throw new Error(`Trajectory export case "${name}" failed: ${error.message}`, { cause: error }); }
    passed.push(`${name} ${((Date.now() - began) / 1000).toFixed(1)}s`);
  }
  console.log(`Trajectory export verification passed (${passed.join(', ')}): an autonomy run exported right after it ended, with every conversation's model calls complete (the search call inside web_search included), run.json with every event, attention item and worker, the timeline's run steps once each, and the README; the project shared folder carried along by the batch command request; a large workspace export streamed without memory growth, a client disconnect that released the file, and three exports at once.`);
} finally {
  if (app) await stopApp(app.child).catch(error => console.error(`stop: ${error.message}`));
  await release(home).catch(error => console.error(`cleanup: ${error.message}`)); await rm(scratch, { recursive: true, force: true });
}
