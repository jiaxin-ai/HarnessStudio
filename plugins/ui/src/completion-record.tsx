import { useId, useState } from 'react';
import type { HumanCompletionConfirmation } from '@harnessstudio/studio/domain-types';

const confirmedTime = (value: string) => Number.isNaN(Date.parse(value)) ? value : new Date(value).toLocaleString('zh-CN', { hour12: false });

/** An Agent's evidence for one goal. Long text starts folded so a record with many goals stays readable. */
export function CompletionEvidence({ text }: { text: string }) {
  const [open, setOpen] = useState(false), id = useId(), long = text.length > 160 || text.split('\n').length > 3;
  return <div className={`completion-evidence${long && !open ? ' is-folded' : ''}`}>
    <span className="completion-evidence-label">Agent 的检查依据</span>
    <p id={id}>{text}</p>
    {long && <button type="button" className="completion-evidence-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>{open ? '收起' : '展开全部'}</button>}
  </div>;
}

/** Who confirmed a completion and which goals; an Agent's record also names its model and shows the evidence of every goal. */
export function CompletionConfirmationRecord({ confirmation }: { confirmation: HumanCompletionConfirmation }) {
  const agent = confirmation.actor === 'agent';
  return <div className={`completion-acknowledgements${agent ? ' is-agent' : ''}`} aria-label="已确认的任务目标">
    <small className="completion-confirmer">{agent ? <><span className="completion-actor-tag">由 Agent 确认</span>{confirmation.agent && <> · 模型 {confirmation.agent.model}</>} · {confirmedTime(confirmation.confirmedAt)}</> : <>由你确认 · {confirmedTime(confirmation.confirmedAt)}</>}</small>
    <ul>{confirmation.goals.filter(goal => goal.checked !== false).map(goal => <li key={goal.id}><span aria-hidden="true">✓</span>{goal.evidence ? <div>{goal.label}<CompletionEvidence text={goal.evidence} /></div> : goal.label}</li>)}</ul>
    {confirmation.withoutSubmittedFiles && <p className="completion-no-files-record">{agent ? 'Agent 已明确确认：无提交文件完成。' : '用户已二次确认：无提交文件完成。'}</p>}
  </div>;
}
