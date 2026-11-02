import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-user-approval/types';

/** Numbers/status only; no question, tool arguments or model reasoning crosses this seam. */
export interface ChatActivity {
  kind: 'none' | 'running' | 'awaiting-input' | 'question' | 'permission';
  interactive: boolean;
}
export interface ActivityQuestion { callId: string; state: 'open' | 'continued' }
export interface ChatActivityFacts { interactive: boolean; approvalIds: Set<string> }
export function emptyChatActivityFacts(): ChatActivityFacts { return { interactive: false, approvalIds: new Set() }; }

/** Approval requests are native paired audits; inherited requests are historical, never live waits. */
export function observeChatActivity(facts: ChatActivityFacts, event: SessionEvent, inheritedEventCount = 0): void {
  if (event.type === 'user/message' && event.data.source.kind === 'user') facts.interactive = true;
  if (event.seq < inheritedEventCount) return;
  if (event.type === 'approval/asked') facts.approvalIds.add(event.data.id);
  else if (event.type === 'approval/decided') facts.approvalIds.delete(event.data.id);
}
export function restoreChatActivity(events: readonly SessionEvent[], inheritedEventCount = 0): ChatActivityFacts {
  const facts = emptyChatActivityFacts();
  for (const event of events) observeChatActivity(facts, event, inheritedEventCount);
  return facts;
}
/** Queued replies cease to need attention immediately, before the model consumes the inbox. */
export function chatActivity(facts: ChatActivityFacts, status: string, questions: readonly ActivityQuestion[], queuedReplyIds: ReadonlySet<string> = new Set()): ChatActivity {
  const interactive = facts.interactive;
  if (questions.some(question => !queuedReplyIds.has(question.callId))) return { kind: 'question', interactive };
  // A persisted audit with no live Agent is not an actionable permission dialog.
  if (status === 'running' && facts.approvalIds.size) return { kind: 'permission', interactive };
  if (status === 'running') return { kind: 'running', interactive };
  return { kind: interactive ? 'awaiting-input' : 'none', interactive };
}
