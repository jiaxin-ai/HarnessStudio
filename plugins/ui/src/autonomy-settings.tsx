import { useEffect, useState } from 'react';
import { api } from './api.ts';
import { BudgetInputs } from './autonomy.tsx';
import { budgetOf, fromBudgetForm, toBudgetForm, type AutonomyBudget, type AutonomySettings } from './autonomy-model.ts';

interface Saved { settings: AutonomySettings; revision: number }

/** Settings page section: the budget every new autonomy run starts with. Models are chosen when a run starts. */
export function AutonomySettingsSection() {
  const [value, setValue] = useState<Saved>(), [draft, setDraft] = useState<Record<keyof AutonomyBudget, string>>();
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const load = (next: Saved) => { setValue(next); setDraft(toBudgetForm(budgetOf(next.settings))); };
  const read = () => api<Saved>('autonomy/settings').then(next => { load(next); return next; });
  useEffect(() => {
    let alive = true;
    void api<Saved>('autonomy/settings').then(next => { if (alive) load(next); }, error => { if (alive) setMessage(`读不到自主模式默认值：${error instanceof Error ? error.message : String(error)}`); });
    return () => { alive = false; };
  }, []);
  return <form className="web-settings autonomy-settings" aria-label="自主模式默认值" onSubmit={event => {
    event.preventDefault(); if (!value || !draft || busy) return;
    const parsed = fromBudgetForm(draft);
    if ('error' in parsed) { setMessage(parsed.error); return; }
    setBusy(true); setMessage('');
    void api<Saved>('autonomy/settings', { revision: value.revision, settings: parsed.budget }).then(next => {
      load(next); setMessage('已保存。以后启动的自主运行按这些默认值预填；正在进行的运行不受影响，可以在它的运行面板里单独修改。');
    }, error => {
      // Another page may have saved first (revision check); the person rereads and redoes the change on top of it.
      setMessage(`${error instanceof Error ? error.message : '保存失败'}。如果是别的页面刚改过，请点「重新读取」后再改。`);
    }).finally(() => setBusy(false));
  }}>
    <div className="web-settings-heading"><h3>自主模式默认值</h3><span>{value ? '' : '正在读取…'}</span></div>
    <p>每次启动自主运行时，预算会先填上这里的值，启动时还可以再改。任何一项用完，运行会暂停，等你调高后继续或停止。模型在启动时选择。</p>
    <fieldset className="autonomy-settings-fields" disabled={busy || !draft}>{draft && <BudgetInputs form={draft} onChange={setDraft} />}</fieldset>
    <div className="autonomy-actions"><button type="submit" disabled={busy || !draft}>保存默认值</button><button type="button" disabled={busy} onClick={() => { setMessage(''); void read().then(() => setMessage('已重新读取。'), error => setMessage(error instanceof Error ? error.message : '读取失败')); }}>重新读取</button></div>
    {message && <div className="model-status" role="status">{message}</div>}
  </form>;
}
