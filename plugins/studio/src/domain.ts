import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readdir, lstat, realpath, open, writeFile, rename, rm, rmdir, chmod } from 'node:fs/promises';
import { constants, watch, type FSWatcher } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID, randomInt, createHash } from 'node:crypto';
import z from '@deepseek-ai/schemastery';
import { WorkspaceFiles } from './workspace.ts';
import { activityIds, isStateChanging, routeAction, summarize, type ActivityEvent, type ActivityInput } from './activity.ts';
import { VmClient, VmWorkspaces } from './vm-client.ts';
import { removeManagedDirectory } from './managed-delete.ts';
import { CompletionFileStore } from './completion-store.ts';
import { FileDescriptionQueue, fallbackFileDescription, fileDescriptionExcerpt, nativeFileDescriptionGenerator, type FileDescriptionGenerator } from './file-descriptions.ts';
import { currentStateNames, isCurrentTaskState, resultSnapshotId, taskSnapshotId, type WorkflowMode, type ReviewedTaskState, type Project, type ProjectDeletePreview, type ProjectDeleteResult, type Task, type TaskDefinition, type Criterion, type Measurement, type Snapshot, type InputRef, type Review, type TaskView, type LeafStats, type TaskState, type GraphPlanningScope, type GraphPlanningContext, type GraphPatchResult, type PlanningTask, type TaskDeletePreview, type TaskDeleteResult, type TaskClearPreview, type TaskClearResult, type CompletionGoal, type HumanCompletionConfirmation, type TaskCompletionPreview, type TaskCompletionResult, type SnapshotFile, type ChecklistItem, type CompletionFileSubmission, type DependencyChangeRequest, type DependencyChangePreview, type DependencyChangeImpact } from './domain-types.ts';
import type { ConnectionFetchMethod } from '@deepseek-ai/dsh-client-connection';
import type { WorkspaceFilePreview, SnapshotManifestView } from './domain-types.ts';
import type { FileSubmissionDescription, CompletionWorkspaceFile, AgentCompletionActor, AgentCompletionInput } from './domain-types.ts';
import { throwIfAborted } from './abort.ts';
import type { SoftwareBackend } from './seat-types.ts';

export const name = 'harnessstudio-domain';
export const inject = ['connection'];
/** vmProjectsRoot (vm_manager data_root/projects, mounted at the same path) moves ordinary task files into vm_manager task spaces.
 * softwareBackend 'none' keeps the same layout in Studio's own data folder (<dataRoot>/files), managed by Studio alone. */
export interface Config { dataRoot: string; legacyWorkspaceIds: string[]; maxFileBytes: number; workflowMode: WorkflowMode; softwareBackend: SoftwareBackend; vmProjectsRoot: string; vmEndpoint: string; vmTrustedHttpOrigins: string[]; vmStopTimeoutMs: number }
export const Config: z<Config> = z.object({ dataRoot: z.string().required(), legacyWorkspaceIds: z.array(String).required(), maxFileBytes: z.natural().min(1).required(), workflowMode: z.union(['single-user', 'reviewed']).default('single-user'),
  softwareBackend: z.union(['none', 'mock', 'vm-manager']).default('mock'),
  vmProjectsRoot: z.string().default(''), vmEndpoint: z.string().default(''), vmTrustedHttpOrigins: z.array(String).default([]), vmStopTimeoutMs: z.natural().min(1000).default(200000) });
/** Task files in <projectsRoot>/<projectId>/tasks/<taskId>, project files in <projectsRoot>/<projectId>/shared. With workspaces
 * these are vm_manager task spaces (D:) and its shared folder (F:); without, Studio's own folder of the no-software mode. */
