/** One time-ordered trajectory of a whole project, merged from Studio, vm_manager and the in-VM recorder.
 * Every time is an absolute UTC instant. Studio and vm_manager stamp on the host; the recorder stamps on the VM
 * clock, which is corrected per recording by a measured offset. Each Agent action on a VM appears once (its
 * operation ID joins the chat tool call, Studio's operation log and the VM's request log); "gap" events mark
 * periods that should have been recorded but were not. */

export type Actor = 'human' | 'agent' | 'system';
export interface TimelineRef { file: string; line?: number; seq?: number }
export interface TimelineEvent {
  projectId?: string; t: string; tMs: number; end?: string; endMs?: number;
  type: string; actor: Actor; summary: string;
  taskId?: string; chatId?: string; vmId?: string; recordingId?: string; operationId?: string; callId?: string;
  detail?: Record<string, unknown>; ref?: TimelineRef;
  /** Set on events stamped by the VM clock: the offset (VM minus host) removed from their time. */
  vmClockOffsetMs?: number;
}

export interface ChatSource { chatId: string; taskId?: string; file: string; events: readonly { seq: number; type: string; time?: number; data?: unknown }[] }
export interface ActivitySource { file: string; line: number; event: { atMs: number; actor: string; source: string; action: string; ok: boolean; error?: string; taskId?: string; chatId?: string; vmId?: string; request?: unknown; before?: unknown; after?: unknown; result?: unknown } }
export interface OperationSource { file: string; line: number; taskId: string; row: Record<string, unknown> }
export interface StepSource { line: number; step: { id: number; time: string; actor: 'agent' | 'human' | null; action: string; window: string | null; operation: { id: string } | null; files: string[]; milestone: string | null } }
export interface RecordingSource {
  taskId: string; vmId: string; recordingId: string; folder: string; row: Record<string, unknown>;
  steps: StepSource[]; requests: { operation: string; startMs: number; endMs: number }[];
  /** First recorder event (recording_start), VM clock. */
  startMs: number | null; trajectory: boolean; finished: boolean;
}
export interface VmSource { taskId: string; vmId: string; file: string; detail: Record<string, unknown> | null }
export interface TaskSource { taskId: string; file: string; createdAt: string; title: string; snapshots: { id: string; createdAt: string; confirmedAt?: string; confirmedBy?: 'agent'; agent?: { runId: string; chatId: string; provider: string; model: string }; file?: string }[]; reviews: { id: string; action: string; createdAt: string; actor: string }[] }
/** One autonomy run's own events (run.json), merged with the activity log's autonomy/* entries without repeating them. */
export interface AutonomySource { runId: string; file: string; events: readonly { seq: number; at: string; type: string; summary: string; page?: string; chatId?: string; taskId?: string; data?: Record<string, unknown> }[] }
export interface TimelineSources { tasks: TaskSource[]; activities: ActivitySource[]; chats: ChatSource[]; operations: OperationSource[]; vms: VmSource[]; recordings: RecordingSource[]; autonomy?: AutonomySource[] }

export interface ClockOffset { recordingId: string; vmId: string; offsetMs: number | null; uncertaintyMs: number | null; method: 'agent-requests' | 'recording-start' | 'none'; applied: boolean; samples: number }

