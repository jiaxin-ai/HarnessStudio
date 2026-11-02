import type { GenerateOptions, StreamChunk, ToolCallId } from '@deepseek-ai/dsh-llm';
import { brandString } from '@deepseek-ai/dsh-brand';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Deterministic orchestrator and worker for autonomous runs (设计.md 第 4 节). The run objective carries
 * `[autonomy-smoke] {...}`; the orchestrator hands each worker `[autonomy-worker] {...}` as its instructions.
 * Every decision is derived from the persisted conversation, never from adapter memory, so pause, stop, restart
 * and resume all continue from what the session actually recorded.
 */
type Json = Record<string, unknown>;
type Message = GenerateOptions['messages'][number];
/** Provider counts for one call: inputTokens is the uncached input; cache reads and writes are separate, as DSH meters them. */
export interface Usage { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
/** One scripted call. `expectError` probes are allowed to fail; others are retried, `required` ones abort the turn. */
export interface CallOp { name: string; args?: Json; expectError?: boolean }
/** Preview a task and then try to complete it with evidence for every target (used to probe someone else's task). */
export interface CompleteOp { complete: string; expectError?: boolean }
/** Read the graph for its revision, then apply this patch (out-of-scope graph probes). */
export interface PatchOp { patch: Json; expectError?: boolean }
/** End the turn here and continue only after a new message arrives (human reply, resolved item, nudge). */
export type Op = CallOp | CompleteOp | PatchOp | 'end-turn';
/** `fill`: fetch the large fixture page until the context is compacted (or reaches `fill` estimated tokens), then work. */
export interface WorkerScript { taskId: string; before?: Op[]; fill?: number; file?: string; content?: string; delayMs?: number; usage?: Usage }
export interface OrchestratorScript {
  /** Graph patch `creates` for the initial plan; `$key` references are resolved by studio_apply_graph_patch. */
  creates?: Json[];
  /** Worker script per created key, per existing task ID, or `*` for the rest. `@key` strings become created IDs. */
  workers?: Record<string, Omit<WorkerScript, 'taskId'>>;
  /** Calls before planning (for example ask_user_question) and after planning (out-of-scope probes). */
  before?: Op[]; after?: Op[];
  waitSeconds?: number; delayMs?: number; usage?: Usage;
  /** End the turn once workers are out and mark the goal complete in the next goal round, with tasks unfinished. */
  completeEarly?: boolean;
}
export type Action = { call: { name: string; args: Json } } | { text: string };
interface Entry { name: string; args: Json; isError: boolean; text: string; value: unknown; callIndex: number; resultIndex: number }

export const ORCHESTRATOR_TAG = 'autonomy-smoke', WORKER_TAG = 'autonomy-worker', PROBE_TAG = 'autonomy-probe';
/** The web smoke provider's large page (about 140,000 characters). */
const FILL_URL = 'https://fixture.invalid/gear';
/** DSH's text estimate: about four characters per token. */
export const estimateTokens = (messages: readonly Message[]) => Math.round(messages.reduce((total, message) =>
  total + message.content.reduce((sum, block) => sum + (block.type === 'text' ? block.text.length : block.type === 'tool-call' ? block.arguments.length : 0), 0), 0) / 4);
const ORCHESTRATOR_TOOLS = ['studio_autonomy_status', 'studio_autonomy_start_worker', 'studio_autonomy_message_worker', 'studio_autonomy_stop_worker', 'studio_autonomy_wait'];
const GOAL_TOOLS = ['get_goal', 'create_goal', 'update_goal'];
/** Human-only operations must never reach a model (deleting files of its own task is ordinary work). */
const HUMAN_ONLY = /(?:delete|clear|purge|remove)_(?:task|project|vm)s?(?:_|$)|(?:task|project|vm)s?_(?:delete|clear|purge|remove)(?:_|$)/u;
const ATTENTION_KINDS = new Set(['question', 'blocked', 'stuck', 'budget', 'restart', 'incomplete']);
/** Message sources that start or steer a turn; other user-role notices (reminders, wrap-ups) arrive inside one. */
const TURN_SOURCES = new Set(['user', 'goal', 'harnessstudio-autonomy']);
const MAX_RETRIES = 3, MAX_NUDGES = 3;

const textOf = (message: Message) => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
const sourceKind = (message: Message) => (message.source as { kind?: string } | undefined)?.kind;
const parse = (text: string): unknown => { try { return JSON.parse(text); } catch { return undefined; } };
const record = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);

