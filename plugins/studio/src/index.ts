import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-agent-preset-registry';
import type {} from '@deepseek-ai/dsh-client-connection';
import type {} from '@deepseek-ai/dsh-session-persistence';
import type {} from '@deepseek-ai/dsh-system-prompt';
import type {} from '@deepseek-ai/dsh-attachment';
import type {} from '@deepseek-ai/dsh-token-meter';
import { Readable } from 'node:stream';
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { mkdir, readFile, open, rename, readdir, lstat, rm, rmdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { WorkspaceFiles, isEntryExists, WORKSPACE_UPLOAD_MAX_BYTES, type WorkspaceLease } from './workspace.ts';
import type {} from './models.ts';
import type {} from './domain.ts';
import { ChatTransfer } from './chat-transfer.ts';
import { readChatExport } from './chat-export.ts';
import type {} from './chat-audit.ts';
import { ChatStreams } from './chat-stream.ts';
import { ChatUsageFacts, chatMetrics, usageFacts } from './chat-metrics.ts';
import { chatActivity, emptyChatActivityFacts, observeChatActivity, restoreChatActivity, type ChatActivityFacts, type ActivityQuestion } from './chat-activity.ts';
import { ChatScratch } from './chat-scratch.ts';
import { extractZip, ZIP_LIMITS } from './chat-zip.ts';
import { ConversationDeletion } from './conversation-delete.ts';
import { ChatAttachments, parseChatAttachmentUploads, assertAttachmentVision } from './chat-attachments.ts';
import type { ChatAttachmentOwner } from './chat-attachment-types.ts';
import type { ChatSummary } from './chat-types.ts';
import type { AutonomyRole } from './autonomy-types.ts';
import { resultSnapshotId, type InputRef, type SnapshotFile, type GraphPlanningScope, type ProjectWorkspaceDirectory, type ProjectWorkspaceFilePreview } from './domain-types.ts';
import { compileSinglePlaceholderPrompt, loadPromptFile, type SinglePlaceholderPromptTemplate } from './prompt-loader.ts';
import { abortError, throwIfAborted } from './abort.ts';
import { removeManagedDirectory } from './managed-delete.ts';

export const name = 'harnessstudio-studio';
export const inject = ['agents', 'agentLoop', 'agentPresets', 'tools', 'systemPrompt', 'sessionPersistence', 'sessionProjections', 'tokenMeter', 'connection', 'llm', 'attachments', 'studioModels', 'studioDomain'];
export interface Config {
  dataRoot: string; promptPath: string; projectPromptPath: string;
  projectLiveContextPromptPath: string; taskLiveContextSingleUserPromptPath: string; taskLiveContextReviewedPromptPath: string;
  projectChatTempPromptPath: string; taskChatTempPromptPath: string;
  workspaceIds: string[]; maxFileBytes: number; pdfRendererPath?: string;
}
export const Config: z<Config> = z.object({
  dataRoot: z.string().required(), promptPath: z.string().required(), projectPromptPath: z.string().required(),
  projectLiveContextPromptPath: z.string().required(), taskLiveContextSingleUserPromptPath: z.string().required(), taskLiveContextReviewedPromptPath: z.string().required(),
  projectChatTempPromptPath: z.string().required(), taskChatTempPromptPath: z.string().required(),
  workspaceIds: z.array(String).required(), maxFileBytes: z.natural().min(1).required(),
  pdfRendererPath: z.string().default('pdftoppm'),
});

/** taskId is an internal workspace owner; project bindings never expose it publicly. role and runId mark the
 * conversations an autonomy run created; they stay as history after the run ends. */
interface Binding extends WorkspaceLease { id: string; scope: 'project' | 'task'; projectId: string; provider: string; model: string; dataGeneration?: number; role?: AutonomyRole; runId?: string }
declare module '@deepseek-ai/cordis' { interface Context { studio: StudioRuntime } }
/** Orchestrator instructions and controller notices are not a person's messages (设计.md §3.3). */
export type AutonomySource = { kind: 'harnessstudio-autonomy'; runId: string; from: 'orchestrator' | 'controller' };
declare module '@deepseek-ai/dsh-llm' { interface MessageSourceMap { 'harnessstudio-autonomy': AutonomySource } }

/** What the autonomy plugin tells the runtime. Every answer is about an unfinished run: a conversation of an ended run is
 * an ordinary conversation again. */
export interface AutonomyBridge {
  /** Role and run of a conversation; scope is the run's task set for a task-branch run, absent for a whole-project run. */
  access(chatId: string): { role: AutonomyRole; runId: string; scope?: ReadonlySet<string>; rootTaskId?: string } | undefined;
  /** The autonomy part of the conversation's live context JSON. */
  liveContext(chatId: string): unknown;
  /** A person pressed stop in this conversation. */
  stopped(chatId: string): void;
  /** The VM ceiling of the run the conversation belongs to, and the conversations whose VMs count. */
  vmQuota(chatId: string): { maxVms: number; chatIds: ReadonlySet<string> } | undefined;
}
/** Run conversations mount this preset (the studio preset plus the repeat-call reminder); a session keeps its preset. */
export const AUTONOMY_PRESET = 'studio-autonomy';
const orchestratorTools = ['studio_autonomy_status', 'studio_autonomy_start_worker', 'studio_autonomy_message_worker', 'studio_autonomy_stop_worker', 'studio_autonomy_wait'];
const completionTools = ['studio_agent_completion_preview', 'studio_agent_complete_task'];
/** Goals are created by the backend; only an orchestrator of an unfinished run reads and reports its goal. */
function autonomyDenied(role: AutonomyRole | undefined): string[] {
  return ['create_goal', ...(role === 'orchestrator' ? [] : [...orchestratorTools, 'get_goal', 'update_goal']), ...(role === 'worker' ? [] : ['studio_agent_report']), ...(role ? [] : completionTools)];
}

/** Tools that act on one task; project conversations never see them. Mock and VM seat tools are both listed. */
const taskOnlyTools = ['studio_task_context', 'studio_read_file', 'studio_read_project_file', 'studio_write_file', 'studio_delete_file',
  'studio_software_status', 'studio_software_launch', 'studio_software_release', 'studio_software_control', 'studio_software_invoke',
  'studio_software_operation', 'studio_software_cancel', 'studio_software_save_artifact',
  'studio_vm_screenshot', 'studio_vm_ui_tree', 'studio_vm_run', 'studio_vm_input', 'studio_vm_launch', 'studio_vm_open_file', 'studio_vm_window', 'studio_vm_milestone',
  'studio_vm_job_status', 'studio_vm_job_cancel'];

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
  return value as Record<string, unknown>;
}
export function stringField(value: Record<string, unknown>, key: string): string {
  const text = value[key];
  if (typeof text !== 'string' || text.length === 0) throw new Error(`Expected ${key}`);
  return text;
}

/** File panel changes report filesystem refusals in words; host paths and errno codes stay out of the page. */
async function panelFileChange<T>(operation: () => Promise<T>, fallback: string, readOnly = '任务文件不可编辑：D 盘已冻结或没有写权限'): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (isEntryExists(error)) throw error;
    const code = error instanceof Error && 'code' in error ? String(error.code) : '';
    if (['EPERM', 'EACCES', 'EROFS'].includes(code)) throw new Error(readOnly);
    if (code === 'ENOENT') throw new Error('文件或文件夹不存在，请刷新后重试');
    if (code === 'ENOSPC') throw new Error('磁盘空间不足');
    throw error instanceof Error ? error : new Error(fallback);
  }
}
async function* bodyChunks(body: ReadableStream<Uint8Array> | null): AsyncIterable<Uint8Array> {
  if (!body) return;
  const reader = body.getReader();
  try { for (;;) { const { done, value } = await reader.read(); if (done) return; yield value; } }
  finally { reader.releaseLock(); }
}

