/** Background commands in a VM (studio_vm_run with background: true), built only on the agent service's existing
 * /execute_windows and /file. A start script launches a detached supervisor process that runs the command, keeps its
 * output and state in D:\.studio-jobs\<jobId>\ and ends the whole process tree on cancel or timeout; Studio keeps its
 * own record of every job (vm-jobs.json) and never reruns one. */
import { open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type { VmJobState, VmJobView } from './seat-types.ts';

/** Where a job's files live: the task's D: drive, so the user and the Agent can read them as task files. */
export const JOB_ROOT = 'D:\\.studio-jobs', JOB_FOLDER = '.studio-jobs';
export const DEFAULT_JOB_MINUTES = 60, MAX_JOB_MINUTES = 24 * 60, MAX_RUNNING_JOBS = 3, JOB_RECORDS_PER_TASK = 100;
/** Job folders that ended this long ago are removed when the next job starts. */
export const JOB_KEEP_DAYS = 7;
const STDOUT_CHARS = 12000, STDERR_CHARS = 4000;
/** The supervisor rewrites job.json this often; on a running VM, a job.json older than STALE_MS means it is gone. */
const HEARTBEAT_SECONDS = 30, STALE_MS = 4 * HEARTBEAT_SECONDS * 1000;
/** A job whose supervisor has not shown up this long after the start request did not start. */
const START_GRACE_MS = 60000;
const states: VmJobState[] = ['starting', 'running', 'exited', 'canceled', 'timedOut', 'interrupted', 'unknown', 'failed'];
const active = new Set<VmJobState>(['starting', 'running']);
export const isActive = (record: Pick<VmJobRecord, 'state'>) => active.has(record.state);

/** Studio's record of one job. reason says why it ended other than by itself: reboot (Windows restarted), supervisor
 * (the supervisor process vanished), vm-stopped / vm-failed / vm-deleted (Windows was shut down), start (it never
 * started), missing (its folder on D: is gone). */
export interface VmJobRecord {
  id: string; taskId: string; projectId: string; vmId: string; environmentId: string; chatId: string;
  command: string; maxMinutes: number; createdAt: string;
  state: VmJobState; returncode: number | null; startedAt: string | null; endedAt: string | null;
  reason: string | null; error: string | null; canceledBy: 'agent' | 'human' | null; outputRemoved: boolean; checkedAt: string;
}
/** The end of a job's output as last read. */
export interface JobOutput { stdout: string; stderr: string; stdoutBytes: number; stderrBytes: number }
/** A state that is true now but not stored, e.g. unknown while the VM does not answer. */
export interface JobTransient { state: VmJobState; note: string }

export const newJobId = () => `job-${randomBytes(6).toString('hex')}`;
export function jobId(value: unknown): string {
  if (typeof value !== 'string' || !/^job-[0-9a-f]{12}$/.test(value)) throw new Error('jobId 无效：应为后台运行返回的任务号，例如 job-0123456789ab');
  return value;
}
export function jobMinutes(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_JOB_MINUTES;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_JOB_MINUTES) throw new Error(`maxMinutes 需为 1～${MAX_JOB_MINUTES} 的整数（默认 ${DEFAULT_JOB_MINUTES}）`);
  return value;
}

const literal = (value: unknown) => `json.loads(${JSON.stringify(JSON.stringify(value))})`;
/** job.json is replaced whole, so readers never see half of it; a reader holding it open on Windows makes the
 * replace fail for a moment, hence the retries. The .tmp name is one the VM recorder's snapshots ignore. */
const FILE_HELPERS = [
  "FINAL = ('exited', 'canceled', 'timedOut', 'failed', 'interrupted', 'unknown')",
  'def load(path):',
  '    try:',
  "        with open(os.path.join(path, 'job.json'), encoding='utf-8') as handle: return json.load(handle)",
  '    except (OSError, ValueError): return None',
  'def save(path, job):',
  "    name = os.path.join(path, 'job.json'); temporary = name + '.tmp'",
  "    with open(temporary, 'w', encoding='utf-8') as handle: json.dump(job, handle, ensure_ascii=False)",
  '    for attempt in range(20):',
  '        try:',
  '            os.replace(temporary, name); return',
  '        except PermissionError: time.sleep(0.25)',
  '    os.replace(temporary, name)',
];
/** The supervisor process, running as `python -c` with the job folder as its argument. The command starts suspended,
 * joins a job object that ends every process in it when the supervisor's handle closes (also when the supervisor
 * itself is killed), and then resumes; cancel (the `cancel` file) and timeout terminate that job object. Programs a
 * finished command leaves running stay, as with studio_vm_run. Without a job object it falls back to taskkill /T. */