/** The JSON object after `[tag]`, also when the text was quoted into a JSON string (goal prompts quote the objective). */
export function tagged(text: string, tag: string): Json | undefined {
  const unescaped = text.replace(/\\(["\\/bfnrt]|u[0-9a-fA-F]{4})/gu, match => JSON.parse(`"${match}"`) as string);
  for (const candidate of text === unescaped ? [text] : [text, unescaped]) {
    const at = candidate.indexOf(`[${tag}]`); if (at < 0) continue;
    const start = candidate.indexOf('{', at); if (start < 0) continue;
    let depth = 0, quoted = false, escaped = false, end = -1;
    for (let index = start; index < candidate.length && end < 0; index++) {
      const char = candidate[index];
      if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; }
      else if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) end = index;
    }
    const value = end < 0 ? undefined : parse(candidate.slice(start, end + 1));
    if (record(value)) return value;
  }
  return undefined;
}

/** The chat's autonomous role and script, from the first message that carries one. The tag that comes first decides:
 * an orchestrator script may contain worker instructions, and worker instructions may quote the run objective. */
export function findScript(messages: readonly Message[]): { role: 'orchestrator'; script: OrchestratorScript } | { role: 'worker'; script: WorkerScript } | undefined {
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const text = textOf(message), at = (tag: string) => { const index = text.indexOf(`[${tag}]`); return index < 0 ? Infinity : index; };
    const worker = at(WORKER_TAG) < at(ORCHESTRATOR_TAG) ? tagged(text, WORKER_TAG) : undefined;
    if (worker) { if (typeof worker.taskId !== 'string') throw new Error('Autonomy smoke: worker script needs taskId'); return { role: 'worker', script: worker as unknown as WorkerScript }; }
    const orchestrator = text.includes(`[${ORCHESTRATOR_TAG}]`) ? tagged(text, ORCHESTRATOR_TAG) : undefined;
    if (orchestrator) return { role: 'orchestrator', script: orchestrator as OrchestratorScript };
  }
  return undefined;
}

/** Every tool call of this chat with its persisted result. A call without a result (cut by a restart) counts as failed. */
export function history(messages: readonly Message[]): Entry[] {
  const entries: Entry[] = [];
  messages.forEach((message, index) => {
    if (message.role !== 'assistant') return;
    for (const block of message.content) {
      if (block.type !== 'tool-call') continue;
      const resultIndex = messages.findIndex((row, at) => at > index && row.role === 'tool' && row.toolCallId === block.id);
      const result = resultIndex < 0 ? undefined : messages[resultIndex];
      const text = result ? textOf(result) : '';
      entries.push({ name: block.name, args: (parse(block.arguments) ?? {}) as Json, isError: !result || (result.role === 'tool' && result.isError === true), text, value: parse(text), callIndex: index, resultIndex: resultIndex < 0 ? index : resultIndex });
    }
  });
  return entries;
}

/** update_goal complete needs the current goal round (or a direct human message) in the open turn; a turn ends at a
 * model reply without tool calls. */
export function inGoalRound(messages: readonly Message[]): boolean {
  const end = messages.findLastIndex(message => message.role === 'assistant' && !message.content.some(block => block.type === 'tool-call'));
  return messages.slice(end + 1).some(message => message.role === 'user' && ['goal', 'user'].includes(sourceKind(message) ?? ''));
}

/** Objects anywhere in a tool result that satisfy `accept`; status/wait shapes are matched loosely by field name. */
export function collect(value: unknown, accept: (row: Json) => boolean, found: Json[] = []): Json[] {
  if (Array.isArray(value)) for (const item of value) collect(item, accept, found);
  else if (record(value)) { if (accept(value)) found.push(value); for (const item of Object.values(value)) collect(item, accept, found); }
  return found;
}

