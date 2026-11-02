/** A checked task list, independent of how it was read, so only manifest.ts needs the YAML parser. */
export interface Budget { tokens?: number; hours?: number; vms?: number; workers?: number; rounds?: number; cacheReadWeight?: number }
export interface TaskFile { source: string; target: string; bytes: number }
/** A model field with the line it was written on, in the task or in defaults. */
export interface ModelField { name: string; line?: number }
export interface TaskSpec {
  name: string; goal: string; files: TaskFile[]; budget: Budget; line?: number;
  orchestratorModel?: ModelField; workerModel?: ModelField; workerModels: ModelField[];
}
export interface Manifest { path: string; directory: string; sha256: string; parallel: number; projectPrefix: string; tasks: TaskSpec[] }
export interface Issue { line?: number; task?: string; message: string }

/** Studio's ranges (LIMITS in plugins/studio/src/autonomy-store.ts), checked here so one bad number starts nothing. */
export const BUDGET_FIELDS = {
  tokens: { label: '折算 token 预算', min: 10_000, max: 100_000_000_000, integer: true, setting: 'tokenBudget' },
  hours: { label: '运行时长（小时）', min: 0.1, max: 720, integer: false, setting: 'maxHours' },
  vms: { label: '同时占用的虚拟机数', min: 0, max: 20, integer: true, setting: 'maxVms' },
  workers: { label: '同时工作的子 Agent 数', min: 1, max: 20, integer: true, setting: 'maxWorkers' },
  rounds: { label: '总 Agent 的轮数上限', min: 1, max: 100_000, integer: true, setting: 'maxRounds' },
  cacheReadWeight: { label: '缓存读取的折算系数', min: 0, max: 1, integer: false, setting: 'cacheReadWeight' },
} as const;

/**
 * The objective the run gets: the goal, plus where the uploaded files are, because nothing else tells the Agent.
 * Without software (status.softwareBackend 'none') Studio has no VM and calls the folder 项目公共空间 only; the VM
 * wording is the longer one, so length checks use it.
 */
export function objectiveOf(goal: string, files: readonly { target: string }[], softwareBackend?: string): string {
  if (!files.length) return goal.trim();
  const where = softwareBackend === 'none' ? '项目公共空间' : '项目公共空间（虚拟机里的 F: 盘）';
  return `${goal.trim()}\n\n已放到${where}根目录的文件：${files.map(file => file.target).join('、')}`;
}
export function issueText(issue: Issue): string {
  const where = [issue.line === undefined ? '' : `第 ${issue.line} 行`, issue.task === undefined ? '' : `任务「${issue.task}」`].filter(Boolean).join('，');
  return where ? `${where}：${issue.message}` : issue.message;
}