export const SUPERVISOR = [
  'import ctypes, json, os, subprocess, sys, time',
  'import psutil',
  ...FILE_HELPERS,
  'path = sys.argv[1]',
  'job = load(path)',
  'me = psutil.Process()',
  "job.update(state='running', pid=me.pid, pidCreated=me.create_time(), bootEpoch=psutil.boot_time(), startedEpoch=time.time(), heartbeatEpoch=time.time())",
  'handle = None; limits = None',
  'try:',
  '    import win32job',
  "    handle = win32job.CreateJobObject(None, '')",
  '    limits = win32job.QueryInformationJobObject(handle, win32job.JobObjectExtendedLimitInformation)',
  "    limits['BasicLimitInformation']['LimitFlags'] |= win32job.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE",
  '    win32job.SetInformationJobObject(handle, win32job.JobObjectExtendedLimitInformation, limits)',
  'except Exception as problem:',
  "    handle = None; job['jobObjectProblem'] = str(problem)[:300]",
  "out = open(os.path.join(path, 'stdout.txt'), 'wb'); err = open(os.path.join(path, 'stderr.txt'), 'wb')",
  'try:',
  "    child = subprocess.Popen('chcp 65001>nul & ' + job['command'], shell=True, stdin=subprocess.DEVNULL, stdout=out, stderr=err, creationflags=subprocess.CREATE_NEW_PROCESS_GROUP | (0x4 if handle else 0))",
  'except Exception as problem:',
  "    job.update(state='failed', reason='start', error=str(problem)[:1000], endedEpoch=time.time()); save(path, job); sys.exit(0)",
  'contained = False',
  'if handle:',
  '    try:',
  '        win32job.AssignProcessToJobObject(handle, int(child._handle)); contained = True',
  "    except Exception as problem: job['jobObjectProblem'] = str(problem)[:300]",
  '    ctypes.windll.ntdll.NtResumeProcess(ctypes.c_void_p(int(child._handle)))',
  "job['jobObject'] = contained; job['childPid'] = child.pid",
  'try:',
  "    job['childCreated'] = psutil.Process(child.pid).create_time()",
  'except Exception: pass',
  'save(path, job)',
  "cancel = os.path.join(path, 'cancel')",
  "deadline = time.monotonic() + job['maxSeconds']; beat = time.monotonic(); ending = None; code = None",
  'while True:',
  '    try:',
  '        code = child.wait(timeout=1); break',
  '    except subprocess.TimeoutExpired: pass',
  "    if os.path.exists(cancel): ending = 'canceled'; break",
  "    if time.monotonic() >= deadline: ending = 'timedOut'; break",
  `    if time.monotonic() - beat >= ${HEARTBEAT_SECONDS}:`,
  "        beat = time.monotonic(); job['heartbeatEpoch'] = time.time()",
  '        try: save(path, job)',
  '        except Exception: pass',
  'if ending:',
  '    if contained: win32job.TerminateJobObject(handle, 1)',
  "    else: subprocess.run(['taskkill', '/F', '/T', '/PID', str(child.pid)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)",
  '    try: code = child.wait(timeout=15)',
  '    except subprocess.TimeoutExpired: code = None',
  'elif contained:',
  '    try:',
  "        limits['BasicLimitInformation']['LimitFlags'] &= ~win32job.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE",
  '        win32job.SetInformationJobObject(handle, win32job.JobObjectExtendedLimitInformation, limits)',
  '    except Exception: pass',
  'out.close(); err.close()',
  "job.update(state=ending or 'exited', returncode=code, endedEpoch=time.time())",
  'try: os.remove(cancel)',
  'except OSError: pass',
  'save(path, job)',
].join('\n');

