export type WorkflowMode = 'single-user' | 'reviewed';
export const stateNames = { unstarted: '待执行', working: '进行中', completed: '已完成', recheck: '待复核' } as const;
export const reviewedStateNames = { unstarted: '未开始', allocated: '已分配', working: '进行中', review: '待复核', accepted: '已验收', revoked: '验收撤销', discarded: '已废弃' } as const;
export type SingleUserTaskState = keyof typeof stateNames;
export type ReviewedTaskState = keyof typeof reviewedStateNames;
export type TaskState = SingleUserTaskState | ReviewedTaskState;
export function currentStateNames(mode: WorkflowMode = 'single-user') { return mode === 'single-user' ? stateNames : reviewedStateNames; }
export function isCurrentTaskState(state: string, mode: WorkflowMode = 'single-user'): state is TaskState { return Object.hasOwn(currentStateNames(mode), state); }
export interface Criterion {
  id: string; label: string; kind: 'numeric' | 'check'; method: string; unit?: string;
  rule?: 'eq' | 'gte' | 'lte' | 'range'; target?: number; min?: number; max?: number; tolerance?: number;
}
export interface ChecklistItem { id: string; text: string }
export interface TaskDefinition {
  title: string; kind: 'task' | 'group'; goal: string; constraints: string; parentId?: string;
  criteria: Criterion[]; outputs: string[]; unresolved: string[];
  /** Text acceptance checklist; absent on historical definitions, whose criteria remain readable. */
  checklist?: ChecklistItem[];
}
export interface InputRef { taskId: string; snapshotId: string }
export interface Project { id: string; title: string; goal: string; constraints: string; revision: number; createdAt: string }
export interface ProjectDeletePreview {
  projectId: string; projectRevision: number; title: string;
  taskCount: number; snapshotCount: number; reviewCount: number; retry: boolean;
}
export interface ProjectDeleteResult { projectId: string; taskIds: string[] }
export interface Task extends TaskDefinition {
  /** Stable internal references stay separate from the five-character public task ID. */
  id: string; code: string; rank: number; projectId: string; state: TaskState; assignee?: string; revision: number;
  /** Persistent data epoch prevents a pre-clear conversation from reopening this node. */
  dataGeneration?: number;
  dependencies: string[]; inputs: InputRef[]; candidateId?: string; acceptedId?: string;
  completedId?: string; archived?: boolean; workflowMode?: WorkflowMode;
  /** Original reviewed lifecycle survives the additive single-user migration. */
  legacyLifecycle?: { state: ReviewedTaskState; candidateId?: string; acceptedId?: string; inputs: InputRef[]; revision: number };
  replacesId?: string; pending?: string; pendingAction?: 'complete' | 'resume' | 'delete' | 'clear' | 'dependencies'; pendingOwnerId?: string; pendingMeasurements?: Measurement[]; pendingConfirmation?: HumanCompletionConfirmation; createdAt: string;
  /** The previous result is historical until a person reviews the current inputs. */
  recheckReason?: string;
  /** A removed predecessor/result requires a human to explicitly reset valid dependencies. */
  dependencyRepairRequired?: boolean;
  completionSubmission?: CompletionFileSubmission;
}
export function resultSnapshotId(task: Pick<Task, 'state' | 'completedId' | 'acceptedId' | 'archived' | 'pending' | 'dependencyRepairRequired'>, mode: WorkflowMode = 'single-user'): string | undefined {
  if (task.archived || task.pending || task.dependencyRepairRequired) return;
  return mode === 'single-user' ? task.state === 'completed' ? task.completedId : undefined : task.state === 'accepted' ? task.acceptedId : undefined;
}
export function taskSnapshotId(task: Pick<Task, 'completedId' | 'candidateId' | 'acceptedId'>, mode: WorkflowMode = 'single-user'): string | undefined { return mode === 'single-user' ? task.completedId ?? task.candidateId ?? task.acceptedId : task.candidateId ?? task.acceptedId ?? task.completedId; }
export interface Measurement { criterionId: string; observed: number | boolean; evidence: string; note: string }
export interface SnapshotFile { path: string; version: string; bytes: number; createdAt?: string; modifiedAt?: string }
/** Mutable suggestion for the current working copy; never part of an immutable snapshot manifest. */
export interface FileSubmissionDescription { text: string; version: string; status: 'pending' | 'generated' | 'fallback' }
export interface CompletionWorkspaceFile extends SnapshotFile { submissionDescription?: FileSubmissionDescription }
export interface SubmittedFile extends SnapshotFile { description: string }
export interface CompletionFileSubmission {
  id: string; taskRevision: number; workspaceVersion: string; submittedAt: string; files: SubmittedFile[];
  /** Version 1 receipts point to a separately persisted, immutable file commit. */
  storageVersion?: 1;
}
export interface CompletionGoal { id: string; label: string; system?: boolean; checked?: boolean;
  /** What an Agent checked for this goal, how, and the result; absent on human confirmations. */
  evidence?: string;
}
/** The autonomy run, conversation and model that confirmed a completion. */
export interface AgentCompletionActor { runId: string; chatId: string; provider: string; model: string }
/** An Agent's completion request: evidence for every goal of the preview, then files to submit or an explicit none. */
export interface AgentCompletionInput {
  revision: number; workspaceVersion: string; childrenVersion?: string;
  evidence: { goal: string; checklist: { id: string; evidence: string }[] };
  files?: { path: string; description: string }[];
  withoutFiles?: true;
}
/** Human acknowledgement is separate from measured evidence; it never invents numeric results. Autonomy mode stores
 * Agent confirmations under the same name, so historical records stay readable. */
