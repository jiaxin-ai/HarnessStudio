/** sandbox_manager: one Linux container per Studio conversation, for the Agent's commands.
 *
 * Studio cannot start containers itself (the Docker socket is root on the host), so this small service owns
 * them. Studio decides what a conversation may reach and sends it as mounts; this service only accepts folders of
 * that conversation's project under the projects root (vm_manager's, or the task spaces in Studio's own data volume when
 * Studio runs without software), runs every sandbox with the configured runtime
 * (gVisor runsc in production) and a network whose only way out is the egress proxy. Studio also sends the limits the
 * user chose on the settings page; they must stay within this service's ceilings, which the host owner sets. */
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { lstat, realpath } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';

export interface SandboxManagerOptions {
  token: string;
  /** vm_manager's <data_root>/projects, at the same path as on the host; or, with filesVolume, the folder of task spaces
   * inside that volume as this service sees it (mounted read-only at filesVolumeRoot). */
  projectsRoot: string;
  /** Task spaces in a Docker volume instead of on the host (Studio without vm_manager keeps them in its data volume): each
   * mount becomes a subpath of this volume, and files a sandbox writes as root are handed back to the owner of projectsRoot. */
  filesVolume?: string; filesVolumeRoot?: string;
  image: string; runtime: string; network: string; proxy: string;
  /** Ceilings of what Studio may ask for; used as is when a request sends no limits. */
  maxCpus: number; maxMemoryGb: number; maxRunning: number;
  pids: number; tmpMb: number; idleMinutes: number; removeHours: number;
  dockerSocket: string;
  /** Studio's data volume and Studio's folder in it; its skills/ and plugins/ are mounted read-only at /skills and /plugins. */
  studioVolume?: string; studioSubpath?: string;
  /** Kept per stream of one command; the runner keeps the start and the last 64 KiB. */
  outputBytes?: number;
  maxTimeoutSeconds?: number; defaultTimeoutSeconds?: number;
  log?: (line: string) => void;
}
export interface Mount { source: string; target: string; readonly: boolean }
export interface Limits { cpus: number; memory_gb: number; max_running: number; idle_minutes: number }
/** Folders of Studio's data volume a sandbox may see, read-only, each at /<name>. */
export const LIBRARIES = ['skills', 'plugins'] as const;
export type Library = typeof LIBRARIES[number];
export interface EnsureRequest { owner: string; project_id: string; task_id?: string; mounts: Mount[]; limits?: Limits; libraries?: Library[] }
export interface ExecRequest { exec_id: string; command: string; cwd: string; timeout_s?: number; env?: Record<string, string> }

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const fail = (status: number, code: string, message: string): never => { throw new ApiError(status, code, message); };
const LABEL = 'harnessstudio.sandbox';
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/, OWNER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'INVALID_REQUEST', '需要 JSON 对象');
  const data = value as Record<string, unknown>;
  const extra = Object.keys(data).find(key => !allowed.includes(key));
  if (extra) fail(400, 'INVALID_REQUEST', `不支持的字段：${extra}`);
  return data;
}
function id(value: unknown, field: string, pattern = ID): string {
  if (typeof value !== 'string' || !pattern.test(value)) fail(400, 'INVALID_REQUEST', `${field} 无效`);
  return value as string;
}

/** The only places a sandbox sees, each tied to one folder of its own project. */
export function mountRule(target: string, taskId: string | undefined): { relative: string; readonlyRequired: boolean } | undefined {
  if (target === '/workspace') return taskId ? { relative: join('tasks', taskId), readonlyRequired: false } : undefined;
  if (target === '/shared') return { relative: 'shared', readonlyRequired: false };
  if (target === '/tasks') return { relative: 'tasks', readonlyRequired: true };
  const input = /^\/inputs\/([a-z0-9][a-z0-9-]{0,63})$/.exec(target);
  if (input && input[1] !== taskId) return { relative: join('tasks', input[1]!), readonlyRequired: true };
  return undefined;
}

/** A folder inside the files volume, relative to where this service mounted that volume. */
export function volumeSubpath(volumeRoot: string, source: string): string {
  if (!isAbsolute(volumeRoot)) throw new Error('filesVolumeRoot must be an absolute path');
  const path = relative(resolve(volumeRoot), resolve(source));
  if (!path || path.startsWith('..') || isAbsolute(path)) throw new Error(`${source} is not inside the files volume at ${volumeRoot}`);
  return path;
}