/** Python for /execute_windows: removes job folders that ended JOB_KEEP_DAYS ago, writes job.json and starts the
 * supervisor detached and without a window, then waits up to 10 s for it to take over. Nothing after the supervisor
 * started may raise, so an HTTP error from the service always means the job did not start. The service treats
 * printed text containing "error" as a failure, so none of these scripts print. */
export function startJobScript(input: { id: string; command: string; maxSeconds: number }, resultPath: string): string {
  const request = { ...input, root: JOB_ROOT, keepSeconds: JOB_KEEP_DAYS * 86400, supervisor: Buffer.from(SUPERVISOR, 'utf8').toString('base64'), result: resultPath };
  return [
    '# studio-job:start',
    'import json, os, re, shutil, subprocess, sys, time',
    `request = ${literal(request)}`,
    ...FILE_HELPERS,
    "root = request['root']; now = time.time(); removed = []",
    'os.makedirs(root, exist_ok=True)',
    'for name in os.listdir(root):',
    '    folder = os.path.join(root, name)',
    "    if not re.match(r'^job-[0-9a-f]{12}$', name) or not os.path.isdir(folder): continue",
    '    try:',
    "        job = load(folder) or {}; created = float(job.get('createdEpoch') or os.path.getmtime(folder))",
    "        done = float(job.get('endedEpoch') or job.get('detectedEpoch') or created) if job.get('state') in FINAL else created + float(job.get('maxSeconds') or 86400) + 60",
    "        if done < now - request['keepSeconds']: shutil.rmtree(folder); removed.append(name)",
    '    except Exception: pass',
    "path = os.path.join(root, request['id'])",
    'os.mkdir(path)',
    "job = {'id': request['id'], 'command': request['command'], 'maxSeconds': request['maxSeconds'], 'createdEpoch': now, 'state': 'starting'}",
    'save(path, job)',
    "code = 'import base64; exec(base64.b64decode(\"' + request['supervisor'] + '\").decode(\"utf-8\"))'",
    'subprocess.Popen([sys.executable, \'-c\', code, path], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW)',
    'try:',
    '    for attempt in range(40):',
    '        time.sleep(0.25); job = load(path) or job',
    "        if job.get('state') != 'starting': break",
    "    with open(os.path.expandvars(request['result']), 'w', encoding='utf-8') as handle: json.dump({'job': job, 'removed': removed}, handle, ensure_ascii=False)",
    'except Exception: pass',
  ].join('\n');
}

/** Python for /execute_windows: each job's job.json, whether its supervisor still runs (same PID and process start
 * time), and the end of its output. A job whose supervisor is gone is settled in job.json: interrupted when Windows
 * restarted since, or when the job object ended the command with the supervisor; unknown otherwise. */