/** Queued domain mutations recheck this signal before committing; cancellation can drain the Agent immediately. */
async function waitForDomainOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try { return await Promise.race([operation, cancelled]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

/** Project planning and task-scoped DSH sessions share persistent conversation transport. */
export class StudioRuntime {
  readonly files: WorkspaceFiles;
  readonly scratch: ChatScratch;
  readonly projectFiles: WorkspaceFiles;
  readonly projectScratch: ChatScratch;
  readonly attachments: ChatAttachments;
  private readonly projectWorkspaceIds = new Set<string>();
  private readonly bindings = new Map<string, Binding>();
  private readonly handles = new Map<string, AgentHandle>();
  private readonly streams = new ChatStreams();
  private readonly usageFacts = new ChatUsageFacts();
  private readonly activityFacts = new Map<string, ChatActivityFacts>();
  private readonly activityQuestions = new Map<string, readonly ActivityQuestion[]>();
  private mutations: Promise<unknown> = Promise.resolve();
  private closing = false;
  private readonly root: string;
  private readonly conversationDeletion: ConversationDeletion;
  private readonly chatTransfer: ChatTransfer;
  private prompt = '';
  private projectPrompt = '';
  private projectLiveContextPrompt!: SinglePlaceholderPromptTemplate;
  private taskLiveContextSingleUserPrompt!: SinglePlaceholderPromptTemplate;
  private taskLiveContextReviewedPrompt!: SinglePlaceholderPromptTemplate;
  private projectChatTempPrompt = '';
  private taskChatTempPrompt = '';
  private readonly instructionSections = new Map<string, { order: number; text: string; role?: AutonomyRole }>();
  private autonomy?: AutonomyBridge;
  /** Conversations inside their own completion call; quiescing their task does not close them. */
  private readonly completing = new Map<string, number>();
  private readonly producerQuiescence = new Map<string, (taskIds: string[]) => Promise<void>>();

  constructor(private readonly ctx: Context, private readonly config: Config) {
    this.root = resolve(config.dataRoot);
    this.conversationDeletion = new ConversationDeletion(this.root);
    this.attachments = new ChatAttachments(this.root, ctx.attachments, { pdfRendererPath: config.pdfRendererPath });
    this.files = ctx.studioDomain.files;
    this.scratch = new ChatScratch(this.files);
    const projectIds = ctx.studioDomain.projects().map(project => project.id);
    projectIds.forEach(id => this.projectWorkspaceIds.add(id));
    const storage = ctx.studioDomain.fileStorage;
    // With vm_manager storage, ordinary project files are the project's shared folder (F:); the no-software mode keeps the
    // same shared folder in Studio's own data folder. Chat scratch stays private either way.
    this.projectFiles = new WorkspaceFiles(join(this.root, 'project-workspaces'), projectIds, config.maxFileBytes, id => {
      if (this.closing) throw new Error('Studio is stopping');
      this.ctx.studioDomain.graph(id);
    }, undefined, storage && {
      locate: id => ctx.studioDomain.sharedSpaceDirectory(id),
      prepare: async id => { await mkdir(ctx.studioDomain.sharedSpaceDirectory(id), { recursive: true, mode: storage.workspaces ? 0o755 : 0o700 }); },
      // vm_manager keeps a deleted project's F:; Studio's own shared folder goes with the project, and so does its empty folder.
      ...(storage.workspaces ? {} : { remove: async (id: string) => {
        const shared = ctx.studioDomain.sharedSpaceDirectory(id), project = dirname(shared);
        await removeManagedDirectory(project, shared);
        for (const empty of [join(project, 'tasks'), project]) await rmdir(empty).catch(error => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error?.code)) throw error; });
      } }),
    });
    this.projectScratch = new ChatScratch(this.projectFiles);
    this.chatTransfer = new ChatTransfer(ctx, this.root, {
      summary: id => this.describeBinding(this.binding(id)),
      assertIdle: id => {
        this.binding(id);
        const status = this.handles.get(id)?.agent.status ?? 'stored';
        if (!['idle', 'stored'].includes(status)) throw new Error('请等待当前对话结束后再下载；运行中的对话不能导出完整调试 JSON。');
      },
      // A debug export only reads: it must not create the temporary tree, which needs a writable (unfinished) task.
      scratchDirectory: id => this.scratchFor(id).existing(this.chatLease(id), id),
    });
  }

  async initialize(): Promise<void> {
    this.ctx.on('agent/assistant-stream', ({ agent, frame }) => { if (this.bindings.has(agent.id)) this.streams.frame(agent.id, frame); });
    this.ctx.on('session/event', (session, event) => {
      if (!this.bindings.has(session.id)) return;
      const facts = this.activityFacts.get(session.id) ?? emptyChatActivityFacts();
      observeChatActivity(facts, event, session.inheritedEventCount);
      this.activityFacts.set(session.id, facts);
      this.streams.event(session.id, event);
      // Native projections catch up to exactly this session's durable cursor.
      // No prompt text, provider secret, or raw usage stream is transported.
      const snapshot = this.ctx.sessionProjections.snapshot(session, ['tokenUsage', 'contextPressure']);
      this.streams.metrics(session.id, chatMetrics(snapshot, this.usageFacts.read(session)));
    });
    this.ctx.on('agent/status', ({ agent, status }) => { if (this.bindings.has(agent.id)) this.streams.status(agent.id, status); });
    this.ctx.on('agent/disposed', ({ agent }) => {
      if (this.bindings.has(agent.id)) {
        this.activityQuestions.set(agent.id, this.ctx.sessionProjections.stateOf(agent.session, 'userQuestions')?.questions.active ?? []);
        this.streams.forget(agent.id);
      }
    });
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const [taskPrompt, projectPrompt, projectLiveContext, taskLiveContextSingleUser, taskLiveContextReviewed, projectChatTemp, taskChatTemp] = await Promise.all([
      loadPromptFile(this.config.promptPath), loadPromptFile(this.config.projectPromptPath), loadPromptFile(this.config.projectLiveContextPromptPath),
      loadPromptFile(this.config.taskLiveContextSingleUserPromptPath), loadPromptFile(this.config.taskLiveContextReviewedPromptPath),
      loadPromptFile(this.config.projectChatTempPromptPath), loadPromptFile(this.config.taskChatTempPromptPath),
    ]);
    this.prompt = taskPrompt.prompt;
    this.projectPrompt = projectPrompt.prompt;
    this.projectLiveContextPrompt = compileSinglePlaceholderPrompt(projectLiveContext.prompt, 'LIVE_PROJECT_CONTEXT_JSON', this.config.projectLiveContextPromptPath);
    this.taskLiveContextSingleUserPrompt = compileSinglePlaceholderPrompt(taskLiveContextSingleUser.prompt, 'LIVE_TASK_CONTEXT_JSON', this.config.taskLiveContextSingleUserPromptPath);
    this.taskLiveContextReviewedPrompt = compileSinglePlaceholderPrompt(taskLiveContextReviewed.prompt, 'LIVE_TASK_CONTEXT_JSON', this.config.taskLiveContextReviewedPromptPath);
    this.projectChatTempPrompt = projectChatTemp.prompt;
    this.taskChatTempPrompt = taskChatTemp.prompt;
    await this.projectFiles.initialize();
    let raw: unknown;
    try { raw = JSON.parse(await readFile(join(this.root, 'chats.json'), 'utf8')); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; return; }
    if (!Array.isArray(raw)) throw new Error('Invalid stored chat bindings');
    for (const item of raw) {
      const row = object(item);
      const id = stringField(row, 'id');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw new Error('Invalid stored chat id');
      if (typeof row.generation !== 'number' || row.generation !== 0) throw new Error('Invalid stored workspace generation');
      if (this.bindings.has(id)) throw new Error('Duplicate stored chat id');
      const scope = row.scope === undefined ? 'task' : row.scope;
      if ((row.role === undefined) !== (row.runId === undefined) || row.role !== undefined && (!['orchestrator', 'worker'].includes(row.role as string) || typeof row.runId !== 'string' || !/^ar-[0-9a-f-]{36}$/.test(row.runId))) throw new Error('Invalid stored chat role');
      const shared = { id, generation: 0, provider: stringField(row, 'provider'), model: stringField(row, 'model'), ...(row.role === undefined ? {} : { role: row.role as AutonomyRole, runId: row.runId as string }) };
      if (scope === 'project') {
        if (Object.hasOwn(row, 'taskId')) throw new Error('Project chat cannot bind a task');
        const projectId = stringField(row, 'projectId');
        this.ctx.studioDomain.graph(projectId);
        const deleting = this.ctx.studioDomain.projectDeleting(projectId);
        await this.allocateProject(projectId, true);
        const binding: Binding = { ...shared, ...(deleting ? this.projectFiles.readLease(projectId) : this.projectFiles.lease(projectId)), scope, projectId };
        this.bindings.set(id, binding);
        if (deleting) { this.projectFiles.revoke(projectId); continue; }
        await this.projectScratch.ensure(binding, id);
      } else if (scope === 'task') {
        const taskId = stringField(row, 'taskId'), task = this.ctx.studioDomain.task(taskId);
        const dataGeneration = row.dataGeneration ?? 0;
        if (typeof dataGeneration !== 'number' || !Number.isSafeInteger(dataGeneration) || dataGeneration < 0) throw new Error('Invalid stored task data generation');
        if (row.projectId !== undefined && row.projectId !== task.projectId) throw new Error('Stored chat project does not own task');
        this.ctx.studioDomain.graph(task.projectId);
        this.files.directory(taskId);
        this.bindings.set(id, { ...shared, ...this.files.readLease(taskId), scope, projectId: task.projectId, dataGeneration: Number(dataGeneration) });
        // Keep obsolete records only as cleanup targets. They are never reopened
        // or provisioned, even after a partial clear and process restart.
        if (dataGeneration !== (task.dataGeneration ?? 0)) continue;
        try { this.ctx.studioDomain.assertDiscussionWritable(taskId); }
        catch { continue; }
        await this.scratch.ensure(this.files.readLease(taskId), id);
      } else throw new Error('Invalid stored chat scope');
    }
    // One durable, read-only replay at startup. Status polling never resumes an
    // Agent, invokes tools, replays a model request or re-reads long transcripts.
    if (this.ctx.sessionProjections) for (const binding of this.bindings.values()) {
      if (binding.scope === 'task' && (binding.dataGeneration ?? 0) !== (this.ctx.studioDomain.task(binding.taskId).dataGeneration ?? 0)) continue;
      let reader: Awaited<ReturnType<Context['sessionPersistence']['open']>> | undefined;
      try {
        reader = await this.ctx.sessionPersistence.open(SessionId(binding.id), 'read');
        const { events } = await reader.read();
        const { snapshot } = this.ctx.sessionProjections.restore({}, events, SessionLogOffset(0), reader.header, reader.inheritedEventCount);
        this.activityFacts.set(binding.id, restoreChatActivity(events, reader.inheritedEventCount));
        const view = snapshot.values.userQuestions as { active?: readonly ActivityQuestion[] } | undefined;
        this.activityQuestions.set(binding.id, view?.active ?? []);
      } catch {
        // An unavailable old transcript remains stored; a light is never a
        // reason to repair or create a Session behind the user's back.
        this.activityFacts.delete(binding.id); this.activityQuestions.delete(binding.id);
      } finally { await reader?.close(); }
    }
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.catch(() => undefined).then(() => {
      if (this.closing) throw new Error('Studio is stopping');
      return operation();
    });
    this.mutations = result;
    return result;
  }

  private async saveBindings(): Promise<void> {
    const filename = join(this.root, 'chats.json');
    const temporary = `${filename}.${randomUUID()}.tmp`;
    // Generations revoke live capabilities only; no live capabilities survive process restart.
    const rows = [...this.bindings.values()].map(row => ({ ...this.describeBinding(row), generation: 0,
      ...(row.scope === 'task' ? { dataGeneration: row.dataGeneration ?? 0 } : {}) }));
    try {
      const writer = await open(temporary, 'wx', 0o600);
      try { await writer.writeFile(JSON.stringify(rows) + '\n'); await writer.sync(); }
      finally { await writer.close(); }
      await rename(temporary, filename);
      const directory = await open(this.root, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await rm(temporary, { force: true }); }
  }

  /** The project a conversation belongs to, for the activity log. */
  chatProject(id: string): string | undefined { return this.bindings.get(id)?.projectId; }
  /** Every conversation of a project for the export, including those of an earlier task data generation (stale). */
  projectChats(projectId: string): (ChatSummary & { stale: boolean })[] {
    return [...this.bindings.values()].filter(binding => binding.projectId === projectId).map(binding => {
      let stale = false;
      if (binding.scope === 'task') try { stale = (binding.dataGeneration ?? 0) !== (this.ctx.studioDomain.task(binding.taskId).dataGeneration ?? 0); } catch { stale = true; }
      return { ...this.describeBinding(binding), stale };
    });
  }

  status() {
    return { milestone: 'M6', workflowMode: this.ctx.studioDomain.mode, softwareBackend: this.ctx.studioDomain.softwareBackend, workspaceMode: 'projects-and-tasks', workspaces: this.ctx.studioDomain.tasks().filter(task => task.kind === 'task' && !task.archived).map(task => task.id),
      tools: this.ctx.tools.schemas().map(tool => tool.name), providers: this.ctx.llm.listProviders(),
      defaults: this.ctx.studioModels.defaults(),
      chats: [...this.bindings.values()].filter(binding => binding.scope === 'project' || (binding.dataGeneration ?? 0) === (this.ctx.studioDomain.task(binding.taskId).dataGeneration ?? 0)).map(binding => {
        const summary = this.describeBinding(binding), agent = this.handles.get(binding.id)?.agent;
        const questions = agent ? this.ctx.sessionProjections?.stateOf(agent.session, 'userQuestions')?.questions.active ?? [] : this.activityQuestions.get(binding.id) ?? [];
        const queued = new Set([...(agent?.inbox?.nextStep ?? []), ...(agent?.inbox?.nextTurn ?? [])].flatMap(message => message.source.kind === 'user-question-reply' ? [message.source.callId] : []));
        return { ...summary, activity: chatActivity(this.activityFacts.get(binding.id) ?? emptyChatActivityFacts(), summary.status ?? 'stored', questions, queued) };
      }) };
  }

  private describeBinding(binding: Binding): ChatSummary {
    const { id, scope, projectId, provider, model } = binding;
    return { id, scope, projectId, ...(scope === 'task' ? { taskId: binding.taskId } : {}), provider, model, ...(binding.role ? { role: binding.role, runId: binding.runId } : {}), tempDirectory: `.chat-tmp/${id}`, status: this.handles.get(id)?.agent.status ?? 'stored' };
  }

  private binding(id: string): Binding {
    const binding = this.bindings.get(id);
    if (!binding) throw new Error('Unknown Studio chat');
    if (binding.scope === 'project') {
      this.ctx.studioDomain.graph(binding.projectId);
      if (this.ctx.studioDomain.projectDeleting(binding.projectId)) throw new Error('项目正在删除或等待删除重试，对话已冻结');
    } else {
      const task = this.ctx.studioDomain.task(binding.taskId);
      if (task.projectId !== binding.projectId) throw new Error('Task chat project changed');
      if (task.pendingAction === 'delete') throw new Error('任务正在删除或等待删除重试，会话已冻结');
      if (task.pendingAction === 'clear') throw new Error('任务正在清空或等待清空重试，会话已冻结');
      if ((binding.dataGeneration ?? 0) !== (task.dataGeneration ?? 0)) throw new Error('清空前的对话已失效，请新建对话');
    }
    return binding;
  }

  /** Project shared folder (vm_manager F:, or Studio's own in the no-software mode): human file panel and read-only Agent access. */
  sharedLease(projectId: string, write = false): WorkspaceLease {
    if (!this.ctx.studioDomain.fileStorage) throw new Error('当前部署没有项目公共空间（F 盘），请使用 vm-manager 后端');
    this.ctx.studioDomain.graph(projectId);
    if (write && this.ctx.studioDomain.projectDeleting(projectId)) throw new Error('项目正在删除或等待删除重试，项目公共空间已冻结');
    this.projectFiles.register(projectId); this.projectWorkspaceIds.add(projectId);
    return write ? this.projectFiles.lease(projectId) : this.projectFiles.readLease(projectId);
  }

  private async allocateProject(projectId: string, allowDeleting = false): Promise<void> {
    this.ctx.studioDomain.graph(projectId);
    if (!allowDeleting && this.ctx.studioDomain.projectDeleting(projectId)) throw new Error('项目正在删除或等待删除重试，项目工作区已冻结');
    this.projectFiles.register(projectId);
    this.projectWorkspaceIds.add(projectId);
    await this.projectFiles.allocate(projectId);
  }

  private projectWorkspaceOwner(projectId: string, taskId: string, allowLegacyGroup = false): void {
    if (this.closing) throw new Error('Studio is stopping');
    if (this.ctx.studioDomain.projectDeleting(projectId)) throw new Error('项目正在删除或等待删除重试，项目文件已冻结');
    // TaskView resolves archived ancestors as well as a node's own archive flag.
    const task = this.ctx.studioDomain.view(taskId);
    if (task.projectId !== projectId) throw new Error('Task workspace does not belong to selected project');
    if (task.kind !== 'task' && !(allowLegacyGroup && task.kind === 'group') || task.archived) throw new Error('Task workspace is unavailable');
    if (!this.ctx.studioDomain.projects().some(project => project.id === projectId)) throw new Error('项目不存在');
    // Registration issues a read capability only; it must not create a draft
    // directory as a side effect of expanding the project file tree.
    this.files.register(taskId);
  }

  async projectDirectory(projectId: string, taskId: string, path = '', offset = 0, limit = 100, signal?: AbortSignal): Promise<ProjectWorkspaceDirectory> {
    this.projectWorkspaceOwner(projectId, taskId);
    const listing = await this.files.listDirectory(this.files.readLease(taskId), path, offset, limit, signal);
    this.projectWorkspaceOwner(projectId, taskId);
    return { projectId, taskId, ...listing };
  }

  /** Listing authority follows the bound conversation. */
  private projectFileListOwner(agent: Agent | undefined): string {
    if (!agent) throw new Error('Agent identity required');
    if (this.closing) throw new Error('Studio is stopping');
    const binding = this.binding(agent.id);
    if (binding.scope === 'project') return this.projectOwner(agent);
    const owner = this.ctx.studioDomain.view(binding.taskId);
    if (owner.archived) throw new Error('Archived conversations cannot list project workspaces');
    if (this.files.readLease(binding.taskId).generation !== binding.generation) throw new Error('Workspace permission was revoked');
    return binding.projectId;
  }
  async listProjectFiles(agent: Agent | undefined, input: unknown = {}, signal?: AbortSignal) {
    throwIfAborted(signal);
    const args = object(input);
    if (Object.keys(args).some(key => !['taskId', 'path', 'offset', 'limit'].includes(key))) throw new Error('Project file list contains unsupported parameters');
    const projectId = this.projectFileListOwner(agent);
    const taskId = args.taskId;
    if (taskId !== undefined) {
      if (typeof taskId !== 'string' || !taskId || taskId.length > 64) throw new Error('Expected internal taskId');
      const path = args.path === undefined ? '' : args.path; if (typeof path !== 'string' || path.length > 8000) throw new Error('Expected a bounded relative directory path');
      const offset = args.offset === undefined ? 0 : args.offset, limit = args.limit === undefined ? 100 : args.limit;
      if (!Number.isSafeInteger(offset) || Number(offset) < 0) throw new Error('Directory list offset must be a nonnegative integer');
      if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 200) throw new Error('Directory list limit must be between 1 and 200');
      const result = await this.projectDirectory(projectId, taskId, path, Number(offset), Number(limit), signal);
      throwIfAborted(signal); this.projectFileListOwner(agent); return result;
    }
    if (args.path !== undefined) throw new Error('A directory path requires taskId; first list project workspaces');
    const offset = args.offset === undefined ? 0 : args.offset, limit = args.limit === undefined ? 50 : args.limit;
    if (!Number.isSafeInteger(offset) || Number(offset) < 0) throw new Error('Workspace list offset must be a nonnegative integer');
    if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100) throw new Error('Workspace list limit must be between 1 and 100');
    const tasks: Array<{ id: string; code: string; title: string; rank: number; parentId?: string; state: string }> = [];
    const rows = this.ctx.studioDomain.tasks(projectId);
    if (rows.length > 100000) throw new Error('Project workspace listing exceeds 100000 tasks');
    const byId = new Map(rows.map(task => [task.id, task]));
    const archived = (task: typeof rows[number]): boolean => {
      const seen = new Set<string>(); let current = task;
      while (true) {
        if (seen.has(current.id)) throw new Error('Task hierarchy contains a cycle'); seen.add(current.id);
        if (current.archived || current.state === 'discarded') return true;
        if (!current.parentId) return false; const parent = byId.get(current.parentId);
        if (!parent) throw new Error('Task hierarchy parent is unavailable'); current = parent;
      }
    };
    let examined = 0;
    for (const task of rows) {
      if (++examined > 100000) throw new Error('Project workspace listing exceeds 100000 tasks');
      if (examined % 100 === 0) { await yieldToEventLoop(undefined, { signal }); throwIfAborted(signal); }
      if (task.kind !== 'task' || archived(task)) continue;
      tasks.push({ id: task.id, code: task.code, title: task.title, rank: task.rank, ...(task.parentId ? { parentId: task.parentId } : {}), state: task.state });
    }
    throwIfAborted(signal); this.projectFileListOwner(agent);
    const page = tasks.slice(Number(offset), Number(offset) + Number(limit)), total = tasks.length;
    return { projectId, tasks: page, offset, limit, total, ...(Number(offset) + page.length < total ? { nextOffset: Number(offset) + page.length } : {}) };
  }

  /** Mutable project-workspace references are readable only from a live task conversation. */
  private projectFileReadOwner(agent: Agent | undefined): { projectId: string; taskId: string } {
    if (!agent) throw new Error('Agent identity required');
    if (this.closing) throw new Error('Studio is stopping');
    const binding = this.binding(agent.id);
    if (binding.scope !== 'task') throw new Error('Project workspace contents require an active task conversation');
    this.ctx.studioDomain.assertDiscussionWritable(binding.taskId);
    if (this.files.readLease(binding.taskId).generation !== binding.generation) throw new Error('Workspace permission was revoked');
    return { projectId: binding.projectId, taskId: binding.taskId };
  }

  private projectFileReadTarget(projectId: string, taskId: string) {
    this.projectWorkspaceOwner(projectId, taskId);
    const task = this.ctx.studioDomain.view(taskId);
    if (task.pendingAction === 'clear' || task.pendingAction === 'delete') throw new Error('Target task workspace is being cleared or deleted');
    return task;
  }

  async readProjectFile(agent: Agent | undefined, input: unknown, signal?: AbortSignal) {
    throwIfAborted(signal);
    const args = object(input);
    if (Object.keys(args).some(key => !['taskId', 'path'].includes(key))) throw new Error('Project file read contains unsupported parameters');
    const taskId = args.taskId, path = args.path;
    if (typeof taskId !== 'string' || !taskId || taskId.length > 64) throw new Error('Expected internal taskId');
    if (typeof path !== 'string' || !path || path.length > 8000) throw new Error('Expected a bounded relative file path');
    const owner = this.projectFileReadOwner(agent); this.projectFileReadTarget(owner.projectId, taskId);
    const preview = await this.files.preview(this.files.readLease(taskId), path);
    throwIfAborted(signal);
    const currentOwner = this.projectFileReadOwner(agent), currentTarget = this.projectFileReadTarget(currentOwner.projectId, taskId);
    if (currentOwner.projectId !== owner.projectId || currentOwner.taskId !== owner.taskId) throw new Error('Task conversation ownership changed');
    return { projectId: owner.projectId, taskId, taskState: currentTarget.state, source: 'task-workspace', formalInput: false, ...preview };
  }

  async projectFile(projectId: string, taskId: string, path: string): Promise<ProjectWorkspaceFilePreview> {
    // A legacy group may have its own saved files in the completion preview.
    // This human-only read grants neither directory listing nor agent writes.
    this.projectWorkspaceOwner(projectId, taskId, true);
    const preview = await this.files.preview(this.files.readLease(taskId), path);
    this.projectWorkspaceOwner(projectId, taskId, true);
    return { projectId, taskId, ...preview };
  }

  /** Read handles for the human file views, with each view's own access check: a task's D:, any task's D: in 项目文件, and F:. */
  openDownload(source: string | undefined, query: Record<string, string>, path: string) {
    if (source === 'task') { const id = stringField(query, 'taskId'); this.ctx.studioDomain.task(id); return this.files.openFile(this.files.readLease(id), path); }
    if (source === 'project') { const projectId = stringField(query, 'projectId'), taskId = stringField(query, 'taskId'); this.projectWorkspaceOwner(projectId, taskId, true); return this.files.openFile(this.files.readLease(taskId), path); }
    if (source === 'shared') return this.projectFiles.openFile(this.sharedLease(stringField(query, 'projectId')), path);
    throw new Error('文件下载来源无效');
  }

  scratchFor(id: string): ChatScratch { return this.binding(id).scope === 'project' ? this.projectScratch : this.scratch; }

  agentStorage(agent: Agent | undefined): { lease: WorkspaceLease; scratch: ChatScratch } {
    if (!agent) throw new Error('Agent identity required');
    return { lease: this.boundLease(agent.id), scratch: this.scratchFor(agent.id) };
  }

  taskLease(agent: Agent | undefined): WorkspaceLease {
    if (!agent) throw new Error('Agent identity required');
    const binding = this.binding(agent.id);
    if (binding.scope !== 'task') throw new Error('Task tools require a task conversation');
    return binding;
  }

  /** Current children are planning metadata; input manifests follow immutable executed references only. */
  taskContext(agent: Agent | undefined) {
    const domain = this.ctx.studioDomain, task = domain.view(this.taskLease(agent).taskId);
    const limit = 200, fileLimit = 100;
    const direct = task.archived ? [] : domain.tasks(task.projectId).filter(child => child.parentId === task.id && !child.archived);
    const children = direct.slice(0, limit).map(child => {
      const view = domain.view(child.id);
      return { id: view.id, code: view.code, parentId: view.parentId, title: view.title, state: view.state, goal: view.goal,
        isFolder: view.isFolder, leafStats: view.leafStats, currentResultId: resultSnapshotId(view, view.workflowMode) ?? null, completedId: view.completedId ?? null, acceptedId: view.acceptedId ?? null, recheckReason: view.recheckReason ?? null, archived: !!view.archived };
    });
    const queue: InputRef[] = [], queued = new Map<string, string>();
    let inputSnapshotsTruncated = false;
    const enqueue = (ref: InputRef) => {
      const owner = queued.get(ref.snapshotId);
      if (owner !== undefined) { if (owner !== ref.taskId) throw new Error('实际输入快照引用归属不一致'); return; }
      if (queue.length >= limit) { inputSnapshotsTruncated = true; return; }
      queued.set(ref.snapshotId, ref.taskId); queue.push(ref);
    };
    task.inputs.forEach(enqueue);
    const inputSnapshots: Array<{ taskId: string; snapshotId: string; files: SnapshotFile[]; filesTotal: number; filesTruncated: boolean;
      childrenRefs: InputRef[]; childrenRefsTotal: number; childrenRefsTruncated: boolean }> = [];
    for (let index = 0; index < queue.length; index++) {
      const ref = queue[index], snapshot = domain.snapshot(ref.snapshotId);
      if (snapshot.taskId !== ref.taskId || domain.task(ref.taskId).projectId !== task.projectId) throw new Error('实际输入快照不属于当前项目或引用任务');
      const refs = snapshot.childrenRefs ?? [], shownRefs = refs.slice(0, limit);
      if (refs.length > limit) inputSnapshotsTruncated = true;
      shownRefs.forEach(enqueue);
      inputSnapshots.push({ taskId: snapshot.taskId, snapshotId: snapshot.id,
        files: snapshot.files.slice(0, fileLimit), filesTotal: snapshot.files.length, filesTruncated: snapshot.files.length > fileLimit,
        childrenRefs: shownRefs, childrenRefsTotal: refs.length, childrenRefsTruncated: refs.length > limit });
    }
    return { ...task, children, childrenTotal: direct.length, childrenTruncated: direct.length > limit,
      inputSnapshots, inputSnapshotsLimit: limit, inputSnapshotsTruncated };
  }

  projectOwner(agent: Agent | undefined): string {
    if (!agent) throw new Error('Agent identity required');
    const binding = this.binding(agent.id);
    if (binding.scope !== 'project') throw new Error('Project planning tools require a project conversation');
    if (this.closing) throw new Error('Studio is stopping');
    if (this.projectFiles.lease(binding.projectId).generation !== binding.generation) throw new Error('Workspace permission was revoked');
    return binding.projectId;
  }

  taskCreationOwner(agent: Agent | undefined): { projectId: string; parentId?: string } {
    if (!agent) throw new Error('Agent identity required');
    const binding = this.binding(agent.id);
    if (binding.scope === 'project') return { projectId: this.projectOwner(agent) };
    if (this.closing) throw new Error('Studio is stopping');
    this.ctx.studioDomain.assertDiscussionWritable(binding.taskId);
    if (this.files.readLease(binding.taskId).generation !== binding.generation) throw new Error('Workspace permission was revoked');
    return { projectId: binding.projectId, parentId: binding.taskId };
  }

  /** Product plugins may add instructions without replacing the Harness loop or shared prompts. With a role, only that role's
   * conversations of an unfinished autonomy run see them. */
  registerInstructions(name: string, order: number, text: string, role?: AutonomyRole): () => void {
    if (this.instructionSections.has(name)) throw new Error('Duplicate Studio instruction section');
    const section = { order, text, ...(role ? { role } : {}) };
    this.instructionSections.set(name, section);
    return () => { if (this.instructionSections.get(name) === section) this.instructionSections.delete(name); };
  }

  /** External producers must stop before domain snapshots or permanent deletion. */
  registerQuiescence(name: string, stop: (taskIds: string[]) => Promise<void>): () => void {
    if (this.producerQuiescence.has(name)) throw new Error('Duplicate task producer');
    this.producerQuiescence.set(name, stop);
    return () => { if (this.producerQuiescence.get(name) === stop) this.producerQuiescence.delete(name); };
  }
  async stopProducers(taskIds: string[]): Promise<void> { for (const stop of this.producerQuiescence.values()) await stop(taskIds); }

  /** The autonomy plugin answers role, scope and VM questions; without it every conversation is ordinary. */
  bindAutonomy(bridge: AutonomyBridge): () => void {
    if (this.autonomy) throw new Error('Duplicate autonomy bridge');
    this.autonomy = bridge;
    return () => { if (this.autonomy === bridge) this.autonomy = undefined; };
  }
  /** Role and run of a conversation while its run is unfinished. */
  autonomyAccess(chatId: string) { return this.autonomy?.access(chatId); }
  /** The stored role marks of a conversation, also after its run ended. */
  chatRole(chatId: string): { role: AutonomyRole; runId: string } | undefined {
    const binding = this.bindings.get(chatId);
    return binding?.role && binding.runId ? { role: binding.role, runId: binding.runId } : undefined;
  }
  /** The provider and model a conversation uses; an Agent completion record names them. */
  chatModel(chatId: string): { provider: string; model: string } { const binding = this.binding(chatId); return { provider: binding.provider, model: binding.model }; }
  /** In a task-branch run the run's Agents change the graph and checklists only inside the branch; null is the project root.
   * structural IDs are moved, re-linked or removed: the branch root's place and prerequisites belong to the graph outside. */
  assertAutonomyScope(agent: Agent | undefined, taskIds: readonly (string | null)[], structural: readonly string[] = []): void {
    if (!agent) throw new Error('Agent identity required');
    const access = this.autonomy?.access(agent.id), scope = access?.scope;
    if (!scope) return;
    const outside = taskIds.filter(id => id === null || !scope.has(id));
    if (outside.length) throw new Error(`自主运行的范围是一个任务分支，只能修改分支根任务及其后代；${outside.includes(null) ? '不能在项目根层创建或移动任务' : `以下任务不在范围内：${[...new Set(outside)].join('、')}`}`);
    if (access.rootTaskId && structural.includes(access.rootTaskId)) throw new Error('分支根任务的位置、前置依赖和删除属于范围外的图谱，自主运行不能修改');
  }
  private vmCounter?: (owners: ReadonlySet<string>) => Promise<number>;
  /** The VM backend counts the VMs of a set of conversations that are starting or running (autonomy usage and limits). */
  registerVmCounter(counter: (owners: ReadonlySet<string>) => Promise<number>): () => void {
    this.vmCounter = counter;
    return () => { if (this.vmCounter === counter) this.vmCounter = undefined; };
  }
  countVms(owners: ReadonlySet<string>): Promise<number> { return this.vmCounter ? this.vmCounter(owners) : Promise.resolve(0); }
  /** VM ceiling of the autonomy run a conversation belongs to (vm-seat checks it before starting a VM). */
  autonomyVmQuota(chatId: string) { return this.autonomy?.vmQuota(chatId); }
  /** Whether a conversation can still act: it exists and its task was not deleted, cleared or frozen for deletion. */
  chatUsable(id: string): boolean { try { this.binding(id); return true; } catch { return false; } }
  /** Live Agent of a conversation, if it is loaded. */
  liveAgent(id: string): Agent | undefined { return this.handles.get(id)?.agent; }

  /** A new orchestrator or worker conversation with its first message, through the same path as a person's first message. */
  startAutonomyChat(input: { scope: 'project' | 'task'; ownerId: string; role: AutonomyRole; runId: string; provider: string; model: string; message: string; from: AutonomySource['from'] }) {
    const extra = { source: { kind: 'harnessstudio-autonomy' as const, runId: input.runId, from: input.from }, role: input.role, runId: input.runId };
    if (input.scope === 'project') {
      this.ctx.studioDomain.graph(input.ownerId);
      if (this.ctx.studioDomain.projectDeleting(input.ownerId)) throw new Error('项目正在删除或等待删除重试，不能继续对话');
      return this.sendOwned('project', input.ownerId, input.ownerId, input.message, input.provider, input.model, undefined, undefined, extra);
    }
    const task = this.ctx.studioDomain.task(input.ownerId);
    return this.ctx.studioDomain.discussion(input.ownerId, () => this.sendOwned('task', input.ownerId, task.projectId, input.message, input.provider, input.model, undefined, undefined, extra));
  }
  /** A message from the orchestrator or the controller to a run conversation: a running Agent reads it at its next step,
   * an idle one starts a turn. */
  sendAutonomyMessage(chatId: string, input: { runId: string; from: AutonomySource['from']; message: string }) {
    const binding = this.binding(chatId);
    if (binding.runId !== input.runId) throw new Error('该对话不属于这次自主运行');
    const extra = { source: { kind: 'harnessstudio-autonomy' as const, runId: input.runId, from: input.from }, steer: true };
    if (binding.scope === 'project') return this.sendOwned('project', binding.projectId, binding.projectId, input.message, binding.provider, binding.model, chatId, undefined, extra);
    return this.ctx.studioDomain.discussion(binding.taskId, () => this.sendOwned('task', binding.taskId, binding.projectId, input.message, binding.provider, binding.model, chatId, undefined, extra));
  }
  /** Ends the current turn and keeps queued messages (pause, budget and stop of a run). */
  interrupt(id: string): void {
    const agent = this.handles.get(id)?.agent;
    if (agent?.status === 'running') agent.cancel({ kind: 'user' }, { keepInbox: true });
  }
  /** Loads a run conversation to continue its goal after a pause or restart. Unlike a person's message it does not need
   * a writable task: an orchestrator may already have completed its own root task. */
  resumeAutonomyAgent(id: string): Promise<Agent> {
    return this.mutate(async () => {
      const live = this.handles.get(id); if (live) return live.agent;
      const stored = this.binding(id);
      const lease = stored.scope === 'project' ? this.projectFiles.lease(stored.projectId) : this.files.readLease(stored.taskId);
      const binding = { ...stored, ...lease }; this.bindings.set(id, binding);
      const handle = await this.ctx.agents.resume({ resumeSessionId: SessionId(id), agentOptions: { provider: binding.provider, model: binding.model }, setup: this.setup(binding) });
      this.handles.set(id, handle); await this.saveBindings();
      return handle.agent;
    });
  }
  /** Completing a task freezes it and closes its live conversations; the conversation inside its own completion call keeps
   * its turn to read the result. Its write permission is revoked like everyone else's. */
  async whileCompleting<T>(chatId: string, operation: () => Promise<T>): Promise<T> {
    this.completing.set(chatId, (this.completing.get(chatId) ?? 0) + 1);
    try { return await operation(); }
    finally { const count = (this.completing.get(chatId) ?? 1) - 1; if (count) this.completing.set(chatId, count); else this.completing.delete(chatId); }
  }

  graphPlanningScope(agent: Agent | undefined, write = false): GraphPlanningScope {
    if (!agent) throw new Error('Agent identity required');
    if (this.closing) throw new Error('Studio is stopping');
    const binding = this.binding(agent.id);
    if (write) this.taskCreationOwner(agent);
    return { projectId: binding.projectId, ...(binding.scope === 'task' ? { taskId: binding.taskId } : {}) };
  }

  chatLease(id: string, write = false): WorkspaceLease {
    if (write && this.closing) throw new Error('Studio is stopping');
    const binding = this.binding(id), files = binding.scope === 'project' ? this.projectFiles : this.files;
    if (write && binding.scope === 'task') {
      this.ctx.studioDomain.assertDiscussionWritable(binding.taskId);
      return files.readLease(binding.taskId);
    }
    return write ? files.lease(binding.taskId) : files.readLease(binding.taskId);
  }

  boundLease(id: string): WorkspaceLease {
    return this.binding(id);
  }

  /** The project and, in a task conversation, the task a conversation acts in; refuses deleting or cleared owners like its other tools. */
  chatScope(id: string): { scope: 'project'; projectId: string } | { scope: 'task'; projectId: string; taskId: string } {
    if (this.closing) throw new Error('Studio is stopping');
    const binding = this.binding(id);
    return binding.scope === 'task' ? { scope: 'task', projectId: binding.projectId, taskId: binding.taskId } : { scope: 'project', projectId: binding.projectId };
  }

  writeTemp(id: string, path: string, content: string) {
    const binding = this.binding(id);
    if (binding.scope === 'project') return this.projectScratch.write(this.chatLease(id, true), id, path, content);
    return this.ctx.studioDomain.discussion(binding.taskId, () => this.scratch.write(this.chatLease(id, true), id, path, content));
  }

  async send(taskId: string, message: string, provider: string, model: string, chatId?: string, attachments?: unknown) {
    if (message.length > 32768) throw new Error('Message too large');
    const task = this.ctx.studioDomain.task(taskId);
    this.checkChatOwner('task', taskId, task.projectId, provider, model, chatId);
    return this.ctx.studioDomain.discussion(taskId, () => this.sendOwned('task', taskId, task.projectId, message, provider, model, chatId, attachments));
  }

  sendProject(projectId: string, message: string, provider: string, model: string, chatId?: string, attachments?: unknown) {
    if (message.length > 32768) throw new Error('Message too large');
    this.ctx.studioDomain.graph(projectId);
    if (this.ctx.studioDomain.projectDeleting(projectId)) throw new Error('项目正在删除或等待删除重试，不能继续对话');
    this.checkChatOwner('project', projectId, projectId, provider, model, chatId);
    return this.sendOwned('project', projectId, projectId, message, provider, model, chatId, attachments);
  }

  private checkChatOwner(scope: Binding['scope'], ownerId: string, projectId: string, provider: string, model: string, chatId?: string): void {
    if (chatId === undefined) return;
    const found = this.binding(chatId);
    if (found.scope !== scope || found.taskId !== ownerId || found.projectId !== projectId) throw new Error('Chat does not belong to selected scope or owner');
    if (found.provider !== provider || found.model !== model) throw new Error('已有对话使用其原 Provider 和模型；切换模型请创建新对话');
  }

  private sendOwned(scope: Binding['scope'], ownerId: string, projectId: string, message: string, provider: string, model: string, chatId?: string, attachments?: unknown,
    extra: { source?: AutonomySource; role?: AutonomyRole; runId?: string; steer?: boolean } = {}) {
    if (message.length > 32768) throw new Error('Message too large');
    const uploads = parseChatAttachmentUploads(attachments);
    if (!message.trim() && !uploads.length) throw new Error('请输入需求或上传参考图纸');
    return this.mutate(async () => {
      if (uploads.length) assertAttachmentVision(await this.ctx.llm.resolveModelInfo(provider, model));
      if (scope === 'project') await this.allocateProject(projectId);
      const files = scope === 'project' ? this.projectFiles : this.files, scratch = scope === 'project' ? this.projectScratch : this.scratch;
      const lease = scope === 'project' ? files.lease(ownerId) : files.readLease(ownerId);
      let binding: Binding;
      let handle: AgentHandle;
      let admitted: Awaited<ReturnType<ChatAttachments['admit']>>;
      if (chatId !== undefined) {
        this.checkChatOwner(scope, ownerId, projectId, provider, model, chatId);
        const found = this.bindings.get(chatId);
        if (!found) throw new Error('Unknown Studio chat');
        binding = { ...found, ...lease }; this.bindings.set(binding.id, binding);
        admitted = await this.attachments.admit(this.attachmentOwner(binding), uploads);
        await scratch.ensure(binding, binding.id);
        const live = this.handles.get(chatId);
        handle = live ?? await this.ctx.agents.resume({ resumeSessionId: SessionId(chatId),
          agentOptions: { provider: binding.provider, model: binding.model }, setup: this.setup(binding) });
      } else {
        await this.ctx.studioModels.validateSelection(provider, model);
        binding = { ...lease, id: randomUUID(), scope, projectId, provider, model,
          ...(scope === 'task' ? { dataGeneration: this.ctx.studioDomain.task(ownerId).dataGeneration ?? 0 } : {}), ...(extra.role ? { role: extra.role, runId: extra.runId } : {}) };
        // Decode and render before creating a Session; refused uploads leave no conversation.
        admitted = await this.attachments.admit(this.attachmentOwner(binding), uploads);
        this.bindings.set(binding.id, binding);
        try {
          await scratch.ensure(binding, binding.id);
          handle = await this.ctx.agents.create({ sessionId: SessionId(binding.id),
            meta: { cwd: files.directory(ownerId), agentPreset: binding.role ? AUTONOMY_PRESET : 'studio' },
            agentOptions: { provider, model }, setup: this.setup(binding) });
        } catch (error) { this.bindings.delete(binding.id); await this.attachments.remove([binding.id]); throw error; }
      }
      this.handles.set(binding.id, handle);
      await this.saveBindings();
      const prompt = createUserMessage({ source: extra.source ?? { kind: 'user' }, content: [...(message.trim() ? [{ type: 'text' as const, text: message }] : []), ...admitted.content] });
      if (extra.steer) handle.agent.steer(prompt); else handle.agent.followup(prompt);
      return { ...this.describeBinding(binding), status: handle.agent.status, attachments: admitted.attachments };
    });
  }

  private setup(binding: Binding) {
    return async (agentCtx: Context): Promise<void> => {
      await this.ctx.agentPresets.mount(agentCtx, binding.role ? AUTONOMY_PRESET : 'studio');
      // Tools follow the role while the run is unfinished; after it ends a run conversation loses them at its next load,
      // and every autonomy tool also refuses at execution.
      const role = this.autonomy?.access(binding.id)?.role;
      // The seat backend registers either the Mock or the VM tool set; restrict() rejects names that are not registered.
      agentCtx.tools.restrict({ deny: [...binding.scope === 'project' ? taskOnlyTools : ['studio_project_context'], ...autonomyDenied(role)].filter(name => agentCtx.tools.get(name)) });
      // The goal tools' global guidance would otherwise reach conversations that cannot see those tools.
      if (role !== 'orchestrator') agentCtx.systemPrompt.section({ name: 'tool:goal', order: 0, text: '', interpolate: false });
      agentCtx.systemPrompt.section({ name: 'studio:engineering', order: 100, text: binding.scope === 'project' ? this.projectPrompt : this.prompt, interpolate: false });
      for (const [name, section] of this.instructionSections) agentCtx.systemPrompt.section({ name: `studio:${name}`, order: section.order, interpolate: false,
        text: () => { const current = this.instructionSections.get(name); return !current || current.role && this.autonomy?.access(binding.id)?.role !== current.role ? '' : current.text; } });
      const autonomy = () => { const value = this.autonomy?.access(binding.id) ? this.autonomy.liveContext(binding.id) : undefined; return value === undefined ? {} : { autonomy: value }; };
      // An orchestrator's section stays the same for the whole run (see AutonomyController.liveContext); after the run it
      // is an ordinary conversation again.
      const orchestrating = () => this.autonomy?.access(binding.id)?.role === 'orchestrator';
      const orchestratorContext = () => {
        const project = this.ctx.studioDomain.projects().find(row => row.id === binding.projectId), root = binding.scope === 'task' ? this.ctx.studioDomain.task(binding.taskId) : undefined;
        return `Autonomy run context (fixed while the run lasts). The tasks in scope, their states, budget use and the tasks you may confirm now (canConfirmNow) come from studio_autonomy_status; graph details from studio_graph_context.\n${JSON.stringify({
          project: { id: binding.projectId, title: project?.title ?? '' }, ...(root ? { rootTask: { id: root.id, code: root.code, title: root.title } } : {}), ...autonomy() })}`;
      };
      if (binding.scope === 'project') agentCtx.systemPrompt.section({ name: 'studio:project-context', order: 105,
        text: () => orchestrating() ? orchestratorContext() : this.projectLiveContextPrompt.render(JSON.stringify({ ...this.ctx.studioDomain.planningContext({ projectId: binding.projectId }, { limit: 50 }), ...autonomy() })), interpolate: false });
      else agentCtx.systemPrompt.section({ name: 'studio:task-discussion', order: 105, interpolate: false,
        text: () => {
          if (orchestrating()) return orchestratorContext();
          const task = this.ctx.studioDomain.view(binding.taskId), singleUser = this.ctx.studioDomain.mode === 'single-user';
          const current = singleUser ? { id: task.id, projectId: task.projectId, code: task.code, title: task.title, description: task.goal, checklist: task.checklist, revision: task.revision, state: task.state, parentId: task.parentId, isFolder: task.isFolder, childCount: task.childCount, leafStats: task.leafStats, dependencies: task.dependencies, inputs: task.inputs, blockers: task.blockers, writable: task.writable, canDiscuss: task.canDiscuss, canEditMetadata: task.canEditMetadata, pending: task.pending, dependencyRepairRequired: task.dependencyRepairRequired, recheckReason: task.recheckReason, currentResultId: resultSnapshotId(task, task.workflowMode) ?? null } : task;
          return (singleUser ? this.taskLiveContextSingleUserPrompt : this.taskLiveContextReviewedPrompt).render(JSON.stringify({ ...current, ...autonomy() }));
        } });
      agentCtx.systemPrompt.section({ name: 'studio:chat-temp', order: 110, interpolate: false,
        text: binding.scope === 'task' ? this.taskChatTempPrompt : this.projectChatTempPrompt });
    };
  }

  async chat(id: string) {
    const binding = this.binding(id);
    await this.ctx.sessionPersistence.flush();
    const reader = await this.ctx.sessionPersistence.open(SessionId(id), 'read');
    try {
      const { events } = await reader.read();
      this.binding(id); // A concurrent deletion cannot return a stale readable chat.
      // Cold reads replay existing native projection definitions, without
      // creating/resuming an Agent or contacting any model/provider.
      const { snapshot } = this.ctx.sessionProjections.restore({}, events, SessionLogOffset(0), reader.header, reader.inheritedEventCount);
      const metrics = chatMetrics(snapshot, usageFacts(events));
      return { ...this.describeBinding(binding), status: this.handles.get(id)?.agent.status ?? 'stored', events, metrics };
    } finally { await reader.close(); }
  }

  chatRequests(id: string, userSeq: number) { return this.chatTransfer.requests(id, userSeq); }
  chatRequest(id: string, requestId: string) { return this.chatTransfer.request(id, requestId); }
  backupChat(id: string, signal?: AbortSignal) { return this.mutate(() => this.chatTransfer.backup(id, signal)); }
  /** The project export's read of one conversation (chat-export.ts). Unlike backupChat it also reads a running
   * conversation, as saved so far, and one a task clear made stale. Only this snapshot holds the mutation queue. */
  exportChat(id: string, exportedAt: Date, signal?: AbortSignal) {
    return this.mutate(async () => {
      const binding = this.bindings.get(id); if (!binding) throw new Error('对话不存在');
      const source = this.projectChats(binding.projectId).find(row => row.id === id)!;
      let scratch: string | undefined;
      try { scratch = await this.scratchFor(id).existing(this.chatLease(id), id); } catch { /* a cleared or deleting owner refuses the lease: its temporary files went with the task's data */ }
      return readChatExport(this.ctx, this.root, source, scratch, exportedAt, signal);
    });
  }

  private attachmentOwner(binding: Binding): ChatAttachmentOwner {
    return { id: binding.id, scope: binding.scope, projectId: binding.projectId, ...(binding.scope === 'task' ? { taskId: binding.taskId } : {}) };
  }
  async chatAttachments(id: string) {
    const attachments = await this.attachments.list(this.attachmentOwner(this.binding(id)));
    this.binding(id); return { id, attachments };
  }
  async chatAttachment(id: string, attachmentId: string, page?: number) {
    const file = await this.attachments.read(this.attachmentOwner(this.binding(id)), attachmentId, page);
    this.binding(id); return file;
  }

  /** Native question replies resume only this owned session with its original tools and scope. */
  ensureQuestionAgent(id: string): Promise<Agent> {
    return this.mutate(async () => {
      const stored = this.binding(id), lease = this.chatLease(id, true);
      const live = this.handles.get(id);
      if (live) {
        if (stored.generation !== lease.generation) throw new Error('当前对话的任务许可已失效，请重新打开对话');
        return live.agent;
      }
      const binding = { ...stored, ...lease }; this.bindings.set(id, binding);
      const handle = await this.ctx.agents.resume({ resumeSessionId: SessionId(id),
        agentOptions: { provider: binding.provider, model: binding.model }, setup: this.setup(binding) });
      this.handles.set(id, handle); await this.saveBindings();
      return handle.agent;
    });
  }

  stream(id: string, signal: AbortSignal): Response {
    this.binding(id);
    return this.streams.response(id, signal, () => this.chat(id));
  }

  stop(id: string): Promise<void> {
    return this.mutate(async () => {
      this.binding(id);
      const agent = this.handles.get(id)?.agent;
      if (agent?.status === 'running') this.autonomy?.stopped(id);
      agent?.cancel({ kind: 'user' });
      return agent;
    }).then(async agent => { await agent?.whenIdle(); });
  }

  quiesce(taskIds: string[]): Promise<void> {
    return this.mutate(async () => {
      for (const [id, handle] of this.handles) { const binding = this.bindings.get(id)!; if (binding.scope === 'task' && taskIds.includes(binding.taskId) && !this.completing.has(id)) { await handle.dispose(); this.handles.delete(id); } }
      await this.ctx.sessionPersistence.flush();
      await this.stopProducers(taskIds);
    });
  }

  /** Human-confirmed domain deletion owns this callback; no model tool exposes it. */
  deleteTaskConversations(taskId: string): Promise<void> {
    return this.mutate(async () => {
      const current = [...this.bindings.values()].filter(binding => binding.scope === 'task' && binding.taskId === taskId).map(binding => binding.id);
      // A prior crash may have materialized a Session before saving its chat binding.
      // Its public header still identifies this exact managed workspace owner.
      const directory = this.files.directory(taskId);
      for (const stored of await this.ctx.sessionPersistence.list()) if (stored.header.cwd === directory) current.push(stored.header.id);
      const ids = await this.conversationDeletion.prepare(taskId, current);
      for (const id of ids) {
        await this.handles.get(id)?.dispose(); this.handles.delete(id); this.streams.remove(id);
      }
      await this.ctx.sessionPersistence.flush();
      await this.conversationDeletion.removeSessions(ids);
      await this.attachments.remove(ids);
      for (const id of ids) await this.ctx.get?.('studioAudit')?.purge(id);
      // Observe absence through the public persistence contract rather than touching
      // its private caches. IDs are never reused and deleted sessions cannot reopen.
      for (const id of ids) if (await this.ctx.sessionPersistence.stat(SessionId(id))) throw new Error('会话仍在持久化存储中，删除已冻结，请重试');
      for (const id of ids) {
        this.bindings.delete(id);
        this.activityFacts.delete(id); this.activityQuestions.delete(id);
      }
      await this.saveBindings();
      await this.conversationDeletion.finish(taskId);
    });
  }

  /** Whole-project deletion additionally owns planning chats and their workspace. */
  deleteProjectConversations(projectId: string, taskIds: string[]): Promise<void> {
    this.projectFiles.register(projectId);
    this.projectFiles.revoke(projectId);
    return this.mutate(async () => {
      const taskSet = new Set(taskIds);
      if (taskSet.size !== taskIds.length || taskIds.some(id => this.ctx.studioDomain.task(id).projectId !== projectId)) throw new Error('项目会话清理范围无效');
      const current = [...this.bindings.values()].filter(binding => binding.projectId === projectId).map(binding => binding.id);
      // Recover Sessions whose process crashed before chats.json was saved. Both
      // project planning and every captured task cwd are exact ownership proofs.
      const directories = new Set([this.projectFiles.directory(projectId), ...taskIds.map(id => this.files.directory(id))]);
      for (const stored of await this.ctx.sessionPersistence.list()) if (stored.header.cwd && directories.has(stored.header.cwd)) current.push(stored.header.id);
      const ids = await this.conversationDeletion.prepare(projectId, current);
      for (const id of ids) {
        await this.handles.get(id)?.dispose(); this.handles.delete(id); this.streams.remove(id);
      }
      await this.ctx.sessionPersistence.flush();
      await this.conversationDeletion.removeSessions(ids);
      await this.attachments.remove(ids);
      for (const id of ids) await this.ctx.get?.('studioAudit')?.purge(id);
      for (const id of ids) if (await this.ctx.sessionPersistence.stat(SessionId(id))) throw new Error('项目会话仍在持久化存储中，删除已冻结，请重试');
      for (const id of ids) {
        this.bindings.delete(id); this.activityFacts.delete(id); this.activityQuestions.delete(id);
      }
      await this.projectFiles.drain();
      await this.projectFiles.deleteTask(projectId);
      this.projectWorkspaceIds.delete(projectId);
      await this.saveBindings();
      await this.conversationDeletion.finish(projectId);
    });
  }

  /** Internal purge primitive. M2/M5 must gate it by state and human confirmation; no production route exposes it. */
  purge(taskId: string): Promise<void> {
    this.files.revoke(taskId);
    return this.mutate(async () => {
      const records = [...this.bindings.values()].filter(binding => binding.scope === 'task' && binding.taskId === taskId);
      for (const binding of records) {
        await this.handles.get(binding.id)?.dispose();
        this.handles.delete(binding.id);
        await this.ctx.get?.('studioAudit')?.purge(binding.id);
      }
      await this.ctx.sessionPersistence.flush();
      const sessionsRoot = join(this.root, 'sessions');
      const parents = await readdir(sessionsRoot, { withFileTypes: true }).catch(error => {
        if (error.code === 'ENOENT') return []; throw error;
      });
      for (const binding of records) {
        // UUID ids are unchanged by DSH's segment encoder. Never derive or duplicate the cwd encoder.
        for (const parent of parents) {
          if (!parent.isDirectory()) continue;
          const candidate = join(sessionsRoot, parent.name, binding.id);
          let info;
          try { info = await lstat(candidate); }
          catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue; throw error; }
          if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Refusing unexpected Session artifact');
          await rm(candidate, { recursive: true });
        }
        this.bindings.delete(binding.id);
        this.activityFacts.delete(binding.id); this.activityQuestions.delete(binding.id);
      }
      await this.attachments.remove(records.map(binding => binding.id));
      await this.files.purge(taskId);
      await this.saveBindings();
      this.files.reopen(taskId);
    });
  }

  async dispose(): Promise<void> {
    this.closing = true;
    for (const task of this.ctx.studioDomain.tasks()) if (task.kind === 'task') { this.files.register(task.id); this.files.revoke(task.id); }
    for (const id of this.projectWorkspaceIds) this.projectFiles.revoke(id);
    await this.mutations.catch(() => undefined);
    await Promise.all([...this.handles.values()].map(handle => handle.dispose()));
    this.handles.clear();
    this.streams.close();
    await Promise.all([this.files.drain(), this.projectFiles.drain()]);
  }
}

