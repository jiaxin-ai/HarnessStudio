import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import type { Project, ProjectDeleteResult } from '@harnessstudio/studio/domain-types';
import { api } from './api.ts';
import { useNoSoftware } from './software-backend.ts';

function restoreProjectFocus(projectId: string) {
  requestAnimationFrame(() => {
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('.sidebar-project-name[data-project-id]')];
    (buttons.find(button => button.dataset.projectId === projectId) ?? buttons.find(button => button.getAttribute('aria-current') === 'page') ?? buttons[0])?.focus({ preventScroll: true });
  });
}

function trapTab(event: KeyboardEvent<HTMLDivElement>, form: RefObject<HTMLFormElement>) {
  if (event.key !== 'Tab') return;
  const items = [...form.current?.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)') ?? []];
  if (!items.length) { event.preventDefault(); return; }
  const first = items[0]!, last = items[items.length - 1]!;
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

export function ProjectRenameDialog({ project, onClose, onRenamed }: { project: Project; onClose(): void; onRenamed(project: Project): Promise<void> }) {
  const [title, setTitle] = useState(project.title), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null), form = useRef<HTMLFormElement>(null), alive = useRef(true);
  useEffect(() => {
    alive.current = true; input.current?.focus(); input.current?.select();
    return () => { alive.current = false; restoreProjectFocus(project.id); };
  }, [project.id]);
  const value = title.trim(), changed = value !== project.title;
  return <div className="studio-dialog project-action-dialog project-rename-dialog" role="dialog" aria-modal="true" aria-labelledby="project-rename-title" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); if (!busy) onClose(); return; }
    trapTab(event, form);
  }}>
    <form ref={form} onSubmit={event => {
      event.preventDefault(); if (!value || !changed || busy) return;
      setBusy(true); setError('');
      void (async () => {
        try { await onRenamed(await api<Project>('project/rename', { id: project.id, revision: project.revision, title: value })); }
        catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : '项目重命名失败'); }
        finally { if (alive.current) setBusy(false); }
      })();
    }}>
      <h2 id="project-rename-title">重命名项目</h2>
      <p>修改后的名称会显示在项目侧栏和项目工作区中。</p>
      <fieldset disabled={busy}><label>项目名称<input ref={input} required maxLength={8000} value={title} onChange={event => setTitle(event.target.value)} /></label>
        {error && <div role="status">{error}</div>}
        <footer><button type="button" onClick={onClose}>取消</button><button className="project-action-primary" type="submit" disabled={!value || !changed}>{busy ? '正在保存…' : '保存名称'}</button></footer>
      </fieldset>
    </form>
  </div>;
}

export function ProjectDeleteDialog({ project, onClose, onDeleted }: { project: Project; onClose(): void; onDeleted(result: ProjectDeleteResult): Promise<void> }) {
  const [confirmationTitle, setConfirmationTitle] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null), form = useRef<HTMLFormElement>(null), alive = useRef(true);
  useEffect(() => {
    alive.current = true; input.current?.focus();
    return () => { alive.current = false; restoreProjectFocus(project.id); };
  }, [project.id]);
  const confirmed = confirmationTitle === project.title;
  return <div className="studio-dialog project-action-dialog project-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="project-delete-title" aria-describedby="project-delete-description" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); if (!busy) onClose(); return; }
    trapTab(event, form);
  }}>
    <form ref={form} onSubmit={event => {
      event.preventDefault(); if (!confirmed || busy) return;
      setBusy(true); setError('');
      void (async () => {
        try { await onDeleted(await api<ProjectDeleteResult>('project/delete', { id: project.id, revision: project.revision, confirmationTitle })); }
        catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : '项目删除失败'); }
        finally { if (alive.current) setBusy(false); }
      })();
    }}>
      <header><span className="project-delete-symbol" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13M10 10v7M14 10v7" /></svg></span><div><h2 id="project-delete-title">删除项目？</h2><p>此操作无法撤销。</p></div></header>
      <div className="project-delete-target"><span>项目</span><strong>{project.title}</strong></div>
      <p id="project-delete-description" className="project-delete-warning">将永久删除该项目中的全部任务、工作文件、对话、临时文件、结果快照和相关历史。请先自行保存需要保留的内容。</p>
      <fieldset disabled={busy}><label>请输入项目名称 <strong>{project.title}</strong> 以确认删除<input ref={input} autoComplete="off" spellCheck={false} value={confirmationTitle} onChange={event => setConfirmationTitle(event.target.value)} /></label>
        {confirmationTitle && !confirmed && <small>输入内容必须与当前项目名称完全一致。</small>}
        {error && <div role="status">{error}</div>}
        <footer><button type="button" onClick={onClose}>取消</button><button className="project-delete-confirm" type="submit" disabled={!confirmed}>{busy ? '正在删除…' : '永久删除项目'}</button></footer>
      </fieldset>
    </form>
  </div>;
}

interface ExportJob { id: string; directory: string; state: 'running' | 'done' | 'failed'; files: number; bytes: number; error?: string }
const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
/** The project as a tree (project → tasks → subtasks) with conversations, page and Agent actions, VM trajectories
 * and timeline/timeline.jsonl. A ZIP is streamed to the browser; a server export runs in the background. */
