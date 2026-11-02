// End-to-end acceptance of autonomous runs (autonomy/设计.md) against the deterministic smoke model: no external
// model, network or VM. Depends on A (agentCompleteTask, completedBy) and B (autonomy tools, /api/studio/autonomy/*).
// Run it in the test image so the image's own plugins are exercised:
//   docker run --rm --user node --tmpfs /opt/harnessstudio/.studio:uid=1000,gid=1000,exec --entrypoint node \
//     harnessstudio/studio:auto-d-test scripts/verify-autonomy.mjs
// AUTONOMY_CASES=project,branch,... runs a subset while debugging.
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { root } from './prepare.mjs';
import { startApp, stopApp } from './verify-app.mjs';

const model = { provider: 'studio-smoke', model: 'm1-smoke' };
const selected = process.env.AUTONOMY_CASES?.split(',').map(name => name.trim()).filter(Boolean);
const ORCHESTRATOR_TOOLS = ['studio_autonomy_message_worker', 'studio_autonomy_start_worker', 'studio_autonomy_status', 'studio_autonomy_stop_worker', 'studio_autonomy_wait'];
const COMPLETION_TOOLS = ['studio_agent_complete_task', 'studio_agent_completion_preview'];
const DEFAULTS = { maxWorkers: 3, maxVms: 2, maxHours: 8, tokenBudget: 20000000, cacheReadWeight: 0.1, maxRounds: 200, maxNudges: 10, stuckFailures: 5, stuckIdleRounds: 3 };
const ACTIVE = ['running', 'paused', 'waiting-human', 'blocked'];

await mkdir(join(root, '.studio'), { recursive: true });
const home = await mkdtemp(join(root, '.studio/autonomy-test-'));
let app, current;

