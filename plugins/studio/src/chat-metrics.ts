import { lastAssistantStreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-llm-retry';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import { SessionSeq } from '@deepseek-ai/dsh-session';
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection';
import type { ContextPressureProjection, TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client';
import type { ChatMetrics } from './chat-types.ts';

export interface UsageFacts { hasUsage: boolean; cacheReported: boolean }
interface UsageFactState extends UsageFacts { cacheReports: number; last?: { turn: number; step: number; cacheReported: boolean } }
const noUsage = (): UsageFactState => ({ hasUsage: false, cacheReported: false, cacheReports: 0 });

/** Same provider sample choice as token-meter; stream details never cross this boundary. */
export function reportedUsage(event: SessionEvent): TokenUsage | undefined {
  if (event.type === 'assistant/message' && event.data.usage !== undefined) return event.data.usage;
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined;
  return lastAssistantStreamChunk(event.data.stream, 'usage')?.usage;
}

function observeUsage(facts: UsageFactState, event: SessionEvent): void {
  if (event.type === 'llm/retry-started' && facts.last && facts.last.turn === event.data.turn && facts.last.step === event.data.step) {
    facts.last = undefined;
  }
  const usage = reportedUsage(event); if (!usage) return;
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return;
  facts.hasUsage = true;
  const { turn, step } = event.data;
  const cacheReported = usage.cacheReadTokens !== undefined || usage.cacheWriteTokens !== undefined;
  const previous = facts.last?.turn === turn && facts.last.step === step ? facts.last : undefined;
  facts.cacheReports += Number(cacheReported) - Number(previous?.cacheReported ?? false);
  facts.cacheReported = facts.cacheReports > 0;
  facts.last = { turn, step, cacheReported };
}

/** Optional cache fields are facts the native totals intentionally coalesce to zero. */
export function usageFacts(events: readonly SessionEvent[]): UsageFacts {
  const facts = noUsage(); for (const event of events) observeUsage(facts, event);
  return { hasUsage: facts.hasUsage, cacheReported: facts.cacheReported };
}

/** Keep live reads incremental without creating a second token accounting implementation. */
export class ChatUsageFacts {
  private readonly sessions = new WeakMap<Session, UsageFactState & { consumed: number }>();
  read(session: Session): UsageFacts {
    let state = this.sessions.get(session);
    if (!state) { state = { ...noUsage(), consumed: 0 }; this.sessions.set(session, state); }
    while (state.consumed < session.seq) {
      const event = session.eventAt(SessionSeq(state.consumed));
      if (event) observeUsage(state, event);
      state.consumed++;
    }
    return { hasUsage: state.hasUsage, cacheReported: state.cacheReported };
  }
}

const tokenCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Select the native reference occupancy and disjoint whole-log billing buckets. */
export function chatMetrics(snapshot: ProjectionSnapshot, facts: UsageFacts): ChatMetrics {
  const pressure = snapshot.values.contextPressure as ContextPressureProjection | undefined;
  const buckets = snapshot.values.tokenUsage as TokenUsageProjection | undefined;
  // Native wire schemas already validate these values. Keep this transport
  // boundary defensive as well: invalid counters stay unknown, never NaN/0.
  const projected = tokenCount(pressure?.projectedTokens), reported = tokenCount(pressure?.pressureTokens);
  const tokens = projected ?? reported;
  const rawCapacity = tokenCount(pressure?.contextWindow), capacity = rawCapacity !== undefined && rawCapacity > 0 ? rawCapacity : undefined;
  const basis = projected !== undefined ? 'projected' : reported !== undefined ? 'reported' : 'unavailable';
  const uncachedInputTokens = tokenCount(buckets?.uncachedInputTokens), outputTokens = tokenCount(buckets?.outputTokens);
  const cacheReadTokens = tokenCount(buckets?.cacheReadTokens), cacheWriteTokens = tokenCount(buckets?.cacheWriteTokens);
  let usage: ChatMetrics['usage'];
  if (facts.hasUsage && uncachedInputTokens !== undefined && outputTokens !== undefined && cacheReadTokens !== undefined && cacheWriteTokens !== undefined) {
    const input = uncachedInputTokens + cacheReadTokens + cacheWriteTokens, total = input + outputTokens;
    if (tokenCount(input) !== undefined && tokenCount(total) !== undefined) usage = {
      uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
      totalTokens: total, cacheReported: facts.cacheReported,
      ...(facts.cacheReported && input > 0 ? { cacheHitPercent: cacheReadTokens / input * 100 } : {}),
    };
  }
  return {
    asOfSeq: Number.isSafeInteger(snapshot.asOfSeq) && snapshot.asOfSeq >= -1 ? snapshot.asOfSeq : -1,
    context: {
      ...(tokens === undefined ? {} : { tokens }),
      ...(capacity === undefined ? {} : { capacity }),
      // Match the native occupancy UI: cap the gauge, retain the true token
      // count so the detail view can still show an over-capacity context.
      ...(tokens === undefined || capacity === undefined ? {} : { percent: Math.min(100, tokens / capacity * 100) }),
      basis, estimated: basis !== 'unavailable',
    },
    ...(usage ? { usage } : {}),
  };
}
