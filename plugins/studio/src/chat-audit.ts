import type { Context } from '@deepseek-ai/cordis';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection';
import type {} from '@deepseek-ai/dsh-session-projection/types';
import type {} from '@deepseek-ai/dsh-tools';
import type {} from './index.ts';
import z from '@deepseek-ai/schemastery';
import { z as schema } from 'zod';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat, type FileHandle } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { ChatAuditArchive, ChatAuditBody, ChatAuditBodySummary, ChatAuditIndex, ChatAuditPosition, ChatAuditRecord, ChatAuditSseEvent, ChatAuditSummary, ChatAuditTransportSummary } from './chat-audit-types.ts';

export const name = 'harnessstudio-chat-audit';
export const inject = ['studio', 'llm', 'sessions', 'sessionProjections'];
export interface Config { dataRoot: string; maxBodyBytes: number }
export const Config: z<Config> = z.object({ dataRoot: z.string().required(), maxBodyBytes: z.natural().min(1024).max(1073741824).default(134217728) });

interface AuditPositionState { turn: number | null; step: number | null; userSeqs: number[]; userMessageIds: string[] }
declare module '@deepseek-ai/dsh-session-projection/types' { interface SessionProjectionStateMap { studioAuditPosition: AuditPositionState } }
declare module '@deepseek-ai/cordis' { interface Context { studioAudit: ChatAuditStore } }
const emptyPosition = (): AuditPositionState => ({ turn: null, step: null, userSeqs: [], userMessageIds: [] });
/** Native admission sequence numbers, including replies admitted between tool steps. */
export function foldAuditPosition(previous: AuditPositionState, event: Pick<SessionEvent, 'type' | 'data' | 'seq'>): AuditPositionState {
  if (event.type === 'turn/start') return { ...emptyPosition(), turn: (event.data as { turn: number }).turn };
  if (event.type === 'step/start') { const { turn, step } = event.data as { turn: number; step: number }; return { ...previous, turn, step }; }
  if (event.type === 'user/message') {
    const message = event.data as { id: string };
    return { ...previous, userSeqs: [...previous.userSeqs, Number(event.seq)], userMessageIds: [...previous.userMessageIds, message.id] };
  }
  return previous;
}
export const auditPositionProjection: ProjectionDefinition<'studioAuditPosition'> = {
  key: 'studioAuditPosition', stateVersion: 1,
  stateSchema: schema.object({ turn: schema.number().int().nonnegative().nullable(), step: schema.number().int().nonnegative().nullable(), userSeqs: schema.array(schema.number().int().nonnegative()), userMessageIds: schema.array(schema.string()) }),
  init: emptyPosition, apply: foldAuditPosition,
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const id = (value: string): string => { if (typeof value !== 'string' || !uuid.test(value)) throw new Error('Invalid audit identity'); return value; };
const unavailable = (reason = 'not-observed'): ChatAuditBodySummary => ({ status: 'unavailable', bytes: 0, observedBytes: 0, reason });
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const detached = <T>(value: T): T => structuredClone(value);
function safeError(error: unknown): string { return error instanceof Error && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(error.name) ? error.name : 'TransportError'; }
function endpoint(value: RequestInfo | URL): string {
  try { const url = new URL(value instanceof Request ? value.url : String(value)); return url.origin + url.pathname; }
  catch { return 'unavailable'; }
}
function neutralRequest(options: GenerateOptions): unknown {
  const { signal: _signal, ...body } = options;
  // GenerateOptions is lossless JSON apart from its cancellation signal.
  return JSON.parse(JSON.stringify(body));
}
function wireStatus(transports: ChatAuditTransportSummary[]): ChatAuditSummary['wireStatus'] {
  const models = transports.filter(row => row.classification === 'model-json');
  if (!models.length || models.every(row => row.request.status === 'unavailable')) return 'unavailable';
  return models.every(row => row.request.status === 'complete' && row.response.status === 'complete') ? 'available' : 'partial';
}

/** Exact SSE data is retained as well as parsed JSON; no cross-frame aggregation. */
export function parseAuditSse(raw: string): ChatAuditSseEvent[] {
  const events: ChatAuditSseEvent[] = [];
  for (const frame of raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n\n')) {
    const data: string[] = []; let event: string | undefined, eventId: string | undefined;
    for (const line of frame.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':'), field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1); if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') data.push(value); else if (field === 'event') event = value; else if (field === 'id') eventId = value;
    }
    if (!data.length) continue;
    const text = data.join('\n'), record: ChatAuditSseEvent = { ...(event === undefined ? {} : { event }), ...(eventId === undefined ? {} : { id: eventId }), data: text };
    try { record.json = JSON.parse(text); } catch { /* Terminal and non-JSON frames remain exact strings. */ }
    events.push(record);
  }
  return events;
}
function bodyView(summary: ChatAuditBodySummary, bytes: Buffer | undefined, contentType = ''): ChatAuditBody {
  if (!bytes) return summary.status === 'complete' ? { ...summary, status: 'unavailable', bytes: 0, reason: 'original-body-missing' } : detached(summary);
  const viewSummary = summary.status === 'complete' && (bytes.length !== summary.bytes || summary.sha256 !== undefined && hash(bytes) !== summary.sha256)
    ? { ...summary, status: 'partial' as const, reason: 'body-integrity-check-failed' }
    : summary;
  const actualSummary = { ...viewSummary, bytes: bytes.byteLength, observedBytes: Math.max(viewSummary.observedBytes, bytes.byteLength) };
  let raw: string;
  try { raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return { ...actualSummary, raw: bytes.toString('base64'), encoding: 'base64', format: 'other' }; }
  const result: ChatAuditBody = { ...actualSummary, raw, encoding: 'utf8', format: 'other' };
  // Partial bytes cannot represent a complete body even if a JSON prefix happens to parse.
  if (actualSummary.status === 'complete') {
    try { result.body = JSON.parse(raw); result.format = 'json'; }
    catch { if (/text\/event-stream/i.test(contentType)) { result.format = 'sse'; result.events = parseAuditSse(raw); } }
  } else if (/text\/event-stream/i.test(contentType)) { result.format = 'sse'; result.events = parseAuditSse(raw); }
  return result;
}
interface StoredRecord extends ChatAuditSummary {}
interface LiveCapture { record: StoredRecord; queue: Promise<void>; revoked: boolean; responses: Set<Promise<void>>; cancellers: Set<() => Promise<void>> }
interface AuditScope { store: ChatAuditStore; capture: LiveCapture }

