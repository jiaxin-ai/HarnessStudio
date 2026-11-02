/** The wording and arithmetic the page needs for autonomy runs; the data shapes are the backend's (设计.md §8, §12). */
import { DEFAULT_AUTONOMY_SETTINGS, type AttentionAction, type AttentionKind, type AutonomyRole, type AutonomySettings, type ModelChoice, type RunAttention, type RunDetail, type RunEvent,
  type RunState, type RunSummary, type RunWorker, type WorkerState } from '@harnessstudio/studio/autonomy-types';
export type { AttentionAction, AttentionKind, AutonomySettings, RunAttention, RunDetail, RunEvent, RunState, RunSummary, RunWorker, WorkerState };
export type ModelRef = ModelChoice;
export type ChatRole = AutonomyRole;
/** The numbers of the settings: what the budget forms and the defaults page edit. Models are chosen when a run starts. */
export type AutonomyBudget = Pick<AutonomySettings, 'maxWorkers' | 'maxVms' | 'maxHours' | 'tokenBudget' | 'cacheReadWeight' | 'maxRounds' | 'maxNudges' | 'stuckFailures' | 'stuckIdleRounds'>;

/** The §6 defaults; used only to fill the form when the saved defaults cannot be read. */
const { orchestratorModel: _orchestrator, workerModel: _worker, workerModels: _workers, ...builtInBudget } = DEFAULT_AUTONOMY_SETTINGS;
export const defaultBudget: AutonomyBudget = builtInBudget;
export const budgetKeys = Object.keys(defaultBudget) as (keyof AutonomyBudget)[];
export const budgetOf = (settings: Partial<AutonomyBudget>): AutonomyBudget => Object.fromEntries(budgetKeys.map(key => [key, typeof settings[key] === 'number' ? settings[key] : defaultBudget[key]])) as unknown as AutonomyBudget;

/** Budget form fields. Tokens are edited in units of 10,000 (万), which reads naturally in Chinese; the cache-read weight
 * as a percentage. `decimal` fields may hold fractions after scaling. */
export interface BudgetField { key: keyof AutonomyBudget; label: string; hint: string; min: number; max?: number; step: number; scale?: number; decimal?: boolean; advanced?: boolean }
export const budgetFields: BudgetField[] = [
  { key: 'maxWorkers', label: '同时工作的子 Agent', hint: '最多几个子 Agent 同时做各自的任务', min: 1, step: 1 },
  { key: 'maxVms', label: '同时开的虚拟机', hint: '本次运行最多同时占用几台虚拟机；到上限后 Agent 不能再开新的', min: 0, step: 1 },
  { key: 'maxHours', label: '最长运行时间（小时）', hint: '暂停期间不计时；到时间后运行自动暂停', min: 0.5, step: 0.5, decimal: true },
  { key: 'tokenBudget', label: '折算 token 预算（万）', hint: '总 Agent 和全部子 Agent 一共能用多少；缓存读取只按一定比例计算（默认 10%，在「高级」里改）；用完后运行自动暂停', min: 1, step: 1, scale: 10_000 },
  { key: 'maxRounds', label: '总 Agent 最多轮数', hint: '总 Agent 每想一轮算一轮；到上限后运行自动暂停', min: 1, step: 1 },
  { key: 'cacheReadWeight', label: '缓存读取计入预算的比例（%）', hint: '每次调用模型都会把已有的对话重读一遍，这部分叫缓存读取，价格比普通输入便宜得多。填 10 表示按 10% 计入预算，填 100 表示全额计入', min: 0, max: 100, step: 1, scale: 0.01, decimal: true, advanced: true },
  { key: 'maxNudges', label: '催促同一个子 Agent 的次数', hint: '总 Agent 给同一个子 Agent 发消息超过这么多次，就算它卡住了，停下来等你', min: 1, step: 1, advanced: true },
  { key: 'stuckFailures', label: '连续失败几次算卡住', hint: '子 Agent 连续这么多次操作失败，就停下来等你', min: 1, step: 1, advanced: true },
  { key: 'stuckIdleRounds', label: '连续几轮没进展算卡住', hint: '子 Agent 连续这么多轮既没有报告进展也没有完成任务，就停下来等你', min: 1, step: 1, advanced: true },
];
/** The fields a person sees: without software there are no VMs to budget (the server counts the VM limit as 0, and a form
 * still carries the hidden value unchanged). */
export const visibleBudgetFields = (vms: boolean): BudgetField[] => vms ? budgetFields : budgetFields.filter(field => field.key !== 'maxVms');
export const toBudgetForm = (budget: AutonomyBudget): Record<keyof AutonomyBudget, string> =>
  Object.fromEntries(budgetFields.map(field => [field.key, String(Number((budget[field.key] / (field.scale ?? 1)).toFixed(6)))])) as Record<keyof AutonomyBudget, string>;
