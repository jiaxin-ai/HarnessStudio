// End-to-end acceptance of `harnessstudio run` (cli/设计.md §7) against a temporary Studio with the deterministic smoke
// model: no external model, network or VM. The client is a separate HTTP program, so it runs on the host against the
// Studio that startApp starts, which loads the built plugins (`npm run build` first after a rebase or a plugin change).
//   npm ci --prefix cli && node scripts/verify-cli-run.mjs
// Where Docker is available it also builds the cli image from this checkout and runs the client in it with the
// docker run arguments of §7.1 (CLI_RUN_IMAGE=harnessstudio/cli:<tag> uses an image built already instead).
// CLI_RUN_CASES=bad,batch,interrupt,twice,upload,noSoftware,docker runs a subset while debugging.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { root } from './prepare.mjs';
import { startApp, stopApp } from './verify-app.mjs';

const AUTO_ANSWER = '没有更多信息，请按合理假设继续，并在结果里写明你的假设。';
const selected = process.env.CLI_RUN_CASES?.split(',').map(name => name.trim()).filter(Boolean);
const client = join(root, 'cli/bin/harnessstudio.ts');
if (!existsSync(join(root, 'cli/node_modules/yaml/package.json'))) throw new Error('cli/ 的依赖没装：先运行 npm ci --prefix cli');
// Smoke model calls cross a loopback HTTP exchange, so the conversation audit records them whole and an export of a
// completed run has no warnings (scripts/verify-trajectory-export.mjs does the same).
process.env.STUDIO_SMOKE_WIRE = '1';

await mkdir(join(root, '.studio'), { recursive: true });
const scratch = await mkdtemp(join(root, '.studio/cli-run-test-'));
let app;

// ---- helpers -------------------------------------------------------------------------------------------------
const leaf = (key, title, extra = {}) => ({ key, ...extra, definition: { title, goal: `完成「${title}」（受控测试）`, checklist: [{ text: `${title}的结果文件已写出` }] } });
const ask = id => ({ name: 'ask_user_question', args: { questions: [{ id, header: '材料', question: `受控测试：${id} 用哪种材料？`, options: [{ label: '钢', description: '测试选项' }, { label: '铝', description: '测试选项' }] }] } });
const goal = script => `受控测试目标（不调用真实模型）\n[autonomy-smoke] ${JSON.stringify(script)}`;
/** JSON is YAML too, and keeps the smoke scripts exact. */
async function manifest(directory, tasks, defaults = {}) {
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'tasks.yaml');
  await writeFile(path, `# 受控测试清单\n${JSON.stringify({ defaults: { orchestratorModel: 'm1-smoke', projectPrefix: '批量测试', ...defaults }, tasks }, null, 2)}\n`);
  return path;
}
async function waitFor(read, ready, message, timeout = 90000) {
  const end = Date.now() + timeout; let value;
  while (Date.now() < end) { try { value = await read(); if (await ready(value)) return value; } catch { /* not there yet */ } await delay(200); }
  throw new Error(`${message}\n最后一次读取：${JSON.stringify(value, null, 1)?.slice(0, 3000)}`);
}
/** The client as a child process; `done` settles with its exit code and output. */
function cli(args, options = {}) {
  const child = spawn(options.command ?? process.execPath, options.command ? args : [client, ...args], { cwd: options.cwd ?? scratch, env: { ...process.env, HARNESSSTUDIO_URL: '', ...options.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr })));
  return { child, done, output: () => stdout + stderr };
}
async function finished(run, timeout = 180000) {
  // An unref'd timer: once the client has ended, a pending deadline must not keep this script alive.
  const result = await Promise.race([run.done, delay(timeout, undefined, { ref: false })]);
  if (!result) { run.child.kill('SIGKILL'); throw new Error(`客户端 ${timeout / 1000} 秒没有结束：\n${run.output().slice(-4000)}`); }
  return result;
}
const json = path => readFile(path, 'utf8').then(JSON.parse);
const runs = async () => (await app.json('autonomy/runs')).runs;
const runDetail = id => app.json(`autonomy/run?id=${encodeURIComponent(id)}`);
/** A stored ZIP (zip-stream.ts writes no compression), read through its central directory. */
async function zipEntries(path) {
  const zip = await readFile(path), files = new Map();
  let at = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(at >= 0, `${path} 不是 ZIP`);
  const count = zip.readUInt16LE(at + 10); at = zip.readUInt32LE(at + 16);
  for (let index = 0; index < count; index++) {
    const method = zip.readUInt16LE(at + 10), size = zip.readUInt32LE(at + 20), nameLength = zip.readUInt16LE(at + 28), extra = zip.readUInt16LE(at + 30), comment = zip.readUInt16LE(at + 32), local = zip.readUInt32LE(at + 42);
    assert.equal(method, 0, 'Export entries are stored');
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8'), data = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    files.set(name, zip.subarray(data, data + size)); at += 46 + nameLength + extra + comment;
  }
  const tested = spawnSync('unzip', ['-tq', path], { encoding: 'utf8' });
  if (!tested.error) assert.equal(tested.status, 0, `unzip -t ${path}: ${tested.stdout}${tested.stderr}`);
  return files;
}
const chatIn = (files, chatId) => [...files.keys()].some(name => name.endsWith(`/${chatId}/chat.json`));
/** §7.5, field by field. */
function checkResult(result, name, status) {
  assert.equal(result.name, name); assert.equal(result.status, status, `${name}: ${result.reason}`);
  assert.equal(typeof result.reason, 'string'); if (status !== 'completed') assert.ok(result.reason.trim(), `${name} 需要说明原因`);
  assert.match(result.projectId, /^p-/u); assert.equal(result.projectUrl, `${app.base}/#project=${result.projectId}`); assert.match(result.runId, /^ar-/u);
  assert.ok(Date.parse(result.startedAt) <= Date.parse(result.endedAt)); assert.equal(result.elapsedMs, Date.parse(result.endedAt) - Date.parse(result.startedAt));
  assert.ok(result.usage.weightedTokens > 0); assert.deepEqual(Object.keys(result.usage.tokenBreakdown).sort(), ['cacheRead', 'cacheWrite', 'output', 'uncachedInput']); assert.equal(typeof result.usage.rounds, 'number');
  assert.ok(Array.isArray(result.tasks) && Array.isArray(result.autoAnswers));
  assert.equal(result.trajectory.file, 'trajectory.zip'); assert.ok(result.trajectory.bytes > 0); assert.ok(result.trajectory.warnings.every(row => typeof row === 'string'));
  // A stopped run may have a model call cut short, which the export reports; a completed one is whole.
  if (status === 'completed') assert.deepEqual(result.trajectory.warnings, [], `${name}: ${result.trajectory.warnings.join('；')}`);
}

