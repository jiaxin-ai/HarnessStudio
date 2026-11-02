/** The Agent's Linux sandbox: one container per conversation, started by sandbox_manager on first use.
 *
 * The sandbox reaches what its conversation may reach: in a task conversation the task's D: (/workspace, read-only
 * once the task is completed or frozen), the project's F: (/shared), completed upstream results (/inputs/<taskId>)
 * and every task's D: of the project read-only (/tasks); in a planning conversation F: and /tasks. Both see the global
 * skill library (/skills) and the installed plugins (/plugins) read-only, so skills marked to run in the sandbox can
 * run their scripts there. It can use the internet through the egress proxy but not the LAN, so platform actions stay
 * with Studio's own tools.
 *
 * The folders are vm_manager's task spaces (D:, F:) with the vm-manager backend, and Studio's own task spaces in its data
 * folder without software (STUDIO_SEAT_BACKEND=none); sandbox_manager then mounts them as subpaths of Studio's data volume.
 *
 * The switch and the limits are set on the settings page and kept in <studio data>/sandbox-settings.json, like the skill
 * and MCP settings; sandbox_manager keeps the ceilings the host owner set. They are not live fields of this plugin's
 * Config: the native settings service copies the whole entry into the user's profile on the first save, and that copy
 * would then hide later changes to the entry in config/studio.patch.yml. */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { randomUUID } from 'node:crypto';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {} from './index.ts';
import type {} from './domain.ts';
import { loadPromptFile } from './prompt-loader.ts';
import { throwIfAborted } from './abort.ts';

export const name = 'harnessstudio-sandbox';
export const inject = ['studio', 'studioDomain', 'tools', 'connection'];
/** noSoftwarePromptPath (default sandbox-no-software-system-prompt.md beside promptPath) replaces promptPath without vm_manager. */
export interface Config { endpoint: string; tokenFile: string; promptPath: string; noSoftwarePromptPath: string; dataRoot: string; maxTimeoutSeconds: number; defaultTimeoutSeconds: number }
export const Config: z<Config> = z.object({
  endpoint: z.string().default(''), tokenFile: z.string().default(''), promptPath: z.string().required(), noSoftwarePromptPath: z.string().default(''), dataRoot: z.string().required(),
  maxTimeoutSeconds: z.natural().min(1).max(1800).default(1800), defaultTimeoutSeconds: z.natural().min(1).max(1800).default(300),
});

export interface SandboxLimits { cpus: number; memoryGb: number; maxRunning: number; idleMinutes: number }
export interface SandboxSettings extends SandboxLimits { enabled: boolean; revision: number }
export const DEFAULT_SETTINGS: SandboxSettings = { enabled: true, cpus: 2, memoryGb: 4, maxRunning: 4, idleMinutes: 30, revision: 0 };
export interface SandboxSettingsView extends SandboxLimits {
  /** Whether this deployment has sandbox_manager and task spaces (vm_manager's, or Studio's own without software); without them the page only explains. */
  configured: boolean; enabled: boolean; revision: number;
  service?: { ok: true; runtime: string; runtimeInstalled: boolean; imagePresent: boolean; running: number; total: number; libraries: boolean; ceilings: { cpus: number; memoryGb: number; maxRunning: number }; host: { cpus: number | null; memoryGb: number | null } } | { ok: false; error: string };
}

export interface SandboxMount { source: string; target: string; readonly: boolean }
export interface SandboxResult {
  exit_code: number | null; signal: string | null; timed_out: boolean; cancelled: boolean; duration_ms: number;
  stdout: string; stderr: string; stdout_bytes: number; stderr_bytes: number; stdout_truncated: boolean; stderr_truncated: boolean;
}
export class SandboxError extends Error {
  override readonly name = 'SandboxError';
  constructor(readonly code: string, message: string) { super(message); }
}

