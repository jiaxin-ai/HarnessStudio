import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { resultSnapshotId, type GraphPlanningScope, type InputRef, type Snapshot, type TaskView } from './domain-types.ts';
import type { StudioDomain } from './domain.ts';
import type {} from './index.ts';
import { loadPromptFile } from './prompt-loader.ts';
import { throwIfAborted } from './abort.ts';

export const name = 'harnessstudio-engineering-context';
export const inject = ['studio', 'studioDomain', 'tools'];
export interface Config { promptPath: string; maxOutputBytes: number }
export const Config: z<Config> = z.object({ promptPath: z.string().required(), maxOutputBytes: z.natural().min(32768).max(65536).default(65536) });

export type EngineeringContextCategory = 'all' | 'definition' | 'checklist' | 'inputs';
export interface EngineeringContextQuery { category?: EngineeringContextCategory; query?: string; offset?: number; limit?: number; revision?: number }
export interface ContextTruncation { field: string; originalLength: number; returnedLength: number; unit: 'characters' | 'items' }
export interface ContextReference { tool: string; arguments: Record<string, string | number>; locator?: string }
export interface EngineeringContextItem {
  kind: 'definition' | 'checklist' | 'input-snapshot' | 'input-file';
  authority: 'current-definition' | 'current-input' | 'historical-input';
  taskId: string; taskRevision?: number; code?: string; state?: string;
  definition?: unknown; checklist?: { id: string; text: string };
  provenance?: { snapshotId: string; capturedAt?: string; rootInput: InputRef; parentSnapshotId?: string; depth: number };
  availability?: 'recorded' | 'unavailable'; validityReason?: string; filesTotal?: number; childrenTotal?: number;
  file?: { path: string; bytes: number; version: string; createdAt?: string; modifiedAt?: string; description?: string };
  references: ContextReference[]; fieldTruncations?: ContextTruncation[];
}
export interface EngineeringContextPage {
  schemaVersion: 1; source: 'studio-domain'; readAt: string; scope: GraphPlanningScope; projectRevision: number; currentTaskRevision: number | null;
  category: EngineeringContextCategory; query: string; items: EngineeringContextItem[]; total: number; offset: number; limit: number; nextOffset?: number;
  truncated: boolean; pageTruncated: boolean; fieldsTruncated: boolean; byteLimited: boolean; maxOutputBytes: number; notes: string[];
}
type ContextDomain = Pick<StudioDomain, 'planningContext' | 'view' | 'task' | 'snapshotManifest'>;
const categories = new Set<EngineeringContextCategory>(['all', 'definition', 'checklist', 'inputs']);
export const engineeringContextScanLimits = Object.freeze({ tasks: 10000, inputSnapshots: 2000, inputReferences: 10000, inputFiles: 100000 });
const notes = [
  'Current definitions and checklists are recorded requirements, not measured or independently verified engineering facts.',
  'Input references identify human-confirmed immutable versions; confirmation does not constitute independent engineering validation. Historical inputs must not be used as current valid results.',
  'This retrieval returns no workspace file content and grants no workspace authority. An active task conversation may separately use studio_read_project_file for mutable same-project, non-archived task-workspace references (formalInput=false); use studio_read_file only for already-authorized immutable input snapshots. Private conversation temporary files remain inaccessible.',
  'Field truncations contain exact prefixes, never inferred summaries. Re-read the cited definition/checklist source when a full field is required; continue nextOffset for additional items using projectRevision as revision.',
];

/** The public tool has no caller-supplied owner IDs or paths, including hidden arguments. */
export function engineeringContextQuery(value: unknown): Required<Omit<EngineeringContextQuery, 'revision'>> & Pick<EngineeringContextQuery, 'revision'> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['category', 'query', 'offset', 'limit', 'revision'].includes(key))) throw new Error('工程上下文查询仅允许 category、query、offset、limit、revision');
  const args = value as Record<string, unknown>, category = args.category === undefined ? 'all' : args.category;
  if (typeof category !== 'string' || !categories.has(category as EngineeringContextCategory)) throw new Error('工程上下文类别不合法');
  if (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 256 || /[\u0000-\u001f\u007f]/.test(args.query))) throw new Error('检索文字须不超过 256 字符，且不能包含控制字符');
  const offset = args.offset === undefined ? 0 : args.offset, limit = args.limit === undefined ? 20 : args.limit;
  if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100) throw new Error('工程上下文分页不合法；limit 须为 1 到 100');
  if (args.revision !== undefined && (!Number.isSafeInteger(args.revision) || Number(args.revision) < 0)) throw new Error('工程上下文 revision 须为非负项目版本');
  return { category: category as EngineeringContextCategory, query: typeof args.query === 'string' ? args.query.trim() : '', offset: Number(offset), limit: Number(limit), ...(args.revision === undefined ? {} : { revision: Number(args.revision) }) };
}