// ---- cases ---------------------------------------------------------------------------------------------------
const cases = {
  /** A list with any problem starts nothing: no project, no run, no output folder. */
  async bad() {
    const before = { runs: (await runs()).length, projects: (await app.json('projects')).length };
    const path = await manifest(join(scratch, 'bad'), [{ name: '好的任务', goal: goal({ creates: [leaf('A', '不该启动')] }) }, { name: '坏的任务', goal: '拼错字段', bugdet: { tokens: 1 }, workerModel: '没有这个模型' }]);
    const result = await finished(cli(['run', path, '--url', app.base, '--out', join(scratch, 'bad', 'out')]));
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /一个任务都没有启动/u); assert.match(result.stderr, /未知字段「bugdet」/u); assert.match(result.stderr, /没有模型 没有这个模型/u);
    assert.equal((await runs()).length, before.runs, 'No run starts'); assert.equal((await app.json('projects')).length, before.projects, 'No project is created');
    assert.equal(existsSync(join(scratch, 'bad', 'out')), false);
  },

  /** Every way a task ends, two at a time, with results, summaries and trajectories. */
  async batch() {
    const directory = join(scratch, 'batch'), out = join(directory, 'out');
    const tasks = [
      { name: '正常完成', goal: goal({ creates: [leaf('A', '正常任务 A'), leaf('B', '正常任务 B', { dependencies: ['$A'] })] }) },
      { name: '自动回答/提问', goal: goal({ before: [ask('scope')], creates: [leaf('A', '提问任务')], workers: { A: { before: [ask('material')] } } }) },
      { name: '受阻', goal: goal({ creates: [leaf('A', '需要人工登录的任务')], workers: { A: { before: [{ name: 'studio_agent_report', args: { kind: 'blocked', message: '需要人工登录许可证服务器（受控测试）' } }, 'end-turn'] } } }) },
      { name: '预算用完', budget: { tokens: 10000 }, goal: goal({ creates: [leaf('A', '预算任务 A'), leaf('B', '预算任务 B')], usage: { inputTokens: 300, outputTokens: 200, cacheReadTokens: 10000 }, workers: { '*': { usage: { inputTokens: 300, outputTokens: 200, cacheReadTokens: 10000 }, delayMs: 200 } } }) },
      { name: '提前宣布完成', goal: goal({ creates: [leaf('A', '先做的任务 A'), leaf('B', '依赖 A 的任务 B', { dependencies: ['$A'] })], completeEarly: true, workers: { '*': { delayMs: 600 } } }) },
    ];
    const path = await manifest(directory, tasks), before = new Set((await runs()).map(run => run.id));
    const result = await finished(cli(['run', path, '--url', app.base, '--out', out, '--parallel', '2', '--no-video']));
    assert.equal(result.code, 2, `需要人时退出码是 2\n${result.stdout}\n${result.stderr}`);

    const state = await json(join(out, 'batch-state.json'));
    assert.deepEqual(state.tasks.map(row => [row.name, row.folder, row.status]), [['正常完成', '正常完成', 'completed'], ['自动回答/提问', '自动回答_提问', 'completed'], ['受阻', '受阻', 'needs-human'], ['预算用完', '预算用完', 'needs-human'], ['提前宣布完成', '提前宣布完成', 'needs-human']]);
    const results = Object.fromEntries(await Promise.all(state.tasks.map(async row => [row.name, await json(join(out, row.folder, 'result.json'))])));
    for (const row of state.tasks) checkResult(results[row.name], row.name, row.status);
    assert.deepEqual(results['正常完成'].tasks.map(task => [task.title, task.state, task.completedBy]), [['正常任务 A', 'completed', 'agent'], ['正常任务 B', 'completed', 'agent']]);
    // The reason is Studio's own item text, which already names the situation: no label repeats it.
    assert.match(results['受阻'].reason, /^子 Agent（[^）]+）需要人处理：需要人工登录许可证服务器/u);
    assert.match(results['预算用完'].reason, /^折算 token 预算已用完/u);
    assert.match(results['提前宣布完成'].reason, /^总 Agent 报告目标已完成，但范围内还有/u);
    for (const row of state.tasks) assert.doesNotMatch(results[row.name].reason, /^(.{4,}?)：\1/u, `${row.name} 的原因重复了：${results[row.name].reason}`);

    // Questions: both the orchestrator's and the worker's were answered in their own chats, with free text.
    const asked = results['自动回答/提问'], detail = await runDetail(asked.runId);
    assert.equal(asked.autoAnswers.length, 2); assert.ok(asked.autoAnswers.every(row => row.answer === AUTO_ANSWER && /用哪种材料/u.test(row.question)));
    const worker = detail.workers[0].chatId;
    assert.deepEqual(new Set(asked.autoAnswers.map(row => row.chatId)), new Set([detail.orchestratorChatId, worker]), 'Each answer goes to the chat named by its item');
    for (const chatId of [detail.orchestratorChatId, worker]) {
      // chat/questions refuses a finished task's chat, so the answer is read from the conversation itself.
      const history = await app.json(`chat?id=${encodeURIComponent(chatId)}`);
      const results = history.events.filter(event => event.type === 'tool/result' && JSON.stringify(event).includes(AUTO_ANSWER));
      assert.equal(results.length, 1, `${chatId}: the question's tool result carries the automatic answer`);
    }

    // Studio's view: stopped where a person is needed, completed otherwise; never more than two at once, and two did overlap.
    const started = (await runs()).filter(run => !before.has(run.id));
    assert.equal(started.length, 5);
    for (const row of state.tasks) assert.equal((await runDetail(row.runId)).state, row.status === 'completed' ? 'completed' : 'stopped', row.name);
    const spans = started.map(run => [Date.parse(run.startedAt), Date.parse(run.endedAt)]);
    const overlap = Math.max(...spans.map(([at]) => spans.filter(([from, to]) => from <= at && at < to).length));
    assert.equal(overlap, 2, `--parallel 2: at most and at least two runs at a time (${overlap})`);

    // Trajectories hold every conversation of the run.
    for (const row of state.tasks) {
      const files = await zipEntries(join(out, row.folder, 'trajectory.zip')), run = await runDetail(row.runId);
      assert.ok(chatIn(files, run.orchestratorChatId), `${row.name}: 导出包里没有总 Agent 的对话 ${run.orchestratorChatId}：\n${[...files.keys()].join('\n')}`);
      for (const item of run.workers) assert.ok(chatIn(files, item.chatId), `${row.name}: 导出包里没有子 Agent ${item.chatId} 的对话`);
      // The run's own record (cli/设计.md §8 and §10 trajectory export): settings, usage, events, items and workers.
      const runFile = [...files.keys()].find(name => name.endsWith(`/autonomy/${row.runId}/run.json`));
      assert.ok(runFile, `${row.name}: 导出包里没有 autonomy/${row.runId}/run.json`);
      const record = JSON.parse(files.get(runFile));
      assert.equal(record.format, 'harnessstudio-autonomy-run/1'); assert.equal(record.orchestratorChatId, run.orchestratorChatId);
      assert.deepEqual(new Set(record.workers.map(item => item.chatId)), new Set(run.workers.map(item => item.chatId)), `${row.name}: run.json lists every worker`);
      if (row.status !== 'completed') assert.ok(record.attention.length > 0, `${row.name}: run.json keeps the item that needed a person`);
    }

    const summary = await json(join(out, 'summary.json'));
    assert.deepEqual(summary.counts, { completed: 2, 'needs-human': 3, failed: 0, interrupted: 0, pending: 0, running: 0 }); assert.equal(summary.interrupted, false); assert.equal(summary.tasks.length, 5);
    const csv = await readFile(join(out, 'summary.csv'), 'utf8');
    assert.ok(csv.startsWith('\uFEFF任务,结果,')); assert.equal(csv.trim().split('\r\n').length, 6);
    assert.match(result.stdout, /任务\s+结果\s+用时\s+折算 token\s+网页链接/u);
    for (const row of state.tasks) assert.ok(result.stdout.includes(`${app.base}/#project=${row.projectId}`), `汇总表里有 ${row.name} 的链接`);
    assert.match(result.stdout, /^\[\d\d:\d\d:\d\d\] /mu, 'Not a terminal: one line per change');
    assert.ok(!/needs-human|orchestratorModel|tokenBudget|waiting-human|undefined/u.test(result.stdout + result.stderr), `No internal names for people:\n${result.stdout}`);
    console.log(`  batch: ${state.tasks.map(row => `${row.name}=${row.status}`).join('，')}`);
  },

  /** The first Ctrl+C stops what runs, exports and exits with 130; --resume runs only what is left, in new projects. */
  async interrupt() {
    const directory = join(scratch, 'interrupt'), out = join(directory, 'out');
    const tasks = [
      { name: '快一', goal: goal({ creates: [leaf('A', '快任务一')] }) },
      { name: '慢', goal: goal({ creates: [leaf('A', '慢任务')], workers: { A: { delayMs: 1500 } } }) },
      { name: '快二', goal: goal({ creates: [leaf('A', '快任务二')] }) },
    ];
    const path = await manifest(directory, tasks), count = (await runs()).length;
    const running = cli(['run', path, '--url', app.base, '--out', out]);
    const state = await waitFor(() => json(join(out, 'batch-state.json')), value => value.tasks[0].status === 'completed' && value.tasks[1].status === 'running' && value.tasks[1].runId, 'The slow task did not start');
    const slow = state.tasks[1];
    await waitFor(() => runDetail(slow.runId), value => value.workers.length > 0, 'The slow run sent no worker');
    running.child.kill('SIGINT');
    const result = await finished(running, 60000);
    assert.equal(result.code, 130, result.stdout + result.stderr);
    assert.match(result.stderr, /正在停止本次启动的运行/u); assert.match(result.stdout, /--resume/u);
    const after = await json(join(out, 'batch-state.json'));
    assert.deepEqual(after.tasks.map(row => row.status), ['completed', 'interrupted', 'pending']);
    const stopped = await json(join(out, '慢', 'result.json'));
    assert.equal(stopped.status, 'interrupted'); assert.equal(stopped.trajectory.file, 'trajectory.zip'); assert.ok(chatIn(await zipEntries(join(out, '慢', 'trajectory.zip')), (await runDetail(slow.runId)).orchestratorChatId));
    assert.equal((await runDetail(slow.runId)).state, 'stopped', 'The interrupted run is stopped in Studio');
    assert.equal(existsSync(join(out, '快二', 'result.json')), false, 'An unstarted task has no result');
    assert.equal((await json(join(out, 'summary.json'))).interrupted, true);
    assert.equal((await runs()).length, count + 2);

    const resumed = await finished(cli(['run', path, '--resume', out, '--url', app.base]));
    assert.equal(resumed.code, 0, resumed.stdout + resumed.stderr);
    assert.equal((await runs()).length, count + 4, 'Only the interrupted and the unstarted task run again');
    const final = await json(join(out, 'batch-state.json'));
    assert.deepEqual(final.tasks.map(row => row.status), ['completed', 'completed', 'completed']);
    assert.equal(final.tasks[0].projectId, state.tasks[0].projectId, 'The finished task is skipped');
    assert.notEqual(final.tasks[1].projectId, slow.projectId, 'The interrupted task runs in a new project');
    const rerun = await json(join(out, '慢', 'result.json'));
    assert.equal(rerun.status, 'completed'); assert.equal(rerun.previousAttempts[0].projectId, slow.projectId); assert.equal(rerun.previousAttempts[0].status, 'interrupted');
    assert.equal((await json(join(out, '慢', 'attempts', '1', 'result.json'))).status, 'interrupted');
    assert.ok((await app.json('projects')).some(project => project.id === slow.projectId), 'The old project stays');
    assert.match(resumed.stdout, /完成（上次）/u);
  },

  /** A second Ctrl+C exits at once. */
  async twice() {
    const directory = join(scratch, 'twice'), out = join(directory, 'out');
    const path = await manifest(directory, [{ name: '慢', goal: goal({ creates: [leaf('A', '慢任务')], workers: { A: { delayMs: 3000 } } }) }]);
    const running = cli(['run', path, '--url', app.base, '--out', out]);
    const state = await waitFor(() => json(join(out, 'batch-state.json')), value => value.tasks[0].runId, 'The task did not start');
    running.child.kill('SIGINT'); await delay(100); running.child.kill('SIGINT');
    const began = Date.now(), result = await finished(running, 20000);
    assert.equal(result.code, 130); assert.ok(Date.now() - began < 5000, 'The second interrupt exits at once'); assert.match(result.stderr, /立即退出/u);
    assert.ok(existsSync(join(out, 'batch-state.json')));
    const left = await runDetail(state.tasks[0].runId);
    if (['running', 'paused', 'waiting-human', 'blocked'].includes(left.state)) await app.json('autonomy/stop', { id: left.id, revision: left.revision });
  },

  /** Files reach the project's shared folder (vm_manager mode, with a fake vm_manager and a temporary projects folder). */
  async upload() {
    const projects = join(scratch, 'vm-projects'), fake = await fakeVmManager(projects), home = await mkdtemp(join(root, '.studio/cli-run-vm-'));
    await mkdir(projects, { recursive: true });
    // config/smoke.patch.yml replaces the domain's config without vm storage, so this Studio gets its own overlay.
    const overlay = join(scratch, 'vm-storage.patch.yml');
    await writeFile(overlay, `- id: studio-domain\n  config:\n    dataRoot: !!js dshHomePath('studio')\n    workflowMode: single-user\n    legacyWorkspaceIds: []\n    maxFileBytes: 262144\n    softwareBackend: vm-manager\n    vmProjectsRoot: ${JSON.stringify(projects)}\n    vmEndpoint: ${JSON.stringify(fake.url)}\n    vmTrustedHttpOrigins: [${JSON.stringify(fake.url)}]\n`);
    const saved = { ...process.env }, main = app;
    Object.assign(process.env, { STUDIO_SEAT_BACKEND: 'vm-manager', STUDIO_VMM_URL: fake.url, STUDIO_VMM_TRUSTED_HTTP_ORIGINS: fake.url, STUDIO_VMM_PROJECTS_ROOT: projects, STUDIO_CONFIG_PATCH: overlay });
    try {
      app = await startApp(home);
      const directory = join(scratch, 'upload'), out = join(directory, 'out');
      await mkdir(join(directory, 'inputs'), { recursive: true }); await writeFile(join(directory, 'inputs', '箱体草图.txt'), '受控测试的输入文件\n');
      const path = await manifest(directory, [{ name: '带文件的任务', files: ['./inputs/箱体草图.txt'], goal: goal({ creates: [leaf('A', '读草图的任务')] }) }]);
      const result = await finished(cli(['run', path, '--url', app.base, '--out', out]));
      assert.equal(result.code, 0, result.stdout + result.stderr);
      const done = await json(join(out, '带文件的任务', 'result.json'));
      assert.equal(await readFile(join(projects, done.projectId, 'shared', '箱体草图.txt'), 'utf8'), '受控测试的输入文件\n', 'The file is on the project’s F: drive');
      const run = (await app.json(`autonomy/runs?projectId=${done.projectId}`)).runs[0];
      assert.match(run.objective, /F: 盘.*箱体草图\.txt/u, 'The objective tells the Agent where the file is');
      // The batch command asks for workspace=1 and says nothing about shared; the input file comes along with the export.
      const archive = await zipEntries(join(out, '带文件的任务', 'trajectory.zip')), input = [...archive.keys()].find(name => name.endsWith('/shared/箱体草图.txt'));
      assert.ok(input, `导出包里有项目共享盘（F:）上的输入文件：\n${[...archive.keys()].join('\n')}`); assert.equal(archive.get(input).toString('utf8'), '受控测试的输入文件\n');
      assert.equal(JSON.parse(archive.get([...archive.keys()].find(name => name.endsWith('/project.json')))).options.shared, true, 'shared follows workspace');
    } finally {
      if (app !== main) await stopApp(app.child);
      app = main; for (const key of ['STUDIO_SEAT_BACKEND', 'STUDIO_VMM_URL', 'STUDIO_VMM_TRUSTED_HTTP_ORIGINS', 'STUDIO_VMM_PROJECTS_ROOT', 'STUDIO_CONFIG_PATCH']) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
      await fake.close(); await release(home);
    }
  },

  /** Without software (STUDIO_SEAT_BACKEND=none): files reach the project's shared space in Studio's own data folder. */
  async noSoftware() {
    const home = await mkdtemp(join(root, '.studio/cli-run-none-')), saved = process.env.STUDIO_SEAT_BACKEND, main = app;
    process.env.STUDIO_SEAT_BACKEND = 'none';
    try {
      app = await startApp(home);
      assert.equal((await app.json('status')).softwareBackend, 'none');
      const directory = join(scratch, 'none'), out = join(directory, 'out');
      await mkdir(join(directory, 'inputs'), { recursive: true }); await writeFile(join(directory, 'inputs', '工况.csv'), '工况,载荷\n额定,5600\n');
      const path = await manifest(directory, [{ name: '无软件的任务', files: ['./inputs/工况.csv'], budget: { vms: 1 }, goal: goal({ creates: [leaf('A', '读工况的任务')] }) }]);
      const result = await finished(cli(['run', path, '--url', app.base, '--out', out]));
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /没有接入软件和虚拟机，清单里的 budget\.vms 不起作用/u);
      const done = await json(join(out, '无软件的任务', 'result.json'));
      assert.equal(await readFile(join(home, 'studio', 'files', done.projectId, 'shared', '工况.csv'), 'utf8'), '工况,载荷\n额定,5600\n', 'The file is in the project’s shared space');
      const run = await runDetail(done.runId);
      assert.match(run.objective, /已放到项目公共空间根目录的文件：工况\.csv$/u); assert.doesNotMatch(run.objective, /虚拟机|F: 盘/u, 'No VM is named where there is none');
      assert.equal(run.settings.maxVms, 0, 'Studio holds the VM limit at 0 without software');
      const archive = await zipEntries(join(out, '无软件的任务', 'trajectory.zip')), names = [...archive.keys()];
      assert.ok(!names.some(name => /\/vm\//u.test(name)), 'No VM part in the export');
      const input = names.find(name => name.endsWith('/shared/工况.csv'));
      assert.ok(input, `导出包里有项目公共空间的输入文件：\n${names.join('\n')}`); assert.equal(archive.get(input).toString('utf8'), '工况,载荷\n额定,5600\n');
    } finally {
      if (app !== main) await stopApp(app.child);
      app = main; if (saved === undefined) delete process.env.STUDIO_SEAT_BACKEND; else process.env.STUDIO_SEAT_BACKEND = saved;
      await release(home);
    }
  },

  /** The cli image with §7.1's arguments: same-path mounts, the caller's user, --init forwarding Ctrl+C. */
  async docker() {
    // Built from this checkout whenever Docker is here; CLI_RUN_IMAGE names an image built already.
    let image = process.env.CLI_RUN_IMAGE;
    if (!image) {
      const server = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' });
      if (server.error || server.status !== 0) {
        console.log(`  docker: 跳过，这里没有可用的 Docker（${(server.error?.message ?? server.stderr ?? '').trim().split('\n')[0]}）。在装了 Docker 的主机上运行这个脚本会测容器方式`);
        return 'skipped';
      }
      image = 'harnessstudio/cli:verify-cli-run';
      const built = await finished(cli(['build', '--target', 'cli', '-t', image, root], { command: 'docker', cwd: root }), 600000);
      assert.equal(built.code, 0, `cli 镜像构建失败：\n${(built.stdout + built.stderr).slice(-3000)}`);
      console.log(`  docker: 用这份源码构建了 ${image}`);
    }
    const work = join(scratch, 'docker-work'), lists = join(scratch, 'docker-lists');
    await mkdir(work, { recursive: true });
    const uid = process.getuid(), gid = process.getgid();
    await writeFile(join(lists, '..', 'docker-input.txt'), 'x').catch(() => undefined);
    const quick = await manifest(lists, [{ name: '容器里的任务', goal: goal({ creates: [leaf('A', '容器任务')] }) }, { name: '慢', goal: goal({ creates: [leaf('A', '容器慢任务')], workers: { A: { delayMs: 3000 } } }) }]);
    const args = out => ['run', '--rm', '--init', '--network', 'host', '--user', `${uid}:${gid}`, '-v', `${work}:${work}`, '-w', work, '-v', `${lists}:${lists}:ro`, '-e', `HARNESSSTUDIO_URL=${app.base}`, image, 'run', quick, '--out', out, '--no-video'];
    const running = cli(args('out'), { command: 'docker', cwd: work });
    const state = await waitFor(() => json(join(work, 'out', 'batch-state.json')), value => value.tasks[0].status === 'completed' && value.tasks[1].runId, 'The container did not reach the second task', 120000);
    await waitFor(() => runDetail(state.tasks[1].runId), value => value.workers.length > 0, 'The slow run sent no worker');
    running.child.kill('SIGINT');
    const result = await finished(running, 60000);
    assert.equal(result.code, 130, `docker run 收到 Ctrl+C 后退出码是 130\n${result.stdout}\n${result.stderr}`);
    const after = await json(join(work, 'out', 'batch-state.json'));
    assert.deepEqual(after.tasks.map(row => row.status), ['completed', 'interrupted']);
    assert.equal((await runDetail(state.tasks[1].runId)).state, 'stopped');
    for (const file of ['batch-state.json', 'summary.json', 'summary.csv', join('容器里的任务', 'result.json'), join('容器里的任务', 'trajectory.zip'), join('慢', 'result.json'), join('慢', 'trajectory.zip')]) {
      const info = await stat(join(work, 'out', file));
      assert.equal(info.uid, uid, `${file} 属于调用者`); assert.equal(info.gid, gid);
    }
    assert.equal((await json(join(work, 'out', '容器里的任务', 'result.json'))).status, 'completed');
    // The list directory is mounted read-only and outside the working folder: a file outside both is refused.
    const outside = await manifest(lists, [{ name: '引用外面的文件', files: ['../docker-input.txt'], goal: '受控测试' }]);
    const refused = await finished(cli([...args('refused').slice(0, -5), 'run', outside], { command: 'docker', cwd: work }));
    assert.equal(refused.code, 1); assert.match(refused.stderr, /不在当前目录或清单所在目录里|找不到文件/u);
    console.log('  docker: 同路径挂载、文件属主、Ctrl+C 收尾都正常');
  },
};

