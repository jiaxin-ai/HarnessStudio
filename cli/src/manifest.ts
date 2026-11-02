/** tasks.yaml (cli/设计.md §7.2): strict, reports every problem at once, and starts nothing while any remains. */
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, relative, resolve, isAbsolute, sep } from 'node:path';
import { LineCounter, isMap, parseDocument, type Document, type Pair } from 'yaml';
import { BUDGET_FIELDS, objectiveOf, type Budget, type Issue, type Manifest, type ModelField, type TaskFile, type TaskSpec } from './spec.ts';

const MAX_OBJECTIVE = 8000, MAX_NAME = 200, MAX_PREFIX = 100, MAX_PARALLEL = 20;
/** Studio's WORKSPACE_UPLOAD_MAX_BYTES. */
const MAX_FILE_BYTES = 1024 ** 3;
const TOP_FIELDS = ['defaults', 'tasks'], MODEL_FIELDS = ['orchestratorModel', 'workerModel', 'workerModels'];
const DEFAULT_FIELDS = [...MODEL_FIELDS, 'budget', 'parallel', 'projectPrefix'], TASK_FIELDS = ['name', 'goal', 'files', 'budget', ...MODEL_FIELDS];

const inside = (path: string, root: string) => { const rest = relative(root, path); return rest === '' || (!rest.startsWith(`..${sep}`) && rest !== '..' && !isAbsolute(rest)); };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

class Checker {
  readonly issues: Issue[] = [];
  private readonly doc: Document;
  private readonly lines: LineCounter;
  constructor(doc: Document, lines: LineCounter) { this.doc = doc; this.lines = lines; }
  private lineOfOffset(offset: number | undefined) { return offset === undefined ? undefined : this.lines.linePos(offset).line; }
  /** The line of the value at `path`, or of its nearest ancestor when it has none (for example behind an alias). */
  line(path: readonly (string | number)[]): number | undefined {
    for (let depth = path.length; depth > 0; depth--) {
      const node = this.doc.getIn(path.slice(0, depth), true) as { range?: [number, number, number] } | undefined;
      if (node?.range) return this.lineOfOffset(node.range[0]);
    }
    return undefined;
  }
  add(path: readonly (string | number)[], message: string, task?: string) { this.issues.push({ line: this.line(path), ...(task === undefined ? {} : { task }), message }); }
  /** Refuse unknown fields, reporting each at its own key so a typo is easy to find. */
  fields(value: Record<string, unknown>, allowed: readonly string[], path: readonly (string | number)[], task?: string) {
    const node = path.length ? this.doc.getIn(path, true) : this.doc.contents, items = isMap(node) ? node.items as Pair<{ range?: [number, number, number]; value?: unknown }>[] : [];
    for (const key of Object.keys(value)) {
      if (allowed.includes(key)) continue;
      const pair = items.find(item => String(item.key?.value ?? '') === key);
      this.issues.push({ line: this.lineOfOffset(pair?.key?.range?.[0]) ?? this.line(path), ...(task === undefined ? {} : { task }), message: `未知字段「${key}」。这里可以写：${allowed.join('、')}` });
    }
  }
  budget(value: unknown, path: readonly (string | number)[], task?: string): Budget {
    if (value === undefined) return {};
    if (!record(value)) { this.add(path, 'budget 要写成字段和数值，例如 { tokens: 20000000, hours: 2 }', task); return {}; }
    this.fields(value, Object.keys(BUDGET_FIELDS), path, task);
    const budget: Budget = {};
    for (const [key, limit] of Object.entries(BUDGET_FIELDS) as [keyof Budget, typeof BUDGET_FIELDS[keyof Budget]][]) {
      const item = value[key];
      if (item === undefined) continue;
      if (typeof item !== 'number' || !Number.isFinite(item) || item < limit.min || item > limit.max || (limit.integer && !Number.isInteger(item))) {
        this.add([...path, key], `${limit.label}要在 ${limit.min} 到 ${limit.max} 之间${limit.integer ? '，且是整数' : ''}`, task); continue;
      }
      budget[key] = item;
    }
    return budget;
  }
  model(value: unknown, path: readonly (string | number)[], label: string, task?: string): ModelField | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !value.trim()) { this.add(path, `${label}要写模型名，或 provider/模型名`, task); return undefined; }
    return { name: value.trim(), line: this.line(path) };
  }
  models(value: unknown, path: readonly (string | number)[], task?: string): ModelField[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) { this.add(path, 'workerModels 要写成列表，例如 [deepseek-flash]', task); return undefined; }
    return value.flatMap((item, index) => this.model(item, [...path, index], '可换用的子 Agent 模型', task) ?? []);
  }
}

async function taskFiles(checker: Checker, value: unknown, path: readonly (string | number)[], task: string, directory: string, roots: readonly string[]): Promise<TaskFile[]> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) { checker.add(path, 'files 要写成文件路径的列表', task); return []; }
  const files: TaskFile[] = [];
  for (const [index, entry] of value.entries()) {
    const at = [...path, index];
    if (typeof entry !== 'string' || !entry.trim()) { checker.add(at, 'files 里的每一项都要是文件路径', task); continue; }
    let source: string;
    try { source = await realpath(resolve(directory, entry)); }
    catch { checker.add(at, `找不到文件：${entry}（相对路径从清单所在目录算起）`, task); continue; }
    if (!roots.some(root => inside(source, root))) {
      checker.add(at, `文件 ${entry} 不在当前目录或清单所在目录里，批量命令读不到它。请把它放到 ${directory} 下面`, task); continue;
    }
    const info = await stat(source);
    if (!info.isFile()) { checker.add(at, `${entry} 不是文件。要上传文件夹里的内容，请逐个列出`, task); continue; }
    if (info.size > MAX_FILE_BYTES) { checker.add(at, `文件 ${entry} 超过上传上限 1 GB`, task); continue; }
    const target = basename(resolve(directory, entry));
    if (files.some(file => file.target === target)) { checker.add(at, `有两个文件都叫 ${target}。它们都放在共享盘根目录，名字不能相同`, task); continue; }
    files.push({ source, target, bytes: info.size });
  }
  return files;
}

