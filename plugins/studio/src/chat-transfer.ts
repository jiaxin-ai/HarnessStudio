/** Conversation request inspection and readable debug exports. */
import type { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import { join } from 'node:path';
import type { ChatSummary } from './chat-types.ts';
import type { ChatAuditStore } from './chat-audit.ts';
import type { ChatAuditSummary } from './chat-audit-types.ts';
import { foldAuditPosition } from './chat-audit.ts';
import { throwIfAborted } from './abort.ts';
import { CHAT_DEBUG_LIMITS, createChatDebugExport, readChatDebugTree,
  type ChatDebugSession, type ChatDebugUpload } from './chat-debug.ts';

export interface ChatTransferOwner {
  summary(id: string): ChatSummary;
  /** The chat's existing temporary directory; undefined when it was never created. */
  scratchDirectory(id: string): Promise<string | undefined>;
  assertIdle(id: string): void;
}
const absent = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const bounded = (bytes: number) => { if (bytes > CHAT_DEBUG_LIMITS.maxTotalBytes) throw new Error('对话调试 JSON 超过 96 MiB 内容上限，请先整理对话附件和临时文件。'); };
type AuditRecord = Awaited<ReturnType<ChatAuditStore['read']>>;
/** Keeps a model call's metadata, sizes and hashes but drops its captured bodies. */
function withoutBodies(record: AuditRecord): AuditRecord {
  const omit = <T extends { raw?: unknown; body?: unknown; events?: unknown; encoding?: unknown; format?: unknown }>(body: T) => {
    const { raw: _raw, body: _body, events: _events, encoding: _encoding, format: _format, ...summary } = body;
    return { ...summary, omitted: 'debug-export-size-limit' };
  };
  return { ...record, request: { representation: record.request.representation, body: { omitted: 'debug-export-size-limit' } },
    transports: record.transports.map(transport => ({ ...transport, request: omit(transport.request), response: omit(transport.response) })) } as AuditRecord;
}
const auditStore = (ctx: Context): ChatAuditStore | undefined => ctx.get?.('studioAudit');
function modifiedAt(sessions: ChatDebugSession[], records: ChatAuditSummary[]): string {
  let latest = 0;
  for (const session of sessions) {
    latest = Math.max(latest, session.header.createdAt);
    for (const event of session.events) latest = Math.max(latest, event.time);
  }
  for (const row of records) for (const value of [row.startedAt, row.endedAt]) if (value && Number.isFinite(Date.parse(value))) latest = Math.max(latest, Date.parse(value));
  return new Date(latest).toISOString();
}
export function completeness(sessions: ChatDebugSession[], records: ChatAuditSummary[], userSeq?: number) {
  const nativeCounts = new Map<string, number>(), capturedIds = new Map<string, Set<string>>();
  const key = (sessionId: string, purpose: string, turn?: unknown, step?: unknown) => JSON.stringify([sessionId, purpose, turn, step]);
  for (const session of sessions) {
    let position = { turn: null as number | null, step: null as number | null, userSeqs: [] as number[], userMessageIds: [] as string[] };
    for (const event of session.events) {
      position = foldAuditPosition(position, event);
      if (userSeq !== undefined && !position.userSeqs.includes(userSeq)) continue;
      const data = event.data as unknown as { turn?: number; step?: number; llmStreamCall?: boolean };
      const conversation = ['assistant/message', 'assistant/attempt'].includes(event.type);
      // Custom/deterministic summaries need no HTTP model body. The native
      // marker is the explicit fact that this compaction called llm.stream.
      const compaction = event.type as string === 'compaction/summary' && data.llmStreamCall === true;
      if (!conversation && !compaction) continue;
      const group = compaction ? key(String(session.header.id), 'compaction') : key(String(session.header.id), 'conversation', data.turn, data.step);
      nativeCounts.set(group, (nativeCounts.get(group) ?? 0) + 1);
    }
  }
  for (const row of records) {
    if (!['conversation', 'compaction'].includes(row.purpose) || userSeq !== undefined && !row.userSeqs.includes(userSeq)) continue;
    const group = row.purpose === 'compaction' ? key(row.storageSessionId, 'compaction') : key(row.storageSessionId, 'conversation', row.turn, row.step), distinct = capturedIds.get(group) ?? new Set<string>();
    distinct.add(row.recordId); capturedIds.set(group, distinct);
  }
  // One new captured attempt cannot stand in for several unrecorded retries at
  // the same native turn/step. Storage identity is used for restored sessions;
  // the immutable original sessionId remains provenance, not the current owner.
  const missing = [...nativeCounts].some(([group, count]) => (capturedIds.get(group)?.size ?? 0) < count);
  const partial = records.some(row => row.wireStatus !== 'available' || row.transports.some(t => t.request.status !== 'complete' || t.response.status !== 'complete'));
  const notes: string[] = [];
  if (missing) notes.push('部分历史模型调用没有已采集的原始 HTTP 请求或响应，无法追溯补录；原生历史已保留。');
  if (partial) notes.push('部分调用没有完整的 HTTP 记录（可能是中断、大小限制或不支持的传输方式），详情保留实际采集状态。');
  const status = missing || partial ? records.length ? 'partial' : 'unavailable' : 'complete';
  return { status: status as 'complete' | 'partial' | 'unavailable', notes };
}
export class ChatTransfer {
  constructor(private ctx: Context, private root: string, private owner: ChatTransferOwner) {}
  private async session(id: string): Promise<ChatDebugSession> {
    const reader = await this.ctx.sessionPersistence.open(SessionId(id), 'read');
    try { return { header: reader.header, inheritedEventCount: Number(reader.inheritedEventCount), events: (await reader.read()).events }; }
    finally { await reader.close(); }
  }
  async requests(id: string, userSeq: number) {
    this.owner.summary(id);
    if (!Number.isSafeInteger(userSeq) || userSeq < 0) throw new Error('无效的用户消息序号');
    await this.ctx.sessionPersistence.flush();
    const session = await this.session(id);
    if (!session.events.some(event => Number(event.seq) === userSeq && event.type === 'user/message')) throw new Error('该序号不是当前对话的用户消息');
    const rows = (await auditStore(this.ctx)?.index(id, userSeq))?.records ?? [];
    this.owner.summary(id);
    return { id, userSeq, asOfSeq: session.events.length, modifiedAt: modifiedAt([session], rows), requests: rows.map(row => ({
      id: row.recordId, turn: row.turn, step: row.step, attempt: row.attempt, purpose: row.purpose, provider: row.provider, model: row.model,
      startedAt: row.startedAt, status: row.status, requestAvailable: row.transports.some(t => t.request.status !== 'unavailable'),
      responseAvailable: row.transports.some(t => t.response.status !== 'unavailable'), wireStatus: row.wireStatus,
    })), completeness: rows.length ? completeness([session], rows, userSeq) : { status: 'unavailable', notes: ['此消息尚未产生已采集的模型请求；旧版本的历史请求无法追溯补录。'] } };
  }
  async request(id: string, requestId: string) {
    this.owner.summary(id); const store = auditStore(this.ctx); if (!store) throw new Error('模型请求记录插件尚未就绪');
    const record = await store.read(id, requestId); this.owner.summary(id);
    return { id: requestId, record, notes: record.wireStatus === 'available' ? [] : ['仅展示实际采集的数据；Harness 逻辑输入不是发送给 Provider 的原始 HTTP body。'] };
  }
  async backup(id: string, signal?: AbortSignal) {
    return this.debugExport(id, signal);
  }
  private async debugExport(id: string, signal?: AbortSignal) {
    const source = this.owner.summary(id); this.owner.assertIdle(id); throwIfAborted(signal);
    await this.ctx.sessionPersistence.flush(); const store = auditStore(this.ctx); await store?.flush(id);
    const sessions = [await this.session(id)];
    const directory = await this.owner.scratchDirectory(id);
    const temporaryFiles = directory ? await readChatDebugTree(directory, {}, signal) : [];
    const required = Buffer.byteLength(JSON.stringify(sessions)) + temporaryFiles.reduce((total, file) => total + file.data.byteLength, 0);
    bounded(required);
    // Every request resends the whole history, so long VM sessions outgrow the limit. The native history and the
    // newest model calls are exported whole; older calls keep their metadata, byte counts and hashes only.
    const index = await store?.index(id), entries = index?.records ?? [], records: AuditRecord[] = new Array(entries.length);
    let budget = CHAT_DEBUG_LIMITS.maxTotalBytes - required, omitted = 0;
    for (let position = entries.length - 1; position >= 0; position--) {
      throwIfAborted(signal); const record = await store!.read(id, entries[position]!.recordId), bytes = Buffer.byteLength(JSON.stringify(record));
      if (!omitted && bytes <= budget) { budget -= bytes; records[position] = record; }
      else { omitted++; records[position] = withoutBodies(record); }
    }
    let uploads: ChatDebugUpload[] = [];
    try {
      const tree = await readChatDebugTree(join(this.root, 'chat-attachments', id), {}, signal);
      const manifest = tree.find(file => file.path === 'manifest.json');
      if (manifest) {
        const value = JSON.parse(Buffer.from(manifest.data).toString('utf8'));
        if (value.version !== 1 || value.owner?.id !== id || value.owner?.projectId !== source.projectId || value.owner?.scope !== source.scope || value.owner?.taskId !== source.taskId) throw new Error('附件归属不匹配');
        uploads = value.uploads;
      }
    } catch (error) { if (!absent(error)) throw error; }
    throwIfAborted(signal); this.owner.assertIdle(id); this.owner.summary(id);
    if ((await this.session(id)).events.length !== sessions[0]!.events.length) throw new Error('对话在保存期间发生变化，请稍后重试');
    const timestamp = modifiedAt(sessions, records);
    // The 96 MiB budget counts compact JSON; indentation can still push the file past its own 136 MiB cap, so the
    // oldest complete calls are reduced further until it fits.
    for (;;) {
      const state = completeness(sessions, records);
      if (omitted) state.notes.push(`对话历史完整；较早的 ${omitted} 次模型调用超出导出上限，只保留时间、状态、字节数和 SHA-256，省略了原始 HTTP 正文。`);
      try {
        return { content: createChatDebugExport({ source, sessions, records, uploads, temporaryFiles,
          modifiedAt: timestamp, completeness: omitted ? { ...state, status: 'partial' } : state }),
          filename: `conversation-${timestamp.replace(/[:.]/g, '-')}.debug.json` };
      } catch (error) {
        const kept = records.length - omitted;
        if (!(error instanceof Error && error.message.includes('136 MiB')) || !kept) throw error;
        const reduce = Math.max(1, Math.ceil(kept / 4));
        for (let position = omitted; position < omitted + reduce; position++) records[position] = withoutBodies(records[position]!);
        omitted += reduce;
      }
    }
  }
}