// ---- small helpers -------------------------------------------------------------------------------------------
const textOf = content => Array.isArray(content) ? content.filter(block => block.type === 'text').map(block => block.text).join('') : typeof content === 'string' ? content : '';
async function waitFor(read, ready, message, timeout = 60000) {
  const end = Date.now() + timeout; let value;
  while (Date.now() < end) { value = await read(); if (await ready(value)) return value; await delay(150); }
  throw new Error(`${message}\n最后一次读取：${JSON.stringify(value, null, 1)?.slice(0, 4000)}`);
}
const run = id => app.json(`autonomy/run?id=${encodeURIComponent(id)}`);
const untilRun = (id, ready, message, timeout) => waitFor(() => run(id), ready, message, timeout);
const chat = id => app.json(`chat?id=${encodeURIComponent(id)}`);
const task = id => app.json(`task?id=${encodeURIComponent(id)}`);
const graph = projectId => app.json(`graph?projectId=${encodeURIComponent(projectId)}`);
const chats = async () => (await app.json('status')).chats;
const snapshot = async taskId => (await app.json(`snapshot?taskId=${encodeURIComponent(taskId)}`)).snapshot;
const leaf = (key, title, extra = {}) => ({ key, ...extra, definition: { title, goal: `完成「${title}」（受控测试）`, checklist: [{ text: `${title}的结果文件已写出` }, { text: `${title}的内容已核对` }] } });
const group = (key, title) => ({ key, definition: { title, goal: `确认「${title}」下的子任务全部完成（受控测试）`, checklist: [{ text: '直属子任务都已由 Agent 完成' }] } });
const objective = script => `受控测试目标（不调用真实模型）\n[autonomy-smoke] ${JSON.stringify(script)}`;
async function start(projectId, script, settings = {}, extra = {}) {
  const detail = await app.json('autonomy/start', { projectId, objective: objective(script), settings: { orchestratorModel: model, workerModel: model, ...settings }, ...extra });
  current = detail.id; return detail;
}
/** pause / resume / stop with the run's current revision. */
async function control(id, action, body = {}) { const detail = await run(id); return app.json(`autonomy/${action}`, { id, revision: detail.revision, ...body }); }
async function update(id, change) { const detail = await run(id); return app.json('autonomy/update', { id, revision: detail.revision, ...change, ...(change.settings ? { settings: { ...detail.settings, ...change.settings } } : {}) }); }
const resolve = (id, attentionId, action) => app.json('autonomy/attention/resolve', { id, attentionId, action });
const openItems = (detail, kind) => detail.attention.filter(item => !item.resolvedAt && (!kind || item.kind === kind));
const worker = (detail, taskId) => detail.workers.find(row => row.taskId === taskId);
/** Every tool call of a chat with its result, in order. */
function calls(history) {
  return history.events.filter(event => event.type === 'tool/call').map(call => {
    const result = history.events.find(event => event.type === 'tool/result' && (event.data.message.source?.callId ?? event.data.message.callId) === call.data.callId);
    let args = call.data.arguments ?? call.data.args; if (typeof args === 'string') try { args = JSON.parse(args); } catch { /* keep text */ }
    return { name: call.data.name, args, isError: result ? result.data.message.isError === true : undefined, text: result ? textOf(result.data.message.content) : '' };
  });
}
const replies = history => history.events.filter(event => event.type === 'assistant/message').map(event => textOf(event.data.message.content));
const everything = history => history.events.map(event => event.type === 'user/message' ? textOf(event.data.content) : event.type === 'assistant/message' ? textOf(event.data.message.content) : event.type === 'tool/result' ? textOf(event.data.message.content) : '').join('\n');
const marker = (history, prefix) => { const text = replies(history).findLast(row => row.startsWith(prefix)); return text === undefined ? undefined : JSON.parse(text.slice(prefix.length).trim()); };
async function idle(ids, message) {
  return waitFor(chats, rows => ids.every(id => { const row = rows.find(item => item.id === id); return row && row.status !== 'running'; }), message, 20000);
}
async function sendProbe(scope, id, probe) {
  const before = id ? (await chat(id)).events.filter(event => event.type === 'turn/end').length : 0;
  const sent = await app.json('chat', { ...scope, ...(id ? { id } : {}), ...model, message: `[autonomy-probe] ${JSON.stringify(probe)}` });
  const history = await waitFor(() => chat(sent.id), value => value.status === 'idle' && value.events.filter(event => event.type === 'turn/end').length > before, 'Probe turn did not finish', 20000);
  const result = marker(history, 'AUTONOMY_PROBE');
  assert.ok(result, `Probe did not answer: ${replies(history).at(-1)}`); return { id: sent.id, history, result };
}
/** Raw session events of a chat (the debug export), oldest first. */
async function rawEvents(id) {
  const response = await fetch(`${app.base}/api/studio/chat/backup?${new URLSearchParams({ id })}`, { headers: { origin: app.base } });
  assert.equal(response.status, 200, 'The chat debug export must succeed');
  return (await response.json()).sessions.flatMap(session => session.events).sort((a, b) => a.seq - b.seq);
}
const weighted = (raw, weight) => Math.round(raw.uncachedInput + raw.cacheWrite + raw.output + raw.cacheRead * weight);
/** Read the stored ZIP (no compression, sizes in the central directory) of a project export. */
async function exportFiles(projectId) {
  const response = await fetch(`${app.base}/api/studio/project/export?${new URLSearchParams({ projectId })}`, { headers: { origin: app.base } });
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
/** Agent completion record of a task: who confirmed it, through which run and chat, with evidence on every target. */
async function agentCompleted(taskId, runId, chatId, by = model) {
  const view = await task(taskId);
  assert.equal(view.state, 'completed', `${view.title} 应由 Agent 完成`); assert.equal(view.completedBy, 'agent', `${view.title}: TaskView.completedBy`);
  const record = await snapshot(taskId), confirmation = record.humanConfirmation;
  assert.equal(confirmation.actor, 'agent'); assert.equal(confirmation.agent.runId, runId);
  if (chatId) assert.equal(confirmation.agent.chatId, chatId, `${view.title} 的完成记录指向错误的对话`);
  assert.equal(confirmation.agent.provider, by.provider); assert.equal(confirmation.agent.model, by.model);
  for (const goal of confirmation.goals.filter(goal => !goal.system)) assert.ok(goal.evidence?.trim(), `${view.title}: 目标 ${goal.id} 没有依据`);
  return { view, record };
}

// ---- cases ---------------------------------------------------------------------------------------------------
const cases = {
  async settings() {
    const initial = await app.json('autonomy/settings');
    assert.deepEqual(Object.fromEntries(Object.keys(DEFAULTS).map(key => [key, initial.settings[key]])), DEFAULTS, 'Global defaults follow 设计.md §6');
    const saved = await app.json('autonomy/settings', { revision: initial.revision, settings: { ...initial.settings, maxWorkers: 4 } });
    assert.equal(saved.settings.maxWorkers, 4); assert.ok(saved.revision > initial.revision);
    assert.equal((await app.call('autonomy/settings', { revision: initial.revision, settings: initial.settings })).status, 400, 'A stale settings page must be rejected');
    assert.equal((await app.call('autonomy/settings', { revision: saved.revision, settings: { ...saved.settings, unknown: 1 } })).status, 400, 'Unknown fields are rejected');
    await app.json('autonomy/settings', { revision: saved.revision, settings: { ...saved.settings, maxWorkers: DEFAULTS.maxWorkers } });
    const project = await app.json('projects', { title: '自主运行：启动校验' });
    const bad = body => app.call('autonomy/start', { projectId: project.id, objective: '受控测试', ...body });
    assert.equal((await bad({ settings: { workerModel: model } })).status, 400, 'The orchestrator model is required');
    assert.equal((await bad({ settings: { orchestratorModel: model } })).status, 400, 'The worker model is required');
    assert.equal((await bad({ settings: { orchestratorModel: model, workerModel: model }, unknown: true })).status, 400, 'Unknown start fields are rejected');
    const foreign = await app.json('projects', { title: '自主运行：其他项目' }), foreignTask = await app.json('task/quick', { projectId: foreign.id, title: '其他项目的任务' });
    assert.equal((await bad({ rootTaskId: foreignTask.id, settings: { orchestratorModel: model, workerModel: model } })).status, 400, 'The scope root must belong to the project');
  },

  async permissions() {
    const project = await app.json('projects', { title: '自主运行：普通对话的权限' }), plain = await app.json('task/quick', { projectId: project.id, title: '普通任务' });
    const probe = { calls: [{ name: 'studio_autonomy_status' }, { name: 'studio_autonomy_start_worker', args: { taskId: plain.id, instructions: 'x' } }, { name: 'studio_agent_report', args: { kind: 'progress', message: 'x' } },
      { name: 'studio_agent_completion_preview', args: { taskId: plain.id } }, { name: 'get_goal' }] };
    for (const scope of [{ projectId: project.id }, { taskId: plain.id }]) {
      const { result } = await sendProbe(scope, undefined, probe);
      assert.deepEqual(result.tools, [], `An ordinary ${scope.taskId ? 'task' : 'project'} chat is offered no autonomy or goal tools`);
      assert.deepEqual(result.humanOnly, [], 'No model chat is offered a task delete or clear tool');
      assert.ok(result.results.every(row => row.isError), `Ordinary chats cannot execute autonomy tools: ${JSON.stringify(result.results)}`);
    }
  },

  async project() {
    const project = await app.json('projects', { title: '自主运行：整个项目' });
    const script = { creates: [group('G', '自主测试任务组'), leaf('A', '任务 A', { parentId: '$G' }), leaf('B', '任务 B', { parentId: '$G' }), leaf('C', '任务 C', { parentId: '$G', dependencies: ['$A'] })],
      workers: { '*': { delayMs: 300 } } };
    const started = await start(project.id, script);
    assert.match(started.id, /^ar-/); assert.equal(started.projectId, project.id); assert.equal(started.rootTaskId, undefined);
    assert.ok(['running', 'waiting-human'].includes(started.state)); assert.ok(started.orchestratorChatId);
    for (const [key, value] of Object.entries(DEFAULTS)) assert.equal(started.settings[key], value, `Run settings copy the default ${key}`);
    assert.deepEqual(started.settings.orchestratorModel, model); assert.deepEqual(started.settings.workerModel, model);
    assert.equal((await app.call('autonomy/start', { projectId: project.id, objective: '第二个运行', settings: { orchestratorModel: model, workerModel: model } })).status, 400, 'One unfinished run per project');
    let parallel = 0;
    const final = await untilRun(started.id, async detail => {
      const busy = new Set(detail.workers.filter(row => row.state === 'running').map(row => row.chatId));
      for (const row of await chats()) if (row.runId === started.id && row.role === 'worker' && row.status === 'running') busy.add(row.id);
      parallel = Math.max(parallel, busy.size); return detail.state === 'completed';
    }, 'Project run did not complete', 90000);
    assert.ok(parallel >= 2, 'Independent tasks A and B must be worked on in parallel');
    assert.ok(final.endedAt); assert.equal(openItems(final).length, 0);
    assert.ok(final.usage.tokens > 0, 'Token usage is counted'); assert.ok(final.usage.rounds >= 1, 'Goal rounds are counted');
    const tasks = (await graph(project.id)).tasks, id = title => tasks.find(row => row.title === title).id;
    const [G, A, B, C] = ['自主测试任务组', '任务 A', '任务 B', '任务 C'].map(id);
    for (const taskId of [A, B, C]) await agentCompleted(taskId, started.id, worker(final, taskId)?.chatId);
    const groupRecord = await agentCompleted(G, started.id, started.orchestratorChatId);
    assert.ok(groupRecord.record.humanConfirmation.childrenVersion, 'The orchestrator confirmed the group against its previewed children');
    const aRecord = await snapshot(A), cRecord = await snapshot(C);
    assert.deepEqual(aRecord.files.map(file => file.path), ['result.md'], 'The worker submitted its result file');
    assert.ok(Date.parse(cRecord.createdAt) > Date.parse(aRecord.createdAt), 'Downstream C finished after its upstream A');
    // Conversations: one orchestrator project chat, one worker task chat per leaf, all marked with the run.
    const rows = (await chats()).filter(row => row.runId === started.id);
    assert.deepEqual(rows.filter(row => row.role === 'orchestrator').map(row => [row.id, row.scope]), [[started.orchestratorChatId, 'project']]);
    assert.deepEqual(rows.filter(row => row.role === 'worker').map(row => row.taskId).sort(), [A, B, C].sort());
    // The run completes as soon as the goal does; the orchestrator's closing reply follows a moment later.
    const orchestrator = await waitFor(() => chat(started.orchestratorChatId), value => value.status !== 'running' && marker(value, 'AUTONOMY_ORCHESTRATOR_DONE'), 'The orchestrator did not finish its last turn', 20000);
    const first = orchestrator.events.find(event => event.type === 'user/message');
    assert.equal(first.data.source.kind, 'harnessstudio-autonomy'); assert.equal(first.data.source.from, 'controller'); assert.equal(first.data.source.runId, started.id);
    const done = marker(orchestrator, 'AUTONOMY_ORCHESTRATOR_DONE');
    // The orchestrator's system prompt stays the same while workers start, tasks complete and the group is confirmed.
    const raw = await rawEvents(started.orchestratorChatId), marked = raw.find(event => JSON.stringify(event.data ?? {}).includes('"name":"update_goal"'));
    assert.ok(marked, 'The orchestrator marked its goal');
    const prompts = raw.filter(event => event.type === 'system/message' && event.seq < marked.seq).length;
    assert.equal(prompts, 1, `The orchestrator's system prompt changed ${prompts - 1} times during the run`);
    assert.ok(done, 'The orchestrator marked the goal complete');
    for (const name of [...ORCHESTRATOR_TOOLS, ...COMPLETION_TOOLS, 'get_goal', 'update_goal']) assert.ok(done.tools.includes(name), `Orchestrator is offered ${name}`);
    assert.ok(!done.tools.includes('studio_agent_report'));
    const workerChat = await waitFor(() => chat(worker(final, A).chatId), value => value.status !== 'running' && marker(value, 'AUTONOMY_WORKER_DONE'), 'Worker A did not finish its last turn', 20000), instruction = workerChat.events.find(event => event.type === 'user/message');
    assert.equal(instruction.data.source.kind, 'harnessstudio-autonomy'); assert.equal(instruction.data.source.from, 'orchestrator');
    assert.deepEqual(marker(workerChat, 'AUTONOMY_WORKER_DONE').tools, ['studio_agent_complete_task', 'studio_agent_completion_preview', 'studio_agent_report'], 'Workers get the report and completion tools only');
    // Activity log and the project export timeline carry autonomy events and the Agent completions.
    const files = await exportFiles(project.id), lines = [...files].filter(([name]) => name.endsWith('.jsonl')).flatMap(([, data]) => data.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)));
    const actions = lines.map(row => row.action ?? row.event?.action ?? row.data?.action).filter(Boolean);
    assert.ok(actions.some(action => action.startsWith('autonomy/')), 'Exported events include autonomy/* actions');
    assert.ok(lines.some(row => (row.action ?? row.event?.action) === 'task/agent-complete' && (row.actor ?? row.event?.actor) === 'agent'), 'Exported events include Agent completions');
    const timeline = files.get([...files.keys()].find(name => name.endsWith('timeline/timeline.jsonl'))).toString('utf8');
    assert.match(timeline, /autonomy\//); assert.match(timeline, /task\/agent-complete/);
    // A person reopens an Agent-completed task: its downstream goes to recheck as before.
    const reopened = await task(A); await app.json('task/action', { id: A, revision: reopened.revision, action: 'resume' });
    assert.equal((await task(C)).state, 'recheck', 'Continuing an Agent-completed task sends downstream work to recheck');
    assert.equal((await app.json(`autonomy/runs?projectId=${project.id}`)).runs[0].id, started.id);
  },

  async branch() {
    const project = await app.json('projects', { title: '自主运行：任务分支' });
    const rootTask = await app.json('task/quick', { projectId: project.id, title: '分支根任务' });
    const inside = await app.json('task/quick', { projectId: project.id, parentId: rootTask.id, title: '分支内已有任务' });
    const outside = await app.json('task/quick', { projectId: project.id, title: '分支外任务' });
    const outsideChecklist = { taskId: outside.id, revision: outside.revision, items: JSON.stringify([{ text: '范围外清单' }]) };
    const script = { creates: [leaf('X', '分支任务 X'), leaf('Y', '分支任务 Y')],
      after: [
        { patch: { creates: [{ key: 'o', parentId: outside.id, definition: { title: '总 Agent 范围外新增' } }] }, expectError: true },
        { patch: { updates: [{ id: outside.id, changes: { title: '总 Agent 范围外改名' } }] }, expectError: true },
        { name: 'studio_update_checklist', args: outsideChecklist, expectError: true },
        { name: 'studio_autonomy_start_worker', args: { taskId: outside.id, instructions: '[autonomy-worker] {"taskId":"x"}' }, expectError: true },
      ],
      workers: { X: { before: [{ complete: '@Y', expectError: true },
        { patch: { creates: [{ key: 'w', parentId: outside.id, definition: { title: '子 Agent 范围外新增' } }] }, expectError: true },
        { name: 'studio_update_checklist', args: outsideChecklist, expectError: true }] } } };
    const started = await start(project.id, script, {}, { rootTaskId: rootTask.id });
    assert.equal(started.rootTaskId, rootTask.id);
    const final = await untilRun(started.id, detail => detail.state === 'completed', 'Branch run did not complete', 90000);
    const orchestratorRow = (await chats()).find(row => row.id === started.orchestratorChatId);
    assert.equal(orchestratorRow.scope, 'task'); assert.equal(orchestratorRow.taskId, rootTask.id, 'A branch run is driven from a chat on its root task');
    const orchestratorCalls = calls(await chat(started.orchestratorChatId));
    const probes = orchestratorCalls.filter(row => row.args?.taskId === outside.id || (row.name === 'studio_apply_graph_patch' && JSON.stringify(row.args).includes(outside.id)));
    assert.ok(probes.length >= 4 && probes.every(row => row.isError), `The orchestrator cannot change or dispatch outside its branch: ${JSON.stringify(probes)}`);
    const tasks = (await graph(project.id)).tasks, X = tasks.find(row => row.title === '分支任务 X').id, Y = tasks.find(row => row.title === '分支任务 Y').id;
    const xCalls = calls(await chat(worker(final, X).chatId));
    const foreign = xCalls.filter(row => row.args?.taskId === Y || JSON.stringify(row.args).includes(outside.id));
    assert.ok(foreign.some(row => row.name === 'studio_agent_complete_task'), 'Worker X tried to complete Y');
    assert.ok(foreign.filter(row => row.name !== 'studio_graph_context').every(row => row.isError || row.name === 'studio_agent_completion_preview'), `A worker cannot complete another task or edit outside its branch: ${JSON.stringify(foreign)}`);
    assert.ok(foreign.find(row => row.name === 'studio_agent_complete_task').isError);
    const outsideNow = await task(outside.id);
    assert.equal(outsideNow.title, '分支外任务'); assert.equal(outsideNow.state, 'unstarted'); assert.deepEqual(outsideNow.checklist, outside.checklist);
    assert.ok(!tasks.some(row => row.parentId === outside.id), 'Nothing was created under the outside task');
    assert.ok(final.workers.every(row => [X, Y, inside.id].includes(row.taskId)), 'Only in-scope tasks got workers');
    assert.ok(final.workers.some(row => row.taskId === inside.id), 'The existing in-scope task was dispatched too');
    assert.ok(!(await chats()).some(row => row.taskId === outside.id), 'No conversation was opened on the outside task');
    await agentCompleted(Y, started.id, worker(final, Y).chatId);
    await agentCompleted(rootTask.id, started.id, started.orchestratorChatId);
  },

  async question() {
    const project = await app.json('projects', { title: '自主运行：提问' });
    const ask = id => ({ name: 'ask_user_question', args: { questions: [{ id, header: '材料', question: '受控测试：用哪种材料？', options: [{ label: '钢', description: '测试选项' }, { label: '铝', description: '测试选项' }] }] } });
    const script = { before: [ask('scope')], creates: [leaf('A', '提问任务 A'), leaf('B', '不受影响的任务 B')], workers: { A: { before: [ask('material')] }, B: { delayMs: 400 } } };
    const started = await start(project.id, script);
    const answer = async chatId => {
      const view = await waitFor(() => app.json(`chat/questions?id=${chatId}`), value => value.pending.some(item => item.canAnswer), 'Question did not become answerable');
      const pending = view.pending[0];
      await app.json('chat/questions/answer', { id: chatId, callId: pending.callId, answers: [{ id: pending.questions[0].id, selected: ['钢'] }] });
    };
    let detail = await untilRun(started.id, value => value.state === 'waiting-human' && openItems(value, 'question').some(item => item.chatId === started.orchestratorChatId), 'The orchestrator question did not make the run wait for a person');
    assert.equal(detail.workers.length, 0, 'Nothing is dispatched before the orchestrator gets its answer');
    await answer(started.orchestratorChatId);
    detail = await untilRun(started.id, value => openItems(value, 'question').some(item => item.chatId && item.chatId !== started.orchestratorChatId), 'The worker question did not open an item');
    assert.equal(detail.state, 'waiting-human');
    const item = openItems(detail, 'question')[0];
    const tasks = (await graph(project.id)).tasks, B = tasks.find(row => row.title === '不受影响的任务 B').id;
    detail = await untilRun(started.id, async value => (await task(B)).state === 'completed', 'Other workers must keep working while one waits for a person');
    assert.equal(detail.state, 'waiting-human'); assert.ok(openItems(detail).some(row => row.id === item.id));
    await answer(item.chatId);
    const final = await untilRun(started.id, value => value.state === 'completed', 'The run did not finish after the answer');
    assert.ok(final.attention.find(row => row.id === item.id).resolvedAt, 'Answering resolves the question item');
  },

  async blocked() {
    const project = await app.json('projects', { title: '自主运行：报告受阻' });
    const script = { creates: [leaf('A', '需要人工登录的任务')], workers: { A: { before: [{ name: 'studio_agent_report', args: { kind: 'blocked', message: '需要人工登录许可证服务器（受控测试）' } }, 'end-turn'] } } };
    const started = await start(project.id, script);
    const detail = await untilRun(started.id, value => value.state === 'waiting-human' && openItems(value, 'blocked').length === 1, 'A blocked report must open a blocked item');
    const item = openItems(detail, 'blocked')[0], A = (await graph(project.id)).tasks[0].id;
    assert.match(item.message, /许可证/); assert.equal(item.taskId, A); assert.notEqual((await task(A)).state, 'completed');
    await resolve(started.id, item.id, 'resolved');
    const final = await untilRun(started.id, value => value.state === 'completed', 'The run did not continue after the item was handled');
    await agentCompleted(A, started.id, worker(final, A).chatId);
  },

  async stuck() {
    const project = await app.json('projects', { title: '自主运行：卡住检测' });
    const fail = { name: 'studio_read_file', args: { path: '受控测试-不存在的文件.md' } };
    const script = { creates: [leaf('A', '反复失败的任务')], workers: { A: { before: [fail, fail, fail, 'end-turn'] } } };
    const started = await start(project.id, script, { stuckFailures: 3 });
    const detail = await untilRun(started.id, value => openItems(value, 'stuck').length === 1, 'Repeated failures must open a stuck item');
    assert.equal(detail.state, 'waiting-human');
    await resolve(started.id, openItems(detail, 'stuck')[0].id, 'continue');
    const final = await untilRun(started.id, value => value.state === 'completed', 'The run did not continue after 让它继续');
    const A = (await graph(project.id)).tasks[0].id;
    await agentCompleted(A, started.id, worker(final, A).chatId);
  },

  async budget() {
    const project = await app.json('projects', { title: '自主运行：折算 token 预算' });
    // Each call: 500 uncached input and output, 10,000 cache reads. Weighted 1,500 per call (80 % is crossed before
    // 100 %), raw 10,500.
    const usage = { inputTokens: 300, outputTokens: 200, cacheReadTokens: 10000 };
    const script = { creates: [leaf('A', '预算任务 A'), leaf('B', '预算任务 B')], usage, workers: { '*': { usage, delayMs: 200 } } };
    const started = await start(project.id, script, { tokenBudget: 10000 });
    const paused = await untilRun(started.id, value => value.state === 'paused' && value.pauseReason === 'budget-tokens', 'A small weighted budget must pause the run');
    assert.equal(openItems(paused, 'budget').length, 1); assert.ok(paused.events.some(event => event.type === 'budget-warning'), 'A budget warning comes first at 80 %');
    assert.match(openItems(paused, 'budget')[0].message, /折算 token 预算已用完/);
    const raw = paused.usage.tokenBreakdown, total = raw.uncachedInput + raw.cacheRead + raw.cacheWrite + raw.output;
    assert.equal(paused.usage.tokens, weighted(raw, 0.1), 'The budget counts cache reads at 10 %');
    assert.ok(total > paused.usage.tokens * 5 && raw.cacheRead > 0, `Raw tokens (${total}) far exceed the weighted count (${paused.usage.tokens})`);
    const ids = [paused.orchestratorChatId, ...paused.workers.map(row => row.chatId)];
    await idle(ids, 'Budget pause must stop every turn');
    const workers = paused.workers.length; await delay(2500);
    assert.equal((await run(started.id)).workers.length, workers, 'No workers are dispatched during a budget pause');
    // A new weight recounts what was used so far.
    const reweighted = await update(started.id, { settings: { cacheReadWeight: 0.05 } });
    assert.equal(reweighted.usage.tokens, weighted(reweighted.usage.tokenBreakdown, 0.05), 'Changing the weight recounts at once');
    assert.ok(reweighted.events.some(event => event.type === 'human-edit' && /缓存读取改为按 5% 计入预算/.test(event.summary)));
    await update(started.id, { settings: { tokenBudget: DEFAULTS.tokenBudget } });
    await control(started.id, 'resume');
    const final = await untilRun(started.id, value => value.state === 'completed', 'The run did not finish after raising the budget');
    assert.equal(final.settings.tokenBudget, DEFAULTS.tokenBudget); assert.equal(final.settings.cacheReadWeight, 0.05);
    assert.equal(final.usage.tokens, weighted(final.usage.tokenBreakdown, 0.05));
  },

  async context() {
    // Autonomy conversations keep about 8000 characters of each tool result and compact at about 120,000 tokens on a
    // 1,000,000-token window; ordinary conversations keep about 32,000 characters and the engine's 80 % rule.
    const project = await app.json('projects', { title: '自主运行：上下文控制' });
    const big = { provider: model.provider, model: 'm1-smoke-1m' };
    const started = await start(project.id, { creates: [leaf('A', '大量检索的任务')], workers: { A: { fill: 200000 } } }, { workerModel: big });
    const final = await untilRun(started.id, value => value.state === 'completed', 'The filling worker did not finish', 180000);
    const A = worker(final, (await graph(project.id)).tasks[0].id), history = await chat(A.chatId);
    const fetched = calls(history).filter(row => row.name === 'web_fetch');
    assert.ok(fetched.length >= 10, `The worker fetched ${fetched.length} pages`);
    const sizes = fetched.map(row => row.text.length).filter(Boolean);
    assert.ok(sizes.length && Math.max(...sizes) <= 9000 && Math.max(...sizes) >= 6000, `Each result keeps about 8000 characters in an autonomy conversation: ${Math.max(...sizes)}`);
    assert.match(fetched.at(-1).text, /Full formatted result stored at: results\/web_fetch/, 'The full page stays in a temporary file');
    assert.equal((fetched.at(-1).text.match(/Full formatted result stored at/g) ?? []).length, 1, 'A result is cut once, with one file path');
    const events = await rawEvents(A.chatId), compactions = events.filter(event => event.type === 'compaction/start');
    assert.ok(compactions.length >= 1, 'The worker context was compacted');
    const before = events.filter(event => event.type === 'tool/result' && event.seq < compactions[0].seq).length;
    assert.ok(before <= 80, `Compaction started after ${before} tool results, at about 120,000 tokens rather than 800,000`);
    const ended = events.find(event => event.type === 'compaction/end');
    console.log(`  context: ${fetched.length} pages kept (largest ${Math.max(...sizes)} characters); first compaction after ${before} tool results; ${JSON.stringify(ended?.data ?? {}).slice(0, 300)}`);
    await agentCompleted(A.taskId, started.id, A.chatId, big);
    const plain = await app.json('task/quick', { projectId: project.id, title: '普通对话的抓取' });
    const ordinary = await app.json('chat', { taskId: plain.id, ...model, message: '[web-ui] 普通对话抓取一个大页面' });
    const done = await waitFor(() => chat(ordinary.id), value => value.status === 'idle' && value.events.some(event => event.type === 'turn/end'), 'The ordinary chat did not finish', 30000);
    const page = calls(done).find(row => row.name === 'web_fetch');
    assert.ok(page.text.length > 30000, `Ordinary conversations keep their 32,000-character cap: ${page.text.length}`);
  },

  async workers() {
    const project = await app.json('projects', { title: '自主运行：并发上限' });
    const script = { creates: [leaf('A', '并发任务 A'), leaf('B', '并发任务 B')], workers: { '*': { delayMs: 300 } } };
    const started = await start(project.id, script, { maxWorkers: 1 });
    let most = 0;
    await untilRun(started.id, detail => { most = Math.max(most, detail.workers.filter(row => row.state === 'running').length); return detail.state === 'completed'; }, 'maxWorkers run did not complete', 90000);
    assert.equal(most, 1, 'maxWorkers 1 allows one active worker at a time');
    assert.ok(calls(await chat(started.orchestratorChatId)).some(row => row.name === 'studio_autonomy_start_worker' && row.isError), 'Starting a second worker beyond the limit is refused');
  },

  async control() {
    const project = await app.json('projects', { title: '自主运行：暂停继续停止' });
    const script = { creates: [leaf('A', '慢任务 A'), leaf('B', '慢任务 B'), leaf('C', '慢任务 C')], delayMs: 700, workers: { '*': { delayMs: 1500 } } };
    const started = await start(project.id, script);
    await untilRun(started.id, value => value.workers.length >= 1, 'No worker was dispatched');
    const paused = await control(started.id, 'pause');
    assert.equal(paused.state, 'paused'); assert.equal(paused.pauseReason, 'user');
    await idle([paused.orchestratorChatId, ...paused.workers.map(row => row.chatId)], 'Pausing must stop the orchestrator and worker turns');
    const count = (await run(started.id)).workers.length; await delay(3000);
    assert.equal((await run(started.id)).workers.length, count, 'No workers are dispatched while paused');
    assert.ok(count < 3, 'The pause landed before every task was dispatched');
    const resumed = await control(started.id, 'resume'); assert.equal(resumed.state, 'running');
    await untilRun(started.id, async value => value.workers.length === 3 && (await graph(project.id)).tasks.some(row => row.state === 'completed'), 'Resume did not continue dispatching');
    const stopped = await control(started.id, 'stop');
    assert.equal(stopped.state, 'stopped'); assert.ok(stopped.endedAt);
    const ids = [stopped.orchestratorChatId, ...stopped.workers.map(row => row.chatId)];
    await idle(ids, 'Stopping must stop every turn');
    const rows = await chats();
    for (const id of ids) assert.equal(rows.find(row => row.id === id)?.runId, started.id, 'Run conversations are kept, with their run marker');
    const tasks = (await graph(project.id)).tasks, completed = tasks.filter(row => row.state === 'completed');
    assert.ok(completed.length >= 1);
    for (const row of completed) assert.equal(row.completedBy, 'agent', 'Completed work is kept after stop');
    // The ended run's tools stop working at once, even where the chat still lists them until it is reloaded.
    const orchestratorProbe = await sendProbe({ projectId: project.id }, stopped.orchestratorChatId, { calls: [{ name: 'studio_autonomy_status' }, { name: 'studio_autonomy_wait', args: { timeoutSeconds: 1 } }] });
    assert.ok(orchestratorProbe.result.results.every(row => row.isError), `Orchestrator tools must fail after stop: ${JSON.stringify(orchestratorProbe.result.results)}`);
    const open = stopped.workers.find(row => !completed.some(item => item.id === row.taskId)) ?? stopped.workers[0];
    const workerProbe = await sendProbe({ taskId: open.taskId }, open.chatId, { calls: [{ name: 'studio_agent_report', args: { kind: 'progress', message: '运行已停止' } }, { name: 'studio_agent_completion_preview', args: { taskId: open.taskId } }] });
    assert.ok(workerProbe.result.results.every(row => row.isError), `Worker tools must fail after stop: ${JSON.stringify(workerProbe.result.results)}`);
    assert.equal((await app.call('autonomy/resume', { id: started.id, revision: (await run(started.id)).revision })).status, 400, 'A stopped run cannot be resumed');
  },

  async early() {
    const project = await app.json('projects', { title: '自主运行：提前宣布完成' });
    const script = { creates: [leaf('A', '先做的任务 A'), leaf('B', '依赖 A 的任务 B', { dependencies: ['$A'] })], completeEarly: true, workers: { '*': { delayMs: 600 } } };
    const started = await start(project.id, script);
    const waiting = await untilRun(started.id, value => openItems(value, 'incomplete').length === 1, 'Marking the goal complete early must open an incomplete item');
    assert.equal(waiting.state, 'waiting-human');
    const tasks = (await graph(project.id)).tasks, A = tasks.find(row => row.title === '先做的任务 A'), B = tasks.find(row => row.title === '依赖 A 的任务 B');
    const item = openItems(waiting, 'incomplete')[0];
    assert.ok(item.message.includes(B.code) || item.message.includes(B.title), 'The incomplete item lists the unfinished tasks');
    await waitFor(() => task(A.id), value => value.state === 'completed', 'Running workers may finish while the run waits');
    await delay(1500);
    assert.ok(!(await run(started.id)).workers.some(row => row.taskId === B.id), 'Nothing new is dispatched while the person decides');
    const rounds = (await run(started.id)).usage.rounds;
    await resolve(started.id, item.id, 'continue');
    const final = await untilRun(started.id, value => value.state === 'completed', 'The run did not finish after 让它继续做', 90000);
    assert.ok(final.usage.rounds > rounds, 'Rounds keep counting across the replacement goal');
    await agentCompleted(B.id, started.id, worker(final, B.id).chatId);
    assert.match(everything(await chat(started.orchestratorChatId)), /attention-resolved/, 'The orchestrator was told the item was resolved');
    // Accepting instead ends the run with unfinished tasks left as they are.
    const second = await app.json('projects', { title: '自主运行：接受提前完成' });
    const run2 = await start(second.id, { creates: [leaf('A', '接受时未完成的任务')], completeEarly: true, workers: { '*': { delayMs: 1500 } } });
    const open = await untilRun(run2.id, value => openItems(value, 'incomplete').length === 1, 'Second early completion did not wait for a person');
    const accepted = await resolve(run2.id, openItems(open, 'incomplete')[0].id, 'accept');
    assert.equal(accepted.state, 'completed');
  },

  async restart() {
    const project = await app.json('projects', { title: '自主运行：服务重启' });
    const script = { creates: [leaf('A', '重启任务 A'), leaf('B', '重启任务 B')], workers: { '*': { delayMs: 1000 } } };
    const started = await start(project.id, script);
    await untilRun(started.id, value => value.workers.length >= 1, 'No worker was dispatched before the restart');
    await stopApp(app.child); app = await startApp(home);
    const paused = await run(started.id);
    assert.equal(paused.state, 'paused'); assert.equal(paused.pauseReason, 'restart'); assert.equal(openItems(paused, 'restart').length, 1);
    await delay(2000);
    assert.equal((await run(started.id)).state, 'paused', 'Nothing resumes by itself after a restart');
    await control(started.id, 'resume');
    const final = await untilRun(started.id, value => value.state === 'completed', 'The run did not finish after resuming from a restart', 90000);
    for (const row of (await graph(project.id)).tasks) await agentCompleted(row.id, started.id, worker(final, row.id).chatId);
  },

  async edits() {
    const project = await app.json('projects', { title: '自主运行：运行中修改' });
    const script = { creates: [leaf('A', '修改测试 A'), leaf('B', '修改测试 B', { dependencies: ['$A'] })], workers: { '*': { delayMs: 800 } } };
    const started = await start(project.id, script);
    await untilRun(started.id, value => value.workers.length >= 1, 'No worker was dispatched');
    const edited = await update(started.id, { objective: `${objective(script)}\n（人在运行中修改了目标）` });
    assert.match(edited.objective, /人在运行中修改了目标/);
    const B = (await graph(project.id)).tasks.find(row => row.title === '修改测试 B'), view = await task(B.id);
    await app.json('task/metadata', { id: B.id, revision: view.revision, title: view.title, goal: view.goal, checklist: [...view.checklist, { text: '人在运行中加的清单项' }] });
    await app.json('task/quick', { projectId: project.id, title: '人在运行中新增的任务' });
    await untilRun(started.id, value => value.events.some(event => event.type === 'human-edit'), 'Human edits must reach the run as human-edit events');
    const final = await untilRun(started.id, value => value.state === 'completed', 'The run did not finish after human edits', 90000);
    assert.match(everything(await chat(started.orchestratorChatId)), /human-edit/, 'The orchestrator received the human-edit event');
    const record = await agentCompleted(B.id, started.id, worker(final, B.id).chatId);
    assert.ok(record.record.humanConfirmation.goals.some(goal => goal.label === '人在运行中加的清单项' && goal.evidence), 'The new checklist item was checked with evidence');
  },

  async vms() {
    // A separate Studio in vm-manager mode against a minimal fake vm_manager (tests/ is not in the image).
    const fake = await fakeVmManager();
    const vmHome = await mkdtemp(join(root, '.studio/autonomy-vm-test-'));
    const saved = { ...process.env }, previous = app;
    Object.assign(process.env, { STUDIO_SEAT_BACKEND: 'vm-manager', STUDIO_VMM_URL: fake.url, STUDIO_VMM_TRUSTED_HTTP_ORIGINS: fake.url });
    try {
      app = await startApp(vmHome);
      const project = await app.json('projects', { title: '自主运行：虚拟机上限' });
      const launch = id => ({ name: 'studio_software_launch', args: { imageId: 'win11-autocad2026', requestId: `autonomy-${id}` }, expectError: true });
      const script = { creates: [leaf('A', '虚拟机任务 A'), leaf('B', '虚拟机任务 B')], workers: { A: { before: [launch('a')] }, B: { delayMs: 1500, before: [launch('b')] } } };
      const started = await start(project.id, script, { maxVms: 1 });
      const final = await untilRun(started.id, value => value.state === 'completed', 'VM limit run did not complete', 90000);
      const results = await Promise.all(final.workers.map(async row => calls(await chat(row.chatId)).find(call => call.name === 'studio_software_launch')));
      assert.equal(results.filter(row => !row.isError).length, 1, `maxVms 1 lets exactly one VM start: ${JSON.stringify(results)}`);
      assert.match(results.find(row => row.isError).text, /虚拟机/, 'The refusal explains the VM limit');
      assert.equal(fake.created(), 1);
    } catch (error) { await diagnose('vms'); throw error; } finally {
      if (app) await stopApp(app.child);
      app = previous; for (const key of ['STUDIO_SEAT_BACKEND', 'STUDIO_VMM_URL', 'STUDIO_VMM_TRUSTED_HTTP_ORIGINS']) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
      await fake.close(); await release(vmHome);
    }
  },
};