export function jobStatusScript(ids: string[], resultPath: string): string {
  return [
    '# studio-job:status',
    'import json, locale, os, time',
    'import psutil',
    `request = ${literal({ root: JOB_ROOT, ids, stdoutChars: STDOUT_CHARS, stderrChars: STDERR_CHARS, result: resultPath })}`,
    ...FILE_HELPERS,
    'def alive(job):',
    '    try: return abs(psutil.Process(job[\'pid\']).create_time() - float(job[\'pidCreated\'])) < 1',
    '    except Exception: return False',
    'def tail(name, chars):',
    '    try:',
    "        with open(name, 'rb') as handle:",
    '            handle.seek(0, 2); size = handle.tell(); start = max(0, size - chars * 4); handle.seek(start); data = handle.read()',
    "    except OSError: return '', 0",
    '    skip = 0',
    '    while start and skip < 3 and skip < len(data) and 0x80 <= data[skip] < 0xC0: skip += 1',
    '    data = data[skip:]',
    "    try: value = data.decode('utf-8')",
    "    except UnicodeDecodeError: value = data.decode(locale.getpreferredencoding(False), 'replace')",
    '    return value[-chars:], size',
    'boot = psutil.boot_time(); now = time.time(); jobs = {}',
    "for name in request['ids']:",
    "    path = os.path.join(request['root'], name); job = load(path)",
    "    if job and job.get('state') in ('starting', 'running') and not (alive(job) if job.get('pid') else now - float(job.get('createdEpoch') or 0) < 60):",
    '        latest = load(path)',
    "        if latest and latest.get('state') not in ('starting', 'running'): job = latest",
    '        else:',
    "            rebooted = bool(job.get('pid')) and abs(boot - float(job.get('bootEpoch') or boot)) > 60",
    "            job['state'] = 'failed' if not job.get('pid') else 'interrupted' if rebooted or job.get('jobObject') else 'unknown'",
    "            job['reason'] = 'start' if not job.get('pid') else 'reboot' if rebooted else 'supervisor'",
    "            job['detectedEpoch'] = now",
    '            try: save(path, job)',
    '            except Exception: pass',
    "    stdout, stdout_bytes = tail(os.path.join(path, 'stdout.txt'), request['stdoutChars'])",
    "    stderr, stderr_bytes = tail(os.path.join(path, 'stderr.txt'), request['stderrChars'])",
    "    jobs[name] = {'job': job, 'stdout': stdout, 'stdoutBytes': stdout_bytes, 'stderr': stderr, 'stderrBytes': stderr_bytes}",
    "with open(os.path.expandvars(request['result']), 'w', encoding='utf-8') as handle: json.dump({'bootEpoch': boot, 'jobs': jobs}, handle, ensure_ascii=False)",
  ].join('\n');
}

/** Python for /execute_windows: asks the supervisor to end the job (the `cancel` file) and waits up to 15 s for it.
 * If the supervisor is gone, ends the command's process tree itself, after checking the process start time so a
 * reused PID is never killed. */
export function cancelJobScript(id: string, resultPath: string): string {
  return [
    '# studio-job:cancel',
    'import json, os, subprocess, time',
    'import psutil',
    `request = ${literal({ root: JOB_ROOT, id, waitSeconds: 15, result: resultPath })}`,
    ...FILE_HELPERS,
    'def alive(pid, created):',
    '    try: return abs(psutil.Process(pid).create_time() - float(created)) < 1',
    '    except Exception: return False',
    "path = os.path.join(request['root'], request['id']); job = load(path)",
    "if job and job.get('state') in ('starting', 'running'):",
    "    with open(os.path.join(path, 'cancel'), 'w') as handle: handle.write('cancel')",
    "    deadline = time.time() + request['waitSeconds']",
    '    while time.time() < deadline:',
    '        time.sleep(0.5); job = load(path) or job',
    "        if job.get('state') not in ('starting', 'running'): break",
    "    if job.get('state') in ('starting', 'running') and not (job.get('pid') and alive(job['pid'], job.get('pidCreated'))):",
    "        child = job.get('childPid')",
    "        if child and not job.get('jobObject') and alive(child, job.get('childCreated')):",
    "            subprocess.run(['taskkill', '/F', '/T', '/PID', str(child)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)",
    "        job.update(state='canceled', reason='supervisor', endedEpoch=time.time())",
    '        try: save(path, job)',
    '        except Exception: pass',
    "with open(os.path.expandvars(request['result']), 'w', encoding='utf-8') as handle: json.dump({'job': job}, handle, ensure_ascii=False)",
  ].join('\n');
}

