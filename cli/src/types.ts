/**
 * What this client reads from Studio's HTTP API, plus the files it writes. Written by hand from
 * plugins/studio/src/autonomy-types.ts and questions-types.ts: the client never imports Studio source.
 */
export type RunState = 'running' | 'paused' | 'waiting-human' | 'blocked' | 'completed' | 'stopped' | 'failed';
export type AttentionKind = 'question' | 'blocked' | 'stuck' | 'budget' | 'restart' | 'incomplete';
export const UNFINISHED: readonly RunState[] = ['running', 'paused', 'waiting-human', 'blocked'];

export interface ModelChoice { provider: string; model: string }
export interface TokenBreakdown { uncachedInput: number; cacheRead: number; cacheWrite: number; output: number }
export interface RunAttention { id: string; kind: AttentionKind; chatId?: string; taskId?: string; message: string; since: string; resolvedAt?: string }
export interface RunWorker { chatId: string; taskId: string; state: string }
export interface RunEvent { at: string; type: string; summary: string }
export interface RunDetail {
  id: string; projectId: string; state: RunState; pauseReason?: string; revision: number; orchestratorChatId: string;
  usage: { tokens: number; tokenBreakdown: TokenBreakdown; elapsedMs: number; rounds: number };
  workers: RunWorker[]; attention: RunAttention[]; events: RunEvent[];
}

export interface Question { id: string; question: string; header?: string; options?: { label: string }[]; multiSelect?: boolean; intent?: { kind: string } }
export interface PendingQuestion { callId: string; state: 'open' | 'continued'; questions: Question[]; canAnswer: boolean; replyQueued?: boolean }
export interface QuestionView { id: string; pending: PendingQuestion[] }

export interface Project { id: string; title: string }
export interface GraphTask { code: string; title: string; state: string; completedBy?: 'human' | 'agent'; archived?: boolean }
export interface ModelsView {
  providers: { id: string; name: string; credentialConfigured?: boolean; models: { id: string }[] }[];
  defaults: { provider: string; model: string };
}
export interface StatusView { providers: { id: string }[]; softwareBackend?: string; chats?: { id: string; runId?: string; status?: string }[] }

export type TaskStatus = 'completed' | 'needs-human' | 'failed' | 'interrupted';
export type RecordStatus = TaskStatus | 'pending' | 'running';
export const FINISHED: readonly RecordStatus[] = ['completed', 'needs-human', 'failed'];

export interface AutoAnswer { at: string; chatId: string; question: string; answer: string }
/** An earlier run of the same task whose project stays in Studio; `folder` is where its files were moved to. */
export interface PreviousAttempt { projectId?: string; projectUrl?: string; runId?: string; status: RecordStatus; reason?: string; folder?: string }
/** result.json (cli/设计.md §7.5). */
export interface TaskResult {
  name: string; status: TaskStatus; reason: string; projectId?: string; projectUrl?: string; runId?: string;
  startedAt: string; endedAt: string; elapsedMs: number;
  usage: { weightedTokens: number; tokenBreakdown: TokenBreakdown; rounds: number };
  tasks: { code: string; title: string; state: string; completedBy?: 'human' | 'agent' }[];
  autoAnswers: AutoAnswer[];
  trajectory: { file: string | null; bytes: number; warnings: string[] };
  previousAttempts?: PreviousAttempt[];
}

/** One task in batch-state.json. */
export interface TaskRecord {
  name: string; folder: string; status: RecordStatus; reason?: string; projectId?: string; projectUrl?: string; runId?: string;
  startedAt?: string; endedAt?: string; elapsedMs?: number; weightedTokens?: number; previousAttempts?: PreviousAttempt[];
}
export interface BatchState {
  version: 1; manifest: { path: string; sha256: string }; studioUrl: string; noVideo: boolean;
  startedAt: string; updatedAt: string; tasks: TaskRecord[];
}