const ms = (value: unknown) => typeof value === 'string' ? Date.parse(value) : typeof value === 'number' ? value : NaN;
const iso = (value: number) => new Date(value).toISOString();
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2; };
/** Autonomy run actions (autonomy/*): people's run-panel requests and the run's own steps. */
const AUTONOMY_ACTIONS: Record<string, [human: string, agent: string]> = {
  start: ['启动自主运行', '启动自主运行'], pause: ['暂停自主运行', '自主运行自动暂停'], resume: ['继续自主运行', '自主运行继续'], stop: ['停止自主运行', '自主运行已停止'],
  update: ['修改自主运行的目标或预算', '修改自主运行'], settings: ['修改自主模式默认设置', '修改自主模式默认设置'], 'attention/resolve': ['处理自主运行的“需要人”事项', '处理“需要人”事项'],
  'start-worker': ['派出子 Agent', '总 Agent 派出子 Agent'], 'stop-worker': ['停止子 Agent', '停止子 Agent'], report: ['子 Agent 报告', '子 Agent 报告'],
  attention: ['自主运行需要人处理', '自主运行需要人处理'], complete: ['自主运行完成', '自主运行完成'], blocked: ['自主运行受阻', '总 Agent 报告目标受阻'], end: ['自主运行结束', '自主运行结束'],
};
function autonomySummary(action: string, agent: boolean, request: unknown): string {
  const [name, detail] = action.slice('autonomy/'.length).split(':'), labels = AUTONOMY_ACTIONS[name!];
  const data = request && typeof request === 'object' ? request as Record<string, unknown> : {};
  const extra = typeof data.message === 'string' ? `：${clip(data.message, 200)}` : typeof data.reason === 'string' ? `（${clip(data.reason, 120)}）` : '';
  const choice = detail ? { accept: '接受结果', continue: '让它继续', resolved: '已处理', 'stop-worker': '停止子 Agent' }[detail] ?? detail : '';
  return `${labels ? labels[agent ? 1 : 0] : `自主运行 ${action}`}${choice ? `：${choice}` : ''}${extra}`;
}
const clip = (value: unknown, limit = 300) => { const text = typeof value === 'string' ? value : JSON.stringify(value) ?? ''; return text.length > limit ? `${text.slice(0, limit)}…` : text; };

/** Run events the activity log records as autonomy/<action> (people's run-panel requests and the run's own steps).
 * A run event matches one such entry of the same run (or conversation) close in time; unmatched ones, such as the
 * pause after a restart or a question closed by its answer, come from run.json. */
const LOGGED: Record<string, string[]> = {
  started: ['start'], paused: ['pause'], resumed: ['resume'], stopped: ['stop'], completed: ['complete'], failed: ['end', 'start'], blocked: ['blocked'],
  'worker-started': ['start-worker'], 'worker-stopped': ['stop-worker'], 'worker-reported': ['report'], 'attention-opened': ['attention'], 'attention-resolved': ['attention/resolve'],
};
/** Run events whose fact the timeline has from elsewhere: completions (task snapshots and task/agent-complete), people's
 * edits (their own requests), the orchestrator's instructions (the worker conversation's message). */
const ELSEWHERE = new Set(['task-completed', 'human-edit', 'worker-message']);
const AGENT_EVENTS = new Set(['worker-settled', 'worker-reported', 'objective-changed']);
const MATCH_WINDOW_MS = 30_000;
function autonomyEvents(runs: readonly AutonomySource[], activities: readonly ActivitySource[]): { events: Omit<TimelineEvent, 't' | 'end'>[]; matched: number } {
  const used = new Set<ActivitySource>(), result: Omit<TimelineEvent, 't' | 'end'>[] = []; let matched = 0;
  const logged = activities.filter(source => source.event.action.startsWith('autonomy/'));
  for (const run of runs) for (const event of run.events) {
    if (ELSEWHERE.has(event.type)) continue;
    const atMs = ms(event.at), names = LOGGED[event.type];
    if (names) {
      let best: ActivitySource | undefined, distance = Infinity;
      for (const source of logged) {
        if (used.has(source)) continue;
        const [name] = source.event.action.slice('autonomy/'.length).split(':'), request = record(source.event.request);
        // Agent steps carry runId; panel requests carry the run as id; a start request has neither (the run is new).
        const runId = typeof request.runId === 'string' ? request.runId : typeof request.id === 'string' ? request.id : undefined;
        if (!names.includes(name!) || runId !== undefined && runId !== run.runId || event.chatId && source.event.chatId && source.event.chatId !== event.chatId) continue;
        const gap = Math.abs(source.event.atMs - atMs);
        if (gap <= MATCH_WINDOW_MS && gap < distance) { best = source; distance = gap; }
      }
      if (best) { used.add(best); matched++; continue; }
    }
    result.push({ tMs: atMs, type: `autonomy.${event.type}`, actor: AGENT_EVENTS.has(event.type) ? 'agent' : 'system', summary: `自主运行：${clip(event.page ?? event.summary)}`,
      ...(event.taskId ? { taskId: event.taskId } : {}), ...(event.chatId ? { chatId: event.chatId } : {}),
      detail: { runId: run.runId, seq: event.seq, ...(event.data ? { data: event.data } : {}) }, ref: { file: run.file, seq: event.seq } });
  }
  return { events: result, matched };
}
const textOf = (content: unknown): string => typeof content === 'string' ? content : Array.isArray(content)
  ? content.map(block => block && typeof block === 'object' && (block as { type?: string }).type === 'text' ? String((block as { text?: string }).text ?? '') : '').join('') : '';
