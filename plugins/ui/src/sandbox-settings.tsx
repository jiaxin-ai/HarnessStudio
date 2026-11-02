import { useEffect, useState } from 'react';
import { api } from './api.ts';
import { useNoSoftware } from './software-backend.ts';

interface Ceilings { cpus: number; memoryGb: number; maxRunning: number }
export interface SandboxSettingsValue {
  configured: boolean; enabled: boolean; revision: number; cpus: number; memoryGb: number; maxRunning: number; idleMinutes: number;
  service?: { ok: true; runtime: string; runtimeInstalled: boolean; imagePresent: boolean; running: number; total: number; libraries: boolean; ceilings: Ceilings; host: { cpus: number | null; memoryGb: number | null } } | { ok: false; error: string };
}
interface Form { enabled: boolean; cpus: number; memoryGb: number; maxRunning: number; idleMinutes: number }
const form = (value: SandboxSettingsValue): Form => ({ enabled: value.enabled, cpus: value.cpus, memoryGb: value.memoryGb, maxRunning: value.maxRunning, idleMinutes: value.idleMinutes });

/** Settings page section: whether Agents may use the Linux sandbox, and how much each one and all together may take. */
export function SandboxSettings() {
  const noSoftware = useNoSoftware();
  const [value, setValue] = useState<SandboxSettingsValue>(), [draft, setDraft] = useState<Form>();
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const load = (next: SandboxSettingsValue) => { setValue(next); setDraft(form(next)); };
  useEffect(() => {
    let alive = true;
    void api<SandboxSettingsValue>('sandbox').then(next => { if (alive) load(next); }, error => { if (alive) setMessage(error instanceof Error ? error.message : String(error)); });
    return () => { alive = false; };
  }, []);
  const service = value?.service, ceilings = service?.ok ? service.ceilings : undefined;
  const status = !value ? '正在读取…' : !value.configured ? '本部署没有安装沙箱服务'
    : !service?.ok ? `沙箱服务连不上${service ? `：${service.error}` : ''}`
    : !service.runtimeInstalled ? `隔离运行时 ${service.runtime} 没有安装，沙箱无法启动`
    : !service.imagePresent ? '沙箱镜像不存在，沙箱无法启动'
    : `${value.enabled ? '已开启' : '已关闭'} · 正在运行 ${service.running} 个沙箱`;
  const patch = (fields: Partial<Form>) => setDraft(previous => previous && { ...previous, ...fields });
  const number = (key: 'cpus' | 'memoryGb' | 'maxRunning' | 'idleMinutes', label: string, min: number, max: number | undefined, step: number, hint: string) =>
    <label title={hint}>{label}<input aria-label={label} type="number" required min={min} max={max} step={step} value={draft?.[key] ?? ''} onChange={event => patch({ [key]: Number(event.target.value) })} /></label>;
  return <form className="web-settings sandbox-settings" aria-label="Linux 沙箱配置" onSubmit={event => {
    event.preventDefault(); if (!value || !draft || busy) return;
    if (value.enabled && !draft.enabled && service?.ok && service.running > 0 && !window.confirm(`关闭后，正在运行的 ${service.running} 个沙箱会被立即结束（${noSoftware ? '任务文件和项目公共空间' : 'D 盘、F 盘'}里的文件不受影响）。确定关闭吗？`)) return;
    setBusy(true); setMessage('');
    void api<SandboxSettingsValue>('sandbox', { ...draft, revision: value.revision }).then(next => {
      load(next); setMessage(next.enabled ? '沙箱设置已保存。新的资源上限从每个沙箱下一次运行命令时生效。' : '沙箱已关闭，Agent 不再能使用沙箱。');
    }, error => setMessage(error instanceof Error ? error.message : '保存失败')).finally(() => setBusy(false));
  }}>
    <div className="web-settings-heading"><h3>Linux 沙箱</h3><span>{status}</span></div>
    <p>开启后，Agent 可以在一个隔离的 Linux 环境里运行命令和 Python 脚本，例如解析 PDF、转换文件、计算画图、从公网下载文件。每个对话一个沙箱：{noSoftware ? '能读写本任务的文件和项目公共空间，' : '能读写本任务的 D 盘和项目的 F 盘，'}只读查看本项目其他任务的文件和全局技能库，{noSoftware ? '不能访问局域网。' : '不能访问局域网和虚拟机。'}</p>
    <fieldset className="sandbox-settings-fields" disabled={busy || !draft || !value?.configured}>
      <label className="sandbox-settings-switch"><span><input type="checkbox" aria-label="允许 Agent 使用 Linux 沙箱" checked={draft?.enabled ?? false} onChange={event => patch({ enabled: event.target.checked })} />允许 Agent 使用 Linux 沙箱</span></label>
      {number('cpus', '每个沙箱的 CPU 核数', 0.5, ceilings?.cpus, 0.5, '一个沙箱最多用多少个 CPU 核')}
      {number('memoryGb', '每个沙箱的内存（GB）', 1, ceilings ? Math.max(1, Math.floor(ceilings.memoryGb)) : undefined, 1, '超过后沙箱里的程序会被结束')}
      {number('maxRunning', '最多同时运行的沙箱数', 1, ceilings?.maxRunning, 1, '达到上限后，新的对话要等其他沙箱闲置回收后才能使用')}
      {number('idleMinutes', '闲置多久后回收（分钟）', 1, 1440, 1, noSoftware ? '沙箱这么久没有运行命令就会被停止；文件留在任务文件和项目公共空间，装过的软件包要重新安装' : '沙箱这么久没有运行命令就会被停止；文件留在 D 盘、F 盘，装过的软件包要重新安装')}
      <button type="submit">保存沙箱设置</button>
    </fieldset>
    <small>{ceilings ? `本机允许的最大值：每个沙箱 ${ceilings.cpus} 核、${ceilings.memoryGb} GB，同时 ${ceilings.maxRunning} 个。` : ''}改动保存后立即生效；正在运行的沙箱在下一次运行命令时按新的上限重新启动。</small>
    {message && <div className="model-status" role="status">{message}</div>}
  </form>;
}