export function ProjectExportDialog({ projectId, title, onClose }: { projectId: string; title: string; onClose(): void }) {
  const [video, setVideo] = useState(false), [snapshots, setSnapshots] = useState(true), [workspace, setWorkspace] = useState(false);
  // The shared folder follows the task files until the person decides otherwise (the server does the same when shared is not sent).
  const [sharedChoice, setSharedChoice] = useState<boolean>(), shared = sharedChoice ?? workspace;
  // Without software there are no VM recordings, screen videos or drive letters to offer.
  const noSoftware = useNoSoftware();
  const [job, setJob] = useState<ExportJob>(), [error, setError] = useState(''), [started, setStarted] = useState(false);
  const form = useRef<HTMLFormElement>(null), alive = useRef(true);
  useEffect(() => { alive.current = true; form.current?.querySelector<HTMLButtonElement>('button[type="submit"]')?.focus(); return () => { alive.current = false; restoreProjectFocus(projectId); }; }, []);
  useEffect(() => {
    if (job?.state !== 'running') return;
    const timer = setInterval(() => { void api<ExportJob>(`project/export/disk?${new URLSearchParams({ jobId: job.id })}`).then(value => { if (alive.current) setJob(value); }, reason => { if (alive.current) setError(reason instanceof Error ? reason.message : '读取导出进度失败'); }); }, 2000);
    return () => clearInterval(timer);
  }, [job?.id, job?.state]);
  const flags = { video: video ? '1' : '0', snapshots: snapshots ? '1' : '0', workspace: workspace ? '1' : '0', shared: shared ? '1' : '0' };
  const download = () => {
    const link = document.createElement('a');
    link.href = `/api/studio/project/export?${new URLSearchParams({ projectId, ...flags })}`; link.download = '';
    document.body.append(link); link.click(); link.remove(); setStarted(true);
  };
  const toServer = async () => {
    setError('');
    try { setJob(await api<ExportJob>('project/export/disk', { projectId, video, snapshots, workspace, shared })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '导出失败'); }
  };
  const running = job?.state === 'running';
  return <div className="studio-dialog project-action-dialog project-export-dialog" role="dialog" aria-modal="true" aria-labelledby="project-export-title" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
    trapTab(event, form);
  }}>
    <form ref={form} onSubmit={event => { event.preventDefault(); download(); }}>
      <header><div><h2 id="project-export-title">导出项目轨迹</h2><p>按“项目 → 任务 → 子任务”的树形结构导出 {title}：任务信息、对话、网页上的操作、Agent 的操作{noSoftware ? '' : '、虚拟机里录制的轨迹'}，并在 timeline/timeline.jsonl 中按时间串成一条（UTC）。</p></div></header>
      <fieldset disabled={running}>
        {!noSoftware && <label className="export-option"><input type="checkbox" checked={video} onChange={event => setVideo(event.target.checked)} /><span>包含屏幕录像<small>虚拟机采集时录下的整段屏幕视频，体积很大。不勾选也会有每一步的截图和操作记录。</small></span></label>}
        <label className="export-option"><input type="checkbox" checked={snapshots} onChange={event => setSnapshots(event.target.checked)} /><span>包含任务完成时的快照文件<small>点“完成”时确认并冻结保存的成果文件，也就是交付的版本。</small></span></label>
        <label className="export-option"><input type="checkbox" checked={workspace} onChange={event => setWorkspace(event.target.checked)} /><span>{noSoftware ? '包含任务当前的文件' : '包含任务当前的 D 盘文件'}<small>{noSoftware ? '每个任务工作区' : '每个任务工作区（D 盘）'}现在的全部文件，包括没完成的任务和没提交的中间文件。</small></span></label>
        <label className="export-option"><input type="checkbox" checked={shared} onChange={event => setSharedChoice(event.target.checked)} /><span>{noSoftware ? '包含项目公共空间的文件' : '包含项目共享盘（F 盘）的文件'}<small>项目共享盘里现在的全部文件，包括批量任务清单上传的输入文件。默认跟随上一项。</small></span></label>
      </fieldset>
      {started && !job && <p className="export-status">已开始下载。项目较大时，浏览器会边生成边下载，请等下载完成。</p>}
      {job && <p className="export-status" role="status">{job.state === 'running' ? `正在导出到服务器：已写入 ${job.files} 个文件，${megabytes(job.bytes)}` : job.state === 'done' ? <>已导出到服务器目录（{job.files} 个文件，{megabytes(job.bytes)}）：<code>{job.directory}</code></> : `导出失败：${job.error ?? ''}`}</p>}
      {error && <div role="status">{error}</div>}
      <footer><button type="button" onClick={onClose}>{job?.state === 'done' || started ? '关闭' : '取消'}</button><button type="button" disabled={running} onClick={() => { void toServer(); }} title="在宿主机上生成完整的导出目录，适合包含录像的大项目">导出到服务器目录</button><button type="submit" disabled={running}>下载 ZIP</button></footer>
    </form>
  </div>;
}