/** Checks the requested mounts against the rules above and the real folders on disk (no links, no other project). */
export async function validateMounts(projectsRoot: string, request: EnsureRequest): Promise<Mount[]> {
  if (!Array.isArray(request.mounts) || !request.mounts.length || request.mounts.length > 40) fail(400, 'INVALID_REQUEST', 'mounts 无效');
  const root = resolve(projectsRoot), seen = new Set<string>(), mounts: Mount[] = [];
  for (const raw of request.mounts) {
    const mount = object(raw, ['source', 'target', 'readonly']);
    if (typeof mount.source !== 'string' || typeof mount.target !== 'string' || typeof mount.readonly !== 'boolean') fail(400, 'INVALID_REQUEST', 'mount 字段无效');
    const target = mount.target as string, source = mount.source as string, readonly = mount.readonly as boolean;
    const rule = mountRule(target, request.task_id);
    if (!rule) fail(400, 'MOUNT_REFUSED', `不允许挂载到 ${target}`);
    if (seen.has(target)) fail(400, 'MOUNT_REFUSED', `重复的挂载点 ${target}`);
    if (rule!.readonlyRequired && !readonly) fail(400, 'MOUNT_REFUSED', `${target} 只能只读挂载`);
    const expected = join(root, request.project_id, rule!.relative);
    if (resolve(source) !== expected) fail(400, 'MOUNT_REFUSED', `${target} 的来源目录不属于这个项目`);
    let info; try { info = await lstat(expected); } catch { fail(404, 'MOUNT_MISSING', `目录不存在：${expected}`); }
    if (!info!.isDirectory() || info!.isSymbolicLink() || await realpath(expected) !== expected) fail(400, 'MOUNT_REFUSED', `${expected} 不是普通目录`);
    seen.add(target); mounts.push({ source: expected, target, readonly });
  }
  return mounts.sort((a, b) => a.target.localeCompare(b.target));
}

/** The user's limits from Studio, each within this service's ceilings. */
export function validateLimits(value: unknown, ceilings: Pick<SandboxManagerOptions, 'maxCpus' | 'maxMemoryGb' | 'maxRunning'>): Limits {
  const data = object(value, ['cpus', 'memory_gb', 'max_running', 'idle_minutes']);
  const number = (key: string, min: number, max: number, integer: boolean) => {
    const item = data[key];
    if (typeof item !== 'number' || !Number.isFinite(item) || item < min || item > max || (integer && !Number.isInteger(item))) fail(400, 'LIMIT_REFUSED', `${key} 须在 ${min}–${max} 之间`);
    return item as number;
  };
  return { cpus: number('cpus', 0.25, ceilings.maxCpus, false), memory_gb: number('memory_gb', 0.5, ceilings.maxMemoryGb, false),
    max_running: number('max_running', 1, ceilings.maxRunning, true), idle_minutes: number('idle_minutes', 1, 1440, true) };
}

export function validateExec(value: unknown, options: Required<Pick<SandboxManagerOptions, 'maxTimeoutSeconds' | 'defaultTimeoutSeconds'>>): ExecRequest & { timeout_s: number } {
  const data = object(value, ['exec_id', 'command', 'cwd', 'timeout_s', 'env']);
  const execId = id(data.exec_id, 'exec_id', OWNER);
  if (typeof data.command !== 'string' || !data.command.trim() || data.command.length > 16000 || data.command.includes('\0')) fail(400, 'INVALID_REQUEST', 'command 须为 1–16000 个字符');
  if (typeof data.cwd !== 'string' || !data.cwd.startsWith('/') || data.cwd.length > 1000 || data.cwd.includes('\0')) fail(400, 'INVALID_REQUEST', 'cwd 须为沙箱里的绝对路径');
  const timeout = data.timeout_s === undefined ? options.defaultTimeoutSeconds : data.timeout_s;
  if (!Number.isInteger(timeout) || (timeout as number) < 1 || (timeout as number) > options.maxTimeoutSeconds) fail(400, 'INVALID_REQUEST', `timeout_s 须为 1–${options.maxTimeoutSeconds}`);
  let env: Record<string, string> | undefined;
  if (data.env !== undefined) {
    const entries = Object.entries(object(data.env, Object.keys(data.env as object)));
    if (entries.length > 50 || entries.some(([key, item]) => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || typeof item !== 'string' || item.length > 8000 || item.includes('\0'))) fail(400, 'INVALID_REQUEST', 'env 无效');
    env = Object.fromEntries(entries) as Record<string, string>;
  }
  return { exec_id: execId, command: data.command as string, cwd: data.cwd as string, timeout_s: timeout as number, ...(env ? { env } : {}) };
}