function resolveKeys<T>(value: T, ids: ReadonlyMap<string, string>): T {
  if (typeof value === 'string') return value.replace(/@([A-Za-z][A-Za-z0-9_-]*)/gu, (match, key: string) => ids.get(key) ?? match) as T;
  if (Array.isArray(value)) return value.map(item => resolveKeys(item, ids)) as T;
  if (record(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveKeys(item, ids)])) as T;
  return value;
}

/** Completion arguments with evidence for every target of the preview: the overall goal and each checklist item. */
export function completion(taskId: string, preview: unknown, files?: { path: string; description: string }[]): Json {
  const view = record(preview) ? preview : {};
  const goals = Array.isArray(view.goals) ? view.goals.filter(record) : [];
  const evidence = (label: unknown) => `已检查：${String(label ?? '')}。${files ? `核对了工作文件 ${files.map(file => file.path).join('、')} 的内容，与要求一致` : '核对了直属子任务的完成记录，均已完成'}（受控测试依据）。`;
  const goal = goals.find(row => row.id === 'goal');
  return {
    taskId, revision: view.taskRevision ?? view.revision ?? 0, workspaceVersion: view.workspaceVersion ?? '',
    ...(typeof view.childrenVersion === 'string' ? { childrenVersion: view.childrenVersion } : {}),
    evidence: { goal: evidence(goal?.label ?? view.title), checklist: goals.filter(row => row.id !== 'goal' && row.system !== true).map(row => ({ id: row.id, evidence: evidence(row.label) })) },
    ...(files ? { files } : { withoutFiles: true }),
  };
}

/** A new message arrived after `index`: one that starts or steers a turn, or anything after the turn's closing reply. */
export function resumedAfter(messages: readonly Message[], index: number): boolean {
  const later = messages.slice(index + 1), closed = later.findIndex(message => message.role === 'assistant' && !message.content.some(block => block.type === 'tool-call'));
  return later.some((message, at) => message.role === 'user' && (TURN_SOURCES.has(sourceKind(message) ?? '') || (closed >= 0 && at > closed)));
}

type Template = { name: string; args: (previous: Entry | undefined) => Json; mode: 'probe' | 'retry' | 'required' };
const isTemplate = (op: Op | Template): op is Template => typeof op === 'object' && 'args' in op && typeof op.args === 'function';
const graphRead: Template['args'] = () => ({ limit: 100 });
function expand(op: Exclude<Op, 'end-turn'>, mode: Template['mode']): Template[] {
  const probe = 'expectError' in op && op.expectError ? 'probe' : mode;
  if ('complete' in op) return [{ name: 'studio_agent_completion_preview', args: () => ({ taskId: op.complete }), mode: probe },
    { name: 'studio_agent_complete_task', args: previous => completion(op.complete, previous?.value), mode: probe }];
  if ('patch' in op) return [{ name: 'studio_graph_context', args: graphRead, mode: 'required' },
    { name: 'studio_apply_graph_patch', args: previous => ({ patch: JSON.stringify({ ...op.patch, revision: (previous?.value as { project?: { revision?: number } } | undefined)?.project?.revision ?? 0 }) }), mode: probe }];
  return [{ name: op.name, args: () => op.args ?? {}, mode: probe }];
}

/**
 * Walk a scripted sequence against the recorded calls. Returns the next action, or how many recorded calls the
 * sequence consumed once it is done. Failed `retry` steps repeat up to MAX_RETRIES; `required` failures throw.
 */
