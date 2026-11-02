import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools';
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { appendFile, mkdir, readFile, open, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { registerProjectExport, type ExportTaskVms, type ExportVm } from './project-export.ts';
import type {} from './index.ts';
import type {} from './domain.ts';
import type { Task } from './domain-types.ts';
import { loadPromptFile } from './prompt-loader.ts';
import type { WorkspaceLease } from './workspace.ts';
import type { RecordingEpisode, RecordingStep, SoftwareDescriptor, StudioVmSeatView, VmAgentStep, VmJobView, VmLicenseView, VmRecording, VmResources, VmSeatState, VmTaskProgress } from './seat-types.ts';
import { AUTO_REARM_WINDOW_MS, isEvaluation, LICENSE_READ_COMMAND, LICENSE_REARM_COMMAND, needsRearm, parseLicense, parseRearm, PENDING_REBOOT, type WindowsLicense } from './vm-license.ts';
import { VmClient, VmPlatformError, VmWorkspaces, vmObject as object } from './vm-client.ts';
import { agentCall, agentJson, compactTree, inputActions, inputScript, pngSize, runScript, VmAgentError, type AgentCallOptions, type AgentResponse } from './vm-agent.ts';
import { episodeFileResponse, loadEpisode, openEpisodeFile, readOperations, zipDisposition, zipEpisode, type OperationRecord } from './vm-recordings.ts';
import { applyCheck, applyStart, cancelJobScript, isActive, jobId, jobMinutes, jobStatusScript, jobView, MAX_RUNNING_JOBS, newJobId, readHostJob, resolveOffline, startJobScript, JOB_FOLDER, VmJobStore, type JobOutput, type JobTransient, type JobVm, type VmJobRecord } from './vm-jobs.ts';
import { abortError, throwIfAborted } from './abort.ts';
export { VmPlatformError } from './vm-client.ts';

/** The subset of the seat plugin Config used by the vm-manager backend. */
export interface VmSeatsConfig { dataRoot: string; vmEndpoint: string; vmTrustedHttpOrigins: string[]; timeoutMs: number; vmStopTimeoutMs: number; vmPromptPath: string; vmRunMinutes?: number; vmLicenseTiming?: Partial<LicenseTiming> }
/** sweepMs: how often running VMs are looked at; retryMs/attempts: reading the licence until the agent service answers;
 * settleMs: wait after scheduling the reboot; readyTimeoutMs: how long Windows may take to come back. */
interface LicenseTiming { sweepMs: number; retryMs: number; attempts: number; settleMs: number; readyTimeoutMs: number }
const LICENSE_TIMING: LicenseTiming = { sweepMs: 30000, retryMs: 10000, attempts: 9, settleMs: 30000, readyTimeoutMs: 10 * 60000 };
/** The licence check of one run, keyed by that run's started_at, persisted with the binding. */
interface VmLicenseRecord extends VmLicenseView { bootKey: string }
interface VmDetail {
  vm_id: string; project_id: string; task_id: string; chat_id: string | null; status: string; environment_id: string;
  spec: { cpu_cores: number; ram_gb: number }; access: { host: string; vnc_port: number | null; rdp_port: number | null; agent_port: number | null };
  mounts: { workspace: { workspace_id: string; writable: boolean } | null; upstreams?: { task_id: string }[] }; current_recording_id: string | null;
  queue: { position: number; reason: string; expires_at: string } | null; created_at: string; started_at: string | null; expires_at: string | null;
  lifecycle?: { timeout_minutes: number; queue_timeout_minutes: number };
  /** Since when the running VM's agent service has not answered (e.g. Windows restarting); vm_manager waits about 5 minutes. */
  unreachable_since?: string | null;
  stopped_at: string | null; stop_reason: string | null; error: { code: string; message: string } | null;
}
/** One launch request of a task's VM. owner is a task conversation, or 'human' for VMs started before the software area
 * followed conversations; a conversation may own several VMs, also of one environment. All of them share the task's D:
 * drive. The binding is persisted before any create request. handedBack: the user just handed the VM back to the Agent,
 * whose next input must follow a fresh screenshot or UI tree. */
interface VmBinding { taskId: string; projectId: string; environmentId: string; owner: string; createRequestId: string; allocatedAt: string; vmId?: string; controller?: 'agent' | 'human'; handedBack?: boolean; license?: VmLicenseRecord }
/** What a launch may choose beyond the environment: spec (at least the environment minimum), how long to queue, who
 * operates it first, the conversation a software-area launch belongs to, and whether the Agent reuses its VM. */
export interface VmLaunchOptions { cpuCores?: number; ramGb?: number; queueMinutes?: number; controller?: 'agent' | 'human'; chatId?: string; reuse?: boolean }
interface Actor { actor: 'human' | 'agent'; ownerId: string; chatId?: string; lease?: WorkspaceLease; signal?: AbortSignal }
/** The VM's agent service, every request tagged with one Studio operation (OPERATION_HEADER). */
type AgentClient = (path: string, options: Omit<AgentCallOptions, 'operation'>) => Promise<AgentResponse>;
/** The VM an operation runs on, as operate() found it. */
interface OperatedVm { vmId: string; environmentId: string; expiresAt: string | null }
/** The VM cannot take an operation now: it no longer exists, does not run, or its agent service does not answer.
 * By name: the Studio and domain plugins are bundled separately. */
export class VmUnavailableError extends Error {
  override readonly name = 'VmUnavailableError';
  constructor(message: string, readonly vmStatus: string) { super(message); }
}
/** A Python script that raised inside the VM (the agent service answers HTTP 500), as opposed to a request that
 * may never have arrived. */
class VmScriptError extends VmAgentError { override readonly name = 'VmScriptError'; }
/** Reads that do not look at the screen, so they leave a hand-back pending (see operate). */
const BLIND_READS = new Set(['milestone', 'job_status', 'job_list']);

const HUMAN = 'human';
const human: Actor = { actor: 'human', ownerId: 'operator' };
export const VM_MODE_UNSUPPORTED = 'VM_MODE_UNSUPPORTED: 虚拟机模式没有 Bridge、控制权和产物接口；请由用户在软件区的 VNC 画面中操作软件';
// A create whose response was lost is adopted only if vm_manager recorded it after this binding was allocated.
const ADOPT_SKEW_MS = 60000;
const states: Record<string, VmSeatState> = { queued: 'provisioning', creating: 'provisioning', starting: 'provisioning', running: 'ready', stopping: 'stopping', deleting: 'stopping', stopped: 'stopped', failed: 'failed' };
/** Statuses which may still write D: or hold host resources; completion stops all of them first. */
const active = new Set(['queued', 'creating', 'starting', 'running', 'stopping']);
const completedStates = new Set(['completed', 'accepted']);
/** vm_manager's default run limit and its accepted range (lifecycle.timeout_minutes). */
export const DEFAULT_RUN_MINUTES = 120, MAX_RUN_MINUTES = 7 * 24 * 60;

function text(value: unknown, label: string): string { if (typeof value !== 'string' || !value || value.length > 200) throw new Error(`Invalid ${label}`); return value; }
function optionalText(value: unknown, label: string): string | null { return value === null || value === undefined ? null : text(value, label); }
function positive(value: unknown, label: string): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${label}`); return value; }
function platformId(value: unknown, label: string): string { const id = text(value, label); if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error(`Invalid ${label}`); return id; }
function ownerId(value: unknown): string { const id = text(value, 'owner'); if (!/^[A-Za-z0-9:_-]{1,200}$/.test(id)) throw new Error('Invalid owner'); return id; }
export function environmentId(value: unknown): string | undefined { if (value === undefined || value === null || value === '') return; const id = text(value, 'imageId'); if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(id)) throw new Error('Invalid imageId'); return id; }
/** A run limit in minutes for vm_manager, or undefined to keep the VM's own limit. */
export function runMinutes(value: unknown): number | undefined {
  if (value === undefined || value === null) return;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_RUN_MINUTES) throw new Error(`运行时长需为 1～${MAX_RUN_MINUTES} 分钟的整数`);
  return value;
}
const startBody = (minutes?: number) => minutes === undefined ? undefined : { lifecycle: { timeout_minutes: minutes } };
function optionalVmId(value: unknown): string | undefined { return value === undefined || value === null || value === '' ? undefined : platformId(value, 'vmId'); }
function requestId(value: unknown): string { const id = text(value, 'requestId'); if (!/^[a-zA-Z0-9:_-]{1,100}$/.test(id)) throw new Error('Invalid requestId'); return id; }
function bindingKey(binding: Pick<VmBinding, 'taskId' | 'environmentId' | 'owner' | 'createRequestId'>) { return `${binding.taskId}::${binding.owner}::${binding.environmentId}::${binding.createRequestId}`; }
/** vm_manager counts each VM's memory as ram_gb plus this virtualization overhead (api.md 1.2). */
export const VM_OVERHEAD_RAM_GB = 1;
function count(value: unknown, label: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label}需为 ${min}～${max} 的整数`);
  return value;
}
const licenseStates = new Set(['checking', 'rearming', 'ok', 'due', 'exhausted', 'failed']);
/** A stored licence record; a check or rearm that a Studio restart interrupted is redone on its next look. */
function licenseRecord(raw: unknown): VmLicenseRecord | undefined {
  if (!raw || typeof raw !== 'object') return;
  const row = raw as Record<string, unknown>, number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null, flag = (value: unknown) => typeof value === 'boolean' ? value : null;
  if (typeof row.state !== 'string' || !licenseStates.has(row.state) || typeof row.bootKey !== 'string' || typeof row.checkedAt !== 'string') return;
  const busy = row.state === 'checking' || row.state === 'rearming';
  return { state: row.state as VmLicenseView['state'], bootKey: busy ? '' : row.bootKey, evaluation: flag(row.evaluation), licensed: flag(row.licensed), daysLeft: number(row.daysLeft), rearms: number(row.rearms), checkedAt: row.checkedAt, error: typeof row.error === 'string' ? row.error.slice(0, 500) : null };
}
const licenseFacts = (license: WindowsLicense) => license.pendingReboot ? { evaluation: null, licensed: null, daysLeft: null, rearms: null } : { evaluation: isEvaluation(license), licensed: license.licenseStatus === 1, daysLeft: Math.floor(license.graceMinutes / 1440), rearms: license.rearms >= PENDING_REBOOT ? null : license.rearms };
const licenseView = (record: VmLicenseRecord | undefined, bootKey: string | null): VmLicenseView | null => {
  if (!record || !bootKey || record.bootKey !== bootKey) return null;
  const { bootKey: _key, ...view } = record; return view;
};
/** Runs a Python script in the VM through its agent service; the script writes its result as JSON to the path it is
 * given, which is read back with /file and removed. */