/** Limit individual source fields before applying a separate lossless page byte cap. */
function boundedSource(value: unknown): { value: unknown; truncations: ContextTruncation[] } {
  const truncations: ContextTruncation[] = []; let bytesLeft = 12000, nodesLeft = 200;
  const visit = (current: unknown, field: string): unknown => {
    if (typeof current === 'string') {
      const bytes = Math.min(8192, bytesLeft); let end = current.length;
      if (Buffer.byteLength(current) > bytes) {
        let low = 0, high = current.length;
        while (low < high) { const middle = Math.ceil((low + high) / 2); if (Buffer.byteLength(current.slice(0, middle)) <= bytes) low = middle; else high = middle - 1; }
        end = low;
        if (end && /[\uD800-\uDBFF]/.test(current[end - 1])) end--;
        truncations.push({ field, originalLength: current.length, returnedLength: end, unit: 'characters' });
      }
      const text = current.slice(0, end); bytesLeft -= Buffer.byteLength(text); return text;
    }
    if (Array.isArray(current)) {
      const output: unknown[] = [];
      for (let index = 0; index < current.length && nodesLeft > 0 && bytesLeft > 0; index++) { nodesLeft--; output.push(visit(current[index], `${field}/${index}`)); }
      if (output.length < current.length) truncations.push({ field, originalLength: current.length, returnedLength: output.length, unit: 'items' });
      return output;
    }
    if (current && typeof current === 'object') return Object.fromEntries(Object.entries(current).map(([key, child]) => [key, visit(child, `${field}/${key}`)]));
    return current;
  };
  return { value: visit(value, ''), truncations };
}
function definitionSource(task: Pick<TaskView, 'title' | 'goal' | 'constraints' | 'criteria' | 'outputs' | 'unresolved'>) {
  return { title: task.title, goal: task.goal, constraints: task.constraints, criteria: task.criteria, outputs: task.outputs, unresolved: task.unresolved };
}
function boundedItem(item: EngineeringContextItem): EngineeringContextItem {
  const source = item.definition ?? item.checklist ?? item.file;
  if (source === undefined) return item;
  const bounded = boundedSource(source), field = item.definition !== undefined ? 'definition' : item.checklist !== undefined ? 'checklist' : 'file';
  return { ...item, [field]: bounded.value, ...(bounded.truncations.length ? { fieldTruncations: bounded.truncations.map(row => ({ ...row, field: `/${field}${row.field}` })) } : {}) };
}
function liveResult(task: TaskView): string | undefined { return task.blockers.length ? undefined : resultSnapshotId(task, task.workflowMode); }
function sourceText(item: EngineeringContextItem): string {
  const strings: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === 'string') strings.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  // Search recorded source fields, not random task IDs/codes or lifecycle labels;
  // otherwise a generated code such as "AbC12" can create flaky false matches.
  [item.definition, item.checklist, item.file, item.provenance].forEach(visit);
  return strings.join('\n').toLowerCase();
}
function currentInput(domain: ContextDomain, owner: TaskView, ref: InputRef, inheritedValid = true): { valid: boolean; reason: string } {
  if (!inheritedValid) return { valid: false, reason: 'ancestor-input-is-historical' };
  if (owner.state === 'recheck' || owner.state === 'revoked' || owner.pending || owner.archived || owner.dependencyRepairRequired) return { valid: false, reason: 'current-task-awaits-review-or-repair' };
  try {
    const task = domain.view(ref.taskId);
    if (task.projectId !== owner.projectId || liveResult(task) !== ref.snapshotId) return { valid: false, reason: 'upstream-current-result-changed-or-invalid' };
    return { valid: true, reason: 'matches-current-human-confirmed-input' };
  } catch { return { valid: false, reason: 'upstream-task-or-result-unavailable' }; }
}

