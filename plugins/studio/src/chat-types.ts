/** Browser-safe conversation transport. Only provider-returned text/reasoning is displayed. */
export interface ChatEvent { seq: number; type: string; data: Record<string, unknown> }
/** role and runId mark the conversations an autonomy run created (orchestrator or worker); absent on ordinary ones. */
export interface ChatSummary { id: string; scope: 'project' | 'task'; projectId: string; taskId?: string; provider: string; model: string; role?: 'orchestrator' | 'worker'; runId?: string; tempDirectory?: string; status?: string }
/** Native durable metering projected to numbers only; missing provider data stays unknown. */
export interface ChatMetrics {
  asOfSeq: number;
  context: {
    tokens?: number;
    capacity?: number;
    percent?: number;
    basis: 'projected' | 'reported' | 'unavailable';
    estimated: boolean;
  };
  usage?: {
    uncachedInputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    /** Accumulated reported cache reads / all disjoint prompt-side buckets. */
    cacheHitPercent?: number;
    /** At least one usage sample explicitly reported a cache bucket, including zero. */
    cacheReported: boolean;
  };
}
export interface ChatRecord extends ChatSummary { status: string; events: readonly ChatEvent[]; metrics?: ChatMetrics }
export interface TextPart { index: number; type: 'text' | 'reasoning'; text: string; closed?: boolean }
export interface LiveAttempt { id: string; turn: number; step: number; revision: number; parts: TextPart[] }
export type TextFrame =
  | { type: 'start'; attemptId: string; revision: number; turn: number; step: number }
  | { type: 'chunk'; attemptId: string; revision: number; chunk:
    | { type: 'block-start'; index: number; blockType: 'text' | 'reasoning' }
    | { type: 'text-delta' | 'reasoning-delta'; index: number; text: string }
    | { type: 'block-end'; index: number; block: { type: 'text' | 'reasoning'; text: string } } }
  | { type: 'end'; attemptId: string; revision: number };
export type ChatPacket =
  | { type: 'snapshot'; chat: ChatRecord; live: LiveAttempt[] }
  | { type: 'event'; event: ChatEvent }
  | { type: 'frame'; frame: TextFrame }
  | { type: 'metrics'; metrics: ChatMetrics }
  | { type: 'status'; status: string }
  | { type: 'error'; error: string };

/** Fold identical frames on server and browser; revisions discard reconnect duplicates. */
export function foldTextFrame(previous: LiveAttempt[], frame: TextFrame): LiveAttempt[] {
  if (frame.type === 'start') {
    if (previous.some(row => row.revision >= frame.revision)) return previous;
    return [{ id: frame.attemptId, turn: frame.turn, step: frame.step, revision: frame.revision, parts: [] }];
  }
  const attempt = previous.find(row => row.id === frame.attemptId);
  if (!attempt || frame.revision <= attempt.revision) return previous;
  if (frame.type === 'end') return previous.filter(row => row.id !== frame.attemptId);
  const chunk = frame.chunk, parts = attempt.parts.map(part => ({ ...part }));
  let part = parts.find(row => row.index === chunk.index);
  if (!part) {
    part = { index: chunk.index, type: chunk.type === 'block-start' ? chunk.blockType : chunk.type === 'block-end' ? chunk.block.type : chunk.type === 'reasoning-delta' ? 'reasoning' : 'text', text: '' };
    parts.push(part);
  }
  if (!part.closed) {
    if (chunk.type === 'block-end') { part.type = chunk.block.type; part.text = chunk.block.text; part.closed = true; }
    else if (chunk.type !== 'block-start') part.text += chunk.text;
  }
  return previous.map(row => row.id === attempt.id ? { ...attempt, revision: frame.revision, parts } : row);
}