export function sequence(ops: readonly (Op | Template)[], entries: readonly Entry[], messages: readonly Message[], mode: Template['mode'], from = 0): { action: Action } | { consumed: number } {
  let at = from;
  for (const op of ops) {
    if (op === 'end-turn') {
      if (!resumedAfter(messages, entries[at - 1]?.resultIndex ?? -1)) return { action: { text: 'AUTONOMY_SMOKE_TURN_END 等待新的消息后继续。' } };
      continue;
    }
    for (const step of isTemplate(op) ? [op] : expand(op, mode)) {
      let failures = 0;
      for (;;) {
        const entry = entries[at];
        if (!entry) return { action: { call: { name: step.name, args: step.args(entries[at - 1]) } } };
        if (entry.name !== step.name) throw new Error(`Autonomy smoke: expected ${step.name} at call ${at + 1}, found ${entry.name}`);
        at++;
        if (!entry.isError || step.mode === 'probe') break;
        if (step.mode === 'required') throw new Error(`Autonomy smoke: ${step.name} failed: ${entry.text.slice(0, 400)}`);
        if (++failures >= MAX_RETRIES) return { action: { text: `AUTONOMY_SMOKE_GAVE_UP ${step.name} 连续失败：${entry.text.slice(0, 400)}` } };
      }
    }
  }
  return { consumed: at };
}

function checkTools(role: 'orchestrator' | 'worker', offered: readonly string[]): void {
  const forbidden = offered.filter(name => HUMAN_ONLY.test(name));
  if (forbidden.length) throw new Error(`Autonomy smoke: human-only tools offered to a model: ${forbidden.join(', ')}`);
  const foreign = role === 'orchestrator' ? offered.filter(name => name === 'studio_agent_report') : offered.filter(name => ORCHESTRATOR_TOOLS.includes(name) || GOAL_TOOLS.includes(name));
  if (foreign.length) throw new Error(`Autonomy smoke: ${role} was offered another role's tools: ${foreign.join(', ')}`);
}
/** The autonomy-related tools a chat was offered, reported in final replies for the acceptance script. */
export const autonomyTools = (offered: readonly string[]) => offered.filter(name => /^(?:studio_autonomy_|studio_agent_)/u.test(name) || GOAL_TOOLS.includes(name)).sort();

export function workerNext(script: WorkerScript, messages: readonly Message[], offered: readonly string[]): Action {
  checkTools('worker', offered);
  const entries = history(messages), file = script.file ?? 'result.md', files = [{ path: file, description: `子 Agent 为任务写出的结果（受控测试）` }];
  const before = sequence(script.before ?? [], entries, messages, 'probe');
  if ('action' in before) return before.action;
  let from = before.consumed;
  if (script.fill) {
    // Counted by what the context holds now, not by call positions: compaction replaces old calls with a checkpoint.
    const compacted = messages.some(message => message.role === 'user' && sourceKind(message) === 'compact-checkpoint');
    if (!compacted && estimateTokens(messages) < script.fill) return { call: { name: 'web_fetch', args: { url: FILL_URL } } };
    from = Math.max(from, entries.findLastIndex(entry => entry.name === 'web_fetch') + 1);
  }
  const main: Template[] = [
    { name: 'studio_write_file', args: () => ({ path: file, content: script.content ?? `# 结果\n\n任务 ${script.taskId} 的受控测试结果。\n` }), mode: 'retry' },
    { name: 'studio_agent_report', args: () => ({ kind: 'progress', message: `已写出 ${file}，开始核对清单。` }), mode: 'retry' },
  ];
  const rest = sequence(main, entries, messages, 'retry', from);
  if ('action' in rest) return rest.action;
  // Preview, then complete with that preview; a refused completion (the task changed meanwhile) previews again.
  const tail = entries.slice(rest.consumed), completes = tail.filter(entry => entry.name === 'studio_agent_complete_task');
  if (completes.some(entry => !entry.isError)) return { text: `AUTONOMY_WORKER_DONE ${JSON.stringify({ taskId: script.taskId, tools: autonomyTools(offered) })}` };
  const failed = [...completes, ...tail.filter(entry => entry.name === 'studio_agent_completion_preview' && entry.isError)];
  if (failed.length >= MAX_RETRIES) return { text: `AUTONOMY_SMOKE_GAVE_UP 确认完成连续失败：${failed.at(-1)!.text.slice(0, 400)}` };
  const last = tail.at(-1);
  if (last?.name === 'studio_agent_completion_preview' && !last.isError) return { call: { name: 'studio_agent_complete_task', args: completion(script.taskId, last.value, files) } };
  return { call: { name: 'studio_agent_completion_preview', args: { taskId: script.taskId } } };
}

