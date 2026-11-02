/** Export of a whole project as a tree: the project at the root, its tasks below, subtasks below their task, and
 * under every task what happened in it (conversations, page and Agent file actions, VMs with Agent operations and
 * the recorder's trajectories, snapshots). timeline/timeline.jsonl merges all of it into one time-ordered list. */
import type { Context } from '@deepseek-ai/cordis';
import type {} from './index.ts';
import type {} from './domain.ts';
import type {} from '@deepseek-ai/dsh-client-connection';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { TaskView } from './domain-types.ts';
import type { AutonomyExportSource, RunState } from './autonomy-types.ts';
import type { ChatExport } from './chat-export.ts';
import { reportSentences, type ChatAuditReport } from './chat-audit-report.ts';
import { contents, jsonLines, loadEpisode, readOperations, recordingStart } from './vm-recordings.ts';
import { writeTree, zipStream, type ExportEntry } from './zip-stream.ts';
import { buildTimeline, type ActivitySource, type AutonomySource, type ChatSource, type OperationSource, type RecordingSource, type TaskSource, type VmSource } from './timeline.ts';
import { throwIfAborted } from './abort.ts';

export interface ExportVm {
  vmId: string; detail: Record<string, unknown> | null; binding?: Record<string, unknown>;
  /** G:\task.json of the VM, which Studio writes before every start. */
  brief: string | null;
  recordings: { id: string; row: Record<string, unknown>; directory: string | null }[];
}
export interface ExportTaskVms { vms: ExportVm[]; operationsLog: string }
export interface ExportVmSource { exportTask(projectId: string, taskId: string): Promise<ExportTaskVms> }
export interface ExportOptions {
  video: boolean; snapshots: boolean; workspace: boolean;
  /** The project's shared folder (F: with vm_manager, Studio's own folder without it) goes to shared/. Absent means left out. */
  shared?: boolean;
}

const FORMAT = 'harnessstudio-project-export/1';
const LOG_LIMIT = 64 * 1024 * 1024;
/** Conversations of an ended run close their last turn within seconds (a completed run's orchestrator still writes its
 * final reply; stopped turns unwind). An export right after the end, as the batch command does, waits for them. */