async function runPython(agent: AgentClient, build: (resultPath: string) => string, timeoutMs: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const resultPath = `%TEMP%\\studio-run-${randomUUID()}.json`;
  try { agentJson(await agent('/execute_windows', { method: 'POST', body: { command: build(resultPath) }, timeoutMs, ...(signal ? { signal } : {}) })); }
  catch (error) { if (error instanceof VmAgentError && error.status) throw new VmScriptError(error.message, error.status); throw error; }
  try { return object(JSON.parse(Buffer.from((await agent('/file', { method: 'POST', form: { file_path: resultPath }, timeoutMs: 30000, ...(signal ? { signal } : {}) })).data).toString('utf8'))); }
  finally { await agent('/execute_windows', { method: 'POST', body: { command: `import os\nos.remove(os.path.expandvars(${JSON.stringify(resultPath)}))` }, timeoutMs: 30000 }).catch(() => {}); }
}
/** Runs a cmd.exe command line in the VM through its agent service and returns the result file (returncode, stdout, stderr). */
function execute(agent: AgentClient, command: string, seconds: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return runPython(agent, resultPath => runScript(command, resultPath, seconds), (seconds + 20) * 1000, signal);
}
/** The VM was not there to answer, so a job is looked at from D: instead; a script that failed in the VM is a real error. */
const unavailable = (error: unknown) => error instanceof Error && (error.name === 'VmUnavailableError' || (error instanceof VmAgentError && error.status === undefined && !(error instanceof VmScriptError)));
const newestFirst = (rows: VmJobRecord[]) => [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
function byVm(rows: VmJobRecord[]): Map<string, VmJobRecord[]> { const groups = new Map<string, VmJobRecord[]>(); for (const row of rows) groups.set(row.vmId, [...groups.get(row.vmId) ?? [], row]); return groups; }
export function launchOptions(data: Record<string, unknown>): VmLaunchOptions {
  if (data.controller !== undefined && data.controller !== 'agent' && data.controller !== 'human') throw new Error('controller 只能是 agent 或 human');
  const cpuCores = count(data.cpuCores, 'CPU 核数', 1, 256), ramGb = count(data.ramGb, '内存', 1, 2048), queueMinutes = count(data.queueMinutes, '最长排队时间', 1, 1440);
  return { ...(cpuCores ? { cpuCores } : {}), ...(ramGb ? { ramGb } : {}), ...(queueMinutes ? { queueMinutes } : {}), ...(data.controller ? { controller: data.controller as 'agent' | 'human' } : {}), ...(data.chatId ? { chatId: ownerId(data.chatId) } : {}) };
}
function osName(os: string) { const windows = /^windows(\d+)$/i.exec(os); return windows ? `Windows ${windows[1]}` : os; }
/** The first rule any preinstalled software matches wins, so AutoCAD + SolidWorks + ANSYS stays mechanical; unknown software counts as mechanical. */
const categoryRules: [RegExp, SoftwareDescriptor['category']][] = [
  [/solidworks/, 'mechanical'], [/ansys|openmodelica|paraview/, 'simulation'], [/kicad|ltspice/, 'electronics'], [/blender/, 'rendering'], [/autocad/, 'drafting'],
];
function category(software: { name: string }[]): SoftwareDescriptor['category'] {
  const names = software.map(row => row.name.toLowerCase());
  return categoryRules.find(([pattern]) => names.some(name => pattern.test(name)))?.[1] ?? 'mechanical';
}
/** A noVNC address is handed to the browser, so only a plain host name or IP literal is accepted. */
function address(host: unknown, port: unknown): string | null {
  if (typeof port !== 'number' || !Number.isSafeInteger(port) || port < 1 || port > 65535 || typeof host !== 'string' || !host || host.length > 253) return null;
  if (/^[A-Za-z0-9.-]+$/.test(host)) return `${host}:${port}`;
  return /^[0-9A-Fa-f:]+$/.test(host) && host.includes(':') ? `[${host}]:${port}` : null;
}
const isMissing = (error: unknown) => error instanceof VmPlatformError && error.status === 404;
/** Software-page VMs start under human control, conversation VMs under their Agent. */
const controllerOf = (binding: VmBinding) => binding.controller ?? (binding.owner === HUMAN ? 'human' : 'agent');

export function environmentDescriptor(raw: unknown): SoftwareDescriptor {
  const row = object(raw), id = environmentId(row.environment_id)!, os = text(row.os, 'os'), spec = object(row.min_spec);
  if (!Array.isArray(row.software) || row.software.length > 20) throw new Error('Invalid software list');
  const software = row.software.map(item => { const entry = object(item); return { name: text(entry.name, 'software name'), version: text(entry.version, 'software version') }; });
  const minSpec = { cpuCores: positive(spec.cpu_cores, 'min_spec.cpu_cores'), ramGb: positive(spec.ram_gb, 'min_spec.ram_gb') }, kind = category(software);
  return {
    id, name: software.map(entry => entry.name).join(' + ') || id, version: software.map(entry => entry.version).join(' / '), mock: false, imageRef: `vm-manager/${id}`,
    category: kind, workbench: kind === 'simulation' ? 'simulation' : 'drawing', capabilities: [], backend: 'vm-manager', vm: { os, software, minSpec },
    description: `${osName(os)} 虚拟机，预装 ${software.map(entry => `${entry.name} ${entry.version}`).join('、') || '软件'}；最低 ${minSpec.cpuCores} 核 CPU / ${minSpec.ramGb} GB 内存。`,
  };
}
function recording(raw: unknown): VmRecording {
  const row = object(raw), status = text(row.status, 'recording status');
  if (!['recording', 'stopped', 'failed'].includes(status)) throw new Error('Invalid recording status');
  return { id: platformId(row.recording_id, 'recording_id'), vmId: platformId(row.vm_id, 'vm_id'), status: status as VmRecording['status'], startedAt: text(row.started_at, 'started_at'),
    stoppedAt: optionalText(row.stopped_at, 'stopped_at'), resultPath: typeof row.result_path === 'string' ? row.result_path.slice(0, 1024) : '', error: typeof row.error === 'string' ? row.error.slice(0, 1000) : null };
}

/** Software seats backed by vm_manager v1. The Mock StudioSeats in seat.ts stays the default and is not changed by this backend. */
export class StudioVmSeats {
  private readonly bindings = new Map<string, VmBinding>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly progressByTask = new Map<string, VmTaskProgress>();
  /** Summaries of finished recordings, keyed by status and trajectory.jsonl time; the VM panel polls every 5 s. */
  private readonly episodes = new Map<string, { key: string; episode: RecordingEpisode | null }>();
  private persistence: Promise<unknown> = Promise.resolve();
  private readonly client: VmClient;
  private readonly workspaces: VmWorkspaces;
  private closing = false;
  /** One licence check or rearm per VM at a time; the sweep looks at running VMs nobody is watching. */
  private readonly licenseJobs = new Map<string, Promise<void>>();
  private readonly licenseAbort = new AbortController();
  private readonly licenseTiming: LicenseTiming;
  private sweeper?: ReturnType<typeof setInterval>;
  private sweeping = false;
  /** Background commands started by Agents, kept across restarts; see vm-jobs.ts. */
  private readonly jobs: VmJobStore;
  constructor(private readonly ctx: Context, private readonly config: VmSeatsConfig) {
    this.licenseTiming = { ...LICENSE_TIMING, ...config.vmLicenseTiming };
    this.jobs = new VmJobStore(config.dataRoot);
    this.client = new VmClient(config.vmEndpoint, config.vmTrustedHttpOrigins, config.timeoutMs);
    this.workspaces = new VmWorkspaces(this.client, config.vmStopTimeoutMs);
  }
  async initialize() {
    await mkdir(this.config.dataRoot, { recursive: true, mode: 0o700 });
    try {
      const values: unknown = JSON.parse(await readFile(join(this.config.dataRoot, 'vm-seats.json'), 'utf8'));
      if (!Array.isArray(values)) throw new Error('Invalid VM bindings');
      for (const raw of values) {
        const row = object(raw);
        // Bindings written before per-conversation VMs belong to the software page.
        const binding: VmBinding = { taskId: text(row.taskId, 'task'), projectId: text(row.projectId, 'project'), environmentId: environmentId(row.environmentId)!, owner: row.owner === undefined ? HUMAN : ownerId(row.owner), createRequestId: requestId(row.createRequestId), allocatedAt: text(row.allocatedAt, 'allocatedAt'), ...(row.vmId ? { vmId: platformId(row.vmId, 'vmId') } : {}), ...(row.controller === 'agent' || row.controller === 'human' ? { controller: row.controller } : {}), ...(row.handedBack === true ? { handedBack: true } : {}), ...(licenseRecord(row.license) ? { license: licenseRecord(row.license) } : {}) };
        const key = bindingKey(binding); if (this.bindings.has(key)) throw new Error('Duplicate VM launch binding'); this.bindings.set(key, binding);
      }
    } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    // A task deleted during a crash still owns its VMs. An offline platform does not block startup; the next start retries.
    for (const binding of [...this.bindings.values()]) {
      let exists = true; try { this.ctx.studioDomain.task(binding.taskId); } catch { exists = false; }
      if (!exists) try { await this.erase(binding); } catch { /* retried on the next start */ }
    }
    await this.save();
    await this.jobs.load();
    for (const taskId of this.jobs.taskIds()) { try { this.ctx.studioDomain.task(taskId); } catch { this.jobs.removeTask(taskId); } }
    await this.jobs.save();
    this.sweeper = setInterval(() => { void this.sweep(); }, this.licenseTiming.sweepMs); this.sweeper.unref?.();
  }
  private save(): Promise<void> {
    const operation = this.persistence.catch(() => undefined).then(async () => {
      const path = join(this.config.dataRoot, 'vm-seats.json'), temporary = `${path}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify([...this.bindings.values()]) + '\n'); await file.sync(); } finally { await file.close(); }
        await rename(temporary, path);
        const directory = await open(this.config.dataRoot, 'r'); try { await directory.sync(); } finally { await directory.close(); }
      } finally { await rm(temporary, { force: true }); }
    });
    this.persistence = operation; return operation;
  }
  private serial<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(taskId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation); this.queues.set(taskId, next);
    void next.finally(() => { if (this.queues.get(taskId) === next) this.queues.delete(taskId); }).catch(() => {}); return next;
  }
  private call<T>(path: string, method = 'GET', body?: unknown, timeoutMs?: number): Promise<T> { return this.client.call<T>(path, method, body, timeoutMs); }
  private path(binding: VmBinding) { if (!binding.vmId) throw new Error('虚拟机正在创建，请刷新状态'); return `/v1/vms/${encodeURIComponent(binding.vmId)}`; }
  private verify(binding: Pick<VmBinding, 'taskId' | 'projectId' | 'environmentId'>, raw: unknown, vmId?: string): VmDetail {
    const row = object(raw);
    if ((vmId && row.vm_id !== vmId) || row.project_id !== binding.projectId || row.task_id !== binding.taskId || row.environment_id !== binding.environmentId) throw new Error('虚拟机平台返回的虚拟机所属任务或环境不匹配');
    platformId(row.vm_id, 'vm_id'); text(row.status, 'status'); text(row.created_at, 'created_at'); object(row.access);
    return row as unknown as VmDetail;
  }
  /** null when vm_manager no longer knows the VM (deleted outside Studio). */
  private async detail(binding: VmBinding): Promise<VmDetail | null> {
    try { return this.verify(binding, await this.call<unknown>(this.path(binding)), binding.vmId); }
    catch (error) { if (isMissing(error)) return null; throw error; }
  }
  /** Every vm_manager VM of a task, including VMs created outside Studio. */
  private async taskVms(projectId: string, taskId: string): Promise<{ vmId: string; status: string }[]> {
    const data = object(await this.call<unknown>(`/v1/vms?${new URLSearchParams({ project_id: projectId, task_id: taskId })}`));
    if (!Array.isArray(data.items)) throw new Error('虚拟机平台响应格式无效');
    return data.items.map(raw => object(raw)).filter(row => row.project_id === projectId && row.task_id === taskId).map(row => ({ vmId: platformId(row.vm_id, 'vm_id'), status: text(row.status, 'status') }));
  }
  /** POST /v1/vms is not idempotent: after a lost response, adopt the VM it created instead of creating another one. */
  private async reconcile(binding: VmBinding): Promise<boolean> {
    const claimed = new Set([...this.bindings.values()].map(row => row.vmId)), since = Date.parse(binding.allocatedAt) - ADOPT_SKEW_MS, chat = binding.owner === HUMAN ? null : binding.owner;
    let adopted: VmDetail | undefined;
    for (const row of await this.taskVms(binding.projectId, binding.taskId)) {
      if (claimed.has(row.vmId)) continue;
      let detail: VmDetail;
      try { detail = object(await this.call<unknown>(`/v1/vms/${encodeURIComponent(row.vmId)}`)) as unknown as VmDetail; }
      catch (error) { if (isMissing(error)) continue; throw error; }
      if (detail.environment_id !== binding.environmentId || (detail.chat_id ?? null) !== chat || !(Date.parse(detail.created_at) >= since)) continue;
      this.verify(binding, detail, row.vmId);
      if (!adopted || Date.parse(detail.created_at) < Date.parse(adopted.created_at)) adopted = detail;
    }
    if (!adopted) return false;
    binding.vmId = adopted.vm_id; await this.save(); return true;
  }
  private taskBindings(taskId: string): VmBinding[] {
    const task = this.ctx.studioDomain.task(taskId), values = [...this.bindings.values()].filter(binding => binding.taskId === taskId);
    if (values.some(binding => binding.projectId !== task.projectId)) throw new Error('Seat owner changed');
    return values;
  }
  /** A VM ID selects exactly; otherwise the owner's VM of the environment. */
  private bound(taskId: string, selected?: string, owner = HUMAN, vmId?: string): VmBinding | undefined {
    const values = this.taskBindings(taskId), id = environmentId(selected);
    if (vmId) { const binding = values.find(row => row.vmId === vmId); if (!binding) throw new Error('该虚拟机不属于当前任务'); return binding; }
    const owned = values.filter(binding => binding.owner === owner && (!id || binding.environmentId === id));
    if (owned.length > 1) throw new Error(`有 ${owned.length} 台虚拟机符合条件，请用 vmId 指定：${owned.map(row => `${row.vmId ?? '创建中'}（${row.environmentId}）`).join('、')}`);
    return owned[0];
  }
  private guard(taskId: string, actor: Actor) {
    throwIfAborted(actor.signal);
    if (this.closing) throw new Error('软件连接正在停止');
    this.ctx.studioDomain.assertWorking(taskId);
    if (actor.lease && (actor.lease.taskId !== taskId || this.ctx.studio.files.readLease(taskId).generation !== actor.lease.generation)) throw new Error('任务软件写权限已撤销');
  }
  /** Only short requests run under the domain lock; stop/delete use the per-task queue alone. */
  private work<T>(taskId: string, actor: Actor, operation: () => Promise<T>): Promise<T> {
    throwIfAborted(actor.signal);
    return this.ctx.studioDomain.work(taskId, () => this.serial(taskId, async () => { this.guard(taskId, actor); return operation(); }), actor.signal);
  }
  async catalog() {
    const data = object(await this.call<unknown>('/v1/environments'));
    if (!Array.isArray(data.items) || data.items.length > 100) throw new Error('虚拟机平台响应格式无效');
    const images = data.items.map(environmentDescriptor);
    return { images, software: images, backend: 'vm-manager' as const, defaultRunMinutes: this.defaultRunMinutes };
  }
  /** The run limit of new VMs (Studio setting vmRunMinutes); each VM keeps its own, changed on (re)start. */
  get defaultRunMinutes() { return runMinutes(this.config.vmRunMinutes) ?? DEFAULT_RUN_MINUTES; }
  /** Host capacity for the launch wizard and the software area: vm_manager's allocation-based figures, how many VMs of
   * each environment could start now at their minimum spec (none while others queue, as the queue is strictly FIFO), and
   * when the VMs holding resources reach their run limit. */
  async resources(): Promise<VmResources> {
    const [raw, { images }, listed] = await Promise.all([this.call<unknown>('/v1/host/resources'), this.catalog(), this.call<unknown>(`/v1/vms?${new URLSearchParams({ status: 'creating,starting,running' })}`)]);
    const data = object(raw), cpu = object(data.cpu), memory = object(data.memory_gb), disk = object(data.disk_gb), vms = object(data.vms);
    const n = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
    const host: VmResources['host'] = {
      cpu: { total: n(cpu.total), allocated: n(cpu.allocated), available: n(cpu.available) }, memoryGb: { total: n(memory.total), allocated: n(memory.allocated), available: n(memory.available) },
      diskGb: { total: n(disk.total), used: n(disk.used), available: n(disk.available) }, running: n(vms.running), queued: n(vms.queued),
    };
    const environments = images.map(image => { const { cpuCores, ramGb } = image.vm!.minSpec; return { id: image.id, launchable: host.queued ? 0 : Math.max(0, Math.min(Math.floor(host.cpu.available / cpuCores), Math.floor(host.memoryGb.available / (ramGb + VM_OVERHEAD_RAM_GB)))) }; });
    const items = object(listed).items, rows = Array.isArray(items) ? items.slice(0, 50) : [];
    const releases = (await Promise.all(rows.map(async item => {
      try {
        const vm = object(await this.call<unknown>(`/v1/vms/${encodeURIComponent(platformId(object(item).vm_id, 'vm_id'))}`)), spec = object(vm.spec);
        return typeof vm.expires_at === 'string' ? [{ at: vm.expires_at, cpuCores: n(spec.cpu_cores), ramGb: n(spec.ram_gb) + VM_OVERHEAD_RAM_GB }] : [];
      } catch { return []; }
    }))).flat().sort((a, b) => a.at.localeCompare(b.at));
    return { host, overheadRamGb: VM_OVERHEAD_RAM_GB, environments, releases, checkedAt: new Date().toISOString() };
  }
  /** The VM's agent service for Studio's own requests (licence checks), logged with no conversation. */
  private systemAgent(detail: VmDetail, operation: string): AgentClient {
    const agent = address(detail.access.host, detail.access.agent_port); if (!agent) throw new Error('虚拟机没有开放操作服务端口');
    return (path, options) => agentCall(`http://${agent}`, path, { ...options, operation, signal: options.signal ? AbortSignal.any([options.signal, this.licenseAbort.signal]) : this.licenseAbort.signal });
  }
  private async readLicense(binding: VmBinding): Promise<WindowsLicense> {
    const detail = await this.detail(binding); if (!detail || detail.status !== 'running') throw new Error('虚拟机没有在运行');
    const result = await execute(this.systemAgent(detail, `lic-${randomUUID()}`), LICENSE_READ_COMMAND, 60);
    if (result.returncode !== 0) throw new Error(`读取授权失败：${String(result.stderr ?? '').trim().slice(0, 300) || `返回码 ${String(result.returncode)}`}`);
    return parseLicense(result.stdout);
  }
  /** Reads the licence until the agent service answers (it may still be starting, or Windows rebooting). */
  private async readLicenseWhenReady(binding: VmBinding, attempts = this.licenseTiming.attempts, notBoot?: string): Promise<WindowsLicense> {
    let failure: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt) await delay(this.licenseTiming.retryMs, undefined, { signal: this.licenseAbort.signal });
      try { const license = await this.readLicense(binding); if (!notBoot || license.lastBoot !== notBoot) return license; failure = new Error('Windows 还没有重启'); }
      catch (error) { if (this.licenseAbort.signal.aborted) throw error; failure = error; }
    }
    throw failure instanceof Error ? failure : new Error(String(failure));
  }
  private async setLicense(binding: VmBinding, bootKey: string, patch: Partial<VmLicenseView>) {
    const previous = binding.license?.bootKey === bootKey ? binding.license : undefined;
    binding.license = { state: 'checking', evaluation: null, licensed: null, daysLeft: null, rearms: null, error: null, ...previous, ...patch, bootKey, checkedAt: new Date().toISOString() };
    await this.save();
  }
  /** Checks the run's licence; an evaluation that has expired or is close to it is rearmed and Windows rebooted, without
   * asking right after the run started, otherwise only when a user asks (manual). Input waits meanwhile (operate). */
  private async licenseJob(binding: VmBinding, bootKey: string, startedAt: number, manual: boolean) {
    const vmId = binding.vmId!, log = (tool: string, ok: boolean, summary: string) => this.audit(binding.taskId, { at: new Date().toISOString(), operation: `lic-${randomUUID()}`, chatId: null, vmId, environmentId: binding.environmentId, tool, kind: 'system', summary, ok }).catch(() => {});
    try {
      await this.setLicense(binding, bootKey, { state: 'checking', error: null });
      const license = await this.readLicenseWhenReady(binding), facts = licenseFacts(license);
      // The final state is written last, so a finished state means the job is over.
      if (!needsRearm(license)) { await log('license_check', true, `${license.name}，剩 ${facts.daysLeft} 天，可续期 ${license.rearms} 次`); await this.setLicense(binding, bootKey, { state: 'ok', ...facts }); return; }
      if (license.rearms <= 0) { await log('license_check', false, '评估授权需要续期，但已没有续期次数'); await this.setLicense(binding, bootKey, { state: 'exhausted', ...facts }); return; }
      if (!manual && Date.now() - startedAt > AUTO_REARM_WINDOW_MS) { await this.setLicense(binding, bootKey, { state: 'due', ...facts }); return; }
      await this.setLicense(binding, bootKey, { state: 'rearming', ...facts });
      const detail = await this.detail(binding); if (!detail || detail.status !== 'running') throw new Error('虚拟机没有在运行');
      const result = await execute(this.systemAgent(detail, `lic-${randomUUID()}`), LICENSE_REARM_COMMAND, 120), rearm = parseRearm(result.stdout);
      if (!rearm.rearmed) throw new Error(`续期失败：${rearm.error ?? '原因未知'}`);
      if (rearm.shutdown !== 0) throw new Error(`已续期，但没能安排重启（shutdown 返回 ${String(rearm.shutdown)}），请在虚拟机里重启 Windows`);
      await log('license_rearm', true, `续期并重启（之前剩 ${facts.daysLeft} 天，可续期 ${license.rearms} 次）`);
      await delay(this.licenseTiming.settleMs, undefined, { signal: this.licenseAbort.signal });
      const attempts = Math.max(1, Math.ceil(this.licenseTiming.readyTimeoutMs / this.licenseTiming.retryMs));
      const after = await this.readLicenseWhenReady(binding, attempts, license.lastBoot), afterFacts = licenseFacts(after);
      await log('license_check', !needsRearm(after), `续期后：剩 ${afterFacts.daysLeft} 天，可续期 ${after.rearms} 次`);
      await this.setLicense(binding, bootKey, needsRearm(after) ? { state: 'failed', ...afterFacts, error: '续期并重启后授权仍未恢复' } : { state: 'ok', ...afterFacts });
    } catch (error) {
      if (this.licenseAbort.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      await log('license_check', false, message); await this.setLicense(binding, bootKey, { state: 'failed', error: message }).catch(() => {});
    }
  }
  /** Starts the licence check of a running VM's current run once; returns the running or finished job. */
  private observe(binding: VmBinding, detail: VmDetail, manual = false): Promise<void> | undefined {
    const vmId = binding.vmId; if (!vmId || this.closing || detail.status !== 'running' || detail.unreachable_since || !detail.started_at) return this.licenseJobs.get(vmId ?? '');
    const running = this.licenseJobs.get(vmId); if (running) return running;
    if (!manual && binding.license?.bootKey === detail.started_at) return;
    const job = this.licenseJob(binding, detail.started_at, Date.parse(detail.started_at), manual).finally(() => this.licenseJobs.delete(vmId));
    this.licenseJobs.set(vmId, job); return job;
  }
  /** Running VMs that no page or Agent looks at are checked too: an expired evaluation shuts Windows down within an hour. */
  private async sweep() {
    if (this.sweeping || this.closing) return; this.sweeping = true;
    try {
      for (const binding of [...this.bindings.values()]) {
        if (!binding.vmId || this.licenseJobs.has(binding.vmId)) continue;
        try { const detail = await this.detail(binding); if (detail) this.observe(binding, detail); } catch { /* vm_manager unreachable: next sweep */ }
      }
    } finally { this.sweeping = false; }
  }
  /** Before input reaches a VM: its run's licence check must have finished, and no rearm reboot may be under way. */
  private async licenseGate(binding: VmBinding, detail: VmDetail) {
    const job = this.observe(binding, detail), state = binding.license?.bootKey === detail.started_at ? binding.license.state : undefined;
    if (state === 'checking' && job) await Promise.race([job, delay(60000)]);
    const now = binding.license?.bootKey === detail.started_at ? binding.license.state : undefined;
    if (now === 'checking' || now === 'rearming') throw new Error('VM_LICENSE_BUSY: Studio 正在检查或续期这台虚拟机的 Windows 评估授权，续期时会重启一次（约 1～3 分钟）；用 studio_software_status 的 waitSeconds 等它完成后再操作');
  }
  /** A user's licence action: check again, or rearm now and reboot (also later in the run, when the check said due). */
  license(taskId: string, vmId: string, action: unknown) {
    if (action !== 'check' && action !== 'rearm') throw new Error('action 只能是 check 或 rearm');
    return this.serial(taskId, async () => {
      const binding = this.bound(taskId, undefined, HUMAN, vmId)!, detail = await this.detail(binding);
      if (!detail || detail.status !== 'running' || detail.unreachable_since) throw new Error('虚拟机运行并且有响应时才能检查授权');
      if (this.licenseJobs.has(vmId)) throw new Error('正在检查或续期授权，请稍候');
      if (action === 'rearm' && binding.license?.state !== 'due' && binding.license?.state !== 'failed') throw new Error('这台虚拟机现在不需要续期');
      if (action === 'check' && binding.license?.bootKey === detail.started_at) delete binding.license;
      void this.observe(binding, detail, action === 'rearm');
      return { seat: await this.current(binding) };
    });
  }
  /** The latest successful Agent input or command on each VM of the task, from the end of its operation log. */
  private async lastSteps(taskId: string): Promise<Map<string, VmAgentStep>> {
    const steps = new Map<string, VmAgentStep>(); let tail = '';
    try {
      const file = await open(this.operationsLog(taskId), 'r');
      try { const { size } = await file.stat(), length = Math.min(size, 65536), buffer = Buffer.alloc(length); await file.read(buffer, 0, length, size - length); tail = buffer.toString('utf8'); } finally { await file.close(); }
    } catch { return steps; }
    for (const line of tail.split('\n')) {
      let row: Record<string, unknown>; try { row = object(JSON.parse(line)); } catch { continue; } // the first line may be cut
      if (row.kind === 'write' && row.ok === true && typeof row.vmId === 'string' && typeof row.at === 'string' && typeof row.tool === 'string') steps.set(row.vmId, { at: row.at, tool: row.tool, summary: String(row.summary ?? '').slice(0, 300) });
    }
    return steps;
  }
  private render(binding: VmBinding, detail: VmDetail, images: SoftwareDescriptor[], lastAgentStep: VmAgentStep | null = null): StudioVmSeatView {
    const state = states[detail.status]; if (!state) throw new Error(`未知的虚拟机状态：${detail.status}`);
    const software = images.find(row => row.id === binding.environmentId) ?? environmentDescriptor({ environment_id: binding.environmentId, os: 'unknown', software: [], min_spec: detail.spec });
    const vnc = state === 'ready' ? address(detail.access.host, detail.access.vnc_port) : null, rdp = state === 'ready' ? address(detail.access.host, detail.access.rdp_port) : null;
    const queue = detail.queue ? object(detail.queue) : null, error = detail.error ? object(detail.error) : null, workspace = detail.mounts?.workspace ? object(detail.mounts.workspace) : null;
    const upstreams = Array.isArray(detail.mounts?.upstreams) ? detail.mounts.upstreams.map(row => String(object(row).task_id)) : [];
    return {
      backend: 'vm-manager', id: detail.vm_id, softwareId: binding.environmentId, taskId: binding.taskId, projectId: binding.projectId, state, vmStatus: detail.status, software,
      owner: binding.owner === HUMAN ? 'human' : 'chat', chatId: binding.owner === HUMAN ? null : binding.owner, upstreamTaskIds: upstreams, controller: controllerOf(binding),
      spec: { cpuCores: detail.spec?.cpu_cores, ramGb: detail.spec?.ram_gb },
      queue: queue ? { position: Number(queue.position), reason: String(queue.reason), expiresAt: String(queue.expires_at) } : null,
      error: error ? { code: String(error.code), message: String(error.message ?? '').slice(0, 1000) } : null,
      createdAt: detail.created_at, startedAt: detail.started_at ?? null, expiresAt: detail.expires_at ?? null, stoppedAt: detail.stopped_at ?? null, stopReason: detail.stop_reason ?? null,
      runMinutes: typeof detail.lifecycle?.timeout_minutes === 'number' ? detail.lifecycle.timeout_minutes : null,
      unreachableSince: state === 'ready' && typeof detail.unreachable_since === 'string' ? detail.unreachable_since : null,
      // Ports change on every start; the address is always taken from this latest detail.
      access: { vncUrl: vnc && `http://${vnc}/`, rdpAddress: rdp },
      workspace: workspace ? { workspaceId: String(workspace.workspace_id), writable: workspace.writable === true } : null,
      currentRecordingId: detail.current_recording_id ?? null, canEdit: this.ctx.studioDomain.view(binding.taskId).writable, lastAgentStep,
      license: licenseView(binding.license, detail.started_at),
    };
  }
  private async current(binding: VmBinding, images?: SoftwareDescriptor[]): Promise<StudioVmSeatView> {
    const detail = await this.detail(binding); if (!detail) throw new Error('虚拟机已不存在（可能已在平台上删除），请重新启动');
    return this.render(binding, detail, images ?? (await this.catalog()).images);
  }
  /** All VMs of the task (every environment and owner), unassigned ones first, each owner's in launch order. */
  async list(taskId: string, selected?: string): Promise<{ seats: StudioVmSeatView[] }> {
    const id = environmentId(selected), values = this.taskBindings(taskId).filter(binding => binding.vmId && (!id || binding.environmentId === id));
    if (!values.length) return { seats: [] };
    const [{ images }, steps] = await Promise.all([this.catalog(), this.lastSteps(taskId)]), seats: StudioVmSeatView[] = [];
    for (const binding of values) { const detail = await this.detail(binding); if (detail) { this.observe(binding, detail); seats.push(this.render(binding, detail, images, steps.get(detail.vm_id) ?? null)); } }
    seats.sort((a, b) => (a.owner === b.owner ? a.createdAt.localeCompare(b.createdAt) : a.owner === 'human' ? -1 : 1));
    return { seats };
  }
  /** seat is the software page's VM of the environment (or the only one); seats lists every owner's VM. */
  async get(taskId: string, selected?: string): Promise<{ seat: StudioVmSeatView | null; seats: StudioVmSeatView[] }> {
    const { seats } = await this.list(taskId, selected);
    return { seat: seats.find(row => row.owner === 'human') ?? (seats.length === 1 ? seats[0]! : null), seats };
  }
  /** Frozen D: drives of completed predecessors are mounted read-only as E:\<taskId>. */
  private async upstreams(task: Task): Promise<string[]> {
    const ids: string[] = [];
    for (const id of task.dependencies ?? []) {
      let predecessor: Task; try { predecessor = this.ctx.studioDomain.task(id); } catch { continue; }
      if (predecessor.projectId !== task.projectId || !completedStates.has(predecessor.state)) continue;
      const space = await this.workspaces.find(task.projectId, id);
      if (space?.frozen) ids.push(id);
    }
    return ids;
  }
  /** A software-area launch names its conversation, which must be one of this task's. */
  private launchOwner(taskId: string, actor: Actor, chatId?: string): string {
    if (actor.chatId) return actor.chatId;
    if (!chatId) return HUMAN;
    // The lease of a chat is its binding, which carries the scope.
    let chat: { scope?: string; taskId?: string } | undefined; try { chat = this.ctx.studio.boundLease(chatId) as unknown as { scope?: string; taskId?: string }; } catch { /* unknown below */ }
    if (chat?.scope !== 'task' || chat.taskId !== taskId) throw new Error('该对话不属于当前任务');
    return chatId;
  }
  /** Launch one VM for the actor. A request ID already bound answers with its VM (a create whose response was lost is
   * adopted, never repeated). With reuse (the Agent's default) the conversation's single VM of the environment is
   * restarted when stopped or failed (its container and C: drive are kept). Otherwise a new VM is persisted and only
   * then POSTed, with the chosen spec (default the environment minimum). minutes sets the run limit (new VMs default
   * to the Studio setting); on a VM that is already starting or running it only changes the limit. */
  create(taskId: string, selected: string, id: string, actor: Actor = human, limit?: number, options: VmLaunchOptions = {}) {
    return this.work(taskId, actor, async () => {
      const minutes = runMinutes(limit);
      const { images } = await this.catalog(), environment = images.find(row => row.id === environmentId(selected));
      if (!environment?.vm) throw new Error('虚拟机平台没有该软件环境，请先从目录选择');
      const owner = this.launchOwner(taskId, actor, options.chatId), { cpuCores: minCpu, ramGb: minRam } = environment.vm.minSpec;
      const cpuCores = options.cpuCores ?? minCpu, ramGb = options.ramGb ?? minRam;
      if (cpuCores < minCpu || ramGb < minRam) throw new Error(`${environment.name} 至少需要 ${minCpu} 核 CPU / ${minRam} GB 内存`);
      const key = bindingKey({ taskId, owner, environmentId: environment.id, createRequestId: id });
      let binding = this.bindings.get(key);
      // A request whose create is still unconfirmed is adopted below, never replaced by another VM.
      if (options.reuse && !(binding && !binding.vmId)) {
        const own = this.taskBindings(taskId).filter(row => row.owner === owner && row.environmentId === environment.id && row.vmId), existing = binding ?? (own.length === 1 ? own[0] : undefined);
        if (!existing && own.length > 1) throw new Error(`本对话已有 ${own.length} 台 ${environment.id} 虚拟机，请用 vmId 指定要启动的那台：${own.map(row => row.vmId).join('、')}；要再开一台时传 newVm: true`);
        if (existing) {
          const detail = await this.detail(existing);
          if (detail) {
            // vm_manager restarts a failed VM on its kept container; one whose container is gone answers 409 VM_FAILED.
            if (detail.status === 'stopped' || detail.status === 'failed') { await this.withRunVmQuota(owner, existing, async () => { await this.writeTaskBrief(existing); await this.call(`${this.path(existing)}/start`, 'POST', startBody(minutes)); }); throwIfAborted(actor.signal); }
            else if (minutes !== undefined && ['queued', 'creating', 'starting', 'running'].includes(detail.status)) await this.call(`${this.path(existing)}/start`, 'POST', startBody(minutes));
            return { seat: await this.current(existing, images) };
          }
          this.bindings.delete(bindingKey(existing)); await this.save(); binding = undefined;
        }
      }
      if (binding?.vmId) {
        const detail = await this.detail(binding);
        if (detail) return { seat: this.render(binding, detail, images) };
        this.bindings.delete(key); await this.save(); binding = undefined;
      }
      if (!binding) {
        binding = { taskId, projectId: this.ctx.studioDomain.task(taskId).projectId, environmentId: environment.id, owner, createRequestId: id, allocatedAt: new Date().toISOString(), ...(options.controller ? { controller: options.controller } : {}) };
        const reserved = binding;
        await this.withRunVmQuota(owner, undefined, async () => { this.bindings.set(key, reserved); await this.save(); });
      }
      if (!await this.reconcile(binding)) {
        throwIfAborted(actor.signal);
        const upstreamTaskIds = await this.upstreams(this.ctx.studioDomain.task(taskId));
        let created: Record<string, unknown>;
        try { created = object(await this.call<unknown>('/v1/vms', 'POST', { project_id: binding.projectId, task_id: taskId, environment_id: environment.id, spec: { cpu_cores: cpuCores, ram_gb: ramGb }, ...(owner === HUMAN ? {} : { chat_id: owner }), ...(upstreamTaskIds.length ? { upstream_task_ids: upstreamTaskIds } : {}), lifecycle: { timeout_minutes: minutes ?? this.defaultRunMinutes, ...(options.queueMinutes ? { queue_timeout_minutes: options.queueMinutes } : {}) } })); }
        catch (error) {
          // A rejected request (e.g. REQUEST_EXCEEDS_CAPACITY) created nothing; only a lost response keeps the binding for adoption.
          if (error instanceof VmPlatformError && error.status >= 400 && error.status < 500) { this.bindings.delete(key); await this.save(); }
          throw error;
        }
        binding.vmId = platformId(created.vm_id, 'vm_id'); await this.save();
      }
      await this.writeTaskBrief(binding);
      return { seat: await this.current(binding, images) };
    });
  }
  private quotaTail: Promise<unknown> = Promise.resolve();
  /** An autonomy run caps the VMs its conversations hold at once (settings.maxVms): one more is refused, none is stopped.
   * Launches of different tasks run in parallel, so the check and the reservation that follows it are serialized. */
  private async withRunVmQuota(owner: string, restarting: VmBinding | undefined, reserve: () => Promise<void>) {
    const quota = owner === HUMAN ? undefined : this.ctx.studio.autonomyVmQuota?.(owner);
    if (!quota) return reserve();
    const run = this.quotaTail.catch(() => undefined).then(async () => {
      if (await this.activeVmCount(quota.chatIds, restarting) >= quota.maxVms) throw new Error(`自主运行同时占用的虚拟机已达上限（${quota.maxVms} 台）：请先停止本次运行中不再需要的虚拟机，或请用户在运行面板调高虚拟机上限`);
      await reserve();
    });
    this.quotaTail = run.catch(() => undefined);
    return run;
  }
  /** VMs of these conversations that are queued, creating, starting or running; a launch not yet confirmed by vm_manager counts. */
  async activeVmCount(owners: ReadonlySet<string>, except?: VmBinding): Promise<number> {
    let count = 0;
    for (const binding of [...this.bindings.values()]) {
      if (!owners.has(binding.owner) || binding === except) continue;
      if (!binding.vmId) { count++; continue; }
      const detail = await this.detail(binding); if (detail && ['queued', 'creating', 'starting', 'running'].includes(detail.status)) count++;
    }
    return count;
  }
  /** The VM's G:\task.json (<projects>/<projectId>/recordings/<vmId>/task.json). The recorder stores it with every
   * recording of the VM, so a recording names its task, goal and checklist; written before every start. */
  private async writeTaskBrief(binding: VmBinding) {
    const root = this.recordingsRoot(); if (!root || !binding.vmId) return;
    try {
      const task = this.ctx.studioDomain.task(binding.taskId), directory = join(root, binding.projectId, 'recordings', binding.vmId), path = join(directory, 'task.json');
      const checklist = task.checklist?.length ? task.checklist.map(item => item.text) : (task.criteria ?? []).map(item => item.label);
      const brief = {
        title: task.title ?? '', task_instruction: task.goal ?? '', constraints: task.constraints ?? '', checklist, outputs: task.outputs ?? [],
        harnessstudio: { project_id: binding.projectId, task_id: binding.taskId, task_code: task.code ?? null, environment_id: binding.environmentId, vm_id: binding.vmId,
          owner: binding.owner === HUMAN ? 'software-page' : 'conversation', chat_id: binding.owner === HUMAN ? null : binding.owner },
      };
      await mkdir(directory, { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, JSON.stringify(brief, null, 2) + '\n'); await rename(temporary, path); } finally { await rm(temporary, { force: true }); }
    } catch { /* Best effort: without it a recording still carries vm_manager's project, task and VM IDs. */ }
  }
  /** Restart a stopped or failed VM of the task (C: drive kept): the user any of them, an Agent its conversation's own;
   * owner and mounts are unchanged. minutes sets the run limit; on a starting or running VM only the limit and its expiry change. */
  start(taskId: string, vmId: string, actor: Actor = human, limit?: number) {
    return this.work(taskId, actor, async () => {
      const minutes = runMinutes(limit);
      const binding = this.bound(taskId, undefined, HUMAN, vmId)!;
      if (actor.chatId && binding.owner !== actor.chatId) throw new Error('只能启动本对话的虚拟机');
      await this.writeTaskBrief(binding);
      await this.call(`${this.path(binding)}/start`, 'POST', startBody(minutes));
      return { seat: await this.current(binding) };
    });
  }
  /** Handover switch of one VM; 'human' keeps the Agent to screenshots and UI trees. Handing it back makes the Agent
   * look at the screen again before its next input, since the user may have changed it. */
  setController(taskId: string, vmId: string, controller: unknown) {
    if (controller !== 'agent' && controller !== 'human') throw new Error('controller 只能是 agent 或 human');
    return this.serial(taskId, async () => {
      const binding = this.bound(taskId, undefined, HUMAN, vmId)!;
      if (controller === 'agent' && controllerOf(binding) === 'human') binding.handedBack = true; else if (controller === 'human') delete binding.handedBack;
      binding.controller = controller; await this.save();
      return { seat: await this.current(binding) };
    });
  }
  /** Moves a VM started before the software area followed conversations into one of the task's conversations. */
  assign(taskId: string, vmId: string, chatId: string) {
    return this.serial(taskId, async () => {
      const binding = this.bound(taskId, undefined, HUMAN, vmId)!, owner = this.launchOwner(taskId, human, chatId);
      if (binding.owner !== HUMAN) throw new Error('这台虚拟机已属于一个对话');
      // The operator stays as it was; without an explicit one, a conversation's VM would default to its Agent.
      binding.controller = controllerOf(binding); this.bindings.delete(bindingKey(binding)); binding.owner = owner; this.bindings.set(bindingKey(binding), binding); await this.save();
      return { seat: await this.current(binding) };
    });
  }
  /** The VM an Agent operates: an explicit vmId of its task, otherwise its own conversation's VM. */
  private agentBinding(taskId: string, chatId: string, selected?: string, vmId?: string): VmBinding {
    if (vmId) return this.bound(taskId, undefined, HUMAN, vmId)!;
    const id = environmentId(selected), own = this.taskBindings(taskId).filter(row => row.owner === chatId && row.vmId && (!id || row.environmentId === id));
    if (own.length === 1) return own[0]!;
    if (own.length > 1) throw new Error(`本对话有 ${own.length} 台虚拟机，请用 vmId 指定要操作的那台：${own.map(row => `${row.vmId}（${row.environmentId}，${controllerOf(row) === 'agent' ? '已交给 Agent' : '用户操作中'}）`).join('、')}`);
    // Models often omit vmId when told to reuse the software page's VM: the one page VM handed to the Agent is meant.
    // Other conversations' VMs are never chosen implicitly.
    const others = this.taskBindings(taskId).filter(row => row.vmId && (!id || row.environmentId === id)), handed = others.filter(row => row.owner === HUMAN && controllerOf(row) === 'agent');
    if (handed.length === 1) return handed[0]!;
    const listed = others.map(row => `${row.vmId}（${row.owner === HUMAN ? '未归属对话' : `对话 ${row.owner.slice(0, 8)}`}，${row.environmentId}，${controllerOf(row) === 'agent' ? '已交给 Agent' : '我来操作，只能截图和读界面'}）`).join('；');
    throw new Error(others.length ? `本对话没有自己的虚拟机，请在 vmId 中指定本任务的虚拟机：${listed}` : '本任务还没有虚拟机：先用 studio_software_launch 启动本对话的虚拟机');
  }
  /** Run one Agent operation on a running VM of its task. Writes need the Agent handover, a working task and a
   * writable D: drive. Every attempt is appended to vm-operations/<taskId>.jsonl under its operation ID, which its
   * agent-service requests carry, so the VM's trajectory recording can tell the Agent's steps from the human's. */
  async operate<T>(taskId: string, actor: Actor, target: { imageId?: string; vmId?: string }, kind: 'read' | 'write', tool: string, summary: string, action: (agent: AgentClient, vm: OperatedVm) => Promise<T>, detail: Record<string, unknown> = {}): Promise<T> {
    throwIfAborted(actor.signal);
    const started = Date.now(), operation = `op-${randomUUID()}`; let binding: VmBinding | undefined, failure: string | undefined;
    try {
      binding = this.agentBinding(taskId, actor.chatId!, target.imageId, target.vmId);
      const detail = await this.detail(binding); if (!detail) throw new VmUnavailableError('虚拟机已不存在，请重新启动', 'deleted');
      if (detail.status !== 'running') throw new VmUnavailableError(`虚拟机当前状态为 ${detail.status}，进入 running 后才能操作；可用 studio_software_status 查询`, detail.status);
      if (detail.unreachable_since) throw new VmUnavailableError(`虚拟机内的服务从 ${detail.unreachable_since} 起无响应（Windows 可能正在重启）；用 studio_software_status 等待 unreachableSince 消失后再操作`, 'unreachable');
      const agent = address(detail.access.host, detail.access.agent_port); if (!agent) throw new Error('虚拟机没有开放操作服务端口');
      if (kind === 'write') {
        if (controllerOf(binding) !== 'agent') throw new Error('VM_HUMAN_CONTROL: 用户已接管这台虚拟机（我来操作），Agent 现在只能截图和读取界面元素；请告诉用户你接下来要做什么，等用户点“交给 Agent”后再操作');
        this.guard(taskId, actor);
        if (detail.mounts?.workspace?.writable === false) throw new Error('D 盘已冻结（任务已完成），不能再在虚拟机中操作写入');
        await this.licenseGate(binding, detail);
        if (binding.handedBack) { delete binding.handedBack; await this.save(); throw new Error('VM_HANDED_BACK: 用户刚把这台虚拟机交还给你，期间可能动过画面。先用 studio_vm_screenshot 或 studio_vm_ui_tree 看清当前状态，再继续操作'); }
      } else if (binding.handedBack && !BLIND_READS.has(tool)) { delete binding.handedBack; await this.save(); }
      return await action((path, options) => agentCall(`http://${agent}`, path, { ...options, operation }), { vmId: detail.vm_id, environmentId: binding.environmentId, expiresAt: detail.expires_at ?? null });
    } catch (error) { failure = error instanceof Error ? error.message : String(error); throw error; }
    finally {
      const entry = { at: new Date(started).toISOString(), operation, chatId: actor.chatId ?? null, vmId: binding?.vmId ?? target.vmId ?? null, environmentId: binding?.environmentId ?? null, tool, kind, summary: summary.slice(0, 500), ok: failure === undefined, ...(failure ? { error: failure.slice(0, 500) } : {}), durationMs: Date.now() - started , ...detail };
      await this.audit(taskId, entry).catch(() => {});
    }
  }
  /** A background job of the calling conversation. */
  private ownJob(taskId: string, actor: Actor, id: string): VmJobRecord {
    const record = this.jobs.get(id);
    if (!record || record.taskId !== taskId || record.chatId !== actor.chatId) throw new Error(`没有找到后台任务 ${id}：只能查询和取消本对话启动的后台任务，用 studio_vm_job_status 不带 jobId 可以列出它们`);
    return record;
  }
  /** Whether the job's VM is still one of the task's VMs; a VM deleted in Studio is looked at from D: alone. */
  private assertJobVm(record: VmJobRecord) {
    if (!this.taskBindings(record.taskId).some(row => row.vmId === record.vmId)) throw new VmUnavailableError('虚拟机已不存在', 'deleted');
  }
  /** Asks the VM about some of its jobs and stores what it says. */
  private async checkJobs(agent: AgentClient, records: VmJobRecord[], signal?: AbortSignal): Promise<Map<string, JobOutput | undefined>> {
    const result = await runPython(agent, path => jobStatusScript(records.map(row => row.id), path), 60000, signal);
    const jobs = result.jobs && typeof result.jobs === 'object' ? result.jobs as Record<string, unknown> : {}, outputs = new Map<string, JobOutput | undefined>();
    for (const record of records) outputs.set(record.id, applyCheck(record, jobs[record.id] ?? null));
    await this.jobs.save();
    return outputs;
  }
  /** The job's VM as vm_manager reports it. */
  private async jobVm(record: VmJobRecord): Promise<JobVm> {
    try {
      const row = object(await this.call<unknown>(`/v1/vms/${encodeURIComponent(record.vmId)}`));
      if (row.project_id !== record.projectId || row.task_id !== record.taskId) return null;
      return { status: String(row.status), unreachable: typeof row.unreachable_since === 'string' && !!row.unreachable_since };
    } catch (error) { return isMissing(error) ? null : undefined; }
  }
  /** Jobs whose VM cannot answer: settled from job.json on D: as the host sees it, and from the VM's state. */
  private async offlineJobs(records: VmJobRecord[]): Promise<Map<string, { output?: JobOutput; transient?: JobTransient }>> {
    const result = new Map<string, { output?: JobOutput; transient?: JobTransient }>(), root = this.recordingsRoot(), before = JSON.stringify(records);
    for (const rows of byVm(records).values()) {
      const vm = await this.jobVm(rows[0]!);
      for (const record of rows) {
        const host = root ? await readHostJob(join(root, record.projectId, 'tasks', record.taskId, JOB_FOLDER, record.id)) : undefined;
        result.set(record.id, resolveOffline(record, host, vm));
      }
    }
    // The software area polls this every few seconds; most polls change nothing.
    if (JSON.stringify(records) !== before) await this.jobs.save();
    return result;
  }
  /** studio_vm_run with background: true. The record is stored before the start request, so a lost answer leaves a
   * job that is settled later from the VM, never one that is started again. */
  startJob(taskId: string, actor: Actor, target: { imageId?: string; vmId?: string }, command: string, minutes: number): Promise<VmJobView> {
    const id = newJobId();
    return this.operate(taskId, actor, target, 'write', 'job_start', command, async (agent, vm) => {
      const running = () => this.jobs.forVm(vm.vmId).filter(isActive);
      if (running().length) await this.checkJobs(agent, running(), actor.signal);
      const same = running().find(row => row.chatId === actor.chatId && row.command === command);
      if (same) throw new Error(`VM_JOB_DUPLICATE: 同一条命令已经在这台虚拟机的后台运行（任务号 ${same.id}）。用 studio_vm_job_status({jobId:"${same.id}",waitSeconds:120}) 查询进度，不要重复启动`);
      if (running().length >= MAX_RUNNING_JOBS) throw new Error(`VM_JOB_LIMIT: 这台虚拟机已有 ${running().length} 个后台任务在运行（最多 ${MAX_RUNNING_JOBS} 个）：${running().map(row => row.id).join('、')}。等其中一个结束，或经用户同意后用 studio_vm_job_cancel 取消，再启动新的`);
      const left = vm.expiresAt ? Math.floor((Date.parse(vm.expiresAt) - Date.now()) / 60000) : Infinity;
      if (minutes > left) throw new Error(`虚拟机将在 ${vm.expiresAt} 到期自动停止（还剩约 ${Math.max(0, left)} 分钟），不够后台任务运行 ${minutes} 分钟。把 maxMinutes 设为不超过 ${Math.max(0, left)}，或先征得用户同意，用 studio_software_launch 的 runMinutes 延长虚拟机运行时长`);
      const now = new Date().toISOString(), record: VmJobRecord = {
        id, taskId, projectId: this.ctx.studioDomain.task(taskId).projectId, vmId: vm.vmId, environmentId: vm.environmentId, chatId: actor.chatId!, command, maxMinutes: minutes,
        createdAt: now, state: 'starting', returncode: null, startedAt: null, endedAt: null, reason: null, error: null, canceledBy: null, outputRemoved: false, checkedAt: now,
      };
      this.jobs.add(record); await this.jobs.save();
      let result: Record<string, unknown>;
      try { result = await runPython(agent, path => startJobScript({ id, command, maxSeconds: minutes * 60 }, path), 60000, actor.signal); }
      catch (error) {
        if (error instanceof VmScriptError) { Object.assign(record, { state: 'failed', reason: 'start', error: error.message.slice(0, 500), endedAt: new Date().toISOString() }); await this.jobs.save(); }
        throw error;
      }
      for (const removed of applyStart(record, result)) { const row = this.jobs.get(removed); if (row) row.outputRemoved = true; }
      await this.jobs.save();
      return jobView(record);
    }, { jobId: id });
  }
  /** One job of the conversation, waiting up to waitSeconds while it runs; the wait is one operation. */
  async jobStatus(taskId: string, actor: Actor, id: string, waitSeconds: number): Promise<VmJobView> {
    const record = this.ownJob(taskId, actor, id), until = Date.now() + waitSeconds * 1000;
    try {
      this.assertJobVm(record);
      return await this.operate(taskId, actor, { vmId: record.vmId }, 'read', 'job_status', id, async agent => {
        while (true) {
          const output = (await this.checkJobs(agent, [record], actor.signal)).get(id), left = until - Date.now();
          if (!isActive(record) || left <= 0) return jobView(record, output);
          await delay(Math.min(5000, left), undefined, { signal: actor.signal });
        }
      }, { jobId: id });
    } catch (error) {
      if (!unavailable(error)) throw error;
      const { output, transient } = (await this.offlineJobs([record])).get(id)!;
      return jobView(record, output, transient);
    }
  }
  /** The conversation's jobs, newest first; running ones are asked about first, one read per VM. */
  async jobList(taskId: string, actor: Actor): Promise<{ jobs: VmJobView[] }> {
    const own = newestFirst(this.jobs.forTask(taskId).filter(row => row.chatId === actor.chatId)).slice(0, 20), transient = new Map<string, JobTransient>();
    for (const [vmId, rows] of byVm(own.filter(isActive))) {
      try { this.assertJobVm(rows[0]!); await this.operate(taskId, actor, { vmId }, 'read', 'job_list', rows.map(row => row.id).join(' '), agent => this.checkJobs(agent, rows, actor.signal), { jobIds: rows.map(row => row.id) }); }
      catch (error) { if (!unavailable(error)) throw error; for (const [id, value] of await this.offlineJobs(rows)) if (value.transient) transient.set(id, value.transient); }
    }
    return { jobs: own.map(row => jobView(row, undefined, transient.get(row.id))) };
  }
  /** Ends a job of the conversation and its whole process tree. */
  async cancelJob(taskId: string, actor: Actor, id: string): Promise<VmJobView> {
    const record = this.ownJob(taskId, actor, id);
    if (!isActive(record)) return jobView(record);
    try {
      this.assertJobVm(record);
      return await this.operate(taskId, actor, { vmId: record.vmId }, 'write', 'job_cancel', id, async agent => this.cancelOnVm(agent, record, 'agent', actor.signal), { jobId: id });
    } catch (error) {
      if (!unavailable(error)) throw error;
      const { output, transient } = (await this.offlineJobs([record])).get(id)!;
      return jobView(record, output, transient);
    }
  }
  private async cancelOnVm(agent: AgentClient, record: VmJobRecord, by: 'agent' | 'human', signal?: AbortSignal): Promise<VmJobView> {
    const result = await runPython(agent, path => cancelJobScript(record.id, path), 60000, signal), was = record.state;
    applyCheck(record, result);
    if (record.state === 'canceled' && was !== 'canceled') record.canceledBy = by;
    await this.jobs.save();
    return jobView(record, undefined, isActive(record) ? { state: record.state, note: '已要求结束，但进程还没有全部退出；稍后再查询确认' } : undefined);
  }
  /** The software area's list: every job of the task, newest first, settled from D: and the VMs' states without
   * asking the VMs (it is polled every few seconds). */
  async taskJobs(taskId: string): Promise<{ jobs: VmJobView[] }> {
    this.ctx.studioDomain.task(taskId);
    const rows = newestFirst(this.jobs.forTask(taskId)).slice(0, 50), values = await this.offlineJobs(rows.filter(isActive));
    return { jobs: rows.map(row => jobView(row, undefined, values.get(row.id)?.transient)) };
  }
  /** A person stops a job from the software area, whoever operates the VM. Its requests carry no operation header,
   * since this is not an Agent step; the operation log records it as the human's. */
  async humanCancelJob(taskId: string, vmId: string, id: string): Promise<{ job: VmJobView }> {
    if (!this.ctx.studioDomain.view(taskId).writable) throw new Error('当前任务只读，不能停止后台任务');
    const record = this.jobs.get(id); if (!record || record.taskId !== taskId || record.vmId !== vmId) throw new Error('没有找到这个后台任务');
    if (!isActive(record)) return { job: jobView(record) };
    const binding = this.taskBindings(taskId).find(row => row.vmId === vmId), detail = binding ? await this.detail(binding) : null, agent = detail && address(detail.access.host, detail.access.agent_port);
    if (!detail || detail.status !== 'running' || detail.unreachable_since || !agent) {
      const { output, transient } = (await this.offlineJobs([record])).get(id)!;
      if (isActive(record)) throw new Error(transient?.note ?? '虚拟机内的服务暂时无响应，现在停不了这个后台任务，请稍后再试');
      return { job: jobView(record, output) };
    }
    const started = Date.now(); let failure: string | undefined;
    try { return { job: await this.cancelOnVm((path, options) => agentCall(`http://${agent}`, path, options), record, 'human') }; }
    catch (error) { failure = error instanceof Error ? error.message : String(error); throw error; }
    finally { await this.audit(taskId, { at: new Date(started).toISOString(), operation: `ui-${randomUUID()}`, chatId: null, vmId, environmentId: record.environmentId, tool: 'job_cancel', kind: 'human', summary: `${id} ${record.command}`.slice(0, 500), ok: failure === undefined, ...(failure ? { error: failure.slice(0, 500) } : {}), durationMs: Date.now() - started, jobId: id }).catch(() => {}); }
  }
  private operationsLog(taskId: string) { return join(this.config.dataRoot, 'vm-operations', `${taskId.replace(/[^A-Za-z0-9_-]/g, '_')}.jsonl`); }
  private async audit(taskId: string, entry: Record<string, unknown>) {
    await mkdir(join(this.config.dataRoot, 'vm-operations'), { recursive: true, mode: 0o700 });
    await appendFile(this.operationsLog(taskId), JSON.stringify(entry) + '\n', { mode: 0o600 });
  }
  /** Delete the VM (C: drive is lost; vm_manager keeps task space and recordings) and forget the binding. */
  private async erase(binding: VmBinding) {
    if (!binding.vmId) await this.reconcile(binding);
    // DELETE of an unknown VM also succeeds.
    if (binding.vmId) await this.call(this.path(binding), 'DELETE', undefined, this.config.vmStopTimeoutMs);
    this.bindings.delete(bindingKey(binding)); await this.save();
  }
  /** Release stops the VM and keeps its C: drive for a later launch; discard deletes it. Both wait for Windows to shut down. */
  async release(taskId: string, confirm: boolean, selected?: string, discard = false, vmId?: string, owner = HUMAN) {
    if (confirm !== true) throw new Error('请先确认停止或删除虚拟机');
    const check = () => { const binding = this.bound(taskId, selected, owner, vmId); if (vmId && owner !== HUMAN && binding?.owner !== owner) throw new Error('只能停止本对话的虚拟机'); return binding; };
    check();
    await this.serial(taskId, async () => {
      const binding = check(); if (!binding) { if (owner !== HUMAN) throw new Error('本对话没有启动该环境的虚拟机'); return; }
      if (discard) return this.erase(binding);
      if (!binding.vmId && !await this.reconcile(binding)) { this.bindings.delete(bindingKey(binding)); await this.save(); return; }
      try { await this.call(`${this.path(binding)}/stop`, 'POST', undefined, this.config.vmStopTimeoutMs); }
      catch (error) { if (!isMissing(error)) throw error; this.bindings.delete(bindingKey(binding)); await this.save(); }
    });
    return { released: true };
  }
  private progress(taskId: string, step: VmTaskProgress['step'], detail: string) { this.progressByTask.set(taskId, { step, detail, updatedAt: new Date().toISOString() }); }
  /** The latest completion/resume step of a task for the completion dialog. */
  taskProgress(taskId: string): { progress: VmTaskProgress | null } {
    const value = this.progressByTask.get(taskId);
    return { progress: value && Date.now() - Date.parse(value.updatedAt) < 600000 ? value : null };
  }
  /** Stop one VM; creating/stopping VMs answer VM_BUSY and are retried until the shared deadline. */
  private async stopVm(vmId: string, deadline: number) {
    while (true) {
      try {
        const result = object(await this.call<unknown>(`/v1/vms/${encodeURIComponent(vmId)}/stop`, 'POST', undefined, Math.max(1000, deadline - Date.now())));
        if (['stopped', 'failed'].includes(String(result.status))) return;
      } catch (error) {
        if (isMissing(error)) return;
        if (!(error instanceof VmPlatformError && ['VM_BUSY', 'STOP_FAILED'].includes(error.code))) throw error;
      }
      if (Date.now() >= deadline) throw new Error(`虚拟机 ${vmId} 未能在时限内停止，任务保持待完成状态，请稍后重试`);
      await delay(5000);
    }
  }
  /** Completion: stop every VM of the task, then freeze its D: drive. Studio then copies the snapshot. Any failure keeps the task pending. */
  private async settle(task: Task) {
    try {
      const running = (await this.taskVms(task.projectId, task.id)).filter(row => active.has(row.status));
      if (running.length) {
        this.progress(task.id, 'stopping', `正在停止该任务的 ${running.length} 台虚拟机（Windows 正常关机）`);
        const deadline = Date.now() + this.config.vmStopTimeoutMs;
        await Promise.all(running.map(row => this.stopVm(row.vmId, deadline)));
      }
      this.progress(task.id, 'freezing', '正在冻结 D 盘（任务空间）');
      const space = await this.workspaces.ensure(task.projectId, task.id);
      if (!space.frozen) await this.workspaces.freeze(space.id);
      this.progress(task.id, 'snapshot', '正在生成完成快照');
    } catch (error) { this.progress(task.id, 'failed', error instanceof Error ? error.message : String(error)); throw error; }
  }
  /** Resume and clear make the D: drive writable again; completed snapshots are not touched. */
  private async thaw(task: Task) {
    const space = await this.workspaces.find(task.projectId, task.id);
    if (!space?.frozen) return;
    this.progress(task.id, 'unfreezing', '正在解冻 D 盘（任务空间）');
    try { await this.workspaces.unfreeze(space.id); this.progressByTask.delete(task.id); }
    catch (error) { this.progress(task.id, 'failed', error instanceof Error ? error.message : String(error)); throw error; }
  }
  /** Producer quiescence of the owning task: completion stops VMs and freezes D:, resume unfreezes it, permanent
   * deletion or clearing deletes every VM of the task (clear also unfreezes). The task space directory is never removed. */
  async quiesce(taskIds: string[]) {
    for (const taskId of taskIds) await this.serial(taskId, async () => {
      const task = this.ctx.studioDomain.task(taskId);
      if (task.pendingOwnerId !== taskId) return;
      if (task.pendingAction === 'complete') return this.settle(task);
      if (task.pendingAction === 'resume') return this.thaw(task);
      if (task.pendingAction !== 'delete' && task.pendingAction !== 'clear') return;
      for (const binding of this.taskBindings(taskId)) await this.erase(binding);
      for (const row of await this.taskVms(task.projectId, taskId)) await this.call(`/v1/vms/${encodeURIComponent(row.vmId)}`, 'DELETE', undefined, this.config.vmStopTimeoutMs);
      this.jobs.removeTask(taskId); await this.jobs.save();
      if (task.pendingAction === 'clear') await this.thaw(task);
    });
  }
  async records(taskId: string, selected?: string, vmId?: string): Promise<{ records: VmRecording[] }> {
    const binding = this.bound(taskId, selected, HUMAN, vmId); if (!binding?.vmId) return { records: [] };
    const data = object(await this.call<unknown>(`/v1/recordings?${new URLSearchParams({ vm_id: binding.vmId })}`));
    if (!Array.isArray(data.items)) throw new Error('虚拟机平台响应格式无效');
    return { records: await this.withEpisodes(binding.projectId, taskId, data.items.slice(0, 50).map(recording).filter(row => row.vmId === binding.vmId)) };
  }
  /** <projects> of vm_manager, where Studio reads the recordings; undefined without STUDIO_VMM_PROJECTS_ROOT. */
  private recordingsRoot(): string | undefined { const root = this.ctx.studioDomain.vmStorage?.projectsRoot; return root ? resolve(root) : undefined; }
  /** Adds what the recorder wrote to finished recordings; a recording in progress is still on the VM's local disk. */
  private async withEpisodes(projectId: string, taskId: string, rows: VmRecording[]): Promise<VmRecording[]> {
    const root = this.recordingsRoot(); if (!root) return rows;
    let operations: Map<string, OperationRecord> | undefined;
    const result: VmRecording[] = [];
    for (const row of rows) {
      if (row.status === 'recording') { result.push({ ...row, episode: null }); continue; }
      const directory = join(root, projectId, 'recordings', row.vmId, row.id);
      const key = `${row.status}:${await stat(join(directory, 'trajectory.jsonl')).then(info => info.mtimeMs, () => 0)}`, cached = this.episodes.get(row.id);
      if (cached?.key === key) { result.push({ ...row, episode: cached.episode }); continue; }
      operations ??= await readOperations(this.operationsLog(taskId));
      const episode = (await loadEpisode(directory, operations))?.episode ?? null;
      if (this.episodes.size >= 1000) this.episodes.delete(this.episodes.keys().next().value!);
      this.episodes.set(row.id, { key, episode }); result.push({ ...row, episode });
    }
    return result;
  }
  /** Every recording of the task, of all its VMs including deleted ones, newest first. */
  async taskRecordings(taskId: string): Promise<{ recordings: VmRecording[] }> {
    const task = this.ctx.studioDomain.task(taskId);
    const data = object(await this.call<unknown>(`/v1/recordings?${new URLSearchParams({ project_id: task.projectId, task_id: taskId })}`));
    if (!Array.isArray(data.items)) throw new Error('虚拟机平台响应格式无效');
    const rows = data.items.filter(raw => object(raw).project_id === task.projectId && object(raw).task_id === taskId).slice(0, 200).map(recording);
    return { recordings: await this.withEpisodes(task.projectId, taskId, rows) };
  }
  /** What the project export needs from vm_manager for one task: every VM of the task (deleted VMs are known only
   * from their recordings), its latest lifecycle and Studio binding, its recordings and their directories, the task
   * brief Studio wrote to G:, and the task's Agent operation log. */
  async exportTask(projectId: string, taskId: string): Promise<ExportTaskVms> {
    const listed = await this.taskVms(projectId, taskId);
    const data = object(await this.call<unknown>(`/v1/recordings?${new URLSearchParams({ project_id: projectId, task_id: taskId })}`));
    const rows = (Array.isArray(data.items) ? data.items : []).map(raw => object(raw)).filter(row => row.project_id === projectId && row.task_id === taskId);
    const root = this.recordingsRoot(), vms: ExportVm[] = [];
    for (const vmId of new Set([...listed.map(row => row.vmId), ...rows.map(row => platformId(row.vm_id, 'vm_id'))])) {
      let detail: Record<string, unknown> | null = null;
      try { detail = object(await this.call<unknown>(`/v1/vms/${encodeURIComponent(vmId)}`)); } catch (error) { if (!isMissing(error)) throw error; }
      const binding = [...this.bindings.values()].find(row => row.vmId === vmId);
      vms.push({
        vmId, detail, ...(binding ? { binding: { owner: binding.owner === HUMAN ? 'software-page' : 'conversation', chatId: binding.owner === HUMAN ? null : binding.owner, environmentId: binding.environmentId, controller: controllerOf(binding), allocatedAt: binding.allocatedAt } } : {}),
        brief: root ? join(root, projectId, 'recordings', vmId, 'task.json') : null,
        recordings: rows.filter(row => row.vm_id === vmId).map(row => { const id = platformId(row.recording_id, 'recording_id'); return { id, row, directory: root ? join(root, projectId, 'recordings', vmId, id) : null }; }),
      });
    }
    return { vms, operationsLog: this.operationsLog(taskId) };
  }
  /** A recording of the task, as vm_manager confirms it, and its result directory. */
  private async recordingLocation(taskId: string, recordingId: unknown): Promise<{ recording: VmRecording; directory: string }> {
    const root = this.recordingsRoot(); if (!root) throw new Error('没有配置 STUDIO_VMM_PROJECTS_ROOT，读取不到采集结果');
    const id = platformId(recordingId, 'recordingId'), task = this.ctx.studioDomain.task(taskId), row = object(await this.call<unknown>(`/v1/recordings/${encodeURIComponent(id)}`));
    if (row.project_id !== task.projectId || row.task_id !== taskId) throw new Error('该采集记录不属于当前任务');
    const value = recording(row); if (value.id !== id) throw new Error('虚拟机平台返回的采集记录不匹配');
    return { recording: value, directory: join(root, task.projectId, 'recordings', value.vmId, value.id) };
  }
  /** The labelled steps of one recording, a page at a time. */
  async recordingSteps(taskId: string, recordingId: unknown, offset: number, limit: number): Promise<{ recording: VmRecording; total: number; offset: number; steps: RecordingStep[] }> {
    const { recording: row, directory } = await this.recordingLocation(taskId, recordingId);
    const loaded = row.status === 'recording' ? null : await loadEpisode(directory, await readOperations(this.operationsLog(taskId))), steps = loaded?.steps ?? [];
    return { recording: { ...row, episode: loaded?.episode ?? null }, total: steps.length, offset, steps: steps.slice(offset, offset + limit) };
  }
  async recordingFile(taskId: string, recordingId: unknown, path: unknown, range: string | null): Promise<Response> {
    const { directory } = await this.recordingLocation(taskId, recordingId);
    return episodeFileResponse(await openEpisodeFile(directory, path), range);
  }
  async recordingZip(taskId: string, recordingId: unknown): Promise<Response> {
    const { recording: row, directory } = await this.recordingLocation(taskId, recordingId);
    if (row.status === 'recording') throw new Error('采集还在进行，停止后才能下载');
    return new Response(await zipEpisode(directory, row.id), { headers: { 'content-type': 'application/zip', 'content-disposition': zipDisposition(`trajectory-${row.id}.zip`), 'x-content-type-options': 'nosniff' } });
  }
  /** Recordings start automatically when a VM becomes running; this is the supplementary start/stop control. */
  recorder(taskId: string, enabled: boolean, selected?: string, vmId?: string) {
    return this.serial(taskId, async () => {
      if (!this.ctx.studioDomain.view(taskId).writable) throw new Error('当前任务只读，不能更改轨迹采集');
      const binding = this.bound(taskId, selected, HUMAN, vmId); if (!binding?.vmId) throw new Error('请先启动虚拟机');
      const detail = await this.detail(binding); if (!detail) throw new Error('虚拟机已不存在，请重新启动');
      if (enabled) await this.call(`${this.path(binding)}/recordings`, 'POST', {});
      else if (detail.current_recording_id) await this.call(`/v1/recordings/${encodeURIComponent(platformId(detail.current_recording_id, 'recording_id'))}/stop`, 'POST', undefined, this.config.vmStopTimeoutMs);
      return { seat: await this.current(binding) };
    });
  }
  async dispose() {
    this.closing = true; clearInterval(this.sweeper); this.licenseAbort.abort();
    await Promise.allSettled([...this.licenseJobs.values()]);
    await Promise.allSettled([...this.queues.values()]);
    await this.persistence.catch(() => {});
    await this.jobs.flush();
  }
  agent(agent: Agent | undefined, signal?: AbortSignal): { taskId: string; actor: Actor } { const lease = this.ctx.studio.taskLease(agent); return { taskId: lease.taskId, actor: { actor: 'agent', ownerId: agent!.id, chatId: ownerId(agent!.id), lease, signal } }; }
}

const IMAGE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    attachmentId: { type: 'string', required: true }, mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
    bytes: { type: 'integer', required: true }, width: { type: 'integer', required: true }, height: { type: 'integer', required: true }, name: { type: 'string' },
    originalDimensions: { type: 'object', additionalProperties: false, properties: { width: { type: 'integer', required: true }, height: { type: 'integer', required: true } } },
  },
} as const;
/** Whether the calling conversation's current model accepts images (e.g. deepseek-flash, not deepseek-v4-pro). */
async function imageCapable(ctx: Context, exec: ToolExecution): Promise<boolean> {
  const agent = exec.agent as { session?: { requestHeader?(): { config?: { provider?: string; model?: string } } | undefined }; options?: { provider?: string; model?: string } } | undefined;
  const routed = agent?.session?.requestHeader?.()?.config, provider = routed?.provider ?? agent?.options?.provider, model = routed?.model ?? agent?.options?.model, llm = ctx.get('llm');
  if (!provider || !model || !llm) return false;
  try { return (await llm.resolveModelInfo(provider, model, exec.signal)).inputModalities?.includes('image') === true; } catch { return false; }
}
const truncate = (value: unknown, limit: number) => { const value_ = typeof value === 'string' ? value : ''; return value_.length > limit ? `${value_.slice(0, limit)}\n…（已截断，共 ${value_.length} 个字符）` : value_; };
/** Agent operations through the VM's agent service; see StudioVmSeats.operate for the guards. */
function vmOperationTools(ctx: Context, seats: StudioVmSeats, output: { schema: { type: 'string' }; render(args: unknown, value: string): { type: 'text'; text: string }[] }, imageParameter: { type: 'string'; description: string }) {
  const target = { imageId: imageParameter, vmId: { type: 'string' as const, description: 'A vmId of this task from studio_software_status. Omit to operate this conversation’s own VM.' } };
  const run = <T>(args: { imageId?: string; vmId?: string }, exec: ToolExecution, kind: 'read' | 'write', tool: string, summary: string, action: (agent: AgentClient) => Promise<T>, detail?: Record<string, unknown>) => {
    const { taskId, actor } = seats.agent(exec.agent, exec.signal);
    return abortable(seats.operate(taskId, actor, { imageId: environmentId(args.imageId), vmId: optionalVmId(args.vmId) }, kind, tool, summary, action, detail), exec.signal);
  };
  const post = async (agent: AgentClient, path: string, body: unknown, timeoutMs: number, signal: AbortSignal) => Buffer.from((await agent(path, { method: 'POST', body, timeoutMs, signal })).data).toString('utf8').slice(0, 2000);
  const bounded = (value: unknown, label: string, max: number) => { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} 须为 1–${max} 个字符`); return value; };
  return [
    defineTool({ name: 'studio_vm_screenshot', description: 'Capture the current screen of a running VM of this task (default: this conversation’s VM). With an image-capable model (e.g. deepseek-flash) the screenshot is returned to you; otherwise it is saved to this conversation’s temporary files for the user and you should use studio_vm_ui_tree. Coordinates are screen pixels.', parameters: target,
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true }, image: IMAGE_SCHEMA } },
        render: (_args: unknown, value: { text: string; image?: ImageAttachmentRef }): ContentBlock[] => value.image ? [{ type: 'text', text: value.text }, { type: 'image', attachment: value.image }] : [{ type: 'text', text: value.text }],
      },
      async execute(args, exec) {
        const shot = await run(args, exec, 'read', 'screenshot', '', async agent => { const response = await agent('/screenshot', { timeoutMs: 30000, maxBytes: 20 * 1024 * 1024, signal: exec.signal }); const size = pngSize(response.data); if (!size) throw new VmAgentError('截图不是有效的 PNG 图片'); return { data: response.data, ...size }; });
        const name = `vm-screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`, attachments = ctx.get('attachments');
        if (attachments && await imageCapable(ctx, exec)) {
          const image = await attachments.saveImage({ data: shot.data, mediaType: 'image/png', name });
          const scale = image.width === shot.width ? '图片坐标即屏幕像素' : `图片已缩放为 ${image.width}x${image.height}，坐标乘以 ${(shot.width / image.width).toFixed(2)} 换算为屏幕像素`;
          return { text: `虚拟机屏幕截图，屏幕分辨率 ${shot.width}x${shot.height}；${scale}。`, image: { ...image } };
        }
        try {
          const saved = await ctx.studio.files.writeScratchBytes(ctx.studio.chatLease(exec.agent!.id, true), exec.agent!.id, `vm-screenshots/${name}`, shot.data, exec.signal);
          return { text: `当前模型不支持图片输入。截图（${shot.width}x${shot.height}）已保存到本对话临时文件 ${saved.path}，供用户查看；请用 studio_vm_ui_tree 读取界面元素和坐标。` };
        } catch { return { text: `当前模型不支持图片输入，截图（${shot.width}x${shot.height}）未能保存；请用 studio_vm_ui_tree 读取界面元素和坐标。` }; }
      } }),
    defineTool({ name: 'studio_vm_ui_tree', description: 'Read the UI element tree of a running VM as compact indented lines: control type, "name", (x,y widthxheight) in screen pixels, [disabled]/[focused]. Filter by a window title substring to keep it short. backend uia (default, ~5 s, richer) or win32 (fast).', parameters: { ...target, window: { type: 'string', description: 'Case-insensitive substring of the top-level window title to keep, e.g. "AutoCAD" or "Notepad".' }, backend: { type: 'string', enum: ['uia', 'win32'] }, maxChars: { type: 'integer', description: 'Output limit, 1000–30000, default 8000.' } }, output,
      async execute(args, exec) {
        const backend = args.backend === 'win32' ? 'win32' : 'uia', maxChars = Math.min(30000, Math.max(1000, Number.isInteger(args.maxChars) ? args.maxChars! : 8000));
        const xml = await run(args, exec, 'read', 'ui_tree', `${backend}${args.window ? ` window=${args.window}` : ''}`, async agent => { const value = agentJson(await agent(`/accessibility?backend=${backend}`, { timeoutMs: 90000, maxBytes: 16 * 1024 * 1024, signal: exec.signal })); if (typeof value.AT !== 'string') throw new VmAgentError('虚拟机没有返回界面元素树'); return value.AT; });
        const tree = compactTree(xml, { ...(args.window ? { window: args.window } : {}), maxChars });
        return `顶层窗口：${JSON.stringify(tree.windows.slice(0, 30))}\n${tree.text || '（没有匹配的可见元素）'}${tree.truncated ? `\n…（已截断到 ${maxChars} 个字符，请用 window 过滤或增大 maxChars）` : ''}`;
      } }),
    defineTool({ name: 'studio_vm_run', description: 'Run a cmd.exe command line in the VM (Windows, as the logged-in user, UTF-8 console) and wait up to 110 s for it to exit; returns returncode, stdout (first 12000 chars) and stderr. On timeout the whole process tree (including PowerShell started by the command) is ended and timedOut is returned. For work that may take longer (a solve, a model rebuild, a batch export) pass background: true instead: the command starts at once and you get a jobId; follow it with studio_vm_job_status (waitSeconds up to 120), never start it again. Background output and state go to D:\\.studio-jobs\\<jobId>\\ (stdout.txt, stderr.txt, job.json, also readable as task files); maxMinutes (default 60, at most 1440 and never past the VM run expiry) ends the whole process tree when reached. At most 3 background jobs run per VM. Background commands must not use the mouse or keyboard. Keep commands targeted: list specific folders instead of recursive scans of large trees such as C:\\Program Files (dir /s or Get-ChildItem -Recurse there takes minutes), and write long output to a D:\\ file and read only the part you need. For GUI programs use studio_vm_launch instead, which does not wait. D:\\ is this task’s file workspace, F:\\ the project shared folder, E:\\<taskId> read-only upstream results. Never run destructive commands without the user’s agreement.', parameters: { ...target, command: { type: 'string', required: true, description: 'Command line, e.g. "dir D:\\" or "powershell -NoProfile -Command Get-ChildItem D:\\".' }, background: { type: 'boolean', description: 'Start the command as a background job and return its jobId at once, for commands that may run longer than 110 s.' }, maxMinutes: { type: 'integer', description: 'With background: the longest the job may run, 1–1440 minutes, default 60; it must end before the VM run expires.' } }, output,
      async execute(args, exec) {
        const command = bounded(args.command, 'command', 8000);
        if (args.background === true) {
          const { taskId, actor } = seats.agent(exec.agent, exec.signal);
          const job = await abortable(seats.startJob(taskId, actor, { imageId: environmentId(args.imageId), vmId: optionalVmId(args.vmId) }, command, jobMinutes(args.maxMinutes)), exec.signal);
          return JSON.stringify({ ...job, next: `后台任务已启动。用 studio_vm_job_status({jobId:"${job.jobId}",waitSeconds:120}) 定期查询进度和输出，不要重复启动同一条命令。` });
        }
        if (args.maxMinutes !== undefined) throw new Error('maxMinutes 只用于 background: true 的后台运行');
        const result = await run(args, exec, 'write', 'run', command, agent => execute(agent, command, 110, exec.signal));
        return JSON.stringify({ returncode: result.returncode ?? null, ...(result.timedOut ? { timedOut: true, note: '命令 110 秒内没有结束，已结束整个进程树；可以拆成更有针对性的小命令，确实需要长时间运行时改用 background: true 后台运行，不要重复同一个长命令。' } : {}), stdout: truncate(result.stdout, 12000), stderr: truncate(result.stderr, 4000) });
      } }),
    defineTool({ name: 'studio_vm_job_status', description: 'Read a background job started with studio_vm_run background: true: state (starting, running, exited, canceled, timedOut, interrupted: Windows restarted or the VM stopped while it ran, unknown: its outcome cannot be known now or ever, failed: it never started), returncode, times, note, and the last 12000 chars of stdout and 4000 of stderr with their sizes in bytes. Pass waitSeconds (up to 120) to wait while it runs; the answer comes as soon as it ends. Without jobId, lists this conversation’s background jobs (newest 20, no output). A job is never restarted automatically: after interrupted or unknown, decide with the user whether to run it again.', parameters: { jobId: { type: 'string', description: 'The jobId from studio_vm_run. Omit to list this conversation’s jobs.' }, waitSeconds: { type: 'integer', description: 'Seconds to wait while the job runs, 0–120, default 0.' } }, output,
      async execute(args, exec) {
        throwIfAborted(exec.signal);
        const { taskId, actor } = seats.agent(exec.agent, exec.signal);
        if (args.jobId === undefined || args.jobId === '') return JSON.stringify(await abortable(seats.jobList(taskId, actor), exec.signal));
        const wait = Math.min(120, Math.max(0, Number.isInteger(args.waitSeconds) ? args.waitSeconds! : 0));
        const job = await abortable(seats.jobStatus(taskId, actor, jobId(args.jobId), wait), exec.signal);
        return JSON.stringify(job.state === 'running' || job.state === 'starting' ? { ...job, next: '仍在运行。稍后再用 waitSeconds 查询，不要重复启动；完整输出在 taskPath 下的 stdout.txt 和 stderr.txt。' } : job);
      } }),
    defineTool({ name: 'studio_vm_job_cancel', description: 'Cancel a background job of this conversation: ends its whole process tree (programs it started included) and waits up to about 15 s. Only with the user’s agreement or when the job is clearly wrong; output written so far stays in its folder.', parameters: { jobId: { type: 'string', required: true } }, output,
      async execute(args, exec) { const { taskId, actor } = seats.agent(exec.agent, exec.signal); return JSON.stringify(await abortable(seats.cancelJob(taskId, actor, jobId(args.jobId)), exec.signal)); } }),
    defineTool({ name: 'studio_vm_input', description: 'Send mouse and keyboard input to the VM screen, in order. actions is a JSON array of up to 50 steps: {"type":"click","x":..,"y":..,"button"?:"left|right|middle","clicks"?:1-3}, {"type":"move","x","y"}, {"type":"drag","x","y","toX","toY"}, {"type":"scroll","amount":-50..50,"x"?,"y"?}, {"type":"type","text":"..."} (any Unicode, \\n presses Enter), {"type":"key","keys":["ctrl","s"]} (pyautogui key names, pressed together), {"type":"wait","seconds":0-10}. Coordinates are screen pixels from studio_vm_ui_tree or the screenshot. Take a screenshot or read the tree afterwards to verify.', parameters: { ...target, actions: { type: 'string', required: true, description: 'JSON array of input steps.' } }, output,
      async execute(args, exec) {
        if (args.actions.length > 20000) throw new Error('actions 过长');
        let parsed: unknown; try { parsed = JSON.parse(args.actions); } catch { throw new Error('actions 须为 JSON 数组'); }
        const actions = inputActions(parsed);
        // The VM types text by pasting it, so the trajectory only shows ctrl+v; the log keeps what was typed.
        const typedText = actions.flatMap(action => action.type === 'type' ? [action.text] : []);
        await run(args, exec, 'write', 'input', JSON.stringify(actions).slice(0, 500), async agent => agentJson(await agent('/execute_windows', { method: 'POST', body: { command: inputScript(actions) }, timeoutMs: 120000, signal: exec.signal })), { actions, ...(typedText.length ? { typedText } : {}) });
        return `已在虚拟机中执行 ${actions.length} 个输入操作；请截图或读取界面元素确认结果。`;
      } }),
    defineTool({ name: 'studio_vm_launch', description: 'Start a program in the VM without waiting for it, e.g. "notepad.exe" or a full path to acad.exe / SLDWORKS.exe. Use studio_vm_ui_tree afterwards to see its window.', parameters: { ...target, command: { type: 'string', required: true } }, output,
      async execute(args, exec) { const command = bounded(args.command, 'command', 2000); return run(args, exec, 'write', 'launch', command, agent => post(agent, '/setup/launch', { command }, 30000, exec.signal)); } }),
    defineTool({ name: 'studio_vm_open_file', description: 'Open a file in the VM with its associated program, e.g. "D:\\drawing.dwg". Waits about 5 seconds.', parameters: { ...target, path: { type: 'string', required: true } }, output,
      async execute(args, exec) { const path = bounded(args.path, 'path', 1000); return run(args, exec, 'write', 'open_file', path, agent => post(agent, '/setup/open_file', { path }, 60000, exec.signal)); } }),
    defineTool({ name: 'studio_vm_window', description: 'Activate (bring to front) or close a VM window whose title contains the given text.', parameters: { ...target, action: { type: 'string', required: true, enum: ['activate', 'close'] }, title: { type: 'string', required: true } }, output,
      async execute(args, exec) {
        const title = bounded(args.title, 'title', 300), path = args.action === 'close' ? '/setup/close_window' : '/setup/activate_window';
        return run(args, exec, 'write', `window_${args.action === 'close' ? 'close' : 'activate'}`, title, agent => post(agent, path, { window_name: title }, 30000, exec.signal));
      } }),
    defineTool({ name: 'studio_vm_milestone', description: 'Mark a named checkpoint in the trajectory recording of a running VM of this task (default: this conversation’s VM), e.g. after finishing a sketch, a part, an assembly or an analysis step. The recorder commits a snapshot of the task files (D:) under this name, so the recording can be reviewed and restored by checkpoints. Recording runs automatically while the VM runs; the user can also press Ctrl+Alt+Shift+M in the VM.', parameters: { ...target, name: { type: 'string', required: true, description: 'Short checkpoint name, e.g. "连杆草图完成".' } }, output,
      async execute(args, exec) {
        const name = bounded(args.name, 'name', 200);
        return run(args, exec, 'read', 'milestone', name, async agent => {
          try { agentJson(await agent('/recording/milestone', { method: 'POST', body: { name }, timeoutMs: 30000, signal: exec.signal })); }
          catch (error) {
            if (error instanceof VmAgentError && error.message.includes('HTTP 409')) throw new VmAgentError('这台虚拟机现在没有进行中的轨迹采集，检查点没有记录');
            if (error instanceof VmAgentError && /not found/i.test(error.message)) throw new VmAgentError('这台虚拟机的镜像还没有安装轨迹采集接口，检查点没有记录');
            throw error;
          }
          return `已在轨迹采集中记录检查点“${name}”，D 盘任务文件的当前版本已随之快照。`;
        });
      } }),
  ];
}
async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort = () => {};
  const canceled = new Promise<never>((_resolve, reject) => { onAbort = () => reject(abortError(signal)); signal.addEventListener('abort', onAbort, { once: true }); if (signal.aborted) onAbort(); });
  try { return await Promise.race([operation, canceled]); } finally { signal.removeEventListener('abort', onAbort); }
}
export async function applyVmSeats(ctx: Context, config: VmSeatsConfig) {
  if (!config.vmPromptPath) throw new Error('vm-manager backend requires vmPromptPath');
  const seats = new StudioVmSeats(ctx, config); await seats.initialize();
  registerProjectExport(ctx, seats);
  ctx.effect(() => ctx.studio.registerQuiescence('software-seat', ids => seats.quiesce(ids)), 'studio-seat: VM stop, D: freeze and deletion');
  ctx.effect(() => ctx.studio.registerVmCounter?.(owners => seats.activeVmCount(owners)) ?? (() => {}), 'studio-seat: autonomy VM count');
  const { prompt: instructions } = await loadPromptFile(config.vmPromptPath);
  ctx.effect(() => () => seats.dispose(), 'studio-seat: VM lifecycle');
  const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] };
  const imageParameter = { type: 'string' as const, description: 'A software environment ID from studio_software_catalog. Required when this conversation has VMs of several environments.' };
  const tools = [
    defineTool({ name: 'studio_software_catalog', description: 'List software environments of the vm-manager platform and the host capacity. Each image is one Windows VM with preinstalled real industrial software (mock:false), operated over VNC; capabilities are empty because there is no Bridge. resources.host gives CPU cores and memory (GB) available to new VMs and how many VMs run or queue; a VM takes ramGb + resources.overheadRamGb of memory; resources.environments[].launchable is how many VMs of that environment could start right now at the minimum spec. Creating environments is unsupported.', parameters: {}, output, async execute(_args, exec) { throwIfAborted(exec.signal); ctx.studio.graphPlanningScope(exec.agent); const catalog = await seats.catalog(); let resources: VmResources | { error: string }; try { resources = await seats.resources(); } catch (error) { resources = { error: error instanceof Error ? error.message : String(error) }; } return JSON.stringify({ ...catalog, resources }); } }),
    defineTool({ name: 'studio_software_launch', description: 'Start a Windows VM of the selected environment for this conversation. By default it reuses this conversation’s VM of that environment, restarting it when stopped or failed (C: drive preserved as it was when Windows shut down; programs and unsaved work are gone); pass vmId when the conversation has several, or newVm:true to start an additional VM (only when the user wants several at once). cpuCores and ramGb default to the environment minimum; check studio_software_catalog resources first and do not take more than the work needs. All VMs of the task share its D: drive, which is the task file workspace. Creation is queued and asynchronous: first boot usually takes 2-8 minutes. Poll studio_software_status until ready; never relaunch to speed it up. After a timeout or error, read status before retrying with the same requestId.', parameters: { imageId: { ...imageParameter, required: true }, requestId: { type: 'string', required: true }, vmId: { type: 'string', description: 'This conversation’s VM to restart or to change the run limit of.' }, newVm: { type: 'boolean', description: 'Start an additional VM even though this conversation already has one of this environment.' }, cpuCores: { type: 'integer', description: 'CPU cores for a new VM, at least the environment minimum.' }, ramGb: { type: 'integer', description: 'Memory in GB for a new VM, at least the environment minimum.' }, runMinutes: { type: 'integer', description: `Run limit in minutes, 1–${MAX_RUN_MINUTES}; the VM stops automatically when it expires. Omit to keep the VM’s own limit (new VMs: ${DEFAULT_RUN_MINUTES} unless the deployment sets another default). Only set it when the user asked for a run time; on a running VM it changes the limit, counted from when this run started.` } }, output, async execute(args, exec) {
      const { taskId, actor } = seats.agent(exec.agent, exec.signal), vmId = optionalVmId(args.vmId);
      if (vmId) return JSON.stringify(await abortable(seats.start(taskId, vmId, actor, runMinutes(args.runMinutes)), exec.signal));
      return JSON.stringify(await abortable(seats.create(taskId, environmentId(args.imageId)!, requestId(args.requestId), actor, runMinutes(args.runMinutes), { ...launchOptions({ cpuCores: args.cpuCores, ramGb: args.ramGb }), reuse: args.newVm !== true }), exec.signal));
    } }),
    defineTool({ name: 'studio_software_status', description: 'Read every VM of this task (each conversation’s, plus older ones owned by none): owner and chatId, controller (agent: you may operate it; human: the user took over and you may only take screenshots and UI trees), state (provisioning/ready/stopping/stopped/failed), queue position and reason, error code, run expiry, mounted upstream tasks and whether the VNC view is available. With imageId selects that environment. While this conversation’s VM boots or its Windows restarts (unreachableSince set) or Studio checks and renews its Windows evaluation licence (license missing or license.state checking/rearming, which reboots Windows once), pass waitSeconds (up to 120) to wait for it instead of calling repeatedly: the answer comes as soon as it is ready, or when the time is up.', parameters: { imageId: imageParameter, waitSeconds: { type: 'integer', description: 'Seconds to wait while this conversation’s VM is provisioning or stopping, 0–120, default 0.' } }, output, async execute(args, exec) {
      throwIfAborted(exec.signal);
      const { taskId, actor } = seats.agent(exec.agent, exec.signal), id = environmentId(args.imageId);
      const until = Date.now() + Math.min(120, Math.max(0, Number.isInteger(args.waitSeconds) ? args.waitSeconds! : 0)) * 1000;
      const changing = (view: { seats: StudioVmSeatView[] }) => view.seats.some(row => row.chatId === actor.chatId && (row.state === 'provisioning' || row.state === 'stopping' || (row.state === 'ready' && (!!row.unreachableSince || !row.license || row.license.state === 'checking' || row.license.state === 'rearming'))));
      let view = await seats.get(taskId, id);
      // vm_manager recommends polling a VM every 5 seconds; a model cannot sleep between calls, so the tool waits.
      for (let wait = Math.min(10000, until - Date.now()); changing(view) && wait > 0; wait = Math.min(10000, until - Date.now())) {
        await delay(wait, undefined, { signal: exec.signal }); view = await seats.get(taskId, id);
      }
      return JSON.stringify(view);
    } }),
    defineTool({ name: 'studio_software_release', description: 'Shut down Windows and stop one of this conversation’s own VMs (by vmId, or its only VM of the selected environment); its C: drive and the task’s D: drive are kept and studio_software_launch restarts it. Unsaved work inside the software is lost, so only call after the user explicitly agreed. Waits up to about 3 minutes. Never stops other owners’ VMs and never deletes a VM.', parameters: { imageId: imageParameter, vmId: { type: 'string', description: 'This conversation’s VM to stop.' } }, output, async execute(args, exec) { const { taskId, actor } = seats.agent(exec.agent, exec.signal); return JSON.stringify(await abortable(seats.release(taskId, true, environmentId(args.imageId), false, optionalVmId(args.vmId), actor.chatId), exec.signal)); } }),
    ...vmOperationTools(ctx, seats, output, imageParameter),
  ];
  for (const tool of tools) ctx.tools.register({ ...tool, parameters: { ...tool.parameters, additionalProperties: false } });
  ctx.effect(() => ctx.studio.registerInstructions('software-seat-text', 113, instructions), 'studio-seat: VM prompt file');
  const query = (request: Request) => new URL(request.url).searchParams;
  for (const [path, methods, action] of [
    ['catalog', ['GET'], async () => seats.catalog()],
    ['seats', ['GET'], async (request: Request) => seats.list(text(query(request).get('taskId'), 'taskId'))],
    ['seat', ['GET', 'POST'], async (request: Request) => {
      if (request.method === 'GET') return seats.get(text(query(request).get('taskId'), 'taskId'), environmentId(query(request).get('imageId')));
      const data = object(await request.json()), selected = environmentId(data.imageId); if (!selected) throw new Error('请选择要启动的软件环境imageId');
      return seats.create(text(data.taskId, 'taskId'), selected, requestId(data.requestId), human, runMinutes(data.runMinutes), launchOptions(data));
    }],
    ['release', ['POST'], async (request: Request) => {
      const data = object(await request.json()); if (data.discard !== undefined && typeof data.discard !== 'boolean') throw new Error('Invalid discard');
      return seats.release(text(data.taskId, 'taskId'), data.confirm === true, environmentId(data.imageId), data.discard === true, optionalVmId(data.vmId));
    }],
    ['records', ['GET'], async (request: Request) => seats.records(text(query(request).get('taskId'), 'taskId'), environmentId(query(request).get('imageId')), optionalVmId(query(request).get('vmId')))],
    ['recordings', ['GET'], async (request: Request) => seats.taskRecordings(text(query(request).get('taskId'), 'taskId'))],
    ['recording', ['GET'], async (request: Request) => {
      const values = query(request), offset = Number(values.get('offset') ?? 0), limit = Number(values.get('limit') ?? 200);
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid page');
      return seats.recordingSteps(text(values.get('taskId'), 'taskId'), values.get('recordingId'), offset, limit);
    }],
    ['recorder', ['POST'], async (request: Request) => { const data = object(await request.json()); if (typeof data.enabled !== 'boolean') throw new Error('Invalid recorder flag'); return seats.recorder(text(data.taskId, 'taskId'), data.enabled, environmentId(data.imageId), optionalVmId(data.vmId)); }],
    ['progress', ['GET'], async (request: Request) => seats.taskProgress(text(query(request).get('taskId'), 'taskId'))],
    ['start', ['POST'], async (request: Request) => { const data = object(await request.json()); return seats.start(text(data.taskId, 'taskId'), platformId(data.vmId, 'vmId'), human, runMinutes(data.runMinutes)); }],
    ['controller', ['POST'], async (request: Request) => { const data = object(await request.json()); return seats.setController(text(data.taskId, 'taskId'), platformId(data.vmId, 'vmId'), data.controller); }],
    ['license', ['POST'], async (request: Request) => { const data = object(await request.json()); return seats.license(text(data.taskId, 'taskId'), platformId(data.vmId, 'vmId'), data.action); }],
    ['assign', ['POST'], async (request: Request) => { const data = object(await request.json()); return seats.assign(text(data.taskId, 'taskId'), platformId(data.vmId, 'vmId'), ownerId(data.chatId)); }],
    ['resources', ['GET'], async () => seats.resources()],
    ['jobs', ['GET'], async (request: Request) => seats.taskJobs(text(query(request).get('taskId'), 'taskId'))],
    ['job-cancel', ['POST'], async (request: Request) => { const data = object(await request.json()); return seats.humanCancelJob(text(data.taskId, 'taskId'), platformId(data.vmId, 'vmId'), jobId(data.jobId)); }],
    ...(['control', 'invoke', 'ack-unknown', 'cancel', 'artifact'] as const).map(name => [name, ['POST'], async () => { throw new Error(VM_MODE_UNSUPPORTED); }] as const),
    ...(['operation', 'events'] as const).map(name => [name, ['GET'], async () => { throw new Error(VM_MODE_UNSUPPORTED); }] as const),
  ] as const) ctx.connection.fetch.register({ path: '/api/studio/software/' + path, methods: [...methods], requestBody: 'buffered', async fetch(request) { try { return Response.json(await ctx.studioDomain.webAction(request, async () => action(request))); } catch (error) { return Response.json({ error: error instanceof Error ? error.message : '软件接口错误' }, { status: 400 }); } } });
  // Recording files (screenshots, the video with Range requests) and the whole recording as a ZIP.
  for (const [path, action] of [
    ['recording-file', (request: Request) => seats.recordingFile(text(query(request).get('taskId'), 'taskId'), query(request).get('recordingId'), query(request).get('path'), request.headers.get('range'))],
    ['recording-zip', (request: Request) => seats.recordingZip(text(query(request).get('taskId'), 'taskId'), query(request).get('recordingId'))],
  ] as const) ctx.connection.fetch.register({ path: '/api/studio/software/' + path, methods: ['GET'], requestBody: 'buffered', async fetch(request) { try { return await action(request); } catch (error) { return Response.json({ error: error instanceof Error ? error.message : '读取采集结果失败' }, { status: 400 }); } } });
}