interface GraphTask { id: string; state: string; isFolder: boolean; parentId?: string; dependencies?: string[]; archived?: boolean; code?: string; title?: string }
export function orchestratorNext(script: OrchestratorScript, messages: readonly Message[], offered: readonly string[]): Action {
  checkTools('orchestrator', offered);
  const entries = history(messages);
  const before = sequence(script.before ?? [], entries, messages, 'probe');
  if ('action' in before) return before.action;
  const creates = script.creates ?? [];
  const planning: Template[] = [
    { name: 'studio_autonomy_status', args: () => ({}), mode: 'required' },
    { name: 'studio_graph_context', args: graphRead, mode: 'required' },
    ...(creates.length ? [{ name: 'studio_apply_graph_patch', args: (previous: Entry | undefined) => ({ patch: JSON.stringify({ revision: (previous?.value as { project?: { revision?: number } } | undefined)?.project?.revision ?? 0, creates }) }), mode: 'required' as const }] : []),
  ];
  const planned = sequence(planning, entries, messages, 'required', before.consumed);
  if ('action' in planned) return planned.action;
  const ids = new Map<string, string>();
  const patchResult = creates.length ? entries[planned.consumed - 1]?.value : undefined;
  for (const row of collect(patchResult, row => typeof row.key === 'string' && typeof row.id === 'string')) ids.set(row.key as string, row.id as string);
  const after = sequence(resolveKeys(script.after ?? [], ids), entries, messages, 'probe', planned.consumed);
  if ('action' in after) return after.action;

  const loop = entries.slice(after.consumed);
  const call = (name: string, args: Json = {}): Action => ({ call: { name, args } });
  // Each cycle starts from a fresh status and graph read, after every wait and at every new turn (resume, goal
  // round, controller notice); the actions below rely on those reads until the next boundary.
  const boundary = Math.max(loop.findLast(entry => entry.name === 'studio_autonomy_wait')?.resultIndex ?? -1,
    messages.findLastIndex(message => message.role === 'user' && TURN_SOURCES.has(sourceKind(message) ?? '')));
  const cycle = loop.filter(entry => entry.callIndex > boundary), last = cycle.at(-1), latest = loop.at(-1);
  // A wait that reports a person's queued message, or a paused or ended run, means: end this turn now.
  const waited = latest?.name === 'studio_autonomy_wait' && !latest.isError && latest.resultIndex === boundary ? latest.value as { humanMessage?: boolean; note?: string } | undefined : undefined;
  if (waited?.humanMessage || waited?.note) return { text: `AUTONOMY_ORCHESTRATOR_TURN_END ${waited.humanMessage ? '有人发来消息，结束本轮去读。' : waited.note}` };
  if (last?.name === 'get_goal' && !last.isError) {
    const goal = (last.value as { goal?: { id?: string; revision?: number } } | undefined)?.goal;
    return call('update_goal', { goal_id: goal?.id ?? '', revision: goal?.revision ?? 0, action: 'complete' });
  }
  if (last?.name === 'update_goal') return { text: last.isError ? `AUTONOMY_ORCHESTRATOR_TURN_END update_goal 被拒绝：${last.text.slice(0, 300)}` : `AUTONOMY_ORCHESTRATOR_DONE ${JSON.stringify({ tools: autonomyTools(offered) })}` };
  if (!cycle.some(entry => entry.name === 'studio_autonomy_status')) return call('studio_autonomy_status');
  if (!cycle.some(entry => entry.name === 'studio_graph_context' && !entry.isError)) return call('studio_graph_context', { limit: 100 });
  const graph = cycle.findLast(entry => entry.name === 'studio_graph_context' && !entry.isError)!.value as { scope?: { taskId?: string }; tasks?: GraphTask[] } | undefined;
  const status = cycle.findLast(entry => entry.name === 'studio_autonomy_status' && !entry.isError)?.value;
  const all = (graph?.tasks ?? []).filter(task => !task.archived), root = graph?.scope?.taskId;
  const inScope = (task: GraphTask): boolean => !root || task.id === root || (!!task.parentId && all.some(parent => parent.id === task.parentId && inScope(parent)));
  const tasks = all.filter(inScope), done = new Set(tasks.filter(task => task.state === 'completed').map(task => task.id));
  const goalMarked = entries.some(entry => entry.name === 'update_goal' && !entry.isError);
  const started = new Set(entries.filter(entry => entry.name === 'studio_autonomy_start_worker' && !entry.isError).map(entry => entry.args.taskId as string));
  const finish = (): Action => inGoalRound(messages) ? call('get_goal') : { text: 'AUTONOMY_ORCHESTRATOR_TURN_END 在下一个 goal Round 中标记完成。' };
  if (script.completeEarly && !goalMarked && started.size) return finish();
  if (tasks.length && tasks.every(task => done.has(task.id))) return finish();

  const depth = (task: GraphTask): number => task.parentId ? 1 + depth(all.find(row => row.id === task.parentId) ?? { id: '', state: '', isFolder: false }) : 0;
  for (const group of tasks.filter(task => task.isFolder && !done.has(task.id)).sort((a, b) => depth(b) - depth(a))) {
    const children = all.filter(task => task.parentId === group.id && !task.archived);
    if (!children.length || !children.every(child => done.has(child.id))) continue;
    if (cycle.some(entry => entry.name === 'studio_agent_complete_task' && entry.args.taskId === group.id)) continue;
    const preview = cycle.findLast(entry => entry.name === 'studio_agent_completion_preview' && entry.args.taskId === group.id);
    if (!preview) return call('studio_agent_completion_preview', { taskId: group.id });
    if (!preview.isError) return call('studio_agent_complete_task', completion(group.id, preview.value));
  }
  for (const task of tasks.filter(task => !task.isFolder && !done.has(task.id) && !started.has(task.id))) {
    if (!(task.dependencies ?? []).every(id => done.has(id))) continue;
    if (cycle.some(entry => entry.name === 'studio_autonomy_start_worker' && entry.args.taskId === task.id)) continue;
    const key = [...ids].find(([, id]) => id === task.id)?.[0];
    const worker = resolveKeys(script.workers?.[key ?? ''] ?? script.workers?.[task.id] ?? script.workers?.['*'] ?? {}, ids);
    return call('studio_autonomy_start_worker', { taskId: task.id, instructions: `[${WORKER_TAG}] ${JSON.stringify({ ...worker, taskId: task.id })}` });
  }
  // A worker that went idle with its task unfinished and nothing open for a human was stopped (pause, budget,
  // restart) or had its blocked/stuck item resolved: tell it to go on, a bounded number of times.
  const open = collect(status, row => typeof row.kind === 'string' && ATTENTION_KINDS.has(row.kind) && typeof row.id === 'string' && row.resolvedAt == null);
  for (const worker of collect(status, row => typeof row.chatId === 'string' && typeof row.taskId === 'string' && typeof row.state === 'string')) {
    if (!['idle', 'stopped'].includes(worker.state as string) || done.has(worker.taskId as string) || !tasks.some(task => task.id === worker.taskId)) continue;
    if (open.some(item => item.chatId === worker.chatId || item.taskId === worker.taskId)) continue;
    const touched = (entry: Entry) => (entry.name === 'studio_autonomy_message_worker' && entry.args.chatId === worker.chatId) || (entry.name === 'studio_autonomy_start_worker' && entry.args.taskId === worker.taskId);
    if (cycle.some(touched) || entries.filter(entry => entry.name === 'studio_autonomy_message_worker' && entry.args.chatId === worker.chatId).length >= MAX_NUDGES) continue;
    return call('studio_autonomy_message_worker', { chatId: worker.chatId, message: '你的任务还没有完成，请从上次停下的地方继续。' });
  }
  return call('studio_autonomy_wait', { timeoutSeconds: script.waitSeconds ?? 5 });
}

