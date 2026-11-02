import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { stateNames, type SingleUserTaskState, type TaskClearPreview, type TaskClearResult, type TaskView } from '@harnessstudio/studio/domain-types';
import { api } from './api.ts';
import { useNoSoftware } from './software-backend.ts';
import { useVmStorage } from './vm-panel.tsx';

export function TaskClearDialog({ task, onClose, onBusyChange, onCleared }: {
  task: TaskView; onClose(): void; onBusyChange(busy: boolean): void; onCleared(result: TaskClearResult): Promise<void>;
}) {
  const [preview, setPreview] = useState<TaskClearPreview>(), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const cancel = useRef<HTMLButtonElement>(null), form = useRef<HTMLFormElement>(null), alive = useRef(true), request = useRef(0), id = useId();
  const vmStorage = useVmStorage(task.projectId), noSoftware = useNoSoftware();
  const loadPreview = useCallback(async (notice = '') => {
    const sequence = ++request.current; setPreview(undefined); setLoading(true); setError(notice);
    try {
      const value = await api<TaskClearPreview>(`task/clear-preview?id=${encodeURIComponent(task.id)}`);
      if (alive.current && request.current === sequence) setPreview(value);
    } catch (error) {
      if (alive.current && request.current === sequence) setError([notice, error instanceof Error ? error.message : '无法读取清空影响范围'].filter(Boolean).join('；'));
    } finally { if (alive.current && request.current === sequence) setLoading(false); }
  }, [task.id]);
  useEffect(() => {
    alive.current = true; const previous = document.activeElement; cancel.current?.focus(); void loadPreview();
    return () => { alive.current = false; request.current++; if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [loadPreview]);
  return <div className="studio-dialog task-delete-dialog task-clear-dialog" role="alertdialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); if (!busy) onClose(); }
    if (event.key !== 'Tab') return;
    const items = [...form.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []];
    if (!items.length) { event.preventDefault(); return; }
    const first = items[0]!, last = items[items.length - 1]!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }}>
    <form ref={form} onSubmit={event => {
      event.preventDefault(); if (!preview || busy || loading) return;
      const confirmed = preview; setBusy(true); onBusyChange(true); setError('');
      void (async () => {
        try {
          const result = await api<TaskClearResult>('task/clear', { id: confirmed.taskId, revision: confirmed.taskRevision, projectRevision: confirmed.projectRevision, confirm: true });
          await onCleared(result);
        } catch (error) {
          if (alive.current) await loadPreview(`${error instanceof Error ? error.message : '清空未完成'}。请查看最新影响范围，再次确认后重试。`);
        } finally { if (alive.current) setBusy(false); onBusyChange(false); }
      })();
    }}>
      <header><span className="task-delete-symbol" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 9a8 8 0 1 1-1 6M5 4v5h5M9 12h6M12 9v6" /></svg></span><div><h2 id={`${id}-title`}>{preview?.retry ? '重新确认清空进展' : '清空这个任务的进展？'}</h2><p>任务定义与图谱保留，工作资料永久清除。</p></div></header>
      <div className="task-delete-target"><code>{preview?.code ?? task.code}</code><strong>{preview?.title ?? task.title}</strong><small>{stateNames[(preview?.state ?? task.state) as SingleUserTaskState]}</small></div>
      <p id={`${id}-description`} className="task-delete-warning">将永久清除本节点的工作文件、已提交文件、全部对话与附件、结果快照{noSoftware ? '' : '和软件实例'}，无法恢复。请先自行保存需要的内容，包括未保存的草稿。</p>
      <p className="task-clear-preserved">任务名称、描述、Checklist、编号和图谱关系保留，清空后回到待执行。</p>
      {vmStorage && <p className="task-clear-preserved">本任务的虚拟机会被删除；虚拟机平台上的任务文件（D 盘）不会被删除，冻结的 D 盘会恢复可写。</p>}
      {loading ? <p role="status">正在检查清空影响范围…</p> : preview && <>
        {!!preview.childCount && <p className="task-clear-children">包含 {preview.childCount} 个直属子节点。本次只清空当前任务组自身资料，子节点及其工作资料保留。清理期间会停止子节点正在执行的操作，之后不会自动续跑。</p>}
        <div className="task-delete-counts"><span>结果快照 <b>{preview.snapshotCount}</b></span><span>复核记录 <b>{preview.reviewCount}</b></span></div>
        {!!preview.affected.length && <section className="task-delete-impact" aria-label="受影响任务"><strong>{preview.affected.length} 个关联任务会受到影响</strong><p>关联任务会暂停执行，已完成节点进入待复核；它们的工作文件和旧快照保留。</p><ul>{preview.affected.slice(0, 6).map(row => <li key={row.id}><code>{row.code}</code><span>{row.title}</span><small>{row.reason === 'dependency' ? '依赖受影响' : '目录汇总'}</small></li>)}</ul>{preview.affected.length > 6 && <small>另有 {preview.affected.length - 6} 个关联任务。</small>}</section>}
        {preview.retry && <p className="task-delete-warning">上次清空尚未完成，相关节点保持冻结。确认后将继续清理剩余数据。</p>}
      </>}
      {error && <p role="status">{error}</p>}
      <footer><button ref={cancel} type="button" disabled={busy} onClick={onClose}>取消</button>{!loading && !preview && <button type="button" disabled={busy} onClick={() => { void loadPreview(); }}>刷新清空预览</button>}<button className="task-delete-confirm" type="submit" disabled={busy || loading || !preview}>{busy ? '正在清空…' : preview?.retry ? '确认继续清空' : '确认清空进展'}</button></footer>
    </form>
  </div>;
}