function* inputItems(domain: ContextDomain, scope: GraphPlanningScope, owner: TaskView): Generator<EngineeringContextItem> {
  if (owner.inputs.length > engineeringContextScanLimits.inputReferences) throw new Error('实际输入引用超过检索扫描上限，不能将截断的清单视为完整工程上下文');
  const queue = owner.inputs.map(rootInput => ({ ref: rootInput, rootInput, depth: 0, inheritedValid: true, parentSnapshotId: undefined as string | undefined }));
  const seen = new Map<string, string>(); let filesScanned = 0;
  for (let index = 0; index < queue.length; index++) {
    const entry = queue[index], { ref, rootInput, depth, parentSnapshotId } = entry, previousOwner = seen.get(ref.snapshotId);
    if (previousOwner !== undefined) { if (previousOwner !== ref.taskId) throw new Error('实际输入快照引用归属不一致'); continue; }
    if (seen.size >= engineeringContextScanLimits.inputSnapshots) throw new Error('实际输入快照超过检索扫描上限，不能返回伪完整的分页总数；请按已有授权引用分批读取');
    seen.set(ref.snapshotId, ref.taskId);
    const validity = currentInput(domain, owner, ref, entry.inheritedValid);
    const provenance = { snapshotId: ref.snapshotId, rootInput: { ...rootInput }, ...(parentSnapshotId ? { parentSnapshotId } : {}), depth };
    let snapshot: Snapshot;
    try {
      // Exactly the existing studio_read_file authority: actual roots and
      // nested childrenRefs, never a predecessor snapshot's own inputs.
      snapshot = domain.snapshotManifest(scope.taskId!, ref.snapshotId).snapshot;
      if (snapshot.taskId !== ref.taskId || domain.task(ref.taskId).projectId !== scope.projectId) throw new Error('实际输入快照不属于当前项目或引用任务');
    } catch {
      yield { kind: 'input-snapshot', authority: 'historical-input', taskId: ref.taskId, provenance, availability: 'unavailable', validityReason: 'recorded-input-manifest-unavailable', references: [] };
      continue;
    }
    const authority = validity.valid ? 'current-input' : 'historical-input', captured = { ...provenance, capturedAt: snapshot.createdAt };
    filesScanned += snapshot.files.length;
    if (filesScanned > engineeringContextScanLimits.inputFiles) throw new Error('实际输入文件超过检索扫描上限，不能返回伪完整的分页总数；请按已有授权引用分批读取');
    yield { kind: 'input-snapshot', authority, taskId: snapshot.taskId, provenance: captured, availability: 'recorded', validityReason: validity.reason,
      definition: definitionSource(snapshot.definition), filesTotal: snapshot.files.length, childrenTotal: snapshot.childrenRefs?.length ?? 0,
      references: [{ tool: 'studio_task_context', arguments: {}, locator: `snapshot:${snapshot.id}/manifest` }] };
    for (const file of snapshot.files) {
      const description = snapshot.submittedFiles?.files.find(submitted => submitted.path === file.path)?.description;
      yield { kind: 'input-file', authority, taskId: snapshot.taskId, provenance: captured, availability: 'recorded', validityReason: validity.reason,
        file: { ...file, ...(description === undefined ? {} : { description }) },
        references: [{ tool: 'studio_read_file', arguments: { snapshotId: snapshot.id, path: file.path }, locator: `snapshot:${snapshot.id}/files/${file.path}` }] };
    }
    for (const child of snapshot.childrenRefs ?? []) {
      if (queue.length >= engineeringContextScanLimits.inputReferences) throw new Error('实际输入子引用超过检索扫描上限，不能将截断的清单视为完整工程上下文');
      queue.push({ ref: child, rootInput, depth: depth + 1, inheritedValid: validity.valid, parentSnapshotId: snapshot.id });
    }
  }
}