export interface HumanCompletionConfirmation { goals: CompletionGoal[]; confirmedAt: string; workspaceVersion: string;
  /** Explicit second confirmation to finish without submitting any workspace files. */
  withoutSubmittedFiles?: boolean;
  /** Direct child versions explicitly reviewed when completing a folder. */
  childrenVersion?: string;
  /** Absent on human and historical confirmations. */
  actor?: 'human' | 'agent';
  agent?: AgentCompletionActor;
}
export interface TaskCompletionChild { taskId: string; code: string; title: string; state: TaskState; isFolder: boolean; ready: boolean; snapshotId?: string }
export interface TaskCompletionPreview {
  taskId: string; projectId: string; code: string; title: string; taskRevision: number;
  isFolder: boolean; isRecheck?: boolean; children: TaskCompletionChild[]; childrenVersion?: string;
  goals: CompletionGoal[]; files: CompletionWorkspaceFile[]; workspaceVersion: string; blockers: string[]; retry: boolean; submittedFiles?: CompletionFileSubmission;
  /** Legacy receipts or damaged commits never appear as successfully submitted. */
  submissionWarning?: string;
}
export interface TaskCompletionResult { task: TaskView; warning?: string }
export interface Snapshot {
  id: string; taskId: string; createdAt: string; definition: TaskDefinition; inputs: InputRef[];
  measurements: Measurement[]; files: SnapshotFile[];
  /** Folder submissions refer to direct children's immutable completed or accepted snapshots. */
  childrenRefs?: InputRef[];
  humanConfirmation?: HumanCompletionConfirmation;
  submittedFiles?: CompletionFileSubmission;
}
export interface SnapshotManifestView { snapshot: Snapshot; unavailableRefs: InputRef[] }
export interface Review { id: string; taskId: string; snapshotId: string; action: 'accept' | 'reject' | 'reaccept' | 'discard'; reason: string; actor: string; inputs: InputRef[]; createdAt: string }
export interface LeafStats { total: number; states: Record<TaskState, number> }
export interface TaskView extends Task { checklist: ChecklistItem[]; canEditMetadata: boolean; workflowMode: WorkflowMode; blockers: string[]; definitionIssues: string[]; writable: boolean; canDiscuss: boolean; isFolder: boolean; childCount: number; leafStats: LeafStats;
  /** Present only on the initiating task of a persisted, frozen relation change. */
  pendingDependencyRequest?: DependencyChangeRequest;
  /** Who confirmed the current valid result; absent while there is none. */
  completedBy?: 'human' | 'agent';
}
export interface ProjectGraph { workflowMode: WorkflowMode; project: Project; tasks: TaskView[] }
export type TaskDirectoryEntry = Pick<TaskView, 'id' | 'code' | 'rank' | 'projectId' | 'title' | 'kind' | 'state' | 'parentId' | 'isFolder' | 'childCount' | 'leafStats' | 'workflowMode' | 'archived' | 'dependencyRepairRequired'>;
/**
 * A task conversation keeps taskId as its stable owner/default parent while the
 * graph planner may operate on the complete same-project graph. Internal
 * metadata readers can request the legacy subtree-only view without granting
 * broader checklist or engineering-context access.
 */
