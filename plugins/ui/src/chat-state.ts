import { foldTextFrame, type ChatRecord, type ChatEvent, type ChatPacket, type ChatMetrics, type LiveAttempt } from '@harnessstudio/studio/chat-types';
import { autonomyMessageText, autonomySource } from './autonomy-model.ts';

export interface ChatState { chat?: ChatRecord; events: ChatEvent[]; live: LiveAttempt[]; status: string; error?: string; metrics?: ChatMetrics }
export const emptyChatState = (): ChatState => ({ events: [], live: [], status: 'stored' });
const mergeEvents = (events: readonly ChatEvent[]) => [...new Map(events.map(event => [event.seq, event])).values()].sort((a, b) => a.seq - b.seq);
export function foldChatPacket(previous: ChatState, packet: ChatPacket): ChatState {
  switch (packet.type) {
    case 'snapshot': return { chat: packet.chat, events: mergeEvents(packet.chat.events), live: packet.live, status: packet.chat.status, ...(packet.chat.metrics ? { metrics: packet.chat.metrics } : {}) };
    case 'metrics': return previous.metrics && previous.metrics.asOfSeq > packet.metrics.asOfSeq ? previous : { ...previous, metrics: packet.metrics };
    case 'event': return { ...previous, events: mergeEvents([...previous.events, packet.event]), live: packet.event.type === 'assistant/message' ? previous.live.filter(row => row.turn !== packet.event.data.turn || row.step !== packet.event.data.step) : previous.live };
    case 'frame': return { ...previous, live: foldTextFrame(previous.live, packet.frame) };
    case 'status': return { ...previous, status: packet.status };
    case 'error': return { ...previous, error: packet.error };
  }
}

