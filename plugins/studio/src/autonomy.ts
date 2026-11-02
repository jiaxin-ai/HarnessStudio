/** Autonomy runs (设计.md): a goal, an orchestrator conversation that plans and dispatches, and worker task conversations.
 *
 * The orchestrator is a Studio project conversation (whole project) or a task conversation on the branch root, with a
 * native DSH goal created here by the backend; goal-round-driver re-runs it whenever it goes idle, so it blocks in
 * studio_autonomy_wait while workers work. Workers are ordinary task conversations, so every task tool keeps its own
 * permission checks. This plugin stores runs in autonomy.sqlite, follows the run conversations' session events (turns,
 * failures, questions, tokens), watches the project for people's edits and completions, enforces the budgets, and owns
 * pause, resume, stop and the human-attention items. Every tool checks role, run and run state again at execution:
 * restrictions are only refreshed when a conversation is loaded. */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type { GoalActivationChanged, GoalChanged, GoalView } from '@deepseek-ai/dsh-goal';
import type {} from '@deepseek-ai/dsh-user-questions';
import type {} from '@deepseek-ai/dsh-client-connection';
import type {} from '@deepseek-ai/dsh-session-projection';
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client';
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import type { AutonomyBridge } from './index.ts';
import type {} from './domain.ts';
import type {} from './models.ts';
import type { AgentCompletionInput, Task, TaskView } from './domain-types.ts';
import { loadPromptFile } from './prompt-loader.ts';
import { AutonomySettingsStore, AutonomyStore, applySettings, isUnfinished, now, runTokens, settingsChange, tokenBreakdown, type StoredAttention, type StoredEvent, type StoredRun, type StoredWorker } from './autonomy-store.ts';
import { abortError, throwIfAborted } from './abort.ts';
import {
  WAIT_EVENT_TYPES, type AttentionAction, type AttentionKind, type AutonomyExportSource, type AutonomyRunExport, type AutonomySettings, type ModelChoice, type PauseReason, type RunDetail, type RunSummary,
  type RunState, type WorkerReportKind, type WorkerState,
} from './autonomy-types.ts';

export const name = 'harnessstudio-autonomy';
export const inject = ['studio', 'studioDomain', 'studioModels', 'tools', 'connection', 'agents', 'goals', 'sessionProjections'];
/** Without software (STUDIO_SEAT_BACKEND=none) the *NoSoftwarePromptPath variants replace the two prompts; empty means the
 * autonomy-*-no-software-system-prompt.md file beside each. */
export interface Config { dataRoot: string; orchestratorPromptPath: string; workerPromptPath: string; orchestratorNoSoftwarePromptPath: string; workerNoSoftwarePromptPath: string; tickSeconds: number }
export const Config: z<Config> = z.object({
  dataRoot: z.string().required(), orchestratorPromptPath: z.string().required(), workerPromptPath: z.string().required(),
  orchestratorNoSoftwarePromptPath: z.string().default(''), workerNoSoftwarePromptPath: z.string().default(''),
  tickSeconds: z.number().min(0.05).max(60).default(5),
});
declare module '@deepseek-ai/cordis' { interface Context { studioAutonomy: AutonomyController } }

