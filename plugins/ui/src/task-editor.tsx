import { useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import { randomId } from './random-id.ts';
import type { ChecklistItem, TaskView } from '@harnessstudio/studio/domain-types';

export function TaskEditor({ initial, onSaved, onClose }: {
  initial: TaskView; onSaved(task: TaskView): Promise<void>; onClose(): void;
}) {
  const [title, setTitle] = useState(initial.title), [goal, setGoal] = useState(initial.goal);
  const [checklist, setChecklist] = useState<ChecklistItem[]>(initial.checklist ?? []);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const form = useRef<HTMLFormElement>(null), name = useRef<HTMLInputElement>(null), alive = useRef(true);
  useEffect(() => {
    alive.current = true; const previous = document.activeElement; name.current?.focus();
    return () => { alive.current = false; if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const add = () => setChecklist(previous => [...previous, { id: `ck-${randomId()}`, text: '' }]);
  return <div className="studio-dialog task-metadata-dialog" role="dialog" aria-modal="true" aria-labelledby="task-metadata-editor-title" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); if (!busy) onClose(); }
    if (event.key !== 'Tab') return;
    const controls = [...form.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled)') ?? []];
    const first = controls[0], last = controls[controls.length - 1];
    if (!first || !last) { event.preventDefault(); return; }
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }}><form ref={form} onSubmit={event => {
    event.preventDefault(); if (busy) return; setBusy(true); setError('');
    void (async () => {
      try {
        const task = await api<TaskView>('task/metadata', { id: initial.id, revision: initial.revision, title: title.trim(), goal: goal.trim(), checklist: checklist.filter(row => row.text.trim()).map(row => ({ ...(initial.checklist.some(item => item.id === row.id) ? { id: row.id } : {}), text: row.text.trim() })) });
        await onSaved(task); onClose();
      } catch (error) { if (alive.current) setError(error instanceof Error ? error.message : '保存失败'); }
      finally { if (alive.current) setBusy(false); }
    })();
  }}><header><div><h2 id="task-metadata-editor-title">编辑任务定义</h2><p><code>{initial.code}</code> 用清楚的描述和验收要求定义这个任务。</p></div></header>
    <fieldset disabled={busy}>
      <label>任务名称<input ref={name} aria-label="任务名称" maxLength={160} required value={title} onChange={event => setTitle(event.target.value)} /></label>
      <label>任务描述与目标<span className="metadata-optional">可选 · 在该任务的所有对话中共享</span><textarea aria-label="任务描述与目标" maxLength={8000} value={goal} placeholder="描述要做什么、为什么做，以及需要注意的边界。" onChange={event => setGoal(event.target.value)} /></label>
      <section className="checklist-editor" aria-label="Checklist"><div className="checklist-editor-heading"><h3>Checklist</h3><small>用文字列出验收要求</small></div>
        <div className="checklist-editor-rows">{checklist.map((row, index) => <div key={row.id} className="checklist-editor-row"><span className="checklist-item-dot" aria-hidden="true" /><input aria-label={`验收要求 ${index + 1}`} maxLength={2000} value={row.text} placeholder="例如：齿轮模型尺寸与方案记录一致" onChange={event => setChecklist(previous => previous.map(item => item.id === row.id ? { ...item, text: event.target.value } : item))} /><button type="button" aria-label={`删除验收要求 ${index + 1}`} title="移除此要求" onClick={() => { setChecklist(previous => previous.filter(item => item.id !== row.id)); name.current?.focus(); }}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" /></svg></button></div>)}</div>
        {!checklist.length && <p className="checklist-editor-empty">暂时没有验收要求，可以稍后补充。</p>}
        <button className="checklist-add" type="button" disabled={checklist.length >= 100} onClick={add}>＋ 添加要求</button>
      </section>
    </fieldset>
    {error && <p className="metadata-editor-error" role="status">{error}</p>}
    <footer><button type="button" disabled={busy} onClick={onClose}>取消</button><button className="metadata-save" type="submit" disabled={busy || !title.trim()}>{busy ? '正在保存…' : '保存任务'}</button></footer>
  </form></div>;
}