interface DockerReply { status: number; body: Buffer }
/** One Docker Engine API call over the unix socket. */
function docker(socket: string, method: string, path: string, body?: unknown, signal?: AbortSignal, maxBytes = 32 * 1024 * 1024): Promise<DockerReply> {
  return new Promise((resolveReply, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const request = httpRequest({ socketPath: socket, method, path, headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}, ...(signal ? { signal } : {}) }, response => {
      const parts: Buffer[] = []; let bytes = 0;
      response.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > maxBytes) { response.destroy(new Error('Docker 返回的数据过大')); return; } parts.push(chunk); });
      response.on('end', () => resolveReply({ status: response.statusCode ?? 0, body: Buffer.concat(parts) }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(payload);
  });
}
const json = (reply: DockerReply): any => reply.body.length ? JSON.parse(reply.body.toString('utf8')) : {};
const dockerMessage = (reply: DockerReply) => { try { return String(json(reply).message ?? '').slice(0, 500); } catch { return reply.body.toString('utf8').slice(0, 500); } };
/** stdout and stderr of a non-TTY exec, from Docker's 8-byte frame headers. */
export function demux(data: Buffer): { stdout: Buffer; stderr: Buffer } {
  const out: Buffer[] = [], err: Buffer[] = [];
  for (let offset = 0; offset + 8 <= data.length;) {
    const size = data.readUInt32BE(offset + 4), frame = data.subarray(offset + 8, offset + 8 + size);
    (data[offset] === 2 ? err : out).push(frame); offset += 8 + size;
  }
  return { stdout: Buffer.concat(out), stderr: Buffer.concat(err) };
}

interface Container { Id: string; Names: string[]; State: string; Labels: Record<string, string> }