/** Only what Studio needs in vm-manager mode without starting a VM: environments, resources and task workspaces. */
async function fakeVmManager(projectsRoot) {
  const spaces = new Map();
  const send = (response, status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
  const server = createServer(async (request, response) => {
    let body = ''; for await (const part of request) body += part;
    const url = new URL(request.url, 'http://vmm'), path = url.pathname, input = body ? JSON.parse(body) : {};
    if (request.method === 'GET' && path === '/v1/environments') return send(response, 200, { data: { items: [] } });
    if (request.method === 'GET' && path === '/v1/host/resources') return send(response, 200, { data: { cpu: { total: 16, allocated: 0, available: 16 }, memory_gb: { total: 62, allocated: 0, available: 60 }, disk_gb: { total: 100, used: 1, available: 99 }, vms: { running: 0, queued: 0 } } });
    if (request.method === 'GET' && path === '/v1/vms') return send(response, 200, { data: { items: [] } });
    if (request.method === 'GET' && path === '/v1/workspaces') return send(response, 200, { data: { total: 0, items: [...spaces.values()].filter(row => row.project_id === url.searchParams.get('project_id') && row.task_id === url.searchParams.get('task_id')) } });
    if (request.method === 'POST' && path === '/v1/workspaces') {
      const existing = [...spaces.values()].find(row => row.project_id === input.project_id && row.task_id === input.task_id);
      if (existing) return send(response, 409, { error: { code: 'WORKSPACE_EXISTS', message: '该任务已有任务空间', details: { workspace_id: existing.workspace_id } } });
      const row = { workspace_id: `ws_${spaces.size + 1}`, project_id: input.project_id, task_id: input.task_id, status: 'writable', path: join(projectsRoot, input.project_id, 'tasks', input.task_id) };
      await mkdir(row.path, { recursive: true }); spaces.set(row.workspace_id, row); return send(response, 200, { data: row });
    }
    const space = /^\/v1\/workspaces\/([^/]+)\/(freeze|unfreeze)$/u.exec(path);
    if (request.method === 'POST' && space && spaces.has(space[1])) { const row = spaces.get(space[1]); row.status = space[2] === 'freeze' ? 'frozen' : 'writable'; return send(response, 200, { data: row }); }
    send(response, 404, { error: { code: 'NOT_FOUND', message: `fake vm_manager: ${request.method} ${path}` } });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(done => { server.closeAllConnections(); server.close(done); }) };
}
/** Snapshot folders are read-only on purpose; open them up before removing the fixture. */
async function release(path) {
  try {
    const walk = async target => { const info = await lstat(target); if (info.isSymbolicLink()) return; if (info.isDirectory()) { await chmod(target, 0o700); for (const name of await readdir(target)) await walk(join(target, name)); } else await chmod(target, 0o600); };
    await walk(path);
  } catch { /* already gone */ } finally { await rm(path, { recursive: true, force: true }); }
}

const SAID = {
  bad: 'a list with problems starts nothing',
  batch: 'completion, automatic answers to orchestrator and worker questions, blocked, budget and early completion as needs-human, with result.json, summaries and complete trajectories; two runs at a time with --parallel 2',
  interrupt: 'Ctrl+C stops, exports and exits 130; --resume runs only what is left, in new projects',
  twice: 'a second Ctrl+C exits at once',
  upload: 'files reach the project’s shared drive (F: with vm_manager)',
  noSoftware: 'without software too, with an objective that names no VM',
  docker: 'the cli image with same-path mounts, the caller’s user and Ctrl+C',
};
const order = Object.keys(SAID);
const passed = [], skipped = [];
try {
  app = await startApp(join(scratch, 'home'));
  for (const name of order) {
    if (selected && !selected.includes(name)) continue;
    const began = Date.now(), outcome = await cases[name]();
    if (outcome === 'skipped') { skipped.push(name); console.log(`- ${name}（跳过）`); continue; }
    passed.push(name); console.log(`✔ ${name}（${Math.round((Date.now() - began) / 1000)} 秒）`);
  }
} finally {
  if (app) await stopApp(app.child);
  await release(scratch);
}
console.log(`${passed.length ? `harnessstudio run verification passed: ${passed.map(name => SAID[name]).join('; ')}.` : 'harnessstudio run verification ran no case.'}${skipped.length ? ` Skipped: ${skipped.join(', ')}.` : ''}`);
