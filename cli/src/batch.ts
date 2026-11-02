/** The whole batch (cli/设计.md §7.4–7.6): the state file, parallel tasks, interruption and resuming. */
import { mkdir, readFile, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { CommandError } from './args.ts';
import { BUDGET_FIELDS, type Budget, type Issue, type Manifest, type ModelField, type TaskSpec } from './spec.ts';
import { counts, folderName, summaryRows, summaryTable, writeJson, writeSummary, type SummaryRow } from './output.ts';
import type { Progress } from './progress.ts';
import { resolveModel, StudioError, type Catalog, type Studio } from './studio.ts';
import { DEFAULT_TIMINGS, runTask, type Phase, type TaskInput, type Timings } from './task.ts';
import { STATUS_TEXT, formatDuration, formatTokens, oneLine, projectStamp, truncate } from './text.ts';
import { FINISHED, UNFINISHED, type BatchState, type ModelChoice, type PreviousAttempt, type RunDetail, type TaskRecord, type TaskResult } from './types.ts';

const STATE_FILE = 'batch-state.json';

function budgetSettings(budget: Budget): Record<string, number> {
  const settings: Record<string, number> = {};
  for (const [key, field] of Object.entries(BUDGET_FIELDS) as [keyof Budget, typeof BUDGET_FIELDS[keyof Budget]][]) if (budget[key] !== undefined) settings[field.setting] = budget[key];
  return settings;
}
/**
 * The settings each run starts with. Unwritten budget items stay out, so Studio applies its global defaults.
 * Studio has no default for run models: the orchestrator falls back to Studio's default chat model and the worker
 * to the orchestrator's, and a task with neither is an issue like any other.
 */
export function planSettings(tasks: readonly TaskSpec[], models: Catalog): { settings: Map<string, Record<string, unknown>>; issues: Issue[] } {
  const settings = new Map<string, Record<string, unknown>>(), issues: Issue[] = [], reported = new Set<string>();
  const resolve = (field: ModelField, task: TaskSpec): ModelChoice | undefined => {
    const value = resolveModel(field.name, models);
    if (typeof value !== 'string') return value;
    // A bad model in defaults would otherwise repeat once per task.
    const key = `${field.line}:${field.name}`;
    if (!reported.has(key)) { reported.add(key); issues.push({ ...field.line === undefined ? {} : { line: field.line }, ...field.line === undefined ? { task: task.name } : {}, message: value }); }
    return undefined;
  };
  for (const task of tasks) {
    const orchestrator = task.orchestratorModel ? resolve(task.orchestratorModel, task) : models.defaults;
    if (!task.orchestratorModel && !orchestrator) issues.push({ task: task.name, ...task.line === undefined ? {} : { line: task.line }, message: '没有写 orchestratorModel（总 Agent 模型），Studio 也没有默认模型。请在 defaults 或这个任务里写上' });
    const worker = task.workerModel ? resolve(task.workerModel, task) : orchestrator;
    const others = task.workerModels.map(field => resolve(field, task));
    if (orchestrator && worker && others.every(Boolean)) settings.set(task.name, { orchestratorModel: orchestrator, workerModel: worker, ...others.length ? { workerModels: others } : {}, ...budgetSettings(task.budget) });
  }
  return { settings, issues };
}

export async function prepareNew(directory: string, manifest: Manifest, studioUrl: string, noVideo: boolean): Promise<BatchState> {
  try {
    await mkdir(directory, { recursive: true });
    const existing = await readdir(directory);
    if (existing.includes(STATE_FILE)) throw new CommandError(`${directory} 里已经有上次的结果。要接着跑请用 --resume ${directory}，要重新跑请换一个文件夹`);
    if (existing.length) throw new CommandError(`输出文件夹 ${directory} 不是空的，请换一个文件夹`);
  } catch (error) {
    if (error instanceof CommandError) throw error;
    throw new CommandError(`没法使用输出文件夹 ${directory}：${(error as Error).message}`);
  }
  const taken = new Set<string>(), time = new Date().toISOString();
  const tasks = manifest.tasks.map((task): TaskRecord => { const folder = folderName(task.name, taken); taken.add(folder); return { name: task.name, folder, status: 'pending' }; });
  return { version: 1, manifest: { path: manifest.path, sha256: manifest.sha256 }, studioUrl, noVideo, startedAt: time, updatedAt: time, tasks };
}

export async function readState(directory: string): Promise<BatchState> {
  let text: string;
  try { text = await readFile(join(directory, STATE_FILE), 'utf8'); }
  catch { throw new CommandError(`${directory} 里没有 ${STATE_FILE}，它不是批量命令的输出文件夹`); }
  let state: BatchState;
  try { state = JSON.parse(text) as BatchState; } catch { throw new CommandError(`${join(directory, STATE_FILE)} 已损坏，没法续跑`); }
  if (state.version !== 1 || !Array.isArray(state.tasks) || typeof state.manifest?.path !== 'string') throw new CommandError(`${join(directory, STATE_FILE)} 的格式不认识，没法续跑`);
  return state;
}
const moveIfPresent = async (from: string, to: string) => {
  try { await rename(from, to); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
};

export interface ResumePlan { state: BatchState; attach: Map<string, NonNullable<TaskInput['attach']>>; earlier: Set<string>; notes: string[] }
/**
 * Finished tasks are skipped; interrupted and unstarted ones run again in a new project (§7.6). A task still marked
 * running means the previous client was killed: its run is picked up if it is alive or done, since starting over would
 * throw hours of work and tokens away, and otherwise it runs again like an interrupted one.
 */
export async function prepareResume(directory: string, state: BatchState, manifest: Manifest, studio: Studio): Promise<ResumePlan> {
  const notes: string[] = [], attach: ResumePlan['attach'] = new Map(), earlier = new Set<string>();
  if (state.manifest.sha256 !== manifest.sha256) notes.push('任务清单和上次不一样了：已经跑完的任务按名字跳过，其余任务按现在的清单跑。');
  if (state.studioUrl !== studio.base) notes.push(`上次连的是 ${state.studioUrl}，这次是 ${studio.base}：上次的项目还在原来那台上。`);
  const old = new Map(state.tasks.map(record => [record.name, record])), taken = new Set(state.tasks.map(record => record.folder));
  const tasks: TaskRecord[] = [];
  for (const spec of manifest.tasks) {
    const record = old.get(spec.name);
    if (!record) { const folder = folderName(spec.name, taken); taken.add(folder); tasks.push({ name: spec.name, folder, status: 'pending' }); continue; }
    if (FINISHED.includes(record.status)) { tasks.push(record); earlier.add(record.name); continue; }
    if (record.status === 'running' && record.runId && record.projectId) {
      const run = await studio.run(record.runId).catch((error: unknown) => { if (error instanceof StudioError) return undefined; throw error; });
      if (run && (UNFINISHED.includes(run.state) || run.state === 'completed')) {
        attach.set(record.name, { projectId: record.projectId, runId: record.runId, ...record.startedAt ? { startedAt: record.startedAt } : {} });
        notes.push(`任务「${record.name}」上次的运行还在，接着跟踪它。`);
        tasks.push({ ...record }); continue;
      }
    }
    const attempts: PreviousAttempt[] = [...record.previousAttempts ?? []];
    if (record.projectId) {
      const folder = join('attempts', String(attempts.length + 1)), target = join(directory, record.folder, folder);
      await mkdir(target, { recursive: true });
      for (const file of ['result.json', 'trajectory.zip']) await moveIfPresent(join(directory, record.folder, file), join(target, file));
      attempts.push({ projectId: record.projectId, ...record.projectUrl ? { projectUrl: record.projectUrl } : {}, ...record.runId ? { runId: record.runId } : {}, status: record.status === 'running' ? 'interrupted' : record.status, ...record.reason ? { reason: record.reason } : {}, folder });
    }
    tasks.push({ name: record.name, folder: record.folder, status: 'pending', ...attempts.length ? { previousAttempts: attempts } : {} });
  }
  const names = new Set(manifest.tasks.map(task => task.name));
  for (const record of state.tasks) {
    if (names.has(record.name)) continue;
    if (FINISHED.includes(record.status)) { tasks.push(record); earlier.add(record.name); notes.push(`任务「${record.name}」已经不在清单里，保留它上次的结果。`); }
    else notes.push(`任务「${record.name}」已经不在清单里，不再运行。`);
  }
  return { state: { ...state, manifest: { path: manifest.path, sha256: manifest.sha256 }, studioUrl: studio.base, tasks }, attach, earlier, notes };
}

/** Saves run one after another, so an older state can never land after a newer one. */
class StateFile {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly state: BatchState;
  private readonly directory: string;
  constructor(state: BatchState, directory: string) { this.state = state; this.directory = directory; }
  save(): Promise<void> {
    const saving = this.chain.catch(() => undefined).then(() => { this.state.updatedAt = new Date().toISOString(); return writeJson(join(this.directory, STATE_FILE), this.state); });
    this.chain = saving;
    return saving;
  }
}

const PHASE_TEXT: Record<Phase, string> = { creating: '建项目', uploading: '上传文件', starting: '启动运行', running: '运行中', stopping: '正在停止', exporting: '导出轨迹' };
function phaseText(phase: Phase, run: RunDetail | undefined): string {
  if (phase !== 'running' || !run) return PHASE_TEXT[phase];
  // A person paused it on the page: the batch waits, and says so, since the task keeps its slot meanwhile.
  if (run.state === 'paused') return run.pauseReason === 'user' ? '已被人暂停，在等待' : '已暂停';
  return run.state === 'waiting-human' ? '等待处理' : run.state === 'blocked' ? '受阻' : '运行中';
}
const ACTIVE_WORKERS = new Set(['running', 'idle', 'waiting-human']);
/**
 * The line a finished task leaves on screen. Export notes stay in result.json: the export can list up to 200 sentences
 * (one per model call cut short), which would bury the batch's output. A missing trajectory is said here.
 */
export function finishLine(result: TaskResult): string {
  const name = oneLine(result.name), facts = `用时 ${formatDuration(result.elapsedMs)}，折算 ${formatTokens(result.usage.weightedTokens)} token`, notes = result.trajectory.warnings;
  const warning = !notes.length ? '' : result.trajectory.file ? `；导出包里有 ${notes.length} 条说明，见 result.json` : `；轨迹没有导出：${truncate(oneLine(notes.find(row => row.startsWith('导出轨迹失败')) ?? notes[0]!), 120)}`;
  return result.status === 'completed' ? `✔ ${name}：完成（${facts}）${warning}` : `${result.status === 'failed' ? '✖' : result.status === 'interrupted' ? '■' : '!'} ${name}：${STATUS_TEXT[result.status]}（${facts}）——${oneLine(result.reason)}${warning}`;
}

export interface BatchInput {
  studio: Studio; publicBase: string; manifest: Manifest; settings: ReadonlyMap<string, Record<string, unknown>>; directory: string; state: BatchState;
  noVideo: boolean; parallel: number; interrupt: AbortSignal; progress: Progress; timings?: Timings;
  /** status.softwareBackend: how the objective names the shared folder. */
  softwareBackend?: string;
  attach?: ResumePlan['attach']; earlier?: ReadonlySet<string>;
}
export interface BatchOutcome { rows: SummaryRow[]; interrupted: boolean; table: string; code: number }
export const exitCode = (rows: readonly { status: string }[], interrupted: boolean) => interrupted ? 130 : rows.some(row => row.status !== 'completed') ? 2 : 0;

export function batchHeader(records: readonly TaskRecord[]): string {
  const count = counts(records), parts = [`完成 ${count.completed}`];
  for (const [status, label] of [['needs-human', '需要人'], ['failed', '失败'], ['interrupted', '已中断']] as const) if (count[status]) parts.push(`${label} ${count[status]}`);
  return `共 ${records.length} 个任务：${[...parts, `运行中 ${count.running}`, `排队 ${count.pending}`].join('，')}`;
}

export async function runBatch(input: BatchInput): Promise<BatchOutcome> {
  const { state, directory, progress, interrupt, manifest } = input, startedAt = new Date().toISOString();
  const file = new StateFile(state, directory), specs = new Map(manifest.tasks.map(spec => [spec.name, spec]));
  const queue = state.tasks.filter(record => specs.has(record.name) && !FINISHED.includes(record.status));
  await file.save();
  const runOne = async (record: TaskRecord) => {
    const spec = specs.get(record.name)!, attach = input.attach?.get(record.name), began = Date.now();
    Object.assign(record, { status: 'running', startedAt: attach?.startedAt ?? new Date().toISOString() });
    delete record.reason; delete record.endedAt; delete record.elapsedMs; delete record.weightedTokens;
    if (!attach) { delete record.projectId; delete record.projectUrl; delete record.runId; }
    await file.save();
    const label = truncate(oneLine(record.name), 24);
    let result: TaskResult;
    try {
      result = await runTask({ studio: input.studio, publicBase: input.publicBase, noVideo: input.noVideo, timings: input.timings ?? DEFAULT_TIMINGS, interrupt, ...input.softwareBackend ? { softwareBackend: input.softwareBackend } : {} }, {
        spec, settings: input.settings.get(record.name)!, projectTitle: `${manifest.projectPrefix} ${projectStamp(new Date())} · ${record.name}`, folder: join(directory, record.folder),
        ...record.previousAttempts?.length ? { previousAttempts: record.previousAttempts } : {}, ...attach ? { attach } : {},
      }, {
        // Awaited: a killed client must find the run it started in the state file (prepareResume).
        record(change) { Object.assign(record, change); return file.save(); },
        progress(phase, run) {
          const text = phaseText(phase, run), facts = [formatDuration(Date.now() - began), ...run ? [`折算 ${formatTokens(run.usage.tokens)} token`, `子 Agent ${run.workers.filter(worker => ACTIVE_WORKERS.has(worker.state)).length} 个在做（共 ${run.workers.length} 个）`] : []];
          progress.set(record.name, `  ${label}  ${text}  ${facts.join('  ')}`, text);
        },
        log(text) { progress.log(`  ${oneLine(record.name)}：${text}`); },
      });
    } catch (error) {
      // runTask reports task failures itself, so this is the output folder failing (for example a full disk).
      const reason = `写结果文件失败：${error instanceof Error ? error.message : String(error)}`;
      const time = new Date().toISOString();
      result = { name: record.name, status: 'failed', reason, ...record.projectId ? { projectId: record.projectId } : {}, ...record.projectUrl ? { projectUrl: record.projectUrl } : {}, ...record.runId ? { runId: record.runId } : {}, startedAt: record.startedAt!, endedAt: time, elapsedMs: Date.now() - began, usage: { weightedTokens: 0, tokenBreakdown: { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, rounds: 0 }, tasks: [], autoAnswers: [], trajectory: { file: null, bytes: 0, warnings: [] } };
    }
    Object.assign(record, { status: result.status, endedAt: result.endedAt, elapsedMs: result.elapsedMs, weightedTokens: result.usage.weightedTokens, ...result.reason ? { reason: result.reason } : {} });
    progress.remove(record.name);
    progress.log(finishLine(result));
    await file.save();
  };
  await Promise.all(Array.from({ length: Math.min(input.parallel, Math.max(queue.length, 1)) }, async () => {
    while (!interrupt.aborted) { const record = queue.shift(); if (!record) return; await runOne(record); }
  }));
  await file.save();
  const interrupted = interrupt.aborted, rows = summaryRows(state.tasks, input.earlier);
  await writeSummary(directory, { startedAt: state.startedAt ?? startedAt, endedAt: new Date().toISOString(), studioUrl: state.studioUrl, manifest: manifest.path, interrupted, rows });
  return { rows, interrupted, table: summaryTable(rows), code: exitCode(rows, interrupted) };
}