export class SandboxManager {
  private readonly lastUsed = new Map<string, number>();
  private readonly active = new Map<string, number>();
  /** Idle minutes of each sandbox, from the request that last ensured it. */
  private readonly idle = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly options: Required<Omit<SandboxManagerOptions, 'log' | 'studioVolume' | 'studioSubpath' | 'filesVolume' | 'filesVolumeRoot'>> & Pick<SandboxManagerOptions, 'log' | 'studioVolume' | 'studioSubpath' | 'filesVolume' | 'filesVolumeRoot'>;
  constructor(options: SandboxManagerOptions) {
    this.options = { outputBytes: 1024 * 1024, maxTimeoutSeconds: 1800, defaultTimeoutSeconds: 300, ...options };
    if (options.filesVolume) volumeSubpath(options.filesVolumeRoot ?? '', options.projectsRoot);
  }
  private log(line: string) { this.options.log?.(line); }
  /** Creating, starting and removing containers is serialized, so the running limit holds. */
  private serial<T>(step: () => Promise<T>): Promise<T> { const next = this.queue.catch(() => undefined).then(step); this.queue = next; return next; }
  private name(owner: string) { return `hs-sbx-${owner}`; }
  private async call(method: string, path: string, body?: unknown, ok = [200, 201, 204, 304]): Promise<any> {
    const reply = await docker(this.options.dockerSocket, method, path, body);
    if (!ok.includes(reply.status)) {
      const message = dockerMessage(reply);
      if (/unknown or invalid runtime|runtime.*not found/i.test(message)) fail(503, 'RUNTIME_MISSING', `沙箱运行时 ${this.options.runtime} 没有安装，沙箱不可用`);
      fail(reply.status === 404 ? 404 : 502, reply.status === 404 ? 'NOT_FOUND' : 'DOCKER_ERROR', `Docker：${message || reply.status}`);
    }
    return json(reply);
  }
  /** This instance's sandboxes only. The label is the same for every Studio on the host, but each instance has its own
   * sandbox network: without the network filter a test instance would stop, reap and count another instance's sandboxes. */
  async list(filters: Record<string, string[]> = {}): Promise<Container[]> {
    const label = [LABEL + '=1', ...(filters.label ?? [])];
    return this.call('GET', `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ ...filters, label, network: [this.options.network] }))}`);
  }
  private async find(owner: string): Promise<Container | undefined> {
    return (await this.list({ name: [`^/${this.name(owner)}$`] }))[0];
  }
  limits(request: EnsureRequest): Limits {
    const { maxCpus, maxMemoryGb, maxRunning, idleMinutes } = this.options;
    return request.limits ?? { cpus: maxCpus, memory_gb: maxMemoryGb, max_running: maxRunning, idle_minutes: idleMinutes };
  }
  private async spec(request: EnsureRequest, mounts: Mount[], limits: Limits) {
    const image = await this.call('GET', `/images/${encodeURIComponent(this.options.image)}/json`).catch(error => { if (error instanceof ApiError && error.status === 404) fail(503, 'IMAGE_MISSING', `沙箱镜像 ${this.options.image} 不存在`); throw error; });
    const { pids, tmpMb, runtime, network, proxy, studioVolume, studioSubpath } = this.options, { cpus, memory_gb: memoryGb } = limits;
    // Libraries are folders of Studio's data volume; only those folders are mounted, never the rest of the volume.
    // A misnamed volume must not be created empty by Docker, so a missing one only leaves the libraries out.
    const volume = request.libraries?.length && studioVolume ? await this.call('GET', `/volumes/${encodeURIComponent(studioVolume)}`).then(() => true, () => { this.log(`Studio volume ${studioVolume} not found; sandboxes start without /skills and /plugins`); return false; }) : false;
    const libraries = volume ? request.libraries!.map(name => ({ Type: 'volume', Source: studioVolume, Target: `/${name}`, ReadOnly: true, VolumeOptions: { NoCopy: true, Subpath: studioSubpath ? `${studioSubpath}/${name}` : name } })) : [];
    const hash = createHash('sha256').update(JSON.stringify({ image: image.Id, runtime, network, proxy, cpus, memoryGb, pids, tmpMb, mounts, libraries })).digest('hex').slice(0, 32);
    const env = ['HOME=/root', 'LANG=C.UTF-8', 'PYTHONIOENCODING=utf-8', 'MPLBACKEND=Agg', 'PIP_DISABLE_PIP_VERSION_CHECK=1',
      ...(proxy ? ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'].map(key => `${key}=${proxy}`) : []), 'NO_PROXY=localhost,127.0.0.1', 'no_proxy=localhost,127.0.0.1'];
    const body = {
      Image: image.Id, Cmd: ['sleep', 'infinity'], Hostname: 'sandbox', WorkingDir: request.task_id ? '/workspace' : '/shared', Env: env,
      Labels: { [LABEL]: '1', [`${LABEL}.owner`]: request.owner, [`${LABEL}.project`]: request.project_id, [`${LABEL}.task`]: request.task_id ?? '', [`${LABEL}.spec`]: hash },
      HostConfig: {
        Runtime: runtime, Init: true, NetworkMode: network, NanoCpus: Math.round(cpus * 1e9), Memory: Math.round(memoryGb * 1024 ** 3), MemorySwap: Math.round(memoryGb * 1024 ** 3), PidsLimit: pids,
        Mounts: [...mounts.map(mount => this.mount(mount)), ...libraries],
        Tmpfs: { '/tmp': `rw,nosuid,nodev,size=${tmpMb}m`, '/run/hs': 'rw,nosuid,nodev,noexec,size=1m' },
        CapDrop: ['ALL'], CapAdd: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID', 'KILL', 'SETGID', 'SETUID'],
        SecurityOpt: ['no-new-privileges'], RestartPolicy: { Name: 'no' }, LogConfig: { Type: 'json-file', Config: { 'max-size': '1m', 'max-file': '1' } },
      },
    };
    return { hash, body };
  }
  /** A validated folder: a bind mount of the host path, or the same folder as a subpath of the files volume. */
  private mount(mount: Mount) {
    const { filesVolume, filesVolumeRoot } = this.options;
    if (!filesVolume) return { Type: 'bind', Source: mount.source, Target: mount.target, ReadOnly: mount.readonly };
    return { Type: 'volume', Source: filesVolume, Target: mount.target, ReadOnly: mount.readonly, VolumeOptions: { NoCopy: true, Subpath: volumeSubpath(filesVolumeRoot!, mount.source) } };
  }
  /** Sandbox commands run as root. In a volume whose task spaces belong to Studio's own user, give what a command created back
   * to that user, so Studio can still edit, clear and delete those files. The owner comes from projectsRoot, which no sandbox
   * mounts, so a command cannot change whose files they are. */
  private async returnFiles(containerId: string): Promise<void> {
    if (!this.options.filesVolume) return;
    const info = await lstat(this.options.projectsRoot);
    if (info.uid === 0) return;
    const owner = `${info.uid}:${info.gid}`;
    const script = `for d in /workspace /shared; do [ -d "$d" ] && [ -w "$d" ] && chown -R -h --from=0 ${owner} "$d"; done; exit 0`;
    const result = await this.execIn(containerId, ['sh', '-c', script]);
    if (result.stderr.length) this.log(`returning files to ${owner} in ${containerId.slice(0, 12)}: ${result.stderr.toString('utf8').slice(0, 300)}`);
  }
  /** The conversation's sandbox, running with exactly these mounts; recreated when they (or the image) changed. */
  ensure(raw: unknown): Promise<{ id: string; created: boolean }> {
    const data = object(raw, ['owner', 'project_id', 'task_id', 'mounts', 'limits', 'libraries']);
    if (data.libraries !== undefined && (!Array.isArray(data.libraries) || data.libraries.some(name => !LIBRARIES.includes(name)) || new Set(data.libraries).size !== data.libraries.length)) fail(400, 'INVALID_REQUEST', 'libraries 无效');
    const request: EnsureRequest = { owner: id(data.owner, 'owner', OWNER), project_id: id(data.project_id, 'project_id'), ...(data.task_id === undefined ? {} : { task_id: id(data.task_id, 'task_id') }), mounts: data.mounts as Mount[],
      ...(data.limits === undefined ? {} : { limits: validateLimits(data.limits, this.options) }), ...(data.libraries ? { libraries: [...data.libraries as Library[]].sort() } : {}) };
    const limits = this.limits(request);
    return this.serial(async () => {
      const mounts = await validateMounts(this.options.projectsRoot, request), { hash, body } = await this.spec(request, mounts, limits);
      this.idle.set(request.owner, limits.idle_minutes);
      let existing = await this.find(request.owner);
      if (existing && (existing.Labels[`${LABEL}.spec`] !== hash || existing.Labels[`${LABEL}.project`] !== request.project_id)) {
        if (this.active.get(request.owner)) fail(409, 'BUSY', '沙箱正在执行命令，权限变化后需要等它结束再重建');
        await this.call('DELETE', `/containers/${existing.Id}?force=1`); existing = undefined;
        this.log(`recreate ${request.owner}: mounts, limits or image changed`);
      }
      if (existing?.State === 'running') { this.lastUsed.set(request.owner, Date.now()); return { id: existing.Id, created: false }; }
      const running = (await this.list({ status: ['running'] })).length;
      if (running >= limits.max_running) fail(429, 'CAPACITY', `现在已有 ${running} 个沙箱在运行（上限 ${limits.max_running}），请稍后再试或改用其他方式`);
      const container = existing ?? await this.call('POST', `/containers/create?name=${this.name(request.owner)}`, body);
      await this.call('POST', `/containers/${container.Id}/start`);
      this.lastUsed.set(request.owner, Date.now());
      this.log(`${existing ? 'start' : 'create'} ${request.owner} project=${request.project_id} task=${request.task_id ?? '-'}`);
      return { id: container.Id, created: !existing };
    });
  }
  private async execIn(containerId: string, cmd: string[], signal?: AbortSignal): Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number }> {
    const exec = await this.call('POST', `/containers/${containerId}/exec`, { Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: false });
    const reply = await docker(this.options.dockerSocket, 'POST', `/exec/${exec.Id}/start`, { Detach: false, Tty: false }, signal);
    if (reply.status !== 200) fail(502, 'DOCKER_ERROR', `Docker：${dockerMessage(reply)}`);
    const inspected = await this.call('GET', `/exec/${exec.Id}/json`);
    return { ...demux(reply.body), exitCode: inspected.ExitCode ?? -1 };
  }
  async exec(owner: string, raw: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
    id(owner, 'owner', OWNER);
    const request = validateExec(raw, this.options), container = await this.find(owner);
    if (!container || container.State !== 'running') fail(409, 'NOT_RUNNING', '沙箱没有运行，请先创建');
    this.active.set(owner, (this.active.get(owner) ?? 0) + 1); this.lastUsed.set(owner, Date.now());
    const onAbort = () => { void this.execIn(container!.Id, ['python3', '/opt/harnessstudio/run.py', 'cancel', request.exec_id]).catch(() => undefined); };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const spec = { exec_id: request.exec_id, command: request.command, cwd: request.cwd, timeout_s: request.timeout_s, max_bytes: this.options.outputBytes, ...(request.env ? { env: request.env } : {}) };
      const result = await this.execIn(container!.Id, ['python3', '/opt/harnessstudio/run.py', 'run', JSON.stringify(spec)]);
      let value: Record<string, unknown>;
      try { value = JSON.parse(result.stdout.toString('utf8')); } catch { fail(502, 'RUNNER_FAILED', `沙箱执行器没有返回结果：${result.stderr.toString('utf8').slice(0, 1000) || `退出码 ${result.exitCode}`}`); }
      if (typeof value!.error === 'string') fail(400, 'EXEC_REFUSED', value!.error as string);
      return value!;
    } finally {
      signal.removeEventListener('abort', onAbort);
      await this.returnFiles(container!.Id).catch(error => this.log(`could not return files of ${owner}: ${error instanceof Error ? error.message : String(error)}`));
      this.active.set(owner, (this.active.get(owner) ?? 1) - 1); this.lastUsed.set(owner, Date.now());
    }
  }
  async remove(filters: { owner?: string; project_id?: string; task_ids?: string[]; all?: boolean }): Promise<{ removed: number }> {
    if (!filters.all && filters.owner === undefined && filters.project_id === undefined && filters.task_ids === undefined) fail(400, 'INVALID_REQUEST', '至少指定 owner、project_id、task_ids 或 all');
    return this.serial(async () => {
      let rows = await this.list();
      if (filters.owner) rows = rows.filter(row => row.Labels[`${LABEL}.owner`] === filters.owner);
      if (filters.project_id) rows = rows.filter(row => row.Labels[`${LABEL}.project`] === filters.project_id);
      if (filters.task_ids) rows = rows.filter(row => filters.task_ids!.includes(row.Labels[`${LABEL}.task`] ?? ''));
      for (const row of rows) { await this.call('DELETE', `/containers/${row.Id}?force=1`); this.lastUsed.delete(row.Labels[`${LABEL}.owner`]!); this.idle.delete(row.Labels[`${LABEL}.owner`]!); }
      if (rows.length) this.log(`removed ${rows.length} sandbox(es) ${JSON.stringify(filters)}`);
      return { removed: rows.length };
    });
  }
  async stop(owner: string): Promise<{ stopped: boolean }> {
    id(owner, 'owner', OWNER);
    return this.serial(async () => { const row = await this.find(owner); if (row?.State !== 'running') return { stopped: false }; await this.call('POST', `/containers/${row.Id}/stop?t=5`); return { stopped: true }; });
  }
  /** What the settings page shows: the ceilings, whether the runtime and image exist, and how many sandboxes run. */
  async resources() {
    const [rows, info, image] = await Promise.all([this.list(), this.call('GET', '/info'), this.call('GET', `/images/${encodeURIComponent(this.options.image)}/json`).then(() => true, () => false)]);
    return { runtime: this.options.runtime, runtime_installed: Object.hasOwn(info.Runtimes ?? {}, this.options.runtime), image: this.options.image, image_present: image,
      running: rows.filter(row => row.State === 'running').length, total: rows.length,
      ceilings: { cpus: this.options.maxCpus, memory_gb: this.options.maxMemoryGb, max_running: this.options.maxRunning },
      host: { cpus: info.NCPU ?? null, memory_gb: typeof info.MemTotal === 'number' ? Math.floor(info.MemTotal / 1024 ** 3) : null },
      pids: this.options.pids, tmp_mb: this.options.tmpMb, idle_minutes: this.options.idleMinutes, libraries: !!this.options.studioVolume };
  }
  async sandboxes(projectId?: string) {
    const rows = await this.list(projectId ? { label: [`${LABEL}.project=${id(projectId, 'project_id')}`] } : {});
    return rows.map(row => ({ id: row.Id.slice(0, 12), owner: row.Labels[`${LABEL}.owner`], project_id: row.Labels[`${LABEL}.project`], task_id: row.Labels[`${LABEL}.task`] || null, state: row.State,
      last_used: this.lastUsed.has(row.Labels[`${LABEL}.owner`]!) ? new Date(this.lastUsed.get(row.Labels[`${LABEL}.owner`]!)!).toISOString() : null }));
  }
  /** Stops sandboxes idle for idleMinutes and removes stopped ones unused for removeHours. Files on D:/F: stay. */
  async reap(now = Date.now()): Promise<void> {
    const rows = await this.list();
    for (const row of rows) {
      const owner = row.Labels[`${LABEL}.owner`]!;
      if (!this.lastUsed.has(owner)) this.lastUsed.set(owner, now);
      const idle = now - this.lastUsed.get(owner)!;
      if (row.State === 'running' && !this.active.get(owner) && idle > (this.idle.get(owner) ?? this.options.idleMinutes) * 60000) { await this.stop(owner).catch(() => undefined); this.log(`stopped idle ${owner}`); }
      else if (row.State !== 'running' && idle > this.options.removeHours * 3600000) await this.remove({ owner }).catch(() => undefined);
    }
  }
}