/** Bind guarded human API actions and scoped model tools to the same file service. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const runtime = new StudioRuntime(ctx, config);
  let zipExtractionTail: Promise<unknown> = Promise.resolve();
  const serializeZipExtraction = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = zipExtractionTail.catch(() => undefined).then(operation);
    zipExtractionTail = result;
    void result.finally(() => { if (zipExtractionTail === result) zipExtractionTail = Promise.resolve(); }).catch(() => {});
    return result;
  };
  await runtime.initialize();
  ctx.effect(() => ctx.studioDomain.bindRuntime(ids => runtime.quiesce(ids)), 'studio: task quiescence');
  ctx.effect(() => ctx.studioDomain.bindProducerRuntime(ids => runtime.stopProducers(ids)), 'studio: container producer quiescence');
  ctx.effect(() => ctx.studioDomain.bindDeletionRuntime(id => runtime.deleteTaskConversations(id)), 'studio: permanent task conversation cleanup');
  ctx.effect(() => ctx.studioDomain.bindProjectDeletionRuntime((id, taskIds) => runtime.deleteProjectConversations(id, taskIds)), 'studio: permanent project conversation cleanup');
  ctx.effect(() => {
    ctx.studioDomain.chatProjects = id => runtime.chatProject(id);
    const unprovide = ctx.provide('studio', runtime);
    return async () => { await runtime.dispose(); await unprovide(); };
  }, 'studio: runtime');
  /** Agent file-tool changes go to the activity log next to the person's web changes. */
  async function agentFileEvent<T>(taskId: string, chatId: string, action: string, path: string, run: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      const result = await run();
      ctx.studioDomain.recordActivity({ actor: 'agent', source: 'agent-tool', action, taskId, chatId, ok: true, durationMs: Date.now() - started, request: { path }, ...(typeof result === 'string' && /^[0-9a-f]{64}$/.test(result) ? { result: { version: result } } : {}) });
      return result;
    } catch (error) {
      ctx.studioDomain.recordActivity({ actor: 'agent', source: 'agent-tool', action, taskId, chatId, ok: false, durationMs: Date.now() - started, request: { path }, error: error instanceof Error ? error.message.slice(0, 500) : String(error) });
      throw error;
    }
  }
  // Native engineering files (DWG, PDF, STEP, …) are downloaded as bytes; the response is never rendered by the page origin.
  ctx.connection.fetch.register({ path: '/api/studio/file/download', methods: ['GET'], requestBody: 'buffered', async fetch(request) {
    try {
      const query = Object.fromEntries(new URL(request.url).searchParams);
      if (Object.keys(query).some(key => !['source', 'projectId', 'taskId', 'snapshotId', 'path'].includes(key))) throw new Error('文件下载参数无效');
      const path = stringField(query, 'path'), name = path.split('/').at(-1) ?? 'file';
      let body: BodyInit, bytes: number;
      if (query.source === 'snapshot') { const file = await ctx.studioDomain.snapshotBytes(stringField(query, 'taskId'), stringField(query, 'snapshotId'), path); body = new Uint8Array(file.data); bytes = file.data.length; }
      else { const opened = await runtime.openDownload(query.source, query, path); bytes = opened.bytes; body = Readable.toWeb(opened.handle.createReadStream()) as ReadableStream<Uint8Array>; }
      const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
      return new Response(body, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}` } });
    } catch (error) { return Response.json({ error: error instanceof Error ? error.message : '文件下载失败' }, { status: 409 }); }
  } });
  // Files people add from the file panels: a task's D: and the project's F:. The request body is the raw file, streamed
  // to disk (WorkspaceFiles.upload); folders=1 creates the folders of the path, for folder uploads.
  const uploadQuery = (request: Request, owner: 'taskId' | 'projectId') => {
    const query = Object.fromEntries(new URL(request.url).searchParams);
    if (Object.keys(query).some(key => ![owner, 'path', 'overwrite', 'folders'].includes(key)) || ![undefined, '0', '1'].includes(query.overwrite) || ![undefined, '0', '1'].includes(query.folders)) throw new Error('文件上传参数无效');
    if (Number(request.headers.get('content-length') ?? 0) > WORKSPACE_UPLOAD_MAX_BYTES) throw new Error(`文件超过上传上限 ${WORKSPACE_UPLOAD_MAX_BYTES / 1024 / 1024} MB`);
    return { id: stringField(query, owner), path: stringField(query, 'path'), options: { overwrite: query.overwrite === '1', createFolders: query.folders === '1' } };
  };
  const uploadFailure = (error: unknown) => isEntryExists(error) ? Response.json({ error: error.message, code: 'exists' }, { status: 409 })
    : Response.json({ error: error instanceof Error ? error.message : '文件上传失败' }, { status: 400 });
  ctx.connection.fetch.register({ path: '/api/studio/file/upload', methods: ['POST'], requestBody: 'streaming', async fetch(request) {
    try {
      const { id, path, options } = uploadQuery(request, 'taskId');
      return Response.json(await ctx.studioDomain.webAction(request, () => panelFileChange(() => runtime.files.upload(id, path, bodyChunks(request.body), options,
        request.signal, step => ctx.studioDomain.workspace(id, step, request.signal)), '文件上传失败')));
    } catch (error) { return uploadFailure(error); }
  } });
  ctx.connection.fetch.register({ path: '/api/studio/project/shared/upload', methods: ['POST'], requestBody: 'streaming', async fetch(request) {
    try {
      const { id, path, options } = uploadQuery(request, 'projectId');
      return Response.json(await ctx.studioDomain.webAction(request, () => panelFileChange(async () => {
        runtime.sharedLease(id, true); await runtime.projectFiles.allocate(id);
        return runtime.projectFiles.upload(id, path, bodyChunks(request.body), options, request.signal);
      }, '文件上传失败', 'F 盘不可写入：没有写权限')));
    } catch (error) { return uploadFailure(error); }
  } });
  ctx.connection.fetch.register({ path: '/api/studio/chat/backup', methods: ['GET'], requestBody: 'buffered', async fetch(request) {
    try {
      const query = Object.fromEntries(new URL(request.url).searchParams);
      if (Object.keys(query).some(key => key !== 'id')) throw new Error('对话导出参数无效');
      const { content, filename } = await runtime.backupChat(stringField(query, 'id'), request.signal);
      return new Response(content as BodyInit, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' } });
    } catch (error) { return Response.json({ error: error instanceof Error ? error.message : '对话调试 JSON 导出失败' }, { status: 409 }); }
  } });
  const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] };
  ctx.tools.register(defineTool({ name: 'studio_project_context', description: 'Read this project planning conversation’s owned project and complete live task graph. Cannot select another project.',
    parameters: {}, output,
    async execute(_args, exec) { throwIfAborted(exec.signal); return JSON.stringify(ctx.studioDomain.graph(runtime.projectOwner(exec.agent))); } }));
  const projectFilesTool = defineTool({ name: 'studio_list_project_files', description: 'List saved workspace directories and file metadata in the current conversation’s bound project. Without taskId, return a flat rank-ordered page of active task workspaces (including siblings and nested tasks), default 50 and maximum 100. With an internal taskId from that list, return one relative directory page, default 100 and maximum 200; follow nextOffset and query directory paths to recurse. Project identity cannot be supplied. The list contains metadata only; active task conversations can pass a listed taskId and path to studio_read_project_file for bounded read-only content access. Listing grants no writes, snapshot/input authority or business-state changes. Private chat temporary files, archived workspaces, traversal and symlinks are refused.',
    parameters: { taskId: { type: 'string', description: 'Optional internal task ID from the workspace list; never a display code. Omit to list active project workspaces.' }, path: { type: 'string', description: 'Optional relative directory path, default empty root; allowed only with taskId. Never .chat-tmp, absolute or parent traversal.' }, offset: { type: 'integer', description: 'Zero-based page offset, default 0; nonnegative safe integer.' }, limit: { type: 'integer', description: 'Workspace page default 50, maximum 100. Directory page default 100, maximum 200. Minimum 1.' } }, output,
    async execute(args, exec) { throwIfAborted(exec.signal); return JSON.stringify(await waitForDomainOperation(runtime.listProjectFiles(exec.agent, args, exec.signal), exec.signal)); } });
  // DSH's implicit parameter map is open by default; advertise and enforce a closed native argument object.
  ctx.tools.register({ ...projectFilesTool, parameters: { ...projectFilesTool.parameters, additionalProperties: false } });
  const readProjectFileTool = defineTool({ name: 'studio_read_project_file', description: 'Preview one saved file from any non-archived task workspace in this active task conversation’s project, including completed predecessors and siblings. Text content is returned with its SHA-256 version; binary and oversized files return status metadata only. This is a mutable project reference (formalInput=false), not an immutable actual-input snapshot and never grants cross-task writes. Project identity cannot be supplied; private chat files, cross-project targets, archived/clearing/deleting tasks, traversal and symlinks are refused.',
    parameters: { taskId: { type: 'string', required: true, description: 'Internal task ID obtained from studio_list_project_files; never a display code.' }, path: { type: 'string', required: true, description: 'Relative file path within that task workspace. Never .chat-tmp, absolute or parent traversal.' } }, output,
    async execute(args, exec) { throwIfAborted(exec.signal); return JSON.stringify(await waitForDomainOperation(runtime.readProjectFile(exec.agent, args, exec.signal), exec.signal)); } });
  ctx.tools.register({ ...readProjectFileTool, parameters: { ...readProjectFileTool.parameters, additionalProperties: false } });
  if (ctx.studioDomain.fileStorage) {
    // The no-software mode has the same shared folder, without virtual machines to mention.
    const vms = !!ctx.studioDomain.vmStorage;
    const sharedTools = [
      defineTool({ name: 'studio_list_project_shared', description: vms ? 'List one directory of this conversation’s project shared folder, which every virtual machine of the project sees as drive F:. Paths are relative; default 100 and maximum 200 entries; follow nextOffset. Read-only for Agents.'
        : 'List one directory of this conversation’s project shared folder, the files every task of the project shares. Paths are relative; default 100 and maximum 200 entries; follow nextOffset. Read-only for Agents.',
        parameters: { path: { type: 'string', description: 'Relative directory path; omit for the folder root.' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, output,
        async execute(args, exec) { throwIfAborted(exec.signal); const { projectId } = runtime.graphPlanningScope(exec.agent); return JSON.stringify(await runtime.projectFiles.listDirectory(runtime.sharedLease(projectId), args.path ?? '', args.offset ?? 0, args.limit ?? 100, exec.signal)); } }),
      defineTool({ name: 'studio_read_project_shared', description: vms ? 'Preview one text file from this conversation’s project shared folder (drive F: in the project’s virtual machines). Binary and oversized files return their status only. Read-only for Agents.'
        : 'Preview one text file from this conversation’s project shared folder. Binary and oversized files return their status only. Read-only for Agents.',
        parameters: { path: { type: 'string', required: true, description: 'Relative file path from studio_list_project_shared.' } }, output,
        async execute(args, exec) { throwIfAborted(exec.signal); const { projectId } = runtime.graphPlanningScope(exec.agent); return JSON.stringify(await runtime.projectFiles.preview(runtime.sharedLease(projectId), args.path)); } }),
    ];
    for (const tool of sharedTools) ctx.tools.register({ ...tool, parameters: { ...tool.parameters, additionalProperties: false } });
  }
  ctx.tools.register(defineTool({ name: 'studio_create_task', description: 'Create one concrete task in the owned project with its name, detailed description and text checklist. Use this singular shortcut only for a genuinely independent single-node addition. Do not use it for initial project decomposition, a multi-node plan, or parallel/sibling work: first read studio_graph_context, then create the coherent topology atomically with studio_apply_graph_patch and set parentId:null explicitly on every intended project-root node. All new nodes use kind task; they become folders when they have children. In a task conversation this shortcut always makes the new node a child of the current task; a supplied parentId cannot select a sibling, ancestor or project root. This does not start, execute, submit files or mark tasks complete.',
    parameters: { definition: { type: 'string', required: true, description: 'JSON TaskDefinition for one independent node: {title:string,goal:string,checklist?:[{id?:string,text:string}],parentId?:owned task ID}. Do not repeat this shortcut to build a decomposition or parallel workflow; use studio_apply_graph_patch instead and give each intended project-root create parentId:null. In a task conversation parentId is fixed to the current task regardless of this JSON. goal is the detailed task description; new text checklist IDs are assigned by the server. Use specific names and informative descriptions; do not fabricate numeric engineering requirements. kind is always task and may be omitted. Legacy constraints/criteria/outputs/unresolved fields remain accepted for reviewed compatibility, but are not current single-user metadata.' } }, output,
    async execute(args, exec) {
      throwIfAborted(exec.signal);
      const owner = runtime.taskCreationOwner(exec.agent);
      if (args.definition.length > 65536) throw new Error('Task definition too large');
      const definition = object(JSON.parse(args.definition));
      definition.kind = 'task';
      if (owner.parentId !== undefined) {
        if (definition.parentId !== undefined && definition.parentId !== owner.parentId) throw new Error('Task conversation can only create children of its current task');
        definition.parentId = owner.parentId;
      }
      runtime.assertAutonomyScope(exec.agent, [typeof definition.parentId === 'string' ? definition.parentId : null]);
      return JSON.stringify(await waitForDomainOperation(ctx.studioDomain.createTask(owner.projectId, definition, exec.signal), exec.signal));
    } }));
  ctx.tools.register(defineTool({ name: 'studio_task_context', description: 'Read the current task view, direct child summaries (maximum 200), and immutable actual-input manifests recursively through folder childrenRefs (maximum 200 manifests, 100 files and 200 child references each). Check total/truncated fields. No other projects, chats or private temporary files are exposed; pagination is not yet available.',
    parameters: {}, output, async execute(_args, exec) { throwIfAborted(exec.signal); return JSON.stringify(runtime.taskContext(exec.agent)); } }));
  ctx.tools.register(defineTool({ name: 'studio_read_file', description: 'Read a UTF-8 file within the current task workspace, or an explicitly authorized owned/actual-input snapshot. Use studio_read_project_file for another task’s mutable workspace. Absolute paths, traversal and symlinks are refused.',
    parameters: { path: { type: 'string', required: true }, snapshotId: { type: 'string', description: 'Optional: an owned snapshot or an actual input snapshot id.' } }, output,
    async execute(args, exec) { throwIfAborted(exec.signal); const lease = runtime.taskLease(exec.agent); return args.snapshotId ? (await ctx.studioDomain.snapshotFile(lease.taskId, args.snapshotId, args.path)).content : (await runtime.files.read(lease, args.path)).content; } }));
  ctx.tools.register(defineTool({ name: 'studio_write_file', description: 'Create or replace a bounded UTF-8 file within the current active task workspace, including an active folder’s own workspace. Returns its SHA-256 version. No cross-task writes or shell access.',
    parameters: { path: { type: 'string', required: true }, content: { type: 'string', required: true } }, output,
    async execute(args, exec) {
      throwIfAborted(exec.signal); const lease = runtime.taskLease(exec.agent);
      return agentFileEvent(lease.taskId, exec.agent!.id, 'file.write', args.path, async () => (await runtime.files.write(lease, args.path, args.content)).version);
    } }));
  const deleteFileTool = defineTool({ name: 'studio_delete_file', description: 'Delete one regular file from the current active task workspace. Directories, private chat files, completed/frozen tasks and all other task workspaces are refused. An optional expectedVersion prevents deleting a file that changed since it was read.',
    parameters: { path: { type: 'string', required: true }, expectedVersion: { type: 'string', description: 'Optional SHA-256 version returned by a prior read/preview.' } }, output,
    async execute(args, exec) {
      throwIfAborted(exec.signal); const lease = runtime.taskLease(exec.agent);
      return agentFileEvent(lease.taskId, exec.agent!.id, 'file.delete', args.path, async () => JSON.stringify(await runtime.files.delete(lease, args.path, args.expectedVersion === undefined ? {} : { expectedVersion: args.expectedVersion })));
    } });
  ctx.tools.register({ ...deleteFileTool, parameters: { ...deleteFileTool.parameters, additionalProperties: false } });
  ctx.tools.register(defineTool({ name: 'studio_write_temp_file', description: 'Write a temporary UTF-8 file private to this conversation. Use a relative path; other conversations cannot access this directory. Not a task deliverable.',
    parameters: { path: { type: 'string', required: true }, content: { type: 'string', required: true } }, output,
    async execute(args, exec) { throwIfAborted(exec.signal); const { lease, scratch } = runtime.agentStorage(exec.agent); return JSON.stringify(await scratch.write(lease, exec.agent!.id, args.path, args.content)); } }));
  ctx.tools.register(defineTool({ name: 'studio_extract_temp_zip', description: 'Safely extract a ZIP already stored in this conversation temporary directory. The service chooses a new isolated extracted/ destination, validates the complete archive before publishing it, and rejects traversal, links, special files, duplicate/conflicting paths, encrypted or multi-volume archives, unsupported compression, CRC failures and archive bombs. Extracted files remain temporary and are not task deliverables.',
    parameters: { path: { type: 'string', required: true, description: 'Relative path returned by studio_download_temp_file or studio_list_temp_files. Maximum ZIP size is 20 MiB.' } }, output, timeoutMs: 120000,
    async execute(args, exec) {
      throwIfAborted(exec.signal);
      const { lease, scratch } = runtime.agentStorage(exec.agent);
      await scratch.ensure(lease, exec.agent!.id);
      return serializeZipExtraction(async () => {
        throwIfAborted(exec.signal);
        const archive = await scratch.readArtifact(lease, exec.agent!.id, args.path, ZIP_LIMITS.maxArchiveBytes, exec.signal);
        const extracted = await extractZip(archive.data, exec.signal);
        if (!extracted.entries.length) throw new Error('ZIP archive is empty');
        const destination = `extracted/${randomUUID()}`;
        const stored = await scratch.writeTree(lease, exec.agent!.id, destination, extracted.entries.map(entry => entry.type === 'directory'
          ? { path: entry.path, kind: 'directory' as const }
          : { path: entry.path, kind: 'file' as const, data: entry.data }), exec.signal);
        const paths = extracted.entries.filter(entry => entry.type === 'file').map(entry => entry.path);
        return JSON.stringify({ source: { path: archive.path, bytes: archive.bytes, sha256: archive.version }, destination: stored.path,
          files: stored.files, directories: stored.directories, expandedBytes: stored.bytes, paths: paths.slice(0, 100), pathsTruncated: paths.length > 100 });
      });
    } }));
  ctx.tools.register(defineTool({ name: 'studio_read_temp_file', description: 'Read a paginated temporary file private to this conversation. offset and limit count Unicode characters. Follow nextOffset to continue; maximum limit is 12000.',
    parameters: { path: { type: 'string', required: true }, offset: { type: 'number' }, limit: { type: 'number' } }, output,
    async execute(args, exec) { throwIfAborted(exec.signal); const { lease, scratch } = runtime.agentStorage(exec.agent); return JSON.stringify(await scratch.read(lease, exec.agent!.id, args.path, args.offset, args.limit, exec.signal)); } }));
  ctx.tools.register(defineTool({ name: 'studio_search_temp_file', description: 'Find a literal query in a temporary file private to this conversation. Returns bounded line snippets, not the complete file.',
    parameters: { path: { type: 'string', required: true }, query: { type: 'string', required: true }, limit: { type: 'number' } }, output,
    async execute(args, exec) { throwIfAborted(exec.signal); const { lease, scratch } = runtime.agentStorage(exec.agent); return JSON.stringify(await scratch.search(lease, exec.agent!.id, args.path, args.query, args.limit, exec.signal)); } }));
  ctx.tools.register(defineTool({ name: 'studio_list_temp_files', description: 'List a page of the current conversation’s temporary files to recover stored web results and extracted archive entries after context compaction. Follow nextOffset while truncated is true.',
    parameters: { offset: { type: 'number', description: 'Zero-based file offset, default 0.' }, limit: { type: 'number', description: 'Page size, default 100 and maximum 200.' } }, output,
    async execute(args, exec) { throwIfAborted(exec.signal); const { lease, scratch } = runtime.agentStorage(exec.agent); return JSON.stringify(await scratch.list(lease, exec.agent!.id, args.limit, args.offset)); } }));
  ctx.connection.fetch.register({ path: '/api/studio/chat/stream', methods: ['GET'], requestBody: 'buffered', async fetch(request) {
    try { return runtime.stream(stringField(Object.fromEntries(new URL(request.url).searchParams), 'id'), request.signal); }
    catch (error) { return Response.json({ error: error instanceof Error ? error.message : '会话连接失败' }, { status: 400 }); }
  } });
  ctx.connection.fetch.register({ path: '/api/studio/chat/attachment', methods: ['GET'], requestBody: 'buffered', async fetch(request) {
    try {
      const query = Object.fromEntries(new URL(request.url).searchParams);
      if (Object.keys(query).some(key => !['id', 'attachmentId', 'page'].includes(key))) throw new Error('参考文件预览参数无效');
      const file = await runtime.chatAttachment(stringField(query, 'id'), stringField(query, 'attachmentId'), query.page === undefined ? undefined : Number(query.page));
      return new Response(new Uint8Array(file.data).buffer, { headers: { 'content-type': file.mediaType,
        'content-disposition': `${file.mediaType === 'application/pdf' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(file.name).replaceAll("'", '%27')}`,
        'content-security-policy': "sandbox; default-src 'none'", 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store' } });
    } catch (error) { return Response.json({ error: error instanceof Error ? error.message : '参考文件读取失败' }, { status: 400 }); }
  } });
  for (const [path, methods, action] of [
    ['/api/studio/status', ['GET'], async () => runtime.status()],
    ['/api/studio/project/rename', ['POST'], async (request: Request) => {
      const data = object(await request.json());
      if (Object.keys(data).some(key => !['id', 'revision', 'title'].includes(key))) throw new Error('项目重命名参数无效');
      return ctx.studioDomain.renameProject(stringField(data, 'id'), { revision: data.revision, title: data.title });
    }],
    ['/api/studio/project/delete-preview', ['GET'], async (request: Request) => {
      const query = Object.fromEntries(new URL(request.url).searchParams);
      if (Object.keys(query).some(key => key !== 'id')) throw new Error('项目删除预览参数无效');
      return ctx.studioDomain.projectDeletePreview(stringField(query, 'id'));
    }],
    ['/api/studio/project/delete', ['POST'], async (request: Request) => {
      const data = object(await request.json());
      if (Object.keys(data).some(key => !['id', 'revision', 'confirmationTitle'].includes(key))) throw new Error('项目删除参数无效');
      return ctx.studioDomain.deleteProject(stringField(data, 'id'), { revision: data.revision, confirmationTitle: data.confirmationTitle });
    }],
    ['/api/studio/task/delete-preview', ['GET'], async (request: Request) => ctx.studioDomain.deletePreview(stringField(Object.fromEntries(new URL(request.url).searchParams), 'id'))],
    ['/api/studio/task/delete', ['POST'], async (request: Request) => {
      const data = object(await request.json());
      if (Object.keys(data).some(key => !['id', 'revision', 'projectRevision', 'confirm'].includes(key))) throw new Error('永久删除参数无效');
      return ctx.studioDomain.deleteTask(stringField(data, 'id'), { revision: data.revision, projectRevision: data.projectRevision, confirm: data.confirm });
    }],
    ['/api/studio/task/clear-preview', ['GET'], async (request: Request) => {
      const query = Object.fromEntries(new URL(request.url).searchParams);
      if (Object.keys(query).some(key => key !== 'id')) throw new Error('清空预览参数无效');
      return ctx.studioDomain.clearPreview(stringField(query, 'id'));
    }],
    ['/api/studio/task/clear', ['POST'], async (request: Request) => {
      const data = object(await request.json());
      if (Object.keys(data).some(key => !['id', 'revision', 'projectRevision', 'confirm'].includes(key))) throw new Error('清空进展参数无效');
      return ctx.studioDomain.clearTask(stringField(data, 'id'), { revision: data.revision, projectRevision: data.projectRevision, confirm: data.confirm });
    }],
    ['/api/studio/project/files', ['GET'], async (request: Request) => {
      const query = Object.fromEntries(new URL(request.url).searchParams);
      return runtime.projectDirectory(stringField(query, 'projectId'), stringField(query, 'taskId'), query.path ?? '',
        query.offset === undefined ? 0 : Number(query.offset), query.limit === undefined ? 100 : Number(query.limit));
    }],
    ['/api/studio/project/file', ['GET'], async (request: Request) => {
      const query = Object.fromEntries(new URL(request.url).searchParams);
      return runtime.projectFile(stringField(query, 'projectId'), stringField(query, 'taskId'), stringField(query, 'path'));
    }],
    ['/api/studio/file', ['GET', 'POST'], async (request: Request) => {
      if (request.method === 'GET') {
        const query = Object.fromEntries(new URL(request.url).searchParams);
        const id = stringField(query, 'taskId'); ctx.studioDomain.task(id);
        return runtime.files.read(runtime.files.readLease(id), stringField(query, 'path'));
      }
      const data = object(await request.json());
      if (Object.keys(data).some(key => !['taskId', 'path', 'content', 'expectedVersion', 'createOnly'].includes(key))) throw new Error('文件保存参数无效');
      if (data.expectedVersion !== undefined && (typeof data.expectedVersion !== 'string' || !/^[0-9a-f]{64}$/.test(data.expectedVersion))) throw new Error('文件版本无效，请刷新预览后重试');
      if (data.createOnly !== undefined && typeof data.createOnly !== 'boolean') throw new Error('文件新建标记无效');
      const id = stringField(data, 'taskId');
      return ctx.studioDomain.workspace(id, () => runtime.files.write(runtime.files.lease(id), stringField(data, 'path'),
        typeof data.content === 'string' ? data.content : stringField(data, 'content'), { ...(typeof data.expectedVersion === 'string' ? { expectedVersion: data.expectedVersion } : {}), ...(typeof data.createOnly === 'boolean' ? { createOnly: data.createOnly } : {}) }), request.signal);
    }],
    ['/api/studio/file/delete', ['POST'], async (request: Request) => {
      const data = object(await request.json());
      if (Object.keys(data).some(key => !['taskId', 'path', 'expectedVersion', 'directory'].includes(key))) throw new Error('文件删除参数无效');
      if (data.expectedVersion !== undefined && (typeof data.expectedVersion !== 'string' || !/^[0-9a-f]{64}$/.test(data.expectedVersion))) throw new Error('文件版本无效，请刷新预览后重试');
      if (data.directory !== undefined && (data.directory !== true || data.expectedVersion !== undefined)) throw new Error('文件夹删除参数无效');
      const id = stringField(data, 'taskId'), path = stringField(data, 'path');
      return panelFileChange(() => ctx.studioDomain.workspace(id, () => data.directory ? runtime.files.deleteDirectory(runtime.files.lease(id), path)
        : runtime.files.delete(runtime.files.lease(id), path, typeof data.expectedVersion === 'string' ? { expectedVersion: data.expectedVersion } : {}), request.signal), '删除失败');
    }],
    ['/api/studio/file/stat', ['GET'], async (request: Request) => {
      const query = Object.fromEntries(new URL(request.url).searchParams);
      if (Object.keys(query).some(key => !['taskId', 'path'].includes(key))) throw new Error('文件查询参数无效');
      const id = stringField(query, 'taskId'); ctx.studioDomain.task(id);
      return runtime.files.stat(runtime.files.readLease(id), stringField(query, 'path'));
    }],
    ['/api/studio/file/rename', ['POST'], async (request: Request) => {
      const data = object(await request.json());
      if (Object.keys(data).some(key => !['taskId', 'from', 'to'].includes(key))) throw new Error('重命名参数无效');
      const id = stringField(data, 'taskId');
      return panelFileChange(() => ctx.studioDomain.workspace(id, () => runtime.files.rename(runtime.files.lease(id), stringField(data, 'from'), stringField(data, 'to')), request.signal), '重命名失败');
    }],
    ['/api/studio/project/shared/status', ['GET'], async (request: Request) => {
      const projectId = stringField(Object.fromEntries(new URL(request.url).searchParams), 'projectId'); ctx.studioDomain.graph(projectId);
      if (ctx.studioDomain.vmStorage) return { enabled: true, path: ctx.studioDomain.sharedSpaceDirectory(projectId), drive: 'F:' };
      // No-software mode: the shared folder lives in Studio's data folder; there is no drive letter.
      return ctx.studioDomain.fileStorage ? { enabled: true, path: ctx.studioDomain.sharedSpaceDirectory(projectId) } : { enabled: false };
    }],
    ['/api/studio/project/shared', ['GET'], async (request: Request) => {
      const query = Object.fromEntries(new URL(request.url).searchParams);
      if (Object.keys(query).some(key => !['projectId', 'path', 'offset', 'limit'].includes(key))) throw new Error('项目公共空间列表参数无效');
      const projectId = stringField(query, 'projectId');
      return runtime.projectFiles.listDirectory(runtime.sharedLease(projectId), query.path ?? '', query.offset === undefined ? 0 : Number(query.offset), query.limit === undefined ? 100 : Number(query.limit), request.signal);
    }],
    ['/api/studio/project/shared/file', ['GET', 'POST'], async (request: Request) => {
      if (request.method === 'GET') {
        const query = Object.fromEntries(new URL(request.url).searchParams);
        return runtime.projectFiles.preview(runtime.sharedLease(stringField(query, 'projectId')), stringField(query, 'path'));
      }
      const data = object(await request.json());
      if (Object.keys(data).some(key => !['projectId', 'path', 'content', 'expectedVersion', 'createOnly'].includes(key))) throw new Error('文件保存参数无效');
      if (data.expectedVersion !== undefined && (typeof data.expectedVersion !== 'string' || !/^[0-9a-f]{64}$/.test(data.expectedVersion))) throw new Error('文件版本无效，请刷新预览后重试');
      if (data.createOnly !== undefined && typeof data.createOnly !== 'boolean') throw new Error('文件新建标记无效');
      const projectId = stringField(data, 'projectId'), lease = runtime.sharedLease(projectId, true);
      await runtime.projectFiles.allocate(projectId);
      return runtime.projectFiles.write(lease, stringField(data, 'path'), typeof data.content === 'string' ? data.content : stringField(data, 'content'),
        { ...(typeof data.expectedVersion === 'string' ? { expectedVersion: data.expectedVersion } : {}), ...(typeof data.createOnly === 'boolean' ? { createOnly: data.createOnly } : {}) });
    }],
    ['/api/studio/project/shared/stat', ['GET'], async (request: Request) => {
      const query = Object.fromEntries(new URL(request.url).searchParams);
      if (Object.keys(query).some(key => !['projectId', 'path'].includes(key))) throw new Error('文件查询参数无效');
      return runtime.projectFiles.stat(runtime.sharedLease(stringField(query, 'projectId')), stringField(query, 'path'));
    }],
    ['/api/studio/project/shared/delete', ['POST'], async (request: Request) => {
      const data = object(await request.json());
      if (Object.keys(data).some(key => !['projectId', 'path', 'expectedVersion'].includes(key))) throw new Error('文件删除参数无效');
      if (data.expectedVersion !== undefined && (typeof data.expectedVersion !== 'string' || !/^[0-9a-f]{64}$/.test(data.expectedVersion))) throw new Error('文件版本无效，请刷新预览后重试');
      return runtime.projectFiles.delete(runtime.sharedLease(stringField(data, 'projectId'), true), stringField(data, 'path'), typeof data.expectedVersion === 'string' ? { expectedVersion: data.expectedVersion } : {});
    }],
    ['/api/studio/chat', ['GET', 'POST'], async (request: Request) => {
      if (request.method === 'GET') return runtime.chat(stringField(Object.fromEntries(new URL(request.url).searchParams), 'id'));
      const data = object(await request.json());
      const hasProject = Object.hasOwn(data, 'projectId'), hasTask = Object.hasOwn(data, 'taskId');
      if (hasProject === hasTask) throw new Error('Select exactly one projectId or taskId');
      if (Object.keys(data).some(key => !['id', 'projectId', 'taskId', 'message', 'provider', 'model', 'attachments'].includes(key))) throw new Error('对话参数无效');
      if (typeof data.message !== 'string') throw new Error('对话内容须为文本');
      const message = data.message, provider = stringField(data, 'provider'), model = stringField(data, 'model');
      const id = data.id === undefined ? undefined : stringField(data, 'id');
      return hasProject ? runtime.sendProject(stringField(data, 'projectId'), message, provider, model, id, data.attachments)
        : runtime.send(stringField(data, 'taskId'), message, provider, model, id, data.attachments);
    }],
    ['/api/studio/chat/requests', ['GET'], async (request: Request) => {
      const query = Object.fromEntries(new URL(request.url).searchParams);
      if (Object.keys(query).some(key => !['id', 'userSeq'].includes(key))) throw new Error('请求查询参数无效');
      return runtime.chatRequests(stringField(query, 'id'), Number(stringField(query, 'userSeq')));
    }],
    ['/api/studio/chat/request', ['GET'], async (request: Request) => {
      const query = Object.fromEntries(new URL(request.url).searchParams);
      if (Object.keys(query).some(key => !['id', 'requestId'].includes(key))) throw new Error('请求详情参数无效');
      return runtime.chatRequest(stringField(query, 'id'), stringField(query, 'requestId'));
    }],
    ['/api/studio/chat/attachments', ['GET'], async (request: Request) => runtime.chatAttachments(stringField(Object.fromEntries(new URL(request.url).searchParams), 'id'))],
    ['/api/studio/chat/stop', ['POST'], async (request: Request) => { const data = object(await request.json()); await runtime.stop(stringField(data, 'id')); return { stopped: true }; }],
    ['/api/studio/chat/temp', ['GET'], async (request: Request) => {
      const query = Object.fromEntries(new URL(request.url).searchParams), id = stringField(query, 'id');
      if (Object.keys(query).some(key => !['id', 'offset', 'limit'].includes(key))) throw new Error('临时文件列表参数无效');
      return runtime.scratchFor(id).list(runtime.chatLease(id), id, query.limit === undefined ? undefined : Number(query.limit), query.offset === undefined ? undefined : Number(query.offset));
    }],
    ['/api/studio/chat/temp/file', ['GET', 'POST'], async (request: Request) => {
      if (request.method === 'GET') {
        const query = Object.fromEntries(new URL(request.url).searchParams), id = stringField(query, 'id');
        return runtime.scratchFor(id).read(runtime.chatLease(id), id, stringField(query, 'path'), query.offset === undefined ? undefined : Number(query.offset), query.limit === undefined ? undefined : Number(query.limit), request.signal);
      }
      const data = object(await request.json()), id = stringField(data, 'id');
      return runtime.writeTemp(id, stringField(data, 'path'), typeof data.content === 'string' ? data.content : stringField(data, 'content'));
    }],
  ] as const) {
    ctx.connection.fetch.register({ path, methods, requestBody: 'buffered', async fetch(request) {
      try { return Response.json(await ctx.studioDomain.webAction(request, async () => action(request))); }
      catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'Studio operation failed' }, { status: 400 }); }
    } });
  }
}