const record = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** VM minus host clock for one recording. The Studio operation log stamps an Agent request on the host before it is
 * sent and its duration after the reply; the VM logs when it received and finished the same request. The true offset
 * lies between the median start difference and the median end difference. Without Agent requests the first recorder
 * event is compared with vm_manager's start of the recording, which includes the recorder's startup (seconds). Only a
 * precise offset, or an obvious clock error over a minute, is applied. */
export function clockOffset(recording: RecordingSource, operations: Map<string, { atMs: number; endMs: number }>): ClockOffset {
  const starts: number[] = [], ends: number[] = [];
  for (const request of recording.requests) {
    const operation = operations.get(request.operation); if (!operation) continue;
    starts.push(request.startMs - operation.atMs); ends.push(request.endMs - operation.endMs);
  }
  const base = { recordingId: recording.recordingId, vmId: recording.vmId };
  if (starts.length) {
    const high = median(starts), low = median(ends), offset = Math.round((high + low) / 2);
    return { ...base, offsetMs: offset, uncertaintyMs: Math.max(0, Math.round(Math.abs(high - low) / 2)), method: 'agent-requests', applied: true, samples: starts.length };
  }
  const started = ms(recording.row.started_at);
  if (recording.startMs !== null && Number.isFinite(started)) {
    const offset = recording.startMs - started;
    return { ...base, offsetMs: offset, uncertaintyMs: 15000, method: 'recording-start', applied: Math.abs(offset) > 60000, samples: 1 };
  }
  return { ...base, offsetMs: null, uncertaintyMs: null, method: 'none', applied: false, samples: 0 };
}

const VM_TOOLS: Record<string, string> = { input: 'studio_vm_input', run: 'studio_vm_run', launch: 'studio_vm_launch', screenshot: 'studio_vm_screenshot', ui_tree: 'studio_vm_ui_tree', open_file: 'studio_vm_open_file', milestone: 'studio_vm_milestone',
  job_start: 'studio_vm_run', job_status: 'studio_vm_job_status', job_list: 'studio_vm_job_status', job_cancel: 'studio_vm_job_cancel' };
const toolOf = (operationTool: string) => VM_TOOLS[operationTool] ?? (operationTool.startsWith('window') ? 'studio_vm_window' : `studio_vm_${operationTool}`);