/** Read directly from the current domain; no new fact store, file read or state write. */
export function retrieveEngineeringContext(domain: ContextDomain, scope: GraphPlanningScope, input: unknown = {}, maxOutputBytes = 65536): EngineeringContextPage {
  const args = engineeringContextQuery(input);
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 32768 || maxOutputBytes > 65536) throw new Error('工程上下文输出上限须为 32768 到 65536 字节');
  // Graph planning is project-wide for a task conversation, but retrieval of
  // definitions/checklists deliberately remains bounded to that task subtree.
  const retrievalScope: GraphPlanningScope = { ...scope, ...(scope.taskId ? { subtreeOnly: true } : {}) };
  const initial = domain.planningContext(retrievalScope, { offset: 0, limit: 1 });
  if (args.revision !== undefined && args.revision !== initial.project.revision) throw new Error('项目版本已变化；请从 offset 0 不带 revision 重新检索，再使用新的 projectRevision 继续分页');
  const query = args.query.toLowerCase(), items: EngineeringContextItem[] = []; let total = 0;
  const accept = (item: EngineeringContextItem) => {
    if (query && !sourceText(item).includes(query)) return;
    if (total >= args.offset && items.length < args.limit) items.push(boundedItem(item));
    total++;
  };
  if (args.category !== 'inputs') {
    if (initial.total > engineeringContextScanLimits.tasks) throw new Error('图谱超过 10000 个任务的检索扫描上限；请进入较小的任务子树进行检索，而不要把局部返回视为完整项目');
    for (let offset = 0; offset < initial.total; offset += 100) {
      const page = domain.planningContext(retrievalScope, { offset, limit: 100 });
      for (let index = 0; index < page.tasks.length; index++) {
        const task = page.tasks[index], base = { taskId: task.id, taskRevision: task.revision, code: task.code, state: task.state, authority: 'current-definition' as const };
        if (args.category === 'all' || args.category === 'definition') accept({ ...base, kind: 'definition', definition: definitionSource(task),
          references: [{ tool: 'studio_graph_context', arguments: { offset: offset + index, limit: 1 } }] });
        if (args.category === 'all' || args.category === 'checklist') for (const item of task.checklist) accept({ ...base, kind: 'checklist', checklist: { ...item },
          references: [{ tool: 'studio_read_checklist', arguments: { taskId: task.id } }] });
      }
    }
  }
  if (scope.taskId && (args.category === 'all' || args.category === 'inputs')) {
    for (const item of inputItems(domain, scope, initial.currentTask!)) accept(item);
  }
  const page: EngineeringContextPage = { schemaVersion: 1, source: 'studio-domain', readAt: new Date().toISOString(), scope: { ...initial.scope },
    projectRevision: initial.project.revision, currentTaskRevision: initial.currentTask?.revision ?? null, category: args.category, query: args.query,
    items, total, offset: args.offset, limit: args.limit, truncated: false, pageTruncated: false, fieldsTruncated: false, byteLimited: false, maxOutputBytes, notes: [...notes] };
  const settle = () => {
    const next = args.offset + page.items.length;
    page.pageTruncated = next < total; page.fieldsTruncated = page.items.some(item => !!item.fieldTruncations?.length); page.truncated = page.pageTruncated || page.fieldsTruncated;
    if (page.pageTruncated) page.nextOffset = next; else delete page.nextOffset;
  };
  settle();
  while (Buffer.byteLength(JSON.stringify(page)) > maxOutputBytes && page.items.length > 1) { page.items.pop(); page.byteLimited = true; settle(); }
  if (Buffer.byteLength(JSON.stringify(page)) > maxOutputBytes) throw new Error('单条工程上下文超过输出上限，请使用更窄的类别和检索文字');
  return page;
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const { prompt: instructions } = await loadPromptFile(config.promptPath);
  ctx.effect(() => ctx.studio.registerInstructions('engineering-context', 109, instructions), 'studio-engineering-context: instructions');
  const tool = defineTool({
    name: 'studio_retrieve_context',
    description: 'Retrieve recorded live engineering task definitions/checklist requirements and the current task’s immutable actual-input manifests. Identity is fixed by this conversation: a project owns only its project metadata; a task owns only its own metadata and descendants, plus its already-authorized actual input snapshots and nested childrenRefs. Exact text search, rank-ordered bounded pages and source references. Read current projectRevision; pass it as revision on later pages, restart at offset 0 if it changes. Current requirements are not measurements. Historical inputs are never current valid results. Returns no file content and grants no new read or write authority. Mutable same-project task-workspace references, when separately allowed for an active task conversation, use studio_read_project_file and remain formalInput=false; immutable authorized inputs use studio_read_file.',
    parameters: {
      category: { type: 'string', enum: ['all', 'definition', 'checklist', 'inputs'], description: 'Default all. Project conversations expose no inputs; task inputs are only the currently bound task’s recorded actual inputs.' },
      query: { type: 'string', description: 'Optional exact substring search (case-insensitive), maximum 256 characters. No semantic inference.' },
      offset: { type: 'integer', description: 'Zero-based matched-item offset, default 0. Follow returned nextOffset.' },
      limit: { type: 'integer', description: 'Maximum matched items, default 20; 1 through 100. The byte cap can reduce a page while preserving nextOffset.' },
      revision: { type: 'integer', description: 'Optional projectRevision from the previous page. A mismatch refuses stale pagination; restart offset 0 without revision.' },
    },
    output: { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) { throwIfAborted(exec.signal); return JSON.stringify(retrieveEngineeringContext(ctx.studioDomain, ctx.studio.graphPlanningScope(exec.agent), args, config.maxOutputBytes)); },
  });
  ctx.tools.register({ ...tool, parameters: { ...tool.parameters, additionalProperties: false } });
}