/** The budget a form describes, or the first field a person has to fix. */
export function fromBudgetForm(form: Record<keyof AutonomyBudget, string>): { budget: AutonomyBudget } | { error: string } {
  const budget = {} as AutonomyBudget;
  for (const field of budgetFields) {
    const text = form[field.key].trim(), value = Number(text);
    if (!text || !Number.isFinite(value) || value < field.min) return { error: `「${field.label}」最小是 ${field.min}` };
    if (field.max !== undefined && value > field.max) return { error: `「${field.label}」最大是 ${field.max}` };
    const scaled = field.decimal ? Number((value * (field.scale ?? 1)).toFixed(6)) : value * (field.scale ?? 1);
    if (!field.decimal && !Number.isInteger(scaled)) return { error: `「${field.label}」要填整数` };
    budget[field.key] = scaled;
  }
  return { budget };
}

const openStates = new Set<RunState>(['running', 'paused', 'waiting-human', 'blocked']);
export const isOpenRun = (state: RunState) => openStates.has(state);
export const canPause = (state: RunState) => state === 'running' || state === 'waiting-human';
export const canResume = (state: RunState) => state === 'paused' || state === 'blocked';

const stateNames: Record<RunState, string> = { running: '运行中', paused: '已暂停', 'waiting-human': '等待你处理', blocked: '受阻', completed: '已完成', stopped: '已停止', failed: '出错停止' };
/** A short state for buttons, chips and the side bar. */
export function runStateLabel(run: Pick<RunSummary, 'state' | 'pauseReason' | 'openAttention'>): string {
  if (isOpenRun(run.state) && run.openAttention > 0) return '等待你处理';
  if (run.state === 'paused' && run.pauseReason?.startsWith('budget-')) return '预算用完';
  return stateNames[run.state] ?? run.state;
}
export type RunTone = 'running' | 'attention' | 'paused' | 'ended';
export function runTone(run: Pick<RunSummary, 'state' | 'openAttention'>): RunTone {
  if (!isOpenRun(run.state)) return 'ended';
  if (run.openAttention > 0 || run.state === 'waiting-human' || run.state === 'blocked') return 'attention';
  return run.state === 'paused' ? 'paused' : 'running';
}
const pauseReasons: Record<string, string> = {
  user: '你暂停了运行。点「继续」接着做。',
  restart: '服务重启过，运行已自动暂停。点「继续」接着做。',
  'budget-tokens': 'Token 预算用完了，运行已暂停。调高预算后点「继续」，或停止运行。',
  'budget-time': '运行时间到上限了，运行已暂停。调高上限后点「继续」，或停止运行。',
  'budget-rounds': '总 Agent 的轮数到上限了，运行已暂停。调高上限后点「继续」，或停止运行。',
  'orchestrator-error': '总 Agent 停了下来（模型调用出错，或它的对话被关闭）。看看总 Agent 的对话，然后点「继续」，或停止运行。',
};
/** One sentence on where the run stands and what the person can do. */
export function runStateDetail(run: Pick<RunSummary, 'state' | 'pauseReason' | 'openAttention'>): string {
  switch (run.state) {
    case 'running': return run.openAttention > 0 ? '有事项需要你处理，与它无关的子 Agent 照常工作。' : 'Agent 正在工作。你可以随时暂停或停止。';
    case 'waiting-human': return '有事项需要你处理，见下方。与它无关的子 Agent 照常工作。';
    case 'paused': return pauseReasons[run.pauseReason ?? ''] ?? '运行已暂停。点「继续」接着做。';
    case 'blocked': return '总 Agent 报告目标受阻，说明见它的对话。处理后点「继续」，或停止运行。';
    case 'completed': return '运行已完成。你可以抽查各个任务，需要改的点「继续修改」。';
    case 'stopped': return '运行已停止。已完成的任务、文件和对话都保留着。';
    case 'failed': return '运行出错停止了。已完成的任务、文件和对话都保留着。';
  }
  return '';
}

const attentionNames: Record<AttentionKind, string> = {
  question: 'Agent 在问你问题', blocked: '需要你动手处理', stuck: '子 Agent 好像卡住了', budget: '预算用完', restart: '服务重启过', incomplete: '总 Agent 认为目标已达成，但还有任务没做完',
};
/** `orchestrator`: the item stands for the orchestrator itself (its chat is the run's orchestrator chat, §12.1). */
export const attentionLabel = (kind: string, orchestrator = false) => kind === 'stuck' && orchestrator ? '总 Agent 停了下来' : attentionNames[kind as AttentionKind] ?? '需要你处理';
/** What each kind of attention offers besides opening its conversation (§5, §12.2). */
export type AttentionChoice =
  | { kind: 'resolve'; action: AttentionAction; label: string; confirm?: true; primary?: true }
  | { kind: 'resume'; label: string } | { kind: 'edit-budget'; label: string };