export function buildTimeline(projectId: string, sources: TimelineSources): { events: TimelineEvent[]; clocks: ClockOffset[] } {
  const events: TimelineEvent[] = [];
  const push = (event: Omit<TimelineEvent, 't' | 'end'> & { tMs: number; endMs?: number }) => {
    if (!Number.isFinite(event.tMs)) return;
    events.push({ t: iso(event.tMs), ...(event.endMs !== undefined && Number.isFinite(event.endMs) ? { end: iso(event.endMs) } : {}), ...event });
  };

  for (const task of sources.tasks) {
    push({ tMs: ms(task.createdAt), type: 'task.created', actor: 'human', summary: `创建任务：${task.title}`, taskId: task.taskId, ref: { file: task.file } });
    for (const snapshot of task.snapshots) {
      push({ tMs: ms(snapshot.createdAt), type: 'task.snapshot', actor: 'system', summary: '生成任务快照（D 盘冻结时的文件）', taskId: task.taskId, detail: { snapshotId: snapshot.id }, ref: { file: snapshot.file ?? task.file } });
      // Autonomy mode lets an Agent confirm a completion; its record names the run, conversation and model.
      const byAgent = snapshot.confirmedBy === 'agent', agent = byAgent ? snapshot.agent : undefined;
      if (snapshot.confirmedAt) push({ tMs: ms(snapshot.confirmedAt), type: 'task.completed', actor: byAgent ? 'agent' : 'human', summary: byAgent ? 'Agent 确认任务完成' : '人工确认任务完成', taskId: task.taskId,
        ...(agent?.chatId ? { chatId: agent.chatId } : {}), detail: { snapshotId: snapshot.id, ...(agent ? { runId: agent.runId, provider: agent.provider, model: agent.model } : {}) }, ref: { file: task.file } });
    }
    for (const review of task.reviews) push({ tMs: ms(review.createdAt), type: `task.review.${review.action}`, actor: 'human', summary: `复核：${review.action}`, taskId: task.taskId, detail: { reviewId: review.id, by: review.actor }, ref: { file: task.file } });
  }

  // A message or question answer sent from the page is already in its conversation; the request itself only adds a
  // duplicate unless it failed before reaching the conversation.
  const exported = new Set(sources.chats.map(chat => chat.chatId));
  for (const { file, line, event } of sources.activities) {
    if (event.ok && event.chatId && exported.has(event.chatId) && (event.action === 'chat' || event.action === 'chat/questions/answer')) continue;
    push({ tMs: event.atMs, type: event.source === 'agent-tool' ? `agent.${event.action}` : `web.${event.action}`, actor: event.actor === 'agent' ? 'agent' : 'human',
      summary: event.action === 'sandbox_exec' ? `Agent 在沙箱中运行命令：${clip(String((event.request as { command?: unknown } | undefined)?.command ?? ''), 200)}${event.ok ? '' : `（失败：${clip(event.error, 120)}）`}`
        : event.action === 'task/agent-complete' ? `Agent 确认任务完成${event.ok ? '' : `（失败：${clip(event.error, 120)}）`}`
        : event.action.startsWith('autonomy/') ? `${autonomySummary(event.action, event.actor === 'agent', event.request)}${event.ok ? '' : `（失败：${clip(event.error, 120)}）`}`
        : `${event.source === 'agent-tool' ? 'Agent 文件操作' : '网页操作'} ${event.action}${event.ok ? '' : `（失败：${clip(event.error, 120)}）`}`,
      ...(event.taskId ? { taskId: event.taskId } : {}), ...(event.chatId ? { chatId: event.chatId } : {}), ...(event.vmId ? { vmId: event.vmId } : {}),
      detail: { ok: event.ok, request: event.request, before: event.before, after: event.after, ...(event.action === 'sandbox_exec' && event.result !== undefined ? { result: event.result } : {}) }, ref: { file, line } });
  }

  // Agent operations on VMs: one event each, joined with the chat tool call that issued it.
  const operations = new Map<string, { atMs: number; endMs: number }>(), matchedCalls = new Set<string>();
  const callsByChat = new Map<string, { callId: string; name: string; time: number; seq: number }[]>();
  for (const chat of sources.chats) callsByChat.set(chat.chatId, chat.events.flatMap(event => event.type === 'tool/call' && typeof event.time === 'number'
    ? [{ callId: String(record(event.data).callId ?? ''), name: String(record(event.data).name ?? ''), time: event.time, seq: event.seq }] : []));
  for (const { file, line, taskId, row } of sources.operations) {
    const id = String(row.operation ?? ''), atMs = ms(row.at), endMs = atMs + (typeof row.durationMs === 'number' ? row.durationMs : 0), chatId = typeof row.chatId === 'string' ? row.chatId : undefined;
    if (!id || !Number.isFinite(atMs)) continue;
    operations.set(id, { atMs, endMs });
    const tool = toolOf(String(row.tool ?? '')), call = chatId ? callsByChat.get(chatId)?.filter(item => item.name === tool && !matchedCalls.has(item.callId) && item.time <= atMs + 1000 && item.time >= atMs - 120000).at(-1) : undefined;
    if (call) matchedCalls.add(call.callId);
    // kind human: a person acted on the VM from the software area (stopping a background job).
    const human = row.kind === 'human';
    push({ tMs: atMs, endMs, type: human ? 'human.vm_operation' : 'agent.vm_operation', actor: human ? 'human' : 'agent', summary: `${human ? '用户在软件区' : 'Agent 在虚拟机中'}执行 ${row.tool}：${clip(row.summary, 200)}${row.ok === false ? `（失败：${clip(row.error, 120)}）` : ''}`,
      taskId, ...(chatId ? { chatId } : {}), ...(typeof row.vmId === 'string' ? { vmId: row.vmId } : {}), operationId: id, ...(call ? { callId: call.callId } : {}),
      detail: { tool: row.tool, kind: row.kind, ok: row.ok, ...(row.typedText ? { typedText: row.typedText } : {}), ...(row.actions ? { actions: row.actions } : {}) }, ref: { file, line } });
  }

  for (const chat of sources.chats) {
    const results = new Map<string, boolean>(), names = new Map<string, string>();
    // A tool result names its call in message.callId, or in its source for results DSH routes back (answers).
    const resultCall = (message: Record<string, unknown>) => String(record(message.source).callId ?? message.callId ?? '');
    for (const event of chat.events) {
      if (event.type === 'tool/result') { const message = record(record(event.data).message); results.set(resultCall(message), message.isError === true); }
      else if (event.type === 'tool/call') names.set(String(record(event.data).callId ?? ''), String(record(event.data).name ?? ''));
    }
    for (const event of chat.events) {
      if (typeof event.time !== 'number') continue;
      const data = record(event.data), base = { tMs: event.time, chatId: chat.chatId, ...(chat.taskId ? { taskId: chat.taskId } : {}), ref: { file: chat.file, seq: event.seq } };
      if (event.type === 'user/message') {
        const source = record(data.source), kind = String(source.kind ?? 'user');
        // An autonomy message is the orchestrator's instruction to a worker, or a notice of the run itself.
        const autonomy = kind === 'harnessstudio-autonomy';
        push({ ...base, type: kind === 'user-question-reply' ? 'chat.question_answer' : kind === 'user' ? 'chat.user_message' : `chat.${kind}`,
          actor: kind === 'user' || kind === 'user-question-reply' ? 'human' : autonomy && source.from === 'orchestrator' ? 'agent' : 'system', summary: clip(textOf(data.content), 300) || '（非文本消息）',
          ...(autonomy ? { detail: { runId: source.runId, from: source.from } } : {}) });
      } else if (event.type === 'tool/result') {
        // A question answered while its call waits comes back as that call's result: the person's answer (the page's
        // request for it is left out of the timeline as already in the conversation).
        const message = record(data.message), callId = resultCall(message);
        if (names.get(callId) === 'ask_user_question') push({ ...base, type: 'chat.question_answer', actor: 'human', summary: clip(textOf(message.content), 300) || '（回答了问题）', callId, ...(message.isError === true ? { detail: { isError: true } } : {}) });
      } else if (event.type === 'assistant/message') {
        const content = record(data.message).content, text = textOf(content);
        const reasoning = Array.isArray(content) ? content.filter(block => record(block).type === 'reasoning').map(block => String(record(block).text ?? '')).join('') : '';
        if (text || reasoning) push({ ...base, type: 'chat.assistant_message', actor: 'agent', summary: clip(text, 300) || '（只有推理过程）', ...(reasoning ? { detail: { reasoningChars: reasoning.length } } : {}) });
      } else if (event.type === 'tool/call') {
        const callId = String(data.callId ?? '');
        if (matchedCalls.has(callId)) continue;
        push({ ...base, type: 'chat.tool_call', actor: 'agent', summary: `调用工具 ${data.name}`, callId, detail: { tool: data.name, ...(results.has(callId) ? { isError: results.get(callId) } : {}) } });
      }
    }
  }

  for (const vm of sources.vms) {
    const detail = vm.detail; if (!detail) continue;
    const base = { taskId: vm.taskId, vmId: vm.vmId, actor: 'system' as const, ref: { file: vm.file } };
    push({ ...base, tMs: ms(detail.created_at), type: 'vm.created', summary: `创建虚拟机 ${vm.vmId}（${detail.environment_id ?? ''}）` });
    push({ ...base, tMs: ms(detail.started_at), type: 'vm.started', summary: '虚拟机最近一次开始运行' });
    const error = record(detail.error);
    if (detail.stopped_at) push({ ...base, tMs: ms(detail.stopped_at), type: error.code ? 'vm.failed' : 'vm.stopped', summary: error.code ? `虚拟机异常结束：${error.code}` : `虚拟机停止（${detail.stop_reason ?? ''}）`, ...(error.code ? { detail: { error } } : {}) });
  }

  // Recordings: start/stop on the host clock, steps on the VM clock corrected by the measured offset.
  const clocks: ClockOffset[] = [];
  for (const recording of sources.recordings) {
    const clock = clockOffset(recording, operations); clocks.push(clock);
    const shift = clock.applied && clock.offsetMs !== null ? clock.offsetMs : 0, base = { taskId: recording.taskId, vmId: recording.vmId, recordingId: recording.recordingId };
    push({ ...base, tMs: ms(recording.row.started_at), type: 'recording.started', actor: 'system', summary: '开始采集轨迹', ref: { file: `${recording.folder}/` } });
    if (recording.row.stopped_at) push({ ...base, tMs: ms(recording.row.stopped_at), type: recording.row.status === 'failed' ? 'recording.failed' : 'recording.stopped', actor: 'system',
      summary: recording.row.status === 'failed' ? `采集失败：${clip(recording.row.error, 200)}` : '停止采集轨迹', ref: { file: `${recording.folder}/` } });
    for (const { line, step } of recording.steps) {
      push({ ...base, tMs: ms(step.time) - shift, type: 'vm.step', actor: step.actor ?? 'system', summary: `${step.action}${step.window ? ` · ${step.window}` : ''}`,
        ...(step.operation ? { operationId: step.operation.id } : {}), ...(shift ? { vmClockOffsetMs: shift } : {}),
        ...(step.files.length || step.milestone ? { detail: { ...(step.files.length ? { files: step.files } : {}), ...(step.milestone ? { milestone: step.milestone } : {}) } } : {}),
        ref: { file: `${recording.folder}/trajectory.jsonl`, line } });
    }
  }

  events.push(...gaps(sources, operations, clocks));
  for (const event of autonomyEvents(sources.autonomy ?? [], sources.activities).events) push(event);
  events.sort((a, b) => a.tMs - b.tMs || a.type.localeCompare(b.type));
  return { events: events.map(event => ({ projectId, ...event })), clocks };
}

