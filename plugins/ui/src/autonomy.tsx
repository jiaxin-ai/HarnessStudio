import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { TaskView } from '@harnessstudio/studio/domain-types';
import { api } from './api.ts';
import { useNoSoftware } from './software-backend.ts';
import type { ModelChoice } from './chat.tsx';
import { useVmStorage } from './vm-panel.tsx';
import {
  attentionChatLabel, attentionChoices, attentionLabel, budgetFields, budgetOf, canPause, canResume, defaultBudget, formatAgo, formatDuration, fromBudgetForm, isOpenRun,
  latestRuns, reportKindLabel, runStateDetail, runStateLabel, runTone, summaryOf, toBudgetForm, unfinishedInScope, usageRows, visibleBudgetFields, workerStateLabel,
  type AttentionAction, type AttentionChoice, type AutonomyBudget, type AutonomySettings, type ModelRef, type RunAttention, type RunDetail, type RunSummary,
} from './autonomy-model.ts';

const POLL_RUN_MS = 2000, POLL_RUNS_MS = 5000;

/** Poll while the page is visible, like the status poll in client.tsx; `poll` returns false to stop until the page is shown again. */
function startVisiblePoll(poll: (signal: AbortSignal) => Promise<boolean>, intervalMs: number): () => void {
  let alive = true, timer: ReturnType<typeof setTimeout> | undefined, controller: AbortController | undefined;
  const tick = async () => {
    if (!alive || document.hidden || controller) return;
    controller = new AbortController(); const current = controller, timeout = setTimeout(() => current.abort(), 5000);
    let again = true;
    try { again = await poll(current.signal); } catch { /* A transient transport error keeps the last observed run. */ }
    finally {
      clearTimeout(timeout); if (controller === current) controller = undefined;
      if (alive && again && !document.hidden) timer = setTimeout(tick, intervalMs);
    }
  };
  const visible = () => { clearTimeout(timer); if (document.hidden) controller?.abort(); else void tick(); };
  document.addEventListener('visibilitychange', visible); void tick();
  return () => { alive = false; clearTimeout(timer); controller?.abort(); document.removeEventListener('visibilitychange', visible); };
}
async function getJson<T>(path: string, signal: AbortSignal): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  const response = await fetch(`/api/studio/${path}`, { signal, cache: 'no-store' });
  const value = await response.json().catch(() => ({}));
  return response.ok ? { ok: true, value: value as T } : { ok: false, error: typeof value?.error === 'string' ? value.error : `HTTP ${response.status}` };
}

// Every project's runs, shared by the side bar and the workbench through one poll.
let runsState: readonly RunSummary[] = [];
const runsListeners = new Set<() => void>();
let stopRunsPoll: (() => void) | undefined;
function publishRuns(next: readonly RunSummary[]) {
  if (JSON.stringify(next) === JSON.stringify(runsState)) return;
  runsState = next; for (const notify of runsListeners) notify();
}
function subscribeRuns(listener: () => void) {
  runsListeners.add(listener);
  stopRunsPoll ??= startVisiblePoll(async signal => {
    const result = await getJson<{ runs: RunSummary[] }>('autonomy/runs', signal);
    if (result.ok && Array.isArray(result.value.runs)) publishRuns(result.value.runs);
    return true;
  }, POLL_RUNS_MS);
  return () => { runsListeners.delete(listener); if (!runsListeners.size) { stopRunsPoll?.(); stopRunsPoll = undefined; } };
}
/** The newest run of each project. */
export function useAutonomyRuns(): ReadonlyMap<string, RunSummary> {
  const runs = useSyncExternalStore(subscribeRuns, () => runsState);
  return useMemo(() => latestRuns(runs), [runs]);
}
/** A run this page just changed shows at once, before the next poll. */
export function noteAutonomyRun(run: RunSummary) {
  const summary = summaryOf(run), known = runsState.some(row => row.id === run.id);
  publishRuns(known ? runsState.map(row => row.id === run.id ? summary : row) : [summary, ...runsState]);
}