export interface ToolTrace { id: string; name: string; arguments: string; result?: string; failed?: boolean; meta?: unknown;
  /** An actual official late answer; the original tool outcome remains unchanged. */
  questionReply?: string;
  /** Sanitized official error classification, never raw source/error metadata. */
  questionOutcome?: 'continued' | 'aborted';
}
const graphMutationTools = new Set(['studio_apply_graph_patch', 'studio_create_task', 'studio_update_checklist']);
const toolLabels: Record<string, string> = { studio_software_catalog: '查询软件镜像', studio_software_launch: '启动软件镜像', studio_software_status: '查看软件状态', studio_software_control: '交接软件控制', studio_software_invoke: '执行软件指令', studio_software_operation: '查看软件操作', studio_software_cancel: '取消软件操作', studio_software_save_artifact: '保存软件产物', ask_user_question: '澄清需求', web_search: '联网搜索', web_fetch: '读取网页', studio_browser_read: '浏览器读取网页', studio_download_temp_file: '下载网页文件到临时目录', studio_extract_temp_zip: '解压临时 ZIP', studio_graph_context: '查看当前任务图谱', studio_apply_graph_patch: '调整任务图谱', studio_create_task: '添加子任务', studio_task_context: '查看任务上下文', studio_retrieve_context: '检索工程上下文', studio_read_checklist: '查看验收清单', studio_update_checklist: '编辑验收清单', studio_list_project_files: '浏览项目文件', studio_read_project_file: '读取项目文件', studio_read_file: '读取任务文件', studio_write_file: '保存任务文件', studio_delete_file: '删除任务文件', studio_list_temp_files: '浏览对话临时文件', studio_read_temp_file: '读取对话临时文件', studio_write_temp_file: '保存对话临时文件', studio_search_temp_file: '搜索对话临时文件', skill: '读取技能', studio_skill_files: '读取技能文件' };
/** MCP tools are named mcp__<server>__<tool> by the native client. */
export const toolLabel = (name: string): string => toolLabels[name] ?? (/^mcp__([A-Za-z0-9_-]+?)__(.+)$/.exec(name)?.slice(1).join(' · ') ?? name);
export interface PendingToolCall { id: string; name: string }
/** Live execution comes from durable native calls, never model text or historical traces. */
export function pendingToolCalls(state: ChatState): PendingToolCall[] {
  if (state.status !== 'running') return [];
  let turn: number | undefined;
  const calls = new Map<string, { step: unknown; call: PendingToolCall }>();
  for (const event of state.events) {
    const data = event.data;
    if (event.type === 'turn/start') { turn = typeof data.turn === 'number' ? data.turn : undefined; calls.clear(); }
    if (event.type === 'tool/call' && turn !== undefined && data.turn === turn && typeof data.callId === 'string' && typeof data.name === 'string') calls.set(data.callId, { step: data.step, call: { id: data.callId, name: data.name } });
    if (event.type === 'tool/result' && data.turn === turn) {
      const id = String(record(data.message).callId), pending = calls.get(id);
      if (pending && (data.step === undefined || pending.step === data.step)) calls.delete(id);
    }
    if (event.type === 'turn/end' && data.turn === turn) { turn = undefined; calls.clear(); }
  }
  return [...calls.values()].map(pending => pending.call);
}
export interface WorkspaceUpdateCursor { chatId?: string; results: number[] }
/** Successful durable tool results refresh the graph while the model is still replying. */
export function observeWorkspaceUpdates(previous: WorkspaceUpdateCursor, state: ChatState, chatId?: string): { cursor: WorkspaceUpdateCursor; changed: boolean } {
  if (!chatId || state.chat?.id !== chatId) return { cursor: previous, changed: false };
  const calls = new Map<string, Array<{ turn: unknown; step: unknown; name: string }>>(), results: number[] = [];
  for (const event of state.events) {
    if (event.type === 'tool/call') {
      const id = String(event.data.callId), history = calls.get(id) ?? [];
      history.push({ turn: event.data.turn, step: event.data.step, name: String(event.data.name) }); calls.set(id, history);
    }
    if (event.type !== 'tool/result') continue;
    const message = record(event.data.message), call = calls.get(String(message.callId))?.findLast(candidate =>
      (typeof event.data.turn !== 'number' || candidate.turn === event.data.turn) && (typeof event.data.step !== 'number' || candidate.step === event.data.step));
    if (graphMutationTools.has(call?.name ?? '') && message.isError !== true) results.push(event.seq);
  }
  const known = new Set(previous.chatId === chatId ? previous.results : []), fresh = results.filter(seq => !known.has(seq));
  return { cursor: { chatId, results: [...new Set([...known, ...results])] }, changed: fresh.length > 0 };
}
export interface GraphActivity { id: string; status: 'pending' | 'complete' | 'failed'; summary: string }
export function graphActivities(steps: readonly ConversationStep[]): GraphActivity[] {
  return steps.flatMap(step => step.tools.flatMap(tool => {
    if (!graphMutationTools.has(tool.name)) return [];
    const status = tool.failed ? 'failed' : tool.result === undefined ? 'pending' : 'complete';
    if (tool.name === 'studio_update_checklist') return [{ id: tool.id, status, summary: status === 'pending' ? '正在更新验收清单…' : status === 'failed' ? '验收清单未更新，可展开思考过程查看详情。' : '验收清单已更新' } satisfies GraphActivity];
    let result: Record<string, unknown> = {};
    try { result = record(JSON.parse(tool.result ?? '')); } catch { /* The original tool result remains available in the trace. */ }
    const counts = [['created', '新增'], ['updated', '更新'], ['moved', '移动'], ['dependencies', '调整依赖']].flatMap(([key, label]) => Array.isArray(result[key]) && result[key].length ? [`${label} ${result[key].length} 项`] : []);
    return [{ id: tool.id, status, summary: status === 'pending' ? '正在调整当前图谱…' : status === 'failed' ? '调整未完成，可展开思考过程查看详情。' : counts.length ? counts.join(' · ') : tool.name === 'studio_create_task' ? '已添加子任务' : '图谱已更新' } satisfies GraphActivity];
  }));
}
export interface ConversationStep { id: string; number: number; reasoning: string[]; text: string[]; tools: ToolTrace[]; streaming: boolean }
export interface ConversationImage { attachmentId: string; name?: string; uploadId?: string }
export type ConversationRow = { id: string; role: 'user'; text: string; images?: ConversationImage[] } | { id: string; role: 'assistant'; turn: number; steps: ConversationStep[]; interrupted?: boolean; notice?: string }
  /** An instruction from the orchestrator or a notice from the autonomy controller: written by Studio, never by the person. */
  | { id: string; role: 'autonomy'; from: 'orchestrator' | 'controller'; text: string };