/** What the VM wrote to job.json; untrusted, so every field is checked. */
interface JobFile { state: VmJobState; returncode: number | null; startedAt: string | null; endedAt: string | null; reason: string | null; error: string | null }
const iso = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? new Date(value * 1000).toISOString() : null;
const shortText = (value: unknown, limit: number) => typeof value === 'string' && value ? value.slice(0, limit) : null;
function jobFile(raw: unknown): JobFile | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>; if (!states.includes(row.state as VmJobState)) return null;
  return { state: row.state as VmJobState, returncode: typeof row.returncode === 'number' && Number.isSafeInteger(row.returncode) ? row.returncode : null, startedAt: iso(row.startedEpoch),
    endedAt: iso(row.endedEpoch) ?? iso(row.detectedEpoch), reason: shortText(row.reason, 40), error: shortText(row.error, 500) };
}
/** A finished record stays as it is; only unknown may still turn out otherwise. */
function settled(record: VmJobRecord) { return !isActive(record) && record.state !== 'unknown'; }
function applyFile(record: VmJobRecord, file: JobFile, now: number) {
  record.checkedAt = new Date(now).toISOString();
  if (settled(record)) return;
  if (record.state === 'unknown' && active.has(file.state)) return;
  record.state = file.state; record.returncode = file.returncode; record.startedAt = file.startedAt ?? record.startedAt;
  record.endedAt = active.has(file.state) ? null : file.endedAt ?? new Date(now).toISOString();
  if (file.reason) record.reason = file.reason;
  if (file.error) record.error = file.error;
}
function end(record: VmJobRecord, state: VmJobState, reason: string, now: number) {
  Object.assign(record, { state, reason, endedAt: new Date(now).toISOString(), checkedAt: new Date(now).toISOString() });
}
function output(raw: Record<string, unknown> | null): JobOutput | undefined {
  if (!raw) return;
  const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  return { stdout: typeof raw.stdout === 'string' ? raw.stdout.slice(-STDOUT_CHARS) : '', stderr: typeof raw.stderr === 'string' ? raw.stderr.slice(-STDERR_CHARS) : '', stdoutBytes: count(raw.stdoutBytes), stderrBytes: count(raw.stderrBytes) };
}
const entryOf = (raw: unknown) => raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;

/** Applies one job's entry from the status or cancel script (null: the VM did not report it). */
export function applyCheck(record: VmJobRecord, raw: unknown, now = Date.now()): JobOutput | undefined {
  const entry = entryOf(raw), file = jobFile(entry?.job);
  if (file) { applyFile(record, file, now); return output(entry); }
  record.checkedAt = new Date(now).toISOString();
  if (!isActive(record)) { if (entry) record.outputRemoved = true; return; }
  if (now - Date.parse(record.createdAt) < START_GRACE_MS) return;
  if (record.state === 'starting') end(record, 'failed', 'start', now); else end(record, 'unknown', 'missing', now);
}
/** The start script's answer: the job as the supervisor left it, and folders it removed. */
export function applyStart(record: VmJobRecord, raw: Record<string, unknown>, now = Date.now()): string[] {
  const file = jobFile(raw.job); if (file) applyFile(record, file, now);
  return Array.isArray(raw.removed) ? raw.removed.filter((id): id is string => typeof id === 'string' && /^job-[0-9a-f]{12}$/.test(id)) : [];
}

/** A job's files as the host sees them on D: (<projects>/<projectId>/tasks/<taskId>/.studio-jobs/<jobId>). */
export interface HostJob { job: JobFile | null; modifiedMs: number | null; output: JobOutput }
async function hostTail(path: string, chars: number): Promise<{ text: string; bytes: number }> {
  let handle; try { handle = await open(path, 'r'); } catch { return { text: '', bytes: 0 }; }
  try {
    const { size } = await handle.stat(), start = Math.max(0, size - chars * 4), buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    let skip = 0; while (start && skip < 3 && skip < buffer.length && (buffer[skip]! & 0xc0) === 0x80) skip++;
    const data = buffer.subarray(skip);
    let text: string; try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { try { text = new TextDecoder('gb18030').decode(data); } catch { text = data.toString('utf8'); } }
    return { text: text.slice(-chars), bytes: size };
  } finally { await handle.close(); }
}
export async function readHostJob(folder: string): Promise<HostJob> {
  let job: JobFile | null = null, modifiedMs: number | null = null;
  try { const path = join(folder, 'job.json'); job = jobFile(JSON.parse(await readFile(path, 'utf8'))); modifiedMs = (await stat(path)).mtimeMs; } catch { /* missing or being replaced */ }
  const [out, err] = await Promise.all([hostTail(join(folder, 'stdout.txt'), STDOUT_CHARS), hostTail(join(folder, 'stderr.txt'), STDERR_CHARS)]);
  return { job, modifiedMs, output: { stdout: out.text, stderr: err.text, stdoutBytes: out.bytes, stderrBytes: err.bytes } };
}
/** The VM as vm_manager reports it: null when it no longer exists, undefined when vm_manager did not answer. */
export type JobVm = { status: string; unreachable: boolean } | null | undefined;
/** Settles a job without its VM's agent service: what job.json on D: says, and whether Windows still runs. host is
 * undefined when Studio cannot read the projects directory. A job that was running when Windows was shut down was
 * interrupted, unless job.json shows it had ended. */
