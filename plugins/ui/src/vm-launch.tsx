import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { SoftwareDescriptor, StudioVmSeatView, VmResources } from '../../studio/src/seat-types.ts';
import { formatMinutes, formatShort, RUN_OPTIONS, softwareShortName, vmStateLabel } from './vm-format.ts';

export interface VmLaunchChoice { environmentId: string; cpuCores: number; ramGb: number; runMinutes: number; queueMinutes?: number; controller: 'agent' | 'human' }
type Preset = 'standard' | 'boosted' | 'custom';
interface Remembered { environmentId?: string; environments?: Record<string, { preset: Preset; cpuCores: number; ramGb: number; runMinutes: number; controller: 'agent' | 'human' }> }
const STORAGE_KEY = 'harnessstudio:vm-launch:v1';
const QUEUE_OPTIONS = [30, 60, 120, 240, 480];
/** The last choices per environment are a per-browser convenience; the page works without storage. */
function remembered(): Remembered { try { const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}'); return value && typeof value === 'object' ? value as Remembered : {}; } catch { return {}; } }
function remember(choice: VmLaunchChoice, preset: Preset) {
  try { const value = remembered(); localStorage.setItem(STORAGE_KEY, JSON.stringify({ environmentId: choice.environmentId, environments: { ...value.environments, [choice.environmentId]: { preset, cpuCores: choice.cpuCores, ramGb: choice.ramGb, runMinutes: choice.runMinutes, controller: choice.controller } } })); } catch { /* storage unavailable */ }
}
const boosted = (spec: { cpuCores: number; ramGb: number }) => ({ cpuCores: Math.ceil(spec.cpuCores * 1.5), ramGb: Math.ceil(spec.ramGb * 1.5) });

/** A capacity bar: what other VMs hold, what this launch would take, and what stays free. */
function Meter({ label, held, request = 0, total, unit, note }: { label: string; held: number; request?: number; total: number; unit: string; note?: string }) {
  const scale = Math.max(total, held + request, 1), over = held + request > total;
  return <div className={`vm-meter${over ? ' is-over' : ''}`}>
    <span className="vm-meter-label">{label}</span>
    <span className="vm-meter-track" role="img" aria-label={`${label}：已占用 ${held} ${unit}${request ? `，本次 ${request} ${unit}` : ''}，可分配共 ${total} ${unit}`}>
      <span className="vm-meter-held" style={{ width: `${held / scale * 100}%` }} />{request > 0 && <span className="vm-meter-request" style={{ width: `${Math.min(request, scale - held) / scale * 100}%` }} />}
    </span>
    <span className="vm-meter-value">{note ?? `${request ? `本次 ${request} · ` : ''}剩 ${Math.max(0, total - held - request)} ${unit}`}</span>
  </div>;
}

/** Host capacity and every VM of the task, grouped by conversation. */
export function VmResourcePanel({ resources, seats, titleOf, chatLabel, currentChat, canAssign, busy, onClose, onOpen, onSelectChat, onAssign }: { resources?: VmResources; seats: StudioVmSeatView[]; titleOf(row: StudioVmSeatView): string; chatLabel(id: string | null): string; currentChat: string; canAssign: boolean; busy: boolean; onClose(): void; onOpen(row: StudioVmSeatView): void; onSelectChat?(id: string): void; onAssign(row: StudioVmSeatView): void }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!(event.target as Element | null)?.closest?.('.vm-resource-anchor')) onClose(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', key); };
  }, [onClose]);
  const host = resources?.host, release = resources?.releases[0];
  const groups = [...new Set(seats.map(row => row.chatId))].sort((a, b) => (a === currentChat ? -1 : b === currentChat ? 1 : 0));
  return <div className="vm-resource-popover" ref={panel} role="dialog" aria-label="宿主机资源和本任务的虚拟机">
    <h4>宿主机资源<small>{resources ? `按已分配额度计算 · ${new Date(resources.checkedAt).toLocaleTimeString('zh-CN', { hour12: false })}` : '正在读取…'}</small></h4>
    {host && <>
      <Meter label="CPU" held={host.cpu.allocated} total={host.cpu.allocated + host.cpu.available} unit="核" note={`可用 ${host.cpu.available} / 共 ${host.cpu.total} 核`} />
      <Meter label="内存" held={host.memoryGb.allocated} total={host.memoryGb.allocated + host.memoryGb.available} unit="GB" note={`可用 ${host.memoryGb.available} / 共 ${host.memoryGb.total} GB`} />
      <Meter label="磁盘" held={host.diskGb.used} total={host.diskGb.total} unit="GB" note={`剩 ${host.diskGb.available} GB`} />
      <p className="vm-resource-summary">运行 {host.running} 台 · 排队 {host.queued} 台{release ? ` · 最早 ${formatShort(release.at)} 有虚拟机到期，释放 ${release.cpuCores} 核 / ${release.ramGb} GB` : ''}</p>
    </>}
    <h4>本任务的虚拟机<small>{seats.length} 台，共用 D 盘</small></h4>
    {seats.length ? groups.map(group => <section key={group ?? 'none'} className="vm-resource-group">
      <header><span>{chatLabel(group)}</span>{group && group !== currentChat && onSelectChat && <button type="button" className="vm-link" onClick={() => onSelectChat(group)}>切换到该对话</button>}</header>
      <ul>{seats.filter(row => row.chatId === group).map(row => <li key={row.id} className={`is-${row.state}`}>
        <span className="software-status-dot" /><span className="vm-resource-name" title={row.software.name}>{titleOf(row)}</span><small>{vmStateLabel(row)} · {row.spec.cpuCores} 核 / {row.spec.ramGb} GB · {row.controller === 'agent' ? 'Agent 操作' : '人工操作'}</small>
        {group === currentChat ? <button type="button" className="vm-link" onClick={() => onOpen(row)}>打开</button> : !group && canAssign ? <button type="button" className="vm-link" disabled={busy} onClick={() => onAssign(row)}>移到本对话</button> : null}
      </li>)}</ul>
    </section>) : <p className="vm-resource-summary">还没有虚拟机。</p>}
  </div>;
}

