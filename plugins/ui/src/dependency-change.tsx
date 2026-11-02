import { useEffect, useId, useRef, useState } from 'react';
import { currentStateNames, type DependencyChangePreview } from '@harnessstudio/studio/domain-types';
import { api } from './api.ts';

export function dependencyChangePayload(preview: DependencyChangePreview) {
  const { kind: _kind, ...request } = preview.request;
  return { ...request, projectRevision: preview.projectRevision, confirmImpact: true, impactVersion: preview.impactVersion };
}

export function dependencyChangeEndpoint(preview: DependencyChangePreview) {
  return preview.request.kind === 'set' ? 'dependencies' : 'dependencies/reconnect';
}

/** The controlled graph retains its old edges until this human confirmation succeeds. */
export function DependencyChangeDialog({ preview, taskNames, onClose, onBusyChange, onApplied }: {
  preview: DependencyChangePreview; taskNames: ReadonlyMap<string, string>; onClose(): void;
  onBusyChange(busy: boolean): void; onApplied(): Promise<void>;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [applied, setApplied] = useState(false);
  const titleId = useId(), descriptionId = useId();
  const form = useRef<HTMLFormElement>(null), cancel = useRef<HTMLButtonElement>(null), alive = useRef(true);
  useEffect(() => {
    alive.current = true; const previous = document.activeElement; cancel.current?.focus();
    return () => { alive.current = false; if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const names = currentStateNames('single-user');
  const reviews = preview.affected.filter(row => row.willRecheck && row.state === 'completed').length;
  const remainingReviews = preview.affected.filter(row => row.state === 'recheck').length;
  const resets = preview.affected.filter(row => row.willResetWork).length;
  const connectionName = (id: string) => taskNames.get(id) ?? (id.startsWith('graph-start:') ? '开始' : id.startsWith('graph-end:') ? '结束' : id);
  const requested = preview.request;
  const confirm = async () => {
    if (busy) return;
    let didApply = applied;
    setBusy(true); onBusyChange(true); setError('');
    try {
      if (!applied) {
        await api(dependencyChangeEndpoint(preview), dependencyChangePayload(preview));
        didApply = true;
        if (alive.current) setApplied(true);
      }
      await onApplied();
    } catch (error) {
      if (alive.current) setError(`${error instanceof Error ? error.message : '依赖调整未完成'}。${didApply ? '变更已提交，请重新加载页面。' : '请取消并重新调整连线，查看最新影响范围后再次确认；若操作未完成，可从任务信息中重试。'}`);
    } finally { if (alive.current) setBusy(false); onBusyChange(false); }
  };
  return <div className="studio-dialog dependency-change-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); if (!busy) onClose(); }
    if (event.key !== 'Tab') return;
    const items = [...form.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]') ?? []];
    const first = items[0], last = items.at(-1);
    if (!first || !last) { event.preventDefault(); return; }
    if (event.shiftKey && (document.activeElement === first || !items.includes(document.activeElement as HTMLElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !items.includes(document.activeElement as HTMLElement))) { event.preventDefault(); first.focus(); }
  }}>
    <form ref={form} aria-busy={busy} onSubmit={event => { event.preventDefault(); void confirm(); }}>
      <header><span className="dependency-change-symbol" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="2.5" /><circle cx="18.5" cy="5" r="2.5" /><circle cx="18.5" cy="19" r="2.5" /><path d="M7.5 12H12V5h4M12 12v7h4" /></svg></span><div><h2 id={titleId}>{preview.retry ? '继续调整任务依赖？' : '调整依赖并重新复核？'}</h2><p>这次调整会影响已有工作结果。</p></div></header>
      <div className="dependency-change-request">{requested.kind === 'reconnect' ? <><small>新连接</small><strong>{connectionName(requested.connection.source)} <span aria-hidden="true">→</span> {connectionName(requested.connection.target)}</strong></> : <><small>{connectionName(requested.id)} 的前序任务</small><strong>{requested.dependencies.length ? requested.dependencies.map(connectionName).join('、') : '无前序任务'}</strong></>}</div>
      <p id={descriptionId} className="dependency-change-description">{reviews > 0 ? <>{reviews} 个已完成任务将进入「待复核」。</> : '关联任务的输入依据将发生变化。'}{remainingReviews > 0 && <> {remainingReviews} 个待复核任务仍须重新检查。</>}{resets > 0 && <> {resets} 个进行中任务将回到待执行，以重新绑定前序结果。</>}工作区文件和旧结果快照会保留。</p>
      <section className="dependency-change-impact" aria-label="依赖调整影响范围"><div><h3>受影响任务</h3><small>{preview.affected.length} 个</small></div><ul tabIndex={0} aria-label="受影响任务列表">{preview.affected.map(row => <li key={row.id}><div><code>{row.code}</code><strong>{row.title}</strong><small>{row.reason === 'summary' ? '上级任务组' : '依赖链任务'}</small></div><span className={row.willRecheck ? 'will-recheck' : undefined}>{names[row.state as keyof typeof names] ?? row.state}{row.willRecheck ? ' → 待复核' : row.willResetWork ? ' → 待执行' : ''}</span><p>{row.description}</p></li>)}</ul></section>
      <p className="dependency-change-note">确认后，请先完成前序任务，再沿依赖链逐项检查 Checklist、总体目标与工作文件。每个待复核任务都需要你单独确认完成。</p>
      {preview.retry && <p className="dependency-change-error">上次调整尚未完成，相关节点保持冻结。确认后将继续原有变更。</p>}
      {error && <p className="dependency-change-error" role="status">{error}</p>}
      <footer><button ref={cancel} type="button" disabled={busy} onClick={onClose}>取消</button><button className="dependency-change-confirm" type="submit" disabled={busy || !!error && !applied}>{busy ? '正在调整…' : applied ? '重新加载任务' : '确认调整依赖'}</button></footer>
    </form>
  </div>;
}