export interface TaskStorage { projectsRoot: string; workspaces?: VmWorkspaces }
export interface VmTaskStorage extends TaskStorage { workspaces: VmWorkspaces }
/** Where the no-software mode keeps task and project files inside Studio's data folder. */
export const LOCAL_FILES_FOLDER = 'files';
declare module '@deepseek-ai/cordis' { interface Context { studioDomain: StudioDomain } }
const now = () => new Date().toISOString();
const taskCodeAlphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求必须为对象');
  return value as Record<string, unknown>;
}
function exactFields(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  const data = object(value), unknown = Object.keys(data).filter(key => !fields.includes(key));
  if (unknown.length) throw new Error(`${label}含不允许的字段：${unknown.join('、')}`);
  return data;
}
function planningCriteriaFields(value: unknown) {
  if (Array.isArray(value)) for (const criterion of value) exactFields(criterion, ['id', 'label', 'kind', 'method', 'unit', 'rule', 'target', 'min', 'max', 'tolerance'], '完成指标');
}
function text(value: unknown, label: string, required = true): string {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > 8000 || (required && !value.trim())) throw new Error(`${label}不能为空且须在长度限制内`);
  return value.trim();
}
function strings(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100 || value.some(item => typeof item !== 'string' || item.length > 2000 || !item.trim())) throw new Error('列表内容不合法');
  return value.map(item => item.trim());
}
function fileName(value: string): string {
  if (!value || value.startsWith('/') || /[\\\0]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('文件须使用任务内相对路径');
  if (value.split('/')[0].toLowerCase() === '.chat-tmp') throw new Error('对话临时文件不能直接作为任务产物或验收证据');
  return value;
}
/** Stable text projections keep old structured definitions and immutable snapshots intact. */
export function checklistItems(task: Pick<TaskDefinition, 'criteria' | 'checklist'>): ChecklistItem[] {
  if (task.checklist !== undefined) return task.checklist.map(item => ({ ...item }));
  return task.criteria.map(criterion => {
    let target = '';
    if (criterion.kind === 'numeric') {
      const unit = criterion.unit ? ` ${criterion.unit}` : '';
      if (criterion.rule === 'range' && criterion.min !== undefined && criterion.max !== undefined) target = `${criterion.min}–${criterion.max}${unit}`;
      else if (criterion.target !== undefined) target = `${criterion.rule === 'gte' ? '≥' : criterion.rule === 'lte' ? '≤' : '='} ${criterion.target}${unit}`;
      if (target && criterion.tolerance !== undefined) target += `（容差 ${criterion.tolerance}${unit}）`;
    }
    return { id: `legacy-${criterion.id}`, text: [criterion.label, target, criterion.method ? `验证：${criterion.method}` : ''].filter(Boolean).join(' · ') };
  });
}
function normalizeChecklist(value: unknown, existing?: ChecklistItem[]): ChecklistItem[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Checklist 须为最多 100 项的文字列表');
  const items = value.map(raw => {
    const row = exactFields(raw, ['id', 'text'], 'Checklist 项');
    const content = text(row.text, 'Checklist 内容'); if (content.length > 2000) throw new Error('Checklist 单项内容不能超过 2000 字符');
    const id = row.id === undefined ? `cl-${randomUUID()}` : text(row.id, 'Checklist 标识');
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error('Checklist 标识不合法');
    if (existing && row.id !== undefined && !existing.some(item => item.id === id)) throw new Error('Checklist 标识不属于当前任务；新增项请省略标识');
    return { id, text: content };
  });
  if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('Checklist 标识重复');
  return items;
}
function definition(input: unknown): TaskDefinition {
  const data = object(input);
  const kind = data.kind === 'group' ? 'group' : data.kind === 'task' ? 'task' : undefined;
  if (!kind) throw new Error('节点类型不正确');
  const title = text(data.title, '任务名称');
  const raw = data.criteria ?? [];
  if (!Array.isArray(raw) || raw.length > 50) throw new Error('验收指标列表不合法');
  const criteria: Criterion[] = raw.map(value => {
    const row = object(value);
    if (row.kind !== 'numeric' && row.kind !== 'check') throw new Error('指标类型不正确');
    const id = row.id === undefined ? `c-${randomUUID()}` : text(row.id, '指标标识');
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(id)) throw new Error('指标标识不合法');
    const result: Criterion = { id, label: text(row.label, '指标名称'), kind: row.kind, method: text(row.method, '验证方法', false) };
    if (row.kind === 'numeric') {
      result.unit = text(row.unit, '单位', false);
      if (row.rule !== undefined) {
        if (!['eq', 'gte', 'lte', 'range'].includes(String(row.rule))) throw new Error('指标比较方式不正确');
        result.rule = row.rule as Criterion['rule'];
      }
      for (const field of ['target', 'min', 'max', 'tolerance'] as const) if (row[field] !== undefined) {
        if (typeof row[field] !== 'number' || !Number.isFinite(row[field])) throw new Error('指标须为有限数字');
        result[field] = row[field];
      }
      if ((result.tolerance ?? 0) < 0 || (result.min !== undefined && result.max !== undefined && result.min > result.max)) throw new Error('指标范围或容差不正确');
    }
    return result;
  });
  if (new Set(criteria.map(row => row.id)).size !== criteria.length) throw new Error('指标标识重复');
  return { title, kind, goal: text(data.goal, '目标', false), constraints: text(data.constraints, '约束', false), criteria,
    outputs: strings(data.outputs).map(fileName), unresolved: strings(data.unresolved),
    ...(data.parentId ? { parentId: text(data.parentId, '父任务') } : {}),
    ...(data.checklist !== undefined ? { checklist: normalizeChecklist(data.checklist) } : {}) };
}
export function definitionIssues(task: TaskDefinition, mode: WorkflowMode = 'single-user'): string[] {
  if (task.kind === 'group' || mode === 'single-user' && task.checklist !== undefined) return [];
  const issues = task.unresolved.map(item => `待补充：${item}`);
  if (!task.goal) issues.push('缺少任务目标');
  if (['零件设计', '结构设计', '设计', '任务'].includes(task.title)) issues.push('请填写具体叶任务；宏观步骤应拆分子任务');
  if (!task.criteria.length) issues.push(mode === 'single-user' ? '缺少完成指标' : '缺少验收指标');
  if (!task.outputs.length) issues.push('缺少预期输出文件');
  for (const criterion of task.criteria) {
    if (!criterion.method) issues.push(`${criterion.label}：缺少验证方法`);
    if (criterion.kind === 'numeric') {
      if (!criterion.unit || !criterion.rule || (criterion.rule === 'range' ? criterion.min === undefined || criterion.max === undefined : criterion.target === undefined)) issues.push(`${criterion.label}：缺少目标值、范围或单位`);
    }
  }
  return issues;
}
export function measurementPass(criterion: Criterion, measurement: Measurement): boolean {
  if (criterion.kind === 'check') return measurement.observed === true;
  if (typeof measurement.observed !== 'number') return false;
  const value = measurement.observed, tolerance = criterion.tolerance ?? 0;
  // Decimal boundary values such as 40.1 - 40 have binary floating-point rounding error.
  const rounding = Number.EPSILON * 4 * Math.max(1, Math.abs(value), Math.abs(criterion.target ?? 0), Math.abs(criterion.min ?? 0), Math.abs(criterion.max ?? 0), tolerance);
  switch (criterion.rule) {
    case 'eq': return Math.abs(value - criterion.target!) <= tolerance + rounding;
    case 'gte': return value >= criterion.target! - tolerance - rounding;
    case 'lte': return value <= criterion.target! + tolerance + rounding;
    case 'range': return value >= criterion.min! - tolerance - rounding && value <= criterion.max! + tolerance + rounding;
    default: return false;
  }
}
/** One goal's evidence: what the Agent checked, how, and the result. */
function evidenceText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}的检查依据不能为空`);
  if (value.trim().length > 2000) throw new Error(`${label}的检查依据不能超过 2000 字符`);
  return value.trim();
}
function completionEvidence(value: unknown): AgentCompletionInput['evidence'] {
  if (value === undefined) throw new Error('Agent 确认完成须为每个目标写明检查依据（evidence）');
  const data = exactFields(value, ['goal', 'checklist'], '检查依据');
  if (!Array.isArray(data.checklist) || data.checklist.length > 200) throw new Error('检查依据的 checklist 须为列表');
  const checklist = data.checklist.map(raw => {
    const row = exactFields(raw, ['id', 'evidence'], 'Checklist 检查依据');
    if (typeof row.id !== 'string' || !row.id) throw new Error('Checklist 检查依据须写明目标 ID');
    return { id: row.id, evidence: evidenceText(row.evidence, `目标 ${row.id} `) };
  });
  if (new Set(checklist.map(row => row.id)).size !== checklist.length) throw new Error('Checklist 检查依据的目标 ID 不能重复');
  return { goal: evidenceText(data.goal, '总体目标'), checklist };
}
function agentActor(value: unknown): AgentCompletionActor {
  const missing = 'Agent 确认完成须提供自主运行、对话和模型信息';
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(missing);
  const data = exactFields(value, ['runId', 'chatId', 'provider', 'model'], 'Agent 身份');
  const field = (key: keyof AgentCompletionActor) => { const raw = data[key]; if (typeof raw !== 'string' || !raw.trim() || raw.length > 200) throw new Error(missing); return raw.trim(); };
  return { runId: field('runId'), chatId: field('chatId'), provider: field('provider'), model: field('model') };
}
/** The activity log keeps identifiers and file names of an Agent completion; the evidence itself is in the snapshot. */
function agentCompletionSummary(input: unknown, actor: unknown): unknown {
  const record = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const data = record(input), who = record(actor), evidence = record(data.evidence);
  return summarize({ runId: who.runId, provider: who.provider, model: who.model, revision: data.revision, workspaceVersion: data.workspaceVersion, childrenVersion: data.childrenVersion,
    evidenceGoals: Array.isArray(evidence.checklist) ? ['goal', ...evidence.checklist.map(row => record(row).id)] : undefined,
    files: Array.isArray(data.files) ? data.files.map(file => record(file).path) : undefined, withoutFiles: data.withoutFiles });
}
interface DeletionJob {
  taskId: string; projectId: string; affectedIds: string[]; directIds: string[]; summaryIds: string[]; snapshotIds: string[];
}
interface ClearingJob {
  taskId: string; projectId: string; affectedIds: string[]; preservedIds: string[]; snapshotIds: string[];
}
interface DependencyJob {
  projectId: string; ownerId: string; request: DependencyChangeRequest;
  modified: { id: string; dependencies: string[] }[]; affected: DependencyChangeImpact[];
}
interface DependencyPlan extends DependencyJob { retry: boolean; requiresConfirmation: boolean }
interface ProjectDeletionJob {
  projectId: string; title: string; taskIds: string[]; snapshotIds: string[];
}

/** Single-process domain transactions; async filesystem operations are serialized around SQLite commits. */
export class StudioDomain {
  readonly files: WorkspaceFiles;
  private readonly completionStore: CompletionFileStore;
  private readonly fileDescriptions: FileDescriptionQueue;
  private descriptionWatcher?: FSWatcher;
  private externalWatcher?: FSWatcher;
  /** Project of tasks created but not yet stored, so their external task space is located before the first insert. */
  private readonly newTaskProjects = new Map<string, string>();
  private readonly descriptionChanges = new Map<string, ReturnType<typeof setTimeout>>();
  /** Who confirmed each result snapshot. Snapshots are immutable, so views read each one once. */
  private readonly confirmers = new Map<string, 'human' | 'agent'>();
  private db!: DatabaseSync;
  private operations: Promise<unknown> = Promise.resolve();
  private stopping = false;
  private quiesce: (ids: string[]) => Promise<void> = async () => { throw new Error('对话运行时尚未就绪'); };
  private quiesceProducers: (ids: string[]) => Promise<void> = async () => {};
  private deleteConversations: (taskId: string) => Promise<void> = async () => { throw new Error('对话清理运行时尚未就绪'); };
  private deleteProjectConversations: (projectId: string, taskIds: string[]) => Promise<void> = async () => { throw new Error('项目对话清理运行时尚未就绪'); };
  /** The task and project file layout shared by the vm-manager and no-software modes; undefined keeps the managed layout. */
  readonly fileStorage?: TaskStorage;
  /** Which software backend this deployment runs; the seat plugin must run the same one. */
  readonly softwareBackend: SoftwareBackend;
  constructor(readonly root: string, private readonly legacyIds: string[], maxBytes: number, readonly mode: WorkflowMode = 'single-user', storage?: TaskStorage, softwareBackend?: SoftwareBackend) {
    const files = storage && { projectsRoot: resolve(storage.projectsRoot), ...(storage.workspaces ? { workspaces: storage.workspaces } : {}) };
    this.fileStorage = files;
    this.softwareBackend = softwareBackend ?? (files ? (files.workspaces ? 'vm-manager' : 'none') : 'mock');
    if (this.softwareBackend === 'none' && (!files || files.workspaces)) throw new Error('无软件模式需要 Studio 自己的任务文件目录');
    this.files = new WorkspaceFiles(join(root, 'workspaces'), legacyIds, maxBytes, id => this.assertWorkspaceWritable(id), id => this.assertDiscussionWritable(id), files && {
      // Unknown or not yet loaded tasks keep the managed layout; only real tasks map to their task space.
      locate: id => { const projectId = this.taskProject(id); return projectId ? this.taskSpaceDirectory(projectId, id) : undefined; },
      prepare: async id => {
        const projectId = this.newTaskProjects.get(id) ?? this.task(id).projectId, directory = this.taskSpaceDirectory(projectId, id);
        // Without vm_manager nobody else creates the task space; Studio owns it like its managed folders.
        if (!files.workspaces) { await mkdir(directory, { recursive: true, mode: 0o700 }); return; }
        const space = await files.workspaces.ensure(projectId, id);
        if (resolve(space.path) !== directory) throw new Error('vm_manager 任务空间路径与 STUDIO_VMM_PROJECTS_ROOT 不一致，请检查挂载');
      },
      // vm_manager keeps its task spaces when Studio clears or deletes a task; Studio's own task spaces go with the task.
      ...(files.workspaces ? {} : { remove: async (id: string) => {
        const projectId = this.taskProject(id); if (!projectId) return;
        const directory = this.taskSpaceDirectory(projectId, id); await removeManagedDirectory(dirname(directory), directory);
      } }),
    });
    this.completionStore = new CompletionFileStore(join(root, 'file-submissions'));
    this.fileDescriptions = new FileDescriptionQueue(async (input, epoch) => {
      const task = this.task(input.taskId); if (task.pending || this.isArchived(task) || (task.dataGeneration ?? 0) !== epoch) return;
      const preview = await this.files.preview(this.files.readLease(task.id), input.path);
      if (preview.status !== 'text' || preview.version !== input.version) return;
      return { ...input, title: task.title, goal: task.goal, content: fileDescriptionExcerpt(preview.content) };
    }, (job, generated) => this.serial(async () => {
      const task = this.task(job.taskId); if ((task.dataGeneration ?? 0) !== job.epoch || task.pendingAction === 'clear' || task.pendingAction === 'delete') return;
      const row = this.db.prepare('SELECT value,version,data_generation FROM file_descriptions WHERE task_id=? AND path=?').get(job.taskId, job.path);
      if (!row || row.version !== job.version || row.data_generation !== job.epoch) return;
      const previous = JSON.parse(String(row.value)) as FileSubmissionDescription;
      const next: FileSubmissionDescription = { text: generated || previous.text, version: job.version, status: generated ? 'generated' : 'fallback' };
      this.db.prepare('UPDATE file_descriptions SET value=? WHERE task_id=? AND path=? AND version=? AND data_generation=?').run(JSON.stringify(next), job.taskId, job.path, job.version, job.epoch);
    }));
    this.files.onWrite((id, path, version) => {
      if (!this.db || this.stopping) return;
      void this.serial(async () => { const task = this.task(id); this.describeWorkspaceFile(task, { path, version, bytes: 0 }); }).catch(() => undefined);
    });
    this.files.onDelete((id, path) => {
      if (!this.db || this.stopping) return;
      void this.serial(async () => { this.db.prepare('DELETE FROM file_descriptions WHERE task_id=? AND path=?').run(id, path); }).catch(() => undefined);
    });
  }
  /** New task IDs remember their project until stored, so allocation can locate the external task space. */
  private reserveTaskId(projectId: string): string { const id = `t-${randomUUID()}`; this.newTaskProjects.set(id, projectId); return id; }
  private taskProject(id: string): string | undefined { const row = this.db?.prepare('SELECT project_id FROM tasks WHERE id=?').get(id); return row ? String(row.project_id) : this.newTaskProjects.get(id); }
  /** vm_manager task spaces and shared folders; only with the vm-manager backend's storage. */
  get vmStorage(): VmTaskStorage | undefined { return this.fileStorage?.workspaces ? this.fileStorage as VmTaskStorage : undefined; }
  /** <projects>/<projectId>/tasks/<taskId>: the VM's D: drive, or the task's files in the no-software mode. */
  taskSpaceDirectory(projectId: string, taskId: string): string { return join(this.fileStorage!.projectsRoot, projectId, 'tasks', taskId); }
  /** <projects>/<projectId>/shared: the VMs' F: drive, or the project's shared files in the no-software mode. */
  sharedSpaceDirectory(projectId: string): string { return join(this.fileStorage!.projectsRoot, projectId, 'shared'); }
  /** vm_manager layout: <projects>/<projectId>/tasks/<taskId>. */
  vmTaskDirectory(projectId: string, taskId: string): string { return this.taskSpaceDirectory(projectId, taskId); }
  vmSharedDirectory(projectId: string): string { return this.sharedSpaceDirectory(projectId); }
  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.files.initialize();
    this.db = new DatabaseSync(join(this.root, 'domain.sqlite'));
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dependencies(source TEXT NOT NULL REFERENCES tasks(id), target TEXT NOT NULL REFERENCES tasks(id), PRIMARY KEY(source,target));
      CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reviews(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_task_ranks(project_id TEXT PRIMARY KEY REFERENCES projects(id), value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS deletion_jobs(task_id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_deletion_jobs(project_id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS clearing_jobs(task_id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dependency_jobs(project_id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS activity_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, project_id TEXT, task_id TEXT, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS activity_events_project ON activity_events(project_id, seq);
      CREATE TABLE IF NOT EXISTS file_descriptions(task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,path TEXT NOT NULL,version TEXT NOT NULL,data_generation INTEGER NOT NULL,value TEXT NOT NULL,PRIMARY KEY(task_id,path));`);
    this.migrateTaskIdentity();
    if (!this.db.prepare('SELECT id FROM projects WHERE id=?').get('m1-verification') && this.legacyIds.length) {
      this.transaction(() => {
        this.putProject({ id: 'm1-verification', title: 'M1 验证数据（保留）', goal: '保留最小插件验证数据，不代表工程验收', constraints: '', revision: 0, createdAt: now() });
        for (const id of this.legacyIds) this.putTask(this.newTask('m1-verification', { title: id === 'm1-gear' ? '齿轮文件入口验证' : '轴承文件入口验证', kind: 'task', goal: 'M1 技术验证', constraints: '仅为验证数据', criteria: [{ id: 'legacy-proof', label: '文件入口可用', kind: 'check', method: '人工核对验证记录' }], outputs: ['parameters.md'], unresolved: [] }, { id, state: 'working', assignee: 'operator' }));
      });
    }
    await this.migrateWorkflow();
    if (this.mode === 'single-user') {
      // Startup derives progress only: historical reviewed candidates require an
      // explicit human confirmation to create a new single-user result snapshot.
      const depth = (task: Task) => { let count = 0, parentId = task.parentId; while (parentId) { count++; parentId = this.task(parentId).parentId; } return count; };
      this.transaction(() => {
        for (const task of this.tasks().sort((a, b) => depth(b) - depth(a))) {
          const children = this.activeChildren(task.id);
          if (!this.children(task.id).length || this.isArchived(task) || ['completed', 'recheck'].includes(task.state) || task.pending) continue;
          // A confirmed folder clear resets this node only. Existing completed
          // children must not turn it back into working merely on restart.
          if (task.state === 'unstarted' && (task.dataGeneration ?? 0) > 0) continue;
          task.state = children.some(child => ['working', 'completed', 'recheck'].includes(child.state)) ? 'working' : 'unstarted'; this.putTask(task);
        }
      });
    }
    for (const task of this.tasks()) if (this.mode === 'single-user' || task.state !== 'unstarted') {
      await this.files.allocate(task.id);
      if (!this.discussionAllowed(task)) this.files.revoke(task.id);
    }
    // Existing files are a baseline, not a batch of auxiliary model requests.
    // Managed writes notify immediately; the watcher covers software/external producers.
    try {
      this.descriptionWatcher = watch(this.files.root, { recursive: true }, (_event, filename) => {
        if (!filename || this.stopping) return;
        const [id, first, ...rest] = filename.toString().replace(/\\/g, '/').split('/');
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) || !first || first.toLowerCase() === '.chat-tmp') return;
        const path = [first, ...rest].join('/'); try { fileName(path); } catch { return; }
        const key = `${id}/${path}`; clearTimeout(this.descriptionChanges.get(key));
        const timer = setTimeout(() => { this.descriptionChanges.delete(key); void this.refreshFileDescriptions(id, path).catch(() => undefined); }, 250); timer.unref(); this.descriptionChanges.set(key, timer);
      });
      this.descriptionWatcher.unref(); this.descriptionWatcher.on('error', () => { this.descriptionWatcher?.close(); this.descriptionWatcher = undefined; });
    } catch { /* Preview reconciliation remains available on hosts without recursive watch support. */ }
    // Virtual machines (and Linux sandboxes) write task files directly into <projects>/<projectId>/tasks/<taskId>.
    if (this.fileStorage) try {
      if (!this.fileStorage.workspaces) await mkdir(this.fileStorage.projectsRoot, { recursive: true, mode: 0o700 });
      this.externalWatcher = watch(this.fileStorage.projectsRoot, { recursive: true }, (_event, filename) => {
        if (!filename || this.stopping) return;
        const [, area, id, first, ...rest] = filename.toString().replace(/\\/g, '/').split('/');
        if (area !== 'tasks' || !id || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) || !first) return;
        const path = [first, ...rest].join('/'); try { fileName(path); } catch { return; }
        const key = `${id}/${path}`; clearTimeout(this.descriptionChanges.get(key));
        const timer = setTimeout(() => { this.descriptionChanges.delete(key); void this.refreshFileDescriptions(id, path).catch(() => undefined); }, 250); timer.unref(); this.descriptionChanges.set(key, timer);
      });
      this.externalWatcher.unref(); this.externalWatcher.on('error', () => { this.externalWatcher?.close(); this.externalWatcher = undefined; });
    } catch { /* The external store may not exist yet; previews still reconcile descriptions. */ }
  }
  bindFileDescriptionGenerator(generator: FileDescriptionGenerator): () => void { return this.fileDescriptions.bind(generator); }
  /** Preserve reviewed history while normal launches use the single-user lifecycle. */
  private async migrateWorkflow() {
    const tasks = this.tasks(), original = new Map(tasks.map(task => [task.id, task]));
    const archived = (task: Task): boolean => {
      const seen = new Set<string>(); let current: Task | undefined = task;
      while (current && !seen.has(current.id)) { if (current.archived || current.state === 'discarded') return true; seen.add(current.id); current = current.parentId ? original.get(current.parentId) : undefined; }
      return false;
    };
    const memo = new Map<string, boolean>();
    const valid = async (task: Task, visiting = new Set<string>()): Promise<boolean> => {
      if (memo.has(task.id)) return memo.get(task.id)!;
      if (visiting.has(task.id) || archived(task)) return false;
      const snapshotId = task.state === 'accepted' ? task.acceptedId : task.state === 'completed' ? task.completedId : undefined;
      if (!snapshotId) return false;
      const next = new Set(visiting).add(task.id);
      try {
        const snapshot = this.snapshot(snapshotId); if (snapshot.taskId !== task.id) return false;
        const predecessors = this.predecessorIds(task);
        if (task.inputs.length !== predecessors.length) return false;
        for (const id of predecessors) {
          const predecessor = original.get(id), ref = task.inputs.find(row => row.taskId === id);
          if (!predecessor || !ref || ref.snapshotId !== (predecessor.state === 'accepted' ? predecessor.acceptedId : predecessor.state === 'completed' ? predecessor.completedId : undefined) || !await valid(predecessor, next)) return false;
        }
        const children = tasks.filter(child => child.parentId === task.id && !archived(child));
        if (snapshot.childrenRefs) {
          const refs = children.map(child => ({ taskId: child.id, snapshotId: child.state === 'accepted' ? child.acceptedId : child.state === 'completed' ? child.completedId : undefined }));
          if (!children.length || JSON.stringify(refs) !== JSON.stringify(snapshot.childrenRefs)) return false;
          for (const child of children) if (!await valid(child, next)) return false;
        } else if (children.length) return false;
        await this.verifySnapshot(snapshot); memo.set(task.id, true); return true;
      } catch { memo.set(task.id, false); return false; }
    };
    const changes: Task[] = [];
    for (const task of tasks) {
      if (task.workflowMode === this.mode && isCurrentTaskState(task.state, this.mode)) continue;
      if (this.mode === 'single-user') {
        const legacyLifecycle = task.legacyLifecycle ?? (task.state !== 'completed' ? { state: task.state as ReviewedTaskState, candidateId: task.candidateId, acceptedId: task.acceptedId, inputs: task.inputs, revision: task.revision } : undefined);
        const isArchived = archived(task), complete = !isArchived && ['accepted', 'completed'].includes(task.state) && await valid(task);
        changes.push({ ...task, workflowMode: this.mode, legacyLifecycle, archived: isArchived || undefined, state: complete ? 'completed' : task.state === 'working' && !isArchived ? 'working' : 'unstarted', ...(complete ? { completedId: task.completedId ?? task.acceptedId } : {}) });
      } else {
        changes.push({ ...task, workflowMode: this.mode, state: archived(task) ? 'discarded' : task.state === 'completed' ? 'review' : task.state === 'recheck' ? 'revoked' : task.state, ...(task.state === 'completed' ? { candidateId: task.completedId } : {}), ...(task.state === 'recheck' ? { acceptedId: task.completedId } : {}) });
      }
    }
    if (changes.length) this.transaction(() => { for (const task of changes) this.putTask(task); });
  }
  bindRuntime(quiesce: (ids: string[]) => Promise<void>): () => void { this.quiesce = quiesce; return () => { this.quiesce = async () => { throw new Error('运行时已停止'); }; }; }
  /** Becoming a folder revokes software writes while retaining its planning conversation. */
  bindProducerRuntime(stop: (ids: string[]) => Promise<void>): () => void { this.quiesceProducers = stop; return () => { this.quiesceProducers = async () => {}; }; }
  private async becomingContainer(id?: string) { if (id && !this.children(id).length) await this.quiesceProducers([id]); }
  /** The host permanently removes only this task's conversations and runtime bindings. */
  bindDeletionRuntime(cleanup: (taskId: string) => Promise<void>): () => void { this.deleteConversations = cleanup; return () => { this.deleteConversations = async () => { throw new Error('对话清理运行时已停止'); }; }; }
  /** Project deletion also owns the project-planning conversations and workspace. */
  bindProjectDeletionRuntime(cleanup: (projectId: string, taskIds: string[]) => Promise<void>): () => void { this.deleteProjectConversations = cleanup; return () => { this.deleteProjectConversations = async () => { throw new Error('项目对话清理运行时已停止'); }; }; }
  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.catch(() => undefined).then(() => { if (this.stopping) throw new Error('项目服务正在停止'); return operation(); });
    this.operations = result; return result;
  }
  private putProject(project: Project) { this.db.prepare('INSERT INTO projects VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(project.id, JSON.stringify(project)); }
  private putTask(task: Task) { this.db.prepare('INSERT INTO tasks(id,project_id,value,code,rank) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,code=excluded.code,rank=excluded.rank').run(task.id, task.projectId, JSON.stringify(task), task.code, task.rank); }
  private taskCode(): string {
    for (let attempt = 0; attempt < 128; attempt++) {
      const code = Array.from({ length: 5 }, () => taskCodeAlphabet[randomInt(taskCodeAlphabet.length)]).join('');
      if (!this.db.prepare('SELECT id FROM tasks WHERE code=? COLLATE BINARY').get(code)) return code;
    }
    throw new Error('任务编号暂时无法分配，请重试');
  }
  /** Atomic additive migration: preserve task keys, timestamps, revisions and immutable snapshots. */
  private migrateTaskIdentity() {
    this.transaction(() => {
      const columns = this.db.prepare('PRAGMA table_info(tasks)').all().map(row => row.name);
      if (!columns.includes('code')) this.db.exec("ALTER TABLE tasks ADD COLUMN code TEXT COLLATE BINARY CHECK(code IS NULL OR (length(code)=5 AND code NOT GLOB '*[^0-9A-Za-z]*'))");
      if (!columns.includes('rank')) this.db.exec('ALTER TABLE tasks ADD COLUMN rank INTEGER CHECK(rank IS NULL OR rank>0)');
      const ranks = new Map(this.db.prepare('SELECT project_id,MAX(rank) AS rank FROM tasks GROUP BY project_id').all().map(row => [String(row.project_id), Number(row.rank ?? 0)]));
      // Row insertion order is the existing authoritative addition order, including equal timestamps.
      for (const row of this.db.prepare('SELECT id,project_id,value,code,rank FROM tasks ORDER BY rowid').all()) {
        const projectId = String(row.project_id), task: Task = JSON.parse(String(row.value));
        const code = row.code === null ? this.taskCode() : String(row.code);
        const rank = row.rank === null ? (ranks.get(projectId) ?? 0) + 1 : Number(row.rank);
        if (row.rank === null) ranks.set(projectId, rank);
        if (task.code !== code || task.rank !== rank) this.putTask({ ...task, code, rank });
      }
      this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS tasks_code_unique ON tasks(code COLLATE BINARY); CREATE UNIQUE INDEX IF NOT EXISTS tasks_project_rank_unique ON tasks(project_id,rank);');
      for (const [projectId, rank] of ranks) this.db.prepare('INSERT INTO project_task_ranks VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET value=MAX(value,excluded.value)').run(projectId, rank);
    });
  }
  /** All creation paths call this inside the same SQLite transaction as task insertion. */
  private newTask(projectId: string, data: TaskDefinition, extra: Partial<Task> = {}): Task {
    const rank = Number(this.db.prepare('SELECT value FROM project_task_ranks WHERE project_id=?').get(projectId)?.value ?? 0) + 1;
    if (!Number.isSafeInteger(rank)) throw new Error('任务排序已超出支持范围');
    this.db.prepare('INSERT INTO project_task_ranks VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET value=excluded.value').run(projectId, rank);
    return { ...data, id: this.reserveTaskId(projectId), state: 'unstarted', revision: 0, dependencies: [], inputs: [], createdAt: now(), ...extra, workflowMode: this.mode, projectId, code: this.taskCode(), rank };
  }
  projects(): Project[] { return this.db.prepare('SELECT value FROM projects ORDER BY rowid').all().map(row => JSON.parse(String(row.value))); }
  tasks(projectId?: string): Task[] {
    const rows = projectId ? this.db.prepare('SELECT value FROM tasks WHERE project_id=? ORDER BY rank').all(projectId) : this.db.prepare('SELECT value FROM tasks ORDER BY rowid').all();
    return rows.map(row => JSON.parse(String(row.value)));
  }
  task(id: string): Task { const row = this.db.prepare('SELECT value FROM tasks WHERE id=?').get(id); if (!row) throw new Error('任务不存在'); return JSON.parse(String(row.value)); }
  private checkVersion(task: Task, revision: unknown) { if (revision !== task.revision) throw new Error('任务已变化，请刷新后重试'); }
  private project(id: string): Project { const project = this.projects().find(row => row.id === id); if (!project) throw new Error('项目不存在'); return project; }
  private touch(task: Task) { task.revision++; this.putTask(task); const project = this.project(task.projectId); project.revision++; this.putProject(project); }
  private children(id: string): Task[] { const task = this.task(id); return this.tasks(task.projectId).filter(row => row.parentId === id); }
  private isArchived(task: Task): boolean { let current = task; while (true) { if (current.archived || current.state === 'discarded') return true; if (!current.parentId) return false; current = this.task(current.parentId); } }
  private activeChildren(id: string): Task[] { return this.children(id).filter(child => !this.isArchived(child)); }
  private resultId(task: Task): string | undefined { return this.isArchived(task) || task.pending || this.repairAffected(task) ? undefined : resultSnapshotId(task, this.mode); }
  /** Direct repair markers propagate to containing folders and dependent subgraphs. */
  private repairAffected(task: Task, seen = new Set<string>()): boolean {
    if (seen.has(task.id)) return false; seen.add(task.id);
    if (task.dependencyRepairRequired) return true;
    // Inherited predecessor removal must block descendants even after its edge
    // has been removed. Check only direct ancestor markers, not sibling trees.
    let parentId = task.parentId;
    while (parentId) { const parent = this.task(parentId); if (parent.dependencyRepairRequired) return true; parentId = parent.parentId; }
    return this.predecessorIds(task).some(id => { try { return this.repairAffected(this.task(id), seen); } catch { return true; } })
      || this.activeChildren(task.id).some(child => this.repairAffected(child, seen));
  }
  private leaf(task: Task) { if (task.kind !== 'task' || this.children(task.id).length) throw new Error('任务组或含子任务的文件夹不能直接执行叶任务工作'); }
  private validateParent(projectId: string, parentId?: string, taskId?: string, allowUnsubmittedReview = false) {
    if (!parentId) return;
    const seen = new Set([taskId]); let parent = this.task(parentId);
    while (true) {
      if (parent.projectId !== projectId || seen.has(parent.id)) throw new Error('父任务跨项目或形成嵌套循环');
      const editable = this.mode === 'single-user' ? parent.state === 'unstarted' || parent.state === 'working' && this.children(parent.id).length > 0 : ['unstarted', 'allocated'].includes(parent.state) || allowUnsubmittedReview && parent.state === 'review';
      if (!editable || parent.pending || this.isArchived(parent) || this.mode === 'reviewed' && parent.acceptedId) throw new Error('父任务已开始工作或冻结（包括已废弃状态），不能添加或移动子任务');
      seen.add(parent.id); if (!parent.parentId) break; parent = this.task(parent.parentId);
    }
  }
  private predecessorIds(task: Task): string[] {
    const ids = new Set(task.dependencies); let parentId = task.parentId;
    while (parentId) { const parent = this.task(parentId); for (const id of parent.dependencies) ids.add(id); parentId = parent.parentId; }
    return [...ids];
  }
  private hierarchy(task: Task): { isFolder: boolean; childCount: number; leafStats: LeafStats } {
    const rows = this.tasks(task.projectId), children = rows.filter(row => row.parentId === task.id);
    const states = Object.fromEntries(Object.keys(currentStateNames(this.mode)).map(state => [state, 0])) as Record<TaskState, number>;
    const leaves = (node: Task): Task[] => { if (this.mode === 'single-user' && this.isArchived(node)) return []; const nested = rows.filter(row => row.parentId === node.id); return nested.length ? nested.flatMap(leaves) : node.kind === 'task' ? [node] : []; };
    const actual = leaves(task); for (const leaf of actual) states[leaf.state]++;
    return { isFolder: children.length > 0, childCount: children.length, leafStats: { total: actual.length, states } };
  }
  blockers(task: Task): string[] {
    const reasons: string[] = [];
    if (this.repairAffected(task)) reasons.push('依赖缺失：请重新设置有效依赖并确认修复；相关旧快照仅保留为历史');
    if (this.children(task.id).length && !this.activeChildren(task.id).length) reasons.push(this.mode === 'single-user' ? '没有有效子任务；至少需要一个有效子任务才能汇总完成' : '全部子任务已废弃；至少需要一个有效子任务才能汇总送验');
    for (const id of this.predecessorIds(task)) {
      let parent: Task; try { parent = this.task(id); } catch { reasons.push(`依赖缺失：${id}`); continue; }
      const resultId = this.resultId(parent);
      if (!resultId) reasons.push(`${this.mode === 'single-user' ? '前驱尚未完成' : '前驱未有效验收'}：${parent.title}`);
      else if ((['working', 'review'].includes(task.state) || this.mode === 'single-user' && task.state === 'unstarted' && task.inputs.length > 0) && !(this.mode === 'single-user' && this.children(task.id).length) && task.inputs.find(row => row.taskId === id)?.snapshotId !== resultId) reasons.push(`实际输入版本不匹配：${parent.title}`);
    }
    return reasons;
  }
  view(id: string): TaskView {
    const task = this.task(id), hierarchy = this.hierarchy(task), blockers = this.blockers(task), job = task.pendingAction === 'dependencies' && task.pendingOwnerId === id ? this.dependencyJob(task.projectId) : undefined;
    const archived = this.isArchived(task), repair = this.repairAffected(task), resultId = archived || task.pending || repair ? undefined : resultSnapshotId(task, this.mode), completedBy = resultId && this.confirmer(resultId);
    return { ...task, checklist: checklistItems(task), canEditMetadata: this.metadataEditable(task), dependencyRepairRequired: repair || undefined, workflowMode: this.mode, archived: archived || undefined, ...hierarchy, blockers, definitionIssues: hierarchy.isFolder ? [] : definitionIssues(task, this.mode), writable: this.workspaceWritable(task, hierarchy, blockers), canDiscuss: this.discussionAllowed(task), ...(completedBy ? { completedBy } : {}), ...(job ? { pendingDependencyRequest: this.currentDependencyRequest(job.request) } : {}) };
  }
  private confirmer(snapshotId: string): 'human' | 'agent' | undefined {
    let value = this.confirmers.get(snapshotId);
    if (!value) {
      const row = this.db.prepare("SELECT json_extract(value,'$.humanConfirmation.actor') AS actor FROM snapshots WHERE id=?").get(snapshotId); if (!row) return;
      value = row.actor === 'agent' ? 'agent' : 'human'; this.confirmers.set(snapshotId, value);
    }
    return value;
  }
  graph(id: string) { return { workflowMode: this.mode, project: this.project(id), tasks: this.tasks(id).map(task => this.view(task.id)) }; }
  directory() { return this.tasks().map(task => { const { id, code, rank, projectId, title, kind, state, parentId, isFolder, childCount, leafStats, workflowMode, archived, dependencyRepairRequired } = this.view(task.id); return { id, code, rank, projectId, title, kind, state, ...(parentId ? { parentId } : {}), isFolder, childCount, leafStats, workflowMode, ...(archived ? { archived } : {}), ...(dependencyRepairRequired ? { dependencyRepairRequired } : {}) }; }); }
  private hierarchyWritable(task: Task): boolean {
    if (this.isArchived(task)) return false;
    let parentId = task.parentId;
    while (parentId) {
      const parent = this.task(parentId);
      if (parent.pending || ['review', 'accepted', 'revoked', 'discarded', 'completed'].includes(parent.state)) return false;
      parentId = parent.parentId;
    }
    return true;
  }
  private assertHierarchyWritable(task: Task) { if (!this.hierarchyWritable(task)) throw new Error('上级任务已冻结或废弃，不能继续子任务工作或讨论'); }
  assertWorking(id: string) { const task = this.task(id); this.leaf(task); this.assertHierarchyWritable(task); if (!(task.state === 'working' || this.mode === 'single-user' && ['unstarted', 'recheck'].includes(task.state)) || task.pending || this.blockers(task).length) throw new Error('任务不可编辑：状态被冻结、输入无效或操作尚未完成'); }
  private discussionAllowed(task: Task): boolean { return (this.mode === 'single-user' ? ['unstarted', 'working', 'recheck'] : ['allocated', 'working']).includes(task.state) && !task.pending && !this.repairAffected(task) && this.hierarchyWritable(task) && (task.state !== 'working' || this.mode === 'single-user' && this.children(task.id).length > 0 || !this.blockers(task).length); }
  assertDiscussionWritable(id: string) { const task = this.task(id); this.assertHierarchyWritable(task); if (!this.discussionAllowed(task)) throw new Error(this.mode === 'single-user' ? '任务讨论不可写：已完成、被冻结或实际输入无效' : '任务讨论不可写：尚未分配、已冻结或实际输入无效'); }
  private workspaceWritable(task: Task, hierarchy = this.hierarchy(task), blockers = this.blockers(task)): boolean {
    if (task.kind !== 'task') return false;
    // An active folder may maintain its own summary/deliverable files, but it
    // still cannot execute leaf-only software or lifecycle work.
    if (hierarchy.isFolder) return this.discussionAllowed(task);
    return (task.state === 'working' || this.mode === 'single-user' && ['unstarted', 'recheck'].includes(task.state))
      && !task.pending && !blockers.length && this.hierarchyWritable(task);
  }
  assertWorkspaceWritable(id: string) { const task = this.task(id); this.assertHierarchyWritable(task); if (!this.workspaceWritable(task)) throw new Error('任务文件不可编辑：任务已完成、被冻结、归档或实际输入无效'); }
  private inputs(task: Task): InputRef[] { if (this.repairAffected(task)) throw new Error('依赖缺失：请先重新设置有效依赖并确认修复'); return this.predecessorIds(task).map(id => { const parent = this.task(id), snapshotId = this.resultId(parent); if (!snapshotId || this.mode === 'single-user' && this.blockers(parent).length) throw new Error(this.mode === 'single-user' ? '前驱须全部有效完成' : '前驱须全部有效验收'); return { taskId: id, snapshotId }; }); }
  private deletionJob(id: string): DeletionJob | undefined { const row = this.db.prepare('SELECT value FROM deletion_jobs WHERE task_id=?').get(id); return row ? JSON.parse(String(row.value)) : undefined; }
  private async ownedDeletionSnapshotsFor(taskIds: ReadonlySet<string>, recorded: string[]): Promise<string[]> {
    const base = join(this.root, 'snapshots'), found = new Set(recorded);
    try { if (await realpath(base) !== base || !(await lstat(base)).isDirectory()) throw new Error('快照根目录已改变'); }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [...found]; throw error; }
    // A process may have renamed a captured snapshot just before SQLite failed.
    // Its manifest still identifies the owner, so journal it without a backup.
    for (const entry of await readdir(base, { withFileTypes: true })) {
      const match = /^(s-[a-z0-9-]{1,64})(?:\.tmp)?$/.exec(entry.name);
      if (!match || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      const path = join(base, entry.name, 'manifest.json');
      let handle;
      try {
        if (await realpath(path) !== path) continue;
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const info = await handle.stat(); if (!info.isFile() || info.size > 1024 * 1024) continue;
        const snapshot = JSON.parse((await handle.readFile()).toString('utf8'));
        if (taskIds.has(snapshot.taskId) && snapshot.id === match[1]) found.add(match[1]);
      } catch (error) {
        if (!(error instanceof SyntaxError || error instanceof Error && 'code' in error && ['ENOENT', 'ELOOP'].includes(String(error.code)))) throw error;
      } finally { await handle?.close(); }
    }
    return [...found];
  }
  private ownedDeletionSnapshots(taskId: string, recorded: string[]): Promise<string[]> { return this.ownedDeletionSnapshotsFor(new Set([taskId]), recorded); }
  private deletionPlan(task: Task): DeletionJob {
    if (this.mode !== 'single-user') throw new Error('永久删除暂仅用于单用户流程');
    if (this.children(task.id).length) throw new Error('任务包含更下级子任务，不能删除；请先删除其子任务');
    const existing = this.deletionJob(task.id); if (existing) return existing;
    const rows = this.tasks(task.projectId), directRows = rows.filter(row => row.id !== task.id && (row.dependencies.includes(task.id) || row.inputs.some(ref => ref.taskId === task.id)));
    const directIds = directRows.filter(row => {
      if (row.dependencies.includes(task.id)) return true;
      // An inherited input is repaired by its owning ancestor, rather than
      // requiring every executed descendant to confirm the same lost edge.
      let parentId = row.parentId;
      while (parentId) { const parent = this.task(parentId); if (parent.dependencies.includes(task.id) || parent.inputs.some(ref => ref.taskId === task.id)) return false; parentId = parent.parentId; }
      return true;
    }).map(row => row.id);
    // Only the nearest fixed summary needs a direct marker. Its ancestors inherit
    // that marker through their children, so repairing it clears the whole chain.
    const parent = task.parentId ? this.task(task.parentId) : undefined;
    const summaryIds = parent && (parent.completedId || parent.candidateId || parent.acceptedId) ? [parent.id] : [];
    // JSON task metadata is authoritative for imported projects whose original
    // dependency table may be incomplete. Actual executed input refs also count.
    const found = new Set<string>(), queue = [task.id, ...directRows.map(row => row.id)];
    while (queue.length) {
      const id = queue.shift()!; if (found.has(id)) continue; found.add(id);
      const current = rows.find(row => row.id === id); if (current?.parentId) queue.push(current.parentId);
      for (const row of rows) if (row.dependencies.includes(id) || row.inputs.some(ref => ref.taskId === id)) queue.push(row.id, ...this.contained(row.id));
    }
    const affectedIds = [...found].filter(id => id !== task.id);
    const pending = [task.id, ...affectedIds].map(id => this.task(id)).find(row => row.pending);
    if (pending) throw new Error('相关任务有未完成的冻结或恢复操作，请先恢复该操作再删除');
    return { taskId: task.id, projectId: task.projectId, affectedIds, directIds, summaryIds,
      snapshotIds: this.db.prepare('SELECT id FROM snapshots WHERE task_id=?').all(task.id).map(row => String(row.id)) };
  }
  /** Read-only concrete confirmation; every real child counts, including archived children. */
  deletePreview(id: string): TaskDeletePreview {
    const task = this.task(id), job = this.deletionPlan(task), summaries = new Set<string>();
    let parentId = task.parentId; while (parentId) { summaries.add(parentId); parentId = this.task(parentId).parentId; }
    return { taskId: id, projectId: task.projectId, taskRevision: task.revision, projectRevision: this.project(task.projectId).revision,
      title: task.title, code: task.code, state: task.state, workspace: true,
      snapshotCount: job.snapshotIds.length, reviewCount: Number(this.db.prepare('SELECT COUNT(*) AS count FROM reviews WHERE task_id=?').get(id)?.count ?? 0),
      affected: job.affectedIds.map(id => { const affected = this.task(id); return { id, code: affected.code, title: affected.title, state: affected.state, reason: summaries.has(id) ? 'summary' as const : 'dependency' as const }; }), retry: Boolean(this.deletionJob(id)) };
  }
  /** Confirmed, journaled hard deletion. Failure leaves every affected writer frozen for retry. */
  deleteTask(id: string, input: unknown): Promise<TaskDeleteResult> { return this.serial(async () => {
    const data = exactFields(input, ['revision', 'projectRevision', 'confirm'], '永久删除'), task = this.task(id);
    if (data.confirm !== true) throw new Error('永久删除必须二次确认');
    this.checkVersion(task, data.revision);
    if (!Number.isSafeInteger(data.projectRevision) || data.projectRevision !== this.project(task.projectId).revision) throw new Error('项目图谱已变化，请重新预览删除影响');
    const job = this.deletionPlan(task), ids = [id, ...job.affectedIds];
    this.fileDescriptions.cancel(id);
    if (!this.deletionJob(id)) job.snapshotIds = await this.ownedDeletionSnapshots(id, job.snapshotIds);
    if (!this.deletionJob(id)) this.transaction(() => {
      this.db.prepare('INSERT INTO deletion_jobs VALUES(?,?)').run(id, JSON.stringify(job));
      for (const value of ids) { const current = this.task(value); current.pending = '正在永久删除任务及关联数据；失败时保持禁止写入，请重试删除'; current.pendingAction = 'delete'; current.pendingOwnerId = id; delete current.pendingMeasurements; delete current.pendingConfirmation; this.touch(current); }
    });
    for (const value of ids) { this.files.register(value); this.files.revoke(value); }
    await this.quiesce(ids); await this.files.drain();
    // Conversation cleanup is idempotent and awaited before any row can disappear.
    await this.deleteConversations(id);
    await this.files.deleteTask(id);
    await this.completionStore.removeTask(id);
    for (const snapshotId of job.snapshotIds) {
      if (!/^s-[a-z0-9-]{1,64}$/.test(snapshotId)) throw new Error('快照清理标识不合法');
      const base = join(this.root, 'snapshots');
      await removeManagedDirectory(base, join(base, snapshotId));
      await removeManagedDirectory(base, join(base, `${snapshotId}.tmp`));
    }
    this.transaction(() => {
      // No external operation is permitted to open this frozen task during cleanup.
      if (this.children(id).length) throw new Error('删除期间任务出现子任务，清理已冻结，请检查并重试');
      for (const value of job.affectedIds) {
        const current = this.task(value);
        current.dependencies = current.dependencies.filter(source => source !== id);
        if (!this.isArchived(current)) this.invalidateSingleUser(current);
        if (job.directIds.includes(value) || job.summaryIds.includes(value)) current.dependencyRepairRequired = true;
        delete current.pending; delete current.pendingAction; delete current.pendingOwnerId; delete current.pendingMeasurements; delete current.pendingConfirmation; this.touch(current);
      }
      this.db.prepare('DELETE FROM dependencies WHERE source=? OR target=?').run(id, id);
      this.db.prepare('DELETE FROM reviews WHERE task_id=?').run(id);
      this.db.prepare('DELETE FROM snapshots WHERE task_id=?').run(id);
      this.db.prepare('DELETE FROM tasks WHERE id=?').run(id);
      this.db.prepare('DELETE FROM deletion_jobs WHERE task_id=?').run(id);
      const project = this.project(job.projectId); project.revision++; this.putProject(project);
    });
    for (const value of job.affectedIds) { const current = this.task(value); if (this.discussionAllowed(current)) this.files.reopen(value); }
    return { taskId: id, projectId: job.projectId, affectedIds: job.affectedIds };
  }); }
  private clearingJob(id: string): ClearingJob | undefined {
    const row = this.db.prepare('SELECT value FROM clearing_jobs WHERE task_id=?').get(id);
    return row ? JSON.parse(String(row.value)) : undefined;
  }
  private clearingPlan(task: Task): ClearingJob {
    if (this.mode !== 'single-user') throw new Error('清空进展暂仅用于单用户流程');
    const existing = this.clearingJob(task.id);
    if (existing) {
      for (const id of [task.id, ...existing.affectedIds, ...existing.preservedIds]) {
        const current = this.task(id);
        if (current.pendingAction !== 'clear' || current.pendingOwnerId !== task.id) throw new Error('清空冻结记录已变化，请检查恢复状态');
      }
      return existing;
    }
    if (this.isArchived(task)) throw new Error('归档任务不能清空进展');
    // Descendants are briefly fenced because an ancestor controls their live
    // permissions, but their states, files, conversations and results survive.
    const preservedIds = this.contained(task.id), preserved = new Set(preservedIds);
    const affectedIds = this.affectedBy([task.id]).filter(id => id !== task.id && !preserved.has(id));
    for (const id of [task.id, ...affectedIds, ...preservedIds]) {
      const current = this.task(id);
      if (current.projectId !== task.projectId) throw new Error('清空影响范围包含跨项目引用，请先修复图谱');
      if (current.pending) throw new Error('相关任务有未完成的冻结或恢复操作，请先恢复该操作再清空');
    }
    return { taskId: task.id, projectId: task.projectId, affectedIds, preservedIds,
      snapshotIds: this.db.prepare('SELECT id FROM snapshots WHERE task_id=?').all(task.id).map(row => String(row.id)) };
  }
  /** Pure read: preview never allocates files, creates a chat or contacts Seat. */
  clearPreview(id: string): TaskClearPreview {
    const task = this.task(id), job = this.clearingPlan(task), summaries = new Set<string>();
    let parentId = task.parentId; while (parentId) { summaries.add(parentId); parentId = this.task(parentId).parentId; }
    return { taskId: id, projectId: task.projectId, taskRevision: task.revision, projectRevision: this.project(task.projectId).revision,
      title: task.title, code: task.code, state: task.state, workspace: true,
      snapshotCount: job.snapshotIds.length, reviewCount: Number(this.db.prepare('SELECT COUNT(*) AS count FROM reviews WHERE task_id=?').get(id)?.count ?? 0),
      affected: job.affectedIds.map(id => { const current = this.task(id); return { id, code: current.code, title: current.title, state: current.state, reason: summaries.has(id) ? 'summary' as const : 'dependency' as const }; }),
      childCount: this.children(id).length, preservedChildren: true, retry: Boolean(this.clearingJob(id)) };
  }
  /** Human-confirmed destructive reset: preserve definition and graph, not history. */
  clearTask(id: string, input: unknown): Promise<TaskClearResult> { return this.serial(async () => {
    const data = exactFields(input, ['revision', 'projectRevision', 'confirm'], '清空进展'), task = this.task(id);
    if (data.confirm !== true) throw new Error('清空进展必须二次确认');
    this.checkVersion(task, data.revision);
    if (!Number.isSafeInteger(data.projectRevision) || data.projectRevision !== this.project(task.projectId).revision) throw new Error('项目图谱已变化，请重新预览清空影响');
    const job = this.clearingPlan(task), ids = [id, ...job.affectedIds, ...job.preservedIds];
    this.fileDescriptions.cancel(id);
    if (!this.clearingJob(id)) {
      const generation = task.dataGeneration ?? 0;
      if (!Number.isSafeInteger(generation) || generation < 0 || generation === Number.MAX_SAFE_INTEGER) throw new Error('任务数据代次不合法或已超出支持范围');
      job.snapshotIds = await this.ownedDeletionSnapshots(id, job.snapshotIds);
      this.transaction(() => {
        this.db.prepare('INSERT INTO clearing_jobs VALUES(?,?)').run(id, JSON.stringify(job));
        for (const value of ids) {
          const current = this.task(value);
          if (value === id) current.dataGeneration = generation + 1;
          current.pending = '正在清空任务自有数据；失败时保持禁止写入，请重新预览并确认清空'; current.pendingAction = 'clear'; current.pendingOwnerId = id;
          delete current.pendingMeasurements; delete current.pendingConfirmation; this.touch(current);
        }
      });
    }
    for (const value of ids) { this.files.register(value); this.files.revoke(value); }
    await this.quiesce(ids); await this.files.drain();
    // The deletion adapter also discovers unindexed Sessions by public cwd and
    // keeps its own retry journal; a fresh UUID is required for every new chat.
    await this.deleteConversations(id);
    await this.files.purge(id);
    await this.completionStore.removeTask(id);
    for (const snapshotId of job.snapshotIds) {
      if (!/^s-[a-z0-9-]{1,64}$/.test(snapshotId)) throw new Error('快照清理标识不合法');
      const base = join(this.root, 'snapshots');
      await removeManagedDirectory(base, join(base, snapshotId));
      await removeManagedDirectory(base, join(base, `${snapshotId}.tmp`));
    }
    this.transaction(() => {
      // Whitelisting the new record drops old result IDs, imported lifecycle,
      // submitted receipts, input refs and review/confirmation history together.
      const current = this.task(id);
      const cleared: Task = { id, projectId: current.projectId, code: current.code, rank: current.rank, createdAt: current.createdAt,
        revision: current.revision, dataGeneration: current.dataGeneration, workflowMode: this.mode, state: 'unstarted',
        title: current.title, kind: current.kind, goal: current.goal, constraints: current.constraints, criteria: current.criteria,
        outputs: current.outputs, unresolved: current.unresolved, dependencies: current.dependencies, inputs: [],
        ...(current.parentId ? { parentId: current.parentId } : {}), ...(current.checklist !== undefined ? { checklist: current.checklist } : {}),
        ...(current.dependencyRepairRequired ? { dependencyRepairRequired: true } : {}) };
      for (const value of job.affectedIds) { const affected = this.task(value); if (!this.isArchived(affected)) this.invalidateSingleUser(affected); else { delete affected.pending; delete affected.pendingAction; delete affected.pendingOwnerId; } this.touch(affected); }
      for (const value of job.preservedIds) { const preserved = this.task(value); delete preserved.pending; delete preserved.pendingAction; delete preserved.pendingOwnerId; this.touch(preserved); }
      this.db.prepare('DELETE FROM reviews WHERE task_id=?').run(id);
      this.db.prepare('DELETE FROM snapshots WHERE task_id=?').run(id);
      this.db.prepare('DELETE FROM file_descriptions WHERE task_id=?').run(id);
      this.touch(cleared);
      this.db.prepare('DELETE FROM clearing_jobs WHERE task_id=?').run(id);
    });
    for (const value of ids) if (this.discussionAllowed(this.task(value))) this.files.reopen(value);
    return { task: this.view(id), projectId: job.projectId, affectedIds: job.affectedIds };
  }); }
  createProject(input: unknown) { return this.serial(async () => {
    const data = object(input); const project: Project = { id: `p-${randomUUID()}`, title: text(data.title, '项目名称'), goal: text(data.goal, '项目目标', false), constraints: text(data.constraints, '约束', false), revision: 0, createdAt: now() };
    this.transaction(() => this.putProject(project)); return project;
  }); }
  private projectDeletionJob(id: string): ProjectDeletionJob | undefined {
    const row = this.db.prepare('SELECT value FROM project_deletion_jobs WHERE project_id=?').get(id);
    return row ? JSON.parse(String(row.value)) : undefined;
  }
  projectDeleting(id: string): boolean { this.project(id); return Boolean(this.projectDeletionJob(id)); }
  renameProject(id: string, input: unknown): Promise<Project> { return this.serial(async () => {
    const data = exactFields(input, ['revision', 'title'], '项目重命名'), project = this.project(id);
    if (this.projectDeletionJob(id)) throw new Error('项目正在删除或等待删除重试，不能重命名');
    if (!Number.isSafeInteger(data.revision) || data.revision !== project.revision) throw new Error('项目已变化，请刷新后重试');
    const title = text(data.title, '项目名称'); if (title === project.title) return project;
    const next = { ...project, title, revision: project.revision + 1 }; this.transaction(() => this.putProject(next)); return next;
  }); }
  projectDeletePreview(id: string): ProjectDeletePreview {
    const project = this.project(id), tasks = this.tasks(id), job = this.projectDeletionJob(id);
    if (!job) {
      const pending = tasks.find(task => task.pending);
      if (pending) throw new Error('项目中有未完成的冻结、清空或删除操作，请先恢复该操作');
    }
    const taskIds = job?.taskIds ?? tasks.map(task => task.id);
    const count = (table: 'snapshots' | 'reviews') => Number(this.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE task_id IN (SELECT id FROM tasks WHERE project_id=?)`).get(id)?.count ?? 0);
    return { projectId: id, projectRevision: project.revision, title: project.title, taskCount: taskIds.length,
      snapshotCount: count('snapshots'), reviewCount: count('reviews'), retry: Boolean(job) };
  }
  /** Confirmed, journaled whole-project deletion. External cleanup is idempotent; a failure remains frozen for retry. */
  deleteProject(id: string, input: unknown): Promise<ProjectDeleteResult> { return this.serial(async () => {
    const data = exactFields(input, ['revision', 'confirmationTitle'], '项目删除'), project = this.project(id);
    if (!Number.isSafeInteger(data.revision) || data.revision !== project.revision) throw new Error('项目已变化，请刷新后重新确认删除');
    if (typeof data.confirmationTitle !== 'string' || data.confirmationTitle !== project.title) throw new Error('请输入完整且完全一致的项目名称以确认删除');
    let job = this.projectDeletionJob(id);
    if (!job) {
      const tasks = this.tasks(id), pending = tasks.find(task => task.pending);
      if (pending) throw new Error('项目中有未完成的冻结、清空或删除操作，请先恢复该操作');
      const taskIds = tasks.map(task => task.id), recorded = this.db.prepare('SELECT id FROM snapshots WHERE task_id IN (SELECT id FROM tasks WHERE project_id=?)').all(id).map(row => String(row.id));
      const snapshotIds = await this.ownedDeletionSnapshotsFor(new Set(taskIds), recorded);
      job = { projectId: id, title: project.title, taskIds, snapshotIds };
      this.transaction(() => {
        if (this.project(id).revision !== data.revision || this.projectDeletionJob(id)) throw new Error('项目已变化，请刷新后重新确认删除');
        this.db.prepare('INSERT INTO project_deletion_jobs VALUES(?,?)').run(id, JSON.stringify(job));
        for (const taskId of taskIds) {
          const task = this.task(taskId); this.fileDescriptions.cancel(taskId);
          task.pending = '正在永久删除项目及全部关联数据；失败时保持禁止写入，请重试删除';
          task.pendingAction = 'delete'; task.pendingOwnerId = task.id; delete task.pendingMeasurements; delete task.pendingConfirmation; task.revision++; this.putTask(task);
        }
        // Keep the confirmed project revision stable across external cleanup
        // retries. The durable job itself rejects every project mutation.
      });
    } else {
      const currentTasks = this.tasks(id), recordedTaskIds = new Set(job.taskIds);
      if (job.projectId !== id || job.title !== project.title || recordedTaskIds.size !== job.taskIds.length
        || currentTasks.length !== recordedTaskIds.size || currentTasks.some(task => !recordedTaskIds.has(task.id))) {
        throw new Error('项目删除恢复记录无效');
      }
      for (const taskId of job.taskIds) {
        const task = this.task(taskId);
        if (task.pendingAction !== 'delete' || task.pendingOwnerId !== task.id) throw new Error('项目删除冻结记录已变化');
        this.fileDescriptions.cancel(taskId);
      }
    }
    const taskIds = job.taskIds;
    for (const taskId of taskIds) { this.files.register(taskId); this.files.revoke(taskId); }
    // Remove every project/task conversation and the planning workspace before
    // external producers are purged. Task workspaces are already write-fenced.
    await this.deleteProjectConversations(id, taskIds);
    await this.quiesce(taskIds); await this.files.drain();
    for (const taskId of taskIds) { await this.files.deleteTask(taskId); await this.completionStore.removeTask(taskId); }
    // Studio's own project folder (no-software mode) goes once its shared folder and task spaces are gone.
    if (this.fileStorage && !this.vmStorage) for (const empty of [join(this.fileStorage.projectsRoot, id, 'tasks'), join(this.fileStorage.projectsRoot, id)])
      await rmdir(empty).catch(error => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error?.code)) throw error; });
    for (const snapshotId of job.snapshotIds) {
      if (!/^s-[a-z0-9-]{1,64}$/.test(snapshotId)) throw new Error('快照清理标识不合法');
      const base = join(this.root, 'snapshots'); await removeManagedDirectory(base, join(base, snapshotId)); await removeManagedDirectory(base, join(base, `${snapshotId}.tmp`));
    }
    this.transaction(() => {
      const current = this.projectDeletionJob(id);
      if (!current || JSON.stringify(current) !== JSON.stringify(job)) throw new Error('项目删除恢复记录已变化');
      if (this.tasks(id).some(task => !taskIds.includes(task.id))) throw new Error('删除期间项目出现新任务，清理已冻结，请检查并重试');
      this.db.prepare('DELETE FROM dependencies WHERE source IN (SELECT id FROM tasks WHERE project_id=?) OR target IN (SELECT id FROM tasks WHERE project_id=?)').run(id, id);
      this.db.prepare('DELETE FROM reviews WHERE task_id IN (SELECT id FROM tasks WHERE project_id=?)').run(id);
      this.db.prepare('DELETE FROM snapshots WHERE task_id IN (SELECT id FROM tasks WHERE project_id=?)').run(id);
      this.db.prepare('DELETE FROM file_descriptions WHERE task_id IN (SELECT id FROM tasks WHERE project_id=?)').run(id);
      this.db.prepare('DELETE FROM deletion_jobs WHERE task_id IN (SELECT id FROM tasks WHERE project_id=?)').run(id);
      this.db.prepare('DELETE FROM clearing_jobs WHERE task_id IN (SELECT id FROM tasks WHERE project_id=?)').run(id);
      this.db.prepare('DELETE FROM dependency_jobs WHERE project_id=?').run(id);
      this.db.prepare('DELETE FROM tasks WHERE project_id=?').run(id);
      this.db.prepare('DELETE FROM project_task_ranks WHERE project_id=?').run(id);
      this.db.prepare('DELETE FROM project_deletion_jobs WHERE project_id=?').run(id);
      this.db.prepare('DELETE FROM projects WHERE id=?').run(id);
    });
    return { projectId: id, taskIds };
  }); }
  private planningRows(scope: GraphPlanningScope) {
    const raw = exactFields(scope, ['projectId', 'taskId', 'subtreeOnly'], '规划作用域'), projectId = text(raw.projectId, '项目');
    const taskId = raw.taskId === undefined ? undefined : text(raw.taskId, '任务');
    const project = this.project(projectId), rows = new Map(this.tasks(projectId).map(task => [task.id, task]));
    if (this.projectDeletionJob(projectId)) throw new Error('项目正在删除或等待删除重试，不能修改图谱');
    if (taskId && !rows.has(taskId)) throw new Error('规划任务不属于当前项目');
    if (raw.subtreeOnly !== undefined && raw.subtreeOnly !== true) throw new Error('规划作用域的 subtreeOnly 只能为 true');
    const ids = taskId && raw.subtreeOnly ? new Set([taskId, ...this.planningContained(rows, taskId)]) : new Set(rows.keys());
    return { scope: { projectId, ...(taskId ? { taskId } : {}), ...(raw.subtreeOnly ? { subtreeOnly: true as const } : {}) }, project, rows, ids };
  }
  private planningContained(rows: Map<string, Task>, id: string): string[] {
    const found = new Set<string>([id]), queue = [id];
    while (queue.length) {
      const parentId = queue.shift()!;
      for (const task of rows.values()) if (task.parentId === parentId && !found.has(task.id)) { found.add(task.id); queue.push(task.id); }
    }
    return [...found].filter(value => value !== id);
  }
  private planningRecordedHistory(task: Task): boolean {
    return Boolean(task.pending || task.archived || task.candidateId || task.acceptedId || task.completedId || task.inputs.length
      || this.db.prepare('SELECT 1 FROM snapshots WHERE task_id=? UNION ALL SELECT 1 FROM reviews WHERE task_id=? LIMIT 1').get(task.id, task.id));
  }
  private planningHistory(task: Task): boolean {
    return task.state !== 'unstarted' || this.planningRecordedHistory(task);
  }
  /**
   * A working folder can be derived solely from child progress. Its state is not
   * an executed input/result of its own, so it must not freeze an otherwise
   * untouched future branch (for example pLaML -> ZZTNK from XE9V0).
   */
  private planningRelationHistory(task: Task, rows: Map<string, Task>): boolean {
    if (this.planningRecordedHistory(task)) return true;
    if (task.state === 'unstarted') return false;
    return !(this.mode === 'single-user' && task.state === 'working' && [...rows.values()].some(row => row.parentId === task.id));
  }
  private planningPure(rows: Map<string, Task>, id?: string): boolean {
    return !id || [id, ...this.planningContained(rows, id)].every(value => { const task = rows.get(value); return task && !this.planningHistory(task); });
  }
  private planningAffected(rows: Map<string, Task>, ids: string[]): Set<string> {
    const found = new Set<string>(), queue = [...ids];
    while (queue.length) {
      const id = queue.shift()!; if (found.has(id)) continue; found.add(id);
      const task = rows.get(id); if (task?.parentId) queue.push(task.parentId);
      for (const target of rows.values()) if (target.dependencies.includes(id)) queue.push(target.id, ...this.planningContained(rows, target.id));
    }
    return found;
  }
  private planningCapabilities(scope: GraphPlanningScope, task: Task, rows: Map<string, Task>): Pick<PlanningTask, 'canUpdateDefinition' | 'canMove' | 'canSetDependencies' | 'canRemove' | 'planningBlockers'> {
    const reasons: string[] = [];
    const writable = this.hierarchyWritable(task) && !task.pending && !this.isArchived(task);
    const editable = this.metadataEditable(task);
    if (!editable) reasons.push('已开始执行的叶任务、已完成、冻结或归档节点不能修改定义');
    const pure = this.planningPure(rows, task.id), affected = [...this.planningAffected(rows, [task.id, ...this.planningContained(rows, task.id)])];
    const affectsHistory = affected.some(id => { const row = rows.get(id); return row && this.planningRelationHistory(row, rows); });
    if (!pure || affectsHistory) reasons.push('移动或改依赖会影响已有执行、输入或快照历史');
    const canSetDependencies = writable && pure && !affectsHistory;
    const canMove = canSetDependencies;
    const referenced = [...rows.values()].some(row => row.id !== task.id && (row.dependencies.includes(task.id) || row.inputs.some(input => input.taskId === task.id)));
    const canRemove = this.mode === 'single-user' && writable && pure && !this.children(task.id).length && !referenced && task.id !== scope.taskId;
    if (task.id === scope.taskId) reasons.push('当前对话绑定任务可移动，但不能从其自身对话移除');
    if (referenced) reasons.push('仍被其他任务依赖或实际输入引用的节点不能直接移除');
    return { canUpdateDefinition: editable, canMove, canSetDependencies, canRemove, planningBlockers: [...new Set(reasons)] };
  }
  /** Bounded same-project graph context; taskId remains separately exposed as currentTask. */
  planningContext(scope: GraphPlanningScope, options: { offset?: number; limit?: number } = {}): GraphPlanningContext {
    const plan = this.planningRows(scope), raw = exactFields(options, ['offset', 'limit'], '规划分页');
    const offset = raw.offset === undefined ? 0 : raw.offset, limit = raw.limit === undefined ? 50 : raw.limit;
    if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100) throw new Error('规划分页不合法；limit 须为 1 到 100');
    const scoped = [...plan.rows.values()].filter(task => plan.ids.has(task.id) && !this.isArchived(task));
    const breadcrumb: GraphPlanningContext['breadcrumb'] = [{ id: plan.project.id, title: plan.project.title }];
    if (plan.scope.taskId) {
      const chain: Task[] = [], seen = new Set<string>(); let id: string | undefined = plan.scope.taskId;
      while (id) { if (seen.has(id)) throw new Error('当前任务层级存在循环'); seen.add(id); const task = plan.rows.get(id); if (!task) throw new Error('当前任务层级缺少父节点'); chain.unshift(task); id = task.parentId; }
      breadcrumb.push(...chain.map(task => ({ id: task.id, title: task.title, code: task.code })));
    }
    const nextOffset = Number(offset) + Number(limit), total = scoped.length;
    return { scope: plan.scope, project: plan.project, ...(plan.scope.taskId ? { currentTask: this.view(plan.scope.taskId) } : {}), breadcrumb,
      tasks: scoped.slice(Number(offset), nextOffset).map(task => ({ ...this.view(task.id), ...this.planningCapabilities(plan.scope, task, plan.rows) })),
      total, offset: Number(offset), limit: Number(limit), ...(nextOffset < total ? { nextOffset } : {}), truncated: nextOffset < total };
  }
  /** Apply a dialogue's draft graph edits as one commit; never change lifecycle or immutable history. */
  applyGraphPatch(scope: GraphPlanningScope, input: unknown, signal?: AbortSignal): Promise<GraphPatchResult> { return this.serial(async () => {
    throwIfAborted(signal);
    const plan = this.planningRows(scope); if (plan.scope.taskId) this.assertDiscussionWritable(plan.scope.taskId);
    const raw = exactFields(input, ['revision', 'creates', 'updates', 'moves', 'dependencies', 'removes'], '图谱修订');
    if (!Number.isSafeInteger(raw.revision) || raw.revision !== plan.project.revision) throw new Error('项目图谱已变化，请重新读取规划上下文后重试');
    let bytes: number; try { bytes = Buffer.byteLength(JSON.stringify(raw)); } catch { throw new Error('图谱修订必须是 JSON 数据'); }
    if (bytes > 65536) throw new Error('图谱修订超过 64 KiB；请拆成多个批次');
    const operations = (key: 'creates' | 'updates' | 'moves' | 'dependencies' | 'removes') => {
      const rows = raw[key] === undefined ? [] : raw[key]; if (!Array.isArray(rows)) throw new Error(`${key} 必须是列表`); return rows;
    };
    const creates = operations('creates'), updates = operations('updates'), moves = operations('moves'), dependencies = operations('dependencies'), removes = operations('removes');
    const count = creates.length + updates.length + moves.length + dependencies.length + removes.length;
    if (!count || count > 50) throw new Error('每批图谱修订须包含 1 到 50 项操作');
    // Removing an active graph node is recoverable (archive, not hard delete),
    // but it fences another task runtime. Keep that lifecycle boundary separate
    // from the otherwise purely transactional create/update/move batch.
    if (removes.length) {
      if (removes.length !== count) throw new Error('移除节点须使用独立图谱修订批次，不能与其他操作混合');
      const ids: string[] = [];
      for (const value of removes) {
        const row = exactFields(value, ['id'], '移除任务'), id = text(row.id, '任务');
        if (ids.includes(id)) throw new Error('同一节点的移除操作重复');
        const task = plan.rows.get(id);
        if (!task || !plan.ids.has(id)) throw new Error('移除任务不存在、跨项目或超出当前对话的图谱作用域');
        if (this.isArchived(task)) throw new Error('任务已经从活动图谱移除');
        if (!this.planningCapabilities(plan.scope, task, plan.rows).canRemove) throw new Error(task.id === plan.scope.taskId
          ? '当前对话绑定任务不能从其自身对话移除；请从上级或项目对话调整'
          : '仅可移除没有子任务、执行历史、实际输入或被引用关系的纯草稿叶节点；有数据节点请使用人工删除确认');
        ids.push(id);
      }
      const removed = ids.map(id => { const task = plan.rows.get(id)!; return { id, code: task.code, title: task.title, ...(task.parentId ? { parentId: task.parentId } : {}) }; });
      for (const id of ids) { this.fileDescriptions.cancel(id); this.files.register(id); this.files.revoke(id); }
      try {
        await this.quiesce(ids); await this.files.drain(); throwIfAborted(signal);
        this.transaction(() => {
          if (this.project(plan.scope.projectId).revision !== raw.revision) throw new Error('项目图谱已变化，请重新读取规划上下文后重试');
          const parents = new Set<string>();
          for (const id of ids) {
            const task = this.task(id);
            if (!this.planningCapabilities(plan.scope, task, new Map(this.tasks(task.projectId).map(row => [row.id, row]))).canRemove) throw new Error('任务在停止写入期间已变化，不能移除');
            task.archived = true; task.revision++; this.putTask(task);
            this.db.prepare('DELETE FROM dependencies WHERE target=?').run(id);
            if (task.parentId) parents.add(task.parentId);
          }
          for (const id of parents) { const parent = this.task(id); parent.revision++; this.putTask(parent); }
          const project = this.project(plan.scope.projectId); project.revision++; this.putProject(project);
        });
      } catch (error) {
        for (const id of ids) { const task = this.task(id); if (this.discussionAllowed(task)) this.files.reopen(id); }
        throw error;
      }
      return { revision: this.project(plan.scope.projectId).revision, created: [], updated: [], moved: [], dependencies: [], removed };
    }
    const candidates = new Map([...plan.rows].map(([id, task]) => [id, structuredClone(task)]));
    const local = new Map<string, string>(), created = new Map<string, string>(), changed = new Set<string>(), containers = new Set<string>();
    const createRows = creates.map(value => {
      const row = exactFields(value, ['key', 'definition', 'parentId', 'dependencies'], '新增任务'), key = text(row.key, '批次任务键');
      if (key !== row.key || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(key) || local.has(key)) throw new Error('批次任务键不合法或重复');
      const spec = exactFields(row.definition, ['title', 'kind', 'goal', 'constraints', 'criteria', 'outputs', 'unresolved', 'checklist'], '新增任务定义');
      if (spec.kind !== undefined && spec.kind !== 'task') throw new Error('聊天图谱只能新增 task 节点；文件夹由子任务自然形成');
      planningCriteriaFields(spec.criteria);
      const id = this.reserveTaskId(plan.scope.projectId), task: Task = { ...definition({ ...spec, kind: 'task', ...(spec.checklist !== undefined ? { checklist: normalizeChecklist(spec.checklist, []) } : {}) }), id, code: '', rank: 0, projectId: plan.scope.projectId,
        workflowMode: this.mode, state: 'unstarted', revision: 0, dependencies: [], inputs: [], createdAt: now() };
      local.set(key, id); created.set(id, key); candidates.set(id, task);
      return { row, key, id };
    });
    const reference = (value: unknown, label: string): string => {
      const raw = text(value, label), id = raw.startsWith('$') ? local.get(raw.slice(1)) : raw;
      if (!id || !candidates.has(id)) throw new Error(`${label}不存在或批次引用未定义：${raw}`);
      if (!created.has(id) && !plan.ids.has(id)) throw new Error(`${label}超出当前对话的图谱作用域`);
      if (!created.has(id) && this.isArchived(plan.rows.get(id)!)) throw new Error('归档任务不能参与聊天图谱修订');
      return id;
    };
    const parent = (value: unknown, optional = false): string | undefined => {
      if (value === undefined && optional) return plan.scope.taskId;
      if (value === null) return undefined;
      if (value === undefined) throw new Error('移动操作须显式指定 parentId');
      return reference(value, '父任务');
    };
    const refs = (value: unknown): string[] => {
      const values = strings(value), ids = values.map(value => reference(value, '前驱任务'));
      if (new Set(ids).size !== ids.length) throw new Error('依赖重复'); return ids;
    };
    for (const item of createRows) { const task = candidates.get(item.id)!; task.parentId = parent(item.row.parentId, true); task.dependencies = refs(item.row.dependencies); if (task.parentId) containers.add(task.parentId); }
    const definitionFields = ['title', 'goal', 'constraints', 'criteria', 'outputs', 'unresolved', 'checklist'] as const;
    const updateIds: string[] = [], moveIds: string[] = [], dependencyIds: string[] = [];
    const duplicate = (list: string[], id: string, label: string) => { if (list.includes(id)) throw new Error(`同一节点的${label}操作重复`); list.push(id); };
    for (const value of updates) {
      const row = exactFields(value, ['id', 'changes'], '更新任务'), id = reference(row.id, '任务'), patch = exactFields(row.changes, definitionFields, '任务定义变更');
      if (!Object.keys(patch).length) throw new Error('任务定义变更不能为空'); duplicate(updateIds, id, '定义更新');
      planningCriteriaFields(patch.criteria);
      const task = candidates.get(id)!, original = plan.rows.get(id);
      if (original?.state === 'working' && !this.children(id).length && Object.keys(patch).some(key => !['title', 'goal', 'checklist'].includes(key))) throw new Error('执行中叶任务只能修改名称、描述与 Checklist；既有结构化验证定义不能修改');
      if (original && !this.planningCapabilities(plan.scope, original, plan.rows).canUpdateDefinition) throw new Error('已开始执行的叶任务、已完成、冻结或归档节点不能修改定义');
      const next = definition({ ...task, ...patch, ...(patch.checklist !== undefined ? { checklist: normalizeChecklist(patch.checklist, checklistItems(task)) } : {}) });
      if (JSON.stringify(definition(task)) !== JSON.stringify(next)) { candidates.set(id, { ...task, ...next }); changed.add(id); }
    }
    for (const value of moves) {
      const row = exactFields(value, ['id', 'parentId'], '移动任务'), id = reference(row.id, '任务'); duplicate(moveIds, id, '移动');
      const original = plan.rows.get(id);
      if (original && !this.planningCapabilities(plan.scope, original, plan.rows).canMove) throw new Error('移动任务会影响已有执行、输入、快照或复核历史；请创建新的任务分支');
      const task = candidates.get(id)!, nextParent = parent(row.parentId);
      if (task.parentId !== nextParent) { if (task.parentId) containers.add(task.parentId); if (nextParent) containers.add(nextParent); task.parentId = nextParent; changed.add(id); }
    }
    for (const value of dependencies) {
      const row = exactFields(value, ['id', 'dependencies'], '更新依赖'), id = reference(row.id, '任务'); duplicate(dependencyIds, id, '依赖更新');
      if (!Array.isArray(row.dependencies)) throw new Error('dependencies 必须是列表');
      const original = plan.rows.get(id);
      if (original && !this.planningCapabilities(plan.scope, original, plan.rows).canSetDependencies) throw new Error('修改依赖会影响已有执行、输入、快照或复核历史；请创建新的任务分支');
      const task = candidates.get(id)!, next = refs(row.dependencies);
      if (JSON.stringify([...task.dependencies].sort()) !== JSON.stringify([...next].sort())) { task.dependencies = next; changed.add(id); }
    }
    const originalChildren = (id: string) => [...plan.rows.values()].filter(task => task.parentId === id);
    const candidateChildren = (id: string) => [...candidates.values()].filter(task => task.parentId === id);
    const hierarchyValid = (id: string) => {
      const seen = new Set<string>([id]); let parentId = candidates.get(id)!.parentId;
      while (parentId) {
        if (seen.has(parentId)) throw new Error('父任务形成嵌套循环'); seen.add(parentId);
        const ancestor = candidates.get(parentId); if (!ancestor) throw new Error('父任务不存在或跨项目');
        const original = plan.rows.get(parentId), editable = ancestor.state === 'unstarted' || this.mode === 'single-user' && ancestor.state === 'working' && originalChildren(parentId).length > 0;
        if (!editable || ancestor.pending || ancestor.archived || original && this.isArchived(original)) throw new Error('父任务已开始执行叶任务、完成、冻结或归档，不能修订子任务');
        parentId = ancestor.parentId;
      }
    };
    for (const id of new Set([...created.keys(), ...updateIds, ...moveIds, ...dependencyIds])) hierarchyValid(id);
    const assertRelationSafe = (ids: Iterable<string>, label: string) => {
      for (const id of ids) { const original = plan.rows.get(id); if (original && this.planningRelationHistory(original, plan.rows)) throw new Error(`${label}会影响已有执行、输入、快照或复核历史；请使用人工影响确认或创建新的任务分支`); }
    };
    const moved = moveIds.filter(id => plan.rows.has(id) && plan.rows.get(id)!.parentId !== candidates.get(id)!.parentId);
    for (const id of moved) {
      const previous = plan.rows.get(id)!, current = candidates.get(id)!;
      const containers = [previous.parentId, current.parentId].filter((value): value is string => Boolean(value));
      for (const value of [id, ...this.planningContained(plan.rows, id)]) if (this.planningHistory(plan.rows.get(value)!)) throw new Error('移动任务会影响已有执行、输入、快照或复核历史；请使用人工影响确认或创建新的任务分支');
      assertRelationSafe(containers, '移动任务');
      assertRelationSafe(new Set([...this.planningAffected(plan.rows, [id]), ...this.planningAffected(candidates, [id])]), '移动任务');
    }
    const dependencyChanges = dependencyIds.filter(id => plan.rows.has(id) && JSON.stringify([...plan.rows.get(id)!.dependencies].sort()) !== JSON.stringify([...candidates.get(id)!.dependencies].sort()));
    for (const id of dependencyChanges) {
      const affected = new Set([...this.planningAffected(plan.rows, [id, ...this.planningContained(plan.rows, id)]), ...this.planningAffected(candidates, [id, ...this.planningContained(candidates, id)])]);
      assertRelationSafe(affected, '修改依赖');
    }
    const edgesToValidate = new Set([...created.keys(), ...moveIds, ...dependencyIds]);
    for (const id of moveIds) for (const task of candidates.values()) if (task.dependencies.includes(id)) edgesToValidate.add(task.id);
    for (const id of edgesToValidate) {
      const task = candidates.get(id)!, original = plan.rows.get(id);
      for (const predecessorId of task.dependencies) {
        const predecessor = candidates.get(predecessorId); if (!predecessor) throw new Error('前驱不存在或跨项目');
        if (predecessor.pending) throw new Error('冻结操作中的任务不能新增或修改前驱引用');
        if (predecessor.archived || plan.rows.has(predecessorId) && this.isArchived(plan.rows.get(predecessorId)!)) throw new Error('归档任务不能作为前驱');
        if (predecessor.kind === 'group' && !candidateChildren(predecessorId).length) throw new Error('空任务组不能作为执行前驱');
        const unchangedLegacy = original && original.parentId === task.parentId && original.dependencies.includes(predecessorId) && !moveIds.includes(predecessorId);
        if (task.parentId !== predecessor.parentId && !unchangedLegacy) throw new Error('前驱依赖必须连接同层兄弟任务');
        const visited = new Set<string>(), queue = [predecessorId];
        while (queue.length) { const value = queue.pop()!; if (value === id) throw new Error('前驱依赖形成循环'); if (visited.has(value)) continue; visited.add(value); queue.push(...(candidates.get(value)?.dependencies ?? [])); }
      }
    }
    throwIfAborted(signal);
    const hasChanges = created.size > 0 || changed.size > 0;
    if (hasChanges) for (const id of containers) if (plan.rows.has(id) && candidateChildren(id).length) await this.becomingContainer(id);
    if (hasChanges) this.transaction(() => {
      throwIfAborted(signal);
      if (this.project(plan.scope.projectId).revision !== raw.revision) throw new Error('项目图谱已变化，请重新读取规划上下文后重试');
      for (const item of createRows) {
        const candidate = candidates.get(item.id)!, task = this.newTask(plan.scope.projectId, definition(candidate), { id: candidate.id, dependencies: candidate.dependencies });
        candidates.set(task.id, task); this.putTask(task);
      }
      const touched = new Set([...changed, ...containers]);
      for (const id of touched) if (!created.has(id)) { const task = candidates.get(id)!; task.revision++; this.putTask(task); }
      for (const id of new Set([...created.keys(), ...dependencyChanges])) {
        this.db.prepare('DELETE FROM dependencies WHERE target=?').run(id);
        for (const predecessor of candidates.get(id)!.dependencies) this.db.prepare('INSERT INTO dependencies VALUES(?,?)').run(predecessor, id);
      }
      const project = this.project(plan.scope.projectId); project.revision++; this.putProject(project);
      throwIfAborted(signal);
    });
    return { revision: this.project(plan.scope.projectId).revision,
      created: createRows.map(item => ({ key: item.key, ...this.view(item.id) })), updated: updateIds.map(id => this.view(id)), moved: moveIds.map(id => this.view(id)), dependencies: dependencyIds.map(id => this.view(id)), removed: [] };
  }); }
  createTask(projectId: string, input: unknown, signal?: AbortSignal) { return this.serial(async () => {
    throwIfAborted(signal);
    this.project(projectId); if (this.projectDeletionJob(projectId)) throw new Error('项目正在删除或等待删除重试，不能新增任务');
    const raw = object(input), data = definition({ ...raw, ...(raw.checklist !== undefined ? { checklist: normalizeChecklist(raw.checklist, []) } : {}) }); this.validateParent(projectId, data.parentId);
    await this.becomingContainer(data.parentId); throwIfAborted(signal);
    const task = this.transaction(() => { const task = this.newTask(projectId, data); this.putTask(task); this.touchContainer(data.parentId); const project = this.project(projectId); project.revision++; this.putProject(project); return task; }); return this.view(task.id);
  }); }
  private touchContainer(id?: string) { if (id) { const parent = this.task(id); parent.revision++; this.putTask(parent); } }
  createQuickTask(projectId: string, input: unknown) { return this.serial(async () => {
    this.project(projectId); if (this.projectDeletionJob(projectId)) throw new Error('项目正在删除或等待删除重试，不能新增任务');
    const data = object(input), title = text(data.title, '任务名称', false);
    const parentId = data.parentId === undefined ? undefined : text(data.parentId, '父任务'); this.validateParent(projectId, parentId);
    const predecessorId = data.predecessorId === undefined ? undefined : text(data.predecessorId, '前驱任务');
    if (predecessorId) { const predecessor = this.task(predecessorId); if (predecessor.pending) throw new Error('冻结操作中的任务不能新增前驱引用'); if (predecessor.projectId !== projectId || predecessor.parentId !== parentId) throw new Error('前驱必须属于同项目、同层兄弟任务'); }
    await this.becomingContainer(parentId);
    this.db.exec('BEGIN IMMEDIATE'); let task: Task | undefined;
    try {
      task = this.newTask(projectId, { title, kind: 'task', goal: '', constraints: '', criteria: [], checklist: [], outputs: [], unresolved: [], ...(parentId ? { parentId } : {}) }, { state: this.mode === 'single-user' ? 'unstarted' : 'allocated', ...(this.mode === 'reviewed' ? { assignee: 'operator' } : {}), dependencies: predecessorId ? [predecessorId] : [] });
      if (!task.title) task.title = `任务${task.code}`;
      await this.files.allocate(task.id);
      this.putTask(task); if (predecessorId) this.db.prepare('INSERT INTO dependencies VALUES(?,?)').run(predecessorId, task.id);
      this.touchContainer(parentId); const project = this.project(projectId); project.revision++; this.putProject(project);
      this.db.exec('COMMIT'); this.files.reopen(task.id); return this.view(task.id);
    } catch (error) {
      this.db.exec('ROLLBACK');
      // An external task space is retained by vm_manager; only Studio-private storage is rolled back (with Studio's own task spaces).
      if (task) {
        this.files.revoke(task.id); await rm(this.files.localDirectory(task.id), { recursive: true, force: true });
        if (this.fileStorage && !this.vmStorage) await rm(this.taskSpaceDirectory(projectId, task.id), { recursive: true, force: true });
      }
      throw error;
    }
  }); }
  updateTask(id: string, input: unknown) { return this.serial(async () => {
    const raw = object(input), task = this.task(id); this.checkVersion(task, raw.revision);
    const editable = this.mode === 'single-user' ? task.state === 'unstarted' || task.state === 'working' && this.children(id).length > 0 : ['unstarted', 'allocated'].includes(task.state);
    if (!editable || task.pending || this.isArchived(task)) throw new Error('开始工作或冻结操作后任务定义不能修改；返工请使用新节点');
    const next = definition(raw); if (next.kind !== task.kind) throw new Error('节点类型不能改变'); this.validateParent(task.projectId, next.parentId, id);
    if (next.parentId !== task.parentId) {
      // Moving a container changes inherited predecessors for every descendant.
      // Preserve executed input history until an explicit subtree migration exists.
      const historical = this.contained(id).some(childId => {
        const child = this.task(childId);
        return !['unstarted', 'allocated'].includes(child.state) || child.pending || child.candidateId || child.acceptedId || child.completedId || child.inputs.length > 0
          || this.db.prepare('SELECT 1 FROM snapshots WHERE task_id=? UNION ALL SELECT 1 FROM reviews WHERE task_id=? LIMIT 1').get(childId, childId);
      });
      if (historical) throw new Error('子树已有执行或快照历史，不能移动文件夹；请创建新的任务分支');
      const adjacent = this.tasks(task.projectId).filter(row => task.dependencies.includes(row.id) || row.dependencies.includes(id));
      if (adjacent.some(row => row.parentId !== next.parentId)) throw new Error('移动后依赖必须保持同层兄弟关系');
    }
    if (next.parentId !== task.parentId) await this.becomingContainer(next.parentId);
    this.transaction(() => { if (next.parentId !== task.parentId) { this.touchContainer(task.parentId); this.touchContainer(next.parentId); } this.touch({ ...task, ...next, parentId: next.parentId }); });
    if (next.parentId !== task.parentId && task.parentId) await this.refreshFolders([task.parentId]);
    return this.view(id);
  }); }
  private metadataEditable(task: Task): boolean {
    return !task.pending && !this.isArchived(task) && this.hierarchyWritable(task)
      && (this.mode === 'single-user' ? ['unstarted', 'working', 'recheck'].includes(task.state) : ['unstarted', 'allocated'].includes(task.state));
  }
  private metadataChange(task: Task, input: unknown): Task {
    const data = exactFields(input, ['revision', 'title', 'goal', 'checklist'], '任务 Metadata'); this.checkVersion(task, data.revision);
    if (!this.metadataEditable(task)) throw new Error('已完成、冻结或归档任务不能修改 Metadata；请先继续修改或创建新任务');
    return { ...task, title: text(data.title, '任务名称'), goal: text(data.goal, '任务描述与目标', false), checklist: normalizeChecklist(data.checklist, checklistItems(task)) };
  }
  updateTaskMetadata(id: string, input: unknown, signal?: AbortSignal): Promise<TaskView> { return this.serial(async () => {
    throwIfAborted(signal); const next = this.metadataChange(this.task(id), input); throwIfAborted(signal);
    this.transaction(() => this.touch(next)); return this.view(id);
  }); }
  readChecklist(scope: GraphPlanningScope, id: string) {
    const plan = this.planningRows({ ...scope, ...(scope.taskId ? { subtreeOnly: true } : {}) }); if (!plan.ids.has(id)) throw new Error('任务超出当前对话的图谱作用域');
    const task = this.task(id); if (this.isArchived(task)) throw new Error('归档任务不能参与 Checklist 编辑');
    return { taskId: id, title: task.title, revision: task.revision, checklist: checklistItems(task), canEditMetadata: this.metadataEditable(task) };
  }
  updateChecklist(scope: GraphPlanningScope, id: string, input: unknown, signal?: AbortSignal) { return this.serial(async () => {
    throwIfAborted(signal); const checklistScope: GraphPlanningScope = { ...scope, ...(scope.taskId ? { subtreeOnly: true } : {}) }, plan = this.planningRows(checklistScope);
    if (!plan.ids.has(id)) throw new Error('任务超出当前对话的图谱作用域');
    if (plan.scope.taskId) this.assertDiscussionWritable(plan.scope.taskId);
    const data = exactFields(input, ['revision', 'items'], 'Checklist 更新'), task = this.task(id);
    const next = this.metadataChange(task, { revision: data.revision, title: task.title, goal: task.goal, checklist: data.items });
    throwIfAborted(signal); this.transaction(() => this.touch(next)); return this.readChecklist(checklistScope, id);
  }); }
  private descendants(id: string) {
    const found = new Set<string>(), todo = [id];
    while (todo.length) for (const row of this.db.prepare('SELECT target FROM dependencies WHERE source=?').all(todo.pop()!)) if (!found.has(String(row.target))) { found.add(String(row.target)); todo.push(String(row.target)); }
    return [...found];
  }
  private contained(id: string): string[] { return this.children(id).flatMap(child => [child.id, ...this.contained(child.id)]); }
  /** Result invalidity travels to containing folders and to downstream tasks and their contained work. */
  private affectedBy(ids: string[]): string[] {
    const found = new Set<string>(), queue = [...ids], rows = this.tasks();
    while (queue.length) {
      const id = queue.shift()!; if (found.has(id)) continue; found.add(id);
      const task = this.task(id); if (task.parentId) queue.push(task.parentId);
      if (this.mode === 'single-user') { for (const row of rows) if (row.dependencies.includes(id) || row.inputs.some(input => input.taskId === id)) queue.push(row.id, ...this.contained(row.id)); }
      else for (const row of this.db.prepare('SELECT target FROM dependencies WHERE source=?').all(id)) { const target = String(row.target); queue.push(target, ...this.contained(target)); }
    }
    return [...found];
  }
  private invalidate(ids: string[]) {
    this.assertNoDeletion(ids);
    for (const id of ids) {
      const task = this.task(id);
      if (this.mode === 'single-user') {
        if (!this.isArchived(task)) { this.invalidateSingleUser(task); this.touch(task); }
      }
      else if (task.state === 'accepted') { task.state = 'revoked'; this.touch(task); }
      else if (task.state === 'review' && this.children(id).length) { task.state = 'allocated'; delete task.candidateId; this.touch(task); }
    }
  }
  private assertNoDeletion(ids: string[]) {
    const frozen = ids.map(id => this.task(id)).find(task => task.pendingAction === 'delete' || task.pendingAction === 'clear' || task.pendingAction === 'dependencies');
    if (frozen) throw new Error(frozen.pendingAction === 'dependencies' ? '操作影响范围包含未完成的依赖调整，请先重新确认该调整' : frozen.pendingAction === 'clear' ? '操作影响范围包含正在清空的任务，请重新预览并确认清空' : '操作影响范围包含正在永久删除的任务，请先重试完成删除');
  }
  private invalidateSingleUser(task: Task) {
    if (['completed', 'recheck'].includes(task.state)) { task.state = 'recheck'; task.recheckReason = this.completionFolder(task) ? '子任务或前序节点有修正，请手动复核' : '前序节点有修正，请手动复核'; }
    else task.state = 'unstarted';
    delete task.pending; delete task.pendingAction; delete task.pendingOwnerId; delete task.pendingMeasurements; delete task.pendingConfirmation;
  }
  private dependencyJob(projectId: string): DependencyJob | undefined {
    const row = this.db.prepare('SELECT value FROM dependency_jobs WHERE project_id=?').get(projectId);
    return row ? JSON.parse(String(row.value)) : undefined;
  }
  private currentDependencyRequest(request: DependencyChangeRequest): DependencyChangeRequest {
    if (request.kind === 'set') { const task = this.task(request.id); return { ...request, revision: task.revision, projectRevision: this.project(task.projectId).revision }; }
    return { ...request, projectRevision: this.project(request.projectId).revision };
  }
  private dependencyRequestIdentity(request: DependencyChangeRequest): string {
    return JSON.stringify(request.kind === 'set' ? { kind: request.kind, id: request.id, dependencies: [...request.dependencies].sort() }
      : { kind: request.kind, projectId: request.projectId, edge: request.edge, connection: request.connection });
  }
  private relationEditable(task: Task) {
    if (!['unstarted', 'working', 'completed', 'recheck'].includes(task.state) || task.pending || this.isArchived(task)) throw new Error('被冻结或归档的任务不能调整依赖');
    let parentId = task.parentId;
    while (parentId) { const parent = this.task(parentId); if (parent.pending || this.isArchived(parent)) throw new Error('上级任务被冻结或归档，不能调整依赖'); parentId = parent.parentId; }
  }
  private dependencyPlan(request: DependencyChangeRequest, modified: { id: string; dependencies: string[] }[], projectId: string): DependencyPlan {
    const rows = new Map(this.tasks(projectId).map(task => [task.id, task])), candidates = new Map(modified.map(row => [row.id, row.dependencies]));
    for (const row of modified) {
      const task = rows.get(row.id)!; this.relationEditable(task);
      if (row.dependencies.length > 100 || new Set(row.dependencies).size !== row.dependencies.length) throw new Error('任务依赖重复或超过 100 个');
      for (const source of row.dependencies) {
        const predecessor = this.task(source);
        if (predecessor.projectId !== projectId) throw new Error('依赖不能跨项目');
        if (predecessor.pending || this.isArchived(predecessor)) throw new Error('冻结或归档任务不能作为有效前驱');
        if (predecessor.kind === 'group' && !this.children(source).length) throw new Error('空任务组不能作为执行前驱');
        if (predecessor.parentId !== task.parentId && !task.dependencies.includes(source)) throw new Error('前驱依赖必须连接同层兄弟任务');
        const seen = new Set<string>(), queue = [source];
        while (queue.length) {
          const current = queue.pop()!; if (current === task.id) throw new Error('前驱依赖形成循环');
          if (seen.has(current)) continue; seen.add(current);
          queue.push(...(candidates.get(current) ?? rows.get(current)?.dependencies ?? []));
        }
      }
    }
    const changed = modified.filter(row => { const task = rows.get(row.id)!; return task.dependencyRepairRequired || JSON.stringify([...task.dependencies].sort()) !== JSON.stringify([...row.dependencies].sort()); });
    const ids = this.affectedBy(changed.flatMap(row => { const task = rows.get(row.id)!; return [row.id, ...(JSON.stringify([...task.dependencies].sort()) === JSON.stringify([...row.dependencies].sort()) ? [] : this.contained(row.id))]; })).filter(id => !this.isArchived(this.task(id)));
    const summaries = new Set<string>();
    for (const row of changed) { let parentId = rows.get(row.id)!.parentId; while (parentId) { summaries.add(parentId); parentId = rows.get(parentId)?.parentId; } }
    const affected: DependencyChangeImpact[] = ids.map(id => {
      const task = this.task(id);
      if (task.pending) throw new Error('影响范围存在未完成的冻结、恢复或删除操作，请先恢复该操作');
      const willRecheck = ['completed', 'recheck'].includes(task.state), willResetWork = task.state === 'working' && !this.completionFolder(task);
      return { id, code: task.code, title: task.title, state: task.state, reason: summaries.has(id) && !changed.some(row => row.id === id) ? 'summary' : 'dependency', willRecheck, willResetWork,
        description: willRecheck ? '旧结果保留为历史，进入待复核；前序有效完成后请手动复核' : willResetWork ? '停止当前写入并回到待执行，现有工作文件保留；后续重新绑定前序输入' : this.completionFolder(task) && task.state === 'working' ? '任务组更新汇总依据，进度仍由子任务推导；现有文件保留' : '现有文件保留，后续须使用调整后的前序输入' };
    });
    return { projectId, ownerId: changed[0]?.id ?? (request.kind === 'set' ? request.id : modified[0]?.id ?? ''), request, modified: changed, affected, retry: false, requiresConfirmation: affected.some(row => this.planningHistory(this.task(row.id))) };
  }
  private retryDependencyPlan(request: DependencyChangeRequest, projectId: string): DependencyPlan | undefined {
    const job = this.dependencyJob(projectId); if (!job) return;
    if (this.dependencyRequestIdentity(request) !== this.dependencyRequestIdentity(job.request)) throw new Error('项目有未完成的依赖调整，请在发起任务中重新预览并确认原调整');
    for (const impact of job.affected) { const task = this.task(impact.id); if (task.pendingAction !== 'dependencies' || task.pendingOwnerId !== job.ownerId) throw new Error('依赖调整冻结记录已变化，请检查恢复状态'); }
    return { ...job, request: this.currentDependencyRequest(job.request), retry: true, requiresConfirmation: true };
  }
  private setDependencyPlan(id: string, input: unknown): DependencyPlan {
    const data = exactFields(input, ['id', 'revision', 'dependencies', 'projectRevision', 'confirmImpact', 'impactVersion'], '依赖修订'), task = this.task(id);
    if (data.id !== undefined && data.id !== id) throw new Error('依赖任务标识不一致'); this.checkVersion(task, data.revision);
    const project = this.project(task.projectId);
    if (data.projectRevision !== undefined && data.projectRevision !== project.revision) throw new Error('项目图谱已变化，请重新预览依赖影响');
    const request: DependencyChangeRequest = { kind: 'set', id, revision: task.revision, projectRevision: project.revision, dependencies: strings(data.dependencies) };
    return this.retryDependencyPlan(request, task.projectId) ?? this.dependencyPlan(request, [{ id, dependencies: request.dependencies }], task.projectId);
  }
  private reconnectDependencyPlan(input: unknown): DependencyPlan {
    const data = exactFields(input, ['projectId', 'projectRevision', 'edge', 'connection', 'confirmImpact', 'impactVersion'], '连线修订');
    const projectId = text(data.projectId, '项目'), project = this.project(projectId);
    if (data.projectRevision !== project.revision) throw new Error('项目图谱已变化，请重新预览依赖影响');
    const endpoint = (value: unknown) => { const row = exactFields(value, ['source', 'target'], '连线端点'); return { source: text(row.source, '连线起点'), target: text(row.target, '连线终点') }; };
    const request: DependencyChangeRequest = { kind: 'reconnect', projectId, projectRevision: project.revision, edge: endpoint(data.edge), connection: endpoint(data.connection) };
    const retry = this.retryDependencyPlan(request, projectId); if (retry) return retry;
    const { edge, connection } = request, rows = this.tasks(projectId), tasks = new Map(rows.map(task => [task.id, task])), anchor = tasks.get(edge.target) ?? tasks.get(edge.source);
    if (!anchor) throw new Error('原连线不存在或跨项目；开始到结束连线不能重新连接');
    const start = `graph-start:${projectId}:${anchor.parentId ?? 'root'}`, end = `graph-end:${projectId}:${anchor.parentId ?? 'root'}`;
    const real = (id: string, virtual: string): Task | undefined => {
      if (id === virtual) return;
      const task = tasks.get(id); if (!task) throw new Error('连线任务不存在或跨项目');
      if (task.parentId !== anchor.parentId) throw new Error('前驱依赖必须连接同层兄弟任务');
      if (this.isArchived(task) || task.pending) throw new Error('冻结或归档任务不能作为连线节点');
      return task;
    };
    const source = real(edge.source, start), target = real(edge.target, end), nextSource = real(connection.source, start), nextTarget = real(connection.target, end);
    if (!source && !target || !nextSource && !nextTarget) throw new Error('开始到结束的虚拟连线不能重新连接');
    if (!source) { if (!target || target.dependencies.length) throw new Error('原开始连线已变化，请刷新后重试'); if (connection.target !== edge.target) throw new Error('开始连线只允许重新连接起点'); }
    else if (!target) { if (rows.some(task => task.parentId === anchor.parentId && !this.isArchived(task) && task.dependencies.includes(source.id))) throw new Error('原结束连线已变化，请刷新后重试'); if (connection.source !== edge.source) throw new Error('结束连线只允许重新连接终点'); }
    else if (!target.dependencies.includes(source.id)) throw new Error('原连线已变化，请刷新后重试');
    const modified = new Map<string, { id: string; dependencies: string[] }>();
    const candidate = (task: Task) => { let row = modified.get(task.id); if (!row) { row = { id: task.id, dependencies: [...task.dependencies] }; modified.set(task.id, row); } return row; };
    if (edge.source !== connection.source || edge.target !== connection.target) {
      if (source && target) candidate(target).dependencies = target.dependencies.filter(id => id !== source.id);
      if (nextSource && nextTarget) { const row = candidate(nextTarget); if (row.dependencies.includes(nextSource.id)) throw new Error('依赖重复，不能连接到已有连线'); row.dependencies.push(nextSource.id); }
    }
    return this.dependencyPlan(request, [...modified.values()], projectId);
  }
  private dependencyImpactVersion(plan: DependencyPlan): string {
    const ids = new Set<string>(), queue = [...plan.affected.map(row => row.id), ...plan.modified.flatMap(row => row.dependencies)];
    while (queue.length) {
      const id = queue.shift()!; if (ids.has(id)) continue; ids.add(id);
      const task = this.task(id); queue.push(...this.predecessorIds(task), ...this.activeChildren(id).map(child => child.id)); if (task.parentId) queue.push(task.parentId);
    }
    const rows = this.tasks(plan.projectId).filter(task => ids.has(task.id)), snapshots = new Map<string, Snapshot | { missing: string }>(), snapshotQueue = rows.flatMap(task => [...task.inputs.map(ref => ref.snapshotId), ...[task.completedId, task.candidateId, task.acceptedId].filter((id): id is string => !!id)]);
    while (snapshotQueue.length) { const id = snapshotQueue.shift()!; if (snapshots.has(id)) continue; try { const snapshot = this.snapshot(id); snapshots.set(id, snapshot); snapshotQueue.push(...snapshot.inputs.map(ref => ref.snapshotId), ...(snapshot.childrenRefs ?? []).map(ref => ref.snapshotId)); } catch { snapshots.set(id, { missing: id }); } }
    return createHash('sha256').update(JSON.stringify({ request: this.currentDependencyRequest(plan.request), project: this.project(plan.projectId), tasks: rows, snapshots: [...snapshots.values()], modified: plan.modified, affected: plan.affected })).digest('hex');
  }
  private dependencyPreview(plan: DependencyPlan): DependencyChangePreview { return { request: this.currentDependencyRequest(plan.request), projectId: plan.projectId, projectRevision: this.project(plan.projectId).revision, impactVersion: this.dependencyImpactVersion(plan), requiresConfirmation: plan.requiresConfirmation, affected: plan.affected, retry: plan.retry }; }
  setDependenciesPreview(id: string, input: unknown): Promise<DependencyChangePreview> { return this.serial(async () => { if (this.mode !== 'single-user') throw new Error('依赖影响确认仅用于单用户流程'); return this.dependencyPreview(this.setDependencyPlan(id, input)); }); }
  reconnectDependenciesPreview(input: unknown): Promise<DependencyChangePreview> { return this.serial(async () => { if (this.mode !== 'single-user') throw new Error('依赖影响确认仅用于单用户流程'); return this.dependencyPreview(this.reconnectDependencyPlan(input)); }); }
  private async commitDependencyPlan(plan: DependencyPlan, input: unknown) {
    const data = object(input), version = this.dependencyImpactVersion(plan);
    if (plan.requiresConfirmation && (data.confirmImpact !== true || data.impactVersion !== version || data.projectRevision !== this.project(plan.projectId).revision)) throw new Error('依赖调整会影响已有工作或历史结果，请重新预览传导影响并二次确认');
    if (!plan.modified.length) return;
    if (!plan.retry) this.transaction(() => {
      const job: DependencyJob = { projectId: plan.projectId, ownerId: plan.ownerId, request: plan.request, modified: plan.modified, affected: plan.affected };
      this.db.prepare('INSERT INTO dependency_jobs VALUES(?,?)').run(plan.projectId, JSON.stringify(job));
      for (const impact of plan.affected) { const task = this.task(impact.id); task.pending = '正在停止受影响任务写入并调整依赖；失败时保持冻结，请在发起任务重新预览并确认'; task.pendingAction = 'dependencies'; task.pendingOwnerId = plan.ownerId; delete task.pendingMeasurements; delete task.pendingConfirmation; this.touch(task); }
    });
    const frozenVersion = this.dependencyImpactVersion(plan), ids = plan.affected.map(row => row.id);
    for (const id of ids) { this.files.register(id); this.files.revoke(id); }
    await this.quiesce(ids); await this.files.drain();
    if (this.dependencyImpactVersion(plan) !== frozenVersion) throw new Error('依赖影响范围在停止写入期间发生变化，请重新预览并确认');
    this.transaction(() => {
      for (const row of plan.modified) { const task = this.task(row.id); this.db.prepare('DELETE FROM dependencies WHERE target=?').run(row.id); for (const source of row.dependencies) this.db.prepare('INSERT INTO dependencies VALUES(?,?)').run(source, row.id); task.dependencies = row.dependencies; delete task.dependencyRepairRequired; this.putTask(task); }
      for (const impact of plan.affected) { const task = this.task(impact.id); if (task.pendingAction !== 'dependencies' || task.pendingOwnerId !== plan.ownerId) throw new Error('依赖调整冻结记录已变化'); this.invalidateSingleUser(task); this.touch(task); }
      this.db.prepare('DELETE FROM dependency_jobs WHERE project_id=?').run(plan.projectId);
    });
    for (const id of ids) if (this.discussionAllowed(this.task(id))) this.files.reopen(id);
    await this.refreshFolders(ids);
  }
  setDependencies(id: string, input: unknown) {
    if (this.mode === 'reviewed') return this.setDependenciesReviewed(id, input);
    return this.serial(async () => { await this.commitDependencyPlan(this.setDependencyPlan(id, input), input); return this.view(id); });
  }
  reconnectDependencies(input: unknown) {
    if (this.mode === 'reviewed') return this.reconnectDependenciesReviewed(input);
    return this.serial(async () => { const plan = this.reconnectDependencyPlan(input); await this.commitDependencyPlan(plan, input); return this.graph(plan.projectId); });
  }
  private setDependenciesReviewed(id: string, input: unknown) { return this.serial(async () => {
    const data = object(input), task = this.task(id); this.checkVersion(task, data.revision);
    if ((this.mode === 'single-user' ? task.state !== 'unstarted' : ['working', 'review', 'discarded'].includes(task.state)) || task.pending || this.isArchived(task)) throw new Error('此阶段不能修改依赖；工作中的实际输入须保留');
    const dependencies = strings(data.dependencies); if (new Set(dependencies).size !== dependencies.length) throw new Error('依赖重复');
    const unchanged = JSON.stringify([...dependencies].sort()) === JSON.stringify([...task.dependencies].sort());
    if (unchanged && !task.dependencyRepairRequired) return this.view(id);
    for (const source of dependencies) {
      const predecessor = this.task(source);
      if (predecessor.pending) throw new Error('冻结操作中的任务不能修改前驱引用');
      if (predecessor.kind === 'group' && !this.children(source).length) throw new Error('空任务组不能作为执行前驱');
      if (this.isArchived(predecessor)) throw new Error('归档任务不能作为有效前驱');
      if (predecessor.projectId !== task.projectId || source === id || this.descendants(id).includes(source)) throw new Error('依赖跨项目或形成循环');
      if (predecessor.parentId !== task.parentId && !task.dependencies.includes(source)) throw new Error('前驱依赖必须连接同层兄弟任务');
    }
    // Confirming removal of a fixed child does not alter surviving children's
    // inputs. Only an actual predecessor change invalidates contained work.
    const affected = this.affectedBy([id, ...(unchanged ? [] : this.contained(id))]);
    this.assertNoDeletion(affected);
    this.transaction(() => {
      this.db.prepare('DELETE FROM dependencies WHERE target=?').run(id);
      for (const source of dependencies) this.db.prepare('INSERT INTO dependencies VALUES(?,?)').run(source, id);
      task.dependencies = dependencies; delete task.dependencyRepairRequired; this.touch(task); this.invalidate(affected);
    });
    await this.pauseInvalid(affected); await this.refreshFolders(affected); return this.view(id);
  }); }
  /** Reconnect a displayed arrow as one transaction, including changes to both targets. */
  private reconnectDependenciesReviewed(input: unknown) { return this.serial(async () => {
    const data = exactFields(input, ['projectId', 'projectRevision', 'edge', 'connection'], '连线修订');
    const projectId = text(data.projectId, '项目'), project = this.project(projectId);
    if (data.projectRevision !== project.revision) throw new Error('项目图谱已变化，请刷新后重试');
    const endpoints = (value: unknown, label: string) => {
      const row = exactFields(value, ['source', 'target'], label);
      return { source: text(row.source, '连线起点'), target: text(row.target, '连线终点') };
    };
    const edge = endpoints(data.edge, '原连线'), connection = endpoints(data.connection, '新连线');
    const rows = this.tasks(projectId), tasks = new Map(rows.map(task => [task.id, task]));
    const originalSource = tasks.get(edge.source), originalTarget = tasks.get(edge.target);
    const anchor = originalTarget ?? originalSource;
    if (!anchor) throw new Error('空图谱的开始到结束连线不能重新连接；原连线不存在或跨项目');
    const start = `graph-start:${projectId}:${anchor.parentId ?? 'root'}`, end = `graph-end:${projectId}:${anchor.parentId ?? 'root'}`;
    const real = (id: string, virtualId: string): Task | undefined => {
      if (id === virtualId) return;
      const task = tasks.get(id);
      if (!task) throw new Error('连线任务不存在或跨项目');
      if (task.parentId !== anchor.parentId) throw new Error('前驱依赖必须连接同层兄弟任务');
      if (this.isArchived(task)) throw new Error('归档任务不能作为有效连线节点');
      if (task.pending) throw new Error('冻结操作中的任务不能修改前驱引用');
      return task;
    };
    const source = real(edge.source, start), target = real(edge.target, end);
    const nextSource = real(connection.source, start), nextTarget = real(connection.target, end);
    if (!source && !target || !nextSource && !nextTarget) throw new Error('开始到结束的虚拟连线不能重新连接');
    if (!source) {
      if (!target || target.dependencies.length) throw new Error('原开始连线已变化，请刷新后重试');
      if (connection.target !== edge.target) throw new Error('开始连线只允许重新连接起点');
    } else if (!target) {
      if (rows.some(task => task.parentId === anchor.parentId && !this.isArchived(task) && task.dependencies.includes(source.id))) throw new Error('原结束连线已变化，请刷新后重试');
      if (connection.source !== edge.source) throw new Error('结束连线只允许重新连接终点');
    } else if (!target.dependencies.includes(source.id)) throw new Error('原连线已变化，请刷新后重试');
    // Dragging back to the same endpoint is not a dependency repair confirmation.
    if (edge.source === connection.source && edge.target === connection.target) return this.graph(projectId);
    const modified = new Map<string, Task>();
    const candidate = (task: Task) => {
      let row = modified.get(task.id);
      if (!row) { row = { ...task, dependencies: [...task.dependencies] }; modified.set(task.id, row); }
      return row;
    };
    if (source && target) candidate(target).dependencies = target.dependencies.filter(id => id !== source.id);
    if (nextSource && nextTarget) {
      const row = candidate(nextTarget);
      if (row.dependencies.includes(nextSource.id)) throw new Error('依赖重复，不能连接到已有连线');
      row.dependencies.push(nextSource.id);
    }
    for (const task of modified.values()) {
      if ((this.mode === 'single-user' ? task.state !== 'unstarted' : ['working', 'review', 'discarded'].includes(task.state)) || task.pending || this.isArchived(task) || !this.hierarchyWritable(task)) throw new Error('此阶段不能修改依赖；工作中的实际输入须保留');
      if (task.dependencies.length > 100) throw new Error('任务依赖不能超过 100 个');
      for (const id of task.dependencies) {
        const predecessor = real(id, start);
        if (!predecessor) throw new Error('虚拟开始节点不能保存为任务依赖');
        if (predecessor.kind === 'group' && !this.children(id).length) throw new Error('空任务组不能作为执行前驱');
        // Traverse the final candidate graph rather than validating the new edge
        // against the old graph: removing its previous endpoint can break a path.
        const seen = new Set<string>(), queue = [id];
        while (queue.length) {
          const current = queue.pop()!;
          if (current === task.id) throw new Error('前驱依赖形成循环');
          if (seen.has(current)) continue; seen.add(current);
          queue.push(...(modified.get(current) ?? tasks.get(current))?.dependencies ?? []);
        }
      }
    }
    const affected = this.affectedBy([...modified.keys()].flatMap(id => [id, ...this.contained(id)]));
    this.assertNoDeletion(affected);
    this.transaction(() => {
      for (const task of modified.values()) {
        this.db.prepare('DELETE FROM dependencies WHERE target=?').run(task.id);
        for (const id of task.dependencies) this.db.prepare('INSERT INTO dependencies VALUES(?,?)').run(id, task.id);
        delete task.dependencyRepairRequired; this.touch(task);
      }
      this.invalidate(affected);
    });
    await this.pauseInvalid(affected); await this.refreshFolders(affected);
    return this.graph(projectId);
  }); }
  private async pauseInvalid(ids: string[]) {
    if (this.mode === 'single-user') {
      for (const id of ids) { this.files.register(id); this.files.revoke(id); }
      if (ids.length) await this.quiesce(ids);
      for (const id of ids) { const task = this.task(id); if (this.discussionAllowed(task)) this.files.reopen(id); }
      return;
    }
    const invalid = ids.filter(id => { const task = this.task(id); return task.state !== 'unstarted' && (task.pending || !['allocated', 'working'].includes(task.state) || task.state === 'working' && this.blockers(task).length > 0); });
    for (const id of invalid) this.files.revoke(id);
    if (invalid.length) await this.quiesce(invalid);
    for (const id of ids) { const task = this.task(id); if (['allocated', 'working'].includes(task.state) && !task.pending && (task.state === 'allocated' || !this.blockers(task).length)) this.files.reopen(id); }
  }
  private async start(task: Task) {
    this.leaf(task);
    this.assertHierarchyWritable(task);
    if (task.state === 'working') { this.assertWorking(task.id); return; }
    if (task.pending || this.isArchived(task)) throw new Error('任务已冻结或归档，不能开始工作');
    if (task.state !== (this.mode === 'single-user' ? 'unstarted' : 'allocated')) throw new Error(this.mode === 'single-user' ? '只有未执行任务可以开始' : '请先领取任务，再开始工作');
    const issues = definitionIssues(task, this.mode); if (issues.length) throw new Error(issues.join('；'));
    if (this.mode === 'single-user') await this.files.allocate(task.id);
    task.inputs = this.inputs(task); task.state = 'working';
    this.transaction(() => this.touch(task)); this.files.reopen(task.id);
    if (this.mode === 'single-user') await this.refreshFolders([task.id]);
  }
  work<T>(id: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> { return this.serial(async () => {
    throwIfAborted(signal);
    if (this.mode === 'single-user') {
      const task = this.task(id); this.leaf(task); this.assertHierarchyWritable(task);
      if (['unstarted', 'recheck'].includes(task.state) && !task.pending) {
        // A deliberate new write binds the current upstream version as legacy
        // start did, but the simplified workflow remains waiting for completion.
        let inputs: InputRef[]; try { inputs = this.inputs(task); } catch (error) { throw new Error(`任务不可编辑：${error instanceof Error ? error.message : String(error)}`); }
        await this.files.allocate(id);
        if (JSON.stringify(inputs) !== JSON.stringify(task.inputs)) { task.inputs = inputs; this.transaction(() => this.touch(task)); }
        this.files.reopen(id);
      }
      this.assertWorking(id);
    } else await this.start(this.task(id));
    return operation();
  }); }
  /** Managed workspace CRUD is available to active folders without granting leaf execution. */
  workspace<T>(id: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const task = this.task(id);
    return this.children(task.id).length ? this.discussion(id, async () => { throwIfAborted(signal); this.assertWorkspaceWritable(id); return operation(); }) : this.work(id, operation, signal);
  }
  /** Planning and private scratch writes do not start engineering work or require complete criteria. */
  discussion<T>(id: string, operation: () => Promise<T>): Promise<T> { return this.serial(async () => {
    const task = this.task(id);
    this.assertHierarchyWritable(task);
    if (task.pending) throw new Error('任务讨论不可写：冻结操作尚未完成');
    if (task.state === 'unstarted' || this.mode === 'single-user' && task.state === 'recheck') { await this.files.allocate(id); if (this.mode === 'reviewed') { task.state = 'allocated'; task.assignee = 'operator'; this.transaction(() => this.touch(task)); } }
    if (this.mode === 'single-user' && ['unstarted', 'recheck'].includes(task.state) && task.kind === 'task' && !this.children(id).length && !this.repairAffected(task)) {
      // Planning remains possible for blocked drafts. When upstream results are
      // available, a new conversation explicitly prepares current input refs
      // before the model's context and file tools receive their capabilities.
      let inputs: InputRef[] | undefined; try { inputs = this.inputs(task); } catch { /* Draft discussions may await their predecessors. */ }
      if (inputs && JSON.stringify(inputs) !== JSON.stringify(task.inputs)) { task.inputs = inputs; this.transaction(() => this.touch(task)); }
    }
    this.assertDiscussionWritable(id); this.files.reopen(id); return operation();
  }); }
  private saveReview(task: Task, action: Review['action'], reason: string) {
    const review: Review = { id: `r-${randomUUID()}`, taskId: task.id, snapshotId: task.candidateId ?? task.acceptedId!, action, reason, actor: 'operator', inputs: ['reject', 'discard'].includes(action) ? task.inputs : this.inputs(task), createdAt: now() };
    this.db.prepare('INSERT INTO reviews VALUES(?,?,?)').run(review.id, task.id, JSON.stringify(review));
  }
  /** Every snapshot of a task, with the directory holding its files, for the project export. */
  taskSnapshots(taskId: string): { snapshot: Snapshot; directory: string }[] {
    this.task(taskId);
    return this.db.prepare('SELECT value FROM snapshots WHERE task_id=? ORDER BY rowid').all(taskId).map(row => {
      const snapshot = JSON.parse(String(row.value)) as Snapshot; return { snapshot, directory: join(this.root, 'snapshots', snapshot.id, 'files') };
    });
  }
  snapshot(id: string): Snapshot { const row = this.db.prepare('SELECT value FROM snapshots WHERE id=?').get(id); if (!row) throw new Error('快照不存在'); return JSON.parse(String(row.value)); }
  snapshotView(taskId: string, snapshotId?: string) { const task = this.task(taskId), snapshot = this.snapshot(snapshotId ?? taskSnapshotId(task, this.mode) ?? ''); if (snapshot.taskId !== task.id) throw new Error('快照不属于任务'); return { snapshot, reviews: this.reviews(task.id), unavailableRefs: this.unavailableSnapshotRefs(snapshot) }; }
  private unavailableSnapshotRefs(snapshot: Snapshot, seen = new Set<string>()): InputRef[] {
    if (seen.has(snapshot.id)) return []; seen.add(snapshot.id);
    const unavailable: InputRef[] = [];
    for (const ref of [...snapshot.inputs, ...(snapshot.childrenRefs ?? [])]) {
      try { this.task(ref.taskId); const related = this.snapshot(ref.snapshotId); if (related.taskId !== ref.taskId) throw new Error(); unavailable.push(...this.unavailableSnapshotRefs(related, seen)); }
      catch { unavailable.push(ref); }
    }
    return [...new Map(unavailable.map(ref => [`${ref.taskId}/${ref.snapshotId}`, ref])).values()];
  }
  /** Appends one event to the activity log; the log never fails the change it describes. */
  recordActivity(input: ActivityInput): void {
    try {
      if (!this.db) return;
      const atMs = input.atMs ?? Date.now(), ids = { ...input };
      if (!ids.projectId && ids.taskId) try { ids.projectId = this.task(ids.taskId).projectId; } catch { /* a task deleted by this very request */ }
      if (!ids.projectId && ids.chatId && this.chatProjects) try { ids.projectId = this.chatProjects(ids.chatId); } catch { /* unknown conversation */ }
      const { atMs: _ignored, ...event } = ids;
      this.db.prepare('INSERT INTO activity_events(at, project_id, task_id, value) VALUES(?,?,?,?)')
        .run(atMs, event.projectId ?? null, event.taskId ?? null, JSON.stringify({ at: new Date(atMs).toISOString(), atMs, ...event }));
    } catch { /* Logging must never turn a completed change into a failure. */ }
  }
  /** Every logged event of a project, oldest first. */
  activities(projectId: string): ActivityEvent[] {
    return this.db.prepare('SELECT seq, value FROM activity_events WHERE project_id=? ORDER BY seq').all(projectId).map(row => ({ seq: Number(row.seq), ...JSON.parse(String(row.value)) }));
  }
  /** Conversations belong to the Studio runtime; it tells the log which project a conversation is in. */
  chatProjects?: (chatId: string) => string | undefined;
  /** Runs one Studio page request and logs it when it changes state, with the task's or project's state before and
   * after. Reads and previews are not logged. */
  async webAction<T>(request: Request, run: () => Promise<T>): Promise<T> {
    const url = new URL(request.url);
    if (!isStateChanging(request.method, url.pathname)) return run();
    const started = Date.now(), query: Record<string, unknown> = Object.fromEntries(url.searchParams);
    let body: Record<string, unknown> = {};
    if ((request.headers.get('content-type') ?? '').includes('json') && Number(request.headers.get('content-length') ?? 0) <= 4 * 1024 * 1024) {
      try { const value = await request.clone().json(); if (value && typeof value === 'object' && !Array.isArray(value)) body = value; } catch { /* the route reports the bad body */ }
    }
    const values = { ...query, ...body }, ids = activityIds(url.pathname, values), state = () => this.activityState(ids);
    const event = { actor: 'human' as const, source: 'web' as const, action: routeAction(url.pathname, values), ...ids, request: summarize(values), before: state() };
    try {
      const result = await run();
      const created = result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : {};
      if (!event.chatId && url.pathname === '/api/studio/chat' && typeof created.id === 'string') event.chatId = created.id;
      if (!event.taskId && typeof created.id === 'string' && url.pathname.startsWith('/api/studio/task') && created.projectId) event.taskId = created.id;
      if (!event.projectId && typeof created.id === 'string' && url.pathname === '/api/studio/projects') event.projectId = created.id;
      this.recordActivity({ ...event, ok: true, durationMs: Date.now() - started, after: this.activityState(event), result: summarize(result) });
      return result;
    } catch (error) {
      this.recordActivity({ ...event, ok: false, error: error instanceof Error ? error.message.slice(0, 500) : String(error), durationMs: Date.now() - started });
      throw error;
    }
  }
  /** The small state summary a logged change is compared with. */
  private activityState(ids: { projectId?: string; taskId?: string }): unknown {
    try {
      if (ids.taskId) { const task = this.task(ids.taskId); return { title: task.title, state: task.state, revision: task.revision, ...(task.pending ? { pending: task.pending, pendingAction: task.pendingAction } : {}) }; }
      if (ids.projectId) { const project = this.project(ids.projectId); return { title: project.title, revision: project.revision }; }
    } catch { /* not created yet, or just deleted */ }
    return undefined;
  }
  reviews(id: string): Review[] { this.task(id); return this.db.prepare('SELECT value FROM reviews WHERE task_id=? ORDER BY rowid').all(id).map(row => JSON.parse(String(row.value))); }
  private completionGoals(task: Task): CompletionGoal[] {
    return [{ id: 'goal', label: task.goal.trim() || task.title }, ...checklistItems(task).map(item => ({ id: task.checklist === undefined ? `criterion:${item.id.slice(7)}` : `checklist:${item.id}`, label: item.text }))];
  }
  private workspaceVersion(files: SnapshotFile[]): string { return createHash('sha256').update(JSON.stringify([...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0))).digest('hex'); }
  private describeWorkspaceFile(task: Task, file: SnapshotFile, generate = true): FileSubmissionDescription {
    const epoch = task.dataGeneration ?? 0, row = this.db.prepare('SELECT value,version,data_generation FROM file_descriptions WHERE task_id=? AND path=?').get(task.id, file.path);
    if (row?.version === file.version && row.data_generation === epoch) {
      try {
        const value = JSON.parse(String(row.value)) as FileSubmissionDescription;
        if (value.version === file.version && typeof value.text === 'string' && !!value.text.trim() && Array.from(value.text).length <= 30 && ['pending', 'generated', 'fallback'].includes(value.status)) {
          if (generate && value.status === 'pending' && !task.pending && !this.isArchived(task)) this.fileDescriptions.enqueue({ taskId: task.id, path: file.path, version: file.version, title: task.title, goal: task.goal }, epoch);
          return value;
        }
      } catch { /* Reconcile malformed metadata from truthful file-name facts. */ }
    }
    const canGenerate = generate && !task.pending && !this.isArchived(task), value: FileSubmissionDescription = { text: fallbackFileDescription(file.path), version: file.version, status: canGenerate ? 'pending' : 'fallback' };
    this.db.prepare('INSERT INTO file_descriptions VALUES(?,?,?,?,?) ON CONFLICT(task_id,path) DO UPDATE SET version=excluded.version,data_generation=excluded.data_generation,value=excluded.value').run(task.id, file.path, file.version, epoch, JSON.stringify(value));
    if (canGenerate) this.fileDescriptions.enqueue({ taskId: task.id, path: file.path, version: file.version, title: task.title, goal: task.goal }, epoch);
    return value;
  }
  /** Background reconciliation covers non-tool producers without touching task revisions or history. */
  refreshFileDescriptions(id: string, changedPath?: string): Promise<void> { return this.serial(async () => {
    const task = this.task(id); if (task.pendingAction === 'clear' || task.pendingAction === 'delete') return;
    const files = await this.completionManifest(task), paths = new Set(files.map(file => file.path));
    for (const file of files) this.describeWorkspaceFile(task, file, changedPath === undefined || file.path === changedPath || file.path.startsWith(`${changedPath}/`));
    for (const row of this.db.prepare('SELECT path FROM file_descriptions WHERE task_id=?').all(id)) if (!paths.has(String(row.path))) this.db.prepare('DELETE FROM file_descriptions WHERE task_id=? AND path=?').run(id, String(row.path));
  }); }
  /** Hash the exact current deliverable manifest without reading private chat storage. */
  private async completionManifest(task: Task): Promise<SnapshotFile[]> {
    this.files.register(task.id);
    const directory = this.files.directory(task.id), files: SnapshotFile[] = []; let total = 0, visited = 0;
    const visit = async (relative: string, depth = 0): Promise<void> => {
      if (depth > 100) throw new Error('工作区文件夹层级超过预览限制');
      const current = join(directory, relative), info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(current) !== current) throw new Error('完成预览拒绝符号链接或非法目录');
      for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        if (!relative && entry.name.toLowerCase() === '.chat-tmp') continue;
        if (++visited > 10000) throw new Error('工作区文件夹数量超过预览限制');
        const path = relative ? `${relative}/${entry.name}` : entry.name; fileName(path);
        if (entry.isSymbolicLink()) throw new Error('完成预览拒绝符号链接');
        if (entry.isDirectory()) await visit(path, depth + 1);
        else {
          if (!entry.isFile() || files.length >= 1000) throw new Error('完成预览文件类型或数量不受支持');
          const handle = await open(join(directory, path), constants.O_RDONLY | constants.O_NOFOLLOW);
          const hash = createHash('sha256'); let bytes = 0, createdAt = '', modifiedAt = '';
          try {
            const info = await handle.stat(); createdAt = new Date(info.birthtimeMs > 0 ? info.birthtimeMs : info.mtimeMs).toISOString(); modifiedAt = info.mtime.toISOString(); if (!info.isFile() || info.size + total > 100 * 1024 * 1024) throw new Error('完成预览超过 100 MiB');
            const buffer = Buffer.alloc(65536);
            while (true) { const part = await handle.read(buffer, 0, buffer.length, null); if (!part.bytesRead) break; bytes += part.bytesRead; total += part.bytesRead; if (total > 100 * 1024 * 1024) throw new Error('完成预览超过 100 MiB'); hash.update(buffer.subarray(0, part.bytesRead)); }
          } finally { await handle.close(); }
          files.push({ path, bytes, version: hash.digest('hex'), createdAt, modifiedAt });
        }
      }
    };
    try { await visit(''); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; if (files.length || await lstat(directory).then(() => true, () => false)) throw new Error('工作区文件已变化，请刷新完成预览'); }
    return files;
  }
  private completionBlockers(task: Task): string[] {
    const blockers = this.blockers(task);
    if (this.completionFolder(task)) {
      const children = this.activeChildren(task.id);
      if (!children.length) blockers.push('任务组至少需要一个有效直属子任务才能完成');
      else if (children.some(child => !this.resultId(child) || this.blockers(child).length)) blockers.push('所有直属子任务和子任务组须已有效完成，请先逐层完成子任务');
    }
    if (!this.hierarchyWritable(task)) blockers.push('上级任务已冻结或归档，不能完成本任务');
    if (this.isArchived(task)) blockers.push('归档任务不能完成');
    if (!['unstarted', 'working', 'recheck'].includes(task.state)) blockers.push('任务已完成或不在可完成状态');
    if (task.pending && (task.pendingAction && task.pendingAction !== 'complete' || task.pendingOwnerId && task.pendingOwnerId !== task.id)) blockers.push('请先恢复正在进行的冻结、继续修改或删除操作');
    return [...new Set(blockers)];
  }
  private completionFolder(task: Task): boolean { return task.kind === 'group' || this.children(task.id).length > 0; }
  private completionChildren(task: Task) {
    return this.activeChildren(task.id).map(child => {
      const snapshotId = this.resultId(child);
      return { taskId: child.id, code: child.code, title: child.title, state: child.state, isFolder: this.completionFolder(child), ready: !!snapshotId && !this.blockers(child).length, ...(snapshotId ? { snapshotId } : {}) };
    });
  }
  private completionChildrenVersion(task: Task): string {
    return createHash('sha256').update(JSON.stringify(this.activeChildren(task.id).map(child => ({ id: child.id, revision: child.revision, state: child.state, snapshotId: this.resultId(child), blockers: this.blockers(child) })))).digest('hex');
  }
  private async verifyCompletionChildren(task: Task, version: string, refs: InputRef[]) {
    if (this.completionChildrenVersion(task) !== version || JSON.stringify(this.folderRefs(task)) !== JSON.stringify(refs)) throw new Error('直属子任务版本已变化，请刷新预览并重新确认全部目标');
    for (const ref of refs) {
      const snapshot = this.snapshot(ref.snapshotId);
      if (snapshot.taskId !== ref.taskId) throw new Error('子任务快照归属不正确');
      await this.verifySnapshot(snapshot);
    }
    if (this.completionChildrenVersion(task) !== version || JSON.stringify(this.folderRefs(task)) !== JSON.stringify(refs)) throw new Error('直属子任务版本在冻结时发生变化，请刷新预览并重新确认全部目标');
  }
  private async submissionState(task: Task): Promise<{ submittedFiles?: CompletionFileSubmission; submissionWarning?: string }> {
    const submission = task.completionSubmission;
    if (!submission) return {};
    if (submission.storageVersion !== 1) return { submissionWarning: '先前的文件提交仅保存了选择记录，尚未保存独立文件版本；请重新选择并提交文件。历史完成快照仍可查看。' };
    try { await this.completionStore.verify(task.id, submission); return { submittedFiles: submission }; }
    catch { return { submissionWarning: '提交区文件校验失败，已保存的文件版本缺失或已改变，不能使用此版本完成工作。要恢复，请重新选择并提交原提交区的全部文件；缺失文件须先恢复至工作区。' }; }
  }
  private async makeCompletionPreview(task: Task, files: SnapshotFile[]): Promise<TaskCompletionPreview> {
    const { submittedFiles, submissionWarning } = await this.submissionState(task), isFolder = this.completionFolder(task);
    return { taskId: task.id, projectId: task.projectId, code: task.code, title: task.title, taskRevision: task.revision,
      isFolder, ...(task.state === 'recheck' ? { isRecheck: true } : {}), children: this.completionChildren(task), ...(isFolder ? { childrenVersion: this.completionChildrenVersion(task) } : {}),
      goals: [...this.completionGoals(task), { id: 'submitted-files', label: '已提交工作文件', system: true, checked: !!submittedFiles }],
      files: files.map((file): CompletionWorkspaceFile => ({ ...file, submissionDescription: this.describeWorkspaceFile(task, file) })), workspaceVersion: this.workspaceVersion(files), blockers: this.completionBlockers(task), retry: !!task.pending, ...(submittedFiles ? { submittedFiles } : {}), ...(submissionWarning ? { submissionWarning } : {}) };
  }
  completionPreview(id: string): Promise<TaskCompletionPreview> { return this.serial(async () => {
    if (this.mode !== 'single-user') throw new Error('逐项目标确认仅用于单用户流程');
    const task = this.task(id); return this.makeCompletionPreview(task, await this.completionManifest(task));
  }); }
  submitCompletionFiles(id: string, input: unknown): Promise<TaskCompletionPreview> { return this.serial(async () => {
    if (this.mode !== 'single-user') throw new Error('提交工作文件仅用于单用户流程');
    const data = exactFields(input, ['revision', 'workspaceVersion', 'files'], '提交工作文件'), task = this.task(id);
    return this.makeCompletionPreview(task, (await this.submitFiles(task, data)).current);
  }); }
  /** Commits chosen workspace files and their descriptions to the submission area, merged with earlier submissions.
   * The person's dialog and Agent completion submit through the same checks. */
  private submitFiles(task: Task, data: Record<string, unknown>): Promise<{ submission: CompletionFileSubmission; current: SnapshotFile[] }> {
    const id = task.id;
    this.checkVersion(task, data.revision); const blockers = this.completionBlockers(task); if (blockers.length) throw new Error(blockers.join('；'));
    if (!Array.isArray(data.files) || !data.files.length || data.files.length > 1000) throw new Error('请至少选择一个工作文件再提交');
    this.files.register(id);
    return this.files.withReadLease(this.files.readLease(id), async () => {
      const current = await this.completionManifest(task), version = this.workspaceVersion(current);
      if (text(data.workspaceVersion, '工作区版本') !== version) throw new Error('工作区文件已变化，请刷新预览并重新选择文件');
      const selected = (data.files as unknown[]).map(raw => {
        const row = exactFields(raw, ['path', 'description'], '待提交文件'), path = fileName(text(row.path, '文件名'));
        const file = current.find(item => item.path === path); if (!file) throw new Error(`工作文件不存在或已变化：${path}`);
        // Omission means the untouched placeholder; an explicit empty string
        // remains a user edit and must never silently revert to generated text.
        const description = Object.hasOwn(row, 'description') ? text(row.description, '文件说明') : this.describeWorkspaceFile(task, file).text;
        if (description.length > 2000) throw new Error('文件说明不能超过 2000 字符');
        return { ...file, description };
      });
      if (new Set(selected.map(file => file.path)).size !== selected.length) throw new Error('待提交文件不能重复');
      const previousState = await this.submissionState(task), previous = previousState.submittedFiles;
      if (task.completionSubmission?.storageVersion === 1 && previousState.submissionWarning) {
        const original = task.completionSubmission.files;
        if (!Array.isArray(original) || !original.length || original.length > 1000 || original.some(file => !file || typeof file.path !== 'string')) throw new Error('原提交区清单不合法，无法确定全部原文件；请先修复清单，不能静默删除文件');
        const paths = original.map(file => fileName(file.path));
        if (paths.some(path => !selected.some(file => file.path === path))) throw new Error(previousState.submissionWarning);
        // Explicitly resubmitting every previously committed path repairs the
        // area using only newly verified workspace bytes; damaged versions stay.
      }
      const merged = new Map((previous?.files ?? []).map(file => [file.path, file])); for (const file of selected) merged.set(file.path, file);
      const submission: CompletionFileSubmission = { id: `fs-${randomUUID()}`, taskRevision: task.revision, workspaceVersion: version, submittedAt: now(), files: [...merged.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0), storageVersion: 1 };
      await this.completionStore.create(id, submission, this.files.directory(id), new Set(selected.map(file => file.path)), previous, async () => {
        this.checkVersion(this.task(id), data.revision);
        if (this.workspaceVersion(await this.completionManifest(task)) !== version) throw new Error('工作区文件在提交时发生变化，请刷新预览并重新提交');
      });
      try { task.completionSubmission = submission; this.transaction(() => this.putTask(task)); }
      catch (error) { await this.completionStore.removeCommit(id, submission.id); throw error; }
      return { submission, current };
    });
  }
  confirmCompletion(id: string, input: unknown): Promise<TaskCompletionResult> { return this.serial(async () => {
    if (this.mode !== 'single-user') throw new Error('逐项目标确认仅用于单用户流程');
    const data = exactFields(input, ['revision', 'checkedGoalIds', 'workspaceVersion', 'submissionId', 'confirmWithoutFiles', 'childrenVersion'], '完成确认'), task = this.task(id);
    return this.completeConfirmed(task, data, {
      acknowledge: goals => {
        const checked = data.checkedGoalIds;
        if (!Array.isArray(checked) || checked.length !== goals.length || new Set(checked).size !== goals.length || goals.some(goal => !checked.includes(goal.id))) throw new Error('请手动确认当前任务的全部目标，不能遗漏、重复或添加其他目标');
        return goals;
      },
      submission: async () => {
        if (data.confirmWithoutFiles !== undefined && typeof data.confirmWithoutFiles !== 'boolean') throw new Error('不提交文件的二次确认须为布尔值');
        const withoutSubmittedFiles = data.confirmWithoutFiles === true;
        if (withoutSubmittedFiles && data.submissionId !== undefined) throw new Error('不提交文件的二次确认不能与文件提交标识同时使用');
        if (withoutSubmittedFiles) return;
        const { submittedFiles, submissionWarning } = await this.submissionState(task);
        if (!submittedFiles || data.submissionId !== submittedFiles.id) throw new Error(submissionWarning ?? '请先选择工作文件、填写每项文件说明并提交工作文件；提交版本须与当前预览一致，或显式二次确认不提交文件完成');
        return submittedFiles;
      },
    });
  }); }
  /** The same preview the person's completion dialog shows, for an Agent. */
  agentCompletionPreview(id: string): Promise<TaskCompletionPreview> { return this.completionPreview(id); }
  /** Autonomy mode: an Agent confirms a completion with evidence for every goal, after the same checks and freeze as
   * a person's confirmation. Whether the calling conversation may complete this task is the caller's decision. */
  async agentCompleteTask(id: string, input: AgentCompletionInput, actor: AgentCompletionActor): Promise<TaskCompletionResult> {
    const started = Date.now(), chatId = actor && typeof actor.chatId === 'string' && actor.chatId ? actor.chatId : undefined;
    const event = { actor: 'agent' as const, source: 'agent-tool' as const, action: 'task/agent-complete', ...(typeof id === 'string' && id ? { taskId: id } : {}), ...(chatId ? { chatId } : {}), request: agentCompletionSummary(input, actor), before: this.activityState({ taskId: id }) };
    try {
      const result = await this.serial(async () => {
        if (this.mode !== 'single-user') throw new Error('Agent 确认完成仅用于单用户流程');
        const agent = agentActor(actor), data = exactFields(input, ['revision', 'workspaceVersion', 'childrenVersion', 'evidence', 'files', 'withoutFiles'], 'Agent 完成确认'), evidence = completionEvidence(data.evidence);
        if (data.withoutFiles !== undefined && data.withoutFiles !== true) throw new Error('无提交文件完成须写 withoutFiles: true');
        if ((data.files === undefined) === (data.withoutFiles === undefined)) throw new Error('须给出要提交的文件（files）或无提交文件完成（withoutFiles: true），且只能给其中一个');
        const task = this.task(id);
        return this.completeConfirmed(task, data, {
          acknowledge: goals => {
            const expected = goals.filter(goal => goal.id !== 'goal').map(goal => goal.id);
            if (evidence.checklist.length !== expected.length || evidence.checklist.some(row => !expected.includes(row.id))) throw new Error(`检查依据须恰好覆盖全部 Checklist 目标，不能缺少或添加：${expected.join('、') || '（本任务没有 Checklist 目标）'}`);
            return goals.map(goal => ({ ...goal, checked: true, evidence: goal.id === 'goal' ? evidence.goal : evidence.checklist.find(row => row.id === goal.id)!.evidence }));
          },
          submission: async () => data.files === undefined ? undefined : (await this.submitFiles(task, { revision: data.revision, workspaceVersion: data.workspaceVersion, files: data.files })).submission,
          agent,
        });
      });
      this.recordActivity({ ...event, ok: true, durationMs: Date.now() - started, after: this.activityState({ taskId: id }), result: { snapshotId: result.task.completedId, ...(result.warning ? { warning: summarize(result.warning) } : {}) } });
      return result;
    } catch (error) {
      this.recordActivity({ ...event, ok: false, error: error instanceof Error ? error.message.slice(0, 500) : String(error), durationMs: Date.now() - started });
      throw error;
    }
  }
  /** Every check, the freeze and the immutable snapshot of a confirmed completion, shared by the person's dialog and
   * Agent completion. Only how the goals are acknowledged, how files reach the submission area and who is recorded differ. */
  private async completeConfirmed(task: Task, data: Record<string, unknown>, confirm: {
    acknowledge(goals: CompletionGoal[]): CompletionGoal[];
    /** The submission to complete with; undefined completes without files. */
    submission(): Promise<CompletionFileSubmission | undefined>;
    agent?: AgentCompletionActor;
  }): Promise<TaskCompletionResult> {
    const id = task.id; this.checkVersion(task, data.revision);
    const blockers = this.completionBlockers(task); if (blockers.length) throw new Error(blockers.join('；'));
    const folder = this.completionFolder(task), childrenVersion = folder ? text(data.childrenVersion, '直属子任务版本') : undefined;
    if (!folder && data.childrenVersion !== undefined) throw new Error('叶任务不能提交直属子任务版本');
    if (folder && childrenVersion !== this.completionChildrenVersion(task)) throw new Error('直属子任务版本已变化，请刷新预览并重新确认全部目标');
    const childrenRefs = folder ? this.folderRefs(task) : undefined;
    const goals = confirm.acknowledge(this.completionGoals(task));
    const expectedVersion = text(data.workspaceVersion, '工作区版本'), files = await this.completionManifest(task);
    if (expectedVersion !== this.workspaceVersion(files)) throw new Error('工作区文件已变化，请刷新预览并重新确认全部目标');
    const submission = await confirm.submission(), withoutSubmittedFiles = !submission;
    if (childrenRefs) await this.verifyCompletionChildren(task, childrenVersion!, childrenRefs);
    task.inputs = this.inputs(task); await this.files.allocate(id);
    const confirmation: HumanCompletionConfirmation = { goals: [...goals, { id: 'submitted-files', label: '已提交工作文件', system: true, checked: !withoutSubmittedFiles }], workspaceVersion: expectedVersion, confirmedAt: now(), ...(withoutSubmittedFiles ? { withoutSubmittedFiles: true } : {}), ...(childrenVersion ? { childrenVersion } : {}), ...(confirm.agent ? { actor: 'agent' as const, agent: confirm.agent } : {}) };
    const measurements = task.pendingMeasurements ?? [];
    task.pending = `正在固定${confirm.agent ? ' Agent ' : '人工'}确认的结果；失败时禁止写入，请重新预览并确认完成`; task.pendingAction = 'complete'; task.pendingOwnerId = id; task.pendingConfirmation = confirmation;
    this.transaction(() => this.touch(task)); this.files.revoke(id); await this.quiesce([id]); await this.files.drain();
    const snapshot = await this.capture(task, measurements, confirmation, submission, childrenRefs);
    task.state = 'completed'; task.completedId = snapshot.id; delete task.pending; delete task.pendingAction; delete task.pendingOwnerId; delete task.pendingMeasurements; delete task.pendingConfirmation; delete task.candidateId; delete task.recheckReason;
    this.transaction(() => { this.db.prepare('INSERT INTO snapshots VALUES(?,?,?)').run(snapshot.id, id, JSON.stringify(snapshot)); this.touch(task); });
    try { await this.refreshFolders([id, ...this.descendants(id)]); }
    catch (error) { return { task: this.view(id), warning: `本任务已完成；上级任务汇总尚未完成，请重试上级任务：${error instanceof Error ? error.message : String(error)}` }; }
    return { task: this.view(id) };
  }
  private measurements(task: Task, value: unknown): Measurement[] {
    if (!Array.isArray(value) || value.length !== task.criteria.length) throw new Error(this.mode === 'single-user' ? '完成须提供每项指标的实测结果和证据' : '送验须提供每项指标的实测结果和证据');
    const rows = value.map(raw => { const row = object(raw); return { criterionId: text(row.criterionId, '指标标识'), observed: row.observed, evidence: fileName(text(row.evidence, '证据文件')), note: text(row.note, '验证说明') }; });
    if (new Set(rows.map(row => row.criterionId)).size !== rows.length) throw new Error('实测指标重复');
    for (const criterion of task.criteria) { const row = rows.find(item => item.criterionId === criterion.id); if (!row || (criterion.kind === 'numeric' ? typeof row.observed !== 'number' || !Number.isFinite(row.observed) : typeof row.observed !== 'boolean')) throw new Error('实测结果类型或指标不匹配'); }
    return rows as Measurement[];
  }
  private async capture(task: Task, measurements: Measurement[], humanConfirmation?: HumanCompletionConfirmation, submittedFiles?: CompletionFileSubmission, childrenRefs?: InputRef[]): Promise<Snapshot> {
    const snapshot: Snapshot = { id: `s-${randomUUID()}`, taskId: task.id, createdAt: now(), definition: definition(task), inputs: task.inputs, measurements, files: [], ...(humanConfirmation ? { humanConfirmation } : {}), ...(submittedFiles ? { submittedFiles } : {}), ...(childrenRefs ? { childrenRefs } : {}) };
    const directory = this.files.directory(task.id), base = join(this.root, 'snapshots'); await mkdir(base, { recursive: true, mode: 0o700 });
    const temporary = join(base, `${snapshot.id}.tmp`), destination = join(base, snapshot.id); await mkdir(join(temporary, 'files'), { recursive: true, mode: 0o700 });
    let total = 0;
    const visit = async (relative: string) => {
      const current = join(directory, relative);
      if ((await lstat(current)).isSymbolicLink() || await realpath(current) !== current) throw new Error('快照拒绝符号链接');
      for (const entry of await readdir(current, { withFileTypes: true })) {
        if (!relative && entry.name.toLowerCase() === '.chat-tmp') continue;
        const path = relative ? `${relative}/${entry.name}` : entry.name; fileName(path);
        if (entry.isSymbolicLink()) throw new Error('快照拒绝符号链接');
        if (entry.isDirectory()) { await mkdir(join(temporary, 'files', path), { mode: 0o700 }); await visit(path); }
        else {
          if (submittedFiles && !submittedFiles.files.some(file => file.path === path)) continue;
          if (!entry.isFile() || snapshot.files.length >= 1000) throw new Error('快照文件类型或数量不受支持');
          const handle = await open(join(directory, path), constants.O_RDONLY | constants.O_NOFOLLOW);
          let bytes: Buffer, createdAt = '', modifiedAt = ''; try {
            const info = await handle.stat(), budget = 100 * 1024 * 1024 - total;
            createdAt = new Date(info.birthtimeMs > 0 ? info.birthtimeMs : info.mtimeMs).toISOString(); modifiedAt = info.mtime.toISOString();
            if (!info.isFile() || info.size > budget) throw new Error('快照文件过大或类型不受支持');
            const parts: Buffer[] = []; let count = 0;
            while (true) { const buffer = Buffer.alloc(Math.min(65536, budget - count + 1)), part = await handle.read(buffer, 0, buffer.length, null); if (!part.bytesRead) break; count += part.bytesRead; if (count > budget) throw new Error('快照超过 100 MiB'); parts.push(buffer.subarray(0, part.bytesRead)); }
            bytes = Buffer.concat(parts, count);
          } finally { await handle.close(); }
          total += bytes.length; if (total > 100 * 1024 * 1024) throw new Error('快照超过 100 MiB');
          await writeFile(join(temporary, 'files', path), bytes, { mode: 0o400, flag: 'wx' });
          snapshot.files.push({ path, bytes: bytes.length, version: createHash('sha256').update(bytes).digest('hex'), createdAt, modifiedAt });
        }
      }
    };
    try {
      if (childrenRefs) await this.verifyCompletionChildren(task, humanConfirmation!.childrenVersion!, childrenRefs);
      if (humanConfirmation) { await this.verifyCompletionInputs(task); if (this.workspaceVersion(await this.completionManifest(task)) !== humanConfirmation.workspaceVersion) throw new Error('工作区文件在冻结时发生变化，请刷新预览并重新确认全部目标'); }
      if (submittedFiles) {
        // A file submission fixes bytes immediately. Later workspace edits are
        // deliberately not recaptured when the person completes the task.
        await this.completionStore.copyInto(task.id, submittedFiles, join(temporary, 'files'));
        snapshot.files = submittedFiles.files.map(({ description: _description, ...file }) => file);
      } else if (!humanConfirmation?.withoutSubmittedFiles) await visit('');
      if (humanConfirmation) {
        const current = await this.completionManifest(task);
        if (this.workspaceVersion(current) !== humanConfirmation.workspaceVersion || submittedFiles && (snapshot.files.length !== submittedFiles.files.length || submittedFiles.files.some(file => !snapshot.files.some(captured => captured.path === file.path && captured.version === file.version && captured.bytes === file.bytes && captured.createdAt === file.createdAt && captured.modifiedAt === file.modifiedAt)))) throw new Error('工作区文件在冻结时发生变化，请刷新预览并重新确认全部目标');
      }
      else for (const path of [...task.outputs, ...measurements.map(row => row.evidence)]) if (!snapshot.files.some(file => file.path === path)) throw new Error(`缺少输出或证据文件：${path}`);
      if (humanConfirmation) await this.verifyCompletionInputs(task);
      if (childrenRefs) await this.verifyCompletionChildren(task, humanConfirmation!.childrenVersion!, childrenRefs);
      if (submittedFiles) await this.completionStore.verify(task.id, submittedFiles);
      await writeFile(join(temporary, 'manifest.json'), JSON.stringify(snapshot), { mode: 0o400, flag: 'wx' });
      await rename(temporary, destination); await chmod(destination, 0o500); return snapshot;
    } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
  }
  private folderRefs(task: Task): InputRef[] {
    const children = this.activeChildren(task.id);
    if (!children.length || children.some(child => !this.resultId(child) || this.blockers(child).length)) throw new Error(this.mode === 'single-user' ? '所有直接子任务须已有效完成' : '所有直接子任务须已有效验收，不能跳过中间层复核');
    return children.map(child => ({ taskId: child.id, snapshotId: this.resultId(child)! }));
  }
  private async verifyCompletionInputs(task: Task) {
    if (JSON.stringify(this.inputs(task)) !== JSON.stringify(task.inputs)) throw new Error('前序任务结果版本已变化，请重新预览并确认完成');
    for (const ref of task.inputs) { const snapshot = this.snapshot(ref.snapshotId); if (snapshot.taskId !== ref.taskId) throw new Error('前序任务快照归属不正确'); await this.verifySnapshot(snapshot); }
    if (JSON.stringify(this.inputs(task)) !== JSON.stringify(task.inputs)) throw new Error('前序任务版本在冻结期间发生变化，请重新预览并确认完成');
  }
  private verifyFolderRefs(snapshot: Snapshot) {
    const refs = this.folderRefs(this.task(snapshot.taskId));
    if (JSON.stringify(refs) !== JSON.stringify(snapshot.childrenRefs)) throw new Error('子任务正式版本已变化，请重新生成上级复核快照');
  }
  private async captureFolder(task: Task): Promise<Snapshot> {
    const snapshot: Snapshot = { id: `s-${randomUUID()}`, taskId: task.id, createdAt: now(), definition: definition(task), inputs: task.inputs, measurements: [], files: [], childrenRefs: this.folderRefs(task) };
    const base = join(this.root, 'snapshots'), temporary = join(base, `${snapshot.id}.tmp`), destination = join(base, snapshot.id);
    await mkdir(join(temporary, 'files'), { recursive: true, mode: 0o700 });
    try {
      await writeFile(join(temporary, 'manifest.json'), JSON.stringify(snapshot), { mode: 0o400, flag: 'wx' });
      await rename(temporary, destination); await chmod(destination, 0o500); return snapshot;
    } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
  }
  /** Each containing level awaits human acceptance of its direct children before advancing. */
  private async refreshFolders(ids: string[], retryPending = false) {
    if (this.mode === 'single-user') { await this.refreshSingleUserFolders(ids, retryPending); return; }
    const folders = new Set<string>();
    for (const id of ids) { let task = this.task(id); folders.add(id); while (task.parentId) { folders.add(task.parentId); task = this.task(task.parentId); } }
    const depth = (id: string) => { let count = 0, task = this.task(id); while (task.parentId) { count++; task = this.task(task.parentId); } return count; };
    for (const id of [...folders].sort((a, b) => depth(b) - depth(a))) {
      const task = this.task(id), children = this.activeChildren(id);
      if (task.pendingAction === 'delete' || task.pendingAction === 'clear' || !children.length || !['unstarted', 'allocated'].includes(task.state) || task.pending && !retryPending || this.blockers(task).length || children.some(child => child.state !== 'accepted' || !child.acceptedId || child.pending || this.blockers(child).length)) continue;
      await this.files.allocate(id); task.inputs = this.inputs(task); task.assignee ??= 'operator'; task.state = 'allocated';
      task.pending = '正在冻结子任务版本；失败时保持禁止写入'; this.transaction(() => this.touch(task));
      this.files.revoke(id); await this.quiesce([id]); await this.files.drain();
      const snapshot = await this.captureFolder(task);
      task.state = 'review'; task.candidateId = snapshot.id; delete task.pending;
      this.transaction(() => { this.db.prepare('INSERT INTO snapshots VALUES(?,?,?)').run(snapshot.id, id, JSON.stringify(snapshot)); this.touch(task); });
    }
  }
  private async refreshSingleUserFolders(ids: string[], _retryPending = false) {
    const folders = new Set<string>();
    for (const id of ids) { let task = this.task(id); folders.add(id); while (task.parentId) { folders.add(task.parentId); task = this.task(task.parentId); } }
    const depth = (id: string) => { let count = 0, task = this.task(id); while (task.parentId) { count++; task = this.task(task.parentId); } return count; };
    for (const id of [...folders].sort((a, b) => depth(b) - depth(a))) {
      const task = this.task(id); if (!this.children(id).length || this.isArchived(task) || task.pending || ['completed', 'recheck'].includes(task.state)) continue;
      const children = this.activeChildren(id), state = children.some(child => ['working', 'completed', 'recheck'].includes(child.state)) ? 'working' : 'unstarted';
      if (task.state !== state) { task.state = state; this.transaction(() => this.touch(task)); }
    }
  }
  private async completeSingleUser(task: Task, data: Record<string, unknown>) {
    if (this.completionFolder(task)) throw new Error('任务组须在完成工作窗口逐项人工确认，不能通过直接完成或汇总接口跳过检查');
    if (task.completedId || task.state === 'recheck') throw new Error('已有历史结果的任务须在完成工作窗口逐项人工确认，不能通过直接完成接口跳过复核');
    this.assertHierarchyWritable(task);
    if (task.pendingConfirmation) throw new Error('人工确认的完成操作须重新预览文件并手动确认全部目标，不能跳过二次确认重试');
    this.leaf(task); this.assertHierarchyWritable(task);
    if (task.state !== 'working') throw new Error('只有进行中任务可以完成');
    const issues = definitionIssues(task, this.mode); if (issues.length) throw new Error(issues.join('；'));
    if (this.blockers(task).length) throw new Error('任务输入无效，不能完成');
    const savedPlan = task.pending && (!task.pendingAction || task.pendingAction === 'complete') ? task.pendingMeasurements : undefined;
    const measurements = this.measurements(task, savedPlan ?? data.measurements);
    for (const criterion of task.criteria) if (!measurementPass(criterion, measurements.find(row => row.criterionId === criterion.id)!)) throw new Error(`指标未达标，不能完成：${criterion.label}`);
    for (const path of [...task.outputs, ...measurements.map(row => row.evidence)]) {
      const target = join(this.files.directory(task.id), path);
      try { if (await realpath(target) !== target || !(await lstat(target)).isFile()) throw new Error(); }
      catch { throw new Error(`输出或证据文件缺失或不合法：${path}`); }
    }
    task.pending = '正在固定结果；失败时禁止写入，可重试完成'; task.pendingAction = 'complete'; task.pendingOwnerId = task.id; task.pendingMeasurements = measurements; this.transaction(() => this.touch(task));
    this.files.revoke(task.id); await this.quiesce([task.id]); await this.files.drain();
    const snapshot = await this.capture(task, measurements);
    task.state = 'completed'; task.completedId = snapshot.id; delete task.pending; delete task.pendingAction; delete task.pendingOwnerId; delete task.pendingMeasurements; delete task.pendingConfirmation; delete task.candidateId;
    this.transaction(() => { this.db.prepare('INSERT INTO snapshots VALUES(?,?,?)').run(snapshot.id, task.id, JSON.stringify(snapshot)); this.touch(task); });
    await this.refreshFolders([task.id, ...this.descendants(task.id)]);
  }
  private async resumeSingleUser(task: Task) {
    this.leaf(task); if (task.state !== 'completed') throw new Error('只有已完成任务可以继续修改');
    if (this.isArchived(task)) throw new Error('归档任务不能继续修改');
    const inputs = this.inputs(task), affected = this.affectedBy([task.id]).filter(id => !this.isArchived(this.task(id)));
    this.assertNoDeletion(affected);
    this.transaction(() => { for (const id of affected) { const current = this.task(id); current.pending = '正在停止相关写入；失败时保持禁止写入，可重试继续修改'; current.pendingAction = 'resume'; current.pendingOwnerId = task.id; delete current.pendingMeasurements; delete current.pendingConfirmation; this.touch(current); } });
    for (const id of affected) { this.files.register(id); this.files.revoke(id); }
    await this.quiesce(affected); await this.files.drain();
    this.transaction(() => {
      for (const id of affected) { const current = this.task(id); this.invalidateSingleUser(current); if (id === task.id) { current.state = 'working'; current.inputs = inputs; delete current.recheckReason; } this.touch(current); }
    });
    await this.files.allocate(task.id); this.files.reopen(task.id);
    await this.refreshFolders(affected);
  }
  private async submit(task: Task, data: Record<string, unknown>) {
    if (task.state !== 'working') throw new Error('只有进行中任务可送验');
    if (this.blockers(task).length) throw new Error('任务输入无效，不能送验');
    const measurements = this.measurements(task, data.measurements);
    for (const path of [...task.outputs, ...measurements.map(row => row.evidence)]) {
      const target = join(this.files.directory(task.id), path);
      try { if (await realpath(target) !== target || !(await lstat(target)).isFile()) throw new Error(); }
      catch { throw new Error(`输出或证据文件缺失或不合法：${path}`); }
    }
    task.pending = '正在冻结；失败时保持禁止写入，可重试送验';
    this.transaction(() => this.touch(task));
    this.files.revoke(task.id);
    await this.quiesce([task.id]); await this.files.drain();
    const snapshot = await this.capture(task, measurements);
    task.state = 'review'; task.candidateId = snapshot.id; delete task.pending;
    this.transaction(() => { this.db.prepare('INSERT INTO snapshots VALUES(?,?,?)').run(snapshot.id, task.id, JSON.stringify(snapshot)); this.touch(task); });
  }
  action(id: string, input: unknown) { return this.serial(async () => {
    const data = object(input), task = this.task(id); this.checkVersion(task, data.revision);
    if (task.pendingAction === 'delete') throw new Error('任务正在永久删除，请在删除确认窗口中重试，不能执行其他操作');
    if (task.pendingAction === 'clear') throw new Error('任务正在清空，请重新预览并确认清空，不能执行其他操作');
    if (task.pendingAction === 'dependencies') throw new Error('依赖调整尚未完成，请在发起任务重新预览并确认；不能执行其他操作');
    if (this.mode === 'single-user') {
      if (this.isArchived(task)) throw new Error('归档任务只保留历史，不能继续执行');
      if (task.pendingOwnerId && task.pendingOwnerId !== id) throw new Error('相关任务正在恢复，请先重试发起任务的操作');
      if (task.pendingAction === 'resume' && data.action !== 'resume') throw new Error('请重试继续修改，不能改用其他操作');
      if (task.pendingAction === 'complete' && data.action !== 'complete') throw new Error('请重试完成，不能改用其他操作');
      switch (data.action) {
        case 'start': await this.start(task); break;
        case 'complete': await this.completeSingleUser(task, data); break;
        case 'aggregate': throw new Error('任务组须在完成工作窗口逐项人工确认，不能通过汇总接口跳过检查');
        case 'resume': await this.resumeSingleUser(task); break;
        default: throw new Error('单用户流程仅支持开始、完成和继续修改');
      }
      return { task: this.view(id) };
    }
    const folder = this.children(id).length > 0;
    switch (data.action) {
      case 'claim':
        if (task.kind === 'group' && !folder) throw new Error('空任务组仅组织子图');
        if (task.state !== 'unstarted') throw new Error('任务已领取');
        this.assertHierarchyWritable(task);
        await this.files.allocate(id); this.files.reopen(id); task.state = 'allocated'; task.assignee = 'operator'; this.transaction(() => this.touch(task)); break;
      case 'start': await this.start(task); break;
      case 'submit':
        if (folder) { this.folderRefs(task); if (!['unstarted', 'allocated'].includes(task.state)) throw new Error('上级任务不在可汇总送验状态'); await this.refreshFolders([id], true); }
        else { this.leaf(task); await this.submit(task, data); }
        break;
      case 'reject': {
        if (task.state !== 'review') throw new Error('只有待复核任务可打回');
        const reason = text(data.reason, '打回说明'); this.transaction(() => { this.saveReview(task, 'reject', reason); task.state = folder ? 'allocated' : 'working'; delete task.candidateId; this.touch(task); });
        if (folder || !this.blockers(task).length) this.files.reopen(id); break;
      }
      case 'accept': case 'reaccept': {
        if (task.state !== (data.action === 'accept' ? 'review' : 'revoked')) throw new Error('任务不在可验收状态');
        if (data.action === 'accept' && this.blockers(task).length) throw new Error('实际输入无效，不能验收');
        const reason = text(data.reason, '验收依据'); this.inputs(task);
        const snapshot = this.snapshot(task.candidateId ?? task.acceptedId!);
        if (folder) this.verifyFolderRefs(snapshot);
        await this.verifySnapshot(snapshot);
        if (!folder) for (const criterion of snapshot.definition.criteria) if (!measurementPass(criterion, snapshot.measurements.find(row => row.criterionId === criterion.id)!)) throw new Error(`指标未达标，不能验收：${criterion.label}`);
        // Original executed inputs and snapshot stay unchanged; reacceptance records the new review basis separately.
        this.transaction(() => { this.saveReview(task, data.action as 'accept' | 'reaccept', reason); task.acceptedId = snapshot.id; task.state = 'accepted'; this.touch(task); });
        const downstream = this.descendants(id).flatMap(target => [target, ...this.contained(target)]);
        await this.pauseInvalid([...new Set(downstream)]); await this.refreshFolders([id, ...downstream]); break;
      }
      case 'discard': {
        if (!['review', 'accepted', 'revoked'].includes(task.state)) throw new Error('此状态不能废弃');
        if (data.redo === true && task.parentId) {
          let parent = this.task(task.parentId);
          while (true) { if (parent.acceptedId) throw new Error('上级任务已有正式版本，请先为上级任务建立返工分支，再创建返工子任务'); if (!parent.parentId) break; parent = this.task(parent.parentId); }
          // Discarding the child resets unsubmitted parent reviews to planning in
          // the same transaction, but cannot revive a discarded or pending parent.
          this.validateParent(task.projectId, task.parentId, undefined, true);
        }
        const reason = text(data.reason, '废弃说明'); const affected = this.affectedBy([id, ...this.contained(id)]); let replacement: Task | undefined;
        this.transaction(() => {
          this.saveReview(task, 'discard', reason);
          task.state = 'discarded'; this.touch(task);
          this.invalidate(affected);
          if (data.redo === true) {
            replacement = this.newTask(task.projectId, { ...definition(task), title: `${task.title}（返工）` }, { dependencies: [...task.dependencies], replacesId: task.id });
            this.putTask(replacement); for (const source of replacement.dependencies) this.db.prepare('INSERT INTO dependencies VALUES(?,?)').run(source, replacement.id);
          }
        });
        await this.pauseInvalid(affected); await this.refreshFolders(affected); return { task: this.view(id), replacement: replacement ? this.view(replacement.id) : undefined };
      }
      default: throw new Error('不支持此操作；清空与删除将在 M5 接入完整确认和清理');
    }
    return { task: this.view(id) };
  }); }
  private async verifySnapshot(snapshot: Snapshot) {
    for (const ref of snapshot.inputs) {
      try { const task = this.task(ref.taskId), input = this.snapshot(ref.snapshotId); if (task.id !== input.taskId) throw new Error(); }
      catch { throw new Error('历史快照引用的输入已被永久删除，不能用作有效结果'); }
    }
    for (const ref of snapshot.childrenRefs ?? []) { const child = this.snapshot(ref.snapshotId); if (child.taskId !== ref.taskId) throw new Error('子任务快照归属不正确'); await this.verifySnapshot(child); }
    for (const file of snapshot.files) {
      const target = join(this.root, 'snapshots', snapshot.id, 'files', file.path);
      if (await realpath(target) !== target) throw new Error('快照路径已改变');
      const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if ((await handle.stat()).size !== file.bytes) throw new Error('快照完整性校验失败');
        const hash = createHash('sha256'), buffer = Buffer.alloc(65536);
        while (true) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); }
        if (hash.digest('hex') !== file.version) throw new Error('快照完整性校验失败');
      } finally { await handle.close(); }
    }
  }
  private snapshotContains(rootId: string, targetId: string, visited = new Set<string>()): boolean {
    if (rootId === targetId) return true;
    if (visited.has(rootId)) return false; visited.add(rootId);
    let snapshot: Snapshot; try { snapshot = this.snapshot(rootId); } catch { return false; }
    return (snapshot.childrenRefs ?? []).some(ref => this.snapshotContains(ref.snapshotId, targetId, visited));
  }
  private authorizedSnapshot(taskId: string, snapshotId: string): Snapshot {
    const owner = this.task(taskId), snapshot = this.snapshot(snapshotId);
    const roots = [...owner.inputs.map(input => input.snapshotId), ...[owner.candidateId, owner.completedId, owner.acceptedId].filter((id): id is string => id !== undefined)];
    if (snapshot.taskId !== owner.id && !roots.some(id => this.snapshotContains(id, snapshot.id))) throw new Error('快照不在当前任务或实际输入范围内');
    return snapshot;
  }
  /** Exact read authority matches snapshotFile; manifests grant no new input capabilities. */
  snapshotManifest(taskId: string, snapshotId: string): SnapshotManifestView {
    const snapshot = this.authorizedSnapshot(taskId, snapshotId);
    return { snapshot, unavailableRefs: this.unavailableSnapshotRefs(snapshot) };
  }
  /** Human-only bounded, lossless preview of an authorized immutable snapshot file. */
  snapshotPreview(taskId: string, snapshotId: string, path: string): Promise<WorkspaceFilePreview> { return this.serial(async () => {
    const snapshot = this.authorizedSnapshot(taskId, snapshotId), file = snapshot.files.find(row => row.path === fileName(path));
    if (!file) throw new Error('快照文件不存在');
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 100 * 1024 * 1024) throw new Error('快照文件大小不受支持');
    const target = join(this.root, 'snapshots', snapshot.id, 'files', file.path);
    if (await realpath(target) !== target) throw new Error('快照路径已改变');
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW), limit = 262144;
    try {
      const info = await handle.stat(); if (!info.isFile() || info.size !== file.bytes) throw new Error('快照完整性校验失败');
      const hash = createHash('sha256'), parts: Buffer[] = []; let length = 0;
      while (true) {
        const bytes = Buffer.alloc(Math.min(65536, file.bytes - length + 1)), part = await handle.read(bytes, 0, bytes.length, null);
        if (!part.bytesRead) break;
        length += part.bytesRead; if (length > file.bytes) throw new Error('快照完整性校验失败');
        const value = bytes.subarray(0, part.bytesRead); hash.update(value); if (file.bytes <= limit) parts.push(value);
      }
      if (length !== file.bytes || hash.digest('hex') !== file.version) throw new Error('快照完整性校验失败');
      this.authorizedSnapshot(taskId, snapshotId);
      if (file.bytes > limit) return { path: file.path, bytes: file.bytes, status: 'tooLarge' };
      const bytes = Buffer.concat(parts, length); if (bytes.includes(0)) return { path: file.path, bytes: length, status: 'binary' };
      let content: string; try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return { path: file.path, bytes: length, status: 'binary' }; }
      return { path: file.path, bytes: length, status: 'text', content, version: file.version };
    } finally { await handle.close(); }
  }); }
  /** Verified bytes of one snapshot file for a download (binary allowed), with the preview's integrity check. */
  snapshotBytes(taskId: string, snapshotId: string, path: string): Promise<{ path: string; data: Buffer }> { return this.serial(async () => {
    const snapshot = this.authorizedSnapshot(taskId, snapshotId), file = snapshot.files.find(row => row.path === fileName(path));
    if (!file) throw new Error('快照文件不存在');
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 100 * 1024 * 1024) throw new Error('快照文件大小不受支持');
    const target = join(this.root, 'snapshots', snapshot.id, 'files', file.path);
    if (await realpath(target) !== target) throw new Error('快照路径已改变');
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat(); if (!info.isFile() || info.size !== file.bytes) throw new Error('快照完整性校验失败');
      const data = await handle.readFile();
      if (data.length !== file.bytes || createHash('sha256').update(data).digest('hex') !== file.version) throw new Error('快照完整性校验失败');
      this.authorizedSnapshot(taskId, snapshotId);
      return { path: file.path, data };
    } finally { await handle.close(); }
  }); }
  async snapshotFile(taskId: string, snapshotId: string, path: string) {
    const snapshot = this.authorizedSnapshot(taskId, snapshotId);
    const file = snapshot.files.find(row => row.path === fileName(path)); if (!file) throw new Error('快照文件不存在');
    const target = join(this.root, 'snapshots', snapshot.id, 'files', file.path);
    if (await realpath(target) !== target) throw new Error('快照路径已改变');
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { if ((await handle.stat()).size > 262144) throw new Error('文本预览超过 256 KiB'); const bytes = await handle.readFile(); if (createHash('sha256').update(bytes).digest('hex') !== file.version) throw new Error('快照完整性校验失败'); return { content: bytes.toString('utf8'), version: file.version }; } finally { await handle.close(); }
  }
  async dispose() { this.stopping = true; this.descriptionWatcher?.close(); this.externalWatcher?.close(); for (const timer of this.descriptionChanges.values()) clearTimeout(timer); this.descriptionChanges.clear(); this.fileDescriptions.dispose(); await this.operations.catch(() => undefined); await this.files.drain(); this.db.close(); }
}

export async function apply(ctx: Context, config: Config) {
  const storage: TaskStorage | undefined = config.softwareBackend === 'none' ? { projectsRoot: join(resolve(config.dataRoot), LOCAL_FILES_FOLDER) }
    : config.vmProjectsRoot ? { projectsRoot: config.vmProjectsRoot, workspaces: new VmWorkspaces(new VmClient(config.vmEndpoint, config.vmTrustedHttpOrigins, 10000), config.vmStopTimeoutMs) } : undefined;
  const domain = new StudioDomain(resolve(config.dataRoot), config.legacyWorkspaceIds, config.maxFileBytes, config.workflowMode, storage, config.softwareBackend); await domain.initialize();
  ctx.effect(() => { const unprovide = ctx.provide('studioDomain', domain); return async () => { await domain.dispose(); await unprovide(); }; }, 'studio: domain');
  ctx.inject(['studio', 'llm', 'studioModels'], inner => { inner.effect(() => domain.bindFileDescriptionGenerator(nativeFileDescriptionGenerator(inner)), 'studio: native file descriptions'); });
  const routes: [string, ConnectionFetchMethod[], (request: Request) => unknown][] = [
    ['/api/studio/projects', ['GET', 'POST'], request => request.method === 'GET' ? domain.projects() : request.json().then(value => domain.createProject(value))],
    ['/api/studio/directory', ['GET'], () => domain.directory()],
    ['/api/studio/graph', ['GET'], request => domain.graph(new URL(request.url).searchParams.get('projectId') ?? '')],
    ['/api/studio/task', ['GET', 'POST'], async request => { if (request.method === 'GET') return domain.view(new URL(request.url).searchParams.get('id') ?? ''); const data = object(await request.json()); return data.id ? domain.updateTask(String(data.id), data) : domain.createTask(text(data.projectId, '项目'), data); }],
    ['/api/studio/task/metadata', ['POST'], async request => { const data = exactFields(await request.json(), ['id', 'revision', 'title', 'goal', 'checklist'], '任务 Metadata'); const { id, ...changes } = data; return domain.updateTaskMetadata(text(id, '任务'), changes); }],
    ['/api/studio/task/quick', ['POST'], async request => { const data = object(await request.json()); return domain.createQuickTask(text(data.projectId, '项目'), data); }],
    ['/api/studio/dependencies', ['POST'], async request => { const data = object(await request.json()); return domain.setDependencies(text(data.id, '任务'), data); }],
    ['/api/studio/dependencies/preview', ['POST'], async request => { const data = object(await request.json()); return domain.setDependenciesPreview(text(data.id, '任务'), data); }],
    ['/api/studio/dependencies/reconnect', ['POST'], async request => domain.reconnectDependencies(await request.json())],
    ['/api/studio/dependencies/reconnect/preview', ['POST'], async request => domain.reconnectDependenciesPreview(await request.json())],
    ['/api/studio/task/action', ['POST'], async request => { const data = object(await request.json()); return domain.action(text(data.id, '任务'), data); }],
    ['/api/studio/task/completion/files', ['POST'], async request => { const data = exactFields(await request.json(), ['taskId', 'revision', 'workspaceVersion', 'files'], '提交工作文件'); const { taskId, ...submission } = data; return domain.submitCompletionFiles(text(taskId, '任务'), submission); }],
    ['/api/studio/task/completion', ['GET', 'POST'], async request => {
      if (request.method === 'GET') return domain.completionPreview(text(new URL(request.url).searchParams.get('taskId'), '任务'));
      const data = exactFields(await request.json(), ['taskId', 'revision', 'workspaceVersion', 'checkedGoalIds', 'submissionId', 'confirmWithoutFiles', 'childrenVersion'], '完成确认');
      const { taskId, ...confirmation } = data;
      return domain.confirmCompletion(text(taskId, '任务'), confirmation);
    }],
    ['/api/studio/snapshot', ['GET'], request => { const query = new URL(request.url).searchParams; return domain.snapshotView(query.get('taskId') ?? '', query.get('id') ?? undefined); }],
    ['/api/studio/snapshot/manifest', ['GET'], request => { const query = new URL(request.url).searchParams; return domain.snapshotManifest(query.get('taskId') ?? '', query.get('snapshotId') ?? ''); }],
    ['/api/studio/snapshot/preview', ['GET'], request => { const query = new URL(request.url).searchParams; return domain.snapshotPreview(query.get('taskId') ?? '', query.get('snapshotId') ?? '', query.get('path') ?? ''); }],
    ['/api/studio/snapshot/file', ['GET'], request => { const query = new URL(request.url).searchParams; return domain.snapshotFile(query.get('taskId') ?? '', query.get('snapshotId') ?? '', query.get('path') ?? ''); }],
  ];
  for (const [path, methods, action] of routes) ctx.connection.fetch.register({ path, methods, requestBody: 'buffered', async fetch(request) {
    try { return Response.json(await domain.webAction(request, async () => action(request))); }
    catch (error) { return Response.json({ error: error instanceof Error ? error.message : '项目操作失败' }, { status: 400 }); }
  } });
}