const ACTIVE: readonly RunState[] = ['running', 'waiting-human'];
const DONE_STATES = new Set(['completed', 'accepted']);
const WAIT_TYPES = new Set<string>(WAIT_EVENT_TYPES);
const ORCHESTRATOR_NOTE = '【自主运行通知】', ORCHESTRATOR_ORDER = '【总 Agent 的指令】';
const WAIT_STOPPED = '等待已中断：自主运行已暂停或停止（或本轮被停止）。运行继续后，先调用 studio_autonomy_status 查看情况。';
const clip = (value: string | undefined, length: number) => { const text = (value ?? '').replace(/\s+/g, ' ').trim(); return text.length > length ? `${text.slice(0, length)}…` : text; };
const sameModel = (a: ModelChoice | undefined, b: ModelChoice) => !!a && a.provider === b.provider && a.model === b.model;
const formatModel = (model?: ModelChoice) => model ? `${model.provider}/${model.model}` : '（未设置）';
// The run panel's event texts (设计.md §12.6): plain Chinese for a person, without tool names, field names or English codes.
// Event summaries stay the orchestrator's own words, which studio_autonomy_wait returns unchanged.
const tokenCount = (value: number) => value >= 10_000 ? `${Number((value / 10_000).toFixed(value < 1_000_000 ? 1 : 0))} 万` : String(value);
const modelName = (value: unknown) => value && typeof value === 'object' && typeof (value as ModelChoice).model === 'string' ? (value as ModelChoice).model : '（未设置）';
const settingPages: Record<string, (value: unknown) => string> = {
  maxWorkers: value => `同时工作的子 Agent 改为 ${value} 个`, maxVms: value => `同时开的虚拟机改为 ${value} 台`, maxHours: value => `最长运行时间改为 ${value} 小时`,
  tokenBudget: value => `折算 token 预算改为 ${tokenCount(Number(value))}`, cacheReadWeight: value => `缓存读取改为按 ${Math.round(Number(value) * 100)}% 计入预算`, maxRounds: value => `总 Agent 最多轮数改为 ${value} 轮`,
  maxNudges: value => `催促同一个子 Agent 的次数改为 ${value} 次`, stuckFailures: value => `连续失败几次算卡住改为 ${value} 次`, stuckIdleRounds: value => `连续几轮没进展算卡住改为 ${value} 轮`,
  orchestratorModel: value => `总 Agent 模型改为 ${modelName(value)}`, workerModel: value => `子 Agent 默认模型改为 ${modelName(value)}`,
  workerModels: value => Array.isArray(value) && value.length ? `其他子 Agent 模型改为 ${value.map(modelName).join('、')}` : '不再允许其他子 Agent 模型',
};
/** A person's graph or checklist change as a sentence; the activity action names stay out of it. */
function editPage(action: string, task?: string): string {
  const [route, detail] = action.split(':'), target = task ? `任务 ${task}` : '任务';
  switch (route) {
    case 'task/quick': return `新建了${target}`;
    case 'task': return `保存了${target}`;
    case 'task/metadata': return `编辑了${target}的定义`;
    case 'task/action': return detail === 'resume' ? `让${target}继续修改` : `操作了${target}`;
    case 'task/completion': return `确认完成了${target}`;
    case 'task/completion/files': return `提交了${target}的文件`;
    case 'task/delete': return `删除了${target}`;
    case 'task/clear': return `清空了${target}的进展`;
    case 'dependencies': case 'dependencies/reconnect': return task ? `调整了${target}的依赖` : '调整了任务之间的依赖';
    default: return `修改了${target}`;
  }
}
const settleReasons: Record<string, string> = { completed: '', aborted: '（被停止）', error: '（模型调用出错）', 'max-tokens': '（回复太长被截断）' };
const resolvedPages: Partial<Record<NonNullable<StoredAttention['resolution']>, string>> = {
  resolved: '你已处理', replied: '你在对话里回复了', answered: '问题已回答或已结束', 'stop-worker': '子 Agent 已停止', accept: '你接受了结果', resumed: '运行已继续', stopped: '运行已结束',
};
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}须为对象`);
  return value as Record<string, unknown>;
}
function exact(value: unknown, keys: string[], label: string): Record<string, unknown> {
  const data = object(value, label), extra = Object.keys(data).find(key => !keys.includes(key));
  if (extra) throw new Error(`${label}包含不支持的字段：${extra}`);
  return data;
}
function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`缺少${label}`);
  if (value.length > max) throw new Error(`${label}最多 ${max} 个字符`);
  return value;
}
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
/** A tool whose work waits on the domain or runtime queue returns when its turn is cancelled: disposing an Agent waits
 * for its running tool, and the operation that disposes it may be the one this work is queued behind. The work itself
 * still completes in the background. */
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => { onAbort = () => reject(abortError(signal)); signal.addEventListener('abort', onAbort, { once: true }); if (signal.aborted) onAbort(); });
  operation.catch(() => undefined);
  return Promise.race([operation, cancelled]).finally(() => signal.removeEventListener('abort', onAbort));
}

/** Scope tasks in rank order: the branch root and its descendants, or the whole project; archived tasks are out. */
export function scopeTasks(tasks: readonly Task[], rootTaskId?: string): Task[] {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const archived = (task: Task) => { let current: Task | undefined = task; const seen = new Set<string>(); while (current && !seen.has(current.id)) { seen.add(current.id); if (current.archived || current.state === 'discarded') return true; current = current.parentId ? byId.get(current.parentId) : undefined; } return false; };
  const inside = (task: Task) => { if (!rootTaskId) return true; let current: Task | undefined = task; const seen = new Set<string>(); while (current && !seen.has(current.id)) { if (current.id === rootTaskId) return true; seen.add(current.id); current = current.parentId ? byId.get(current.parentId) : undefined; } return false; };
  return tasks.filter(task => task.kind === 'task' && inside(task) && !archived(task));
}

export class AutonomyController implements AutonomyBridge, AutonomyExportSource {
  readonly store: AutonomyStore;
  readonly settings: AutonomySettingsStore;
  private operations: Promise<unknown> = Promise.resolve();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly waiting = new Set<string>();
  /** Orchestrators inside one of our own goal calls: their goal events are ours, not the model's or the driver's. */
  private readonly hostGoal = new Set<string>();
  private readonly humanStops = new Map<string, number>();
  private readonly lastText = new Map<string, string>();
  private readonly questions = new Map<string, Set<string>>();
  private readonly scopeCache = new Map<string, { revision: number; ids: Set<string> }>();
  private vmCount = new Map<string, { at: number; count: number }>();
  private closing = false;

  constructor(private readonly ctx: Context, private readonly config: Pick<Config, 'dataRoot'>) {
    this.store = new AutonomyStore(join(config.dataRoot, 'autonomy.sqlite'));
    this.settings = AutonomySettingsStore.at(config.dataRoot);
  }

  /** Runs that were active when the service stopped wait for a person: the goal driver is disarmed after a restart. */
  async initialize(): Promise<string | undefined> {
    this.store.initialize();
    const problem = await this.settings.load();
    for (const run of this.store.runs()) {
      if (!ACTIVE.includes(run.state)) continue;
      this.store.updateRun(run.id, value => { value.state = 'paused'; value.pauseReason = 'restart'; delete value.activeSince; }, { bump: true });
      this.addEvent(run, 'paused', 'Studio 重启，运行已暂停，等人点继续', { page: 'Studio 服务重启过，运行已暂停，等你点「继续」' });
      this.openAttention(run.id, { kind: 'restart', chatId: run.orchestratorChatId, message: 'Studio 服务重启过，自主运行已暂停。检查各对话的情况后点「继续」，总 Agent 会接着工作。' });
    }
    return problem;
  }
  dispose(): void {
    this.closing = true;
    for (const set of this.waiters.values()) for (const wake of set) wake();
    this.store.close();
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.catch(() => undefined).then(operation);
    this.operations = result;
    return result;
  }

  // ---- facts about runs ----
  private domain() { return this.ctx.studioDomain; }
  /** No software backend: VMs do not exist, so the VM budget is 0 and nothing the Agents read mentions VMs. */
  private noSoftware(): boolean { return this.ctx.studioDomain?.softwareBackend === 'none'; }
  private withoutVms<T extends Partial<AutonomySettings>>(settings: T): T { if (!this.noSoftware()) return settings; const { maxVms: _vms, ...rest } = settings; return rest as T; }
  private projectRevision(projectId: string): number | undefined { return this.domain().projects().find(project => project.id === projectId)?.revision; }
  /** The task IDs of a task-branch run, cached per project revision. */
  scopeIds(run: StoredRun): Set<string> | undefined {
    if (!run.rootTaskId) return undefined;
    const revision = this.projectRevision(run.projectId) ?? -1, cached = this.scopeCache.get(run.id);
    if (cached && cached.revision === revision) return cached.ids;
    const ids = new Set(scopeTasks(this.domain().tasks(run.projectId), run.rootTaskId).map(task => task.id));
    this.scopeCache.set(run.id, { revision, ids });
    return ids;
  }
  private tasksOf(run: StoredRun): Task[] { return scopeTasks(this.domain().tasks(run.projectId), run.rootTaskId); }
  private elapsed(run: StoredRun): number { return run.usage.elapsedMs + (run.activeSince ? Math.max(0, Date.now() - Date.parse(run.activeSince)) : 0); }
  private remainingRounds(run: StoredRun): number { return run.settings.maxRounds - run.priorRounds; }
  /** Used-up budgets. The round budget pauses through the goal's own limit (the driver blocks with round-limit after
   * the last round), so a check while working leaves rounds out and the last admitted round runs to its end. */
  private exceeded(run: StoredRun, rounds = true): PauseReason | undefined {
    if (run.usage.tokens >= run.settings.tokenBudget) return 'budget-tokens';
    if (this.elapsed(run) >= run.settings.maxHours * 3_600_000) return 'budget-time';
    if (rounds && run.usage.rounds >= run.settings.maxRounds) return 'budget-rounds';
  }
  private budgetPage(reason: PauseReason, run: StoredRun): string {
    if (reason === 'budget-tokens') return `折算 token 预算用完了（${tokenCount(run.usage.tokens)} / ${tokenCount(run.settings.tokenBudget)}）`;
    if (reason === 'budget-time') return `运行时间到上限了（${run.settings.maxHours} 小时）`;
    return `总 Agent 的轮数到上限了（${run.usage.rounds} / ${run.settings.maxRounds} 轮）`;
  }
  private budgetText(reason: PauseReason, run: StoredRun): string {
    if (reason === 'budget-tokens') return `折算 token 预算已用完（${run.usage.tokens.toLocaleString('en-US')} / ${run.settings.tokenBudget.toLocaleString('en-US')}，缓存读取按 ${run.settings.cacheReadWeight} 折算）`;
    if (reason === 'budget-time') return `运行时长已到上限（${run.settings.maxHours} 小时）`;
    return `总 Agent 的轮数已到上限（${run.usage.rounds} / ${run.settings.maxRounds}）`;
  }
  private activeWorkers(runId: string): StoredWorker[] { return this.store.workers(runId).filter(worker => worker.state === 'active'); }
  private runChats(run: StoredRun): string[] { return [run.orchestratorChatId, ...this.store.workers(run.id).map(worker => worker.chatId)]; }

  // ---- the bridge the runtime asks ----
  access(chatId: string) {
    const mark = this.ctx.studio.chatRole(chatId); if (!mark) return undefined;
    const run = this.store.findRun(mark.runId);
    // While start() creates the orchestrator its chat ID is not stored yet; only start() binds an orchestrator role.
    if (!run || !isUnfinished(run.state) || mark.role === 'orchestrator' && run.orchestratorChatId && run.orchestratorChatId !== chatId) return undefined;
    const scope = this.scopeIds(run);
    return { role: mark.role, runId: run.id, ...(scope ? { scope, rootTaskId: run.rootTaskId } : {}) };
  }
  liveContext(chatId: string): unknown {
    const access = this.access(chatId); if (!access) return undefined;
    const run = this.store.run(access.runId), scope = run.rootTaskId ? { rootTaskId: run.rootTaskId } : 'whole-project';
    // The orchestrator's system prompt keeps only what holds for the whole run: every change of a system section makes
    // DSH append the whole prompt again and the provider reread the rest uncached. Tasks, their states and what it may
    // confirm now come from studio_autonomy_status.
    if (access.role === 'orchestrator') return { role: access.role, runId: run.id, scope,
      completionRule: 'You may confirm completion only of tasks that studio_autonomy_status marks canConfirmNow (task groups in scope, and leaf tasks no worker is assigned to), with studio_agent_complete_task and concrete evidence for every goal.' };
    const worker = this.store.worker(chatId), completable = ACTIVE.includes(run.state) && worker && worker.state === 'active' ? [worker.taskId] : [];
    return { role: access.role, runId: run.id, runState: run.state, scope,
      // The written rule that lifts 「only a person confirms completion」 for exactly this task.
      agentCompletionAuthorized: completable.length > 0, completableTaskIds: completable,
      completionRule: 'You may confirm completion of your own task only, with studio_agent_complete_task and concrete evidence for every goal.' };
  }
  stopped(chatId: string): void { this.humanStops.set(chatId, Date.now()); }
  vmQuota(chatId: string) {
    const access = this.access(chatId); if (!access) return undefined;
    const run = this.store.run(access.runId);
    return { maxVms: run.settings.maxVms, chatIds: new Set(this.runChats(run)) };
  }
  private async vms(run: StoredRun): Promise<number> {
    const cached = this.vmCount.get(run.id); if (cached && Date.now() - cached.at < 10_000) return cached.count;
    let count = cached?.count ?? 0;
    try { count = await this.ctx.studio.countVms(new Set(this.runChats(run))); } catch { /* keep the last count when vm_manager does not answer */ }
    this.vmCount.set(run.id, { at: Date.now(), count });
    return count;
  }

  // ---- events, attention and state ----
  private addEvent(run: StoredRun | string, type: string, summary: string, extra: { chatId?: string; taskId?: string; data?: Record<string, unknown>; page?: string } = {}): StoredEvent {
    const runId = typeof run === 'string' ? run : run.id, { page, ...rest } = extra;
    const event = this.store.addEvent({ runId, at: now(), type, summary: clip(summary, 2000), ...(page ? { page: clip(page, 600) } : {}), ...rest, deliver: WAIT_TYPES.has(type) });
    if (event.deliver) for (const wake of this.waiters.get(runId) ?? []) wake();
    return event;
  }
  private activity(run: StoredRun, action: string, extra: { taskId?: string; chatId?: string; request?: unknown; result?: unknown; ok?: boolean; error?: string } = {}) {
    this.domain().recordActivity({ actor: 'agent', source: 'agent-tool', action: `autonomy/${action}`, projectId: run.projectId, ok: extra.ok ?? true,
      ...(extra.taskId ? { taskId: extra.taskId } : {}), ...(extra.chatId ? { chatId: extra.chatId } : {}),
      request: { runId: run.id, ...(extra.request && typeof extra.request === 'object' ? extra.request : {}) },
      ...(extra.result !== undefined ? { result: extra.result } : {}), ...(extra.error ? { error: extra.error.slice(0, 500) } : {}) });
  }
  /** running ⇄ waiting-human follows the open attention items; other states are left alone. */
  private settleState(runId: string): StoredRun {
    return this.store.updateRun(runId, run => {
      if (!ACTIVE.includes(run.state)) return;
      run.state = this.store.openAttention(runId).length ? 'waiting-human' : 'running';
    }, { bump: true });
  }
  openAttention(runId: string, input: { kind: AttentionKind; chatId?: string; taskId?: string; message: string; callId?: string; cause?: StoredAttention['cause']; awaitingSummary?: boolean }): StoredAttention | undefined {
    const open = this.store.openAttention(runId);
    if (open.some(item => item.kind === input.kind && item.chatId === input.chatId && item.callId === input.callId && item.cause === input.cause)) return undefined;
    const item: StoredAttention = { id: `at-${randomUUID()}`, runId, since: now(), ...input };
    this.store.putAttention(item);
    const run = this.settleState(runId);
    this.addEvent(run, 'attention-opened', `需要人：${input.message}`, { ...(input.chatId ? { chatId: input.chatId } : {}), ...(input.taskId ? { taskId: input.taskId } : {}), data: { attentionId: item.id, kind: input.kind }, page: `需要你处理：${clip(input.message, 300)}` });
    this.activity(run, 'attention', { ...(input.taskId ? { taskId: input.taskId } : {}), ...(input.chatId ? { chatId: input.chatId } : {}), request: { kind: input.kind, message: input.message } });
    return item;
  }
  private closeAttention(item: StoredAttention, resolution: NonNullable<StoredAttention['resolution']>, note?: string, pageNote = resolution === 'continue' ? item.kind === 'stuck' ? '你让它继续' : '你已处理' : resolvedPages[resolution]): StoredRun {
    this.store.putAttention({ ...item, resolvedAt: now(), resolution });
    if (item.kind === 'stuck' && item.chatId) {
      const worker = this.store.worker(item.chatId);
      if (worker) this.store.updateWorker(item.chatId, value => { if (item.cause === 'failures') value.failures = 0; if (item.cause === 'idle') value.idleRounds = 0; if (item.cause === 'nudges') value.nudges = 0; });
    }
    const run = this.settleState(item.runId);
    this.addEvent(run, 'attention-resolved', `已处理：${item.message}${note ? `。${note}` : ''}`, { ...(item.chatId ? { chatId: item.chatId } : {}), ...(item.taskId ? { taskId: item.taskId } : {}), data: { attentionId: item.id, kind: item.kind, resolution },
      page: `已处理：${clip(item.message, 160)}${pageNote ? `（${pageNote}）` : ''}` });
    return run;
  }
  private wake(runId: string) { for (const wake of this.waiters.get(runId) ?? []) wake(); }

  // ---- goal calls of our own ----
  private hostGoalCall<T>(chatId: string, call: () => T): T {
    this.hostGoal.add(chatId);
    try { return call(); } finally { this.hostGoal.delete(chatId); }
  }
  private goal(agent: Agent): GoalView | undefined { return this.ctx.goals.get(agent); }

  // ---- lifecycle ----
  start(input: unknown, actor: 'human' = 'human'): Promise<RunDetail> {
    return this.serial(async () => {
      const data = exact(input, ['projectId', 'rootTaskId', 'objective', 'settings'], '启动参数');
      const projectId = text(data.projectId, '项目', 200), objective = text(data.objective, '目标', 8000).trim();
      const domain = this.domain(); domain.graph(projectId);
      if (domain.projectDeleting(projectId)) throw new Error('项目正在删除，不能启动自主运行');
      if (this.store.unfinished(projectId).length) throw new Error('这个项目已有一个未结束的自主运行，请先停止它');
      let rootTaskId: string | undefined;
      if (data.rootTaskId !== undefined && data.rootTaskId !== null) {
        rootTaskId = text(data.rootTaskId, '范围根任务', 200);
        const root = domain.view(rootTaskId);
        if (root.projectId !== projectId) throw new Error('范围根任务不属于这个项目');
        if (root.archived || root.kind !== 'task') throw new Error('范围根任务已归档，不能作为范围');
        if (DONE_STATES.has(root.state)) throw new Error('范围根任务已完成；要继续修改请先在任务页点「继续修改」');
        if (!root.canDiscuss) throw new Error('范围根任务当前不能讨论（被冻结、前置无效或上级已完成），总 Agent 无法在它上面工作');
      }
      const settings = applySettings(this.settings.get().settings, this.withoutVms(settingsChange(data.settings ?? {})));
      if (this.noSoftware()) settings.maxVms = 0;
      if (!settings.orchestratorModel) throw new Error('请选择总 Agent 模型');
      if (!settings.workerModel) throw new Error('请选择子 Agent 模型');
      for (const model of [settings.orchestratorModel, settings.workerModel, ...settings.workerModels]) await this.ctx.studioModels.validateSelection(model.provider, model.model);
      const time = now(), run: StoredRun = {
        id: `ar-${randomUUID()}`, projectId, ...(rootTaskId ? { rootTaskId } : {}), objective, state: 'running', settings, orchestratorChatId: '', revision: 1,
        createdAt: time, startedAt: time, usage: { tokens: 0, elapsedMs: 0, rounds: 0 }, activeSince: time, priorRounds: 0, chatTokens: {}, waitCursor: 0, warned: [],
        watch: { projectRevision: this.projectRevision(projectId) ?? 0, activitySeq: this.lastActivitySeq(projectId), completed: this.tasksOf({ projectId, rootTaskId } as StoredRun).filter(task => DONE_STATES.has(task.state)).map(task => task.id) },
      };
      this.store.insertRun(run);
      let chatId: string;
      try {
        const chat = await this.ctx.studio.startAutonomyChat({ scope: rootTaskId ? 'task' : 'project', ownerId: rootTaskId ?? projectId, role: 'orchestrator', runId: run.id,
          provider: settings.orchestratorModel.provider, model: settings.orchestratorModel.model, message: this.firstMessage(run), from: 'controller' });
        chatId = chat.id;
        this.store.updateRun(run.id, value => { value.orchestratorChatId = chatId; });
        const agent = this.ctx.studio.liveAgent(chatId);
        if (!agent) throw new Error('总 Agent 没有启动');
        this.hostGoalCall(chatId, () => this.ctx.goals.create(agent, { objective, maxGoalRounds: settings.maxRounds }));
      } catch (error) {
        const failed = this.store.updateRun(run.id, value => { value.state = 'failed'; value.endedAt = now(); delete value.activeSince; }, { bump: true });
        this.addEvent(failed, 'failed', `启动失败：${errorText(error)}`);
        if (failed.orchestratorChatId) this.ctx.studio.interrupt(failed.orchestratorChatId);
        throw error;
      }
      const started = this.store.run(run.id);
      this.addEvent(started, 'started', `${actor === 'human' ? '人' : ''}启动自主运行：${clip(objective, 200)}`, { chatId, page: `${actor === 'human' ? '你' : ''}启动了自主运行：${clip(objective, 200)}` });
      return this.detail(started.id);
    });
  }
  private firstMessage(run: StoredRun): string {
    const root = run.rootTaskId ? this.domain().view(run.rootTaskId) : undefined, s = run.settings;
    return [`${ORCHESTRATOR_NOTE}自主运行已开始（${run.id}），你是这次运行的总 Agent。`, '', `目标：${run.objective}`,
      `范围：${root ? `任务分支「${root.code} ${root.title}」（根任务 ID ${root.id}）及其全部子任务` : '整个项目'}`,
      `预算：同时最多 ${s.maxWorkers} 个子 Agent${this.noSoftware() ? '' : `、${s.maxVms} 台虚拟机`}；总时长 ${s.maxHours} 小时；折算 token ${s.tokenBudget.toLocaleString('en-US')}（未缓存输入 + 缓存写入 + 输出 + 缓存读取 × ${s.cacheReadWeight}）；总 Agent 最多 ${s.maxRounds} 轮。`,
      `子 Agent 默认模型：${formatModel(s.workerModel)}${s.workerModels.length ? `；也可选用：${s.workerModels.map(formatModel).join('、')}` : ''}。`, '',
      '先调用 studio_autonomy_status 查看范围内的任务和预算，再按系统提示中的工作方式规划、派出子 Agent。等待子 Agent 时调用 studio_autonomy_wait，不要用结束回合来等待。'].join('\n');
  }

  /** A person's pause from the run panel (webAction logs the request). */
  pause(id: string, revision: unknown): Promise<RunDetail> {
    return this.serial(async () => { await this.pauseNow(id, revision, 'user', undefined, false, true); return this.detail(id); });
  }
  private async pauseNow(id: string, revision: unknown, reason: PauseReason, attention?: { kind: AttentionKind; message: string; chatId?: string; cause?: StoredAttention['cause'] }, goalPaused = false, byPage = false): Promise<StoredRun> {
    const run = this.store.updateRun(id, value => {
      if (!ACTIVE.includes(value.state)) throw new Error(value.state === 'paused' ? '运行已经暂停' : '只有运行中的自主运行可以暂停');
      value.usage.elapsedMs = this.elapsed(value); delete value.activeSince; value.state = 'paused'; value.pauseReason = reason;
    }, { revision, bump: true });
    this.addEvent(run, 'paused', reason === 'user' ? '运行已暂停' : reason === 'orchestrator-error' ? '总 Agent 停了下来，运行已暂停' : `${this.budgetText(reason, run)}，运行已暂停`,
      reason.startsWith('budget-') ? { page: `${this.budgetPage(reason, run)}，运行已暂停` } : {});
    if (!byPage) this.activity(run, 'pause', { request: { reason } });
    if (attention) this.openAttention(id, attention);
    // A host pause of the goal also aborts the orchestrator's live turn (goal-round-driver); queued input is kept.
    const agent = this.ctx.studio.liveAgent(run.orchestratorChatId);
    if (agent && !goalPaused) try { this.hostGoalCall(agent.id, () => { const goal = this.goal(agent); if (goal?.phase === 'active') this.ctx.goals.pause(agent, { id: goal.id, revision: goal.revision }); }); }
    catch (error) { this.ctx.logger.warn(`studio-autonomy: could not pause the goal of ${run.id}: ${errorText(error)}`); }
    for (const chatId of [run.orchestratorChatId, ...this.activeWorkers(id).map(worker => worker.chatId)]) this.ctx.studio.interrupt(chatId);
    this.wake(id);
    return this.store.run(id);
  }

  /** A person's resume from the run panel (webAction logs the request). */
  resume(id: string, revision: unknown): Promise<RunDetail> {
    return this.serial(async () => { await this.resumeNow(id, revision, false, true); return this.detail(id); });
  }
  private async resumeNow(id: string, revision: unknown, goalResumed = false, byPage = false): Promise<void> {
    const run = this.store.run(id);
    if (revision !== undefined && revision !== run.revision) throw new Error('自主运行已变化，请刷新后重试');
    if (run.state !== 'paused' && run.state !== 'blocked') throw new Error('只有暂停或受阻的自主运行可以继续');
    if (this.store.openAttention(id).some(item => item.kind === 'incomplete')) throw new Error('总 Agent 已报告目标完成但还有未完成的任务，请在「需要人」事项里选择接受或让它继续做');
    const over = this.exceeded(run);
    if (over) throw new Error(`${this.budgetText(over, run)}，请先调高预算再继续`);
    if (this.remainingRounds(run) < 1) throw new Error('总 Agent 的轮数已用完，请先调高轮数上限再继续');
    if (!goalResumed) {
      this.hostGoal.add(run.orchestratorChatId);
      try {
        const agent = await this.ctx.studio.resumeAutonomyAgent(run.orchestratorChatId);
        const goal = this.goal(agent), remaining = this.remainingRounds(run);
        if (!goal || goal.phase === 'complete') this.ctx.goals.create(agent, { objective: run.objective, maxGoalRounds: remaining });
        else {
          let current = goal;
          // Edits made while the orchestrator was not loaded (e.g. after a restart) reach the goal here.
          const change = { ...(current.objective !== run.objective ? { objective: run.objective } : {}), ...(current.maxGoalRounds !== remaining ? { maxGoalRounds: Math.max(remaining, current.roundsStarted + 1) } : {}) };
          if (Object.keys(change).length) current = this.ctx.goals.edit(agent, { id: current.id, revision: current.revision }, change);
          if (current.phase !== 'active' || current.activation !== 'armed') this.ctx.goals.resume(agent, { id: current.id, revision: current.revision });
        }
      } finally { this.hostGoal.delete(run.orchestratorChatId); }
    }
    for (const item of this.store.openAttention(id)) if (item.kind === 'restart' || item.kind === 'budget' || item.kind === 'stuck' && item.cause === 'orchestrator') this.store.putAttention({ ...item, resolvedAt: now(), resolution: 'resumed' });
    const resumed = this.store.updateRun(id, value => { value.state = 'running'; delete value.pauseReason; value.activeSince = now(); }, { bump: true });
    this.settleState(id);
    this.humanStops.delete(run.orchestratorChatId);
    this.addEvent(resumed, 'resumed', run.state === 'blocked' ? '人让受阻的运行继续；请用 studio_autonomy_status 看清现状后继续推进' : '运行已继续；被暂停时中断的子 Agent 需要你决定是否发消息让它们继续',
      { page: run.state === 'blocked' ? '受阻的运行已继续' : '运行已继续' });
    if (!byPage) this.activity(resumed, 'resume');
  }

  /** A person's stop from the run panel (webAction logs the request). */
  stop(id: string, revision: unknown): Promise<RunDetail> {
    return this.serial(async () => { await this.finish(id, 'stopped', revision, undefined, true); return this.detail(id); });
  }
  /** Ends a run: stopped by a person, completed, or a deleted project. Conversations, tasks, files and VMs stay. */
  private async finish(id: string, state: 'stopped' | 'completed' | 'failed', revision?: unknown, summary?: string, byPage = false, page?: string): Promise<StoredRun> {
    const run = this.store.updateRun(id, value => {
      if (!isUnfinished(value.state)) throw new Error('自主运行已经结束');
      value.usage.elapsedMs = this.elapsed(value); delete value.activeSince; delete value.pauseReason; value.state = state; value.endedAt = now();
    }, { revision, bump: true });
    for (const item of this.store.openAttention(id)) this.store.putAttention({ ...item, resolvedAt: now(), resolution: 'stopped' });
    const agent = this.ctx.studio.liveAgent(run.orchestratorChatId);
    if (agent && state !== 'completed') try { this.hostGoalCall(agent.id, () => { const goal = this.goal(agent); if (goal) this.ctx.goals.clear(agent, { id: goal.id, revision: goal.revision }); }); }
    catch (error) { this.ctx.logger.warn(`studio-autonomy: could not clear the goal of ${run.id}: ${errorText(error)}`); }
    const tasks = new Map(this.domain().tasks(run.projectId).map(task => [task.id, task]));
    for (const worker of this.store.workers(id)) {
      if (worker.state === 'active') this.store.updateWorker(worker.chatId, value => { value.state = DONE_STATES.has(tasks.get(worker.taskId)?.state ?? '') ? 'done' : 'stopped'; value.stopReason = '运行已结束'; });
      this.ctx.studio.interrupt(worker.chatId);
    }
    if (state !== 'completed') this.ctx.studio.interrupt(run.orchestratorChatId);
    this.addEvent(run, state, summary ?? (state === 'stopped' ? '运行已停止' : state === 'completed' ? '运行已完成' : '运行已结束'), page ? { page } : {});
    if (!byPage) this.activity(run, state === 'stopped' ? 'stop' : state === 'completed' ? 'complete' : 'end');
    this.wake(id);
    return run;
  }

  update(input: unknown): Promise<RunDetail> {
    return this.serial(async () => {
      const data = exact(input, ['id', 'revision', 'objective', 'settings'], '修改参数'), id = text(data.id, '运行 ID', 200);
      if (data.objective === undefined && data.settings === undefined) throw new Error('请给出要修改的目标或预算');
      const current = this.store.run(id);
      if (!isUnfinished(current.state)) throw new Error('自主运行已经结束，不能修改');
      if (data.revision !== current.revision) throw new Error('自主运行已变化，请刷新后重试');
      const objective = data.objective === undefined ? undefined : text(data.objective, '目标', 8000).trim();
      const change = data.settings === undefined ? {} : this.withoutVms(settingsChange(data.settings)), settings = applySettings(current.settings, change);
      if (!sameModel(settings.orchestratorModel, current.settings.orchestratorModel!)) throw new Error('总 Agent 的模型在运行开始后不能修改');
      if (!settings.workerModel) throw new Error('子 Agent 默认模型不能清空');
      for (const model of [settings.workerModel, ...settings.workerModels]) if (!sameModel(current.settings.workerModel, model) && !current.settings.workerModels.some(item => sameModel(item, model))) await this.ctx.studioModels.validateSelection(model.provider, model.model);
      const agent = this.ctx.studio.liveAgent(current.orchestratorChatId), goal = agent && this.goal(agent);
      if (agent && goal && goal.phase !== 'complete') {
        const goalChange = { ...(objective !== undefined && objective !== goal.objective ? { objective } : {}),
          ...(settings.maxRounds !== current.settings.maxRounds ? { maxGoalRounds: Math.max(1, settings.maxRounds - current.priorRounds) } : {}) };
        if (Object.keys(goalChange).length) this.hostGoalCall(agent.id, () => this.ctx.goals.edit(agent, { id: goal.id, revision: goal.revision }, goalChange));
      }
      // A raised budget may warn again at its new 80%.
      const rewarn: Record<string, (keyof AutonomySettings)[]> = { tokens: ['tokenBudget', 'cacheReadWeight'], time: ['maxHours'], rounds: ['maxRounds'] };
      const run = this.store.updateRun(id, value => {
        if (objective !== undefined) value.objective = objective;
        value.settings = settings; value.warned = value.warned.filter(kind => !rewarn[kind]!.some(key => key in change));
        // A new weight applies to everything counted so far.
        value.usage.tokens = runTokens(value.chatTokens, settings.cacheReadWeight);
      }, { bump: true });
      // The orchestrator reads the same sentences as the page (models by name, the budget as weighted tokens) plus the
      // field names it sees in studio_autonomy_status.
      const sentences = Object.entries(change).map(([key, value]) => `${settingPages[key]?.(value) ?? '修改了其他设置'}（${key}）`);
      const parts = [...objective !== undefined ? [`目标改为：${clip(objective, 300)}`] : [], ...sentences.length ? [`预算或模型设置：${sentences.join('，')}`] : []];
      const pages = [...objective !== undefined ? [`目标改为「${clip(objective, 120)}」`] : [], ...Object.entries(change).map(([key, value]) => settingPages[key]?.(value) ?? '修改了其他设置')];
      this.addEvent(run, 'human-edit', `人修改了运行：${parts.join('；')}`, { data: { objective: objective !== undefined, settings: Object.keys(change) }, page: `你修改了运行：${pages.join('；')}` });
      this.checkBudget(run);
      return this.detail(id);
    });
  }

  resolveAttention(input: unknown): Promise<RunDetail> {
    return this.serial(async () => {
      const data = exact(input, ['id', 'attentionId', 'action'], '处理参数'), id = text(data.id, '运行 ID', 200), attentionId = text(data.attentionId, '事项 ID', 200);
      const action = data.action as AttentionAction;
      if (!['resolved', 'continue', 'stop-worker', 'accept'].includes(action)) throw new Error('处理方式无效');
      const run = this.store.run(id), item = this.store.attention(id).find(value => value.id === attentionId);
      if (!item) throw new Error('事项不存在');
      if (item.resolvedAt) throw new Error('这个事项已经处理过了');
      if (!isUnfinished(run.state)) throw new Error('自主运行已经结束');
      if (action === 'accept' && item.kind !== 'incomplete') throw new Error('「接受」只用于总 Agent 提前宣布完成的事项');
      switch (item.kind) {
        case 'question': throw new Error('这是 Agent 提的问题，请在对应对话里回答');
        case 'restart': case 'budget':
          if (action === 'stop-worker') throw new Error('这个事项没有对应的子 Agent');
          await this.resumeOrClose(run, item); break;
        case 'incomplete':
          if (action === 'accept') { this.closeAttention(item, 'accept'); await this.finish(id, 'completed', undefined, '人接受了总 Agent 的结果，运行已完成（未完成的任务保持原样）', false, '你接受了总 Agent 的结果，运行已完成（没完成的任务保持原样）'); break; }
          if (action !== 'continue') throw new Error('请选择「接受，结束运行」或「让它继续做」');
          await this.continueGoal(run, item); break;
        case 'stuck': case 'blocked': {
          if (item.cause === 'orchestrator') { if (action === 'stop-worker') throw new Error('这是总 Agent 的事项'); await this.resumeOrClose(run, item); break; }
          const worker = item.chatId ? this.store.worker(item.chatId) : undefined;
          if (action === 'stop-worker') {
            if (!worker) throw new Error('这个事项没有对应的子 Agent');
            this.stopWorkerNow(run, worker, '人在运行面板上停止了这个子 Agent', 'human');
            if (!this.store.attention(id).find(value => value.id === item.id)?.resolvedAt) this.closeAttention(item, 'stop-worker');
            break;
          }
          this.closeAttention(item, action, action === 'continue' && item.kind === 'stuck' ? '人让它继续' : '人已处理');
          if (worker && worker.state === 'active' && ACTIVE.includes(this.store.run(id).state)) {
            const note = item.kind === 'blocked' ? '人已处理你报告的问题，请继续你的任务。' : '人已查看你的情况，请继续完成你的任务；如果仍然不行，用 studio_agent_report 说明具体卡在哪里。';
            try { await this.ctx.studio.sendAutonomyMessage(worker.chatId, { runId: id, from: 'controller', message: `${ORCHESTRATOR_NOTE}${note}` }); }
            catch (error) { this.addEvent(id, 'worker-message-failed', `通知子 Agent 失败：${errorText(error)}`, { chatId: worker.chatId }); }
          }
          break;
        }
      }
      return this.detail(id);
    });
  }
  /** Items that only a resume answers: a paused run resumes; in a run already working again (e.g. after 「让它继续做」) the
   * item is closed once its budget allows it. */
  private async resumeOrClose(run: StoredRun, item: StoredAttention): Promise<void> {
    if (run.state === 'paused' || run.state === 'blocked') { await this.resumeNow(run.id, undefined); return; }
    const over = this.exceeded(run); if (over) throw new Error(`${this.budgetText(over, run)}，请先调高预算`);
    this.closeAttention(item, 'resumed');
  }
  /** 「让它继续做」: a completed DSH goal cannot be resumed, but it may be replaced by a new one. */
  private async continueGoal(run: StoredRun, item: StoredAttention): Promise<void> {
    this.hostGoal.add(run.orchestratorChatId);
    let prior = run.priorRounds;
    try {
      const agent = await this.ctx.studio.resumeAutonomyAgent(run.orchestratorChatId), goal = this.goal(agent);
      if (goal?.phase === 'complete') prior += goal.roundsStarted;
      const remaining = run.settings.maxRounds - prior;
      if (remaining < 1) throw new Error('总 Agent 的轮数已用完，请先调高轮数上限');
      const over = this.exceeded(run); if (over && over !== 'budget-rounds') throw new Error(`${this.budgetText(over, run)}，请先调高预算`);
      this.ctx.goals.create(agent, { objective: run.objective, maxGoalRounds: remaining });
    } finally { this.hostGoal.delete(run.orchestratorChatId); }
    this.store.updateRun(run.id, value => {
      value.priorRounds = prior; value.usage.rounds = prior;
      if (value.state === 'paused' || value.state === 'blocked') { value.state = 'running'; delete value.pauseReason; }
      value.activeSince ??= now();
    });
    // The new goal is armed: what only a resume answers is answered.
    for (const other of this.store.openAttention(run.id)) if (other.kind === 'restart' || other.kind === 'budget' || other.kind === 'stuck' && other.cause === 'orchestrator') this.store.putAttention({ ...other, resolvedAt: now(), resolution: 'resumed' });
    const open = this.tasksOf(run).filter(task => !DONE_STATES.has(task.state));
    this.closeAttention(item, 'continue', `人让总 Agent 继续做。这些任务还没有完成，请继续：${open.slice(0, 30).map(task => `${task.code} ${task.title}`).join('；') || '（无）'}`,
      open.length ? `你让总 Agent 继续做，还有 ${open.length} 个任务没完成` : '你让总 Agent 继续做');
  }

  // ---- goal and session observation ----
  goalChanged(agent: Agent, change: GoalChanged): void {
    const run = this.orchestratorRun(agent.id); if (!run) return;
    if (change.goal && change.operation !== 'clear') this.trackRounds(run, change.goal.roundsStarted);
    if (this.hostGoal.has(agent.id) || this.closing) return;
    void this.serial(async () => {
      const current = this.store.run(run.id); if (!isUnfinished(current.state)) return;
      switch (change.operation) {
        case 'complete': await this.goalCompleted(current); return;
        case 'block':
          if (change.goal?.blockedReason?.code === 'round-limit') { if (ACTIVE.includes(current.state)) await this.pauseNow(run.id, undefined, 'budget-rounds', { kind: 'budget', message: `${this.budgetText('budget-rounds', current)}。调高「总 Agent 的轮数上限」后点继续。` }, true); return; }
          return this.blocked(current, change.goal?.blockedReason?.message ?? '');
        case 'pause': if (ACTIVE.includes(current.state)) await this.pauseNow(run.id, undefined, 'user', undefined, true); return;
        case 'resume':
          if (current.state !== 'paused' && current.state !== 'blocked') return;
          try { await this.resumeNow(run.id, undefined, true); }
          catch (error) {
            // The model resumed its goal on a person's message, but the run cannot continue: keep the two in step.
            this.addEvent(run.id, 'resume-refused', `不能继续：${errorText(error)}`);
            try { this.hostGoalCall(agent.id, () => { const goal = this.goal(agent); if (goal?.phase === 'active') this.ctx.goals.pause(agent, { id: goal.id, revision: goal.revision }); }); }
            catch (pauseError) { this.ctx.logger.warn(`studio-autonomy: could not pause the goal of ${run.id} again: ${errorText(pauseError)}`); }
          }
          return;
        case 'edit': if (change.goal && change.goal.objective !== current.objective) { const updated = this.store.updateRun(run.id, value => { value.objective = change.goal!.objective; }, { bump: true }); this.addEvent(updated, 'objective-changed', `目标改为：${clip(change.goal.objective, 300)}`, { page: `总 Agent 把目标改为：${clip(change.goal.objective, 300)}` }); } return;
        case 'clear': await this.finish(run.id, 'stopped', undefined, '总 Agent 的目标被清除，运行已停止'); return;
      }
    }).catch(error => this.ctx.logger.warn(`studio-autonomy: goal change of ${run.id}: ${errorText(error)}`));
  }
  private async goalCompleted(run: StoredRun): Promise<void> {
    const open = this.tasksOf(run).filter(task => !DONE_STATES.has(task.state));
    if (!open.length) { await this.finish(run.id, 'completed', undefined, '总 Agent 报告目标已完成，范围内的任务全部完成'); return; }
    // From a paused or blocked run too: the model may complete its goal on a person's message.
    const updated = this.store.updateRun(run.id, value => { value.state = 'waiting-human'; delete value.pauseReason; value.activeSince ??= now(); }, { bump: true });
    const list = open.slice(0, 30).map(task => `${task.code} ${task.title}（${task.state === 'recheck' ? '待复核' : task.state === 'working' ? '进行中' : '待执行'}）`).join('；');
    const message = `总 Agent 报告目标已完成，但范围内还有 ${open.length} 个任务没有完成：${list}${open.length > 30 ? ' 等' : ''}。请选择「接受，结束运行」或「让它继续做」。`;
    // Its final reply is added when its turn ends; a turn that already ended gave it already.
    const running = this.ctx.studio.liveAgent(run.orchestratorChatId)?.status === 'running', reply = clip(this.lastText.get(run.orchestratorChatId), 1500);
    this.openAttention(updated.id, { kind: 'incomplete', chatId: run.orchestratorChatId, ...(running ? { awaitingSummary: true, message } : { message: reply ? `${message}\n\n总 Agent 的说明：${reply}` : message }) });
  }
  private blocked(run: StoredRun, reason: string): void {
    const updated = this.store.updateRun(run.id, value => { value.usage.elapsedMs = this.elapsed(value); delete value.activeSince; value.state = 'blocked'; }, { bump: true });
    this.addEvent(updated, 'blocked', `总 Agent 报告目标受阻：${reason}`, { chatId: run.orchestratorChatId });
    this.activity(updated, 'blocked', { request: { reason: clip(reason, 500) } });
    for (const worker of this.activeWorkers(run.id)) this.ctx.studio.interrupt(worker.chatId);
    this.wake(run.id);
  }
  activationChanged(payload: GoalActivationChanged): void {
    if (payload.goal?.activation !== 'disarmed' || this.closing) return;
    const chatId = String(payload.sessionId), run = this.orchestratorRun(chatId);
    if (!run || !ACTIVE.includes(run.state) || this.hostGoal.has(chatId)) return;
    // The driver stopped continuing an active goal: a model error, a reply cut off, or a person's stop outside a goal round.
    setImmediate(() => void this.serial(async () => {
      const current = this.store.findRun(run.id), agent = this.ctx.studio.liveAgent(chatId);
      if (!current || !ACTIVE.includes(current.state) || !agent || this.hostGoal.has(chatId)) return;
      const goal = this.goal(agent); if (!goal || goal.phase !== 'active' || goal.activation !== 'disarmed') return;
      const stoppedAt = this.humanStops.get(chatId);
      if (stoppedAt && Date.now() - stoppedAt < 120_000) { await this.pauseNow(run.id, undefined, 'user', undefined, false); return; }
      await this.pauseNow(run.id, undefined, 'orchestrator-error', { kind: 'stuck', cause: 'orchestrator', chatId,
        message: '总 Agent 停了下来（模型调用出错或回复太长被截断）。请查看总 Agent 的对话，确认后点「继续」。' }, false);
    }).catch(error => this.ctx.logger.warn(`studio-autonomy: orchestrator stop of ${run.id}: ${errorText(error)}`)));
  }
  orchestratorDisposed(chatId: string): void {
    const run = this.orchestratorRun(chatId); if (!run || !ACTIVE.includes(run.state) || this.closing) return;
    void this.serial(async () => {
      const current = this.store.findRun(run.id); if (!current || !ACTIVE.includes(current.state)) return;
      await this.pauseNow(run.id, undefined, 'orchestrator-error', { kind: 'stuck', cause: 'orchestrator', chatId,
        message: '总 Agent 的对话被关闭了（例如它所在的任务被清空、删除或冻结）。请检查后点「继续」，或停止运行。' }, true);
    }).catch(error => this.ctx.logger.warn(`studio-autonomy: orchestrator disposal of ${run.id}: ${errorText(error)}`));
  }
  private orchestratorRun(chatId: string): StoredRun | undefined {
    const mark = this.ctx.studio.chatRole(chatId); if (mark?.role !== 'orchestrator') return undefined;
    const run = this.store.findRun(mark.runId);
    return run && run.orchestratorChatId === chatId && isUnfinished(run.state) ? run : undefined;
  }
  private trackRounds(run: StoredRun, roundsStarted: number): void {
    const rounds = run.priorRounds + roundsStarted;
    if (rounds === run.usage.rounds) return;
    const updated = this.store.updateRun(run.id, value => { value.usage.rounds = value.priorRounds + roundsStarted; });
    this.checkBudget(updated);
  }

  /** Every session event of a run conversation: tokens, replies, tool failures, questions, people's messages, turn ends. */
  observe(session: Session, event: SessionEvent): void {
    if (this.closing) return;
    const chatId = String(session.id), mark = this.ctx.studio.chatRole(chatId); if (!mark) return;
    const run = this.store.findRun(mark.runId); if (!run || !isUnfinished(run.state)) return;
    if (event.seq < session.inheritedEventCount) return;
    const worker = mark.role === 'worker' ? this.store.worker(chatId) : undefined;
    switch (event.type) {
      case 'assistant/message': {
        const reply = event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
        if (reply.trim()) this.lastText.set(chatId, reply);
        this.tokens(run, chatId, session);
        if (worker) this.store.updateWorker(chatId, value => { value.lastActivityAt = now(); });
        break;
      }
      case 'assistant/attempt': this.tokens(run, chatId, session); break;
      case 'tool/result':
        if (worker && worker.state === 'active') {
          const failed = event.data.message.isError === true;
          const updated = this.store.updateWorker(chatId, value => { value.failures = failed ? value.failures + 1 : 0; value.lastActivityAt = now(); });
          if (failed && updated.failures >= run.settings.stuckFailures) this.openAttention(run.id, { kind: 'stuck', cause: 'failures', chatId, taskId: worker.taskId,
            message: `子 Agent（${this.taskLabel(worker.taskId)}）连续 ${updated.failures} 次工具调用失败。请查看它的对话：可以在对话里给出指示、让它继续，或停止这个子 Agent。` });
        }
        break;
      case 'user/message':
        // An admitted goal round is a goal-source message; the goal emits no change for it.
        if (event.data.source.kind === 'goal' && mark.role === 'orchestrator') this.trackRounds(run, event.data.source.round);
        if (event.data.source.kind === 'user') {
          // A person wrote in this conversation: that answers its 「blocked」 or 「stuck」 item.
          for (const item of this.store.openAttention(run.id)) if (item.chatId === chatId && (item.kind === 'blocked' || item.kind === 'stuck' && item.cause !== 'orchestrator')) this.closeAttention(item, 'replied', '人在对话里回复了');
        }
        break;
      case 'turn/end':
        if (mark.role === 'worker' && worker) this.workerSettled(run, worker, event.data.reason);
        if (mark.role === 'orchestrator') {
          const pending = this.store.openAttention(run.id).find(item => item.kind === 'incomplete' && item.awaitingSummary);
          if (pending) { const reply = clip(this.lastText.get(chatId), 1500); this.store.putAttention({ ...pending, awaitingSummary: false, ...(reply ? { message: `${pending.message}\n\n总 Agent 的说明：${reply}` } : {}) }); this.store.updateRun(run.id, () => {}, { bump: true }); }
        }
        this.tokens(run, chatId, session);
        break;
    }
    this.questionsOf(run, chatId, session, worker?.taskId);
  }
  private taskLabel(taskId: string): string { try { const task = this.domain().task(taskId); return `${task.code} ${task.title}`; } catch { return taskId; } }
  private workerSettled(run: StoredRun, worker: StoredWorker, reason: { kind: string }): void {
    const reply = clip(this.lastText.get(worker.chatId), 1500), label = this.taskLabel(worker.taskId);
    this.addEvent(run, 'worker-settled', `子 Agent（${label}）一轮结束${reason.kind === 'completed' ? '' : `（${reason.kind}）`}：${reply || '（没有文字回复）'}`, { chatId: worker.chatId, taskId: worker.taskId, data: { reason: reason.kind },
      page: `子 Agent（${label}）这一轮结束${settleReasons[reason.kind] ?? '（意外结束）'}：${clip(reply, 300) || '（没有文字回复）'}` });
    if (reason.kind === 'error' || reason.kind === 'max-tokens') this.addEvent(run, 'worker-failed', `子 Agent（${label}）这一轮因${reason.kind === 'error' ? '模型调用出错' : '回复太长被截断'}而结束`, { chatId: worker.chatId, taskId: worker.taskId });
    if (worker.state !== 'active' || reason.kind === 'aborted' || !ACTIVE.includes(run.state)) { this.store.updateWorker(worker.chatId, value => { value.progressed = false; }); return; }
    const updated = this.store.updateWorker(worker.chatId, value => { value.idleRounds = value.progressed ? 0 : value.idleRounds + 1; value.progressed = false; value.lastActivityAt = now(); });
    if (updated.idleRounds >= run.settings.stuckIdleRounds) this.openAttention(run.id, { kind: 'stuck', cause: 'idle', chatId: worker.chatId, taskId: worker.taskId,
      message: `子 Agent（${label}）连续 ${updated.idleRounds} 轮既没有报告进展也没有完成任务。请查看它的对话：可以在对话里给出指示、让它继续，或停止这个子 Agent。` });
  }
  /** ask_user_question in a run conversation is a 「question」 item until it is answered or withdrawn. */
  private questionsOf(run: StoredRun, chatId: string, session: Session, taskId?: string): void {
    const active = this.ctx.sessionProjections.stateOf(session, 'userQuestions')?.questions.active ?? [];
    const ids = new Set(active.map(item => String(item.callId))), known = this.questions.get(chatId) ?? new Set<string>();
    if (ids.size === known.size && [...ids].every(id => known.has(id))) return;
    this.questions.set(chatId, ids);
    for (const item of active) if (!known.has(String(item.callId))) {
      const asked = item.questions.map(question => question.question).join('；');
      this.openAttention(run.id, { kind: 'question', chatId, callId: String(item.callId), ...(taskId ? { taskId } : {}), message: `${chatId === run.orchestratorChatId ? '总 Agent' : `子 Agent（${taskId ? this.taskLabel(taskId) : chatId}）`}在问：${clip(asked, 600)}` });
    }
    for (const item of this.store.openAttention(run.id)) if (item.kind === 'question' && item.chatId === chatId && item.callId && !ids.has(item.callId)) this.closeAttention(item, 'answered', '问题已回答或已结束');
  }
  private tokens(run: StoredRun, chatId: string, session: Session): void {
    const buckets = this.ctx.sessionProjections.snapshot(session, ['tokenUsage']).values.tokenUsage as TokenUsageProjection | undefined;
    if (!buckets) return;
    const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
    const usage = { uncachedInput: count(buckets.uncachedInputTokens), cacheRead: count(buckets.cacheReadTokens), cacheWrite: count(buckets.cacheWriteTokens), output: count(buckets.outputTokens) };
    // Tokens the conversation used before it joined this run do not count.
    const known = run.chatTokens[chatId];
    if (typeof known === 'object' && (Object.keys(usage) as (keyof typeof usage)[]).every(key => known[key] === usage[key])) return;
    const updated = this.store.updateRun(run.id, value => { value.chatTokens[chatId] = usage; value.usage.tokens = runTokens(value.chatTokens, value.settings.cacheReadWeight); });
    this.checkBudget(updated);
  }

  /** 80% warns the orchestrator once; 100% pauses the run with a 「budget」 item. */
  private checkBudget(run: StoredRun): void {
    if (!ACTIVE.includes(run.state)) return;
    const over = this.exceeded(run, false);
    if (over) {
      void this.serial(async () => {
        const current = this.store.run(run.id); if (!ACTIVE.includes(current.state) || this.exceeded(current, false) !== over) return;
        await this.pauseNow(run.id, undefined, over, { kind: 'budget', message: `${this.budgetText(over, current)}。调高预算后点继续，或停止运行。` });
      }).catch(error => this.ctx.logger.warn(`studio-autonomy: budget pause of ${run.id}: ${errorText(error)}`));
      return;
    }
    const usage = [['tokens', run.usage.tokens / run.settings.tokenBudget, '折算 token 预算', '折算 token 预算'], ['time', this.elapsed(run) / (run.settings.maxHours * 3_600_000), '运行时长', '运行时间'], ['rounds', run.usage.rounds / run.settings.maxRounds, '总 Agent 轮数', '总 Agent 的轮数']] as const;
    for (const [kind, ratio, label, page] of usage) if (ratio >= 0.8 && !run.warned.includes(kind)) {
      const updated = this.store.updateRun(run.id, value => { if (!value.warned.includes(kind)) value.warned.push(kind); });
      this.addEvent(updated, 'budget-warning', `${label}已用到 ${Math.floor(ratio * 100)}%，请抓紧收尾，必要时请人调高预算`, { data: { budget: kind }, page: `${page}已用到 ${Math.floor(ratio * 100)}%` });
    }
  }

  /** Periodic: elapsed time, people's edits and completions in the project. */
  tick(): void {
    if (this.closing) return;
    for (const run of this.store.unfinished()) {
      try {
        if (!this.domain().projects().some(project => project.id === run.projectId)) { void this.serial(() => this.finish(run.id, 'stopped', undefined, '项目已删除，运行已结束')).catch(() => undefined); continue; }
        let current = run;
        if (current.activeSince) current = this.store.updateRun(run.id, value => { if (!value.activeSince) return; value.usage.elapsedMs = this.elapsed(value); value.activeSince = now(); });
        this.watch(current);
        this.releaseLostWorkers(current);
        this.checkBudget(this.store.run(run.id));
      } catch (error) { this.ctx.logger.warn(`studio-autonomy: tick of ${run.id}: ${errorText(error)}`); }
    }
  }
  /** A worker whose conversation was deleted or cleared away by a person no longer holds its task or a slot. */
  private releaseLostWorkers(run: StoredRun): void {
    for (const worker of this.activeWorkers(run.id)) {
      if (this.ctx.studio.chatUsable(worker.chatId)) continue;
      this.store.updateWorker(worker.chatId, value => { value.state = 'stopped'; value.stopReason = '对话已失效（任务被清空或删除）'; });
      this.addEvent(run, 'worker-failed', `子 Agent（${this.taskLabel(worker.taskId)}）的对话已失效（任务被清空或删除），已停止；需要时重新派出`, { chatId: worker.chatId, taskId: worker.taskId,
        page: `子 Agent（${this.taskLabel(worker.taskId)}）的对话已失效（任务被清空或删除），这个子 Agent 已停止` });
    }
  }
  private lastActivitySeq(projectId: string): number { return this.domain().activities(projectId).at(-1)?.seq ?? 0; }
  private watch(run: StoredRun): void {
    const revision = this.projectRevision(run.projectId);
    if (revision === undefined || revision === run.watch.projectRevision) return;
    const tasks = this.tasksOf(run), ids = new Set(tasks.map(task => task.id)), done = tasks.filter(task => DONE_STATES.has(task.state)).map(task => task.id);
    const known = new Set(run.watch.completed);
    for (const task of tasks) if (DONE_STATES.has(task.state) && !known.has(task.id)) this.taskCompleted(run, task);
    const edits = this.domain().activities(run.projectId).filter(event => event.seq > run.watch.activitySeq);
    const human = edits.filter(event => event.actor === 'human' && event.ok && /^(task|dependencies)(\/|:|$)/.test(event.action) && !/preview/.test(event.action)
      && (event.taskId ? ids.has(event.taskId) || !run.rootTaskId : !run.rootTaskId || [...ids].some(id => JSON.stringify(event.request ?? '').includes(id))));
    if (human.length) this.addEvent(run, 'human-edit', `人修改了范围内的任务图谱或清单：${human.slice(0, 10).map(event => `${event.action}${event.taskId ? `（${this.taskLabel(event.taskId)}）` : ''}`).join('；')}${human.length > 10 ? ` 等 ${human.length} 项` : ''}。请用 studio_autonomy_status 查看最新情况并按新情况调整`, { data: { actions: human.length },
      page: `你修改了范围内的任务：${[...new Set(human.slice(0, 10).map(event => editPage(event.action, event.taskId ? this.taskLabel(event.taskId) : undefined)))].join('；')}${human.length > 10 ? ` 等 ${human.length} 项` : ''}` });
    this.store.updateRun(run.id, value => { value.watch = { projectRevision: revision, activitySeq: edits.at(-1)?.seq ?? value.watch.activitySeq, completed: done }; });
  }
  private taskCompleted(run: StoredRun, task: Task): void {
    const worker = this.store.workers(run.id).find(value => value.taskId === task.id && value.state === 'active');
    if (worker) this.store.updateWorker(worker.chatId, value => { value.state = 'done'; value.progressed = true; value.idleRounds = 0; });
    let by: TaskView['completedBy']; try { by = this.domain().view(task.id).completedBy; } catch { /* deleted meanwhile */ }
    this.addEvent(run, 'task-completed', `任务 ${task.code} ${task.title} 已完成${by === 'agent' ? '（由 Agent 确认）' : by === 'human' ? '（由人确认）' : ''}`, { taskId: task.id, ...(worker ? { chatId: worker.chatId } : {}),
      page: `任务 ${task.code} ${task.title} 已完成${by === 'agent' ? '（由 Agent 确认）' : by === 'human' ? '（由你确认）' : ''}` });
    this.store.updateRun(run.id, value => { if (!value.watch.completed.includes(task.id)) value.watch.completed.push(task.id); });
  }

  // ---- tools ----
  /** The caller's run, checked at every call: restrictions only refresh when a conversation is loaded. */
  authorize(agent: Agent | undefined, role: 'orchestrator' | 'worker', states: readonly RunState[] = ACTIVE): StoredRun {
    if (!agent) throw new Error('Agent identity required');
    const mark = this.ctx.studio.chatRole(agent.id);
    if (!mark || mark.role !== role) throw new Error(role === 'orchestrator' ? '只有自主运行的总 Agent 可以使用这个工具' : '只有自主运行的子 Agent 可以使用这个工具');
    const run = this.store.findRun(mark.runId);
    if (!run || !isUnfinished(run.state)) throw new Error('这次自主运行已经结束，本对话现在是普通对话，不能再使用自主运行的工具');
    if (role === 'orchestrator' && run.orchestratorChatId !== agent.id) throw new Error('只有这次运行的总 Agent 可以使用这个工具');
    if (!states.includes(run.state)) throw new Error(run.state === 'paused' ? '自主运行已暂停，等人点继续后再操作' : run.state === 'blocked' ? '自主运行已受阻，等人处理' : '自主运行当前不能执行这个操作');
    return run;
  }
  statusFor(agent: Agent | undefined): unknown {
    const run = this.authorize(agent, 'orchestrator', ['running', 'waiting-human', 'paused', 'blocked']);
    const workers = this.store.workers(run.id), busy = new Map(workers.filter(worker => worker.state === 'active').map(worker => [worker.taskId, worker.chatId]));
    const tasks = this.tasksOf(run), parents = new Set(tasks.map(task => task.parentId).filter(Boolean));
    const views = tasks.slice(0, 300).map(task => {
      const view = this.domain().view(task.id), group = parents.has(task.id) || view.isFolder;
      const canStartWorker = !group && !DONE_STATES.has(view.state) && !view.pending && !view.blockers.length && view.writable && view.canDiscuss && !busy.has(task.id);
      // The same rule completionTarget enforces: groups in scope, and leaves no active worker is doing.
      const canConfirmNow = ACTIVE.includes(run.state) && !DONE_STATES.has(view.state) && (group || !busy.has(task.id));
      return { id: view.id, code: view.code, title: view.title, state: view.state, kind: group ? 'group' : 'leaf', ...(view.parentId ? { parentId: view.parentId } : {}),
        dependencies: view.dependencies, checklistItems: view.checklist?.length ?? 0, canStartWorker, ...(view.blockers.length ? { blockers: view.blockers } : {}),
        ...(view.pending ? { frozen: view.pending } : {}), ...(busy.has(task.id) ? { activeWorker: busy.get(task.id) } : {}),
        canConfirmNow, ...(view.completedBy ? { completedBy: view.completedBy } : {}) };
    });
    const pending = this.store.events(run.id, run.waitCursor).filter(event => event.deliver).length;
    return { run: { id: run.id, state: run.state, ...(run.pauseReason ? { pauseReason: run.pauseReason } : {}), objective: run.objective,
      scope: run.rootTaskId ? { rootTaskId: run.rootTaskId, label: this.taskLabel(run.rootTaskId) } : 'whole-project',
      budget: { maxWorkers: run.settings.maxWorkers, ...this.noSoftware() ? {} : { maxVms: run.settings.maxVms }, maxHours: run.settings.maxHours, tokenBudget: run.settings.tokenBudget, maxRounds: run.settings.maxRounds, maxNudges: run.settings.maxNudges },
      usage: { weightedTokens: run.usage.tokens, tokenBudget: run.settings.tokenBudget, cacheReadWeight: run.settings.cacheReadWeight, rawTokens: tokenBreakdown(run.chatTokens),
        elapsedMinutes: Math.round(this.elapsed(run) / 60_000), rounds: run.usage.rounds, activeWorkers: busy.size },
      workerModels: [run.settings.workerModel, ...run.settings.workerModels].filter(Boolean) },
      tasks: views, tasksTotal: tasks.length, ...(tasks.length > views.length ? { tasksTruncated: true } : {}),
      workers: workers.map(worker => this.workerView(worker, run)), attention: this.store.openAttention(run.id).map(item => ({ id: item.id, kind: item.kind, ...(item.chatId ? { chatId: item.chatId } : {}), ...(item.taskId ? { taskId: item.taskId } : {}), message: item.message, since: item.since })),
      pendingEvents: pending, ...(pending ? { next: 'Call studio_autonomy_wait to receive the pending events.' } : {}) };
  }
  private workerState(worker: StoredWorker, open: StoredAttention[]): WorkerState {
    if (worker.state === 'done') return 'done';
    if (worker.state === 'stopped') return 'stopped';
    if (open.some(item => item.chatId === worker.chatId)) return 'waiting-human';
    return this.ctx.studio.liveAgent(worker.chatId)?.status === 'running' ? 'running' : 'idle';
  }
  private workerView(worker: StoredWorker, run: StoredRun, open = this.store.openAttention(run.id)) {
    let task: Task | undefined; try { task = this.domain().task(worker.taskId); } catch { /* deleted */ }
    return { chatId: worker.chatId, taskId: worker.taskId, code: task?.code ?? '', title: task?.title ?? '（任务已删除）', provider: worker.provider, model: worker.model,
      state: this.workerState(worker, open), nudges: worker.nudges, ...(worker.lastReport ? { lastReport: worker.lastReport } : {}), ...(worker.lastActivityAt ? { lastActivityAt: worker.lastActivityAt } : {}) };
  }
  /** Tasks a worker may take: in scope, a leaf, not done or frozen, prerequisites met, no other active worker, room left. */
  private assertAssignable(run: StoredRun, taskId: string, except?: string): TaskView {
    const scope = this.scopeIds(run), view = this.domain().view(taskId);
    if (view.projectId !== run.projectId || scope && !scope.has(taskId) || view.archived) throw new Error('任务不在这次运行的范围内');
    if (view.isFolder) throw new Error('任务组由总 Agent 在子任务全部完成后确认，不能派子 Agent；请为它的叶任务派子 Agent');
    if (DONE_STATES.has(view.state)) throw new Error('任务已完成');
    if (view.pending) throw new Error(`任务正在进行其他操作（${view.pending}），请稍后再试`);
    if (view.blockers.length) throw new Error(`前置条件未满足：${view.blockers.join('；')}`);
    if (!view.writable || !view.canDiscuss) throw new Error('任务当前不能工作（被冻结、前置无效或上级任务已完成）');
    const active = this.activeWorkers(run.id).filter(worker => worker.chatId !== except);
    const same = active.find(worker => worker.taskId === taskId);
    if (same) throw new Error(`这个任务已有活动的子 Agent（对话 ${same.chatId}）；请用 studio_autonomy_message_worker 给它发消息，或先停止它`);
    if (active.length >= run.settings.maxWorkers) throw new Error(`同时工作的子 Agent 已达上限（${run.settings.maxWorkers} 个），请等其中一个完成或停止后再派`);
    return view;
  }
  startWorker(agent: Agent | undefined, args: Record<string, unknown>): Promise<unknown> {
    return this.serial(async () => {
      const run = this.authorize(agent, 'orchestrator');
      if (this.store.openAttention(run.id).some(item => item.kind === 'incomplete')) throw new Error('你已报告目标完成，正在等人确认，不能再派出子 Agent');
      const over = this.exceeded(run, false); if (over) throw new Error(`${this.budgetText(over, run)}，不能再派出子 Agent`);
      const taskId = text(args.taskId, 'taskId', 200), instructions = text(args.instructions, 'instructions', 32000);
      const allowed = [run.settings.workerModel!, ...run.settings.workerModels];
      let model = run.settings.workerModel!;
      if (args.model !== undefined) {
        const choice = exact(args.model, ['provider', 'model'], 'model');
        model = { provider: text(choice.provider, 'model.provider', 200), model: text(choice.model, 'model.model', 200) };
        if (!allowed.some(item => sameModel(item, model))) throw new Error(`只能选用运行设置允许的子 Agent 模型：${allowed.map(formatModel).join('、')}`);
      }
      const view = this.assertAssignable(run, taskId);
      await this.ctx.studioModels.validateSelection(model.provider, model.model);
      const chat = await this.ctx.studio.startAutonomyChat({ scope: 'task', ownerId: taskId, role: 'worker', runId: run.id, provider: model.provider, model: model.model,
        message: `${ORCHESTRATOR_ORDER}\n${instructions}`, from: 'orchestrator' });
      const time = now();
      this.store.putWorker({ chatId: chat.id, runId: run.id, taskId, provider: model.provider, model: model.model, state: 'active', nudges: 0, failures: 0, idleRounds: 0, progressed: false, createdAt: time, lastActivityAt: time });
      this.addEvent(run, 'worker-started', `派出子 Agent 做任务 ${view.code} ${view.title}（${formatModel(model)}）`, { chatId: chat.id, taskId, page: `派出子 Agent 做任务 ${view.code} ${view.title}（模型 ${model.model}）` });
      this.activity(run, 'start-worker', { taskId, chatId: chat.id, request: { provider: model.provider, model: model.model } });
      return { chatId: chat.id, taskId, code: view.code, title: view.title, provider: model.provider, model: model.model, maxWorkers: run.settings.maxWorkers, activeWorkers: this.activeWorkers(run.id).length };
    });
  }
  messageWorker(agent: Agent | undefined, args: Record<string, unknown>): Promise<unknown> {
    return this.serial(async () => {
      const run = this.authorize(agent, 'orchestrator');
      const chatId = text(args.chatId, 'chatId', 200), message = text(args.message, 'message', 32000), worker = this.store.worker(chatId);
      if (!worker || worker.runId !== run.id) throw new Error('这不是本次运行的子 Agent');
      if (worker.state === 'done') throw new Error('这个子 Agent 的任务已完成');
      if (this.store.openAttention(run.id).some(item => item.kind === 'stuck' && item.cause === 'nudges' && item.chatId === chatId)) throw new Error('给这个子 Agent 发消息的次数已达上限，已请人处理；人处理之前不能再给它发消息');
      if (worker.state === 'stopped') {
        if (this.store.openAttention(run.id).some(item => item.kind === 'incomplete')) throw new Error('你已报告目标完成，正在等人确认，不能再让子 Agent 恢复工作');
        this.assertAssignable(run, worker.taskId, chatId);
      }
      await this.ctx.studio.sendAutonomyMessage(chatId, { runId: run.id, from: 'orchestrator', message: `${ORCHESTRATOR_ORDER}\n${message}` });
      const updated = this.store.updateWorker(chatId, value => { value.state = 'active'; delete value.stopReason; value.nudges++; value.lastActivityAt = now(); });
      this.addEvent(run, 'worker-message', `给子 Agent（${this.taskLabel(worker.taskId)}）发消息：${clip(message, 200)}`, { chatId, taskId: worker.taskId, page: `总 Agent 给子 Agent（${this.taskLabel(worker.taskId)}）发了消息：${clip(message, 200)}` });
      if (updated.nudges >= run.settings.maxNudges) this.openAttention(run.id, { kind: 'stuck', cause: 'nudges', chatId, taskId: worker.taskId,
        message: `总 Agent 已给子 Agent（${this.taskLabel(worker.taskId)}）发了 ${updated.nudges} 次消息，它可能卡住了。请查看它的对话：可以在对话里给出指示、让它继续，或停止这个子 Agent。` });
      return { chatId, delivered: true, nudges: updated.nudges, maxNudges: run.settings.maxNudges, workerStatus: this.ctx.studio.liveAgent(chatId)?.status ?? 'stored' };
    });
  }
  stopWorker(agent: Agent | undefined, args: Record<string, unknown>): Promise<unknown> {
    return this.serial(async () => {
      const run = this.authorize(agent, 'orchestrator', ['running', 'waiting-human', 'blocked']);
      const chatId = text(args.chatId, 'chatId', 200), reason = text(args.reason, 'reason', 2000), worker = this.store.worker(chatId);
      if (!worker || worker.runId !== run.id) throw new Error('这不是本次运行的子 Agent');
      if (worker.state !== 'active') throw new Error(worker.state === 'done' ? '这个子 Agent 的任务已完成' : '这个子 Agent 已经停止');
      this.stopWorkerNow(run, worker, `总 Agent 停止：${reason}`, 'orchestrator', reason);
      return { chatId, stopped: true, activeWorkers: this.activeWorkers(run.id).length };
    });
  }
  private stopWorkerNow(run: StoredRun, worker: StoredWorker, reason: string, by: 'human' | 'orchestrator', why?: string): void {
    this.ctx.studio.liveAgent(worker.chatId)?.cancel({ kind: 'user' });
    if (worker.state === 'active') this.store.updateWorker(worker.chatId, value => { value.state = 'stopped'; value.stopReason = reason; });
    for (const item of this.store.openAttention(run.id)) if (item.chatId === worker.chatId && (item.kind === 'stuck' || item.kind === 'blocked')) this.closeAttention(item, 'stop-worker', '子 Agent 已停止');
    this.addEvent(run, 'worker-stopped', `停止子 Agent（${this.taskLabel(worker.taskId)}）：${clip(reason, 300)}`, { chatId: worker.chatId, taskId: worker.taskId,
      page: by === 'human' ? `你停止了子 Agent（${this.taskLabel(worker.taskId)}）` : `总 Agent 停止了子 Agent（${this.taskLabel(worker.taskId)}）${why ? `：${clip(why, 300)}` : ''}` });
    this.activity(run, 'stop-worker', { taskId: worker.taskId, chatId: worker.chatId, request: { reason: clip(reason, 300) } });
  }
  report(agent: Agent | undefined, args: Record<string, unknown>): unknown {
    const run = this.authorize(agent, 'worker');
    const kind = args.kind as WorkerReportKind, message = text(args.message, 'message', 8000);
    if (!['progress', 'blocked', 'question-for-orchestrator'].includes(kind)) throw new Error('kind 只能是 progress、blocked 或 question-for-orchestrator');
    const worker = this.store.worker(agent!.id);
    if (!worker || worker.runId !== run.id) throw new Error('本对话不是这次运行的子 Agent');
    if (worker.state !== 'active') throw new Error(worker.state === 'done' ? '你的任务已完成，不需要再报告' : '你已被总 Agent 或人停止；等收到新的指令再继续');
    const at = now();
    this.store.updateWorker(worker.chatId, value => { value.lastReport = { kind, message: clip(message, 2000), at }; value.progressed = true; value.idleRounds = 0; value.lastActivityAt = at; });
    const label = this.taskLabel(worker.taskId);
    this.addEvent(run, 'worker-reported', `子 Agent（${label}）${kind === 'progress' ? '报告进展' : kind === 'blocked' ? '报告需要人处理' : '请总 Agent 决定'}：${message}`, { chatId: worker.chatId, taskId: worker.taskId, data: { kind } });
    this.activity(run, 'report', { taskId: worker.taskId, chatId: worker.chatId, request: { kind, message: clip(message, 500) } });
    if (kind === 'blocked') this.openAttention(run.id, { kind: 'blocked', chatId: worker.chatId, taskId: worker.taskId, message: `子 Agent（${label}）需要人处理：${clip(message, 1500)}` });
    return { delivered: true, kind, next: kind === 'blocked' ? 'A human-attention item was opened. End this turn; you will receive a message when the person has dealt with it.'
      : kind === 'question-for-orchestrator' ? 'The orchestrator receives this at its next wait. End this turn if you cannot continue without its answer.' : 'The orchestrator receives this at its next wait. Continue your task.' };
  }
  async wait(agent: Agent | undefined, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const run = this.authorize(agent, 'orchestrator');
    const seconds = args.timeoutSeconds === undefined ? 300 : args.timeoutSeconds;
    if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < 1 || seconds > 600) throw new Error('timeoutSeconds 须为 1–600 的整数');
    if (this.waiting.has(run.id)) throw new Error('已有一个 studio_autonomy_wait 在等待；一次只能等一个');
    this.waiting.add(run.id);
    const deadline = Date.now() + seconds * 1000;
    try {
      for (;;) {
        throwIfAborted(signal, WAIT_STOPPED);
        const current = this.store.run(run.id);
        if (!ACTIVE.includes(current.state)) return { events: [], run: this.brief(current), note: '运行已暂停或结束，停止等待并结束本轮。' };
        if (this.queuedForOrchestrator(agent!)) return { events: [], humanMessage: true, run: this.brief(current), next: 'A person sent you a message. End this turn now (without calling more tools) to read it; the run continues afterwards.' };
        const fetched = this.store.events(run.id, current.waitCursor), delivered = fetched.filter(event => event.deliver);
        if (fetched.length) this.store.updateRun(run.id, value => { value.waitCursor = Math.max(value.waitCursor, fetched.at(-1)!.seq); });
        if (delivered.length) return { events: delivered.map(event => ({ seq: event.seq, at: event.at, type: event.type, summary: event.summary, ...(event.chatId ? { chatId: event.chatId } : {}), ...(event.taskId ? { taskId: event.taskId } : {}), ...(event.data ? { data: event.data } : {}) })),
          run: this.brief(this.store.run(run.id)), ...(fetched.length >= 500 ? { more: true } : {}),
          ...(this.queuedForOrchestrator(agent!) ? { humanMessage: true, next: 'A person also sent you a message: handle these events briefly, then end this turn to read it.' } : {}) };
        if (fetched.length >= 500) continue;
        const remaining = deadline - Date.now();
        if (remaining <= 0 || this.closing) return { events: [], timedOut: true, run: this.brief(current), next: 'No new events. Check studio_autonomy_status if something seems stuck, then wait again.' };
        await new Promise<void>(resolve => {
          const set = this.waiters.get(run.id) ?? new Set(); this.waiters.set(run.id, set);
          const done = () => { clearTimeout(timer); set.delete(done); signal.removeEventListener('abort', done); resolve(); };
          const timer = setTimeout(done, remaining); set.add(done); signal.addEventListener('abort', done, { once: true });
        });
      }
    } finally { this.waiting.delete(run.id); }
  }
  /** Messages a person (or anyone but the goal driver) queued for the orchestrator's next turn wait behind its wait. */
  private queuedForOrchestrator(agent: Agent): boolean {
    const live = this.ctx.studio.liveAgent(agent.id) ?? agent;
    return [...live.inbox?.nextTurn ?? []].some(message => message.source.kind !== 'goal');
  }
  inboxInserted(agent: Agent): void {
    const mark = this.ctx.studio.chatRole(agent.id);
    if (mark?.role === 'orchestrator') this.wake(mark.runId);
  }
  private brief(run: StoredRun) {
    return { state: run.state, ...(run.pauseReason ? { pauseReason: run.pauseReason } : {}), activeWorkers: this.activeWorkers(run.id).length, openAttention: this.store.openAttention(run.id).length,
      usage: { weightedTokens: run.usage.tokens, tokenBudget: run.settings.tokenBudget, cacheReadWeight: run.settings.cacheReadWeight, elapsedMinutes: Math.round(this.elapsed(run) / 60_000), maxHours: run.settings.maxHours, rounds: run.usage.rounds, maxRounds: run.settings.maxRounds } };
  }

  /** Completion permission of the autonomy tools (设计.md §4.3): a worker its own task; the orchestrator scope groups and
   * leaves no active worker is doing. The domain then applies every check of a human completion. */
  completionTarget(agent: Agent | undefined, taskId: string): { run: StoredRun; role: 'orchestrator' | 'worker' } {
    if (!agent) throw new Error('Agent identity required');
    const mark = this.ctx.studio.chatRole(agent.id);
    if (!mark) throw new Error('只有自主运行中的总 Agent 和子 Agent 可以确认任务完成');
    const run = this.authorize(agent, mark.role);
    if (mark.role === 'worker') {
      const worker = this.store.worker(agent.id);
      if (!worker || worker.runId !== run.id || worker.taskId !== taskId) throw new Error('子 Agent 只能确认自己的任务完成');
      if (worker.state !== 'active') throw new Error('你已被停止，不能再确认任务完成');
      return { run, role: 'worker' };
    }
    const scope = this.scopeIds(run), task = this.domain().view(taskId);
    if (task.projectId !== run.projectId || scope && !scope.has(taskId) || task.archived) throw new Error('任务不在这次运行的范围内');
    if (!task.isFolder) {
      const busy = this.activeWorkers(run.id).find(worker => worker.taskId === taskId);
      if (busy) throw new Error(`这个叶任务由子 Agent（对话 ${busy.chatId}）在做，应由它自己确认完成；需要时先停止它`);
    }
    return { run, role: 'orchestrator' };
  }
  completionRecorded(run: StoredRun, taskId: string): void {
    const task = this.domain().task(taskId);
    if (DONE_STATES.has(task.state) && !this.store.run(run.id).watch.completed.includes(taskId)) this.taskCompleted(this.store.run(run.id), task);
  }

  // ---- page views ----
  summary(run: StoredRun): RunSummary {
    return { id: run.id, projectId: run.projectId, ...(run.rootTaskId ? { rootTaskId: run.rootTaskId } : {}), objective: run.objective, state: run.state,
      ...(run.pauseReason ? { pauseReason: run.pauseReason } : {}), createdAt: run.createdAt, startedAt: run.startedAt, ...(run.endedAt ? { endedAt: run.endedAt } : {}), revision: run.revision,
      openAttention: this.store.openAttention(run.id).length };
  }
  async detail(id: string): Promise<RunDetail> {
    const run = this.store.run(id), attention = this.store.attention(id), open = attention.filter(item => !item.resolvedAt);
    const workers = this.store.workers(id);
    return { ...this.summary(run), settings: run.settings, orchestratorChatId: run.orchestratorChatId,
      usage: { tokens: run.usage.tokens, tokenBreakdown: tokenBreakdown(run.chatTokens), elapsedMs: this.elapsed(run), rounds: run.usage.rounds, vms: isUnfinished(run.state) ? await this.vms(run) : 0, workers: workers.filter(worker => worker.state === 'active').length },
      workers: workers.map(worker => this.workerView(worker, run, open)),
      attention: attention.slice(-100).map(item => ({ id: item.id, kind: item.kind, ...(item.chatId ? { chatId: item.chatId } : {}), ...(item.taskId ? { taskId: item.taskId } : {}), message: item.message, since: item.since, ...(item.resolvedAt ? { resolvedAt: item.resolvedAt } : {}) })),
      events: this.store.latestEvents(id, 50).map(event => ({ at: event.at, type: event.type, summary: event.page ?? event.summary, ...(event.chatId ? { chatId: event.chatId } : {}), ...(event.taskId ? { taskId: event.taskId } : {}) })) };
  }
  /** Every run of a project for the project export, oldest first, with all of its events and attention items. */
  exportRuns(projectId: string): AutonomyRunExport[] {
    return this.store.runs(projectId).reverse().map(run => {
      const events: AutonomyRunExport['events'] = [];
      for (let page = this.store.events(run.id, 0, 1000); page.length; page = this.store.events(run.id, page.at(-1)!.seq, 1000))
        for (const { runId: _run, ...event } of page) events.push(event);
      const workers = this.store.workers(run.id).map(({ runId: _run, progressed: _progressed, ...worker }) => {
        let task: Task | undefined; try { task = this.domain().task(worker.taskId); } catch { /* deleted later: the record stays */ }
        return { ...worker, code: task?.code ?? '', title: task?.title ?? '（任务已删除）' };
      });
      return { format: 'harnessstudio-autonomy-run/1' as const, id: run.id, projectId: run.projectId, ...(run.rootTaskId ? { rootTaskId: run.rootTaskId } : {}), objective: run.objective, state: run.state, ...(run.pauseReason ? { pauseReason: run.pauseReason } : {}),
        createdAt: run.createdAt, startedAt: run.startedAt, ...(run.endedAt ? { endedAt: run.endedAt } : {}), orchestratorChatId: run.orchestratorChatId, settings: run.settings,
        usage: { weightedTokens: run.usage.tokens, tokenBreakdown: tokenBreakdown(run.chatTokens), byChat: run.chatTokens, elapsedMs: this.elapsed(run), rounds: run.usage.rounds },
        workers, attention: this.store.attention(run.id).map(({ runId: _run, awaitingSummary: _awaiting, ...item }) => item), events };
    });
  }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const controller = new AutonomyController(ctx, config);
  const problem = await controller.initialize(); if (problem) ctx.logger.warn(`studio-autonomy: ${problem}`);
  // Without software the variants say nothing about VMs (prompts/autonomy-*-no-software-system-prompt.md).
  const noSoftware = ctx.studioDomain.softwareBackend === 'none';
  const variant = (configured: string, base: string) => configured || join(dirname(base), basename(base).replace(/-system-prompt\.md$/u, '-no-software-system-prompt.md'));
  const [orchestratorPrompt, workerPrompt] = await Promise.all([
    loadPromptFile(noSoftware ? variant(config.orchestratorNoSoftwarePromptPath, config.orchestratorPromptPath) : config.orchestratorPromptPath),
    loadPromptFile(noSoftware ? variant(config.workerNoSoftwarePromptPath, config.workerPromptPath) : config.workerPromptPath)]);
  ctx.effect(() => { const unprovide = ctx.provide('studioAutonomy', controller); return async () => { controller.dispose(); await unprovide(); }; }, 'studio-autonomy: controller');
  ctx.effect(() => ctx.studio.bindAutonomy(controller), 'studio-autonomy: runtime bridge');
  ctx.effect(() => ctx.studio.registerInstructions('autonomy-orchestrator', 115, orchestratorPrompt.prompt, 'orchestrator'), 'studio-autonomy: orchestrator instructions');
  ctx.effect(() => ctx.studio.registerInstructions('autonomy-worker', 116, workerPrompt.prompt, 'worker'), 'studio-autonomy: worker instructions');
  ctx.on('session/event', (session, event) => { try { controller.observe(session, event); } catch (error) { ctx.logger.warn(`studio-autonomy: ${errorText(error)}`); } });
  ctx.on('goal/changed', ({ agent, change }) => controller.goalChanged(agent, change));
  ctx.on('goal/activation-changed', payload => controller.activationChanged(payload));
  ctx.on('agent/disposed', ({ agent }) => controller.orchestratorDisposed(agent.id));
  ctx.on('agent/inbox/inserted', ({ agent }) => controller.inboxInserted(agent));
  ctx.effect(() => { const timer = setInterval(() => controller.tick(), config.tickSeconds * 1000); timer.unref(); return () => clearInterval(timer); }, 'studio-autonomy: budget and project watch');
  registerTools(ctx, controller);
  registerRoutes(ctx, controller);
}

function registerTools(ctx: Context, controller: AutonomyController): void {
  const noSoftware = ctx.studioDomain.softwareBackend === 'none';
  const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] };
  const json = (value: unknown) => JSON.stringify(value);
  const tools = [
    defineTool({ name: 'studio_autonomy_status', description: 'Autonomy orchestrator only. Read this run: state, objective, scope, budget and usage, every task in scope (internal ID, code, title, state, leaf or group, dependencies, whether a worker can start now, blockers, active worker), every worker (chatId, task, model, state, latest report), open human-attention items and how many events wait for studio_autonomy_wait. Refused in ordinary conversations, in other runs and after the run ended.',
      parameters: {}, output, async execute(_args, exec) { throwIfAborted(exec.signal); return json(controller.statusFor(exec.agent)); } }),
    defineTool({ name: 'studio_autonomy_start_worker', description: 'Autonomy orchestrator only. Start a worker for one leaf task in scope: a new task conversation of that task receives your instructions as its first message and works with that task’s own tools and permissions. Refused when the task is out of scope, a group, completed, frozen, has unmet prerequisites, already has an active worker, when active workers reached the run’s maxWorkers, when you reported the goal complete, or when the budget is used up. model must be one of the run’s allowed worker models; omit it for the default worker model.',
      parameters: { taskId: { type: 'string', required: true, description: 'Internal task ID from studio_autonomy_status, never the display code.' },
        instructions: { type: 'string', required: true, description: 'What the worker must achieve, what it may assume, what to verify, and when to report. Up to 32000 characters.' },
        model: { type: 'object', description: 'Optional {provider, model}: one of the run’s allowed worker models.', properties: { provider: { type: 'string', required: true }, model: { type: 'string', required: true } }, additionalProperties: false } },
      output, timeoutMs: 120000, async execute(args, exec) { throwIfAborted(exec.signal); return json(await abortable(controller.startWorker(exec.agent, args as Record<string, unknown>), exec.signal)); } }),
    defineTool({ name: 'studio_autonomy_message_worker', description: 'Autonomy orchestrator only. Send a message to one of this run’s workers: a running worker reads it at its next step, an idle one starts a new turn. A stopped worker is restarted (the worker limits are checked again). Every message counts toward that worker’s nudge limit; at the limit a human-attention item opens and further messages are refused until a person handles it.',
      parameters: { chatId: { type: 'string', required: true, description: 'Worker chatId from studio_autonomy_status or studio_autonomy_start_worker.' }, message: { type: 'string', required: true, description: 'Clear, specific instructions. Up to 32000 characters.' } },
      output, timeoutMs: 120000, async execute(args, exec) { throwIfAborted(exec.signal); return json(await abortable(controller.messageWorker(exec.agent, args as Record<string, unknown>), exec.signal)); } }),
    defineTool({ name: 'studio_autonomy_stop_worker', description: 'Autonomy orchestrator only. Stop one of this run’s workers, like the stop button: its current turn ends, nothing is deleted (conversation, files' + (noSoftware ? '' : ' and VMs') + ' stay). The task becomes free for another worker.',
      parameters: { chatId: { type: 'string', required: true, description: 'Worker chatId.' }, reason: { type: 'string', required: true, description: 'Why, shown to the user.' } },
      output, async execute(args, exec) { throwIfAborted(exec.signal); return json(await abortable(controller.stopWorker(exec.agent, args as Record<string, unknown>), exec.signal)); } }),
    defineTool({ name: 'studio_autonomy_wait', description: 'Autonomy orchestrator only. Block until this run has new events or the timeout passes (default 300 s, at most 600 s), then return every event since the previous wait exactly once: worker-settled (a worker’s turn ended, with its last reply), worker-reported, task-completed, worker-failed, attention-opened, attention-resolved, human-edit, budget-warning, resumed. Always wait with this tool instead of ending your turn: an idle orchestrator is restarted immediately and wastes the budget. Returns at once when the run is paused or stopped.',
      parameters: { timeoutSeconds: { type: 'integer', description: 'Seconds to wait, 1–600, default 300.' } },
      output, timeoutMs: 630000, async execute(args, exec) { throwIfAborted(exec.signal, WAIT_STOPPED); return json(await controller.wait(exec.agent, args as Record<string, unknown>, exec.signal)); } }),
    defineTool({ name: 'studio_agent_report', description: 'Autonomy worker only. Report to the orchestrator. kind progress: a stage is done (say what and how you checked it). kind blocked: a person must act (login, licence, popup, missing key information, dangerous operation); this opens a human-attention item, then end your turn. kind question-for-orchestrator: a decision the orchestrator must make. The orchestrator receives reports at its next wait.',
      parameters: { kind: { type: 'string', required: true, enum: ['progress', 'blocked', 'question-for-orchestrator'] }, message: { type: 'string', required: true, description: 'Specific report, up to 8000 characters.' } },
      output, async execute(args, exec) { throwIfAborted(exec.signal); return json(controller.report(exec.agent, args as Record<string, unknown>)); } }),
    ...completionTools(ctx, controller, output),
  ];
  for (const tool of tools) ctx.tools.register({ ...tool, parameters: { ...tool.parameters, additionalProperties: false } });
}

/** 设计.md §4.3: permission here, then every check of a human completion in the domain (§4.4). */
function completionTools(ctx: Context, controller: AutonomyController, output: { schema: { type: 'string' }; render: (args: unknown, value: string) => { type: 'text'; text: string }[] }) {
  return [
    defineTool({ name: 'studio_agent_completion_preview', description: 'Autonomy orchestrator and workers only. The same preview a person sees before completing a task: the goals to confirm (overall goal and every checklist item, with IDs), the working files with suggested descriptions, the workspace version, a group’s direct children and their version, and blockers. Call it before studio_agent_complete_task and check every goal against real files.',
      parameters: { taskId: { type: 'string', required: true, description: 'Internal task ID.' } }, output,
      async execute(args, exec) {
        throwIfAborted(exec.signal);
        const taskId = text(args.taskId, 'taskId', 200);
        controller.completionTarget(exec.agent, taskId);
        return JSON.stringify(await abortable(ctx.studioDomain.agentCompletionPreview(taskId), exec.signal));
      } }),
    defineTool({ name: 'studio_agent_complete_task', description: 'Autonomy orchestrator and workers only. Confirm a task complete as the Agent. A worker may complete only its own task; the orchestrator only task groups in scope and leaf tasks no active worker is doing. Give revision, workspaceVersion (and childrenVersion for a group) from studio_agent_completion_preview, evidence for every goal, and either files to submit or withoutFiles:true. Evidence must be concrete and true: which file you checked, how, and the result. Every check of a human completion still applies (prerequisites, all direct children completed, versions, frozen state). The record shows the task was confirmed by an Agent; a person can reopen it.',
      parameters: {
        taskId: { type: 'string', required: true }, revision: { type: 'integer', required: true }, workspaceVersion: { type: 'string', required: true }, childrenVersion: { type: 'string', description: 'Required for a task group.' },
        evidence: { type: 'object', required: true, description: '{goal: evidence for the overall goal, checklist: [{id, evidence}] covering every checklist goal ID of the preview exactly once}.', additionalProperties: false,
          properties: { goal: { type: 'string', required: true }, checklist: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', required: true }, evidence: { type: 'string', required: true } } } } } },
        files: { type: 'array', description: 'Working files to submit: [{path, description}]. Give either files or withoutFiles.', items: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true }, description: { type: 'string', required: true } } } },
        withoutFiles: { type: 'boolean', description: 'true: complete without submitted files.' },
      }, output, timeoutMs: 300000,
      async execute(args, exec) {
        throwIfAborted(exec.signal);
        const taskId = text(args.taskId, 'taskId', 200), { run } = controller.completionTarget(exec.agent, taskId), agent = exec.agent!;
        // The domain validates every field again; withoutFiles:false means "not given".
        const { taskId: _task, ...rest } = args as Record<string, unknown>;
        if (rest.withoutFiles === false) delete rest.withoutFiles;
        const actor = { runId: run.id, chatId: agent.id, ...ctx.studio.chatModel(agent.id) };
        // The caller keeps its turn while its task freezes; its writes are revoked like everyone else's.
        const operation = ctx.studio.whileCompleting(agent.id, () => ctx.studioDomain.agentCompleteTask(taskId, rest as unknown as AgentCompletionInput, actor));
        void operation.then(() => controller.completionRecorded(run, taskId)).catch(() => undefined);
        const result = await abortable(operation, exec.signal);
        return JSON.stringify(result);
      } }),
  ];
}

function registerRoutes(ctx: Context, controller: AutonomyController): void {
  const query = (request: Request, keys: string[]) => { const values = Object.fromEntries(new URL(request.url).searchParams); const extra = Object.keys(values).find(key => !keys.includes(key)); if (extra) throw new Error(`不支持的参数：${extra}`); return values; };
  const runId = (data: Record<string, unknown>) => text(data.id, '运行 ID', 200);
  const routes: [string, 'GET' | 'POST', (request: Request, data: Record<string, unknown>) => Promise<unknown>][] = [
    ['settings', 'GET', async request => { query(request, []); return controller.settings.get(); }],
    ['settings', 'POST', async (_request, data) => {
      const body = exact(data, ['revision', 'settings'], '设置');
      return controller.settings.save(body.revision, body.settings, async settings => { for (const model of [settings.orchestratorModel, settings.workerModel, ...settings.workerModels]) if (model) await ctx.studioModels.validateSelection(model.provider, model.model); });
    }],
    ['runs', 'GET', async request => {
      // Without a project, every project's runs (the side bar); runs of deleted projects are left out.
      const { projectId } = query(request, ['projectId']), projects = new Set(ctx.studioDomain.projects().map(project => project.id));
      if (projectId !== undefined && !projects.has(text(projectId, '项目', 200))) throw new Error('项目不存在');
      return { runs: controller.store.runs(projectId).filter(run => projects.has(run.projectId)).map(run => controller.summary(run)) };
    }],
    ['run', 'GET', async request => controller.detail(text(query(request, ['id']).id, '运行 ID', 200))],
    ['start', 'POST', async (_request, data) => controller.start(data)],
    ['pause', 'POST', async (_request, data) => { exact(data, ['id', 'revision'], '暂停参数'); return controller.pause(runId(data), data.revision); }],
    ['resume', 'POST', async (_request, data) => { exact(data, ['id', 'revision'], '继续参数'); return controller.resume(runId(data), data.revision); }],
    ['stop', 'POST', async (_request, data) => { exact(data, ['id', 'revision'], '停止参数'); return controller.stop(runId(data), data.revision); }],
    ['update', 'POST', async (_request, data) => controller.update(data)],
    ['attention/resolve', 'POST', async (_request, data) => controller.resolveAttention(data)],
  ];
  for (const path of new Set(routes.map(([path]) => path))) {
    const handlers = routes.filter(route => route[0] === path);
    ctx.connection.fetch.register({ path: `/api/studio/autonomy/${path}`, methods: handlers.map(route => route[1]), requestBody: 'buffered', async fetch(request) {
      try {
        const handler = handlers.find(route => route[1] === request.method)?.[2];
        if (!handler) throw new Error('不支持的请求方法');
        if (request.method === 'GET') return Response.json(await ctx.studioDomain.webAction(request, () => handler(request, {})));
        const data = object(await request.json(), '请求内容');
        // The activity log files a change under the project in its request; run routes carry only the run ID.
        let projectId: string | undefined;
        if (typeof data.id === 'string') projectId = controller.store.findRun(data.id)?.projectId;
        const url = new URL(request.url); if (projectId && data.projectId === undefined) url.searchParams.set('projectId', projectId);
        const logged = new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
        return Response.json(await ctx.studioDomain.webAction(logged, () => handler(request, data)));
      } catch (error) { return Response.json({ error: errorText(error) }, { status: 400 }); }
    } });
  }
}