/** `tasks` holds what could be read even when there are issues, so their models can be checked in the same pass. */
export async function loadManifest(path: string, cwd: string): Promise<{ manifest?: Manifest; tasks: TaskSpec[]; issues: Issue[] }> {
  let source: Buffer;
  try { source = await readFile(path); }
  catch (error) { return { tasks: [], issues: [{ message: `读不到任务清单 ${path}：${(error as NodeJS.ErrnoException).code === 'ENOENT' ? '文件不存在' : (error as Error).message}` }] }; }
  const lines = new LineCounter(), doc = parseDocument(source.toString('utf8'), { lineCounter: lines });
  if (doc.errors.length) return { tasks: [], issues: doc.errors.map(error => ({ ...(error.linePos ? { line: error.linePos[0].line } : {}), message: `YAML 写法有误：${error.message.split('\n')[0]}` })) };
  const checker = new Checker(doc, lines), root: unknown = doc.toJS();
  if (!record(root)) return { tasks: [], issues: [{ message: '任务清单是空的，或者不是字段的形式。至少要有 tasks 列表' }] };
  checker.fields(root, TOP_FIELDS, []);
  const defaults = root.defaults === undefined ? {} : root.defaults;
  if (!record(defaults)) { checker.add(['defaults'], 'defaults 要写成字段的形式'); return { tasks: [], issues: checker.issues }; }
  checker.fields(defaults, DEFAULT_FIELDS, ['defaults']);
  const shared = {
    orchestratorModel: checker.model(defaults.orchestratorModel, ['defaults', 'orchestratorModel'], '总 Agent 模型'),
    workerModel: checker.model(defaults.workerModel, ['defaults', 'workerModel'], '子 Agent 模型'),
    workerModels: checker.models(defaults.workerModels, ['defaults', 'workerModels']) ?? [],
    budget: checker.budget(defaults.budget, ['defaults', 'budget']),
  };
  const parallel = defaults.parallel ?? 1;
  if (!Number.isInteger(parallel) || (parallel as number) < 1 || (parallel as number) > MAX_PARALLEL) checker.add(['defaults', 'parallel'], `parallel 要写 1 到 ${MAX_PARALLEL} 之间的整数`);
  const prefix = defaults.projectPrefix ?? '批量';
  if (typeof prefix !== 'string' || !prefix.trim() || prefix.length > MAX_PREFIX) checker.add(['defaults', 'projectPrefix'], `projectPrefix 要写 1 到 ${MAX_PREFIX} 个字的文字`);

  if (!Array.isArray(root.tasks) || !root.tasks.length) { checker.add(['tasks'], 'tasks 要写成列表，至少有一个任务'); return { tasks: [], issues: checker.issues }; }
  const directory = dirname(path), roots = [await realpath(cwd), await realpath(directory)];
  const tasks: TaskSpec[] = [], names = new Set<string>();
  for (const [index, row] of (root.tasks as unknown[]).entries()) {
    const path = ['tasks', index];
    if (!record(row)) { checker.add(path, '每个任务都要有 name 和 goal'); continue; }
    const label = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : `第 ${index + 1} 个`;
    checker.fields(row, TASK_FIELDS, path, label);
    if (typeof row.name !== 'string' || !row.name.trim() || row.name.trim().length > MAX_NAME) checker.add([...path, 'name'], `name 要写 1 到 ${MAX_NAME} 个字的任务名`, label);
    else if (names.has(label)) checker.add([...path, 'name'], '任务名在清单里重复了', label);
    names.add(label);
    if (typeof row.goal !== 'string' || !row.goal.trim()) checker.add([...path, 'goal'], 'goal 要写清楚这个任务要做成什么', label);
    const files = await taskFiles(checker, row.files, [...path, 'files'], label, directory, roots);
    if (typeof row.goal === 'string' && objectiveOf(row.goal, files).length > MAX_OBJECTIVE) checker.add([...path, 'goal'], `goal 太长：加上文件说明后不能超过 ${MAX_OBJECTIVE} 个字`, label);
    const orchestratorModel = checker.model(row.orchestratorModel, [...path, 'orchestratorModel'], '总 Agent 模型', label), workerModel = checker.model(row.workerModel, [...path, 'workerModel'], '子 Agent 模型', label);
    tasks.push({
      name: label, goal: typeof row.goal === 'string' ? row.goal : '', files, line: checker.line(path), budget: { ...shared.budget, ...checker.budget(row.budget, [...path, 'budget'], label) },
      workerModels: checker.models(row.workerModels, [...path, 'workerModels'], label) ?? shared.workerModels,
      ...orchestratorModel ?? shared.orchestratorModel ? { orchestratorModel: (orchestratorModel ?? shared.orchestratorModel)! } : {},
      ...workerModel ?? shared.workerModel ? { workerModel: (workerModel ?? shared.workerModel)! } : {},
    });
  }
  if (checker.issues.length) return { tasks, issues: checker.issues };
  return { tasks, issues: [], manifest: { path, directory, sha256: createHash('sha256').update(source).digest('hex'), parallel: parallel as number, projectPrefix: (prefix as string).trim(), tasks } };
}