async function body(request: IncomingMessage, limit = 256 * 1024): Promise<unknown> {
  const parts: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) { bytes += (chunk as Buffer).length; if (bytes > limit) fail(413, 'TOO_LARGE', '请求过大'); parts.push(chunk as Buffer); }
  if (!bytes) return {};
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { fail(400, 'INVALID_REQUEST', '请求不是 JSON'); }
}
function send(response: ServerResponse, status: number, value: unknown) {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(value));
}

/** HTTP API. Every route needs `Authorization: Bearer <token>`; the service is reachable only on Studio's network. */
export function createSandboxServer(manager: SandboxManager, token: string): Server {
  const expected = Buffer.from(`Bearer ${token}`);
  return createServer(async (request, response) => {
    const abort = new AbortController();
    response.on('close', () => { if (!response.writableFinished) abort.abort(); });
    try {
      const given = Buffer.from(request.headers.authorization ?? '');
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) fail(401, 'UNAUTHORIZED', '未授权');
      const url = new URL(request.url ?? '/', 'http://sandbox'), path = url.pathname, method = request.method ?? 'GET';
      const owner = /^\/v1\/sandboxes\/([^/]+)(\/exec|\/stop)?$/.exec(path);
      if (method === 'GET' && path === '/v1/health') return send(response, 200, { ok: true });
      if (method === 'GET' && path === '/v1/resources') return send(response, 200, await manager.resources());
      if (method === 'GET' && path === '/v1/sandboxes') return send(response, 200, { items: await manager.sandboxes(url.searchParams.get('project_id') ?? undefined) });
      if (method === 'POST' && path === '/v1/sandboxes/ensure') return send(response, 200, await manager.ensure(await body(request)));
      if (method === 'POST' && path === '/v1/sandboxes/remove') {
        const data = object(await body(request), ['owner', 'project_id', 'task_ids', 'all']);
        if (data.all !== undefined && data.all !== true) fail(400, 'INVALID_REQUEST', 'all 只能是 true');
        if (data.task_ids !== undefined && (!Array.isArray(data.task_ids) || data.task_ids.length > 10000)) fail(400, 'INVALID_REQUEST', 'task_ids 无效');
        return send(response, 200, await manager.remove({ ...(data.owner === undefined ? {} : { owner: id(data.owner, 'owner', OWNER) }), ...(data.project_id === undefined ? {} : { project_id: id(data.project_id, 'project_id') }),
          ...(data.task_ids === undefined ? {} : { task_ids: (data.task_ids as unknown[]).map(value => id(value, 'task_id')) }), ...(data.all ? { all: true } : {}) }));
      }
      if (method === 'POST' && owner?.[2] === '/exec') return send(response, 200, await manager.exec(decodeURIComponent(owner[1]!), await body(request, 64 * 1024), abort.signal));
      if (method === 'POST' && owner?.[2] === '/stop') return send(response, 200, await manager.stop(decodeURIComponent(owner[1]!)));
      fail(404, 'NOT_FOUND', '没有这个接口');
    } catch (error) {
      if (error instanceof ApiError) return send(response, error.status, { code: error.code, message: error.message });
      send(response, 500, { code: 'INTERNAL', message: error instanceof Error ? error.message.slice(0, 500) : '内部错误' });
    }
  });
}