export function resolveOffline(record: VmJobRecord, host: HostJob | undefined, vm: JobVm, now = Date.now()): { output?: JobOutput; transient?: JobTransient } {
  if (host?.job && !active.has(host.job.state)) applyFile(record, host.job, now);
  if (!isActive(record)) { if (host && !host.job) record.outputRemoved = true; return { ...(host?.job ? { output: host.output } : {}) }; }
  const down = vm === null ? 'vm-deleted' : vm && vm.status !== 'running' ? vm.status === 'failed' ? 'vm-failed' : 'vm-stopped' : undefined;
  if (down) {
    if (!host) return { transient: { state: 'unknown', note: '虚拟机没有在运行，Studio 读不到 D 盘上的任务记录；重新启动虚拟机后再查询，可以确认它在停机前是否已经结束' } };
    if (host.job) end(record, 'interrupted', down, now);
    else if (now - Date.parse(record.createdAt) >= START_GRACE_MS || record.state === 'starting') end(record, record.state === 'starting' ? 'failed' : 'unknown', record.state === 'starting' ? 'start' : 'missing', now);
    return { output: host.output };
  }
  if (vm?.unreachable) return { ...(host ? { output: host.output } : {}), transient: { state: 'unknown', note: '虚拟机内的服务暂时无响应（Windows 可能正在重启），状态待确认；稍后再查询' } };
  if (vm === undefined) return { ...(host ? { output: host.output } : {}), transient: { state: 'unknown', note: '暂时连不上虚拟机平台，状态待确认；稍后再查询' } };
  if (host?.job && host.modifiedMs !== null && now - host.modifiedMs > STALE_MS) return { output: host.output, transient: { state: 'unknown', note: `看护进程超过 ${Math.round(STALE_MS / 60000)} 分钟没有更新状态，可能已因 Windows 重启而中断；查询一次即可确认` } };
  return { ...(host ? { output: host.output } : {}) };
}

const stateTexts: Record<VmJobState, string> = { starting: '正在启动', running: '运行中', exited: '已结束', canceled: '已取消', timedOut: '超时结束', interrupted: '中断', unknown: '结果未知', failed: '未能启动' };
const reasonTexts: Record<string, string> = {
  reboot: 'Windows 重启了（包括授权续期时的重启），任务被中断', 'vm-stopped': '虚拟机已停止，Windows 关机时任务被中断', 'vm-failed': '虚拟机失败，任务被中断',
  'vm-deleted': '虚拟机已删除，任务被中断', start: '看护进程没有启动起来，命令没有运行', missing: 'D 盘上找不到这个任务的记录（输出目录可能已被删除），结果未知',
};
function note(record: VmJobRecord): string | null {
  if (record.state === 'timedOut') return `运行超过 ${record.maxMinutes} 分钟，已结束整个进程树`;
  if (record.state === 'canceled') return record.canceledBy === 'human' ? '用户在软件区停止了这个后台任务' : '已取消，整个进程树已结束';
  if (record.reason === 'supervisor') return record.state === 'unknown' ? '看护进程意外退出（例如在任务管理器里被结束），命令可能仍在运行，结果未知' : '看护进程意外退出（例如在任务管理器里被结束），任务被中断';
  const text = record.reason ? reasonTexts[record.reason] ?? null : null;
  return record.error ? `${text ?? '出错'}：${record.error}` : text;
}
export function jobView(record: VmJobRecord, value?: JobOutput, transient?: JobTransient): VmJobView {
  const state = transient?.state ?? record.state, removed = record.outputRemoved ? `输出目录已按 ${JOB_KEEP_DAYS} 天保留期清理` : null;
  return {
    jobId: record.id, vmId: record.vmId, chatId: record.chatId, command: record.command, state, stateText: stateTexts[state], returncode: record.returncode,
    createdAt: record.createdAt, startedAt: record.startedAt, endedAt: record.endedAt, maxMinutes: record.maxMinutes, canceledBy: record.canceledBy,
    note: [transient?.note ?? note(record), removed].filter(Boolean).join('；') || null,
    outputFolder: `${JOB_ROOT}\\${record.id}`, taskPath: `${JOB_FOLDER}/${record.id}`, outputRemoved: record.outputRemoved, ...value,
  };
}