/** HTTP client of sandbox_manager. */
export class SandboxClient {
  constructor(private readonly endpoint: string, private readonly token: string) {}
  private async call<T>(path: string, body: unknown, signal?: AbortSignal, timeoutMs = 60000): Promise<T> {
    const deadline = AbortSignal.timeout(timeoutMs), combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let response: Response;
    try { response = await fetch(`${this.endpoint.replace(/\/$/, '')}${path}`, { method: 'POST', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: combined, redirect: 'error' }); }
    catch (error) { throwIfAborted(signal); throw new SandboxError('UNAVAILABLE', deadline.aborted ? '沙箱服务响应超时' : `沙箱服务不可达：${error instanceof Error ? error.message : String(error)}`); }
    const value = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new SandboxError(typeof value.code === 'string' ? value.code : `HTTP_${response.status}`, typeof value.message === 'string' ? value.message : `沙箱服务返回 HTTP ${response.status}`);
    return value as T;
  }
  private async get<T>(path: string, timeoutMs = 10000): Promise<T> {
    let response: Response;
    try { response = await fetch(`${this.endpoint.replace(/\/$/, '')}${path}`, { headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' }); }
    catch (error) { throw new SandboxError('UNAVAILABLE', `沙箱服务不可达：${error instanceof Error ? error.message : String(error)}`); }
    const value = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new SandboxError(typeof value.code === 'string' ? value.code : `HTTP_${response.status}`, typeof value.message === 'string' ? value.message : `沙箱服务返回 HTTP ${response.status}`);
    return value as T;
  }
  ensure(owner: string, projectId: string, taskId: string | undefined, mounts: SandboxMount[], limits: SandboxLimits, libraries: string[], signal?: AbortSignal) {
    return this.call<{ id: string; created: boolean }>('/v1/sandboxes/ensure', { owner, project_id: projectId, ...(taskId ? { task_id: taskId } : {}), mounts,
      limits: { cpus: limits.cpus, memory_gb: limits.memoryGb, max_running: limits.maxRunning, idle_minutes: limits.idleMinutes }, libraries }, signal, 120000);
  }
  resources() { return this.get<{ runtime: string; runtime_installed: boolean; image_present: boolean; running: number; total: number; libraries: boolean; ceilings: { cpus: number; memory_gb: number; max_running: number }; host: { cpus: number | null; memory_gb: number | null } }>('/v1/resources'); }
  run(owner: string, input: { command: string; cwd: string; timeoutSeconds: number }, signal?: AbortSignal) {
    return this.call<SandboxResult>(`/v1/sandboxes/${owner}/exec`, { exec_id: randomUUID(), command: input.command, cwd: input.cwd, timeout_s: input.timeoutSeconds }, signal, (input.timeoutSeconds + 60) * 1000);
  }
  remove(filter: { owner?: string; project_id?: string; task_ids?: string[]; all?: true }) { return this.call<{ removed: number }>('/v1/sandboxes/remove', filter, undefined, 60000); }
}

const exists = (path: string) => stat(path).then(info => info.isDirectory(), () => false);
const completed = new Set(['completed', 'accepted']);

/** What a conversation's sandbox mounts, from the same permissions as its file tools. */
export async function sandboxMounts(ctx: Context, chatId: string): Promise<{ projectId: string; taskId?: string; mounts: SandboxMount[]; cwd: string; notes: string[] }> {
  const scope = ctx.studio.chatScope(chatId), domain = ctx.studioDomain, storage = domain.fileStorage, drive = domain.vmStorage ? (letter: string) => `（${letter} 盘）` : () => '';
  if (!storage) throw new SandboxError('UNAVAILABLE', '当前部署没有使用 vm_manager 的任务空间，沙箱不可用');
  const projectId = scope.projectId, mounts: SandboxMount[] = [], notes: string[] = [];
  if (domain.projectDeleting(projectId)) throw new SandboxError('REFUSED', '项目正在删除，沙箱不可用');
  ctx.studio.sharedLease(projectId, true); await ctx.studio.projectFiles.allocate(projectId);
  mounts.push({ source: domain.sharedSpaceDirectory(projectId), target: '/shared', readonly: false });
  const tasks = join(storage.projectsRoot, projectId, 'tasks');
  if (await exists(tasks)) mounts.push({ source: tasks, target: '/tasks', readonly: true });
  if (scope.scope === 'task') {
    const task = domain.view(scope.taskId), workspace = domain.taskSpaceDirectory(projectId, task.id);
    if (await exists(workspace)) {
      mounts.push({ source: workspace, target: '/workspace', readonly: !task.writable });
      if (!task.writable) notes.push(`本任务已完成、冻结或归档：/workspace${drive('D')}只读`);
    } else notes.push(domain.vmStorage ? '本任务的 D 盘还没有创建，/workspace 不可用' : '本任务的文件夹还没有创建，/workspace 不可用');
    for (const dependency of task.dependencies ?? []) {
      let upstream; try { upstream = domain.task(dependency); } catch { continue; }
      if (upstream.projectId !== projectId || !completed.has(upstream.state)) continue;
      const source = domain.taskSpaceDirectory(projectId, upstream.id);
      if (await exists(source)) mounts.push({ source, target: `/inputs/${upstream.id}`, readonly: true });
    }
    return { projectId, taskId: task.id, mounts, cwd: mounts.some(mount => mount.target === '/workspace') ? '/workspace' : '/shared', notes };
  }
  return { projectId, mounts, cwd: '/shared', notes };
}

/** The tool result: exit status first, then each stream; the spill policy keeps long results in a temporary file. */
export function formatResult(result: SandboxResult, cwd: string, notes: string[] = []): string {
  const status = result.cancelled ? '已取消' : result.timed_out ? `超时，已结束整个进程组（${Math.round(result.duration_ms / 1000)} 秒）` : result.exit_code === null ? `被信号 ${result.signal ?? ''} 结束` : `退出码 ${result.exit_code}`;
  const lines = [`${status} · 用时 ${(result.duration_ms / 1000).toFixed(1)} 秒 · 工作目录 ${cwd}`, ...notes];
  const stream = (label: string, text: string, bytes: number, truncated: boolean) => text ? [`--- ${label}${truncated ? `（共 ${bytes} 字节，只保留开头和结尾；需要全文请重定向到文件后分段读取）` : ''} ---`, text.replace(/\n$/, '')] : [];
  return [...lines, ...stream('stdout', result.stdout, result.stdout_bytes, result.stdout_truncated), ...stream('stderr', result.stderr, result.stderr_bytes, result.stderr_truncated), ...(!result.stdout && !result.stderr ? ['（没有输出）'] : [])].join('\n');
}

const limitsOf = (settings: SandboxSettings): SandboxLimits => ({ cpus: settings.cpus, memoryGb: settings.memoryGb, maxRunning: settings.maxRunning, idleMinutes: settings.idleMinutes });

/** sandbox-settings.json: missing means the defaults; a damaged file is reported and replaced by the next save. */
export class SandboxSettingsStore {
  private value: SandboxSettings = { ...DEFAULT_SETTINGS };
  private writes = Promise.resolve();
  constructor(private readonly path: string) {}
  async load(): Promise<string | undefined> {
    let text: string;
    try { text = await readFile(this.path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    try { const data = JSON.parse(text) as Partial<SandboxSettings>; this.value = { ...validateSettings({ ...DEFAULT_SETTINGS, ...data }), revision: Number.isSafeInteger(data.revision) ? data.revision! : 0 }; }
    catch (error) { return `${this.path} is invalid (${error instanceof Error ? error.message : String(error)}); using the defaults until the settings are saved again`; }
  }
  get(): SandboxSettings { return this.value; }
  /** Saves a form read at `revision`; a form read before another save is refused. */
  save(next: SandboxSettings): Promise<SandboxSettings> {
    const run = this.writes.then(async () => {
      if (next.revision !== this.value.revision) throw new Error('沙箱设置已被修改，请刷新后再保存');
      const value = { ...next, revision: this.value.revision + 1 }, temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(value, null, 2) + '\n'); await rename(temporary, this.path);
      this.value = value; return value;
    });
    this.writes = run.then(() => undefined, () => undefined);
    return run;
  }
}

/** Checks a settings form against the plugin's own bounds and, when the service answers, its ceilings. */
export function validateSettings(value: unknown, ceilings?: { cpus: number; memoryGb: number; maxRunning: number }): SandboxLimits & { enabled: boolean; revision: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('沙箱设置须为对象');
  const data = value as Record<string, unknown>, extra = Object.keys(data).find(key => !['enabled', 'cpus', 'memoryGb', 'maxRunning', 'idleMinutes', 'revision'].includes(key));
  if (extra) throw new Error(`不支持的字段：${extra}`);
  if (typeof data.enabled !== 'boolean') throw new Error('缺少沙箱开关');
  if (!Number.isSafeInteger(data.revision)) throw new Error('缺少配置版本，请刷新页面');
  const number = (key: string, label: string, min: number, max: number, step: number) => {
    const item = data[key];
    if (typeof item !== 'number' || !Number.isFinite(item) || item < min || item > max || Math.abs(item / step - Math.round(item / step)) > 1e-9) throw new Error(`${label}须在 ${min}–${max} 之间${step === 1 ? '，且为整数' : `，按 ${step} 递增`}`);
    return item;
  };
  return { enabled: data.enabled, revision: data.revision as number,
    cpus: number('cpus', '每个沙箱的 CPU 核数', 0.5, ceilings?.cpus ?? 64, 0.5), memoryGb: number('memoryGb', '每个沙箱的内存（GB）', 1, ceilings ? Math.max(1, Math.floor(ceilings.memoryGb)) : 256, 1),
    maxRunning: number('maxRunning', '同时运行的沙箱数', 1, ceilings?.maxRunning ?? 64, 1), idleMinutes: number('idleMinutes', '闲置回收时间（分钟）', 1, 1440, 1) };
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const configured = !!config.endpoint && !!ctx.studioDomain.fileStorage, vms = !!ctx.studioDomain.vmStorage;
  const token = configured ? (config.tokenFile ? await readFile(config.tokenFile, 'utf8') : '').trim() : '';
  if (configured && !token) throw new Error('studio-sandbox: tokenFile is required with an endpoint');
  const client = configured ? new SandboxClient(config.endpoint, token) : undefined;
  const settings = new SandboxSettingsStore(join(config.dataRoot, 'sandbox-settings.json'));
  const problem = await settings.load(); if (problem) ctx.logger.warn(`studio-sandbox: ${problem}`);
  const view = async (): Promise<SandboxSettingsView> => {
    const base = { configured, ...settings.get() };
    if (!client) return base;
    try {
      const value = await client.resources();
      return { ...base, service: { ok: true, runtime: value.runtime, runtimeInstalled: value.runtime_installed, imagePresent: value.image_present, running: value.running, total: value.total, libraries: value.libraries,
        ceilings: { cpus: value.ceilings.cpus, memoryGb: value.ceilings.memory_gb, maxRunning: value.ceilings.max_running }, host: { cpus: value.host.cpus, memoryGb: value.host.memory_gb } } };
    } catch (error) { return { ...base, service: { ok: false, error: error instanceof Error ? error.message : String(error) } }; }
  };
  ctx.connection.fetch.register({ path: '/api/studio/sandbox', methods: ['GET', 'POST'], requestBody: 'buffered', async fetch(request) {
    try {
      if (request.method === 'POST') {
        if (!client) throw new Error('当前部署没有安装沙箱服务，无法修改沙箱设置');
        const current = await view(), next = validateSettings(await request.json(), current.service?.ok ? current.service.ceilings : undefined);
        await settings.save(next);
        await sync();
      }
      return Response.json(await view());
    } catch (error) {
      const message = error instanceof Error ? error.message : '沙箱设置失败';
      return Response.json({ error: message }, { status: 400 });
    }
  } });

  if (!client) { ctx.logger.info('studio-sandbox: no sandbox_manager endpoint or task spaces; studio_sandbox_run is not offered'); return; }
  // Without vm_manager the same sandbox has no VMs to point to or to share files with.
  const { prompt } = await loadPromptFile(vms ? config.promptPath : config.noSoftwarePromptPath || join(dirname(config.promptPath), 'sandbox-no-software-system-prompt.md'));
  // Completing, clearing or deleting a task first ends its sandboxes, so nothing writes to D: while it is frozen.
  // Deleting a project also ends its planning conversations' sandboxes, which belong to no task.
  ctx.effect(() => ctx.studio.registerQuiescence('sandbox', async taskIds => {
    if (!taskIds.length) return;
    const projects = new Set<string>();
    for (const id of taskIds) { try { const projectId = ctx.studioDomain.task(id).projectId; if (ctx.studioDomain.projectDeleting(projectId)) projects.add(projectId); } catch { /* already gone */ } }
    try {
      await client.remove({ task_ids: taskIds });
      for (const projectId of projects) await client.remove({ project_id: projectId });
    } catch (error) { ctx.logger.warn(`studio-sandbox: could not end sandboxes of ${taskIds.length} task(s): ${error instanceof Error ? error.message : String(error)}`); }
  }), 'studio-sandbox: write fence');
  const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] };
  const tool = defineTool({
    name: 'studio_sandbox_run',
    description: `Run a bash command in this conversation's Linux sandbox (Debian; Python 3 with numpy, pandas, scipy, matplotlib, openpyxl, python-docx, python-pptx, pypdf, pdfplumber, ezdxf, trimesh, requests; git, curl, wget, zip/7z, jq, ripgrep, ImageMagick, poppler-utils, pandoc). Optional: use it when a Linux command or a script is the simplest way, e.g. to parse a PDF, convert or analyse files, compute with Python, or download a file from the internet; plain reading and writing of single text files is also possible with the file tools. It cannot run Windows or engineering software (AutoCAD, SolidWorks, ANSYS)${vms ? ': use the VM tools for those' : ', and this deployment has none'}. The sandbox starts on first use (a few seconds), keeps installed packages and files in /tmp until it has been idle for a while (the user sets how long), and is shared by the calls of this conversation only. Folders: /workspace = this task's files (${vms ? 'VM D:, ' : ''}writable unless the task is completed or frozen), /shared = the project shared folder (${vms ? 'VM F:, ' : ''}writable; project skills are in /shared/skills), /inputs/<taskId> = completed upstream results (read-only), /tasks/<taskId> = every task's files in this project (read-only), /skills = the global skill library and /plugins = installed plugins (read-only; run a skill's scripts from there), /tmp = scratch, cleared when the sandbox stops. Files written to /workspace or /shared appear at once in ${vms ? 'the VMs and ' : ''}the file panels. The internet is reachable over HTTP/HTTPS through a proxy (pip install, curl and git work); the LAN${vms ? ', Studio and the VMs are' : ' and Studio are'} not. Each call is a fresh bash process: the working directory and exported variables do not carry over, files do. Background processes end when the command returns. Default timeout ${config.defaultTimeoutSeconds} s, at most ${config.maxTimeoutSeconds} s. Long output keeps only its start and end: write it to a file and read the part you need.`,
    parameters: {
      command: { type: 'string', required: true, description: 'Bash command line, e.g. "pdftotext -layout input.pdf - | head -100" or "python3 analyse.py".' },
      cwd: { type: 'string', description: 'Working directory inside the sandbox, default /workspace (task conversations) or /shared (planning conversations).' },
      timeoutSeconds: { type: 'integer', description: `Seconds before the command and its child processes are ended, 1–${config.maxTimeoutSeconds}, default ${config.defaultTimeoutSeconds}.` },
    },
    output,
    async execute(args, exec) {
      throwIfAborted(exec.signal);
      const agent = exec.agent; if (!agent) throw new Error('Agent identity required');
      if (!settings.get().enabled) throw new Error(`Linux 沙箱已在设置中关闭，请改用文件工具${vms ? '或虚拟机' : ''}，或请用户在设置里打开沙箱`);
      if (typeof args.command !== 'string' || !args.command.trim() || args.command.length > 16000) throw new Error('command 须为 1–16000 个字符');
      const timeoutSeconds = args.timeoutSeconds === undefined ? config.defaultTimeoutSeconds : args.timeoutSeconds;
      if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > config.maxTimeoutSeconds) throw new Error(`timeoutSeconds 须为 1–${config.maxTimeoutSeconds}`);
      let scope = await sandboxMounts(ctx, agent.id);
      const cwd = args.cwd === undefined || args.cwd === '' ? scope.cwd : args.cwd;
      if (typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.length > 1000) throw new Error('cwd 须为沙箱里的绝对路径，例如 /workspace/data');
      const started = Date.now(), activity = { actor: 'agent' as const, source: 'agent-tool' as const, action: 'sandbox_exec', projectId: scope.projectId, ...(scope.taskId ? { taskId: scope.taskId } : {}), chatId: agent.id, request: { command: args.command, cwd, timeoutSeconds } };
      try {
        // Only libraries that exist: Docker refuses a volume subpath that is missing.
        const limits = limitsOf(settings.get()), libraries = (await Promise.all(['plugins', 'skills'].map(async name => await exists(join(config.dataRoot, name)) ? name : ''))).filter(Boolean);
        await client.ensure(agent.id, scope.projectId, scope.taskId, scope.mounts, limits, libraries, exec.signal);
        // A task completed while its sandbox was starting has D: frozen now: start it again read-only before running anything.
        const latest = await sandboxMounts(ctx, agent.id);
        if (JSON.stringify(latest.mounts) !== JSON.stringify(scope.mounts)) { scope = latest; await client.ensure(agent.id, scope.projectId, scope.taskId, scope.mounts, limits, libraries, exec.signal); }
        const result = await client.run(agent.id, { command: args.command, cwd, timeoutSeconds }, exec.signal);
        ctx.studioDomain.recordActivity({ ...activity, ok: true, durationMs: Date.now() - started, result: { exitCode: result.exit_code, timedOut: result.timed_out, cancelled: result.cancelled, durationMs: result.duration_ms, stdoutBytes: result.stdout_bytes, stderrBytes: result.stderr_bytes } });
        return formatResult(result, cwd, scope.notes);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.studioDomain.recordActivity({ ...activity, ok: false, durationMs: Date.now() - started, error: message.slice(0, 500) });
        if (error instanceof Error && error.name === 'SandboxError' && (error as SandboxError).code === 'CAPACITY') throw new Error(`${message}。这不是命令的问题，可以稍后重试，或改用文件工具${vms ? '、虚拟机' : ''}完成。`);
        if (error instanceof Error && error.name === 'SandboxError' && (error as SandboxError).code === 'LIMIT_REFUSED') throw new Error(`设置里的沙箱资源上限超出了沙箱服务允许的范围（${message}），请用户在设置里重新保存沙箱设置`);
        throw error;
      }
    },
  });
  // The switch adds or removes the tool and its instructions at once; turning it off also ends every sandbox.
  // Runs are chained, so two quick saves end and register in order.
  let mounted: (() => void) | undefined, syncing = Promise.resolve();
  const sync = () => (syncing = syncing.catch(() => undefined).then(async () => {
    const enabled = settings.get().enabled;
    if (enabled && !mounted) {
      const offTool = ctx.tools.register({ ...tool, parameters: { ...tool.parameters, additionalProperties: false } }), offPrompt = ctx.studio.registerInstructions('sandbox-text', 114, prompt);
      mounted = () => { offTool(); offPrompt(); };
    } else if (!enabled && mounted) {
      mounted(); mounted = undefined;
      try { const { removed } = await client.remove({ all: true }); if (removed) ctx.logger.info(`studio-sandbox: turned off, ended ${removed} sandbox(es)`); }
      catch (error) { ctx.logger.warn(`studio-sandbox: turned off, but could not end the running sandboxes: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }));
  ctx.effect(() => { void sync(); return () => { mounted?.(); mounted = undefined; }; }, 'studio-sandbox: tool');
}
