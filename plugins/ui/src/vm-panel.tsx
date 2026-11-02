import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import type { TaskView } from '@harnessstudio/studio/domain-types';
import type { SoftwareDescriptor, StudioVmSeatView, VmAgentStep, VmJobView, VmRecording, VmResources } from '../../studio/src/seat-types.ts';
import { api } from './api.ts';
import { randomId } from './random-id.ts';
import { CopyButton } from './region.tsx';
import { RecordingActions, RecordingSummary, RecordingViewer } from './recording-viewer.tsx';
import { VmLaunchDialog, VmResourcePanel, type VmLaunchChoice } from './vm-launch.tsx';
import { DEFAULT_RUN_MINUTES, formatMinutes, formatShort, MAX_RUN_MINUTES, RUN_OPTIONS, softwareShortName, vmStateLabel } from './vm-format.ts';
export { vmStateLabel } from './vm-format.ts';
import { useNoSoftware } from './software-backend.ts';

const formatTime = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
const message = (reason: unknown, fallback: string) => reason instanceof Error ? reason.message : fallback;
function RunLimit({ value, disabled, onChange }: { value: number; disabled: boolean; onChange(minutes: number): void }) {
  const options = RUN_OPTIONS.includes(value) ? RUN_OPTIONS : [...RUN_OPTIONS, value].sort((a, b) => a - b);
  return <label className="vm-run-limit" title="到期后虚拟机自动关机。运行中修改时，从本次开始运行时算起。">运行时长<select value={value} disabled={disabled} onChange={event => onChange(Number(event.target.value))}>{options.map(minutes => <option key={minutes} value={minutes}>{formatMinutes(minutes)}</option>)}</select></label>;
}
const vmStatuses: Record<string, string> = { queued: '排队中', creating: '正在创建', starting: '正在开机', running: '运行中', stopping: '正在关机', stopped: '已停止', deleting: '正在删除', failed: '失败' };
export const queueReasons: Record<string, string> = { waiting_turn: '前面还有排队的请求', insufficient_resources: '宿主机资源不足，等待其他虚拟机释放', docker_unavailable: 'Docker 暂时不可用' };
const stopReasons: Record<string, string> = { manual: '手动停止', cancelled: '排队中被取消', expired: '运行到期自动停止', failure: '失败后自动停止' };
const recordingStates = { recording: '采集中', stopped: '已停止', failed: '失败' };
/** Whether this project's files live in vm_manager task spaces (D:) and its shared folder (F:); never without software. */
export function useVmStorage(projectId: string): boolean {
  // The no-software mode has the same shared folder, but no VMs or drives to tell people about.
  const noSoftware = useNoSoftware();
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let valid = true; setEnabled(false);
    void api<{ enabled: boolean }>(`project/shared/status?${new URLSearchParams({ projectId })}`).then(value => { if (valid) setEnabled(value.enabled); }, () => undefined);
    return () => { valid = false; };
  }, [projectId]);
  return enabled && !noSoftware;
}
function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), intervalMs); return () => clearInterval(timer); }, [intervalMs]);
  return now;
}
const ago = (at: string, now: number) => { const seconds = Math.max(0, Math.round((now - Date.parse(at)) / 1000)); return seconds < 60 ? `${seconds} 秒前` : seconds < 3600 ? `${Math.floor(seconds / 60)} 分钟前` : formatShort(at); };
/** The noVNC page of a VM. view_only keeps a separate window from sending input while the Agent operates. */
export function vncPage(url: string, viewOnly: boolean) {
  const page = new URL(url);
  page.search = new URLSearchParams({ resize: 'scale', reconnect: 'true', autoconnect: 'true', ...(viewOnly ? { view_only: 'true' } : {}) }).toString();
  return page.toString();
}
const toolNames: Record<string, string> = { run: '执行命令', job_start: '后台运行', job_cancel: '停止后台任务', launch: '启动程序', open_file: '打开文件', window_activate: '切换窗口', window_close: '关闭窗口' };
const jobRunning = (job: VmJobView) => job.state === 'running' || job.state === 'starting';
const clipCommand = (command: string) => command.length > 80 ? `${command.slice(0, 80)}…` : command;
/** One line for the Agent's latest step; input summaries are the (possibly cut) JSON of its actions. */
export function describeStep(step: VmAgentStep): string {
  if (step.tool !== 'input') return `${toolNames[step.tool] ?? step.tool}${step.summary ? `：${step.summary.length > 60 ? `${step.summary.slice(0, 60)}…` : step.summary}` : ''}`;
  let actions: Record<string, unknown>[] = [];
  try { const parsed: unknown = JSON.parse(step.summary); if (Array.isArray(parsed)) actions = parsed.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object'); } catch { return '鼠标键盘操作'; }
  const first = actions[0]; if (!first) return '鼠标键盘操作';
  const name = first.type === 'click' ? `点击 (${first.x}, ${first.y})` : first.type === 'type' ? '输入文字' : first.type === 'key' && Array.isArray(first.keys) ? `按键 ${first.keys.join('+')}` : first.type === 'scroll' ? '滚动' : first.type === 'drag' ? '拖动' : first.type === 'move' ? '移动鼠标' : first.type === 'wait' ? '等待' : '鼠标键盘操作';
  return actions.length > 1 ? `${name} 等 ${actions.length} 步` : name;
}

/** The Windows licence of the current run, in one phrase. */
export function licenseText(seat: Pick<StudioVmSeatView, 'state' | 'license'>): string {
  const license = seat.license;
  if (!license) return seat.state === 'ready' ? '开机后自动检查' : '运行后检查';
  if (license.state === 'checking') return '正在检查…';
  if (license.state === 'rearming') return '正在续期并重启…';
  if (license.state === 'failed') return `检查失败：${license.error ?? '原因未知'}`;
  if (license.evaluation === false) return license.licensed ? '正式授权，已激活' : '正式版本，未激活';
  const left = license.licensed ? `剩 ${license.daysLeft ?? '?'} 天` : '已过期';
  return `评估版，${left}，可续期 ${license.rearms ?? '?'} 次${license.state === 'exhausted' ? '（已用完，删掉这台虚拟机重建即可）' : license.state === 'due' ? '（需要续期）' : ''}`;
}
const Icon = {
  plus: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>,
  more: <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r=".9" /><circle cx="8" cy="8" r=".9" /><circle cx="12.5" cy="8" r=".9" /></svg>,
  chevron: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>,
  agent: <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="5" width="10" height="8" rx="2" /><path d="M8 2.5V5M6 9h.01M10 9h.01" /></svg>,
  human: <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="5" r="2.5" /><path d="M3 14c.6-2.8 2.6-4 5-4s4.4 1.2 5 4" /></svg>,
  lock: <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></svg>,
  fullscreen: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" /></svg>,
  external: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v4h-9v-9h4" /></svg>,
  close: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>,
};

type ConfirmKind = 'stop' | 'discard' | 'rearm' | 'job';
const confirmCopy: Record<ConfirmKind, { title: string; text: string; action: string }> = {
  job: { title: '停止', text: '将结束这个后台任务启动的全部进程（整个进程树）。已经写出的输出会保留在任务文件 .studio-jobs 中，任务不会自动重新运行。', action: '确认停止' },
  stop: { title: '停止', text: 'Windows 将关机，软件中未保存的内容会丢失。C 盘内容和任务文件（D 盘）会保留，之后可以重新启动。关机最长约需 2 分钟。', action: '确认停止' },
  discard: { title: '删除', text: '将删除这台虚拟机的容器和 C 盘内容，无法恢复。任务文件（D 盘）、项目公共空间（F 盘）和采集记录会保留。', action: '确认删除' },
  rearm: { title: '续期并重启', text: '将续期 Windows 评估授权（再用 90 天）并重启 Windows，约 1～3 分钟，软件中未保存的内容会丢失。期间画面锁定，Agent 暂停操作。', action: '续期并重启' },
};
function Confirm({ kind, name, busy, error, warning, onClose, onConfirm }: { kind: ConfirmKind; name: string; busy: boolean; error?: string; warning?: string; onClose(): void; onConfirm(): void }) {
  const dialog = useRef<HTMLDialogElement>(null), cancel = useRef<HTMLButtonElement>(null), titleId = useId();
  useEffect(() => {
    const previous = document.activeElement; dialog.current?.showModal(); cancel.current?.focus();
    return () => { dialog.current?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  return <dialog ref={dialog} className="software-confirm" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <h2 id={titleId}>{confirmCopy[kind].title} {name}？</h2>
    <p>{confirmCopy[kind].text}</p>
    {warning && <p className="software-warning">{warning}</p>}
    {error && <p className="software-warning" role="status">{error}</p>}
    <footer><button ref={cancel} type="button" disabled={busy} onClick={onClose}>取消</button><button type="button" className="software-danger" disabled={busy} onClick={onConfirm}>{busy ? '处理中…' : confirmCopy[kind].action}</button></footer>
  </dialog>;
}

/** The VNC view. While the Agent operates, a layer takes every pointer event and the frame is inert, so nothing typed or
 * clicked reaches the VM; the banner says what the Agent did last and takes the VM over. */
function VmScreen({ seat, title, busy, canControl, now, onTakeOver }: { seat: StudioVmSeatView; title: string; busy: boolean; canControl: boolean; now: number; onTakeOver(): void }) {
  const frame = useRef<HTMLIFrameElement>(null), container = useRef<HTMLDivElement>(null), hintTimer = useRef<ReturnType<typeof setTimeout>>();
  // Studio's licence check and rearm also hold the screen: the rearm reboots Windows.
  const activating = seat.license?.state === 'checking' || seat.license?.state === 'rearming';
  const [hint, setHint] = useState(false), locked = seat.controller === 'agent' || activating, url = vncPage(seat.access.vncUrl!, false);
  useLayoutEffect(() => {
    const element = frame.current; if (!element) return;
    if (locked && document.activeElement === element) element.blur();
    element.toggleAttribute('inert', locked);
  }, [locked, url]);
  useEffect(() => () => clearTimeout(hintTimer.current), []);
  const nudge = () => { setHint(true); clearTimeout(hintTimer.current); hintTimer.current = setTimeout(() => setHint(false), 2400); };
  return <div className={`vm-screen-frame${locked ? ' is-locked' : ''}`} ref={container} data-vm-screen={seat.id}>
    <iframe ref={frame} key={url} className="vm-screen" src={url} title={`${title} 虚拟机画面`} tabIndex={locked ? -1 : 0} referrerPolicy="no-referrer" allow="clipboard-read; clipboard-write; fullscreen" sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-popups" />
    {locked && <div className="vm-lock" aria-label="画面已锁定" onPointerDown={event => { if (event.target === event.currentTarget) { event.preventDefault(); nudge(); } }} onContextMenu={event => event.preventDefault()}>
      <div className="vm-lock-banner">
        {Icon.lock}
        {activating ? <span><strong>{seat.license!.state === 'rearming' ? '正在续期 Windows 评估授权，画面已锁定' : '正在检查 Windows 评估授权…'}</strong><small>{seat.license!.state === 'rearming' ? 'Windows 会重启一次，约 1～3 分钟，完成后自动解锁' : '开机后自动检查，几秒钟'}</small></span>
          : <span><strong>Agent 正在操作，画面已锁定</strong><small>{seat.lastAgentStep ? `最近一步：${describeStep(seat.lastAgentStep)} · ${ago(seat.lastAgentStep.at, now)}` : '鼠标和键盘不会传到虚拟机'}</small></span>}
        {canControl && !activating && <button type="button" className="software-primary" disabled={busy} onClick={onTakeOver}>我来操作</button>}
      </div>
      {hint && <p className="vm-lock-hint" role="status">{activating ? '正在处理 Windows 授权，完成后自动解锁' : '画面已锁定，点「我来操作」接管'}</p>}
    </div>}
  </div>;
}

/** Everything about one VM that is not needed while working in it: run limit, addresses, mounts, recordings, stop and delete. */
function VmDetails({ seat, title, owner, task, records, jobs, showJobs, chatLabel, busy, mayCreate, writable, onClose, onRunLimit, onRecorder, onOpenWindow, onConfirm, onStopJob }: { seat: StudioVmSeatView; title: string; owner: string; task: TaskView; records: VmRecording[]; jobs: VmJobView[]; showJobs: boolean; chatLabel(id: string | null): string; busy: boolean; mayCreate: boolean; writable: boolean; onClose(): void; onRunLimit(minutes: number): void; onRecorder(enabled: boolean): void; onOpenWindow(): void; onConfirm(kind: 'stop' | 'discard'): void; onStopJob(job: VmJobView): void }) {
  const [viewing, setViewing] = useState<VmRecording>(), state = seat.state, running = state === 'ready', jobSection = useRef<HTMLElement>(null);
  // Opened from the status bar's job notice: the job list, not the run facts, is what the user came for.
  useEffect(() => { if (showJobs) jobSection.current?.scrollIntoView({ block: 'start' }); }, [showJobs]);
  const { vncUrl, rdpAddress } = seat.access, locked = seat.controller === 'agent';
  return <section className="vm-details-drawer" aria-label={`${title} 详细信息`}>
    <header><strong title={seat.software.name}>{title}</strong><button type="button" className="software-icon-button" aria-label="关闭详细信息" onClick={onClose}>{Icon.close}</button></header>
    <section><h5>运行</h5>
      <RunLimit value={seat.runMinutes ?? DEFAULT_RUN_MINUTES} disabled={busy || !mayCreate || state === 'stopping'} onChange={onRunLimit} />
      <dl className="vm-facts">
        <div><dt>配置</dt><dd>{seat.spec.cpuCores} 核 / {seat.spec.ramGb} GB</dd></div>
        <div><dt>归属</dt><dd>{owner}</dd></div>
        <div><dt>开始运行</dt><dd>{formatTime(seat.startedAt)}</dd></div>
        <div><dt>到期自动停止</dt><dd>{formatTime(seat.expiresAt)}</dd></div>
        <div><dt>D 盘（任务文件）</dt><dd>{seat.workspace ? seat.workspace.writable ? '可写' : '已冻结（只读）' : '—'}</dd></div>
        <div><dt>E 盘（上游任务）</dt><dd>{seat.upstreamTaskIds.length ? `${seat.upstreamTaskIds.length} 个已完成上游，只读` : '无'}</dd></div>
        <div><dt>Windows 授权</dt><dd title={seat.license ? `检查于 ${formatTime(seat.license.checkedAt)}` : undefined}>{licenseText(seat)}</dd></div>
      </dl>
    </section>
    <section><h5>访问</h5>
      <dl className="vm-access" aria-label="访问信息">
        <div><dt>VNC 网页</dt><dd>{vncUrl ? <><button type="button" className="vm-link" onClick={onOpenWindow}>{locked ? '在新窗口查看（只能看）' : '在新窗口打开'}</button><code>{vncUrl}</code></> : <span>运行后显示</span>}</dd></div>
        <div><dt>RDP</dt><dd>{locked ? <span>Agent 操作时不显示：RDP 登录会占用 Agent 正在用的桌面</span> : rdpAddress ? <><code>{rdpAddress}</code><CopyButton text={rdpAddress} label="RDP 地址" /></> : <span>运行后显示</span>}</dd></div>
        <div><dt>虚拟机</dt><dd><code>{seat.id}</code><CopyButton text={seat.id} label="虚拟机 ID" /><span className="vm-access-separator">·</span>容器 <code>vm-{seat.id}</code></dd></div>
      </dl>
    </section>
    <section ref={jobSection} className="software-records vm-jobs" aria-label="后台任务">
      <header><h5>后台任务</h5><small>{jobs.filter(jobRunning).length} 个运行中</small></header>
      {jobs.length ? <ol>{jobs.slice(0, 10).map(job => <li key={job.jobId} className={`is-${job.state}`}>
        <span className="vm-job-state">{job.stateText}{job.returncode !== null && !jobRunning(job) ? ` · 返回码 ${job.returncode}` : ''}</span>
        <code title={job.command}>{clipCommand(job.command)}</code>
        <small>{chatLabel(job.chatId)} · 开始于 {formatTime(job.startedAt ?? job.createdAt)}{job.endedAt ? ` · 结束于 ${formatTime(job.endedAt)}` : ` · 最长 ${formatMinutes(job.maxMinutes)}`}</small>
        {job.note && <small className="vm-job-note">{job.note}</small>}
        <small>{job.outputRemoved ? '输出已清理' : <>输出：任务文件 <code>{job.taskPath}/</code></>}</small>
        {jobRunning(job) && <button type="button" className="software-text-button" disabled={busy || !writable} onClick={() => onStopJob(job)}>停止…</button>}
      </li>)}</ol> : <p>Agent 用后台运行启动的长命令（求解、重建、批量导出）会列在这里。</p>}
      <p className="software-readonly">后台任务不受“我来操作”影响，会继续运行；停止虚拟机、Windows 重启都会中断它，中断后不会自动重新运行。输出在任务文件的 .studio-jobs 文件夹，结束 7 天后自动清理。</p>
    </section>
    <section className="software-records vm-recordings" aria-label="轨迹采集">
      <header><h5>轨迹采集</h5><small>{records.length} 条</small></header>
      <label className="software-recorder"><input type="checkbox" checked={!!seat.currentRecordingId} disabled={busy || !writable || !running} onChange={event => onRecorder(event.target.checked)} />{seat.currentRecordingId ? '正在采集屏幕和键鼠操作' : '采集已停止'}</label>
      {records.length ? <ol>{records.map(record => <li key={record.id}><time dateTime={record.startedAt}>{new Date(record.startedAt).toLocaleTimeString('zh-CN', { hour12: false })}</time><span>{recordingStates[record.status]}{record.stoppedAt ? ` · 结束于 ${formatTime(record.stoppedAt)}` : ''}</span><RecordingSummary recording={record} /><small>{record.error || record.resultPath}</small><RecordingActions taskId={task.id} recording={record} onOpen={() => setViewing(record)} /></li>)}</ol> : <p>虚拟机进入运行状态后会自动开始采集。</p>}
      <p className="software-readonly">采集器记录屏幕、键鼠和文件变化，停止后生成轨迹；Agent 的操作会标注在对应步骤上。在虚拟机里按 Ctrl+Alt+Shift+M 可以记录一个检查点。</p>
      {viewing && <RecordingViewer taskId={task.id} recording={viewing} onClose={() => setViewing(undefined)} />}
    </section>
    <footer>
      {(state === 'ready' || state === 'provisioning') && <button type="button" className="software-text-button" disabled={busy || !!task.pending} onClick={() => onConfirm('stop')}>停止虚拟机</button>}
      {(state === 'stopped' || state === 'failed') && <button type="button" className="software-text-button" disabled={busy || !!task.pending} onClick={() => onConfirm('discard')}>删除虚拟机</button>}
    </footer>
  </section>;
}

interface Menu { vmId: string; x: number; y: number }
/** One window per VM opened from Studio; it follows the operator, so it can only watch while the Agent operates. */
interface OpenedWindow { window: Window; url: string }

/** The vm_manager software area of a task conversation: one tab per VM of the conversation, an add wizard, the host's
 * capacity, and the operator lock. Without a conversation yet, the tabs are the task's VMs owned by none; VMs added
 * there join the conversation its first message creates. */
export function VmArea({ task, active, catalog, defaultRunMinutes = DEFAULT_RUN_MINUTES, chatId, chats, onSelectChat }: { task: TaskView; active: boolean; catalog: SoftwareDescriptor[]; defaultRunMinutes?: number; chatId: string; chats: string[]; onSelectChat?(id: string): void }) {
  const taskId = task.id;
  const [seats, setSeats] = useState<StudioVmSeatView[]>(), [resources, setResources] = useState<VmResources>(), [records, setRecords] = useState<VmRecording[]>([]), [jobs, setJobs] = useState<VmJobView[]>([]);
  const [selectedByChat, setSelectedByChat] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [connectionError, setConnectionError] = useState('');
  const [launching, setLaunching] = useState(false), [resourcesOpen, setResourcesOpen] = useState(false), [details, setDetails] = useState<false | 'all' | 'jobs'>(false), [overflowOpen, setOverflowOpen] = useState(false);
  const [menu, setMenu] = useState<Menu>(), [confirmation, setConfirmation] = useState<{ kind: ConfirmKind; vmId: string; job?: VmJobView }>(), [overflowing, setOverflowing] = useState(false);
  const alive = useRef(true), pending = useRef(false), fetching = useRef(false), sequence = useRef(0), accepted = useRef(0), launchRequest = useRef<string>();
  const windows = useRef(new Map<string, OpenedWindow>()), menuElement = useRef<HTMLDivElement>(null), tabList = useRef<HTMLDivElement>(null);
  // VMs added before the conversation existed join the conversation its first message creates.
  const draftVms = useRef(new Set<string>()), draftChats = useRef<string[]>();
  const now = useNow(15000);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // A notice reports what just happened; the status bar carries the lasting state.
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 6000); return () => clearTimeout(timer); }, [notice]);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    // Background jobs are a side list: when they cannot be read, the VMs still show.
    const [view, listed] = await Promise.all([api<{ seats: StudioVmSeatView[] }>(`software/seats?${new URLSearchParams({ taskId })}`, undefined, { timeoutMs: 30000 }),
      api<{ jobs: VmJobView[] }>(`software/jobs?${new URLSearchParams({ taskId })}`, undefined, { timeoutMs: 30000 }).catch(() => undefined)]);
    if (!alive.current || request < accepted.current) return;
    accepted.current = request; setSeats(view.seats); if (listed) setJobs(listed.jobs);
  }, [taskId]);
  const refreshResources = useCallback(async () => { const value = await api<VmResources>('software/resources', undefined, { timeoutMs: 30000 }); if (alive.current) setResources(value); }, []);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    const poll = () => {
      if (disposed || document.visibilityState === 'hidden' || fetching.current || pending.current) return;
      fetching.current = true;
      // vm_manager recommends polling a VM every 5 seconds.
      void refresh().then(() => { if (!disposed) setConnectionError(''); }, reason => { if (!disposed) setConnectionError(message(reason, '无法连接虚拟机平台')); }).finally(() => { fetching.current = false; });
    };
    poll(); const timer = setInterval(poll, 5000); document.addEventListener('visibilitychange', poll);
    return () => { disposed = true; clearInterval(timer); document.removeEventListener('visibilitychange', poll); };
  }, [active, refresh]);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    const poll = () => { if (!disposed && document.visibilityState !== 'hidden') void refreshResources().catch(() => undefined); };
    poll(); const timer = setInterval(poll, launching || resourcesOpen ? 5000 : 15000);
    return () => { disposed = true; clearInterval(timer); };
  }, [active, refreshResources, launching, resourcesOpen]);

  const eligible = task.kind === 'task' && !task.isFolder;
  const mayCreate = eligible && task.writable && !task.pending && !task.archived;
  const scope = eligible ? chatId : '*';
  const all = seats ?? [], tabs = all.filter(row => !eligible || (chatId ? row.chatId === chatId : row.owner === 'human'));
  const seat = tabs.find(row => row.id === selectedByChat[scope]) ?? tabs[0];
  // Messages belong to the conversation they were shown in.
  useEffect(() => { setNotice(''); setError(''); setDetails(false); }, [scope]);
  const select = (id: string) => { setSelectedByChat(previous => ({ ...previous, [scope]: id })); setMenu(undefined); setOverflowOpen(false); };
  const software = (row: StudioVmSeatView) => catalog.find(entry => entry.id === row.softwareId) ?? row.software;
  /** Tab names, numbered when one conversation has several VMs of an environment. */
  const titleOf = (row: StudioVmSeatView, list = tabs) => {
    const same = list.filter(item => item.softwareId === row.softwareId && item.chatId === row.chatId), name = softwareShortName(software(row), row.softwareId);
    return same.length > 1 ? `${name} #${same.indexOf(row) + 1}` : name;
  };
  const chatLabel = (id: string | null) => !id ? '未归属对话' : chats.includes(id) ? `对话 ${chats.indexOf(id) + 1}${id === chatId ? '（当前）' : ''}` : '其他对话';

  // VMs added while the conversation was still a draft join the first conversation created after it.
  useEffect(() => {
    if (!chatId) { draftChats.current ??= chats; return; }
    if (!draftVms.current.size || !draftChats.current || draftChats.current.includes(chatId) || !chats.includes(chatId)) return;
    const moving = [...draftVms.current]; draftVms.current.clear(); draftChats.current = undefined;
    void (async () => {
      for (const vmId of moving) { try { await api('software/assign', { taskId, vmId, chatId }); } catch { /* it stays among the VMs owned by no conversation */ } }
      if (alive.current) { setSelectedByChat(value => ({ ...value, [chatId]: moving.at(-1)! })); await refresh().catch(() => undefined); }
    })();
  });

  // Records follow the selected VM while its details are open.
  const detailId = details ? seat?.id : undefined;
  useEffect(() => {
    setRecords([]);
    if (!detailId || !active) return;
    let disposed = false;
    const load = () => { void api<{ records: VmRecording[] }>(`software/records?${new URLSearchParams({ taskId, vmId: detailId })}`, undefined, { timeoutMs: 30000 }).then(value => { if (!disposed) setRecords(value.records); }, () => undefined); };
    load(); const timer = setInterval(load, 5000);
    return () => { disposed = true; clearInterval(timer); };
  }, [detailId, active, taskId]);

  // Windows opened from here follow each VM's operator and its address, which changes on every start.
  useEffect(() => {
    for (const [vmId, opened] of windows.current) {
      if (opened.window.closed) { windows.current.delete(vmId); continue; }
      const row = all.find(item => item.id === vmId); if (!row?.access.vncUrl) continue;
      const url = vncPage(row.access.vncUrl, row.controller === 'agent');
      if (url !== opened.url) { try { opened.window.location.href = url; opened.url = url; } catch { windows.current.delete(vmId); } }
    }
  });
  const openWindow = (row: StudioVmSeatView) => {
    if (!row.access.vncUrl) return;
    const url = vncPage(row.access.vncUrl, row.controller === 'agent'), existing = windows.current.get(row.id);
    if (existing && !existing.window.closed) { existing.window.location.href = url; existing.url = url; existing.window.focus(); return; }
    const opened = window.open('', `harnessstudio-vm-${row.id}`);
    if (!opened) { setError('浏览器拦截了新窗口，请允许本站打开弹出窗口后重试。'); return; }
    // The opener link stays: it is what lets this page switch the window to view only when the Agent takes over.
    opened.location.href = url; windows.current.set(row.id, { window: opened, url });
  };

  const run = async (action: () => Promise<void>, refreshAfter = true) => {
    if (pending.current || !active) return false;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try { await action(); if (refreshAfter) await refresh(); return true; }
    catch (reason) { if (alive.current) setError(message(reason, '虚拟机操作失败')); return false; }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const restart = (row: StudioVmSeatView) => { if (mayCreate) void run(async () => { await api('software/start', { taskId, vmId: row.id }, { timeoutMs: 60000 }); }); };
  /** A stopped or failed VM takes the new limit when restarted; a starting or running one gets it now, counted from this run's start. */
  const setRunLimit = (row: StudioVmSeatView, minutes: number) => {
    if (!mayCreate) return;
    void run(async () => {
      if (row.state === 'ready' || row.state === 'provisioning') { await api('software/start', { taskId, vmId: row.id, runMinutes: minutes }, { timeoutMs: 60000 }); setNotice(`运行时长已改为 ${formatMinutes(minutes)}，从本次开始运行时算起。`); }
      else { await api('software/start', { taskId, vmId: row.id, runMinutes: minutes }, { timeoutMs: 60000 }); setNotice(`已按 ${formatMinutes(minutes)} 重新启动。`); }
    });
  };
  const handover = (row: StudioVmSeatView, controller: 'agent' | 'human') => {
    if (row.controller === controller) return;
    void run(async () => { await api('software/controller', { taskId, vmId: row.id, controller }, { timeoutMs: 30000 }); setNotice(controller === 'agent' ? 'Agent 现在可以操作这台虚拟机，画面已锁定。' : '你在操作这台虚拟机，Agent 只能截图和读取界面。'); });
  };
  const release = (vmId: string, discard: boolean) => {
    const target = all.find(row => row.id === vmId); if (!target) return;
    void run(async () => { await api('software/release', { taskId, vmId, confirm: true, discard }, { timeoutMs: 240000 }); setConfirmation(undefined); setNotice(discard ? `${titleOf(target)} 已删除。` : `${titleOf(target)} 已停止，C 盘内容已保留。`); });
  };
  const licenseAction = (row: StudioVmSeatView, action: 'check' | 'rearm') => { void run(async () => { await api('software/license', { taskId, vmId: row.id, action }, { timeoutMs: 60000 }); setConfirmation(undefined); setNotice(action === 'rearm' ? '正在续期 Windows 授权，Windows 会重启一次。' : '正在重新检查 Windows 授权。'); }); };
  const stopJob = (job: VmJobView) => { void run(async () => { const result = await api<{ job: VmJobView }>('software/job-cancel', { taskId, vmId: job.vmId, jobId: job.jobId }, { timeoutMs: 90000 }); setConfirmation(undefined); setNotice(jobRunning(result.job) ? '已要求停止后台任务，进程还在退出，稍后会更新。' : `后台任务${result.job.stateText}。`); }); };
  const toggleRecording = (row: StudioVmSeatView, enabled: boolean) => { void run(async () => { await api('software/recorder', { taskId, vmId: row.id, enabled }, { timeoutMs: 240000 }); }); };
  const assign = (row: StudioVmSeatView) => { if (chatId) void run(async () => { await api('software/assign', { taskId, vmId: row.id, chatId }, { timeoutMs: 30000 }); select(row.id); }); };
  const launch = async (choice: VmLaunchChoice) => {
    // Keep one request ID until it is acknowledged; the backend also adopts a create whose response was lost.
    const requestId = launchRequest.current ??= randomId();
    const result = await api<{ seat: StudioVmSeatView }>('software/seat', { taskId, imageId: choice.environmentId, requestId, runMinutes: choice.runMinutes, cpuCores: choice.cpuCores, ramGb: choice.ramGb, queueMinutes: choice.queueMinutes, controller: choice.controller, ...(chatId ? { chatId } : {}) }, { timeoutMs: 60000 });
    if (launchRequest.current === requestId) launchRequest.current = undefined;
    if (!chatId) draftVms.current.add(result.seat.id);
    if (!alive.current) return;
    setLaunching(false); select(result.seat.id); setNotice(result.seat.queue ? `已提交，排队第 ${result.seat.queue.position} 位。` : '已提交，正在创建虚拟机。首次开机通常需要 2～8 分钟。');
    await Promise.all([refresh(), refreshResources()]).catch(() => undefined);
  };

  // The tab strip offers a list of every tab once they no longer fit.
  useLayoutEffect(() => {
    const element = tabList.current; if (!element) return;
    const measure = () => setOverflowing(element.scrollWidth > element.clientWidth + 1);
    measure(); const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [tabs.length]);
  useEffect(() => { tabList.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [seat?.id]);
  useEffect(() => {
    if (!menu) return;
    menuElement.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => { if (!menuElement.current?.contains(event.target as Node)) setMenu(undefined); };
    const key = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setMenu(undefined); } };
    const dismiss = () => setMenu(undefined);
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', key); window.addEventListener('resize', dismiss); window.addEventListener('blur', dismiss);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', key); window.removeEventListener('resize', dismiss); window.removeEventListener('blur', dismiss); };
  }, [menu]);
  useEffect(() => {
    if (!overflowOpen) return;
    const outside = (event: PointerEvent) => { if (!(event.target as Element | null)?.closest?.('.vm-overflow')) setOverflowOpen(false); };
    const key = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') setOverflowOpen(false); };
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', key); };
  }, [overflowOpen]);
  const openMenu = (event: ReactMouseEvent, row: StudioVmSeatView) => {
    event.preventDefault(); select(row.id);
    setMenu({ vmId: row.id, x: Math.max(8, Math.min(event.clientX, window.innerWidth - 200)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 220)) });
  };
  const tabKeys = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : undefined;
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) { const box = event.currentTarget.getBoundingClientRect(); openMenu({ preventDefault: () => event.preventDefault(), clientX: box.left + 12, clientY: box.bottom } as ReactMouseEvent, tabs[index]!); return; }
    if (next === undefined) return;
    event.preventDefault(); select(tabs[next]!.id); tabList.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };

  const menuSeat = menu && all.find(row => row.id === menu.vmId), confirmSeat = confirmation && all.find(row => row.id === confirmation.vmId);
  const jobsOf = (vmId: string) => jobs.filter(job => job.vmId === vmId), runningJobs = seat ? jobsOf(seat.id).filter(jobRunning) : [];
  const confirmRunning = confirmation ? jobsOf(confirmation.vmId).filter(jobRunning).length : 0;
  const confirmWarning = confirmation && (confirmation.kind === 'stop' || confirmation.kind === 'rearm') && confirmRunning ? `这台虚拟机上有 ${confirmRunning} 个后台任务正在运行，${confirmation.kind === 'stop' ? '关机' : '重启'}会中断它们，之后不会自动重新运行。` : undefined;
  const host = resources?.host, label = chatId ? chatLabel(chatId).replace('（当前）', '') : '新对话';
  const disabledReason = !eligible ? '任务组只能查看已有虚拟机，请在末端子任务中添加软件环境。' : !task.writable || task.archived ? '当前任务只读，恢复编辑后可以添加软件环境。' : task.pending ? '任务操作处理中，稍后可以添加软件环境。' : '';
  const state = seat?.state, running = state === 'ready', expiresIn = seat?.expiresAt ? Date.parse(seat.expiresAt) - now : Infinity;
  const expiring = running && expiresIn < 15 * 60000, writable = mayCreate && !!seat?.canEdit, canControl = eligible && !!seat;
  const tabState = (row: StudioVmSeatView) => `is-${row.state}${row.state === 'ready' && row.expiresAt && Date.parse(row.expiresAt) - now < 15 * 60000 ? ' is-expiring' : ''}`;
  return <section className="software-panel vm-area" aria-label="软件环境">
    <nav className="vm-tabbar" aria-label={`${label}的软件环境`}>
      <div className="vm-tabs" role="tablist" ref={tabList} aria-label="虚拟机">
        {tabs.map((row, index) => <button key={row.id} type="button" role="tab" aria-selected={row.id === seat?.id} tabIndex={row.id === seat?.id ? 0 : -1} className={`vm-tab ${tabState(row)}`}
          title={`${row.software.name}\n${vmStateLabel(row)} · ${row.spec.cpuCores} 核 / ${row.spec.ramGb} GB\n${row.controller === 'agent' ? 'Agent 操作中，画面已锁定' : '你在操作'}\n右键查看更多操作`}
          onClick={() => select(row.id)} onContextMenu={event => openMenu(event, row)} onKeyDown={event => tabKeys(event, index)}>
          <span className={`software-status-dot${row.state === 'provisioning' || row.state === 'stopping' ? ' is-busy' : ''}`} /><span className="vm-tab-name">{titleOf(row)}</span><span className={`vm-tab-operator is-${row.controller}`} aria-label={row.controller === 'agent' ? 'Agent 操作' : '我来操作'}>{row.controller === 'agent' ? Icon.agent : Icon.human}</span>
        </button>)}
      </div>
      {overflowing && <div className="vm-overflow"><button type="button" className="software-icon-button" aria-label="全部虚拟机标签" aria-expanded={overflowOpen} onClick={() => setOverflowOpen(value => !value)}>{Icon.chevron}</button>
        {overflowOpen && <div className="vm-overflow-list" role="menu">{tabs.map(row => <button key={row.id} type="button" role="menuitem" className={tabState(row)} onClick={() => select(row.id)}><span className="software-status-dot" />{titleOf(row)}<small>{vmStateLabel(row)}</small></button>)}</div>}</div>}
      <button type="button" className="software-icon-button vm-tab-add" aria-label="添加软件环境" title={disabledReason || '添加软件环境'} disabled={!mayCreate || busy} onClick={() => setLaunching(true)}>{Icon.plus}</button>
      <div className="vm-resource-anchor">
        <button type="button" className="vm-resource-chip" aria-expanded={resourcesOpen} title="宿主机资源和本任务的全部虚拟机" onClick={() => setResourcesOpen(value => !value)}>
          {host ? <><span>可用 {host.cpu.available} 核 · {host.memoryGb.available} GB</span><span className="vm-chip-extra">运行 {host.running}</span><span className={host.queued ? 'is-queued' : ''}>排队 {host.queued}</span></> : <span>资源</span>}{Icon.chevron}
        </button>
        {resourcesOpen && <VmResourcePanel resources={resources} seats={all} titleOf={row => titleOf(row, all)} chatLabel={chatLabel} currentChat={chatId} canAssign={!!chatId && mayCreate} busy={busy}
          onClose={() => setResourcesOpen(false)} onOpen={row => { setResourcesOpen(false); select(row.id); }} onSelectChat={onSelectChat && (id => { setResourcesOpen(false); onSelectChat(id); })} onAssign={row => { setResourcesOpen(false); assign(row); }} />}
      </div>
    </nav>
    <div className="software-message" role="status">{error || connectionError || notice}</div>
    {!seats ? <div className="software-empty"><span className="software-status-dot is-busy" /><p>正在读取虚拟机…</p></div> : !seat ? <div className="software-empty vm-empty">
      <div className="software-empty-art"><svg viewBox="0 0 62 50" aria-hidden="true"><rect x="6" y="6" width="50" height="32" rx="4" /><path d="M24 44h14M31 38v6M31 16v12M25 22h12" /></svg></div>
      <h3>{eligible ? `${label}还没有软件环境` : '没有虚拟机'}</h3>
      <p>{eligible ? '每台虚拟机是一个标签页，预装真实软件；本任务的所有虚拟机共用 D 盘（任务文件）。Agent 在对话里启动的也会出现在这里。' : '任务组只能查看已有虚拟机。'}</p>
      {eligible && <button type="button" className="software-primary vm-empty-add" disabled={!mayCreate || busy} onClick={() => setLaunching(true)}>{Icon.plus}添加软件环境</button>}
      {host && <small>现在可用 {host.cpu.available} 核 / {host.memoryGb.available} GB 内存 · 运行 {host.running} 台 · 排队 {host.queued} 台</small>}
      {disabledReason && <small>{disabledReason}</small>}
      {eligible && !chatId && mayCreate && <small>这是新对话：添加的虚拟机会在你发出第一条消息后归入这个对话。</small>}
    </div> : <div className="vm-view">
      <div className="vm-statusbar">
        <span className={`software-seat-status is-${state}`}><span className={`software-status-dot${state === 'provisioning' || state === 'stopping' ? ' is-busy' : ''}`} />{vmStateLabel(seat)}</span>
        <span className="vm-spec">{seat.spec.cpuCores} 核 / {seat.spec.ramGb} GB</span>
        {seat.expiresAt && (running || state === 'provisioning') && <span className={`vm-expiry${expiring ? ' is-expiring' : ''}`} title={`到期自动停止：${formatTime(seat.expiresAt)}`}>{expiring ? `还剩 ${Math.max(0, Math.ceil(expiresIn / 60000))} 分钟` : `到期 ${formatShort(seat.expiresAt)}`}</span>}
        {(running || state === 'provisioning') && mayCreate && <button type="button" className={`vm-extend${expiring ? ' is-expiring' : ''}`} disabled={busy || (seat.runMinutes ?? 0) + 60 > MAX_RUN_MINUTES} onClick={() => setRunLimit(seat, Math.min(MAX_RUN_MINUTES, (seat.runMinutes ?? DEFAULT_RUN_MINUTES) + 60))}>延长 1 小时</button>}
        {runningJobs.length > 0 && <button type="button" className="vm-jobs-chip" title={runningJobs.map(job => `${job.stateText}：${clipCommand(job.command)}`).join('\n')} onClick={() => setDetails('jobs')}>后台任务 {runningJobs.length} 个运行中</button>}
        {running && seat.license && ['due', 'exhausted', 'failed'].includes(seat.license.state) && <span className="vm-license-warning" title={licenseText(seat)}>
          {seat.license.state === 'due' ? `Windows 授权${seat.license.licensed ? `剩 ${seat.license.daysLeft} 天` : '已过期'}` : seat.license.state === 'exhausted' ? 'Windows 授权已用完，请删掉重建' : 'Windows 授权检查失败'}
          {seat.license.state !== 'exhausted' && mayCreate && <button type="button" disabled={busy} onClick={() => seat.license!.state === 'failed' && !seat.license!.error?.includes('续期') ? licenseAction(seat, 'check') : setConfirmation({ kind: 'rearm', vmId: seat.id })}>{seat.license.state === 'failed' && !seat.license.error?.includes('续期') ? '重试' : '续期并重启'}</button>}
        </span>}
        <div className="vm-statusbar-actions">
          {canControl && <div className="vm-operator" role="group" aria-label="谁来操作" title="同一时间只有一个操作者。交给 Agent 时画面锁定，点「我」接管。">
            <span>操作</span>
            <button type="button" aria-pressed={seat.controller === 'agent'} disabled={busy} onClick={() => handover(seat, 'agent')}>{Icon.agent}Agent</button>
            <button type="button" aria-pressed={seat.controller === 'human'} disabled={busy} onClick={() => handover(seat, 'human')}>{Icon.human}我</button>
          </div>}
          {(state === 'stopped' || state === 'failed') && <button type="button" className="software-primary" disabled={busy || !mayCreate} onClick={() => restart(seat)}>重新启动</button>}
          {running && seat.access.vncUrl && <button type="button" className="software-icon-button" aria-label="全屏" title="全屏" onClick={() => { void document.querySelector<HTMLElement>(`[data-vm-screen="${seat.id}"]`)?.requestFullscreen?.().catch(() => setError('浏览器拒绝了全屏，请改用“在新窗口打开”。')); }}>{Icon.fullscreen}</button>}
          {running && seat.access.vncUrl && <button type="button" className="software-icon-button" aria-label={seat.controller === 'agent' ? '在新窗口查看（只能看）' : '在新窗口打开'} title={seat.controller === 'agent' ? '在新窗口查看（Agent 操作时只能看）' : '在新窗口打开'} onClick={() => openWindow(seat)}>{Icon.external}</button>}
          <button type="button" className="software-icon-button" aria-label="详细信息" title="运行时长、访问地址、轨迹采集、停止和删除" aria-expanded={!!details} onClick={() => setDetails(value => value ? false : 'all')}>{Icon.more}</button>
        </div>
      </div>
      <div className="vm-stage">
        {state === 'provisioning' && <div className="vm-notice"><strong>{seat.queue ? `排队中，第 ${seat.queue.position} 位` : vmStatuses[seat.vmStatus] ?? '正在准备'}</strong><p>{seat.queue ? `${queueReasons[seat.queue.reason] ?? seat.queue.reason}；${formatTime(seat.queue.expiresAt)} 前仍未开始会自动取消。${resources?.releases[0] ? `最早 ${formatShort(resources.releases[0].at)} 有虚拟机到期释放资源。` : ''}` : `提交于 ${formatTime(seat.createdAt)}。首次开机通常需要 2～8 分钟，重新启动约 2 分钟，页面会自动刷新。`}</p></div>}
        {state === 'stopping' && <div className="vm-notice"><strong>正在关机</strong><p>Windows 正在关机，完成后可以重新启动或删除。</p></div>}
        {state === 'failed' && <div className="software-warning"><strong>{vmStateLabel(seat)}{seat.error ? `（${seat.error.code}）` : ''}</strong><p>{seat.error?.message || '请查看虚拟机平台日志。'}{seat.stoppedAt ? `，停止于 ${formatTime(seat.stoppedAt)}` : ''}。{seat.startedAt ? 'C 盘内容保留在原来的容器里：点“重新启动”回到关机时的状态，软件中未保存的内容已经丢失。不再需要时可以在右键菜单中删除。' : '这台虚拟机还没有开过机，点“重新启动”会重新排队创建。'}</p></div>}
        {state === 'stopped' && <div className="vm-notice"><strong>已停止{seat.stopReason ? `（${stopReasons[seat.stopReason] ?? seat.stopReason}）` : ''}</strong><p>停止于 {formatTime(seat.stoppedAt)}。C 盘内容已保留，点“重新启动”继续使用。</p></div>}
        {running && seat.unreachableSince && seat.license?.state !== 'rearming' && <div className="vm-notice"><strong>虚拟机内的服务暂时无响应</strong><p>从 {formatTime(seat.unreachableSince)} 起无响应，Windows 可能正在重启，画面中可以看到进度。持续约 5 分钟仍无响应才会判为失败。</p></div>}
        {running && (seat.access.vncUrl ? <VmScreen seat={seat} title={titleOf(seat)} busy={busy} canControl={canControl} now={now} onTakeOver={() => handover(seat, 'human')} /> : <div className="vm-notice"><strong>运行中</strong><p>这台虚拟机没有开放 VNC 画面。</p></div>)}
        {!writable && eligible && <p className="software-readonly">当前任务只读，可以查看或停止虚拟机。</p>}
        {details && <VmDetails seat={seat} title={titleOf(seat)} owner={chatLabel(seat.chatId)} task={task} records={records} jobs={jobsOf(seat.id)} showJobs={details === 'jobs'} chatLabel={chatLabel} busy={busy} mayCreate={mayCreate} writable={writable} onClose={() => setDetails(false)} onRunLimit={minutes => setRunLimit(seat, minutes)} onRecorder={enabled => toggleRecording(seat, enabled)} onOpenWindow={() => openWindow(seat)} onConfirm={kind => setConfirmation({ kind, vmId: seat.id })} onStopJob={job => setConfirmation({ kind: 'job', vmId: seat.id, job })} />}
      </div>
    </div>}
    {menu && menuSeat && <div className="sidebar-context-menu vm-context-menu" ref={menuElement} role="menu" aria-label={`${titleOf(menuSeat)} 操作`} style={{ left: menu.x, top: menu.y }}>
      {(menuSeat.state === 'stopped' || menuSeat.state === 'failed') && <button type="button" role="menuitem" disabled={busy || !mayCreate} onClick={() => { setMenu(undefined); restart(menuSeat); }}>重新启动</button>}
      {menuSeat.state === 'ready' && menuSeat.access.vncUrl && <button type="button" role="menuitem" onClick={() => { setMenu(undefined); openWindow(menuSeat); }}>{menuSeat.controller === 'agent' ? '在新窗口查看（只能看）' : '在新窗口打开'}</button>}
      {canControl && <button type="button" role="menuitem" disabled={busy} onClick={() => { setMenu(undefined); handover(menuSeat, menuSeat.controller === 'agent' ? 'human' : 'agent'); }}>{menuSeat.controller === 'agent' ? '我来操作' : '交给 Agent'}</button>}
      <button type="button" role="menuitem" onClick={() => { setMenu(undefined); setDetails('all'); }}>详细信息</button>
      <div className="sidebar-menu-divider" role="separator" />
      {(menuSeat.state === 'ready' || menuSeat.state === 'provisioning') && <button type="button" role="menuitem" className="sidebar-menu-delete" disabled={busy || !!task.pending} onClick={() => { setMenu(undefined); setConfirmation({ kind: 'stop', vmId: menuSeat.id }); }}>停止虚拟机…</button>}
      {(menuSeat.state === 'stopped' || menuSeat.state === 'failed') && <button type="button" role="menuitem" className="sidebar-menu-delete" disabled={busy || !!task.pending} onClick={() => { setMenu(undefined); setConfirmation({ kind: 'discard', vmId: menuSeat.id }); }}>删除虚拟机…</button>}
    </div>}
    {confirmation && confirmSeat && <Confirm kind={confirmation.kind} name={confirmation.job ? `后台任务 ${clipCommand(confirmation.job.command)}` : titleOf(confirmSeat)} busy={busy} error={error} warning={confirmWarning} onClose={() => setConfirmation(undefined)} onConfirm={() => { const target = all.find(row => row.id === confirmation.vmId); if (confirmation.kind === 'job') { if (confirmation.job) stopJob(confirmation.job); } else if (confirmation.kind === 'rearm') { if (target) licenseAction(target, 'rearm'); } else release(confirmation.vmId, confirmation.kind === 'discard'); }} />}
    {launching && <VmLaunchDialog catalog={catalog} resources={resources} defaultRunMinutes={defaultRunMinutes} target={label} onRefresh={() => refreshResources()} onClose={() => setLaunching(false)} onLaunch={launch} />}
  </section>;
}
