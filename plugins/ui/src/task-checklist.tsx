import { useEffect, useId, useRef } from 'react';
import { resultSnapshotId, type CompletionGoal, type TaskView, type SnapshotManifestView } from '@harnessstudio/studio/domain-types';
import { CompletionEvidence } from './completion-record.tsx';

/** Only the current valid result may supply confirmations; older snapshots are history. */
export function confirmedChecklistGoals(task: TaskView, manifest?: SnapshotManifestView): Map<string, CompletionGoal> {
  const confirmed = new Map<string, CompletionGoal>(), currentId = resultSnapshotId(task, task.workflowMode);
  if (!currentId || task.blockers.length || !manifest || manifest.unavailableRefs.length) return confirmed;
  const snapshot = manifest.snapshot;
  if (snapshot.id !== currentId || snapshot.taskId !== task.id || !snapshot.humanConfirmation) return confirmed;
  for (const row of task.checklist) {
    const goalId = snapshot.definition.checklist === undefined && row.id.startsWith('legacy-')
      ? `criterion:${row.id.slice(7)}` : `checklist:${row.id}`;
    const goal = snapshot.humanConfirmation.goals.find(goal => goal.id === goalId && goal.label === row.text && !goal.system && goal.checked !== false);
    if (goal) confirmed.set(row.id, goal);
  }
  return confirmed;
}

/** The full dialog also shows an Agent's evidence under each row it confirmed. */
export function TaskChecklistList({ task, manifest, evidence = false }: { task: TaskView; manifest?: SnapshotManifestView; evidence?: boolean }) {
  const confirmed = confirmedChecklistGoals(task, manifest), byAgent = manifest?.snapshot.humanConfirmation?.actor === 'agent';
  return <ul className="task-metadata-checklist">{task.checklist.map(row => {
    const goal = confirmed.get(row.id), checked = !!goal, agent = checked && byAgent;
    return <li key={row.id}><span className={`checklist-item-dot${checked ? ' is-checked' : ''}${agent ? ' is-agent' : ''}`} role="checkbox" aria-checked={checked} aria-readonly="true" aria-label={agent ? `${row.text}（由 Agent 确认）` : row.text} title={agent ? '由 Agent 确认' : undefined}>{checked && <svg viewBox="0 0 12 12" aria-hidden="true"><path d="m2.3 6 2.4 2.4 5-5" /></svg>}</span>{evidence && goal?.evidence ? <div className="task-checklist-text">{row.text}<CompletionEvidence text={goal.evidence} /></div> : <span className="task-checklist-text">{row.text}</span>}</li>;
  })}</ul>;
}

/** Read-only full view, including when a task's results are frozen. */
export function TaskChecklistDialog({ task, manifest, onClose }: { task: TaskView; manifest?: SnapshotManifestView; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null), titleId = useId();
  useEffect(() => {
    const element = dialog.current, previous = document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return <dialog ref={dialog} className="task-checklist-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><div><h2 id={titleId}>全部 Checklist（{task.checklist.length} 项）</h2><p><code>{task.code}</code> {task.title}</p></div><button type="button" aria-label="关闭完整 Checklist" onClick={onClose}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" /></svg></button></header>
    <div className="task-checklist-dialog-body" tabIndex={0}><TaskChecklistList task={task} manifest={manifest} evidence /></div>
  </dialog>;
}