const SETTLE_MS = 60_000, SETTLE_POLL_MS = 200;
const ENDED_RUNS: readonly RunState[] = ['completed', 'stopped', 'failed'];
/** project.json keeps every incomplete call in modelCalls; warnings stays readable. */
const CALL_WARNINGS = 200;
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const lines = (rows: unknown[]) => Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
/** A folder name that is valid on Windows and Linux. */
export const safeName = (value: string, fallback: string) => value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 60) || fallback;
export const exportStamp = (date: Date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

/** What a conversation or an upload keeps inside a task or project folder without being the folder's own content. */
const privateEntry = (name: string, top: boolean) => (top && name.toLowerCase() === '.chat-tmp') || /\.upload\.tmp$/.test(name);

/** Regular files below a directory, without following links; skipped names at the top level are left out. */
async function* walk(root: string, skip: (name: string, top: boolean) => boolean, prefix = ''): AsyncGenerator<{ path: string; absolute: string; bytes: number; modified: Date }> {
  let names: string[];
  try { names = (await readdir(join(root, prefix))).sort(); } catch { return; }
  for (const name of names) {
    if (skip(name, !prefix)) continue;
    const path = prefix ? `${prefix}/${name}` : name, absolute = join(root, path), info = await lstat(absolute);
    if (info.isDirectory()) yield* walk(root, skip, path);
    else if (info.isFile()) yield { path, absolute, bytes: info.size, modified: info.mtime };
  }
}

const README = `# 项目轨迹导出

由 HarnessStudio 生成。所有时间都是 UTC（以 Z 结尾的 ISO 时间或 epoch 毫秒）。

- project.json：项目信息、任务树、依赖关系、导出时间与选项、自主运行清单（autonomyRuns）、模型调用记录的完整情况（modelCalls）、导出时遇到的问题（warnings）。
- events.jsonl：不属于某个任务的网页操作（例如新建、重命名项目）。
- autonomy/<运行 ID>/run.json：一次自主运行的完整记录，见下文「自主运行」。没有跑过自主运行的项目没有这个目录。
- planning-chats/<对话 ID>/：项目级对话。chat.json 是对话内容和模型调用记录，见下文「chat.json」；temporary-files/ 是这个对话的临时文件。整个项目的自主运行，总 Agent 的对话在这里。
- tasks/<任务编号 标题>/：每个任务一个文件夹，子任务在其 subtasks/ 下，结构相同：
  - task.json：任务定义、状态、检查项、依赖、快照与复核记录（完成记录里写着由人还是由 Agent 确认，以及每条依据）。
  - events.jsonl：网页上对这个任务的操作（人），以及 Agent 用文件工具改动的文件。
  - chats/<对话 ID>/：任务对话，内容同 planning-chats。子 Agent 的对话在这里。
  - vm/<虚拟机 ID>/：vm.json（虚拟机信息与采集记录，vm_manager 只保留最近一次运行的时间）、operations.jsonl（Agent 在这台虚拟机上的每次操作，含输入的文字）、task-brief.json（虚拟机的 G:\\task.json）、recordings/<采集 ID>/（采集器原样输出：trajectory.jsonl、截图、raw/、snapshots/ 等；录像按导出选项决定是否包含）。
  - snapshots/<快照 ID>/：完成任务时冻结的文件（导出选项）。
  - workspace/：任务当前的 D 盘文件（导出选项）。
- shared/：项目共享盘的文件（导出选项）。有虚拟机的部署是各虚拟机里的 F: 盘，没有虚拟机的部署是 Studio 自己的项目公共空间；批量命令清单里 files 上传的输入文件就在这里。目录结构与盘上一致，不含对话的临时文件（在各对话的 temporary-files/ 下）。导出时变小或消失的文件只记一条 warnings，软链接不导出。
- timeline/timeline.jsonl：整个项目按时间排列的一条轨迹，每行一个事件：
  t（UTC）、type、actor（human / agent / system）、summary、任务/对话/虚拟机/采集/操作 ID，以及 ref（原始文件和行号或事件序号）。
  - Agent 对虚拟机的每次操作只出现一次（type=agent.vm_operation），对话里对应的工具调用、Studio 的操作日志和虚拟机的请求日志用操作 ID 串起来。用户在软件区停止后台任务是 type=human.vm_operation。
  - 虚拟机里的每一步是 vm.step，actor 区分 Agent 和人；时间来自虚拟机时钟，已按 timeline/clock.json 的偏差换算成宿主机时间。
  - 该采集却没有采集到的时段是 type=gap 的事件（虚拟机开机中、采集失败、采集器中断、虚拟机异常结束、Agent 操作时没有在采集等），带 start/end 和原因。
  - 自主运行的步骤：活动日志里有的是 web.autonomy/*（人在运行面板上的操作）和 agent.autonomy/*（运行自己的步骤：派出子 Agent、需要人、暂停、结束等）；活动日志里没有的从 run.json 补进来，type 是 autonomy.<事件类型>（子 Agent 一轮结束、预算预警、服务重启后的暂停、问题被回答后事项关闭等），ref 指向 run.json 的事件序号。同一件事只出现一次。任务完成看 task.completed，actor 是 agent 时表示由 Agent 确认。
- timeline/clock.json：每段采集的虚拟机与宿主机时钟偏差及测量方法。

## 自主运行（autonomy/<运行 ID>/run.json）

- objective、rootTaskId（范围根任务，没有表示整个项目）、state、pauseReason、createdAt、startedAt、endedAt、orchestratorChatId（总 Agent 的对话）。
- settings：这次运行的模型和预算，运行中改过的是最后的值。
- usage：weightedTokens 是预算用的折算 token（未缓存输入 + 缓存写入 + 输出 + 缓存读取 × settings.cacheReadWeight）；tokenBreakdown 是原始分项合计，byChat 是每个对话的分项；elapsedMs 不含暂停的时间；rounds 是总 Agent 的轮数。
- workers：每个子 Agent 的对话 ID、任务、模型、状态、最近一次报告（lastReport）、催促次数（nudges）。历次报告都在 events 里（type=worker-reported）。
- attention：全部“需要人”事项。resolvedAt 是处理时间，resolution 是处理方式：resolved、continue、stop-worker、accept 是人在面板上的选择，answered 是问题被回答，replied 是人在对话里回复，resumed 是运行继续时一并关闭，stopped 是运行结束时一并关闭。
- events：全部事件，从旧到新。summary 是写给总 Agent 的文字（studio_autonomy_wait 返回的就是它），page 是运行面板给人看的文字，没有 page 时两边相同。

## chat.json

- source：这个对话属于谁（项目或任务、模型；role 是 orchestrator 表示总 Agent，worker 表示子 Agent，runId 是所属运行）。
- sessions[0].events：原生会话事件，按 seq 排序：每条消息、模型的思考内容（assistant/message 里 type=reasoning 的块）、工具调用（tool/call）和完整结果（tool/result）、用量。
- modelCalls：每次模型调用一条，从旧到新，每一条都带完整的原始内容：
  - 位置和结果：recordId、turn（第几轮）、step（第几步）、attempt（同一步的第几次尝试）、provider、model、startedAt、endedAt、status（completed、failed、cancelled、interrupted、running）、wireStatus（available 表示原始 HTTP 内容完整）。
  - purpose：conversation 是对话本身；compaction 是上下文压缩时写摘要的调用；session-title 是起对话标题；web-search 是联网搜索工具里的模型调用，toolCallId 是对应的工具调用。
  - transports：这次调用实际发出的 HTTP 请求，SDK 自动重试时有多个。transports[n].request.raw 是发给模型服务的原始正文，.body 是解析后的 JSON；transports[n].response.raw 是原始返回，流式返回时 .events 是逐帧解析的结果。HTTP 头不保存，密钥不会出现在这里。
  - request：Harness 内部的中立格式，不是发给模型服务的正文，分析时以 transports 为准。
- temporaryFiles：对话的临时文件清单（联网结果、下载的文件等），文件本身在同目录的 temporary-files/ 下。
- completeness：这个对话的记录完整情况，含义同下文。

怎么找到某次模型调用的原始请求：

1. 在 timeline/timeline.jsonl 里找到关心的事件，它的 ref.file 是这个对话的 chat.json，ref.seq 是会话事件序号。
2. 在这个 chat.json 的 sessions[0].events 里找到 seq 相同的事件；assistant/message 的 data 里有 turn 和 step。
3. 在 modelCalls 里找 turn、step 相同的记录；同一步重试过时，attempt 最大的是最后一次。
4. transports[0].request.body 就是发给模型的全部内容（messages、tools 等），transports[0].response.raw 是模型的原始返回。例如：
   jq '.modelCalls[] | select(.turn==3 and .step==1) | .transports[0].request.body' chat.json

## 模型调用记录完整吗

project.json 的 modelCalls 统计了全部对话：total 是记录数，complete 是完整的条数；notSent 是发出 HTTP 请求之前就失败或被停止的调用（模型什么也没收到，不算不完整）；incompleteCalls 列出不完整的调用和原因代码；unrecordedCalls 列出会话里有、但没有原始记录的调用；chats 是每个对话的情况。这些内容也会写进 warnings，一句话说清是哪个对话、哪次调用、什么原因。

常见原因：调用被停止（暂停或停止运行时正在进行的调用，返回只记录到停止时）；Studio 在调用进行中重启；单个请求或返回超过 128 MB 的保存上限，只保存开头部分；对话启用记录之前的历史调用。

模型调用记录没有保留期限，只有删除对话（删除任务或项目）时才一起删除。导出时还在运行的对话，导出的是当时为止的内容，warnings 里会写明；运行刚结束时导出会先等这次运行的对话停下来（最多 60 秒）。

暂未包含：人的口述（think-aloud）、软件内部语义（AutoCAD 等的对象级操作）、人在虚拟机之外的活动，以及任务文件变化时自动生成“文件说明”的模型调用（这些调用只写一句提交说明，不属于任何对话）。
`;

const label = (ctx: Context, chat: { id: string; taskId?: string; role?: string }) => {
  let owner = '项目对话';
  if (chat.taskId) try { const task = ctx.studioDomain.task(chat.taskId); owner = `任务 ${task.code} ${task.title}`; } catch { owner = `任务 ${chat.taskId}`; }
  return `对话 ${chat.id}（${owner}${chat.role === 'orchestrator' ? '，总 Agent' : chat.role === 'worker' ? '，子 Agent' : ''}）`;
};
/** Conversations still running among `ids`, after waiting for them up to `limit` ms. */
async function settle(ctx: Context, projectId: string, ids: ReadonlySet<string>, limit: number, signal?: AbortSignal): Promise<string[]> {
  const deadline = Date.now() + limit;
  for (;;) {
    throwIfAborted(signal);
    const running = ctx.studio.projectChats(projectId).filter(row => ids.has(row.id) && !['idle', 'stored'].includes(row.status ?? 'stored')).map(row => row.id);
    if (!running.length || Date.now() >= deadline) return running;
    await delay(SETTLE_POLL_MS, undefined, { ...(signal ? { signal } : {}) }).catch(() => undefined);
  }
}

/** The entries of one export, under the folder name `root`. `settleMs` limits the wait for an ended run's conversations. */
export async function* projectEntries(ctx: Context, vms: ExportVmSource | undefined, projectId: string, options: ExportOptions, root: string, exportedAt: Date, signal?: AbortSignal, { settleMs = SETTLE_MS }: { settleMs?: number } = {}): AsyncGenerator<ExportEntry> {
  const domain = ctx.studioDomain, runtime = ctx.studio, graph = domain.graph(projectId), warnings: string[] = [];
  const entry = (name: string, data: Uint8Array, modified = exportedAt): ExportEntry => ({ name: `${root}/${name}`, data, modified });
  // Live files (a workspace, a temporary folder, a recording still being written) may change while they are packed.
  const changing = (problem: string) => { warnings.push(`文件在导出时发生变化：${problem.startsWith(`${root}/`) ? problem.slice(root.length + 1) : problem}`); };
  const tasks = new Map(graph.tasks.map(task => [task.id, task])), children = new Map<string, TaskView[]>();
  for (const task of graph.tasks) { const parent = task.parentId && tasks.has(task.parentId) ? task.parentId : ''; children.set(parent, [...children.get(parent) ?? [], task]); }
  const folders = new Map<string, string>();
  const place = (parent: string, prefix: string) => {
    const used = new Set<string>();
    for (const task of (children.get(parent) ?? []).sort((a, b) => a.rank - b.rank)) {
      let name = `${task.code} ${safeName(task.title, task.id)}`; while (used.has(name)) name += '_'; used.add(name);
      folders.set(task.id, `${prefix}/${name}`); place(task.id, `${prefix}/${name}/subtasks`);
    }
  };
  place('', 'tasks');

  const activity = domain.activities(projectId), chats = runtime.projectChats(projectId);
  const timeline = { tasks: [] as TaskSource[], activities: [] as ActivitySource[], chats: [] as ChatSource[], operations: [] as OperationSource[], vms: [] as VmSource[], recordings: [] as RecordingSource[], autonomy: [] as AutonomySource[] };
  const eventsFile = (file: string, rows: typeof activity) => { rows.forEach((event, index) => timeline.activities.push({ file, line: index + 1, event })); return lines(rows); };

  yield entry('README.md', Buffer.from(README));
  yield entry('events.jsonl', eventsFile('events.jsonl', activity.filter(event => !event.taskId || !tasks.has(event.taskId))));

  // The plugin's read-only view: the export never touches its storage. Without the plugin there are no runs.
  const autonomy: AutonomyExportSource | undefined = ctx.get?.('studioAutonomy');
  let runs = autonomy?.exportRuns(projectId) ?? [];
  const closing = new Set(runs.filter(run => ENDED_RUNS.includes(run.state)).flatMap(run => [run.orchestratorChatId, ...run.workers.map(worker => worker.chatId)]));
  if (closing.size) {
    await settle(ctx, projectId, closing, settleMs, signal);
    // A last turn can still add usage and events.
    runs = autonomy?.exportRuns(projectId) ?? [];
  }
  for (const run of runs) {
    const file = `autonomy/${run.id}/run.json`;
    timeline.autonomy.push({ runId: run.id, file, events: run.events });
    yield entry(file, json(run));
  }

  const reports: { chatId: string; taskId?: string; file: string; report: ChatAuditReport; label: string }[] = [];
  async function* chat(id: string, folder: string, taskId?: string): AsyncGenerator<ExportEntry> {
    throwIfAborted(signal);
    const base = `${folder}/${id}`;
    let value: ChatExport;
    try { value = await runtime.exportChat(id, exportedAt, signal); }
    catch (error) {
      throwIfAborted(signal);
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`对话 ${id} 没有导出：${message}`); yield entry(`${base}/ERROR.txt`, Buffer.from(`${message}\n`));
      return;
    }
    const name = label(ctx, value.source);
    if (value.source.status === 'running') warnings.push(`${name}导出时还在运行，导出的是当时为止的内容`);
    yield { name: `${root}/${base}/chat.json`, stream: value.json(signal), modified: new Date(value.modifiedAt) };
    for (const file of value.temporaryFiles) { throwIfAborted(signal); yield { name: `${root}/${base}/temporary-files/${file.path}`, file: file.absolute, bytes: file.bytes, modified: file.modified, changing }; }
    // The archive has read chat.json to its end by now, so the report is final.
    reports.push({ chatId: id, ...(taskId ? { taskId } : {}), file: `${base}/chat.json`, report: value.report, label: name });
    timeline.chats.push({ chatId: id, ...(taskId ? { taskId } : {}), file: `${base}/chat.json`, events: value.events as unknown as ChatSource['events'] });
  }
  for (const row of chats.filter(row => row.scope === 'project')) yield* chat(row.id, 'planning-chats');

  for (const task of graph.tasks) {
    const folder = folders.get(task.id)!, chatRows = chats.filter(row => row.scope === 'task' && row.taskId === task.id);
    throwIfAborted(signal);
    const snapshots = domain.taskSnapshots(task.id), reviews = domain.reviews(task.id);
    let vmData: ExportTaskVms | undefined;
    if (vms) try { vmData = await vms.exportTask(projectId, task.id); } catch (error) { warnings.push(`任务 ${task.code} 的虚拟机信息没有读到：${error instanceof Error ? error.message : String(error)}`); }
    yield entry(`${folder}/task.json`, json({ task, snapshots: snapshots.map(row => row.snapshot), reviews, chats: chatRows.map(row => ({ id: row.id, provider: row.provider, model: row.model, stale: row.stale })), vms: vmData?.vms.map(vm => vm.vmId) ?? [] }));
    timeline.tasks.push({ taskId: task.id, file: `${folder}/task.json`, createdAt: task.createdAt, title: task.title, reviews: reviews.map(review => ({ id: review.id, action: review.action, createdAt: review.createdAt, actor: review.actor })),
      snapshots: snapshots.map(({ snapshot }) => ({ id: snapshot.id, createdAt: snapshot.createdAt, ...(snapshot.humanConfirmation ? { confirmedAt: snapshot.humanConfirmation.confirmedAt, ...(snapshot.humanConfirmation.actor === 'agent' ? { confirmedBy: 'agent' as const, agent: snapshot.humanConfirmation.agent } : {}) } : {}), ...(options.snapshots ? { file: `${folder}/snapshots/${snapshot.id}/manifest.json` } : {}) })) });
    yield entry(`${folder}/events.jsonl`, eventsFile(`${folder}/events.jsonl`, activity.filter(event => event.taskId === task.id)));
    for (const row of chatRows) yield* chat(row.id, `${folder}/chats`, task.id);

    if (vmData) {
      const operations = await jsonLines(vmData.operationsLog, LOG_LIMIT), operationMap = await readOperations(vmData.operationsLog);
      const unassigned = operations.filter(row => !vmData!.vms.some(vm => vm.vmId === row.vmId));
      if (unassigned.length) {
        unassigned.forEach((row, index) => timeline.operations.push({ file: `${folder}/vm/operations-unassigned.jsonl`, line: index + 1, taskId: task.id, row }));
        yield entry(`${folder}/vm/operations-unassigned.jsonl`, lines(unassigned));
      }
      for (const vm of vmData.vms) {
        const base = `${folder}/vm/${vm.vmId}`, own = operations.filter(row => row.vmId === vm.vmId);
        yield entry(`${base}/vm.json`, json({ vmId: vm.vmId, detail: vm.detail, ...(vm.detail ? {} : { note: '虚拟机已删除，vm_manager 不再提供它的运行信息；采集记录仍然保留。' }), binding: vm.binding ?? null, recordings: vm.recordings.map(row => row.row) }));
        timeline.vms.push({ taskId: task.id, vmId: vm.vmId, file: `${base}/vm.json`, detail: vm.detail });
        own.forEach((row, index) => timeline.operations.push({ file: `${base}/operations.jsonl`, line: index + 1, taskId: task.id, row }));
        yield entry(`${base}/operations.jsonl`, lines(own));
        if (vm.brief) try { const info = await stat(vm.brief); if (info.isFile()) yield { name: `${root}/${base}/task-brief.json`, file: vm.brief, bytes: info.size, modified: info.mtime }; } catch { /* Studio never started this VM */ }
        for (const recording of vm.recordings) {
          const folderName = `${base}/recordings/${recording.id}`;
          const source: RecordingSource = { taskId: task.id, vmId: vm.vmId, recordingId: recording.id, folder: folderName, row: recording.row, steps: [], requests: [], startMs: null, trajectory: false, finished: false };
          timeline.recordings.push(source);
          if (!recording.directory) continue;
          let listing: Awaited<ReturnType<typeof contents>>;
          try { listing = await contents(recording.directory); } catch { continue; /* still recording, or never written */ }
          for (const file of listing.files) {
            if (!options.video && file.path === 'recording.mp4') continue;
            throwIfAborted(signal);
            yield { name: `${root}/${folderName}/${file.path}`, file: file.absolute, bytes: file.bytes, modified: file.modified, changing };
          }
          const loaded = await loadEpisode(recording.directory, operationMap);
          source.steps = (loaded?.steps ?? []).map((step, index) => ({ line: index + 1, step }));
          source.trajectory = listing.files.some(file => file.path === 'trajectory.jsonl');
          source.startMs = await recordingStart(recording.directory);
          source.finished = /完成[:：]/.test(await readFile(join(recording.directory, 'recorder.log'), 'utf8').catch(() => ''));
          source.requests = (await jsonLines(join(recording.directory, 'agent_requests.jsonl'), LOG_LIMIT)).flatMap(row => typeof row.operation === 'string' && typeof row.start_ms === 'number' && typeof row.end_ms === 'number' ? [{ operation: row.operation, startMs: row.start_ms, endMs: row.end_ms }] : []);
          if (!options.video && listing.files.some(file => file.path === 'recording.mp4')) yield entry(`${folderName}/recording.mp4.omitted.txt`, Buffer.from('导出时没有勾选“包含屏幕录像”，录像未包含。原文件在 vm_manager 的采集目录中。\n'));
        }
      }
    }

    if (options.snapshots) for (const { snapshot, directory } of snapshots) {
      yield entry(`${folder}/snapshots/${snapshot.id}/manifest.json`, json(snapshot));
      const base = await realpath(directory).catch(() => null);
      for (const file of snapshot.files) {
        if (!base) { warnings.push(`快照 ${snapshot.id} 的文件目录不存在`); break; }
        const target = await realpath(join(directory, file.path)).catch(() => null);
        if (!target || !target.startsWith(base + sep)) { warnings.push(`快照 ${snapshot.id} 缺少文件 ${file.path}`); continue; }
        yield { name: `${root}/${folder}/snapshots/${snapshot.id}/files/${file.path}`, file: target, bytes: file.bytes, modified: new Date(snapshot.createdAt) };
      }
    }
    if (options.workspace) {
      domain.files.register(task.id);
      for await (const file of walk(domain.files.directory(task.id), privateEntry)) {
        throwIfAborted(signal); yield { name: `${root}/${folder}/workspace/${file.path}`, file: file.absolute, bytes: file.bytes, modified: file.modified, changing };
      }
    }
  }

  // The project's shared folder is where a batch list's input files are put. It belongs to the project, not to a task, so it
  // sits beside the task tree. Files that change while they are packed are reported like workspace files; links are not followed.
  if (options.shared) {
    let shared: string | undefined;
    try { runtime.projectFiles.register(projectId); shared = runtime.projectFiles.directory(projectId); }
    catch (error) { warnings.push(`项目共享盘没有导出：${error instanceof Error ? error.message : String(error)}`); }
    if (shared) for await (const file of walk(shared, privateEntry)) {
      throwIfAborted(signal); yield { name: `${root}/shared/${file.path}`, file: file.absolute, bytes: file.bytes, modified: file.modified, changing };
    }
  }

  const { events, clocks } = buildTimeline(projectId, timeline);
  yield entry('timeline/timeline.jsonl', lines(events));
  yield entry('timeline/clock.json', json({ note: '虚拟机时钟减宿主机时钟（毫秒）。agent-requests：用同一操作在两边的时间测得，误差为 uncertaintyMs；recording-start：用采集开始时间粗估（含采集器启动的几秒），只有偏差超过一分钟才换算。', recordings: clocks }));
  const sum = (count: (report: ChatAuditReport) => number) => reports.reduce((total, row) => total + count(row.report), 0);
  const sentences = reports.flatMap(row => reportSentences(row.label, row.report));
  warnings.push(...sentences.slice(0, CALL_WARNINGS), ...sentences.length > CALL_WARNINGS ? [`另有 ${sentences.length - CALL_WARNINGS} 条模型调用记录的问题，全部列在 project.json 的 modelCalls 里`] : []);
  yield entry('project.json', json({
    format: FORMAT, exportedAt: exportedAt.toISOString(), options: { ...options, shared: options.shared === true }, workflowMode: graph.workflowMode, project: graph.project,
    tasks: graph.tasks.map(task => ({ id: task.id, code: task.code, title: task.title, state: task.state, parentId: task.parentId ?? null, folder: folders.get(task.id) })),
    dependencies: graph.tasks.flatMap(task => task.dependencies.map(source => ({ from: source, to: task.id }))),
    counts: { tasks: graph.tasks.length, chats: chats.length, events: activity.length, timeline: events.length, gaps: events.filter(event => event.type === 'gap').length, recordings: timeline.recordings.length, autonomyRuns: runs.length },
    autonomyRuns: runs.map(run => ({ id: run.id, file: `autonomy/${run.id}/run.json`, state: run.state, ...(run.pauseReason ? { pauseReason: run.pauseReason } : {}), startedAt: run.startedAt, ...(run.endedAt ? { endedAt: run.endedAt } : {}), events: run.events.length, workers: run.workers.length, attention: run.attention.length })),
    modelCalls: {
      total: sum(report => report.calls), complete: sum(report => report.complete), notSent: sum(report => report.notSent), incomplete: sum(report => report.incomplete.length), unrecorded: sum(report => report.missing.reduce((total, row) => total + row.inSession - row.recorded, 0)),
      chats: reports.map(({ chatId, taskId, file, report }) => ({ chatId, ...(taskId ? { taskId } : {}), file, status: report.status, calls: report.calls, complete: report.complete, notSent: report.notSent, incomplete: report.incomplete.length, unrecorded: report.missing.reduce((total, row) => total + row.inSession - row.recorded, 0) })),
      incompleteCalls: reports.flatMap(({ chatId, file, report }) => report.incomplete.map(call => ({ chatId, file, ...call }))),
      unrecordedCalls: reports.flatMap(({ chatId, file, report }) => report.missing.map(row => ({ chatId, file, ...row }))),
    },
    warnings,
  }));
}