export interface QuestionAnswerActivity { id: string; question: string; header?: string; selected: string[]; custom?: string; skipped?: boolean }
export interface QuestionActivity { id: string; status: 'complete' | 'failed'; summary: string; questions: QuestionAnswerActivity[] }
function jsonRecord(value: string | undefined): Record<string, unknown> {
  if (value === undefined || value.length > 131072) return {};
  try { return record(JSON.parse(value)); } catch { return {}; }
}
/** Interpret real native tool batches, never assistant prose or result metadata. */
function questionAnswers(argumentsText: string, resultText: string | undefined): QuestionAnswerActivity[] | undefined {
  const questions = jsonRecord(argumentsText).questions, payload = jsonRecord(resultText);
  if (!Array.isArray(questions) || !questions.length || questions.length > 12 || payload.pending === true || !Array.isArray(payload.answers) || payload.answers.length !== questions.length) return;
  const answers = new Map<string, Record<string, unknown>>();
  for (const raw of payload.answers) {
    const answer = record(raw);
    if (typeof answer.id !== 'string' || answers.has(answer.id)) return;
    answers.set(answer.id, answer);
  }
  const seen = new Set<string>(), output: QuestionAnswerActivity[] = [];
  for (const raw of questions) {
    const question = record(raw), answer = typeof question.id === 'string' ? answers.get(question.id) : undefined;
    if (typeof question.id !== 'string' || !question.id.trim() || question.id.length > 128 || seen.has(question.id)
      || typeof question.question !== 'string' || !question.question.trim() || question.question.length > 4096 || !answer
      || question.header !== undefined && (typeof question.header !== 'string' || !question.header.trim() || question.header.length > 128)) return;
    seen.add(question.id);
    const options = question.options === undefined ? [] : question.options;
    if (!Array.isArray(options) || options.length > 30 || !Array.isArray(answer.selected) || answer.selected.length > options.length) return;
    const labels = options.map(option => record(option).label);
    if (labels.some(label => typeof label !== 'string' || !label.trim() || label.length > 256) || new Set(labels).size !== labels.length
      || answer.selected.some(label => typeof label !== 'string' || !labels.includes(label)) || new Set(answer.selected).size !== answer.selected.length) return;
    if (answer.custom !== undefined && (typeof answer.custom !== 'string' || !answer.custom.trim() || answer.custom.length > 8192)) return;
    // Tool arguments use multi_select; a late reply is checked against those
    // original arguments, rather than the duplicated questions in its payload.
    if (question.multi_select !== true && (answer.selected.length > 1 || answer.selected.length && answer.custom !== undefined)) return;
    output.push({ id: question.id, question: question.question, ...(typeof question.header === 'string' ? { header: question.header } : {}), selected: [...answer.selected] as string[],
      ...(typeof answer.custom === 'string' ? { custom: answer.custom } : {}), ...(!answer.selected.length && answer.custom === undefined ? { skipped: true } : {}) });
  }
  return output;
}
/** Historical answered questions are separate from the live pending question form. */
export function questionActivities(steps: readonly ConversationStep[]): QuestionActivity[] {
  return steps.flatMap<QuestionActivity>(step => step.tools.flatMap<QuestionActivity>(tool => {
    if (tool.name !== 'ask_user_question') return [];
    if (tool.questionOutcome === 'aborted') return [{ id: tool.id, status: 'failed', summary: '澄清已停止', questions: [] }];
    const questions = questionAnswers(tool.arguments, tool.questionReply ?? (tool.failed ? undefined : tool.result));
    if (questions) return [{ id: tool.id, status: 'complete', summary: `已回答 ${questions.length} 项澄清问题`, questions } satisfies QuestionActivity];
    if (tool.questionOutcome === 'continued') return [];
    if (tool.failed) return [{ id: tool.id, status: 'failed', summary: /\bASK_ABORTED\b/.test(tool.result ?? '') ? '澄清已停止' : '澄清已结束', questions: [] } satisfies QuestionActivity];
    return [];
  }));
}
export interface WebSource { url: string; title?: string; snippet?: string; publishedAt?: string }
export interface WebActivity {
  id: string; kind: 'search' | 'fetch'; label: string; status: 'pending' | 'complete' | 'failed';
  sources: WebSource[]; truncated: boolean; statusCode?: number; artifact?: { path: string; bytes: number };
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
/** External citations may only open absolute HTTP(S) URLs, including on replay. */
export function safeWebUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value.trim())) return;
  try { const url = new URL(value.trim()); return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined; } catch { return; }
}
/** Keep web evidence outside the collapsed thought tree without parsing tool prose. */
export function webActivities(steps: readonly ConversationStep[]): WebActivity[] {
  return steps.flatMap(step => step.tools.flatMap(tool => {
    if (tool.name !== 'web_search' && tool.name !== 'web_fetch') return [];
    const kind = tool.name === 'web_search' ? 'search' : 'fetch', meta = record(tool.meta);
    let args: Record<string, unknown> = {};
    try { args = record(JSON.parse(tool.arguments)); } catch { /* A partial call can still show its pending state. */ }
    const label = kind === 'search' ? (Array.isArray(args.queries) ? args.queries.filter(query => typeof query === 'string').join(' · ') : '') : typeof args.url === 'string' ? args.url : '';
    const rawSources = kind === 'search' ? Array.isArray(meta.sources) ? meta.sources : [] : typeof meta.url === 'string' ? [{ url: meta.url }] : [];
    const sources = tool.failed ? [] : rawSources.flatMap(value => {
      const source = record(value), url = safeWebUrl(source.url);
      if (!url) return [];
      return [{ url, ...typeof source.title === 'string' ? { title: source.title } : {}, ...typeof source.snippet === 'string' ? { snippet: source.snippet } : {}, ...typeof source.publishedAt === 'string' ? { publishedAt: source.publishedAt } : {} }];
    });
    const artifact = record(meta.studioArtifact);
    return [{ id: tool.id, kind, label, status: tool.failed ? 'failed' : tool.result === undefined ? 'pending' : 'complete', sources, truncated: meta.truncated === true,
      ...typeof meta.statusCode === 'number' && Number.isFinite(meta.statusCode) ? { statusCode: meta.statusCode } : {},
      ...typeof artifact.path === 'string' && typeof artifact.bytes === 'number' && Number.isFinite(artifact.bytes) && artifact.bytes >= 0 ? { artifact: { path: artifact.path, bytes: artifact.bytes } } : {},
    } satisfies WebActivity];
  }));
}
function blocks(content: unknown, kind: 'text' | 'reasoning'): string[] {
  if (typeof content === 'string') return kind === 'text' ? [content] : [];
  return Array.isArray(content) ? content.flatMap(value => { const row = record(value); return row.type === kind && typeof row.text === 'string' ? [row.text] : []; }) : [];
}
/** Only immutable native image references may become history thumbnails. */
function nativeImage(value: unknown): ConversationImage | undefined {
  const block = record(value), attachment = record(block.attachment);
  if (block.type !== 'image' || typeof attachment.attachmentId !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(attachment.attachmentId)) return;
  return { attachmentId: attachment.attachmentId, ...(typeof attachment.name === 'string' && attachment.name.trim() && attachment.name.length <= 512 ? { name: attachment.name } : {}) };
}
/** The owned attachment service emits these complete blocks directly before native images. */
function attachmentMarker(value: string): string | undefined {
  const marker = /^\n\[用户提供的参考文件：([^\u0000-\u001f\u007f]{1,255})；附件 ID ([0-9a-f]{32})；(?:以下为实际提供给模型的参考图片；图中尺寸与设计约束仍需向用户确认。|PDF 已转换为 [1-6] 页图片，供视觉对齐；不代表 CAD 几何或精确尺寸解析。)\]\n$/.exec(value);
  return marker?.[2];
}
function userContent(content: unknown): { text: string; images: ConversationImage[] } {
  if (!Array.isArray(content)) return { text: blocks(content, 'text').join('\n'), images: [] };
  const text: string[] = [], images: ConversationImage[] = [];
  let uploadId: string | undefined;
  for (let index = 0; index < content.length; index++) {
    const value = content[index], block = record(value), image = nativeImage(value);
    if (image) { images.push({ ...image, ...(uploadId === undefined ? {} : { uploadId }) }); continue; }
    // Never strip a user's ordinary text, a partial marker or a marker without
    // its immediately adjacent valid native image. Do not change LLM content.
    uploadId = undefined;
    if (block.type === 'text' && typeof block.text === 'string') {
      const marker = attachmentMarker(block.text);
      if (marker && nativeImage(content[index + 1])) uploadId = marker;
      else text.push(block.text);
    }
  }
  return { text: text.join('\n'), images };
}
export function conversationRows(state: ChatState): ConversationRow[] {
  const rows: ConversationRow[] = [], turns = new Map<number, Extract<ConversationRow, { role: 'assistant' }>>();
  const tools = new Map<string, Array<{ turn: number; step: number; trace: ToolTrace }>>();
  const toolTrace = (id: string, turn?: unknown, number?: unknown) => tools.get(id)?.findLast(call =>
    (typeof turn !== 'number' || call.turn === turn) && (typeof number !== 'number' || call.step === number))?.trace;
  const assistant = (turn: number) => {
    let row = turns.get(turn);
    if (!row) { row = { id: `turn-${turn}`, role: 'assistant', turn, steps: [] }; turns.set(turn, row); rows.push(row); }
    return row;
  };
  const step = (turn: number, number: number) => {
    const row = assistant(turn); let part = row.steps.find(item => item.number === number);
    if (!part) { part = { id: `${turn}-${number}`, number, reasoning: [], text: [], tools: [], streaming: false }; row.steps.push(part); }
    return part;
  };
  let currentTurn = 0;
  for (const event of state.events) {
    const data = event.data, message = record(data.message);
    if (event.type === 'turn/start' && typeof data.turn === 'number') currentTurn = data.turn;
    if (event.type === 'user/message' && record(data.source).kind === 'user') {
      const { text, images } = userContent(data.content);
      rows.push({ id: `user-${event.seq}`, role: 'user', text, ...(images.length ? { images } : {}) });
    }
    const automated = event.type === 'user/message' ? autonomySource(data.source) : undefined;
    if (automated) rows.push({ id: `autonomy-${event.seq}`, role: 'autonomy', from: automated.from, text: autonomyMessageText(userContent(data.content).text) });
    if (event.type === 'user/message' && record(data.source).kind === 'user-question-reply') {
      const source = record(data.source), trace = toolTrace(String(source.callId)), reply = jsonRecord(blocks(data.content, 'text').join('\n'));
      const outcome = jsonRecord(trace?.result);
      if (trace?.name === 'ask_user_question' && reply.kind === 'answer_to_pending_question' && reply.tool === 'ask_user_question' && reply.callId === source.callId
        && trace.questionOutcome !== 'aborted' && (outcome.pending === true || trace.questionOutcome === 'continued')) {
        const answers = questionAnswers(trace.arguments, JSON.stringify({ answers: reply.answers }));
        if (answers) trace.questionReply = JSON.stringify({ answers: answers.map(answer => ({ id: answer.id, selected: answer.selected, ...(answer.custom !== undefined ? { custom: answer.custom } : {}) })) });
      }
    }
    if (event.type === 'assistant/message') {
      const part = step(Number(data.turn ?? currentTurn), Number(data.step ?? 1));
      part.text.push(...blocks(message.content, 'text')); part.reasoning.push(...blocks(message.content, 'reasoning'));
      if (data.interrupted) assistant(Number(data.turn ?? currentTurn)).interrupted = true;
    }
    if (event.type === 'tool/call') {
      const trace: ToolTrace = { id: String(data.callId), name: String(data.name), arguments: String(data.arguments ?? '') };
      const turn = Number(data.turn ?? currentTurn), number = Number(data.step ?? 1), calls = tools.get(trace.id) ?? [];
      calls.push({ turn, step: number, trace }); tools.set(trace.id, calls); step(turn, number).tools.push(trace);
    }
    if (event.type === 'tool/result') {
      // Provider IDs can repeat in another call. Native turn/step coordinates
      // keep a late result on its original step; legacy unscoped events use
      // only the latest preceding call rather than inventing coordinates.
      const trace = toolTrace(String(message.callId), data.turn, data.step);
      if (trace) { trace.result = blocks(message.content, 'text').join('\n'); trace.failed = message.isError === true; trace.meta = message.meta;
        if (message.questionOutcome === 'continued' || message.questionOutcome === 'aborted') trace.questionOutcome = message.questionOutcome;
      }
    }
    if (event.type === 'turn/end') {
      const reason = record(data.reason);
      if (reason.kind === 'error') assistant(Number(data.turn)).notice = '本轮生成失败，可以重试。';
    }
  }
  for (const attempt of state.live) {
    // Durable settlement wins over a reconnect snapshot containing the same transient prefix.
    if (state.events.some(event => event.type === 'assistant/message' && event.data.turn === attempt.turn && event.data.step === attempt.step)) continue;
    const part = step(attempt.turn, attempt.step); part.streaming = true;
    for (const block of [...attempt.parts].sort((a, b) => a.index - b.index)) (block.type === 'reasoning' ? part.reasoning : part.text).push(block.text);
  }
  for (const row of turns.values()) row.steps.sort((a, b) => a.number - b.number);
  return rows.filter(row => row.role !== 'assistant' || row.steps.some(part => part.reasoning.length || part.text.length || part.tools.length || part.streaming) || row.notice);
}
const sameList = <T>(a: readonly T[], b: readonly T[], same: (x: T, y: T) => boolean = Object.is) => a.length === b.length && a.every((value, index) => same(value, b[index]!));
const sameImage = (a: ConversationImage, b: ConversationImage) => a.attachmentId === b.attachmentId && a.name === b.name && a.uploadId === b.uploadId;
const sameTool = (a: ToolTrace, b: ToolTrace) => a.id === b.id && a.name === b.name && a.arguments === b.arguments && a.result === b.result && a.failed === b.failed
  && a.meta === b.meta && a.questionReply === b.questionReply && a.questionOutcome === b.questionOutcome;
