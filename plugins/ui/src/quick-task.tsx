import { useEffect, useRef, useState } from 'react';
import type { TaskView } from '@harnessstudio/studio/domain-types';
import { api } from './api.ts';

export interface NewTaskContext { parentId?: string; predecessorId?: string }
export function QuickTaskDialog({ projectId, context, onClose, onSaved }: {
  projectId: string; context: NewTaskContext; onClose(): void; onSaved(task: TaskView): Promise<void>;
}) {
  const [title, setTitle] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    input.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return <div className="studio-dialog quick-task-dialog" role="dialog" aria-modal="true" aria-labelledby="quick-task-title" onKeyDown={event => { if (event.key === 'Escape' && !busy) onClose(); }}>
    <form onSubmit={event => {
      event.preventDefault(); setBusy(true); setError('');
      void (async () => {
        try { const task = await api<TaskView>('task/quick', { projectId, ...context, title: title.trim() }); await onSaved(task); onClose(); }
        catch (error) { setError(error instanceof Error ? error.message : '创建失败'); }
        finally { setBusy(false); }
      })();
    }}>
      <h2 id="quick-task-title">添加新任务</h2>
      <p>给任务起个名字，也可以进入对话后再完善。</p>
      <fieldset disabled={busy}>
        <label>任务名称（可选）<input ref={input} aria-label="任务名称（可选）" maxLength={160} value={title} placeholder="例如：设计一个齿轮" onChange={event => setTitle(event.target.value)} /></label>
        <small>留空时自动命名为“任务 + 编号”。</small>
        <div role="status">{error}</div>
        <div className="quick-task-actions"><button type="button" onClick={onClose}>取消</button><button type="submit">{busy ? '正在创建…' : '创建任务'}</button></div>
      </fieldset>
    </form>
  </div>;
}