const text = (value: unknown, limit: number) => typeof value === 'string' && value.length <= limit ? value : undefined;
function record(raw: unknown): VmJobRecord | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const row = raw as Record<string, unknown>, nullable = (value: unknown, limit: number) => value === null ? null : text(value, limit);
  const fields = { id: text(row.id, 20), taskId: text(row.taskId, 200), projectId: text(row.projectId, 200), vmId: text(row.vmId, 64), environmentId: text(row.environmentId, 100), chatId: text(row.chatId, 200), command: text(row.command, 8000), createdAt: text(row.createdAt, 40), checkedAt: text(row.checkedAt, 40) };
  if (Object.values(fields).some(value => !value) || !/^job-[0-9a-f]{12}$/.test(fields.id!) || !states.includes(row.state as VmJobState) || typeof row.maxMinutes !== 'number' || !Number.isSafeInteger(row.maxMinutes)) return;
  const startedAt = nullable(row.startedAt, 40), endedAt = nullable(row.endedAt, 40), reason = nullable(row.reason, 40), error = nullable(row.error, 500);
  if (startedAt === undefined || endedAt === undefined || reason === undefined || error === undefined) return;
  return { ...fields as Pick<VmJobRecord, keyof typeof fields>, maxMinutes: row.maxMinutes, state: row.state as VmJobState, returncode: typeof row.returncode === 'number' && Number.isSafeInteger(row.returncode) ? row.returncode : null,
    startedAt, endedAt, reason, error, canceledBy: row.canceledBy === 'agent' || row.canceledBy === 'human' ? row.canceledBy : null, outputRemoved: row.outputRemoved === true };
}

/** Studio's job records (vm-jobs.json beside vm-seats.json), written whole and in order. */
export class VmJobStore {
  private readonly records = new Map<string, VmJobRecord>();
  private persistence: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string) {}
  async load() {
    let values: unknown;
    try { values = JSON.parse(await readFile(join(this.directory, 'vm-jobs.json'), 'utf8')); }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return; throw error; }
    if (!Array.isArray(values)) throw new Error('Invalid VM job records');
    for (const raw of values) { const value = record(raw); if (!value || this.records.has(value.id)) throw new Error('Invalid VM job record'); this.records.set(value.id, value); }
  }
  get(id: string) { return this.records.get(id); }
  forTask(taskId: string) { return [...this.records.values()].filter(row => row.taskId === taskId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  forVm(vmId: string) { return [...this.records.values()].filter(row => row.vmId === vmId); }
  taskIds() { return new Set([...this.records.values()].map(row => row.taskId)); }
  add(value: VmJobRecord) {
    this.records.set(value.id, value);
    // Running jobs are always kept; the oldest finished ones go first.
    const ended = this.forTask(value.taskId).filter(row => !isActive(row));
    for (const row of ended.slice(Math.max(0, JOB_RECORDS_PER_TASK - (this.forTask(value.taskId).length - ended.length)))) this.records.delete(row.id);
  }
  removeTask(taskId: string) { for (const row of this.forTask(taskId)) this.records.delete(row.id); }
  save(): Promise<void> {
    const operation = this.persistence.catch(() => undefined).then(async () => {
      const path = join(this.directory, 'vm-jobs.json'), temporary = `${path}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify([...this.records.values()]) + '\n'); await file.sync(); } finally { await file.close(); }
        await rename(temporary, path);
      } finally { await rm(temporary, { force: true }); }
    });
    this.persistence = operation; return operation;
  }
  async flush() { await this.persistence.catch(() => {}); }
}
