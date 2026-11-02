/** Autonomy run storage: <studio data>/autonomy.sqlite for runs, workers, attention and events, and
 * <studio data>/autonomy-settings.json for the global defaults. Run data stays out of domain.sqlite (设计.md §3.1).
 * node:sqlite is synchronous, so every read-modify-write below completes without interleaving. */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_AUTONOMY_SETTINGS, UNFINISHED_STATES, weightedTokens,
  type AttentionAction, type AttentionKind, type AutonomySettings, type ModelChoice, type PauseReason, type RunState, type TokenBreakdown, type WorkerReportKind,
} from './autonomy-types.ts';

export interface StoredRun {
  id: string; projectId: string; rootTaskId?: string; objective: string; state: RunState; pauseReason?: PauseReason;
  settings: AutonomySettings; orchestratorChatId: string; revision: number;
  createdAt: string; startedAt: string; endedAt?: string;
  usage: { tokens: number; elapsedMs: number; rounds: number };
  /** Start of the current active stretch (running or waiting-human); elapsed time stops while paused. */
  activeSince?: string;
  /** Rounds of earlier goals of this run: 「让它继续做」 replaces a completed goal and its count restarts at 0. */
  priorRounds: number;
  /** Raw token counts of each run conversation, so the run total is a sum without double counting and a changed
   * cacheReadWeight applies at once. A number is a total stored before the counts were kept apart (already final). */
  chatTokens: Record<string, TokenBreakdown | number>;
  /** Last event seq studio_autonomy_wait returned. */
  waitCursor: number;
  /** Budgets already warned at 80%. */
  warned: string[];
  /** What the controller last saw of the project, to notice people's edits and completions. */
  watch: { projectRevision: number; activitySeq: number; completed: string[] };
}
export interface StoredWorker {
  chatId: string; runId: string; taskId: string; provider: string; model: string;
  /** active until its task is done or it is stopped; stopped frees its task and its slot. */
  state: 'active' | 'stopped' | 'done';
  nudges: number; failures: number; idleRounds: number;
  /** A report or completion since its last turn ended: that turn was not idle. */
  progressed: boolean;
  lastReport?: { kind: WorkerReportKind; message: string; at: string }; lastActivityAt?: string; createdAt: string; stopReason?: string;
}
export interface StoredAttention {
  id: string; runId: string; kind: AttentionKind; chatId?: string; taskId?: string; message: string; since: string;
  resolvedAt?: string; resolution?: AttentionAction | 'answered' | 'replied' | 'resumed' | 'stopped';
  /** question: the ask_user_question call it stands for. */
  callId?: string;
  /** stuck: what tripped it, so its counter is reset when it is resolved. */
  cause?: 'failures' | 'idle' | 'nudges' | 'orchestrator';
  /** incomplete: the orchestrator's final reply is appended when its turn ends. */
  awaitingSummary?: boolean;
}
/** summary is written for the orchestrator (studio_autonomy_wait returns it); page, when given, is the text the run panel shows. */
export interface StoredEvent { seq: number; runId: string; at: string; type: string; summary: string; page?: string; chatId?: string; taskId?: string; deliver: boolean; data?: Record<string, unknown> }