export interface GraphPlanningScope { projectId: string; taskId?: string; subtreeOnly?: true }
export type PlanningDefinitionChanges = Partial<Pick<TaskDefinition, 'title' | 'goal' | 'constraints' | 'criteria' | 'outputs' | 'unresolved' | 'checklist'>>;
export interface GraphPatchCreate {
  key: string;
  definition: Pick<TaskDefinition, 'title'> & Partial<Omit<TaskDefinition, 'title' | 'kind' | 'parentId'>> & { kind?: 'task' };
  /** Existing internal task ID or a batch-local reference such as "$gear". */
  parentId?: string | null;
  dependencies?: string[];
}
export interface GraphPatch {
  revision: number;
  creates?: GraphPatchCreate[];
  updates?: { id: string; changes: PlanningDefinitionChanges }[];
  moves?: { id: string; parentId: string | null }[];
  dependencies?: { id: string; dependencies: string[] }[];
  /** Recoverably remove pure draft leaves from the active graph. */
  removes?: { id: string }[];
}
export interface PlanningTask extends TaskView {
  canUpdateDefinition: boolean; canMove: boolean; canSetDependencies: boolean; canRemove: boolean; planningBlockers: string[];
}
export interface GraphPlanningContext {
  scope: GraphPlanningScope; project: Project; currentTask?: TaskView;
  breadcrumb: { id: string; title: string; code?: string }[];
  tasks: PlanningTask[]; total: number; offset: number; limit: number; nextOffset?: number; truncated: boolean;
}
export interface GraphPatchResult {
  revision: number;
  created: (TaskView & { key: string })[];
  updated: TaskView[]; moved: TaskView[]; dependencies: TaskView[];
  /** Removed drafts are archived rather than hard-deleted, preserving audit data. */
  removed: Pick<Task, 'id' | 'code' | 'title' | 'parentId'>[];
}
/** Human-only browsing of task workspaces; private chat temporary files are excluded. */
export interface WorkspaceDirectoryEntry {
  name: string; path: string; kind: 'file' | 'directory'; bytes?: number; modifiedAt?: string;
}
export interface WorkspaceDirectoryListing {
  path: string; entries: WorkspaceDirectoryEntry[]; offset: number; limit: number; total: number; nextOffset?: number;
}
export type WorkspaceFilePreview =
  | { path: string; bytes: number; status: 'text'; content: string; version: string }
  | { path: string; bytes: number; status: 'binary' | 'tooLarge' };
export interface ProjectWorkspaceDirectory extends WorkspaceDirectoryListing { projectId: string; taskId: string }
export type ProjectWorkspaceFilePreview = WorkspaceFilePreview & { projectId: string; taskId: string };
export interface TaskDeleteImpact { id: string; code: string; title: string; state: TaskState; reason: 'dependency' | 'summary' }
export interface TaskDeletePreview {
  taskId: string; projectId: string; taskRevision: number; projectRevision: number;
  title: string; code: string; state: TaskState; workspace: true;
  snapshotCount: number; reviewCount: number; affected: TaskDeleteImpact[]; retry: boolean;
}
export interface TaskDeleteResult { taskId: string; projectId: string; affectedIds: string[] }
export interface TaskClearPreview extends TaskDeletePreview {
  /** Clearing a folder removes its own data only; descendants and graph relations survive. */
  childCount: number; preservedChildren: true;
}
export interface TaskClearResult { task: TaskView; projectId: string; affectedIds: string[] }
export interface DependencyEndpoint { source: string; target: string }
export type DependencyChangeRequest =
  | { kind: 'set'; id: string; revision: number; projectRevision: number; dependencies: string[] }
  | { kind: 'reconnect'; projectId: string; projectRevision: number; edge: DependencyEndpoint; connection: DependencyEndpoint };
export interface DependencyChangeImpact {
  id: string; code: string; title: string; state: TaskState;
  reason: 'dependency' | 'summary'; willRecheck: boolean; willResetWork: boolean; description: string;
}
export interface DependencyChangePreview {
  request: DependencyChangeRequest; projectId: string; projectRevision: number; impactVersion: string;
  requiresConfirmation: boolean; affected: DependencyChangeImpact[]; retry: boolean;
}