/** Add a software environment: environment, resources and run time on one page, with the host's capacity and the queue. */
export function VmLaunchDialog({ catalog, resources, defaultRunMinutes, target, onRefresh, onClose, onLaunch }: { catalog: SoftwareDescriptor[]; resources?: VmResources; defaultRunMinutes: number; target: string; onRefresh(): Promise<void>; onClose(): void; onLaunch(choice: VmLaunchChoice): Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null), titleId = useId(), saved = useRef(remembered());
  const environments = catalog.filter(entry => entry.vm), host = resources?.host;
  const firstFit = environments.find(entry => (resources?.environments.find(row => row.id === entry.id)?.launchable ?? 0) > 0);
  const [environmentId, setEnvironmentId] = useState(() => environments.find(entry => entry.id === saved.current.environmentId)?.id ?? firstFit?.id ?? environments[0]?.id ?? '');
  const environment = environments.find(entry => entry.id === environmentId), min = environment?.vm?.minSpec ?? { cpuCores: 1, ramGb: 1 };
  const initial = (id: string) => {
    const entry = environments.find(row => row.id === id), spec = entry?.vm?.minSpec ?? { cpuCores: 1, ramGb: 1 }, last = saved.current.environments?.[id];
    return last && last.cpuCores >= spec.cpuCores && last.ramGb >= spec.ramGb ? last : { preset: 'standard' as Preset, ...spec, runMinutes: defaultRunMinutes, controller: 'human' as const };
  };
  const [config, setConfig] = useState(() => initial(environmentId));
  const [queueMinutes, setQueueMinutes] = useState(30), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    const previous = document.activeElement; dialog.current?.showModal();
    return () => { dialog.current?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  const chooseEnvironment = (id: string) => { setEnvironmentId(id); setConfig(initial(id)); setError(''); };
  const choosePreset = (preset: Preset) => setConfig(value => ({ ...value, preset, ...(preset === 'standard' ? min : preset === 'boosted' ? boosted(min) : {}) }));
  const overhead = resources?.overheadRamGb ?? 1, needCpu = config.cpuCores, needRam = config.ramGb + overhead;
  const cpuBudget = host ? host.cpu.allocated + host.cpu.available : Infinity;
  const tooBig = !!host && (needCpu > cpuBudget || needRam > host.memoryGb.total);
  const fitsNow = !!host && host.queued === 0 && needCpu <= host.cpu.available && needRam <= host.memoryGb.available;
  const invalid = !environment || config.cpuCores < min.cpuCores || config.ramGb < min.ramGb || !Number.isInteger(config.cpuCores) || !Number.isInteger(config.ramGb);
  const release = resources?.releases[0];
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || invalid || tooBig || !environment) return;
    const choice: VmLaunchChoice = { environmentId: environment.id, cpuCores: config.cpuCores, ramGb: config.ramGb, runMinutes: config.runMinutes, controller: config.controller, ...(fitsNow ? {} : { queueMinutes }) };
    setBusy(true); setError('');
    try { remember(choice, config.preset); await onLaunch(choice); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '提交失败'); void onRefresh().catch(() => undefined); }
    finally { setBusy(false); }
  };
  const availability = (entry: SoftwareDescriptor) => {
    if (!host) return { text: '正在读取资源…', tone: '' };
    if (host.queued) return { text: `前面有 ${host.queued} 台在排队`, tone: 'is-queued' };
    const count = resources?.environments.find(row => row.id === entry.id)?.launchable ?? 0;
    return count ? { text: `可立即启动 ${count} 台`, tone: 'is-free' } : { text: '资源不足，需要排队', tone: 'is-queued' };
  };
  return <dialog ref={dialog} className="vm-launch-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={event => { void submit(event); }}>
      <header><div><h2 id={titleId}>添加软件环境</h2><p>加到{target}，每台虚拟机是一个标签页</p></div><button type="button" className="software-icon-button" aria-label="关闭" disabled={busy} onClick={onClose}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg></button></header>
      <p className="vm-launch-host">{host ? <>宿主机现在可用 <strong>{host.cpu.available} 核 / {host.memoryGb.available} GB</strong> · 运行 {host.running} 台 · 排队 {host.queued} 台</> : '正在读取宿主机资源…'}</p>
      <section aria-labelledby={`${titleId}-environment`}><h3 id={`${titleId}-environment`}><span>1</span>软件环境</h3>
        <div className="vm-launch-environments" role="radiogroup" aria-labelledby={`${titleId}-environment`}>{environments.map(entry => {
          const state = availability(entry), selected = entry.id === environmentId;
          return <label key={entry.id} className={`vm-launch-environment${selected ? ' is-selected' : ''}`}>
            <input type="radio" name="environment" value={entry.id} checked={selected} disabled={busy} onChange={() => chooseEnvironment(entry.id)} />
            <span className="vm-launch-environment-body"><strong>{softwareShortName(entry, entry.id)}</strong>{entry.vm!.software.length > 1 && <small>{entry.vm!.software.map(item => `${item.name} ${item.version}`).join(' · ')}</small>}<small>{entry.vm!.os.replace(/^windows(\d+)$/i, 'Windows $1')} · 最低 {entry.vm!.minSpec.cpuCores} 核 / {entry.vm!.minSpec.ramGb} GB</small></span>
            <span className={`vm-launch-availability ${state.tone}`}>{state.text}</span>
          </label>;
        })}</div>
      </section>
      <section aria-labelledby={`${titleId}-spec`}><h3 id={`${titleId}-spec`}><span>2</span>资源配置</h3>
        <div className="vm-launch-options" role="radiogroup" aria-labelledby={`${titleId}-spec`}>
          {([['standard', `标准 ${min.cpuCores} 核 / ${min.ramGb} GB`], ['boosted', `加强 ${boosted(min).cpuCores} 核 / ${boosted(min).ramGb} GB`], ['custom', '自定义']] as const).map(([preset, text]) => <label key={preset} className={config.preset === preset ? 'is-selected' : ''}><input type="radio" name="preset" checked={config.preset === preset} disabled={busy} onChange={() => choosePreset(preset)} />{text}</label>)}
        </div>
        {config.preset === 'custom' && <div className="vm-launch-custom">
          <label>CPU<input type="number" min={min.cpuCores} max={Number.isFinite(cpuBudget) ? cpuBudget : undefined} step={1} value={config.cpuCores} disabled={busy} onChange={event => setConfig(value => ({ ...value, cpuCores: Math.floor(Number(event.target.value)) }))} />核</label>
          <label>内存<input type="number" min={min.ramGb} max={host?.memoryGb.total} step={1} value={config.ramGb} disabled={busy} onChange={event => setConfig(value => ({ ...value, ramGb: Math.floor(Number(event.target.value)) }))} />GB</label>
          <small>不能低于最低配置 {min.cpuCores} 核 / {min.ramGb} GB</small>
        </div>}
        {host && <div className="vm-launch-meters">
          <Meter label="CPU" held={host.cpu.allocated} request={needCpu} total={host.cpu.allocated + host.cpu.available} unit="核" />
          <Meter label="内存" held={host.memoryGb.allocated} request={needRam} total={host.memoryGb.allocated + host.memoryGb.available} unit="GB" />
          <small>每台虚拟机另占 {overhead} GB 内存用于虚拟化。</small>
        </div>}
        {host && !invalid && <div className={`vm-launch-verdict${tooBig ? ' is-error' : fitsNow ? ' is-free' : ' is-queued'}`} role="status">
          {tooBig ? <p>超出宿主机总容量（CPU 最多 {cpuBudget} 核），即使宿主机空闲也无法创建，请减小配置。</p> : fitsNow ? <p>资源足够：提交后几秒内开始创建，首次开机通常需要 2～8 分钟。</p> : <>
            <p>需要排队，预计第 {host.queued + 1} 位：{host.queued ? `前面还有 ${host.queued} 台在排队，按提交顺序创建` : `需要 ${needCpu} 核 / ${needRam} GB，现在只有 ${host.cpu.available} 核 / ${host.memoryGb.available} GB`}。{release ? `最早 ${formatShort(release.at)} 有虚拟机到期，释放 ${release.cpuCores} 核 / ${release.ramGb} GB。` : ''}</p>
            <label>最长排队<select value={queueMinutes} disabled={busy} onChange={event => setQueueMinutes(Number(event.target.value))}>{QUEUE_OPTIONS.map(minutes => <option key={minutes} value={minutes}>{formatMinutes(minutes)}</option>)}</select>超过后自动取消</label>
          </>}
        </div>}
      </section>
      <section aria-labelledby={`${titleId}-time`}><h3 id={`${titleId}-time`}><span>3</span>运行时长</h3>
        <div className="vm-launch-options" role="radiogroup" aria-labelledby={`${titleId}-time`}>{RUN_OPTIONS.map(minutes => <label key={minutes} className={config.runMinutes === minutes ? 'is-selected' : ''}><input type="radio" name="minutes" checked={config.runMinutes === minutes} disabled={busy} onChange={() => setConfig(value => ({ ...value, runMinutes: minutes }))} />{formatMinutes(minutes)}</label>)}</div>
        <small className="vm-launch-note">{fitsNow ? `到期约 ${formatShort(Date.now() + config.runMinutes * 60000)}（本机时间）自动关机` : `从开始运行时算起，${formatMinutes(config.runMinutes)}后自动关机`}；运行中也能修改或延长。</small>
      </section>
      <footer>
        <div className="vm-launch-operator" role="radiogroup" aria-label="谁来操作"><span>谁来操作</span>
          <label className={config.controller === 'human' ? 'is-selected' : ''}><input type="radio" name="controller" checked={config.controller === 'human'} disabled={busy} onChange={() => setConfig(value => ({ ...value, controller: 'human' }))} />我来操作</label>
          <label className={config.controller === 'agent' ? 'is-selected' : ''}><input type="radio" name="controller" checked={config.controller === 'agent'} disabled={busy} onChange={() => setConfig(value => ({ ...value, controller: 'agent' }))} />交给 Agent（画面锁定）</label>
        </div>
        {error && <p className="software-warning" role="alert">{error}</p>}
        <div className="vm-launch-actions"><button type="button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="software-primary" disabled={busy || invalid || tooBig || !environment}>{busy ? '正在提交…' : fitsNow ? '启动' : '提交排队'}</button></div>
      </footer>
    </form>
  </dialog>;
}
