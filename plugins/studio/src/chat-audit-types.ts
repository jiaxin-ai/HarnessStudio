/** Exact transport bodies are distinct from the Harness's provider-neutral request. */
export type ChatAuditBodyStatus = 'capturing' | 'complete' | 'partial' | 'unavailable';
export interface ChatAuditBodySummary {
  status: ChatAuditBodyStatus;
  bytes: number;
  observedBytes: number;
  sha256?: string;
  reason?: string;
}
export interface ChatAuditBody extends ChatAuditBodySummary {
  /** UTF-8 text, or base64 when the captured bytes are not valid UTF-8. */
  raw?: string;
  encoding?: 'utf8' | 'base64';
  format?: 'json' | 'sse' | 'other';
  /** Parsed from raw bytes, never assembled from a current prompt or model chunks. */
  body?: unknown;
  /** Every SSE frame in received order, including non-JSON and terminal frames. */
  events?: ChatAuditSseEvent[];
}
export interface ChatAuditSseEvent {
  event?: string;
  id?: string;
  data: string;
  json?: unknown;
}
export interface ChatAuditTransportSummary {
  ordinal: number;
  classification: 'model-json' | 'auxiliary-json';
  /** Credentials, search parameters and fragments are never retained. */
  endpoint: string;
  method: string;
  startedAt: string;
  endedAt?: string;
  statusCode?: number;
  contentType?: string;
  error?: string;
  request: ChatAuditBodySummary;
  response: ChatAuditBodySummary;
}
export interface ChatAuditTransport extends Omit<ChatAuditTransportSummary, 'request' | 'response'> {
  request: ChatAuditBody;
  response: ChatAuditBody;
}
export interface ChatAuditSummary {
  recordId: string;
  /** Original Session identity is preserved when a conversation is imported. */
  sessionId: string;
  /** Current storage/authorization owner, including for imported records. */
  storageSessionId: string;
  userSeqs: number[];
  userMessageIds: string[];
  turn: number | null;
  step: number | null;
  attempt: number;
  nativeAttemptId?: string;
  /** web-search: the model call a search provider made inside one web_search tool call (DeepSeek search is a
   * Messages request with a server-side search tool); toolCallId names that call. */
  purpose: 'conversation' | 'compaction' | 'session-title' | 'web-search';
  toolCallId?: string;
  provider: string;
  model: string;
  startedAt: string;
  endedAt?: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  wireStatus: 'available' | 'partial' | 'unavailable';
  error?: string;
  importedAt?: string;
  transports: ChatAuditTransportSummary[];
}
export interface ChatAuditRecord extends Omit<ChatAuditSummary, 'transports'> {
  /** Supplementary debug input; this is explicitly not a provider wire body. */
  request: { representation: 'provider-neutral'; body: unknown };
  transports: ChatAuditTransport[];
}
export interface ChatAuditIndex {
  sessionId: string;
  status: 'available' | 'unavailable';
  reason?: 'no-captured-records';
  records: ChatAuditSummary[];
}
export interface ChatAuditArchive { version: 1; sessionId: string; records: ChatAuditRecord[] }
export interface ChatAuditPosition {
  turn: number | null;
  step: number | null;
  userSeqs: number[];
  userMessageIds: string[];
  nativeAttemptId?: string;
}