interface ExportJob { id: string; projectId: string; directory: string; state: 'running' | 'done' | 'failed'; files: number; bytes: number; startedAt: string; finishedAt?: string; error?: string }
const flag = (value: unknown, fallback: boolean) => value === undefined || value === null ? fallback : value === true || value === '1';

/** GET /api/studio/project/export streams the export as a ZIP; POST /api/studio/project/export/disk writes it
 * to the server (the project's vm_manager folder, so it is reachable on the host) in the background. */
export function registerProjectExport(ctx: Context, vms?: ExportVmSource): void {
  const jobs = new Map<string, ExportJob>();
  const project = (value: unknown) => { if (typeof value !== 'string' || !value) throw new Error('请指定项目'); return ctx.studioDomain.graph(value).project; };
  ctx.connection.fetch.register({ path: '/api/studio/project/export', methods: ['GET'], requestBody: 'buffered', async fetch(request) {
    try {
      const query = new URL(request.url).searchParams, value = project(query.get('projectId')), exportedAt = new Date();
      // shared follows workspace unless it is given: a client that asks for the task files gets the project's input files too.
      const workspace = flag(query.get('workspace'), false), options = { video: flag(query.get('video'), false), snapshots: flag(query.get('snapshots'), true), workspace, shared: flag(query.get('shared'), workspace) };
      const root = `${safeName(value.title, 'project')}-${exportStamp(exportedAt)}`;
      ctx.studioDomain.recordActivity({ actor: 'human', source: 'web', action: 'project/export', projectId: value.id, ok: true, request: options });
      return new Response(zipStream(projectEntries(ctx, vms, value.id, options, root, exportedAt, request.signal), request.signal), { headers: {
        'content-type': 'application/zip', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${root}.zip`)}`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
    } catch (error) { return Response.json({ error: error instanceof Error ? error.message : '项目导出失败' }, { status: 400 }); }
  } });
  ctx.connection.fetch.register({ path: '/api/studio/project/export/disk', methods: ['GET', 'POST'], requestBody: 'buffered', async fetch(request) {
    try {
      if (request.method === 'GET') {
        const job = jobs.get(new URL(request.url).searchParams.get('jobId') ?? ''); if (!job) throw new Error('导出任务不存在');
        return Response.json(job);
      }
      const data = await request.json() as Record<string, unknown>, value = project(data.projectId), exportedAt = new Date();
      if ([...jobs.values()].some(job => job.projectId === value.id && job.state === 'running')) throw new Error('这个项目正在导出，请等它完成');
      const workspace = flag(data.workspace, true), options = { video: flag(data.video, true), snapshots: flag(data.snapshots, true), workspace, shared: flag(data.shared, workspace) };
      const root = `${safeName(value.title, 'project')}-${exportStamp(exportedAt)}`, projects = ctx.studioDomain.vmStorage?.projectsRoot;
      const directory = projects ? join(resolve(projects), value.id, 'exports', root) : join(resolve(ctx.studio.files.root), '..', 'exports', value.id, root);
      const job: ExportJob = { id: randomUUID(), projectId: value.id, directory, state: 'running', files: 0, bytes: 0, startedAt: exportedAt.toISOString() };
      jobs.set(job.id, job);
      ctx.studioDomain.recordActivity({ actor: 'human', source: 'web', action: 'project/export/disk', projectId: value.id, ok: true, request: { ...options, directory } });
      // Entries carry the root folder; the tree is written below the export directory's parent.
      void (async () => {
        try {
          const entries = (async function* () { for await (const item of projectEntries(ctx, vms, value.id, options, root, exportedAt)) yield { ...item, name: item.name.slice(root.length + 1) }; })();
          await writeTree(entries, directory, (files, bytes) => { job.files = files; job.bytes = bytes; });
          job.state = 'done';
        } catch (error) { job.state = 'failed'; job.error = error instanceof Error ? error.message : String(error); }
        job.finishedAt = new Date().toISOString();
      })();
      return Response.json(job);
    } catch (error) { return Response.json({ error: error instanceof Error ? error.message : '项目导出失败' }, { status: 400 }); }
  } });
}