/** One run's details, polled every 2 seconds while the run is open and the page is visible. */
export function useRunDetail(runId: string | undefined) {
  const [detail, setDetail] = useState<RunDetail>(), [error, setError] = useState('');
  const current = useRef(runId); current.current = runId;
  // A run this page just started or changed is accepted even before runId switches to it; the result is filtered by runId below.
  const accept = useCallback((value: RunDetail) => {
    setDetail(previous => JSON.stringify(previous) === JSON.stringify(value) ? previous : value); setError(''); noteAutonomyRun(value);
  }, []);
  useEffect(() => {
    setError(''); if (!runId) { setDetail(undefined); return; }
    return startVisiblePoll(async signal => {
      const result = await getJson<RunDetail>(`autonomy/run?id=${encodeURIComponent(runId)}`, signal);
      if (signal.aborted || current.current !== runId) return false;
      if (!result.ok) { setError(result.error); return true; }
      accept(result.value); return isOpenRun(result.value.state);
    }, POLL_RUN_MS);
  }, [runId, accept]);
  const reload = useCallback(async () => {
    if (!runId) return;
    const value = await api<RunDetail>(`autonomy/run?id=${encodeURIComponent(runId)}`); accept(value); return value;
  }, [runId, accept]);
  return { detail: detail?.id === runId ? detail : undefined, error, accept, reload };
}

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), intervalMs); return () => clearInterval(timer); }, [intervalMs]);
  return now;
}
const modelKey = (ref: ModelRef | undefined) => ref ? JSON.stringify([ref.provider, ref.model]) : '';
const sameModel = (a: ModelRef | undefined, b: ModelRef | undefined) => !!a && !!b && a.provider === b.provider && a.model === b.model;
const MODELS_KEY = 'harnessstudio:autonomy-models:v1';
interface RememberedModels { orchestratorModel?: ModelRef; workerModel?: ModelRef; workerModels?: ModelRef[] }
/** The models of the last start are a per-browser convenience (设计.md §9); the page works without storage. */
function rememberedModels(): RememberedModels {
  try { const value: unknown = JSON.parse(localStorage.getItem(MODELS_KEY) ?? '{}'); return value && typeof value === 'object' ? value as RememberedModels : {}; } catch { return {}; }
}
function rememberModels(value: RememberedModels) { try { localStorage.setItem(MODELS_KEY, JSON.stringify(value)); } catch { /* storage unavailable */ } }
const objectiveDrafts = new Map<string, string>();
const formatTime = (at: string | undefined) => at ? new Date(at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '—';

/** A modal confirmation; the native dialog keeps focus inside and closes on Escape. */
export function ConfirmDialog({ title, action, busy, error, onClose, onConfirm, fallbackFocus, children }: { title: string; action: string; busy: boolean; error?: string; onClose(): void; onConfirm(): void; fallbackFocus?(): void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null), cancel = useRef<HTMLButtonElement>(null), titleId = useId(), fallback = useRef(fallbackFocus); fallback.current = fallbackFocus;
  useEffect(() => {
    const previous = document.activeElement; dialog.current?.showModal(); cancel.current?.focus();
    // The confirmed action can remove the button that opened the dialog (停止… becomes 开始新的运行).
    return () => { dialog.current?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); else fallback.current?.(); };
  }, []);
  return <dialog ref={dialog} className="software-confirm autonomy-confirm" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <h2 id={titleId}>{title}</h2>
    {children}
    {error && <p className="software-warning" role="status">{error}</p>}
    <footer><button ref={cancel} type="button" disabled={busy} onClick={onClose}>取消</button><button type="button" className="autonomy-danger" disabled={busy} onClick={onConfirm}>{busy ? '处理中…' : action}</button></footer>
  </dialog>;
}

/** The budget inputs shared by the start dialog, the run panel and the settings page. */
export function BudgetInputs({ form, disabled, onChange }: { form: Record<keyof AutonomyBudget, string>; disabled?: boolean; onChange(next: Record<keyof AutonomyBudget, string>): void }) {
  const id = useId(), fields = visibleBudgetFields(!useNoSoftware());
  const input = (field: typeof budgetFields[number]) => <label key={field.key}><span>{field.label}</span>
    <input type="number" inputMode="decimal" required min={field.min} max={field.max} step={field.step} value={form[field.key]} disabled={disabled} aria-describedby={`${id}-${field.key}`} onChange={event => onChange({ ...form, [field.key]: event.target.value })} />
    <small id={`${id}-${field.key}`}>{field.hint}</small></label>;
  return <div className="autonomy-budget">
    <div className="autonomy-budget-fields">{fields.filter(field => !field.advanced).map(input)}</div>
    <details className="autonomy-budget-advanced"><summary>高级：缓存读取怎么计入预算、什么时候算子 Agent 卡住了</summary><div className="autonomy-budget-fields">{fields.filter(field => field.advanced).map(input)}</div></details>
  </div>;
}

function RunIcon() {
  return <svg className="autonomy-icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M10 2.5 11.6 7l4.9.2-3.9 3 1.4 4.8L10 12.2 6 15l1.4-4.8-3.9-3L8.4 7z" /></svg>;
}
/** The toolbar entry: starts a run, or opens the panel of the open one with its state on the button. */
export function AutonomyButton({ run, buttonRef, onClick }: { run?: RunSummary; buttonRef?: React.Ref<HTMLButtonElement>; onClick(): void }) {
  const tone = run ? runTone(run) : undefined, label = run ? runStateLabel(run) : '';
  return <button ref={buttonRef} type="button" className={`autonomy-button${tone ? ` is-${tone}` : ''}`} aria-haspopup="dialog"
    title={run ? `自主运行${label}，点击打开运行面板` : '给出目标，让 Agent 自己规划、分派并完成任务'} onClick={onClick}>
    <RunIcon />自主模式{run && <span className="autonomy-button-state"><i aria-hidden="true" />{label}{run.openAttention > 1 ? ` ${run.openAttention}` : ''}</span>}
  </button>;
}
/** The side bar mark of a project with an open run. */
export function AutonomyProjectMark({ run }: { run: RunSummary }) {
  const tone = runTone(run), text = run.openAttention > 0 ? `待处理 ${run.openAttention}` : run.state === 'running' ? '自主' : runStateLabel(run);
  return <small className={`autonomy-project-mark is-${tone}`} title={`自主运行：${runStateLabel(run)}${run.openAttention ? `，${run.openAttention} 项需要你处理` : ''}`}><i aria-hidden="true" /><span className="visually-hidden">自主运行：</span><span className="autonomy-project-mark-text">{text}</span></small>;
}