export function attentionChoices(kind: string, orchestrator = false): AttentionChoice[] {
  switch (kind) {
    case 'blocked': return [{ kind: 'resolve', action: 'resolved', label: '我已处理好', primary: true }, ...orchestrator ? [] : [{ kind: 'resolve', action: 'stop-worker', label: '停止这个子 Agent' } as const]];
    case 'stuck': return orchestrator ? [{ kind: 'resume', label: '继续运行' }]
      : [{ kind: 'resolve', action: 'continue', label: '让它继续', primary: true }, { kind: 'resolve', action: 'stop-worker', label: '停止这个子 Agent' }];
    case 'budget': return [{ kind: 'edit-budget', label: '调整预算' }, { kind: 'resume', label: '继续运行' }];
    case 'restart': return [{ kind: 'resume', label: '继续运行' }];
    case 'incomplete': return [{ kind: 'resolve', action: 'continue', label: '让它继续做', primary: true }, { kind: 'resolve', action: 'accept', label: '接受，结束运行', confirm: true }];
    default: return [];
  }
}
/** The link text for an attention's conversation: questions are answered there. */
export const attentionChatLabel = (kind: string) => kind === 'question' ? '去回答' : kind === 'blocked' ? '打开对话' : '查看对话';

const workerStates: Record<WorkerState, string> = { running: '工作中', idle: '等待指令', 'waiting-human': '等你处理', stopped: '已停止', done: '已结束' };
export const workerStateLabel = (state: string) => workerStates[state as WorkerState] ?? state;
const reportKinds: Record<string, string> = { progress: '进展', blocked: '需要人处理', 'question-for-orchestrator': '请总 Agent 决定' };
export const reportKindLabel = (kind: string) => reportKinds[kind] ?? '报告';
export const chatRoleLabel = (role: ChatRole) => role === 'orchestrator' ? '总 Agent' : '子 Agent';

/** Which tasks have a live worker, for the graph: 'waiting' when that worker waits for a person. */
export function workerActivity(run: Pick<RunDetail, 'state' | 'workers'> | undefined): ReadonlyMap<string, 'working' | 'waiting'> {
  const result = new Map<string, 'working' | 'waiting'>();
  if (!run || !isOpenRun(run.state)) return result;
  for (const worker of run.workers) {
    if (worker.state === 'waiting-human') result.set(worker.taskId, 'waiting');
    else if ((worker.state === 'running' || worker.state === 'idle') && !result.has(worker.taskId)) result.set(worker.taskId, 'working');
  }
  return result;
}

export interface ScopeTask { id: string; parentId?: string; state: string; archived?: boolean; code: string; title: string; rank: number }
/** Tasks of the run's scope that are not completed: the root and all its descendants, or the whole project. */
export function unfinishedInScope<T extends ScopeTask>(tasks: readonly T[], rootTaskId?: string): T[] {
  const children = new Map<string | undefined, T[]>();
  for (const task of tasks) children.set(task.parentId, [...children.get(task.parentId) ?? [], task]);
  const ids = new Set(tasks.map(task => task.id));
  const scope: T[] = [], seen = new Set<string>();
  // An archived task hides its whole branch, as in the graph.
  const visit = (task: T) => { if (seen.has(task.id) || task.archived) return; seen.add(task.id); scope.push(task); for (const child of children.get(task.id) ?? []) visit(child); };
  if (rootTaskId) { const root = tasks.find(task => task.id === rootTaskId); if (root) visit(root); }
  // Roots of the project are tasks whose parent is absent; an orphan (missing parent) still belongs to the project.
  else for (const task of tasks) if (!task.parentId || !ids.has(task.parentId)) visit(task);
  return scope.filter(task => task.state !== 'completed').sort((a, b) => a.code.localeCompare(b.code, 'zh-CN', { numeric: true }) || a.rank - b.rank);
}

/** A source of a user/message event that the autonomy controller or orchestrator wrote, never a person. */
export function autonomySource(source: unknown): { from: 'orchestrator' | 'controller'; runId?: string } | undefined {
  if (!source || typeof source !== 'object') return;
  const value = source as Record<string, unknown>;
  if (value.kind !== 'harnessstudio-autonomy') return;
  return { from: value.from === 'orchestrator' ? 'orchestrator' : 'controller', ...(typeof value.runId === 'string' ? { runId: value.runId } : {}) };
}
export const autonomyMessageLabel = (from: 'orchestrator' | 'controller') => from === 'orchestrator' ? '总 Agent 的指令' : '自主运行通知';
/** The row's own title says who wrote it, so the marker Studio puts in front for the model is left out of the shown text. */
export const autonomyMessageText = (text: string) => text.replace(/^【(?:自主运行通知|总 Agent 的指令)】\n?/u, '');

