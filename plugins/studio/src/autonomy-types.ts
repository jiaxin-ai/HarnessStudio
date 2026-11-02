/** Autonomy run contract shared by the backend and the page (设计.md §3, §5, §6, §8). Browser-safe: no DSH imports. */

export type AutonomyRole = 'orchestrator' | 'worker';
export type RunState = 'running' | 'paused' | 'waiting-human' | 'blocked' | 'completed' | 'stopped' | 'failed';
/** user, restart, budget-tokens, budget-time, budget-rounds, orchestrator-error. */
export type PauseReason = 'user' | 'restart' | 'budget-tokens' | 'budget-time' | 'budget-rounds' | 'orchestrator-error';
export type AttentionKind = 'question' | 'blocked' | 'stuck' | 'budget' | 'restart' | 'incomplete';
export type AttentionAction = 'resolved' | 'continue' | 'stop-worker' | 'accept';
export type WorkerState = 'running' | 'idle' | 'waiting-human' | 'stopped' | 'done';
export type WorkerReportKind = 'progress' | 'blocked' | 'question-for-orchestrator';
/** Events studio_autonomy_wait returns to the orchestrator. */
export const WAIT_EVENT_TYPES = ['worker-settled', 'worker-reported', 'task-completed', 'worker-failed', 'attention-opened', 'attention-resolved', 'human-edit', 'budget-warning', 'resumed'] as const;
export type WaitEventType = typeof WAIT_EVENT_TYPES[number];
/** Run states that still hold the project's single run slot. */
export const UNFINISHED_STATES: readonly RunState[] = ['running', 'paused', 'waiting-human', 'blocked'];

export interface ModelChoice { provider: string; model: string }
export interface AutonomySettings {
  /** tokenBudget counts weighted tokens: uncached input + cache writes + output + cache reads × cacheReadWeight. */
  maxWorkers: number; maxVms: number; maxHours: number; tokenBudget: number; cacheReadWeight: number; maxRounds: number;
  maxNudges: number; stuckFailures: number; stuckIdleRounds: number;
  orchestratorModel?: ModelChoice; workerModel?: ModelChoice; workerModels: ModelChoice[];
}
export const DEFAULT_AUTONOMY_SETTINGS: AutonomySettings = {
  maxWorkers: 3, maxVms: 2, maxHours: 8, tokenBudget: 20_000_000, cacheReadWeight: 0.1, maxRounds: 200,
  maxNudges: 10, stuckFailures: 5, stuckIdleRounds: 3, workerModels: [],
};

/** Raw token counts of a run's conversations, before cache reads are weighted. */
export interface TokenBreakdown { uncachedInput: number; cacheRead: number; cacheWrite: number; output: number }
/** Weighted tokens: what the token budget counts. Cache reads are cheap and reread the whole context on every call. */
export function weightedTokens(usage: TokenBreakdown, cacheReadWeight: number): number {
  return Math.round(usage.uncachedInput + usage.cacheWrite + usage.output + usage.cacheRead * cacheReadWeight);
}
export interface RunSummary {
  id: string; projectId: string; rootTaskId?: string; objective: string; state: RunState; pauseReason?: PauseReason;
  createdAt: string; startedAt: string; endedAt?: string; revision: number;
  /** Unresolved human-attention items, so the side bar can show 「待处理 N」 without a detail request per project. */
  openAttention: number;
}
export interface RunWorker {
  chatId: string; taskId: string; code: string; title: string; provider: string; model: string; state: WorkerState; nudges: number;
  lastReport?: { kind: WorkerReportKind; message: string; at: string }; lastActivityAt?: string;
}
export interface RunAttention { id: string; kind: AttentionKind; chatId?: string; taskId?: string; message: string; since: string; resolvedAt?: string }
export interface RunEvent { at: string; type: string; summary: string; chatId?: string; taskId?: string }
export interface RunDetail extends RunSummary {
  settings: AutonomySettings;
  orchestratorChatId: string;
  /** tokens is weighted (see weightedTokens); tokenBreakdown sums the raw counts it was computed from. */
  usage: { tokens: number; tokenBreakdown: TokenBreakdown; elapsedMs: number; rounds: number; vms: number; workers: number };
  workers: RunWorker[];
  attention: RunAttention[];
  /** The latest 50, newest first. Their summary is the text written for people (设计.md §12.6), not the orchestrator's. */
  events: RunEvent[];
}

/** One run as the project export writes it to autonomy/<runId>/run.json (cli/设计.md §10). Unlike RunDetail: every event
 * and attention item, oldest first, with what was stored. */
export interface AutonomyRunExport {
  format: 'harnessstudio-autonomy-run/1';
  id: string; projectId: string; rootTaskId?: string; objective: string; state: RunState; pauseReason?: PauseReason;
  createdAt: string; startedAt: string; endedAt?: string;
  orchestratorChatId: string;
  /** Budgets, models and cacheReadWeight as they stood last. */
  settings: AutonomySettings;
  usage: {
    /** What tokenBudget counts: uncachedInput + cacheWrite + output + cacheRead × cacheReadWeight. */
    weightedTokens: number;
    tokenBreakdown: TokenBreakdown;
    /** Raw counts per conversation. A number is an already weighted total stored before the counts were kept apart. */
    byChat: Record<string, TokenBreakdown | number>;
    /** Running time without pauses. */
    elapsedMs: number;
    /** Orchestrator rounds, across the goals of 「让它继续做」. */
    rounds: number;
  };
  workers: {
    chatId: string; taskId: string; code: string; title: string; provider: string; model: string;
    /** active: still holds its task and a slot; stopped: released it; done: its task is complete. */
    state: 'active' | 'stopped' | 'done'; stopReason?: string;
    /** Messages from the orchestrator, consecutive failed tool calls, turns in a row without progress. */
    nudges: number; failures: number; idleRounds: number;
    /** Its latest report; every report is a worker-reported event. */
    lastReport?: { kind: WorkerReportKind; message: string; at: string }; lastActivityAt?: string; createdAt: string;
  }[];
  attention: {
    id: string; kind: AttentionKind; chatId?: string; taskId?: string; message: string; since: string;
    resolvedAt?: string;
    /** How it was handled: a person's action (resolved, continue, stop-worker, accept), or what closed it (answered, replied, resumed, stopped). */
    resolution?: AttentionAction | 'answered' | 'replied' | 'resumed' | 'stopped';
    callId?: string; cause?: 'failures' | 'idle' | 'nudges' | 'orchestrator';
  }[];
  /** summary is what the orchestrator read; page, when present, what the run panel showed. deliver: studio_autonomy_wait returns it. */
  events: { seq: number; at: string; type: string; summary: string; page?: string; chatId?: string; taskId?: string; deliver: boolean; data?: Record<string, unknown> }[];
}
/** What the project export reads from the autonomy plugin (read-only); its storage stays the plugin's own. */
export interface AutonomyExportSource { exportRuns(projectId: string): AutonomyRunExport[] }