export interface StartTask { id: string; code: string; title: string; isFolder: boolean }
/** Start a run: goal, scope, models and budget on one page. */
export function AutonomyStartDialog({ projectId, task, choices, fallbackModel, lastRun, onClose, onStarted, onShowRun }: {
  projectId: string; task?: StartTask; choices: ModelChoice[]; fallbackModel?: ModelRef; lastRun?: RunSummary;
  onClose(): void; onStarted(run: RunDetail): void; onShowRun(id: string): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), titleId = useId(), objectiveId = useId();
  // A deployment whose projects have shared VM storage runs VMs (设计.md §9: the warning does not look at single tasks).
  const vmCapable = useVmStorage(projectId), noSoftware = useNoSoftware();
  const available = (ref: ModelRef | undefined) => ref && choices.find(choice => sameModel(choice, ref)) ? { provider: ref.provider, model: ref.model } : undefined;
  const initial = useMemo(() => {
    const saved = rememberedModels(), fallback = available(fallbackModel) ?? (choices[0] && { provider: choices[0].provider, model: choices[0].model });
    const workerModel = available(saved.workerModel) ?? fallback;
    return { orchestratorModel: available(saved.orchestratorModel) ?? fallback, workerModel, workerModels: (saved.workerModels ?? []).flatMap(ref => available(ref) && !sameModel(ref, workerModel) ? [available(ref)!] : []) };
  }, []);
  const [objective, setObjective] = useState(() => objectiveDrafts.get(projectId) ?? '');
  const [scope, setScope] = useState<'project' | 'task'>(task ? 'task' : 'project');
  const [orchestratorModel, setOrchestratorModel] = useState<ModelRef | undefined>(initial.orchestratorModel), [workerModel, setWorkerModel] = useState<ModelRef | undefined>(initial.workerModel);
  const [workerModels, setWorkerModels] = useState<ModelRef[]>(initial.workerModels);
  const [budget, setBudget] = useState(() => toBudgetForm(defaultBudget)), [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  useEffect(() => {
    const previous = document.activeElement; dialog.current?.showModal();
    return () => { dialog.current?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    let alive = true;
    void api<{ settings: AutonomySettings }>('autonomy/settings').then(value => { if (alive) setBudget(toBudgetForm(budgetOf(value.settings))); },
      reason => { if (alive) setNotice(`读不到自主模式默认值（${reason instanceof Error ? reason.message : String(reason)}），下面先填了系统默认值。`); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);
  useEffect(() => { objectiveDrafts.set(projectId, objective); }, [projectId, objective]);
  const pick = (key: string) => { const choice = choices.find(row => modelKey(row) === key); return choice ? { provider: choice.provider, model: choice.model } : undefined; };
  const visionOf = (ref: ModelRef | undefined) => choices.find(choice => sameModel(choice, ref))?.supportsImages === true;
  const workers = [workerModel, ...workerModels].filter(Boolean) as ModelRef[];
  const visionMissing = vmCapable && workers.length > 0 && !workers.some(visionOf);
  const groups = [...new Set(choices.map(row => row.provider))];
  const options = groups.map(provider => <optgroup key={provider} label={choices.find(row => row.provider === provider)!.providerName}>{choices.filter(row => row.provider === provider).map(row => <option key={row.model} value={modelKey(row)}>{row.model}{row.supportsImages ? '（支持图片）' : ''}</option>)}</optgroup>);
  const submit = async () => {
    if (busy) return;
    const parsed = fromBudgetForm(budget);
    if (!objective.trim()) { setError('请写下目标：要做成什么、有什么要求。'); return; }
    if (!orchestratorModel || !workerModel) { setError('请选择总 Agent 和子 Agent 的模型。'); return; }
    if ('error' in parsed) { setError(parsed.error); return; }
    const settings: AutonomySettings = { ...parsed.budget, orchestratorModel, workerModel, workerModels: workerModels.filter(ref => !sameModel(ref, workerModel)) };
    setBusy(true); setError('');
    try {
      const run = await api<RunDetail>('autonomy/start', { projectId, ...(scope === 'task' && task ? { rootTaskId: task.id } : {}), objective: objective.trim(), settings }, { timeoutMs: 60000 });
      rememberModels({ orchestratorModel, workerModel, workerModels: settings.workerModels }); objectiveDrafts.delete(projectId); onStarted(run);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '启动失败'); } finally { setBusy(false); }
  };
  return <dialog ref={dialog} className="autonomy-start-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <header><div><h2 id={titleId}>启动自主运行</h2><p>写下目标，Agent 会自己规划任务、派子 Agent 去做，并自己检查、确认完成。</p></div><button type="button" className="autonomy-close" aria-label="关闭" disabled={busy} onClick={onClose}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg></button></header>
      {lastRun && !isOpenRun(lastRun.state) && <p className="autonomy-last-run">上次运行：{runStateLabel(lastRun)} · {formatTime(lastRun.endedAt ?? lastRun.startedAt)}<button type="button" className="autonomy-link" disabled={busy} onClick={() => onShowRun(lastRun.id)}>查看那次运行</button></p>}
      <fieldset disabled={busy}>
        <section><h3><span>1</span><label htmlFor={objectiveId}>目标</label></h3>
          <textarea id={objectiveId} required autoFocus rows={5} value={objective} onChange={event => setObjective(event.target.value)} placeholder={'写清楚要做成什么、做到什么程度、有什么要求和限制。例如：\n完成减速器箱体的三维建模和强度校核，输出装配图（DWG）和校核报告（PDF）；材料用 HT200，安全系数不低于 1.5。'} />
          <small>目标越具体，Agent 越少停下来问你。缺关键信息时它会在对话里问你。</small>
        </section>
        <section role="radiogroup" aria-labelledby={`${titleId}-scope`}><h3 id={`${titleId}-scope`}><span>2</span>范围</h3>
          <div className="autonomy-scope">
            <label className={scope === 'project' ? 'is-selected' : ''}><input type="radio" name="scope" checked={scope === 'project'} onChange={() => setScope('project')} /><span><strong>整个项目</strong><small>总 Agent 可以规划和完成项目里的全部任务</small></span></label>
            <label className={`${scope === 'task' ? 'is-selected' : ''}${task ? '' : ' is-disabled'}`}><input type="radio" name="scope" checked={scope === 'task'} disabled={!task} onChange={() => setScope('task')} /><span><strong>{task ? <>只做 <code>{task.code}</code> {task.title}{task.isFolder ? ' 这一组' : ''}</> : '只做一个任务分支'}</strong><small>{task ? '总 Agent 只能规划和完成这个任务和它下面的子任务' : '先在图谱里选中一个任务，才能只做它的分支'}</small></span></label>
          </div>
        </section>
        <section><h3><span>3</span>模型</h3>
          {choices.length ? <div className="autonomy-models">
            <label>总 Agent<select required value={modelKey(orchestratorModel)} onChange={event => setOrchestratorModel(pick(event.target.value))}>{!orchestratorModel && <option value="">请选择</option>}{options}</select><small>负责理解目标、规划任务、分派和跟进，建议选能力强的模型</small></label>
            <label>子 Agent（默认）<select required value={modelKey(workerModel)} onChange={event => { const next = pick(event.target.value); setWorkerModel(next); setWorkerModels(previous => previous.filter(ref => !sameModel(ref, next))); }}>{!workerModel && <option value="">请选择</option>}{options}</select><small>做具体任务的 Agent 默认用这个模型</small></label>
            {choices.length > 1 && <fieldset className="autonomy-extra-models"><legend>总 Agent 还可以给个别任务换用</legend>
              {choices.filter(choice => !sameModel(choice, workerModel)).map(choice => <label key={modelKey(choice)}><input type="checkbox" checked={workerModels.some(ref => sameModel(ref, choice))} onChange={event => setWorkerModels(previous => event.target.checked ? [...previous, { provider: choice.provider, model: choice.model }] : previous.filter(ref => !sameModel(ref, choice)))} /><span>{choice.model}<small>{choice.providerName}{choice.supportsImages ? ' · 支持图片' : ''}</small></span></label>)}
            </fieldset>}
            {visionMissing && <p className="software-warning" role="note">所选的子 Agent 模型都不支持图片。如果有任务要操作虚拟机里的软件，子 Agent 看不到屏幕画面。建议在上面勾选一个支持图片的模型；不加也可以启动。</p>}
          </div> : <p className="software-warning">还没有可用的模型，请先在左下角「模型配置」里添加。</p>}
        </section>
        <section><h3><span>4</span>预算</h3>
          <BudgetInputs form={budget} disabled={loading} onChange={setBudget} />
          {notice && <small className="autonomy-start-notice">{notice}</small>}
          <small>任何一项用完，运行会暂停并等你处理。默认值可以在「模型配置」页的「自主模式默认值」里改。</small>
        </section>
      </fieldset>
      <footer>
        <p className="autonomy-start-note">Agent 会逐条检查清单、写出检查依据，然后自己确认任务完成，完成记录会标明“由 Agent 确认”。你随时可以暂停或停止，事后可以抽查任何任务，点「继续修改」让它重做。删除、清空只有你能做。</p>
        {error && <p className="software-warning" role="alert">{error}</p>}
        <div className="vm-launch-actions"><button type="button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="autonomy-primary" disabled={busy || loading || !choices.length}>{busy ? '正在启动…' : '开始运行'}</button></div>
      </footer>
    </form>
  </dialog>;
}

/** Worker models of a running run: the default and the others the orchestrator may pick per task. The orchestrator's
 * model stays as it started. Same wording and vision warning as the start dialog. */
function RunModels({ choices, orchestrator, workerModel, workerModels, vmCapable, disabled, onChange }: {
  choices: readonly ModelChoice[]; orchestrator?: ModelRef; workerModel?: ModelRef; workerModels: ModelRef[]; vmCapable: boolean; disabled: boolean;
  onChange(workerModel: ModelRef | undefined, workerModels: ModelRef[]): void;
}) {
  const known = (ref: ModelRef | undefined) => !!ref && choices.some(choice => sameModel(choice, ref));
  // A model removed from the model page since the start stays selectable as it is, so saving does not change it silently.
  const listed: ModelChoice[] = [...choices, ...[workerModel, ...workerModels].filter((ref): ref is ModelRef => !!ref && !known(ref)).map(ref => ({ ...ref, providerName: ref.provider }))];
  const vision = (ref: ModelRef) => listed.find(choice => sameModel(choice, ref))?.supportsImages === true;
  const workers = [workerModel, ...workerModels].filter((ref): ref is ModelRef => !!ref);
  const groups = [...new Set(listed.map(row => row.provider))];
  return <fieldset className="autonomy-run-models" disabled={disabled}><legend>模型</legend>
    <p>总 Agent：{orchestrator?.model ?? '（未设置）'}<small>（运行开始后不能改）</small></p>
    <label>子 Agent（默认）<select required value={workerModel ? JSON.stringify([workerModel.provider, workerModel.model]) : ''} onChange={event => {
      const choice = listed.find(row => JSON.stringify([row.provider, row.model]) === event.target.value); if (!choice) return;
      const next = { provider: choice.provider, model: choice.model }; onChange(next, workerModels.filter(ref => !sameModel(ref, next)));
    }}>{groups.map(provider => <optgroup key={provider} label={listed.find(row => row.provider === provider)!.providerName}>{listed.filter(row => row.provider === provider).map(row => <option key={row.model} value={JSON.stringify([row.provider, row.model])}>{row.model}{row.supportsImages ? '（支持图片）' : ''}</option>)}</optgroup>)}</select></label>
    {listed.length > 1 && <fieldset className="autonomy-extra-models"><legend>总 Agent 还可以给个别任务换用</legend>
      {listed.filter(choice => !sameModel(choice, workerModel)).map(choice => <label key={`${choice.provider}/${choice.model}`}><input type="checkbox" checked={workerModels.some(ref => sameModel(ref, choice))}
        onChange={event => onChange(workerModel, event.target.checked ? [...workerModels, { provider: choice.provider, model: choice.model }] : workerModels.filter(ref => !sameModel(ref, choice)))} />
        <span>{choice.model}<small>{choice.providerName}{choice.supportsImages ? ' · 支持图片' : ''}</small></span></label>)}
    </fieldset>}
    {vmCapable && workers.length > 0 && !workers.some(vision) && <p className="software-warning" role="note">所选的子 Agent 模型都不支持图片。如果有任务要操作虚拟机里的软件，子 Agent 看不到屏幕画面。建议在上面勾选一个支持图片的模型。</p>}
  </fieldset>;
}

type PanelChat = { id: string; scope?: 'project' | 'task'; taskId?: string };
/** The run panel: a drawer beside the workbench that does not block it, so the person can follow a worker into its task. */
export function AutonomyPanel({ runId, projectId, detail, error, tasks, chats, choices, onClose, onChanged, onReload, onOpenChat, onOpenTask, onStartNew }: {
  runId: string; projectId: string; detail?: RunDetail; error: string; tasks: readonly TaskView[]; chats: readonly PanelChat[]; choices: readonly ModelChoice[];
  onClose(): void; onChanged(run: RunDetail): void; onReload(): Promise<RunDetail | undefined>; onOpenChat(chatId: string, taskId?: string): void; onOpenTask(taskId: string): void; onStartNew(): void;
}) {
  const titleId = useId(), heading = useRef<HTMLHeadingElement>(null), editSection = useRef<HTMLElement>(null), now = useNow(15000);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [confirm, setConfirm] = useState<{ kind: 'stop' } | { kind: 'accept'; attention: RunAttention }>();
  const [editing, setEditing] = useState<{ revision: number; objective: string; budget: Record<keyof AutonomyBudget, string>; workerModel?: ModelRef; workerModels: ModelRef[] }>();
  const vmCapable = useVmStorage(projectId), noSoftware = useNoSoftware();
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [runId]);
  // An action often replaces the button that ran it (暂停 becomes 继续); keep focus in the panel so Escape and Tab still work.
  const keepFocus = () => requestAnimationFrame(() => { if (!document.activeElement || document.activeElement === document.body) heading.current?.focus({ preventScroll: true }); });
  useEffect(() => { setEditing(undefined); setConfirm(undefined); setMessage(''); }, [runId]);
  const act = async (operation: () => Promise<RunDetail>, done?: string) => {
    setBusy(true); setMessage('');
    try { const run = await operation(); onChanged(run); if (done) setMessage(done); return true; }
    // A refused change (for example an outdated revision) refreshes the run, so the next attempt starts from what the server has.
    // The run may have changed itself between polls (e.g. paused on its budget); the reload makes a second try use the new revision.
    catch (reason) { const text = reason instanceof Error ? reason.message : '操作失败'; setMessage(/已变化/.test(text) ? '运行刚刚有了变化（例如它自己暂停了），已载入最新状态。请看一下再操作一次。' : text); void onReload().catch(() => undefined); return false; }
    finally { setBusy(false); keepFocus(); }
  };
  if (!detail) return <section className="autonomy-panel" aria-labelledby={titleId} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } }}>
    <header className="autonomy-panel-header"><h2 id={titleId} ref={heading} tabIndex={-1}>自主运行</h2><button type="button" className="autonomy-close" aria-label="关闭运行面板" onClick={onClose}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg></button></header>
    <div className="autonomy-panel-scroll"><p role="status">{error ? `读取运行失败：${error}` : '正在读取运行…'}</p></div>
  </section>;
  const run = detail, open = isOpenRun(run.state), tone = runTone(run);
  const control = (action: 'pause' | 'resume' | 'stop', done: string) => act(() => api<RunDetail>(`autonomy/${action}`, { id: run.id, revision: run.revision }, { timeoutMs: 60000 }), done);
  const resolve = (attention: RunAttention, action: AttentionAction) => act(() => api<RunDetail>('autonomy/attention/resolve', { id: run.id, attentionId: attention.id, action }, { timeoutMs: 60000 }),
    action === 'accept' ? '运行已结束。' : action === 'stop-worker' ? '已停止这个子 Agent。' : action === 'continue' ? '已让它继续。' : '已标记为处理好。');
  const startEdit = () => { setEditing({ revision: run.revision, objective: run.objective, budget: toBudgetForm(budgetOf(run.settings)), ...run.settings.workerModel ? { workerModel: run.settings.workerModel } : {}, workerModels: run.settings.workerModels ?? [] }); setMessage(''); requestAnimationFrame(() => editSection.current?.scrollIntoView({ block: 'nearest' })); };
  const choose = (attention: RunAttention, choice: AttentionChoice) => {
    if (choice.kind === 'edit-budget') startEdit();
    else if (choice.kind === 'resume') void control('resume', '运行已继续。');
    else if (choice.confirm) { setMessage(''); setConfirm({ kind: 'accept', attention }); }
    else void resolve(attention, choice.action);
  };
  const root = run.rootTaskId ? tasks.find(task => task.id === run.rootTaskId) : undefined;
  const orchestratorTask = run.rootTaskId, waiting = run.attention.filter(row => !row.resolvedAt), resolved = run.attention.filter(row => row.resolvedAt);
  const unfinished = unfinishedInScope(tasks, run.rootTaskId);
  const taskName = (id?: string) => { const task = id ? tasks.find(row => row.id === id) : undefined; return task ? `${task.code} ${task.title}` : undefined; };
  const workerOrder = { 'waiting-human': 0, running: 1, idle: 2, stopped: 3, done: 4 } as Record<string, number>;
  const workers = [...run.workers].sort((a, b) => (workerOrder[a.state] ?? 5) - (workerOrder[b.state] ?? 5) || (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
  const events = [...run.events].sort((a, b) => b.at.localeCompare(a.at));
  const chatTask = (chatId?: string) => chats.find(chat => chat.id === chatId)?.taskId;
  return <section className={`autonomy-panel is-${tone}`} aria-labelledby={titleId} onKeyDown={event => { if (event.key === 'Escape' && !confirm) { event.preventDefault(); onClose(); } }}>
    <header className="autonomy-panel-header">
      <h2 id={titleId} ref={heading} tabIndex={-1}><RunIcon />自主运行</h2><span className={`autonomy-state is-${tone}`}><i aria-hidden="true" />{runStateLabel(run)}</span>
      <button type="button" className="autonomy-close" aria-label="关闭运行面板" title="关闭运行面板（Esc）" onClick={onClose}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg></button>
    </header>
    <div className="autonomy-panel-scroll">
      <section className="autonomy-status" aria-label="运行状态">
        <p>{runStateDetail(run)}</p>
        <dl>
          <div><dt>范围</dt><dd>{run.rootTaskId ? root ? <button type="button" className="autonomy-link" onClick={() => onOpenTask(root.id)}><code>{root.code}</code> {root.title}{root.isFolder ? ' 这一组' : ''}</button> : '一个任务分支' : '整个项目'}</dd></div>
          <div><dt>开始</dt><dd>{formatTime(run.startedAt)}{run.endedAt ? ` · 结束 ${formatTime(run.endedAt)}` : ''}</dd></div>
        </dl>
        <div className="autonomy-actions">
          <button type="button" disabled={busy} onClick={() => onOpenChat(run.orchestratorChatId, orchestratorTask)}>总 Agent 对话</button>
          {canPause(run.state) && <button type="button" disabled={busy} onClick={() => { void control('pause', noSoftware ? '运行已暂停。正在进行的回合已停下。' : '运行已暂停。正在进行的回合已停下，虚拟机保持运行。'); }}>暂停</button>}
          {canResume(run.state) && <button type="button" className="autonomy-primary" disabled={busy} onClick={() => { void control('resume', '运行已继续。'); }}>继续</button>}
          {open && <button type="button" className="autonomy-danger" disabled={busy} onClick={() => { setMessage(''); setConfirm({ kind: 'stop' }); }}>停止…</button>}
          {!open && <button type="button" className="autonomy-primary" disabled={busy} onClick={onStartNew}>开始新的运行</button>}
        </div>
        {(message || error) && <p className="autonomy-message" role="status">{message || `刷新失败：${error}`}</p>}
      </section>

      {waiting.length > 0 && <section className="autonomy-section autonomy-attention-list" aria-labelledby={`${titleId}-attention`}>
        <h3 id={`${titleId}-attention`}>需要你处理 <b>{waiting.length}</b></h3>
        {waiting.map(attention => { const target = taskName(attention.taskId ?? chatTask(attention.chatId)), orchestrator = attention.chatId === run.orchestratorChatId; return <article key={attention.id} className={`autonomy-attention is-${attention.kind}`}>
          <header><strong>{attentionLabel(attention.kind, orchestrator)}</strong><small>{formatAgo(attention.since, now)}</small></header>
          {target && <small className="autonomy-attention-task">{target}</small>}
          <p>{attention.message}</p>
          {attention.kind === 'incomplete' && <div className="autonomy-unfinished"><small>还没完成的任务（{unfinished.length}）：</small>
            {unfinished.length ? <ul>{unfinished.map(task => <li key={task.id}><button type="button" className="autonomy-link" onClick={() => onOpenTask(task.id)}><code>{task.code}</code> {task.title}</button></li>)}</ul> : <small>现在范围内的任务都已完成。</small>}</div>}
          <div className="autonomy-actions">
            {attention.chatId ? <button type="button" disabled={busy} onClick={() => onOpenChat(attention.chatId!, attention.taskId)}>{attentionChatLabel(attention.kind)}</button> : attention.taskId ? <button type="button" disabled={busy} onClick={() => onOpenTask(attention.taskId!)}>打开任务</button> : null}
            {attentionChoices(attention.kind, orchestrator).map(choice => <button key={choice.label} type="button" className={choice.kind === 'resolve' && choice.primary || choice.kind === 'resume' ? 'autonomy-primary' : choice.kind === 'resolve' && (choice.confirm || choice.action === 'stop-worker') ? 'autonomy-danger' : ''} disabled={busy || choice.kind === 'resume' && !canResume(run.state)} onClick={() => choose(attention, choice)}>{choice.label}{choice.kind === 'resolve' && choice.confirm ? '…' : ''}</button>)}
          </div>
        </article>; })}
      </section>}

      <section className="autonomy-section" aria-labelledby={`${titleId}-goal`} ref={editSection}>
        <h3 id={`${titleId}-goal`}>目标{open && !editing && <button type="button" className="autonomy-link" disabled={busy} onClick={startEdit}>修改目标、模型和预算</button>}</h3>
        {editing ? <form className="autonomy-edit" onSubmit={event => {
          event.preventDefault(); const parsed = fromBudgetForm(editing.budget);
          if (!editing.objective.trim()) { setMessage('目标不能为空。'); return; }
          if ('error' in parsed) { setMessage(parsed.error); return; }
          const before = budgetOf(run.settings), changed: Partial<AutonomySettings> = Object.fromEntries(Object.entries(parsed.budget).filter(([key, value]) => before[key as keyof AutonomyBudget] !== value));
          const extra = editing.workerModels.filter(ref => !sameModel(ref, editing.workerModel)), previous = run.settings.workerModels ?? [];
          if (editing.workerModel && !sameModel(editing.workerModel, run.settings.workerModel)) changed.workerModel = editing.workerModel;
          if (extra.length !== previous.length || extra.some(ref => !previous.some(item => sameModel(item, ref)))) changed.workerModels = extra;
          const body = { id: run.id, revision: editing.revision, ...(editing.objective.trim() !== run.objective ? { objective: editing.objective.trim() } : {}), ...(Object.keys(changed).length ? { settings: changed } : {}) };
          if (!('objective' in body) && !('settings' in body)) { setEditing(undefined); return; }
          void act(() => api<RunDetail>('autonomy/update', body, { timeoutMs: 60000 }), '已保存。总 Agent 会收到通知，按新的目标、模型和预算调整。').then(ok => { if (ok) setEditing(undefined); });
        }}>
          <textarea aria-label="目标" required rows={4} value={editing.objective} disabled={busy} onChange={event => setEditing(previous => previous && { ...previous, objective: event.target.value })} />
          <RunModels choices={choices} orchestrator={run.settings.orchestratorModel} workerModel={editing.workerModel} workerModels={editing.workerModels} vmCapable={vmCapable} disabled={busy}
            onChange={(workerModel, workerModels) => setEditing(previous => previous && { ...previous, ...workerModel ? { workerModel } : {}, workerModels })} />
          <BudgetInputs form={editing.budget} disabled={busy} onChange={budget => setEditing(previous => previous && { ...previous, budget })} />
          {message && !busy && editing.revision !== run.revision && <p className="software-warning">运行在你修改期间有了变化。可以点「载入最新」看看现在的目标、模型和预算，再重新修改。<button type="button" className="autonomy-link" onClick={startEdit}>载入最新</button></p>}
          <div className="autonomy-actions"><button type="submit" className="autonomy-primary" disabled={busy}>保存</button><button type="button" disabled={busy} onClick={() => setEditing(undefined)}>取消</button></div>
        </form> : <p className="autonomy-objective">{run.objective}</p>}
      </section>

      <section className="autonomy-section" aria-labelledby={`${titleId}-usage`}>
        <h3 id={`${titleId}-usage`}>预算用量</h3>
        {usageRows(run, !noSoftware).map(row => <div key={row.key} className={`vm-meter autonomy-meter${row.warn ? ' is-warn' : ''}`}>
          <span className="vm-meter-label">{row.label}</span>
          <span className="vm-meter-track" role="meter" aria-label={row.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(row.percent)} aria-valuetext={`${row.text}${row.warn ? '，接近上限' : ''}`}><span className="vm-meter-held" style={{ width: `${row.percent}%` }} /></span>
          <span className="vm-meter-value">{row.text}{row.warn ? ' · 接近上限' : ''}</span>
          {row.detail && <small className="autonomy-meter-detail">{row.detail}</small>}
        </div>)}
        <p className="autonomy-meter-note">折算 token：未缓存输入、缓存写入和输出全额计算，缓存读取按 {Number(((run.settings.cacheReadWeight ?? 0.1) * 100).toFixed(2))}% 计算。</p>
      </section>

      <section className="autonomy-section" aria-labelledby={`${titleId}-workers`}>
        <h3 id={`${titleId}-workers`}>子 Agent <b>{run.workers.length}</b></h3>
        {workers.length ? <ul className="autonomy-workers">{workers.map(worker => <li key={worker.chatId}><button type="button" className={`autonomy-worker is-${worker.state}`} onClick={() => onOpenChat(worker.chatId, worker.taskId)}>
          <span className="autonomy-worker-title"><code>{worker.code}</code><strong>{worker.title}</strong><span className="autonomy-worker-state">{workerStateLabel(worker.state)}</span></span>
          <small>{worker.model} · 最近活动 {formatAgo(worker.lastActivityAt, now)}{worker.nudges ? ` · 催促 ${worker.nudges} 次` : ''}</small>
          {worker.lastReport && <span className="autonomy-worker-report"><b>{reportKindLabel(worker.lastReport.kind)}</b>{worker.lastReport.message}</span>}
        </button></li>)}</ul> : <p className="autonomy-empty">{open ? '总 Agent 还没有派出子 Agent。' : '这次运行没有派出子 Agent。'}</p>}
      </section>

      <section className="autonomy-section" aria-labelledby={`${titleId}-events`}>
        <h3 id={`${titleId}-events`}>最近发生的事</h3>
        {events.length ? <ol className="autonomy-events">{events.map((event, index) => <li key={`${event.at}:${index}`}><time dateTime={event.at}>{formatAgo(event.at, now)}</time>
          {event.chatId || event.taskId ? <button type="button" className="autonomy-link" onClick={() => event.chatId ? onOpenChat(event.chatId, event.taskId) : onOpenTask(event.taskId!)}>{event.summary}</button> : <span>{event.summary}</span>}</li>)}</ol> : <p className="autonomy-empty">还没有事件。</p>}
      </section>

      {resolved.length > 0 && <details className="autonomy-section autonomy-resolved"><summary>已处理的事项 {resolved.length}</summary>
        <ul>{resolved.map(attention => <li key={attention.id}><strong>{attentionLabel(attention.kind, attention.chatId === run.orchestratorChatId)}</strong><small>{formatTime(attention.since)} → {formatTime(attention.resolvedAt)}</small><p>{attention.message}</p></li>)}</ul></details>}
    </div>
    {confirm?.kind === 'stop' && <ConfirmDialog title="停止这次自主运行？" action="确认停止" busy={busy} error={message} fallbackFocus={keepFocus} onClose={() => { setConfirm(undefined); setMessage(''); }} onConfirm={() => { void control('stop', '运行已停止。').then(ok => { if (ok) setConfirm(undefined); }); }}>
      <p>总 Agent 和全部子 Agent 会停下手上的工作，这次运行结束，不能再继续。已完成的任务、文件和对话都会保留；还没完成的任务保持现在的样子，你可以自己接着做，或以后再启动一次自主运行。</p>
    </ConfirmDialog>}
    {confirm?.kind === 'accept' && <ConfirmDialog title="接受结果并结束运行？" action="接受，结束运行" busy={busy} error={message} fallbackFocus={keepFocus} onClose={() => { setConfirm(undefined); setMessage(''); }} onConfirm={() => { void resolve(confirm.attention, 'accept').then(ok => { if (ok) setConfirm(undefined); }); }}>
      <p>运行会结束并标为已完成。{unfinished.length ? '下面这些任务保持原样，不会完成：' : ''}</p>
      {unfinished.length > 0 && <ul className="autonomy-confirm-list">{unfinished.slice(0, 12).map(task => <li key={task.id}><code>{task.code}</code> {task.title}</li>)}{unfinished.length > 12 && <li>另有 {unfinished.length - 12} 个任务</li>}</ul>}
      <p>以后你可以自己做这些任务，或再启动一次自主运行。</p>
    </ConfirmDialog>}
  </section>;
}