/** Periods that should have been recorded but were not: a VM running without a recording (booting, or a recording
 * that never started), a failed or incomplete recording, a VM that failed while in use, and Agent operations on a
 * VM outside every recording. Idle time is not a gap. */
export function gaps(sources: TimelineSources, operations: Map<string, { atMs: number; endMs: number }>, clocks: ClockOffset[]): TimelineEvent[] {
  const result: TimelineEvent[] = [];
  const gap = (taskId: string, vmId: string, startMs: number, endMs: number, reason: string, summary: string, extra: Partial<TimelineEvent> = {}) => {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return;
    result.push({ t: iso(startMs), tMs: startMs, end: iso(endMs), endMs, type: 'gap', actor: 'system', summary, taskId, vmId, detail: { reason, seconds: Math.round((endMs - startMs) / 1000) }, ...extra });
  };
  for (const vm of sources.vms) {
    const recordings = sources.recordings.filter(row => row.vmId === vm.vmId).map(row => ({ row, start: ms(row.row.started_at), stop: ms(row.row.stopped_at) })).sort((a, b) => a.start - b.start);
    const detail = vm.detail;
    if (detail) {
      const started = ms(detail.started_at), stopped = Number.isFinite(ms(detail.stopped_at)) ? ms(detail.stopped_at) : Date.now();
      const first = recordings.find(item => item.start >= started - 5000);
      if (Number.isFinite(started)) {
        if (first) gap(vm.taskId, vm.vmId, started, first.start, 'vm-booting', '虚拟机开机中，尚未开始采集');
        else if (detail.status === 'running' || Number.isFinite(ms(detail.stopped_at))) gap(vm.taskId, vm.vmId, started, stopped, 'vm-running-not-recorded', '虚拟机在运行，但这段时间没有采集记录');
      }
      const error = record(detail.error);
      if (error.code) {
        const last = recordings.at(-1), lastStep = last?.row.steps.at(-1);
        const clock = clocks.find(item => item.recordingId === last?.row.recordingId), shift = clock?.applied && clock.offsetMs !== null ? clock.offsetMs : 0;
        const from = lastStep ? ms(lastStep.step.time) - shift : last?.stop ?? started;
        gap(vm.taskId, vm.vmId, from, ms(detail.stopped_at), 'vm-failed', `虚拟机异常结束（${error.code}），最后一段没有完整轨迹`);
      }
    }
    for (const { row, start, stop } of recordings) {
      const base = { recordingId: row.recordingId };
      if (row.row.status === 'failed') gap(vm.taskId, vm.vmId, start, Number.isFinite(stop) ? stop : start + 1, 'recording-failed', `采集失败：${clip(row.row.error, 160)}`, base);
      else if (row.row.status === 'stopped' && !row.trajectory) gap(vm.taskId, vm.vmId, start, stop, 'recording-incomplete', '采集已停止，但没有生成轨迹文件', base);
      else if (row.row.status === 'stopped' && !row.finished) {
        const clock = clocks.find(item => item.recordingId === row.recordingId), shift = clock?.applied && clock.offsetMs !== null ? clock.offsetMs : 0, lastStep = row.steps.at(-1);
        gap(vm.taskId, vm.vmId, lastStep ? ms(lastStep.step.time) - shift : start, stop, 'recorder-interrupted', '采集器没有正常结束，最后一段可能缺失', base);
      }
    }
  }
  // Agent operations that changed a VM while no recording of that VM ran.
  for (const { taskId, row } of sources.operations) {
    const operation = operations.get(String(row.operation ?? '')), vmId = typeof row.vmId === 'string' ? row.vmId : undefined;
    if (!operation || !vmId || row.kind === 'read' || row.kind === 'human' || row.ok === false) continue;
    const covered = sources.recordings.some(item => item.vmId === vmId && ms(item.row.started_at) <= operation.atMs && (!item.row.stopped_at || ms(item.row.stopped_at) >= operation.atMs));
    if (!covered) gap(taskId, vmId, operation.atMs, Math.max(operation.endMs, operation.atMs + 1), 'agent-operation-not-recorded', 'Agent 操作了虚拟机，但当时没有在采集', { operationId: String(row.operation) });
  }
  return result;
}