const sameStep = (a: ConversationStep, b: ConversationStep) => a.id === b.id && a.number === b.number && a.streaming === b.streaming
  && sameList(a.reasoning, b.reasoning) && sameList(a.text, b.text) && sameList(a.tools, b.tools, sameTool);
/** Keep unchanged rows and model calls identical across folds, so a stream frame or a keystroke re-renders only what changed. */
export function reuseRows(previous: readonly ConversationRow[], next: ConversationRow[]): ConversationRow[] {
  if (!previous.length) return next;
  const known = new Map(previous.map(row => [row.id, row]));
  const rows = next.map(row => {
    const prior = known.get(row.id);
    if (row.role === 'user') return prior?.role === 'user' && prior.text === row.text && sameList(prior.images ?? [], row.images ?? [], sameImage) ? prior : row;
    if (row.role === 'autonomy') return prior?.role === 'autonomy' && prior.text === row.text && prior.from === row.from ? prior : row;
    if (prior?.role !== 'assistant') return row;
    const steps = new Map(prior.steps.map(step => [step.id, step]));
    const reused = row.steps.map(step => { const match = steps.get(step.id); return match && sameStep(match, step) ? match : step; });
    return prior.turn === row.turn && prior.interrupted === row.interrupted && prior.notice === row.notice && sameList(prior.steps, reused) ? prior : { ...row, steps: reused };
  });
  return sameList(previous, rows) ? previous as ConversationRow[] : rows;
}