/** Token counts in 万 / 亿, as people here read them. */
/** `wan` writes small counts in 万 too, so a count beside a budget in 万 reads in the same unit. */
export function formatTokenCount(value: number, wan = false): string {
  if (!Number.isFinite(value) || value < 0) return '—';
  // Only an explicit true: callers also pass this function to map(), which supplies an index here.
  if (value < 10_000) return wan === true ? `${Number((value / 10_000).toFixed(2))} 万` : String(Math.round(value));
  if (value < 100_000_000) { const wan = value / 10_000; return `${wan < 100 ? Number(wan.toFixed(1)) : Math.round(wan)} 万`; }
  return `${Number((value / 100_000_000).toFixed(2))} 亿`;
}
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const minutes = Math.floor(ms / 60_000), hours = Math.floor(minutes / 60);
  if (!minutes) return '不到 1 分钟';
  return hours ? `${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分` : ''}` : `${minutes} 分钟`;
}
export function formatAgo(at: string | undefined, now: number): string {
  const time = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(time)) return '—';
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return new Date(time).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

export interface UsageRow { key: 'tokens' | 'time' | 'rounds' | 'vms' | 'workers'; label: string; used: number; limit: number; percent: number; text: string; warn: boolean; detail?: string }
/** One bar per budget; 80% or more of a limit is called out. Without software (vms false) there is no VM bar. */
export function usageRows(run: Pick<RunDetail, 'usage' | 'settings'>, vms = true): UsageRow[] {
  const { usage } = run, settings = budgetOf(run.settings);
  const row = (key: UsageRow['key'], label: string, used: number, limit: number, text: string): UsageRow => {
    const ratio = limit > 0 ? used / limit : used > 0 ? 1 : 0;
    return { key, label, used, limit, percent: Math.max(0, Math.min(100, ratio * 100)), text, warn: ratio >= 0.8 };
  };
  return [
    { ...row('tokens', '折算 token', usage.tokens, settings.tokenBudget, `${formatTokenCount(usage.tokens, settings.tokenBudget >= 10_000)} / ${formatTokenCount(settings.tokenBudget)}`), ...tokenDetail(usage.tokenBreakdown, settings.cacheReadWeight) },
    row('time', '时长', usage.elapsedMs, settings.maxHours * 3_600_000, `${formatDuration(usage.elapsedMs)} / ${settings.maxHours} 小时`),
    row('rounds', '总 Agent 轮数', usage.rounds, settings.maxRounds, `${usage.rounds} / ${settings.maxRounds} 轮`),
    row('vms', '虚拟机', usage.vms, settings.maxVms, `${usage.vms} / ${settings.maxVms} 台`),
    row('workers', '子 Agent', usage.workers, settings.maxWorkers, `${usage.workers} / ${settings.maxWorkers} 个`),
  ].filter(row => vms || row.key !== 'vms');
}

/** How the weighted count came about, in words: raw counts with cache reads at their weight. */
function tokenDetail(raw: RunDetail['usage']['tokenBreakdown'] | undefined, weight: number): { detail?: string } {
  if (!raw) return {};
  const percent = Number((weight * 100).toFixed(2));
  return { detail: `未缓存输入 ${formatTokenCount(raw.uncachedInput)} · 缓存读取 ${formatTokenCount(raw.cacheRead)}（按 ${percent}% 计 ${formatTokenCount(raw.cacheRead * weight)}）· 缓存写入 ${formatTokenCount(raw.cacheWrite)} · 输出 ${formatTokenCount(raw.output)}` };
}
export const summaryOf = (run: RunSummary): RunSummary => ({ id: run.id, projectId: run.projectId, ...(run.rootTaskId ? { rootTaskId: run.rootTaskId } : {}), objective: run.objective, state: run.state, ...(run.pauseReason ? { pauseReason: run.pauseReason } : {}), createdAt: run.createdAt, startedAt: run.startedAt, ...(run.endedAt ? { endedAt: run.endedAt } : {}), revision: run.revision, openAttention: run.openAttention });
/** The newest run of each project; runs arrive newest first. */
export function latestRuns(runs: readonly RunSummary[]): ReadonlyMap<string, RunSummary> {
  const result = new Map<string, RunSummary>();
  for (const run of runs) if (!result.has(run.projectId)) result.set(run.projectId, run);
  return result;
}