/** Private, durable body spooling. Lazy index reads never load any request/response body. */
export class ChatAuditStore {
  readonly root: string;
  readonly scope = new AsyncLocalStorage<AuditScope>();
  private readonly live = new Map<string, LiveCapture>();
  private readonly revoked = new Set<string>();
  private readonly admissions = new Map<string, Promise<void>>();
  constructor(dataRoot: string, readonly maxBodyBytes = 134217728, private readonly warn: (message: string) => void = () => {}) {
    if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 1073741824) throw new Error('Invalid audit body limit');
    this.root = join(resolve(dataRoot), 'chat-audit');
  }
  private sessionPath(sessionId: string) { return join(this.root, id(sessionId)); }
  private recordPath(sessionId: string, recordId: string) { return join(this.sessionPath(sessionId), id(recordId)); }
  private assertLive(capture: LiveCapture): void { if (capture.revoked || this.revoked.has(capture.record.storageSessionId)) throw new Error('Audit session was permanently removed'); }
  private async atomic(path: string, value: unknown): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`, file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    try {
      await rename(temporary, path);
      const directory = await open(dirname(path), 'r'); try { await directory.sync(); } finally { await directory.close(); }
    } finally { await rm(temporary, { force: true }); }
  }
  private persist(capture: LiveCapture): Promise<void> {
    const operation = capture.queue.then(async () => { this.assertLive(capture); await this.atomic(join(this.recordPath(capture.record.storageSessionId, capture.record.recordId), 'record.json'), capture.record); });
    capture.queue = operation.catch(() => {}); return operation;
  }
  private async stored(sessionId: string): Promise<StoredRecord[]> {
    let entries;
    try { entries = await readdir(this.sessionPath(sessionId), { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    if (entries.length > 100000) throw new Error('Audit record scan limit exceeded');
    const records: StoredRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !uuid.test(entry.name)) continue;
      let text: string;
      // A record being opened has no record.json yet, and one a tool call left empty is removed again (tool()).
      try { text = await readFile(join(this.recordPath(sessionId, entry.name), 'record.json'), 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      const record = JSON.parse(text) as StoredRecord;
      if (record.recordId !== entry.name || record.storageSessionId !== sessionId) throw new Error('Invalid audit record owner');
      if (record.status === 'running' && !this.live.has(record.recordId)) {
        record.status = 'interrupted';
        for (const transport of record.transports) if (transport.response.status === 'capturing') transport.response = { ...transport.response, status: 'partial', reason: 'process-interrupted' };
      }
      record.wireStatus = wireStatus(record.transports); records.push(record);
    }
    return records.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.recordId.localeCompare(b.recordId));
  }
  async index(sessionId: string, userSeq?: number): Promise<ChatAuditIndex> {
    if (userSeq !== undefined && (!Number.isSafeInteger(userSeq) || userSeq < 0)) throw new Error('Invalid user admission sequence');
    const rows = (await this.stored(sessionId)).filter(row => userSeq === undefined || row.userSeqs.includes(userSeq));
    return { sessionId, status: rows.length ? 'available' : 'unavailable', ...(rows.length ? {} : { reason: 'no-captured-records' as const }), records: rows };
  }
  async read(sessionId: string, recordId: string): Promise<ChatAuditRecord> {
    id(recordId); const record = (await this.stored(sessionId)).find(row => row.recordId === recordId);
    if (!record) throw new Error('Unknown audit record');
    const path = this.recordPath(sessionId, recordId), transports: ChatAuditRecord['transports'] = [];
    for (const transport of record.transports) {
      const bytes = async (kind: string) => { try { const filename = join(path, `transport-${transport.ordinal}.${kind}.raw`), info = await stat(filename); if (info.size > this.maxBodyBytes) throw new Error('Audit body exceeds configured read limit'); return await readFile(filename); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; } };
      transports.push({ ...transport, request: bodyView(transport.request, await bytes('request'), 'application/json'), response: bodyView(transport.response, await bytes('response'), transport.contentType) });
    }
    const request = JSON.parse(await readFile(join(path, 'neutral.json'), 'utf8')) as ChatAuditRecord['request'];
    return { ...record, request, transports, wireStatus: wireStatus(transports) };
  }
  async export(sessionId: string): Promise<ChatAuditArchive> {
    await this.flush(sessionId); const index = await this.index(sessionId);
    return { version: 1, sessionId, records: await Promise.all(index.records.map(row => this.read(sessionId, row.recordId))) };
  }
  start(options: GenerateOptions, position: ChatAuditPosition): Promise<LiveCapture> {
    return this.open({ sessionId: String(options.sessionId), purpose: options.purpose ?? 'conversation', provider: options.provider, model: options.model }, neutralRequest(options), position);
  }
  private async open(header: { sessionId: string; purpose: ChatAuditSummary['purpose']; provider: string; model: string; toolCallId?: string }, neutral: unknown, position: ChatAuditPosition): Promise<LiveCapture> {
    const sessionId = id(header.sessionId); if (this.revoked.has(sessionId)) throw new Error('Audit session was permanently removed');
    const predecessor = this.admissions.get(sessionId) ?? Promise.resolve(); let release = () => {};
    const ticket = new Promise<void>(resolve => { release = resolve; }); this.admissions.set(sessionId, predecessor.then(() => ticket));
    await predecessor;
    try {
      const purpose = header.purpose, history = await this.stored(sessionId);
      const attempt = history.reduce((maximum, row) => row.sessionId === sessionId && row.turn === position.turn && row.step === position.step && row.purpose === purpose ? Math.max(maximum, row.attempt) : maximum, 0) + 1;
      const record: StoredRecord = { ...detached(position), recordId: randomUUID(), sessionId, storageSessionId: sessionId, attempt, purpose, ...(header.toolCallId ? { toolCallId: header.toolCallId } : {}), provider: header.provider, model: header.model,
        startedAt: new Date().toISOString(), status: 'running', wireStatus: 'unavailable', transports: [] };
      const capture: LiveCapture = { record, queue: Promise.resolve(), revoked: false, responses: new Set(), cancellers: new Set() };
      await mkdir(this.recordPath(sessionId, record.recordId), { recursive: true, mode: 0o700 }); this.live.set(record.recordId, capture);
      try { await this.atomic(join(this.recordPath(sessionId, record.recordId), 'neutral.json'), { representation: 'provider-neutral', body: neutral }); await this.persist(capture); }
      catch (error) { this.live.delete(record.recordId); await rm(this.recordPath(sessionId, record.recordId), { recursive: true, force: true }); throw error; }
      return capture;
    } finally { release(); }
  }
  async finish(capture: LiveCapture, status: ChatAuditSummary['status'], error?: unknown): Promise<void> {
    if (capture.revoked) return;
    // An adapter which stops reading before EOF cannot promise a complete wire response.
    await Promise.allSettled([...capture.cancellers].map(cancel => cancel()));
    capture.record.status = status; capture.record.endedAt = new Date().toISOString(); capture.record.wireStatus = wireStatus(capture.record.transports);
    if (error !== undefined) capture.record.error = safeError(error);
    await this.persist(capture); this.live.delete(capture.record.recordId);
  }
  async *capture(options: GenerateOptions, position: ChatAuditPosition, next: () => AsyncIterable<StreamChunk>): AsyncGenerator<StreamChunk> {
    const capture = await this.start(options, position), active = { store: this, capture };
    let iterator: AsyncIterator<StreamChunk> | undefined, settled = false;
    try {
      iterator = this.scope.run(active, () => next()[Symbol.asyncIterator]());
      while (true) { const result = await this.scope.run(active, () => iterator!.next()); if (result.done) break; yield result.value; }
      settled = true; await this.finish(capture, options.signal?.aborted ? 'cancelled' : 'completed');
    } catch (error) { settled = true; await this.finish(capture, options.signal?.aborted ? 'cancelled' : 'failed', error); throw error; }
    finally {
      if (!settled) { if (iterator?.return) await this.scope.run(active, () => iterator!.return!()); await this.finish(capture, 'cancelled'); }
    }
  }
  /** A tool whose provider calls a model over HTTP itself (web_search through DeepSeek search): its model requests are
   * captured like a conversation call's, in a record of their own. A tool run that sent no model request (a search API
   * without a model, the smoke provider) leaves no record. */
  async tool<T>(input: { sessionId: string; purpose: 'web-search'; toolCallId: string; arguments: unknown; signal: AbortSignal }, position: ChatAuditPosition, run: () => Promise<T>): Promise<T> {
    // The search model and endpoint are the provider's own; the record names the model once its request is seen.
    let capture: LiveCapture;
    try {
      capture = await this.open({ sessionId: input.sessionId, purpose: input.purpose, provider: 'web-search', model: 'unknown', toolCallId: input.toolCallId },
        { tool: 'web_search', callId: input.toolCallId, arguments: input.arguments }, { ...position, step: null });
    } catch { this.warn('Chat audit could not open a web search record; the search runs unrecorded.'); return run(); }
    let result: T;
    try { result = await this.scope.run({ store: this, capture }, run); }
    catch (error) { await this.settleTool(capture, input.signal.aborted ? 'cancelled' : 'failed', error); throw error; }
    await this.settleTool(capture, input.signal.aborted ? 'cancelled' : 'completed');
    return result;
  }
  private async settleTool(capture: LiveCapture, status: ChatAuditSummary['status'], error?: unknown): Promise<void> {
    if (capture.record.transports.length) { await this.finish(capture, status, error); return; }
    await capture.queue; this.live.delete(capture.record.recordId);
    await rm(this.recordPath(capture.record.storageSessionId, capture.record.recordId), { recursive: true, force: true });
  }
  /** Wait only for active writes; bodies remain streaming and are not forced into memory. */
  async flush(sessionId?: string): Promise<void> {
    if (sessionId !== undefined) id(sessionId);
    const captures = [...this.live.values()].filter(row => sessionId === undefined || row.record.storageSessionId === sessionId);
    await Promise.all(captures.map(async row => { await row.queue; }));
  }
  async purge(sessionId: string): Promise<void> {
    id(sessionId); this.revoked.add(sessionId);
    const captures = [...this.live.values()].filter(row => row.record.storageSessionId === sessionId);
    for (const capture of captures) { capture.revoked = true; await Promise.allSettled([...capture.cancellers].map(cancel => cancel())); await capture.queue; this.live.delete(capture.record.recordId); }
    await rm(this.sessionPath(sessionId), { recursive: true, force: true }); this.admissions.delete(sessionId);
  }
  async dispose(): Promise<void> { for (const capture of this.live.values()) await Promise.allSettled([...capture.cancellers].map(cancel => cancel())); await this.flush(); }

  async import(sessionId: string, archive: ChatAuditArchive): Promise<void> {
    id(sessionId);
    if (!archive || archive.version !== 1 || !uuid.test(archive.sessionId) || !Array.isArray(archive.records) || archive.records.length > 100000) throw new Error('Invalid audit archive');
    if (this.revoked.has(sessionId)) throw new Error('Audit session was permanently removed');
    if ((await this.stored(sessionId)).length) throw new Error('Audit import requires a new empty conversation');
    const seen = new Set<string>(), importedAt = new Date().toISOString();
    // Validate every record before creating any audit history.
    for (const row of archive.records) {
      id(row.recordId); id(row.sessionId); id(row.storageSessionId);
      if (seen.has(row.recordId) || !Array.isArray(row.userSeqs) || row.userSeqs.some(seq => !Number.isSafeInteger(seq) || seq < 0) || !Array.isArray(row.userMessageIds)
        || row.userMessageIds.some(value => typeof value !== 'string') || !Number.isSafeInteger(row.attempt) || row.attempt < 1 || !Array.isArray(row.transports) || row.transports.length > 10000
        || !row.request || row.request.representation !== 'provider-neutral' || !row.request.body || typeof row.request.body !== 'object'
        || !['running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(row.status) || !['conversation', 'compaction', 'session-title', 'web-search'].includes(row.purpose)
        || row.toolCallId !== undefined && (typeof row.toolCallId !== 'string' || !row.toolCallId || row.toolCallId.length > 200)
        || typeof row.provider !== 'string' || !row.provider || typeof row.model !== 'string' || !row.model || typeof row.startedAt !== 'string' || !Number.isFinite(Date.parse(row.startedAt))
        || row.endedAt !== undefined && (typeof row.endedAt !== 'string' || !Number.isFinite(Date.parse(row.endedAt)))
        || row.turn !== null && (!Number.isSafeInteger(row.turn) || row.turn < 0) || row.step !== null && (!Number.isSafeInteger(row.step) || row.step < 0)) throw new Error('Invalid audit archive record');
      seen.add(row.recordId);
      for (const [index, transport] of row.transports.entries()) {
        if (transport.ordinal !== index + 1 || !['model-json', 'auxiliary-json'].includes(transport.classification) || typeof transport.endpoint !== 'string'
          || typeof transport.method !== 'string' || !/^[A-Z]{1,16}$/.test(transport.method) || typeof transport.startedAt !== 'string' || !Number.isFinite(Date.parse(transport.startedAt))
          || transport.statusCode !== undefined && (!Number.isSafeInteger(transport.statusCode) || transport.statusCode < 100 || transport.statusCode > 599)) throw new Error('Invalid audit transport');
        const url = transport.endpoint === 'unavailable' ? undefined : new URL(transport.endpoint);
        if (url && (url.href !== url.origin + url.pathname || url.username || url.password)) throw new Error('Audit archive contains an unsafe endpoint');
        for (const body of [transport.request, transport.response]) {
          if (!body || !['capturing', 'complete', 'partial', 'unavailable'].includes(body.status) || !Number.isSafeInteger(body.bytes) || body.bytes < 0
            || !Number.isSafeInteger(body.observedBytes) || body.observedBytes < body.bytes || body.bytes > this.maxBodyBytes) throw new Error('Invalid audit body status or size');
          if (body.raw !== undefined) { if (typeof body.raw !== 'string' || !['utf8', 'base64'].includes(body.encoding ?? '')) throw new Error('Invalid audit body encoding');
            if (body.encoding === 'base64' && (body.raw.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.raw))) throw new Error('Invalid audit base64 bytes');
            const bytes = Buffer.from(body.raw, body.encoding === 'base64' ? 'base64' : 'utf8');
            if (bytes.byteLength > this.maxBodyBytes || bytes.byteLength !== body.bytes || (body.sha256 !== undefined && hash(bytes) !== body.sha256)) throw new Error('Audit body integrity or size check failed');
          } else if (body.status === 'complete') throw new Error('Complete audit body has no original bytes');
        }
      }
    }
    try {
      for (const row of archive.records) {
        const { transports, request, ...header } = detached(row), summaries: ChatAuditTransportSummary[] = [];
        await mkdir(this.recordPath(sessionId, row.recordId), { recursive: true, mode: 0o700 });
        await this.atomic(join(this.recordPath(sessionId, row.recordId), 'neutral.json'), request);
        for (const transport of transports) {
          const summary = { ...transport } as ChatAuditTransportSummary;
          for (const kind of ['request', 'response'] as const) {
            const { raw, encoding, format: _format, body: _body, events: _events, ...bodySummary } = transport[kind];
            if (raw !== undefined) { const file = await open(join(this.recordPath(sessionId, row.recordId), `transport-${transport.ordinal}.${kind}.raw`), 'wx', 0o600); try { await file.writeFile(Buffer.from(raw, encoding === 'base64' ? 'base64' : 'utf8')); await file.sync(); } finally { await file.close(); } }
            summary[kind] = bodySummary.status === 'capturing' ? { ...bodySummary, status: 'partial', reason: 'imported-interrupted-capture' } : bodySummary;
          }
          summaries.push(summary);
        }
        const stored: StoredRecord = { ...header, storageSessionId: sessionId, importedAt, status: header.status === 'running' ? 'interrupted' : header.status, transports: summaries, wireStatus: wireStatus(summaries) };
        await this.atomic(join(this.recordPath(sessionId, row.recordId), 'record.json'), stored);
      }
    } catch (error) { await rm(this.sessionPath(sessionId), { recursive: true, force: true }); throw error; }
  }

  async transport(capture: LiveCapture, parentFetch: typeof fetch, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    this.assertLive(capture);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)), contentType = headers.get('content-type') ?? '';
    if (!['POST', 'PUT', 'PATCH'].includes(method) || !/application\/(?:[A-Za-z0-9.+-]*\+)?json/i.test(contentType)) return parentFetch(input, init);
    const captured = await requestBytes(input, init, this.maxBodyBytes);
    let parsed: Record<string, unknown> | undefined;
    if (captured.status === 'complete') { try { const value = JSON.parse(captured.bytes.toString('utf8')); if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value; } catch { /* Exact non-JSON bytes still remain visible. */ } }
    const path = this.recordPath(capture.record.storageSessionId, capture.record.recordId), ordinal = capture.record.transports.length + 1;
    const classification = parsed && ('messages' in parsed || 'input' in parsed || 'contents' in parsed) || /\/(messages|responses|chat\/completions)(?:\/|$)/.test(endpoint(input)) ? 'model-json' : 'auxiliary-json';
    // Credential refresh/file-service JSON can occur inside the same async call.
    // It is not a model body, and must not be included in the conversation archive.
    if (classification === 'auxiliary-json') return parentFetch(input, init);
    const row: ChatAuditTransportSummary = { ordinal, classification, endpoint: endpoint(input), method, startedAt: new Date().toISOString(), request: { status: captured.status, bytes: captured.bytes.length, observedBytes: captured.observedBytes, ...(captured.reason ? { reason: captured.reason } : {}), ...(captured.status === 'complete' ? { sha256: hash(captured.bytes) } : {}) }, response: unavailable() };
    if (capture.record.purpose === 'web-search' && typeof parsed?.model === 'string' && parsed.model) capture.record.model = String(parsed.model).slice(0, 200);
    capture.record.transports.push(row);
    if (captured.status !== 'unavailable') { const requestFile = await open(join(path, `transport-${ordinal}.request.raw`), 'wx', 0o600); try { await requestFile.writeFile(captured.bytes); await requestFile.sync(); } finally { await requestFile.close(); } }
    await this.persist(capture); // Exact attempted bytes are durable before HTTP dispatch.
    let response: Response;
    try { response = await parentFetch(input, init); }
    catch (error) { row.error = safeError(error); row.endedAt = new Date().toISOString(); row.response = unavailable('fetch-failed'); await this.persist(capture); throw error; }
    row.statusCode = response.status; row.contentType = response.headers.get('content-type') ?? undefined;
    if (!response.body) { row.response = { status: 'complete', bytes: 0, observedBytes: 0, sha256: hash(new Uint8Array()) }; row.endedAt = new Date().toISOString(); const file = await open(join(path, `transport-${ordinal}.response.raw`), 'wx', 0o600); await file.close(); await this.persist(capture); return response; }
    const reader = response.body.getReader(); let file: FileHandle | undefined, completed = false, observed = 0, written = 0, writeFailed = false;
    const digest = createHash('sha256'); let resolveDone = () => {};
    const done = new Promise<void>(resolve => { resolveDone = resolve; }); capture.responses.add(done);
    try { file = await open(join(path, `transport-${ordinal}.response.raw`), 'wx', 0o600); }
    catch { writeFailed = true; this.warn('Chat audit response storage failed; the original model stream remains available.'); }
    row.response = { status: 'capturing', bytes: 0, observedBytes: 0 }; await this.persist(capture);
    const finalize = async (reason?: string) => {
      if (completed) { await done; return; } completed = true;
      try { await file?.sync(); } catch { writeFailed = true; } finally { await file?.close().catch(() => {}); }
      row.response = { status: reason || writeFailed || observed > this.maxBodyBytes ? 'partial' : 'complete', bytes: written, observedBytes: observed,
        ...(reason || writeFailed || observed > this.maxBodyBytes ? { reason: reason ?? (writeFailed ? 'storage-error' : 'max-body-bytes') } : { sha256: digest.digest('hex') }) };
      row.endedAt = new Date().toISOString(); capture.record.wireStatus = wireStatus(capture.record.transports);
      if (!capture.revoked) await this.persist(capture).catch(() => { this.warn('Chat audit metadata could not be saved.'); });
      capture.responses.delete(done); capture.cancellers.delete(cancel); resolveDone();
    };
    const cancel = async () => { await reader.cancel().catch(() => {}); await finalize('cancelled'); }; capture.cancellers.add(cancel);
    const maxBodyBytes = this.maxBodyBytes;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) { await finalize(); controller.close(); return; }
          const bytes = next.value; observed += bytes.byteLength; digest.update(bytes);
          if (!writeFailed && file && written < maxBodyBytes && !capture.revoked) {
            const part = bytes.subarray(0, Math.min(bytes.byteLength, maxBodyBytes - written));
            try { let offset = 0; while (offset < part.byteLength) { const result = await file.write(part.subarray(offset)); if (!result.bytesWritten) throw new Error('Audit spool write made no progress'); offset += result.bytesWritten; written += result.bytesWritten; } } catch { writeFailed = true; }
          }
          row.response.bytes = written; row.response.observedBytes = observed;
          // One bounded chunk is held at a time. Original consumer backpressure and cancellation are preserved.
          controller.enqueue(bytes);
        } catch (error) { await finalize('response-error'); controller.error(error); }
      }, async cancel() { await cancel(); },
    }, { highWaterMark: 0 });
    const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    for (const key of ['url', 'redirected', 'type'] as const) Object.defineProperty(wrapped, key, { value: response[key], configurable: true });
    return wrapped;
  }
}

async function requestBytes(input: RequestInfo | URL, init: RequestInit | undefined, limit: number): Promise<{ status: ChatAuditBodySummary['status']; bytes: Buffer; observedBytes: number; reason?: string }> {
  const body = init?.body;
  let bytes: Buffer | undefined;
  if (typeof body === 'string') bytes = Buffer.from(body);
  else if (body instanceof URLSearchParams) bytes = Buffer.from(body.toString());
  else if (body instanceof ArrayBuffer) bytes = Buffer.from(body);
  else if (ArrayBuffer.isView(body)) bytes = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  else if (body instanceof Blob && body.size <= limit) bytes = Buffer.from(await body.arrayBuffer());
  else if (body === undefined && input instanceof Request && input.body) {
    const reader = input.clone().body!.getReader(), chunks: Buffer[] = []; let size = 0;
    try { while (true) { const part = await reader.read(); if (part.done) { bytes = Buffer.concat(chunks); break; } size += part.value.byteLength; chunks.push(Buffer.from(part.value).subarray(0, Math.max(0, limit - (size - part.value.byteLength))));
        if (size > limit) { void reader.cancel().catch(() => {}); return { status: 'partial', bytes: Buffer.concat(chunks), observedBytes: size, reason: 'max-body-bytes' }; } } }
    catch { return { status: 'unavailable', bytes: Buffer.alloc(0), observedBytes: 0, reason: 'request-body-unreadable' }; }
  }
  if (!bytes) return { status: 'unavailable', bytes: Buffer.alloc(0), observedBytes: body instanceof Blob ? body.size : 0, reason: body instanceof Blob ? 'max-body-bytes' : 'streaming-request-body' };
  return bytes.byteLength > limit ? { status: 'partial', bytes: bytes.subarray(0, limit), observedBytes: bytes.byteLength, reason: 'max-body-bytes' } : { status: 'complete', bytes, observedBytes: bytes.byteLength };
}

/** A reversible instance composition; existing Proxy/SDK fetch behavior stays underneath. */
export function installAuditFetch(store: ChatAuditStore, target: Pick<typeof globalThis, 'fetch'> = globalThis): () => void {
  const parent = target.fetch, descriptor = Object.getOwnPropertyDescriptor(target, 'fetch');
  const wrapped: typeof fetch = (input, init) => { const scope = store.scope.getStore(); return scope?.store === store ? store.transport(scope.capture, parent.bind(target), input, init) : parent.call(target, input, init); };
  Object.defineProperty(target, 'fetch', { value: wrapped, configurable: true, writable: true }); let active = true;
  return () => { if (!active) return; active = false; if (Object.getOwnPropertyDescriptor(target, 'fetch')?.value !== wrapped) return; if (descriptor) Object.defineProperty(target, 'fetch', descriptor); else Reflect.deleteProperty(target, 'fetch'); };
}

export function apply(ctx: Context, config: Config): void {
  const store = new ChatAuditStore(config.dataRoot, config.maxBodyBytes), attempts = new Map<string, { turn: number; step: number; nativeAttemptId: string }>();
  ctx.effect(() => ctx.provide('studioAudit', store), 'studio-audit: private store');
  ctx.sessionProjections.register(auditPositionProjection);
  ctx.on('agent/assistant-stream', ({ agent, frame }) => { if (frame.type === 'start') attempts.set(agent.id, { turn: frame.turn, step: frame.step, nativeAttemptId: String(frame.attemptId) }); });
  ctx.on('llm/stream', (options, next) => (async function* () {
    const sessionId = options.sessionId;
    if (!sessionId) { yield* next(); return; }
    try { ctx.studio.boundLease(sessionId); } catch { yield* next(); return; }
    const session = ctx.sessions.get(SessionId(sessionId)), state = session ? ctx.sessionProjections.stateOf(session, 'studioAuditPosition') ?? emptyPosition() : emptyPosition();
    const currentAttempt = options.purpose ? undefined : attempts.get(sessionId);
    const position: ChatAuditPosition = { ...detached(state), ...(currentAttempt && currentAttempt.turn === state.turn && currentAttempt.step === state.step ? { nativeAttemptId: currentAttempt.nativeAttemptId } : {}) };
    yield* store.capture(options, position, next);
  })());
  ctx.effect(() => installAuditFetch(store), 'studio-audit: exact HTTP bodies');
  // web_search providers may call a model themselves (DeepSeek search is a Messages request); those requests leave the
  // conversation's own model call, so the tool's dispatch is the capture scope.
  ctx.on('tools/execute', (exec, next) => {
    const agent = exec.agent; if (exec.name !== 'web_search' || !agent) return next();
    const sessionId = String(agent.session.id);
    try { ctx.studio.boundLease(sessionId); } catch { return next(); }
    const state = ctx.sessionProjections.stateOf(agent.session, 'studioAuditPosition') ?? emptyPosition();
    return store.tool({ sessionId, purpose: 'web-search', toolCallId: String(exec.callId), arguments: exec.arguments, signal: exec.signal }, detached(state), next);
  });
  ctx.on('session/flush', () => store.flush());
  ctx.effect(() => () => store.dispose(), 'studio-audit: close body spools');
}