/** `[autonomy-probe] {"calls":[...]}` from a person: report the offered autonomy tools and try each call once. */
export function probeNext(probe: Json, messages: readonly Message[], userIndex: number, offered: readonly string[]): Action {
  const calls = Array.isArray(probe.calls) ? probe.calls.filter(record) as unknown as CallOp[] : [];
  const results = history(messages.slice(userIndex + 1));
  const next = calls[results.length];
  if (next) return { call: { name: next.name, args: next.args ?? {} } };
  return { text: `AUTONOMY_PROBE ${JSON.stringify({ tools: autonomyTools(offered), humanOnly: offered.filter(name => HUMAN_ONLY.test(name)), results: results.map(entry => ({ name: entry.name, isError: entry.isError, text: entry.text.slice(0, 300) })) })}` };
}

async function* emit(action: Action, usage: Usage): AsyncIterable<StreamChunk> {
  if ('call' in action) {
    const block = { type: 'tool-call' as const, id: brandString<ToolCallId>(randomUUID()), name: action.call.name, arguments: JSON.stringify(action.call.args) };
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }; yield { type: 'block-end', index: 0, block };
  } else {
    yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: action.text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: action.text } };
  }
  const cacheRead = usage.cacheReadTokens ?? 0, cacheWrite = usage.cacheWriteTokens ?? 0;
  yield { type: 'usage', usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, ...cacheRead || cacheWrite ? { cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite } : {},
    totalTokens: usage.inputTokens + usage.outputTokens + cacheRead + cacheWrite } };
  yield { type: 'finish', reason: { kind: 'call' in action ? 'tool-calls' : 'stop' } };
}