export const isUnfinished = (state: RunState) => UNFINISHED_STATES.includes(state);
const EMPTY_TOKENS: TokenBreakdown = { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
/** Sum of the raw counts; totals kept from before the split have no breakdown and are left out. */
export function tokenBreakdown(chats: StoredRun['chatTokens']): TokenBreakdown {
  const sum = { ...EMPTY_TOKENS };
  for (const value of Object.values(chats)) if (typeof value === 'object') for (const key of Object.keys(sum) as (keyof TokenBreakdown)[]) sum[key] += value[key];
  return sum;
}
/** The run's weighted total: each conversation's counts weighted, plus totals kept from before the split. */
export function runTokens(chats: StoredRun['chatTokens'], cacheReadWeight: number): number {
  return Object.values(chats).reduce<number>((total, value) => total + (typeof value === 'number' ? value : weightedTokens(value, cacheReadWeight)), 0);
}
/** Runs and settings written before cacheReadWeight existed count cache reads at the default weight. */
function readRun(text: string): StoredRun {
  const run = JSON.parse(text) as StoredRun;
  if (typeof run.settings.cacheReadWeight !== 'number') run.settings.cacheReadWeight = DEFAULT_AUTONOMY_SETTINGS.cacheReadWeight;
  return run;
}
export const now = () => new Date().toISOString();

export class AutonomyStore {
  private db!: DatabaseSync;
  constructor(private readonly path: string) {}
  initialize(): void {
    this.db = new DatabaseSync(this.path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, created_at TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS runs_project ON runs(project_id, created_at);
      CREATE TABLE IF NOT EXISTS workers(chat_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS workers_run ON workers(run_id);
      CREATE TABLE IF NOT EXISTS attention(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS attention_run ON attention(run_id);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_run ON events(run_id, seq);`);
  }
  close(): void { this.db?.close(); }
  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  run(id: string): StoredRun {
    const row = this.db.prepare('SELECT value FROM runs WHERE id=?').get(id);
    if (!row) throw new Error('自主运行不存在');
    return readRun(String(row.value));
  }
  findRun(id: string): StoredRun | undefined { try { return this.run(id); } catch { return undefined; } }
  /** Newest first. */
  runs(projectId?: string): StoredRun[] {
    const rows = projectId ? this.db.prepare('SELECT value FROM runs WHERE project_id=? ORDER BY created_at DESC, rowid DESC').all(projectId)
      : this.db.prepare('SELECT value FROM runs ORDER BY created_at DESC, rowid DESC').all();
    return rows.map(row => readRun(String(row.value)));
  }
  unfinished(projectId?: string): StoredRun[] { return this.runs(projectId).filter(run => isUnfinished(run.state)); }
  insertRun(run: StoredRun): void {
    this.transaction(() => {
      if (this.unfinished(run.projectId).length) throw new Error('这个项目已有一个未结束的自主运行，请先停止它');
      this.db.prepare('INSERT INTO runs VALUES(?,?,?,?)').run(run.id, run.projectId, run.createdAt, JSON.stringify(run));
    });
  }
  /** Changes one run atomically. With `revision` a stale page is refused; `bump` increments the revision (state, objective,
   * settings and attention changes do; usage counters do not, so a page's revision stays valid while Agents work). */
  updateRun(id: string, change: (run: StoredRun) => void, options: { revision?: unknown; bump?: boolean } = {}): StoredRun {
    return this.transaction(() => {
      const run = this.run(id);
      if (options.revision !== undefined && options.revision !== run.revision) throw new Error('自主运行已变化，请刷新后重试');
      change(run);
      if (options.bump) run.revision++;
      this.db.prepare('UPDATE runs SET value=? WHERE id=?').run(JSON.stringify(run), id);
      return run;
    });
  }

  workers(runId: string): StoredWorker[] { return this.db.prepare('SELECT value FROM workers WHERE run_id=? ORDER BY rowid').all(runId).map(row => JSON.parse(String(row.value))); }
  worker(chatId: string): StoredWorker | undefined { const row = this.db.prepare('SELECT value FROM workers WHERE chat_id=?').get(chatId); return row ? JSON.parse(String(row.value)) : undefined; }
  putWorker(worker: StoredWorker): void { this.db.prepare('INSERT INTO workers VALUES(?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET value=excluded.value').run(worker.chatId, worker.runId, worker.taskId, JSON.stringify(worker)); }
  updateWorker(chatId: string, change: (worker: StoredWorker) => void): StoredWorker {
    return this.transaction(() => { const worker = this.worker(chatId); if (!worker) throw new Error('子 Agent 不存在'); change(worker); this.putWorker(worker); return worker; });
  }

  attention(runId: string): StoredAttention[] { return this.db.prepare('SELECT value FROM attention WHERE run_id=? ORDER BY rowid').all(runId).map(row => JSON.parse(String(row.value))); }
  openAttention(runId: string): StoredAttention[] { return this.attention(runId).filter(item => !item.resolvedAt); }
  putAttention(item: StoredAttention): void { this.db.prepare('INSERT INTO attention VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(item.id, item.runId, JSON.stringify(item)); }

  addEvent(event: Omit<StoredEvent, 'seq'>): StoredEvent {
    const result = this.db.prepare('INSERT INTO events(run_id, value) VALUES(?,?)').run(event.runId, JSON.stringify(event));
    return { ...event, seq: Number(result.lastInsertRowid) };
  }
  /** Events after a seq, oldest first. */
  events(runId: string, afterSeq = 0, limit = 500): StoredEvent[] {
    return this.db.prepare('SELECT seq, value FROM events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?').all(runId, afterSeq, limit).map(row => ({ ...JSON.parse(String(row.value)), seq: Number(row.seq) }));
  }
  latestEvents(runId: string, limit = 50): StoredEvent[] {
    return this.db.prepare('SELECT seq, value FROM events WHERE run_id=? ORDER BY seq DESC LIMIT ?').all(runId, limit).map(row => ({ ...JSON.parse(String(row.value)), seq: Number(row.seq) }));
  }
  lastEventSeq(runId: string): number { const row = this.db.prepare('SELECT MAX(seq) AS seq FROM events WHERE run_id=?').get(runId); return Number(row?.seq ?? 0); }
}

const SETTING_KEYS = ['maxWorkers', 'maxVms', 'maxHours', 'tokenBudget', 'cacheReadWeight', 'maxRounds', 'maxNudges', 'stuckFailures', 'stuckIdleRounds', 'orchestratorModel', 'workerModel', 'workerModels'] as const;
const LIMITS: Record<string, [label: string, min: number, max: number, integer: boolean]> = {
  maxWorkers: ['同时工作的子 Agent 数', 1, 20, true], maxVms: ['同时占用的虚拟机数', 0, 20, true], maxHours: ['运行总时长（小时）', 0.1, 720, false],
  tokenBudget: ['折算 token 预算', 10_000, 100_000_000_000, true], cacheReadWeight: ['缓存读取的折算系数', 0, 1, false], maxRounds: ['总 Agent 的轮数上限', 1, 100_000, true], maxNudges: ['催促同一个子 Agent 的次数上限', 1, 1000, true],
  stuckFailures: ['判定卡住的连续失败次数', 1, 1000, true], stuckIdleRounds: ['判定卡住的无进展轮数', 1, 1000, true],
};
function modelChoice(value: unknown, label: string): ModelChoice {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}须为 {provider, model}`);
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(key => key !== 'provider' && key !== 'model') || typeof data.provider !== 'string' || !data.provider || typeof data.model !== 'string' || !data.model
    || data.provider.length > 200 || data.model.length > 200) throw new Error(`${label}须为 {provider, model}`);
  return { provider: data.provider, model: data.model };
}
/** Validates a settings object or a partial change of one (only known fields). A null model removes that default. */
export function settingsChange(value: unknown): Partial<AutonomySettings> & { orchestratorModel?: ModelChoice | null; workerModel?: ModelChoice | null } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('自主模式设置须为对象');
  const data = value as Record<string, unknown>, extra = Object.keys(data).find(key => !(SETTING_KEYS as readonly string[]).includes(key));
  if (extra) throw new Error(`不支持的设置字段：${extra}`);
  const result: Record<string, unknown> = {};
  for (const [key, [label, min, max, integer]] of Object.entries(LIMITS)) {
    if (data[key] === undefined) continue;
    const item = data[key];
    if (typeof item !== 'number' || !Number.isFinite(item) || item < min || item > max || integer && !Number.isInteger(item)) throw new Error(`${label}须在 ${min}–${max} 之间${integer ? '，且为整数' : ''}`);
    result[key] = item;
  }
  for (const key of ['orchestratorModel', 'workerModel'] as const) if (data[key] !== undefined) result[key] = data[key] === null ? null : modelChoice(data[key], key === 'orchestratorModel' ? '总 Agent 模型' : '子 Agent 模型');
  if (data.workerModels !== undefined) {
    if (!Array.isArray(data.workerModels) || data.workerModels.length > 20) throw new Error('其他子 Agent 模型须为最多 20 项的列表');
    const models = data.workerModels.map(item => modelChoice(item, '其他子 Agent 模型'));
    result.workerModels = [...new Map(models.map(model => [`${model.provider}/${model.model}`, model])).values()];
  }
  return result as ReturnType<typeof settingsChange>;
}
export function applySettings(base: AutonomySettings, change: ReturnType<typeof settingsChange>): AutonomySettings {
  const next: AutonomySettings = { ...base, ...change } as AutonomySettings;
  for (const key of ['orchestratorModel', 'workerModel'] as const) if ((change as Record<string, unknown>)[key] === null) delete next[key];
  return next;
}

/** autonomy-settings.json, like sandbox-settings.json: missing means the defaults; a page saving an old revision is refused.
 * Not the DSH settings service, whose first save would copy the entry into the profile (docs/sandbox.md 「资源和回收」). */
export class AutonomySettingsStore {
  private value: AutonomySettings = structuredClone(DEFAULT_AUTONOMY_SETTINGS);
  private revision = 0;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string) {}
  static at(dataRoot: string) { return new AutonomySettingsStore(join(dataRoot, 'autonomy-settings.json')); }
  async load(): Promise<string | undefined> {
    let text: string;
    try { text = await readFile(this.path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    try {
      const data = JSON.parse(text) as { settings?: unknown; revision?: unknown };
      this.value = applySettings(structuredClone(DEFAULT_AUTONOMY_SETTINGS), settingsChange(data.settings ?? {}));
      this.revision = Number.isSafeInteger(data.revision) ? Number(data.revision) : 0;
    } catch (error) { return `${this.path} is invalid (${error instanceof Error ? error.message : String(error)}); using the defaults until the settings are saved again`; }
  }
  get(): { settings: AutonomySettings; revision: number } { return { settings: structuredClone(this.value), revision: this.revision }; }
  save(revision: unknown, change: unknown, validate: (settings: AutonomySettings) => Promise<void> = async () => {}): Promise<{ settings: AutonomySettings; revision: number }> {
    const run = this.writes.then(async () => {
      if (revision !== this.revision) throw new Error('自主模式默认设置已被修改，请刷新后再保存');
      const settings = applySettings(this.value, settingsChange(change));
      await validate(settings);
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, JSON.stringify({ settings, revision: this.revision + 1 }, null, 2) + '\n', { mode: 0o600 }); await rename(temporary, this.path); }
      finally { await rm(temporary, { force: true }); }
      this.value = settings; this.revision++;
      return this.get();
    });
    this.writes = run.catch(() => undefined);
    return run;
  }
}