/** Keep the evidence a reviewer needs: the run as Studio saw it, and the last steps of its conversations. */
async function diagnose(name) {
  if (!current || !app) return;
  try {
    const detail = await run(current);
    console.error(`\n[${name}] run ${current}: ${JSON.stringify({ state: detail.state, pauseReason: detail.pauseReason, usage: detail.usage, workers: detail.workers, attention: detail.attention, events: detail.events.slice(0, 15) }, null, 1)}`);
    for (const id of [detail.orchestratorChatId, ...detail.workers.map(row => row.chatId)]) {
      const history = await chat(id), ended = history.events.findLast(event => event.type === 'turn/end')?.data?.reason;
      console.error(`[${name}] chat ${id} (${history.status}): ${calls(history).slice(-8).map(row => `${row.name}${row.isError ? `✗(${row.text.slice(0, 120)})` : ''}`).join(' → ')} | ${replies(history).at(-1)?.slice(0, 300)} | turn end ${JSON.stringify(ended)?.slice(0, 600)}`);
    }
  } catch (inner) { console.error(`[${name}] diagnostics failed: ${inner.message}`); }
  current = undefined;
}

/** Only what Studio needs to create and watch VMs (vm_manager api.md): {data} envelopes, async create. */
async function fakeVmManager() {
  const vms = new Map(), spaces = new Map(); let sequence = 0;
  const environments = [{ environment_id: 'win11-autocad2026', os: 'windows11', software: [{ name: 'AutoCAD', version: '2026' }], min_spec: { cpu_cores: 4, ram_gb: 8 } }];
  const send = (response, status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
  const server = createServer(async (request, response) => {
    let body = ''; for await (const part of request) body += part;
    const url = new URL(request.url, 'http://vmm'), path = url.pathname, input = body ? JSON.parse(body) : {};
    const vm = /^\/v1\/vms\/([^/]+)$/.exec(path)?.[1];
    if (request.method === 'GET' && path === '/v1/environments') return send(response, 200, { data: { items: environments } });
    if (request.method === 'GET' && path === '/v1/host/resources') return send(response, 200, { data: { cpu: { total: 16, allocated: 0, available: 16 }, memory_gb: { total: 62, allocated: 0, available: 60 }, disk_gb: { total: 100, used: 1, available: 99 }, vms: { running: vms.size, queued: 0 } } });
    if (request.method === 'GET' && path === '/v1/workspaces') return send(response, 200, { data: { total: 0, items: [...spaces.values()].filter(row => row.project_id === url.searchParams.get('project_id') && row.task_id === url.searchParams.get('task_id')) } });
    if (request.method === 'POST' && path === '/v1/workspaces') {
      const existing = [...spaces.values()].find(row => row.project_id === input.project_id && row.task_id === input.task_id);
      if (existing) return send(response, 409, { error: { code: 'WORKSPACE_EXISTS', message: '该任务已有任务空间', details: { workspace_id: existing.workspace_id } } });
      const row = { workspace_id: `ws_${spaces.size + 1}`, project_id: input.project_id, task_id: input.task_id, status: 'writable', path: `/srv/projects/${input.project_id}/tasks/${input.task_id}` }; spaces.set(row.workspace_id, row); return send(response, 200, { data: row });
    }
    const space = /^\/v1\/workspaces\/([^/]+)\/(freeze|unfreeze)$/.exec(path);
    if (request.method === 'POST' && space && spaces.has(space[1])) { const row = spaces.get(space[1]); row.status = space[2] === 'freeze' ? 'frozen' : 'writable'; return send(response, 200, { data: row }); }
    if (request.method === 'GET' && path === '/v1/vms') return send(response, 200, { data: { items: [...vms.values()].filter(row => (!url.searchParams.get('task_id') || row.task_id === url.searchParams.get('task_id')) && (!url.searchParams.get('project_id') || row.project_id === url.searchParams.get('project_id'))).map(({ vm_id, project_id, task_id, status }) => ({ vm_id, project_id, task_id, status })) } });
    if (request.method === 'POST' && path === '/v1/vms') {
      const id = `vm_${String(++sequence).padStart(8, '0')}`;
      vms.set(id, { vm_id: id, project_id: input.project_id, task_id: input.task_id, chat_id: input.chat_id ?? null, status: 'queued', environment_id: input.environment_id, os: 'windows11', software: [], spec: input.spec ?? { cpu_cores: 4, ram_gb: 8 }, expose: { vnc: true, rdp: true }, lifecycle: { timeout_minutes: 120, queue_timeout_minutes: 30 }, created_at: new Date().toISOString(), queue: { position: 1, reason: 'waiting_turn' }, mounts: { workspace: { workspace_id: 'ws_1', writable: true }, upstreams: [] }, access: { host: '127.0.0.1', vnc_port: null, rdp_port: null, agent_port: null } });
      return send(response, 200, { data: { vm_id: id, status: 'queued', queue_position: 1, workspace_id: 'ws_1' } });
    }
    if (vm && vms.has(vm) && request.method === 'GET') return send(response, 200, { data: vms.get(vm) });
    if (vm && request.method === 'DELETE') { vms.delete(vm); return send(response, 200, { data: { vm_id: vm, status: 'deleted' } }); }
    send(response, 404, { error: { code: 'NOT_FOUND', message: `fake vm_manager: ${request.method} ${path}` } });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${server.address().port}`, created: () => sequence, close: () => new Promise(done => server.close(done)) };
}

/** Snapshot folders are read-only on purpose; open up only this fixture before removing it. */
async function release(path) {
  try {
    const walk = async target => { const info = await lstat(target); if (info.isSymbolicLink()) return; if (info.isDirectory()) { await chmod(target, 0o700); for (const name of await readdir(target)) await walk(join(target, name)); } else await chmod(target, 0o600); };
    await walk(path);
  } finally { await rm(path, { recursive: true, force: true }); }
}

const order = ['settings', 'permissions', 'project', 'branch', 'question', 'blocked', 'stuck', 'budget', 'context', 'workers', 'control', 'early', 'edits', 'restart', 'vms'];
const passed = [];
try {
  app = await startApp(home);
  for (const name of order.filter(name => !selected || selected.includes(name))) {
    current = undefined; const began = Date.now();
    try { await cases[name](); }
    catch (error) {
      await diagnose(name);
      throw new Error(`Autonomy case "${name}" failed: ${error.message}`, { cause: error });
    }
    passed.push(`${name} ${((Date.now() - began) / 1000).toFixed(1)}s`);
  }
  console.log(`Autonomy verification passed (${passed.join(', ')}): settings and start validation; ordinary chats without autonomy tools; whole-project and branch runs with parallel workers, dependency order, Agent completion records with evidence and orchestrator group confirmation; scope refusals for both roles; questions, blocked and stuck items; token budget pause and maxWorkers; pause, resume and stop with tools failing after the end; early completion with continue and accept; human edits; restart to paused; recheck after a person reopens Agent work; activity log and export timeline; maxVms against a fake vm_manager.`);
} finally {
  if (app) await stopApp(app.child);
  await release(home);
}