/** Claims only chats that carry an autonomy script, or a person's explicit probe; every other smoke path is unchanged. */
export function autonomyProbe(options: GenerateOptions): AsyncIterable<StreamChunk> | undefined {
  const messages = options.messages, offered = options.tools?.map(tool => tool.name) ?? [];
  if (options.purpose === 'compaction') {
    // The checkpoint replaces the span that held the script, so it carries the script on.
    const tagged = messages.filter(message => message.role === 'user').map(textOf).find(text => text.includes(`[${WORKER_TAG}]`) || text.includes(`[${ORCHESTRATOR_TAG}]`));
    if (!tagged) return undefined;
    const line = tagged.split('\n').find(row => row.includes(`[${WORKER_TAG}]`) || row.includes(`[${ORCHESTRATOR_TAG}]`))!;
    return emit({ text: `AUTONOMY_SMOKE_CHECKPOINT earlier steps condensed.\n${line}` }, { inputTokens: 100, outputTokens: 20 });
  }
  const userIndex = messages.findLastIndex(message => message.role === 'user' && sourceKind(message) === 'user');
  const userText = userIndex < 0 ? '' : textOf(messages[userIndex]!);
  const probe = /^\[autonomy-probe\]/u.test(userText) ? tagged(userText, PROBE_TAG) : undefined;
  const found = probe ? undefined : findScript(messages);
  if (!probe && !found) return undefined;
  return (async function* () {
    if (probe) { yield* emit(probeNext(probe, messages, userIndex, offered), { inputTokens: 50, outputTokens: 10 }); return; }
    const script = found!.script;
    const action = found!.role === 'worker' ? workerNext(found!.script as WorkerScript, messages, offered) : orchestratorNext(found!.script as OrchestratorScript, messages, offered);
    const last = history(messages).at(-1);
    if (script.delayMs !== undefined && (!Number.isSafeInteger(script.delayMs) || script.delayMs < 0 || script.delayMs > 60000)) throw new Error('Autonomy smoke: delayMs must be 0..60000');
    // Delay tool calls only, before emitting anything, so a pause or stop cancels the step instead of half-recording
    // it; closing replies are immediate. A rejected wait must not become a hot loop of status reads.
    const pause = ('call' in action ? script.delayMs ?? 0 : 0) + (last?.name === 'studio_autonomy_wait' && last.isError ? 1000 : 0);
    if (pause) await delay(pause, undefined, { signal: options.signal });
    yield* emit(action, script.usage ?? { inputTokens: 100, outputTokens: 20 });
  })();
}
