/** How complete the captured model calls of one conversation are, call by call (cli/设计.md §8): which calls lack exact
 * HTTP bytes and why, and which model calls the session shows have no record at all. The project export writes this
 * into each chat.json and lists every incomplete call in project.json. Pure: no storage access. */
import type { ChatAuditBodySummary, ChatAuditSummary } from './chat-audit-types.ts';

export interface CallIssue { part: 'call' | 'request' | 'response'; transport?: number; reason: string }
export interface IncompleteCall {
  recordId: string; purpose: ChatAuditSummary['purpose']; turn: number | null; step: number | null; attempt: number; toolCallId?: string;
  startedAt: string; status: ChatAuditSummary['status']; issues: CallIssue[];
}
/** Model calls the session shows (assistant attempts and messages of one step, LLM compactions, search requests, title
 * requests) beyond the records captured for them. */
export interface MissingCalls { purpose: ChatAuditSummary['purpose']; turn: number | null; step: number | null; inSession: number; recorded: number }
export interface ChatAuditReport {
  status: 'complete' | 'partial' | 'unavailable';
  /** Captured records, complete ones, and calls that ended before any HTTP request (nothing reached a model). */
  calls: number; complete: number; notSent: number;
  incomplete: IncompleteCall[]; missing: MissingCalls[];
  /** The same findings as sentences for people. */
  notes: string[];
}
interface CallView { status: ChatAuditSummary['status']; transports: readonly { ordinal: number; request: ChatAuditBodySummary; response: ChatAuditBodySummary }[] }

/** What is missing from one call: from its stored summary, or from the record as read, which also checks the saved
 * bytes against their length and hash. 'not-sent': it failed or was stopped before sending anything. */
export function callIssues(call: CallView): CallIssue[] | 'not-sent' {
  const issues: CallIssue[] = [];
  if (call.status === 'running') issues.push({ part: 'call', reason: 'call-running' });
  if (!call.transports.length) {
    if (call.status === 'failed' || call.status === 'cancelled') return 'not-sent';
    if (call.status === 'interrupted') issues.push({ part: 'call', reason: 'process-interrupted' });
    else if (call.status === 'completed') issues.push({ part: 'call', reason: 'no-http' });
  }
  for (const transport of call.transports) for (const part of ['request', 'response'] as const) {
    const body = transport[part];
    if (body.status !== 'complete') issues.push({ part, transport: transport.ordinal, reason: body.reason ?? body.status });
  }
  return issues;
}

/** Model calls in the session without a captured record. A retried step has one attempt event per failed try and a
 * message for the last; each try is one record. Inherited events belong to the session they were copied from. */
export function missingCalls(events: readonly { seq: number; type: string; data?: unknown }[], inheritedEventCount: number, records: readonly ChatAuditSummary[]): MissingCalls[] {
  const inSession = new Map<string, MissingCalls>(), key = (purpose: string, turn: number | null, step: number | null) => JSON.stringify([purpose, turn, step]);
  const count = (purpose: MissingCalls['purpose'], turn: number | null, step: number | null, by = 1) => {
    const id = key(purpose, turn, step), row = inSession.get(id) ?? { purpose, turn, step, inSession: 0, recorded: 0 }; row.inSession += by; inSession.set(id, row);
  };
  for (const event of events) {
    if (event.seq < inheritedEventCount) continue;
    const data = (event.data ?? {}) as { turn?: unknown; step?: unknown; llmStreamCall?: unknown };
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') count('conversation', typeof data.turn === 'number' ? data.turn : null, typeof data.step === 'number' ? data.step : null);
    // A compaction with a custom or template summarizer calls no model; the native marker says this one did.
    else if (event.type === 'compaction/summary' && data.llmStreamCall === true) count('compaction', null, null);
    else if (event.type === 'web/deepseek-search-llm-request') count('web-search', null, null);
    else if (event.type === 'session/title-llm-request') count('session-title', null, null);
  }
  for (const row of records) {
    const scoped = row.purpose === 'conversation' ? key(row.purpose, row.turn, row.step) : key(row.purpose, null, null), target = inSession.get(scoped);
    // One search call may send several model requests (one per query); each is counted against the session's requests.
    if (target) target.recorded += row.purpose === 'web-search' ? row.transports.length : 1;
  }
  return [...inSession.values()].filter(row => row.recorded < row.inSession);
}

const REASONS: Record<string, string> = {
  'call-running': '导出时这次调用还在进行，只记录到导出那一刻',
  'process-interrupted': 'Studio 在调用进行中停止或重启，只记录到那一刻',
  'no-http': '这次调用没有经过 HTTP（测试模型，或不用标准 fetch 的模型适配器），没有原始请求和返回',
  cancelled: '调用被停止（暂停或停止运行、在对话里点了停止），只记录到停止时',
  'max-body-bytes': '超过对话审计的保存上限（maxBodyBytes，默认 128 MB），只保存了开头部分',
  'fetch-failed': '请求没有发出去或连接失败，没有收到返回',
  'response-error': '接收返回时连接出错，返回不完整',
  'storage-error': '写入磁盘失败，没有保存完整',
  'not-observed': '没有观察到这部分内容',
  capturing: '导出时还在接收',
  'streaming-request-body': '请求体以流的方式发送，无法逐字记录',
  'request-body-unreadable': '请求体读取失败',
  'body-integrity-check-failed': '保存的内容与记录的长度或校验值不一致',
  'original-body-missing': '保存原始内容的文件不见了',
  'imported-interrupted-capture': '导入的对话里这次调用当时没有记录完',
  'export-read-failed': '导出时读取这条记录失败',
};
const PURPOSES: Record<ChatAuditSummary['purpose'], string> = { conversation: '对话调用', compaction: '上下文压缩调用', 'session-title': '对话命名调用', 'web-search': '联网搜索中的模型调用' };
const PARTS = { call: '', request: '原始请求', response: '原始返回' };
const position = (turn: number | null, step: number | null) => turn === null ? '' : step === null ? `第 ${turn} 轮` : `第 ${turn} 轮第 ${step} 步`;
export const reasonText = (reason: string) => REASONS[reason] ?? `未完整记录（${reason}）`;
export function issueText(issue: CallIssue): string {
  const part = PARTS[issue.part];
  return `${part}${part && issue.transport !== undefined && issue.transport > 1 ? `（第 ${issue.transport} 次 HTTP 请求）` : ''}${part ? '：' : ''}${reasonText(issue.reason)}`;
}
/** One sentence per incomplete call or group of unrecorded calls; `chat` names the conversation for the reader. */
export function reportSentences(chat: string, report: Pick<ChatAuditReport, 'incomplete' | 'missing'>): string[] {
  return [
    ...report.incomplete.map(call => `${chat}的${PURPOSES[call.purpose]}（${[position(call.turn, call.step), call.toolCallId ? `工具调用 ${call.toolCallId}` : '', `开始于 ${call.startedAt}`, `记录 ${call.recordId}`].filter(Boolean).join('，')}）不完整：${call.issues.map(issueText).join('；')}`),
    ...report.missing.map(row => `${chat}有 ${row.inSession - row.recorded} 次${PURPOSES[row.purpose]}${row.turn === null ? '' : `（${position(row.turn, row.step)}）`}没有原始请求记录：会话里有这些调用，但对话审计没有记下（例如审计启用之前的调用）`),
  ];
}
export function reportStatus(report: Pick<ChatAuditReport, 'calls' | 'incomplete' | 'missing'>): ChatAuditReport['status'] {
  if (!report.incomplete.length && !report.missing.length) return 'complete';
  return report.calls ? 'partial' : 'unavailable';
}
