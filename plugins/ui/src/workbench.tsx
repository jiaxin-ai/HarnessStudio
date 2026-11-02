import { useCallback, useEffect, useId, useMemo, useState, useRef, useSyncExternalStore } from 'react';
import { stateNames, type SingleUserTaskState, type ProjectGraph, type TaskView, type Snapshot, type TaskDeletePreview, type TaskDeleteResult, type TaskClearResult, type InputRef, type DependencyChangeRequest, type DependencyChangePreview } from '@harnessstudio/studio/domain-types';
import { api } from './api.ts';
import { TaskEditor } from './task-editor.tsx';
import type { ModelSettings } from './models.tsx';
import { ChatPane, type ModelChoice } from './chat.tsx';
import { ResizableSplit } from './resizable-split.tsx';
import { TaskGraph } from './task-graph.tsx';
import { aggregateTaskActivity } from './task-activity.ts';
import type { ChatActivity } from '../../studio/src/chat-activity.ts';
import { QuickTaskDialog, type NewTaskContext } from './quick-task.tsx';
import { ProjectFilesPanel } from './project-files.tsx';
import { TaskFilesPanel, type TaskFileDraft } from './task-files.tsx';
import { TaskCompletionDialog } from './task-completion.tsx';
import { CompletionConfirmationRecord } from './completion-record.tsx';
import { SoftwarePanel } from './software-panel.tsx';
import { useVmStorage } from './vm-panel.tsx';
import { TaskClearDialog } from './task-clear.tsx';
import { forgetChatAttachmentDrafts } from './chat-attachments.tsx';
import { TaskChecklistDialog, TaskChecklistList } from './task-checklist.tsx';
import { DependencyChangeDialog, dependencyChangeEndpoint, dependencyChangePayload } from './dependency-change.tsx';
import { DownloadButton } from './file-download.tsx';
import { TaskRecordings } from './recording-viewer.tsx';
import { useNoSoftware } from './software-backend.ts';
import type { SoftwareBackend } from '../../studio/src/seat-types.ts';
import { IdChip, RegionButtons, onTitleBarDoubleClick, type Region, type RegionControl } from './region.tsx';
import { availableModelPreference, modelPreferenceStorageKey, readModelPreference, saveModelPreference, type ModelPreference } from './model-preference.ts';
import { AutonomyButton, AutonomyPanel, AutonomyStartDialog, noteAutonomyRun, useAutonomyRuns, useRunDetail } from './autonomy.tsx';
import { isOpenRun, workerActivity, type RunDetail } from './autonomy-model.ts';

export interface RuntimeStatus { softwareBackend?: SoftwareBackend; providers: { id: string; name: string }[]; chats: { id: string; scope?: 'project' | 'task'; projectId?: string; taskId?: string; provider: string; model: string; status?: string; activity?: ChatActivity; role?: 'orchestrator' | 'worker'; runId?: string }[] }
interface Draft { fileDraft?: TaskFileDraft; chatId?: string }
/** Which side of each workbench split is collapsed; kept per browser like VS Code's layout. */
type Fold = 'first' | 'second' | null;
interface Layout { rows: Fold; top: Fold; bottom: Fold }
const LAYOUT_KEY = 'harnessstudio:layout:v2:collapsed', ROW_TITLE_HEIGHT = 40;
const defaultLayout = (): Layout => ({ rows: null, top: null, bottom: null });
function readLayout(): Layout {
  const fold = (value: unknown): Fold => value === 'first' || value === 'second' ? value : null;
  try { const value = JSON.parse(window.localStorage.getItem(LAYOUT_KEY) ?? '{}') as Partial<Layout>; return { rows: fold(value.rows), top: fold(value.top), bottom: fold(value.bottom) }; }
  catch { return defaultLayout(); }
}
function saveLayout(layout: Layout) { try { window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch { /* The layout still works without storage. */ } }
const emptyDraft = (): Draft => ({});
// Keep file drafts in this browser session when switching tasks, projects or
// settings. A save may clear only the exact draft that produced its request.
let workspaceDrafts: Record<string, Draft> = {};
const draftListeners = new Set<() => void>();
const subscribeDrafts = (listener: () => void) => { draftListeners.add(listener); return () => { draftListeners.delete(listener); }; };
const getDrafts = () => workspaceDrafts;
function setDrafts(update: (previous: Record<string, Draft>) => Record<string, Draft>) {
  const next = update(workspaceDrafts);
  if (next === workspaceDrafts) return;
  workspaceDrafts = next; for (const notify of draftListeners) notify();
}
/** A confirmed project deletion must not leave hidden drafts or unload warnings behind. */
export function forgetProjectWorkspaceDrafts(projectId: string, taskIds: Iterable<string>) {
  const removed = new Set([`project:${projectId}`, ...taskIds]);
  setDrafts(previous => {
    const next = Object.fromEntries(Object.entries(previous).filter(([key]) => !removed.has(key)));
    return Object.keys(next).length === Object.keys(previous).length ? previous : next;
  });
}
window.addEventListener('beforeunload', event => {
  if (!Object.values(workspaceDrafts).some(row => row.fileDraft && (row.fileDraft.isNew || row.fileDraft.content !== row.fileDraft.baseContent))) return;
  event.preventDefault(); event.returnValue = '';
});
function TaskDeleteDialog({ task, onClose, onBusyChange, onDeleted }: {
  task: TaskView; onClose(): void; onBusyChange(busy: boolean): void; onDeleted(result: TaskDeleteResult): Promise<void>;
}) {
  const vmStorage = useVmStorage(task.projectId);
  const [preview, setPreview] = useState<TaskDeletePreview>(), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const cancel = useRef<HTMLButtonElement>(null), form = useRef<HTMLFormElement>(null), alive = useRef(true), request = useRef(0);
  const loadPreview = useCallback(async (notice = '') => {
    const sequence = ++request.current; setPreview(undefined); setLoading(true); setError(notice);
    try {
      const value = await api<TaskDeletePreview>(`task/delete-preview?id=${encodeURIComponent(task.id)}`);
      if (alive.current && request.current === sequence) setPreview(value);
    } catch (error) {
      if (alive.current && request.current === sequence) setError([notice, error instanceof Error ? error.message : '无法读取删除影响范围'].filter(Boolean).join('；'));
    } finally { if (alive.current && request.current === sequence) setLoading(false); }
  }, [task.id]);
  useEffect(() => {
    alive.current = true; const previous = document.activeElement; cancel.current?.focus(); void loadPreview();
    return () => { alive.current = false; request.current++; if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [loadPreview]);
  return <div className="studio-dialog task-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="task-delete-title" aria-describedby="task-delete-description" onKeyDown={event => {
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
          const result = await api<TaskDeleteResult>('task/delete', { id: confirmed.taskId, revision: confirmed.taskRevision, projectRevision: confirmed.projectRevision, confirm: true });
          await onDeleted(result);
        } catch (error) {
          if (alive.current) await loadPreview(`${error instanceof Error ? error.message : '删除未完成'}。请查看最新影响范围，再次确认后重试。`);
        } finally { if (alive.current) setBusy(false); onBusyChange(false); }
      })();
    }}>
      <header><span className="task-delete-symbol" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13M10 10v7M14 10v7" /></svg></span><div><h2 id="task-delete-title">{preview?.retry ? '重新确认删除任务' : '删除这个任务？'}</h2><p>仅没有下一级子任务的节点可以删除。</p></div></header>
      <div className="task-delete-target"><code>{preview?.code ?? task.code}</code><strong>{preview?.title ?? task.title}</strong><small>{stateNames[(preview?.state ?? task.state) as SingleUserTaskState]}</small></div>
      <p id="task-delete-description" className="task-delete-warning">将永久删除这个节点、任务工作空间、全部对话、临时文件、结果快照和相关历史。这些数据无法恢复，请先自行保存需要的文件。</p>
      {vmStorage && <p className="task-delete-warning">本任务的虚拟机会被删除；虚拟机平台上的任务文件（D 盘）不会被删除，会保留在宿主机上。</p>}
      {loading ? <p role="status">正在检查删除影响范围…</p> : preview && <>
        <div className="task-delete-counts"><span>已登记结果快照 <b>{preview.snapshotCount}</b></span><span>历史复核记录 <b>{preview.reviewCount}</b></span></div>
        {preview.affected.length > 0 && <section className="task-delete-impact" aria-label="受影响任务"><strong>{preview.affected.length} 个任务会受到影响</strong><p>关联任务将暂停执行，需要重新确认依赖；上级目录的汇总结果也会重新计算。</p><ul>{preview.affected.slice(0, 6).map(row => <li key={row.id}><code>{row.code}</code><span>{row.title}</span><small>{row.reason === 'dependency' ? '依赖受影响' : '目录汇总'}</small></li>)}</ul>{preview.affected.length > 6 && <small>另有 {preview.affected.length - 6} 个关联任务。</small>}</section>}
        {preview.retry && <p className="task-delete-warning">上次删除尚未完成，相关节点保持冻结。确认后将继续清理剩余数据。</p>}
      </>}
      {error && <p role="status">{error}</p>}
      <footer><button ref={cancel} type="button" disabled={busy} onClick={onClose}>取消</button>{!loading && !preview && <button type="button" disabled={busy} onClick={() => { void loadPreview(); }}>刷新删除预览</button>}<button className="task-delete-confirm" type="submit" disabled={busy || loading || !preview}>{busy ? '正在删除…' : preview?.retry ? '确认继续永久删除' : '确认永久删除'}</button></footer>
    </form>
  </div>;
}

export function ProjectWorkbench({ projectId, selectedTaskId: selected, onSelectTask, status, models, onProjectUpdate }: { projectId: string; selectedTaskId: string; onSelectTask: (id: string) => void; status: RuntimeStatus; models?: ModelSettings; onProjectUpdate: () => Promise<void> }) {
  const [graph, setGraph] = useState<ProjectGraph>();
  const activity = useMemo(() => aggregateTaskActivity(graph?.tasks ?? [], status.chats), [graph?.tasks, status.chats]);
  const currentProject = useRef(projectId); currentProject.current = projectId;
  const projectGeneration = useRef({ id: projectId, value: 0 });
  if (projectGeneration.current.id !== projectId) projectGeneration.current = { id: projectId, value: projectGeneration.current.value + 1 };
  const graphRequest = useRef(0);
  const drafts = useSyncExternalStore(subscribeDrafts, getDrafts);
  const [chatMessages, setChatMessages] = useState<Record<string, string>>({});
  const [resource, setResource] = useState<'file' | 'project' | 'software'>('file');
  // Without software there is no software tab; the file tabs take the whole area.
  const noSoftware = useNoSoftware();
  const [maximized, setMaximized] = useState<Region | null>(null);
  const [layout, setLayout] = useState(readLayout), [layoutReset, setLayoutReset] = useState(0);
  useEffect(() => { saveLayout(layout); }, [layout]);
  const foldRows = (pane: Fold) => setLayout(previous => ({ ...previous, rows: previous.rows === pane ? null : pane }));
  const region = (name: Region): RegionControl => {
    const top = name === 'graph' || name === 'details', row: Fold = top ? 'first' : 'second';
    return { maximized: maximized === name, toggle: () => setMaximized(previous => previous === name ? null : name),
      fold: { folded: layout.rows === row, direction: top ? 'up' : 'down', label: top ? (task ? '图谱和任务详情' : '任务图谱') : '对话和文件区', toggle: () => foldRows(row) } };
  };
  const resetLayout = () => { setMaximized(null); setLayout(defaultLayout()); setLayoutReset(value => value + 1); };
  const resourceId = useId();
  const [lastModel, setLastModel] = useState(readModelPreference);
  const rememberModel = (choice: ModelPreference) => { saveModelPreference(choice); setLastModel({ provider: choice.provider, model: choice.model }); };
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [editing, setEditing] = useState<TaskView>();
  const [graphParent, setGraphParent] = useState<string>(), [newTask, setNewTask] = useState<NewTaskContext>();
  const [deleteCandidate, setDeleteCandidate] = useState<TaskView>();
  const [clearCandidate, setClearCandidate] = useState<TaskView>();
  const [dependencyCandidate, setDependencyCandidate] = useState<DependencyChangePreview>();
  const [completionCandidate, setCompletionCandidate] = useState<TaskView>();
  const [checklistOpen, setChecklistOpen] = useState(false);
  const [fileRefresh, setFileRefresh] = useState(0);
  const [snapshot, setSnapshot] = useState<{ snapshot: Snapshot; unavailableRefs: InputRef[] }>();
  const graphReady = graph?.project.id === projectId;
  // Autonomy: the open run of this project drives the toolbar button and graph marks; the panel can also show an ended run.
  const latestRun = useAutonomyRuns().get(projectId);
  const [runPanel, setRunPanel] = useState<string>(), [startingRun, setStartingRun] = useState(false);
  const autonomyButton = useRef<HTMLButtonElement>(null);
  const runDetail = useRunDetail(runPanel ?? (latestRun && isOpenRun(latestRun.state) ? latestRun.id : undefined));
  // The panel may show an older run; the button follows the project's newest run, with the fresher details when they match.
  const liveRun = runDetail.detail && runDetail.detail.id === latestRun?.id ? runDetail.detail : latestRun, openRun = liveRun && isOpenRun(liveRun.state) ? liveRun : undefined;
  const agentWork = useMemo(() => workerActivity(runDetail.detail), [runDetail.detail]);
  useEffect(() => {
    const sync = (event: StorageEvent) => { if (event.key === modelPreferenceStorageKey || event.key === null) setLastModel(readModelPreference()); };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  const activeTasks = useMemo(() => {
    const rows = graph?.project.id === projectId ? graph.tasks : [], byId = new Map(rows.map(row => [row.id, row])), hidden = new Map<string, boolean>();
    for (const task of rows) {
      const chain: string[] = [], seen = new Set<string>(); let cursor: string | undefined = task.id, archived = false;
      while (cursor && !seen.has(cursor)) {
        if (hidden.has(cursor)) { archived = hidden.get(cursor)!; break; }
        const row = byId.get(cursor); if (!row) break;
        chain.push(cursor); seen.add(cursor); if (row.archived) { archived = true; break; } cursor = row.parentId;
      }
      for (const id of chain) hidden.set(id, archived);
    }
    return rows.filter(row => !hidden.get(row.id));
  }, [graph?.tasks, graph?.project.id, projectId]);
  const workspaceKey = selected || `project:${projectId}`;
  const task = activeTasks.find(item => item.id === selected), draft = drafts[workspaceKey] ?? emptyDraft();
  const taskStateName = task && stateNames[task.state as SingleUserTaskState];
  const update = (value: Partial<Draft>) => setDrafts(previous => ({ ...previous, [workspaceKey]: { ...(previous[workspaceKey] ?? emptyDraft()), ...value } }));
  const refresh = useCallback(async () => {
    const generation = projectGeneration.current.value, request = ++graphRequest.current;
    const value = await api<ProjectGraph>(`graph?projectId=${encodeURIComponent(projectId)}`);
    if (currentProject.current === projectId && projectGeneration.current.value === generation && graphRequest.current === request) setGraph(value);
    return value;
  }, [projectId]);
  useEffect(() => {
    let alive = true; setGraph(undefined); setGraphParent(undefined); setEditing(undefined); setNewTask(undefined); setDeleteCandidate(undefined); setClearCandidate(undefined); setDependencyCandidate(undefined); setCompletionCandidate(undefined); setMessage('');
    void refresh().catch(error => { if (alive) setMessage(String(error)); });
    return () => { alive = false; };
  }, [projectId, refresh]);
  useEffect(() => {
    if (!selected) setGraphParent(undefined);
    else if (task && task.id !== graphParent && task.parentId !== graphParent) setGraphParent(task.parentId);
  }, [selected, task?.id, task?.parentId, graphParent]);
  useEffect(() => { if (graph?.project.id === projectId && selected && !task) onSelectTask(''); }, [graph, projectId, selected, task?.id, onSelectTask]);
  useEffect(() => { setSnapshot(undefined); setResource('file'); setChecklistOpen(false); }, [selected, task?.id]);
  useEffect(() => {
    let alive = true; setSnapshot(undefined);
    if (task?.pendingAction !== 'delete' && task?.pendingAction !== 'clear' && (task?.completedId || task?.candidateId || task?.acceptedId)) void api<{ snapshot: Snapshot; unavailableRefs: InputRef[] }>(`snapshot?taskId=${encodeURIComponent(selected)}`).then(value => {
      if (!alive) return;
      setSnapshot(value);
    }, error => { if (alive) setMessage(String(error)); });
    return () => { alive = false; };
  }, [selected, task?.revision]);
  const select = (id: string) => { onSelectTask(id); setMessage(''); };
  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setMessage('');
    try { await operation(); await onProjectUpdate(); } catch (error) { setMessage(error instanceof Error ? error.message : '操作失败'); }
    finally { try { await refresh(); } catch (error) { setMessage(String(error)); } setBusy(false); }
  };
  const applyDependencies = async (request: DependencyChangeRequest) => {
    const generation = projectGeneration.current.value;
    await run(async () => {
      const { kind, ...body } = request;
      const preview = await api<DependencyChangePreview>(kind === 'set' ? 'dependencies/preview' : 'dependencies/reconnect/preview', body);
      if (currentProject.current !== projectId || projectGeneration.current.value !== generation) return;
      if (preview.requiresConfirmation) setDependencyCandidate(preview);
      else await api(dependencyChangeEndpoint(preview), dependencyChangePayload(preview));
    });
  };
  const action = (action: 'resume') => { if (task) void run(async () => { await api('task/action', { id: task.id, revision: task.revision, action }); setMessage('已恢复编辑，旧快照保留。'); }); };
  const pageChats = status.chats.flatMap(chat => {
    if (!graphReady) return [];
    if (!selected) return chat.scope === 'project' && chat.projectId === projectId ? [{ ...chat, taskId: workspaceKey, taskLabel: `${graph!.project.title} · 项目需求` }] : [];
    return task?.kind === 'task' && chat.scope !== 'project' && chat.taskId === task.id ? [{ ...chat, taskId: workspaceKey, taskLabel: `${task.code} ${task.title}` }] : [];
  });
  // A remembered conversation must belong to this page; an explicit empty ID
  // keeps its unsent new-conversation draft selected instead of opening history.
  const chatId = draft.chatId === '' ? '' : pageChats.find(chat => chat.id === draft.chatId)?.id ?? pageChats[0]?.id;
  const chatDraftKey = chatId || `new:${workspaceKey}`;
  const chatMessage = chatMessages[chatDraftKey] ?? '';
  const selectChat = (id: string) => {
    if (!id) { update({ chatId: '' }); return; }
    const chat = pageChats.find(row => row.id === id);
    if (!chat) return;
    update({ chatId: id });
  };
  const choices: ModelChoice[] = (models?.providers ?? []).flatMap(row => row.models.map(item => ({ provider: row.id, providerName: row.name, model: item.id, supportsImages: item.supportsImages })));
  if (status.providers.some(row => row.id === 'studio-smoke')) choices.push({ provider: 'studio-smoke', providerName: '本机测试适配器', model: 'm1-smoke' });
  if (status.providers.some(row => row.id === 'studio-vision-smoke')) choices.push({ provider: 'studio-vision-smoke', providerName: '本机视觉测试适配器', model: 'vision-smoke', supportsImages: true });
  const rememberedChoice = availableModelPreference(lastModel, choices);
  const canWork = !!task && task.kind === 'task' && !task.isFolder && task.writable;
  const canDiscuss = !!task && task.kind === 'task' && task.canDiscuss;
  const resumePending = !!task?.pending && task.pendingAction === 'resume';
  const deletePending = !!task?.pending && task.pendingAction === 'delete';
  const clearPending = !!task?.pending && task.pendingAction === 'clear';
  const ownsClear = clearPending && task?.pendingOwnerId === task?.id;
  const canClear = !!task && !task.archived && (!task.pending || ownsClear);
  const dependencyPending = !!task?.pending && task.pendingAction === 'dependencies';
  const isCompletionGroup = !!task && (task.isFolder || task.kind === 'group');
  const ownsDelete = deletePending && task?.pendingOwnerId === task?.id;
  const ownsResume = resumePending && task?.pendingOwnerId === task?.id && !isCompletionGroup && task?.state === 'completed';
  const canFinish = !!task && ['unstarted', 'working', 'recheck'].includes(task.state) && (!task.pending || task.pendingAction === 'complete') && (!task.pendingOwnerId || task.pendingOwnerId === task.id);
  const activeChildren = activeTasks.filter(row => row.parentId === task?.id);
  const readyChildren = activeChildren.filter(row => row.state === 'completed' && !!row.completedId && !row.pending && !row.blockers.length && !row.dependencyRepairRequired);
  const childrenReady = !isCompletionGroup || activeChildren.length > 0 && readyChildren.length === activeChildren.length;
  const syncChatWorkspace = useCallback(() => {
    if (currentProject.current !== projectId) return;
    setFileRefresh(previous => previous + 1);
    const generation = projectGeneration.current.value;
    void Promise.all([refresh(), onProjectUpdate()]).catch(error => { if (currentProject.current === projectId && projectGeneration.current.value === generation) setMessage(error instanceof Error ? error.message : '项目刷新失败'); });
  }, [projectId, refresh, onProjectUpdate]);
  const narrow = () => window.matchMedia('(max-width: 700px)').matches;
  /** Follow the run panel into a task, and into one of its conversations, making sure the conversation is on screen. */
  const openTask = (taskId: string) => {
    setMaximized(null); select(taskId);
    if (narrow()) setRunPanel(undefined);
  };
  const openChat = (chatId: string, taskId?: string) => {
    const chat = status.chats.find(row => row.id === chatId), owner = chat ? chat.scope === 'project' ? '' : chat.taskId ?? '' : taskId ?? '';
    setDrafts(previous => { const key = owner || `project:${projectId}`; return { ...previous, [key]: { ...(previous[key] ?? emptyDraft()), chatId } }; });
    setMaximized(null); setLayout(previous => ({ ...previous, rows: previous.rows === 'second' ? null : previous.rows, bottom: previous.bottom === 'first' ? null : previous.bottom }));
    select(owner);
    if (narrow()) setRunPanel(undefined);
  };
  const runStarted = (run: RunDetail) => {
    noteAutonomyRun(run); runDetail.accept(run); setStartingRun(false); setRunPanel(run.id);
    void onProjectUpdate().catch(() => undefined);
  };
  const chatPane = graphReady && (!selected || task?.kind === 'task') && <ChatPane key={`${workspaceKey}:${task?.dataGeneration ?? 0}`} region={region('chat')} projectId={projectId} taskId={workspaceKey} taskLabel={task ? `${task.code} ${task.title}` : `${graph?.project.title ?? ''} · 项目需求`} contextKind={task ? 'task' : 'project'} chatId={chatId} canWork={!selected || canDiscuss} disabledCopy={clearPending ? '清空尚未完成，相关节点已冻结。请在任务信息区域重新确认清空。' : dependencyPending ? '依赖调整尚未完成，相关任务已冻结。请在任务信息区域重新确认调整。' : deletePending ? '删除尚未完成，节点已冻结。请在任务信息区域重新确认删除。' : resumePending ? '继续修改尚未完成，请在任务信息区域重试继续修改。' : task?.state === 'completed' ? isCompletionGroup ? '任务组已完成；如需调整，请在子任务中继续修改，再逐层确认任务组。' : '任务已完成，点击“继续修改”后可继续对话。' : task?.pending ? '任务操作处理中，稍后可继续对话。' : undefined} busy={busy} message={chatMessage} onMessage={message => setChatMessages(previous => ({ ...previous, [chatDraftKey]: message }))} choices={choices} provider={rememberedChoice?.provider ?? ''} model={rememberedChoice?.model ?? ''}
          chats={pageChats} onSelectChat={selectChat} onSelectModel={choice => { rememberModel(choice); update({ chatId: '' }); }}
          onSend={async (provider, model, attachments) => { let accepted = false; await run(async () => { const value = await api<{ id: string }>('chat', { ...(task ? { taskId: task.id } : { projectId }), provider, model, message: chatMessage, ...(attachments.length ? { attachments } : {}), ...(chatId ? { id: chatId } : {}) }); accepted = true; rememberModel({ provider, model }); update({ chatId: value.id }); setChatMessages(previous => ({ ...previous, [chatDraftKey]: '' })); }); return accepted; }}
          onSettled={syncChatWorkspace}
          onWorkspaceChanged={syncChatWorkspace}
          onStop={async id => { await run(async () => { await api('chat/stop', { id }); }); }} />;
  const taskMetadata = task && <section className={`task-metadata${task.checklist.length > 1 ? ' has-checklist' : ''}`} aria-label="任务信息">
        <div className="task-metadata-scroll"><dl className="task-metadata-fields">
          <div className="task-metadata-description-field"><dt>描述与目标</dt><dd className="task-metadata-description" role="region" aria-label="任务描述与目标" tabIndex={0}>{task.goal || <span className="task-metadata-empty">尚未填写</span>}</dd></div>
          <div className="task-metadata-checklist-field"><dt><span>Checklist <span className="task-checklist-count">{task.checklist.length} 项</span></span>{task.checklist.length > 0 && <button type="button" className="task-checklist-expand" aria-label={`查看完整 Checklist（${task.checklist.length} 项）`} onClick={() => setChecklistOpen(true)}>查看全部<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3H3v3m7-3h3v3M3 10v3h3m4 0h3v-3" /></svg></button>}</dt><dd className="task-metadata-checklist-region" role="region" aria-label={`Checklist，${task.checklist.length} 项验收要求`} tabIndex={0}>{task.checklist.length ? <TaskChecklistList task={task} manifest={snapshot} /> : <span className="task-metadata-empty">尚未添加验收要求</span>}</dd></div>
        </dl>
        {task.state === 'recheck' && <div className="task-recheck-notice" role="status"><strong>待复核</strong><p>{task.recheckReason || '前序节点有修正，请手动复核'}</p><small>旧快照仅作为历史保留。请先完成前序任务，再检查文件和目标，逐项确认完成。</small></div>}
        {!!task.blockers.length && <p className="task-warning">{task.blockers.join('；')}</p>}{task.pending && <p className="task-warning">{task.pending}</p>}

          {task.pending && task.pendingOwnerId && task.pendingOwnerId !== task.id && !activeTasks.some(row => row.id === task.pendingOwnerId) && <small>发起任务当前不可用，请刷新项目后重试。</small>}
          {task.pending && <small>{clearPending ? '清空未完成，相关节点保持冻结，请重新确认后重试。' : dependencyPending ? '依赖调整未完成，请重新预览影响范围并确认后重试。' : deletePending ? '删除未完成，相关节点保持冻结，请使用下方入口重新确认后重试。' : canFinish ? '结果尚未保存成功，请点击“完成工作”重新预览并确认。' : '当前操作尚未完成，请使用下方入口处理。'}</small>}
          {task.dependencyRepairRequired && <p className="task-warning">上游任务已被删除。请在图谱中调整连线，再右键节点选择「确认当前依赖」；上游依赖仍待修复时，本任务会继续阻塞。</p>}
          {isCompletionGroup && <small className="task-folder-completion-note">直属子节点已完成 {readyChildren.length} / {activeChildren.length}。{task.pending ? '当前操作尚未完成，请先使用恢复入口处理。' : task.state === 'completed' ? '当前任务组已确认完成。子任务重新修改后，需要重新检查并确认本组。' : childrenReady ? '请点击「完成工作」，检查当前任务组的文件、Checklist 和总体目标。' : activeChildren.length ? '请先完成全部子任务和子任务组；每一层任务组都需要单独确认完成。' : '请先添加子任务，当前任务组才能完成。'}</small>}
        </div>
        <div className="task-actions">{canFinish && <button disabled={busy || !childrenReady} title={!childrenReady ? '全部直属子任务和子任务组已完成后，才能完成当前任务组' : undefined} onClick={() => setCompletionCandidate(task)}>{task.state === 'recheck' ? '复核并完成' : '完成工作'}</button>}
          {!isCompletionGroup && task.state === 'completed' && !deletePending && (!resumePending || ownsResume) && <button disabled={busy || !!task.pending && !ownsResume} onClick={() => action('resume')}>{ownsResume ? '重试继续修改' : '继续修改'}</button>}
          {canClear && <button className="task-clear-action" disabled={busy} onClick={() => setClearCandidate(task)}>{ownsClear ? '重新确认清空' : '清空进展…'}</button>}
          {clearPending && !ownsClear && activeTasks.some(row => row.id === task.pendingOwnerId) && <button disabled={busy} onClick={() => select(task.pendingOwnerId!)}>前往清空发起任务</button>}
          {deletePending && (ownsDelete || activeTasks.some(row => row.id === task.pendingOwnerId)) && <button disabled={busy} onClick={() => ownsDelete ? setDeleteCandidate(task) : task.pendingOwnerId && select(task.pendingOwnerId)}>{ownsDelete ? '重新确认删除' : '前往删除发起任务'}</button>}
          {resumePending && !ownsResume && activeTasks.some(row => row.id === task.pendingOwnerId) && <button disabled={busy} onClick={() => select(task.pendingOwnerId!)}>前往发起任务</button>}
          {dependencyPending && <button disabled={busy || !task.pendingDependencyRequest && !activeTasks.some(row => row.id === task.pendingOwnerId)} onClick={() => task.pendingDependencyRequest ? void applyDependencies(task.pendingDependencyRequest) : task.pendingOwnerId && select(task.pendingOwnerId)}>{task.pendingDependencyRequest ? '重新确认依赖调整' : '前往依赖调整发起任务'}</button>}
          {task.pending && !resumePending && !deletePending && !clearPending && !dependencyPending && task.pendingOwnerId && task.pendingOwnerId !== task.id && activeTasks.some(row => row.id === task.pendingOwnerId) && <button disabled={busy} onClick={() => select(task.pendingOwnerId!)}>前往结果保存发起任务</button>}
        </div>
      </section>;
  const resourceRegion = region('resources');
  const resourcePane = task && <div className="resource-panel"><nav className="resource-tabs" role="tablist" aria-label="任务资源" onDoubleClick={onTitleBarDoubleClick(resourceRegion)} onKeyDown={event => {
    const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : event.key === 'ArrowRight' ? tabs[(index + 1) % tabs.length] : event.key === 'ArrowLeft' ? tabs[(index - 1 + tabs.length) % tabs.length] : undefined;
    if (next) { event.preventDefault(); next.click(); next.focus(); }
  }}><button id={`${resourceId}-file-tab`} role="tab" aria-selected={resource === 'file'} aria-controls={`${resourceId}-file-panel`} tabIndex={resource === 'file' ? 0 : -1} onClick={() => setResource('file')}>任务文件</button><button id={`${resourceId}-project-tab`} role="tab" aria-selected={resource === 'project'} aria-controls={`${resourceId}-project-panel`} tabIndex={resource === 'project' ? 0 : -1} onClick={() => setResource('project')}>项目文件</button>{!noSoftware && <button id={`${resourceId}-software-tab`} role="tab" aria-selected={resource === 'software'} aria-controls={`${resourceId}-software-panel`} tabIndex={resource === 'software' ? 0 : -1} onClick={() => setResource('software')}>软件</button>}<div className="region-actions"><RegionButtons control={resourceRegion} name={noSoftware ? '文件区' : '文件与软件区'} /></div></nav>
        <div className={`resource-scroll${resource === 'project' || resource === 'file' ? ' is-project-files' : ' is-software'}`}>
        {!noSoftware && <div className="software-resource" id={`${resourceId}-software-panel`} role="tabpanel" aria-labelledby={`${resourceId}-software-tab`} hidden={resource !== 'software'}><SoftwarePanel key={`${task.id}:${task.dataGeneration ?? 0}`} task={task} active={resource === 'software'} chatId={chatId ?? ''} chats={pageChats.map(chat => chat.id)} onSelectChat={selectChat} onArtifactsSaved={syncChatWorkspace} /></div>}
        <div className="file-resource" id={`${resourceId}-file-panel`} role="tabpanel" aria-labelledby={`${resourceId}-file-tab`} hidden={resource !== 'file'}>
        {task.kind === 'task' ? <TaskFilesPanel key={`${task.id}:${task.dataGeneration ?? 0}`} projectId={projectId} task={task} tasks={activeTasks} snapshot={snapshot?.snapshot} refreshVersion={fileRefresh + (graph?.project.revision ?? 0)} draft={draft.fileDraft} onDraftChange={fileDraft => update({ fileDraft })} onSaved={savedDraft => {
          setDrafts(previous => previous[workspaceKey]?.fileDraft === savedDraft ? { ...previous, [workspaceKey]: { ...previous[workspaceKey], fileDraft: undefined } } : previous);
          syncChatWorkspace();
        }} completionRecord={snapshot ? <details className="file-completion-record" key={snapshot.snapshot.id}><summary>已提交文件与完成记录{snapshot.snapshot.humanConfirmation?.actor === 'agent' && <span className="completion-actor-tag">由 Agent 确认</span>}</summary><section className="task-completion completion-snapshot" aria-label="冻结结果">
        <h3>{task.state === 'completed' ? '完成快照' : '保留的旧快照'}</h3><small>{snapshot.snapshot.createdAt} · {snapshot.snapshot.id} · 只读</small>
        {(snapshot.unavailableRefs ?? []).length > 0 && <p className="task-warning">历史快照包含已删除的输入或子任务，不能作为当前有效结果。</p>}
        {snapshot.snapshot.humanConfirmation && <CompletionConfirmationRecord confirmation={snapshot.snapshot.humanConfirmation} />}
        {snapshot.snapshot.submittedFiles && <div className="completion-submitted-record" aria-label="已提交的工作文件"><small>文件提交于 {new Date(snapshot.snapshot.submittedFiles.submittedAt).toLocaleString()}</small><dl>{snapshot.snapshot.submittedFiles.files.map(file => <div key={file.path}><dt>{file.path}<DownloadButton className="completion-file-download" from={{ source: 'snapshot', taskId: task.id, snapshotId: snapshot.snapshot.id }} path={file.path} /></dt><dd>{file.description}</dd></div>)}</dl></div>}
        {!noSoftware && <TaskRecordings taskId={task.id} />}
        {snapshot.snapshot.childrenRefs?.map(row => <p key={row.taskId}>{graph?.tasks.find(child => child.id === row.taskId)?.title ?? row.taskId} · 完成版本 {row.snapshotId}</p>)}
        {snapshot.snapshot.measurements.map(row => <p key={row.criterionId}>{snapshot.snapshot.definition.criteria.find(criterion => criterion.id === row.criterionId)?.label ?? row.criterionId}：{typeof row.observed === 'boolean' ? row.observed ? '满足' : '不满足' : String(row.observed)} · 证据 {row.evidence}{row.note ? ` · ${row.note}` : ''}</p>)}
        <small>快照文件：{snapshot.snapshot.files.map(file => file.path).join('、') || '无直接文件'}</small>
      </section></details> : undefined} /> : <p className="resource-empty">工作文件保存在各个子任务中，请在「项目文件」中浏览。</p>}
        </div><div className="project-file-resource" id={`${resourceId}-project-panel`} role="tabpanel" aria-labelledby={`${resourceId}-project-tab`} hidden={resource !== 'project'}><ProjectFilesPanel key={projectId} projectId={projectId} tasks={activeTasks} refreshVersion={fileRefresh + (graph?.project.revision ?? 0)} /></div></div></div>;
  const detailsRegion = region('details');
  const detailsPane = task && <section className="task-details-panel" aria-label="任务详情">
    <header className="region-titlebar" onDoubleClick={onTitleBarDoubleClick(detailsRegion)}>
      <h3 title={`${task.code} ${task.title}`}><code>{task.code}</code>{task.title}</h3><span className="task-state-badge">{taskStateName}{task.completedBy === 'agent' ? ' · Agent 确认' : ''}{task.isFolder ? ` · ${task.leafStats.total} 个末端任务` : ''}</span>
      <div className="region-actions">{task.canEditMetadata && <button className="task-definition-button" disabled={busy} onClick={() => setEditing(task)}>编辑任务定义</button>}<RegionButtons control={detailsRegion} name="任务详情" /></div>
    </header>
    <div className="task-details-ids"><IdChip label="任务 ID" value={task.id} /></div>
    {taskMetadata}
  </section>;
  const graphPane = graph && graphReady ? <TaskGraph region={region('graph')} project={graph.project} tasks={graph.tasks} activity={activity} agentWork={agentWork} parentId={graphParent} selectedId={selected} disabled={busy || !!dependencyCandidate} onSelect={select} onOpen={id => { setGraphParent(id); select(id); }} onNavigate={id => { setGraphParent(id); select(id ?? ''); }} onAdd={setNewTask} onEdit={row => { select(row.id); setEditing(row); }} onDelete={setDeleteCandidate} onClear={setClearCandidate} onDependencies={(row, dependencies) => { void applyDependencies({ kind: 'set', id: row.id, revision: row.revision, projectRevision: graph.project.revision, dependencies }); }} onReconnect={(edge, connection) => { void applyDependencies({ kind: 'reconnect', projectId: graph.project.id, projectRevision: graph.project.revision, edge, connection }); }} /> : <section className="studio-graph" aria-label="项目任务图谱">正在加载图谱…</section>;
  // VS Code style: every divider is draggable, and dragging one to an edge collapses that side completely.
  const topRow = detailsPane ? <ResizableSplit className="workbench-top" direction="horizontal" label="调整任务图谱与任务详情的宽度" initialRatio={0.64} minFirst={260} minSecond={240} stackAt={900} storageKey="harnessstudio:layout:v2:top"
    collapsible="both" collapsed={layout.top} onCollapsedChange={top => setLayout(previous => ({ ...previous, top }))} resetKey={layoutReset} maximize={maximized === 'graph' ? 'first' : maximized === 'details' ? 'second' : undefined} first={graphPane} second={detailsPane} /> : graphPane;
  const bottomRow = !graph || !graphReady ? <div className="empty-workspace">正在加载项目…</div> : chatPane ? <ResizableSplit className="workbench-bottom" direction="horizontal" label={noSoftware ? '调整对话与文件区的宽度' : '调整对话与文件/软件区的宽度'} initialRatio={0.52} minFirst={300} minSecond={280} stackAt={640} stackedMinSecond={100} storageKey="harnessstudio:layout:v2:bottom"
    collapsible="both" collapsed={layout.bottom} onCollapsedChange={bottom => setLayout(previous => ({ ...previous, bottom }))} resetKey={layoutReset} maximize={maximized === 'chat' ? 'first' : maximized === 'resources' ? 'second' : undefined}
    first={chatPane} second={task ? resourcePane : <ProjectFilesPanel key={projectId} projectId={projectId} tasks={activeTasks} refreshVersion={fileRefresh + graph.project.revision} region={resourceRegion} />} /> : <div className="group-workspace">{resourcePane}</div>;
  return <>
    {checklistOpen && task && <TaskChecklistDialog key={task.id} task={task} manifest={snapshot} onClose={() => setChecklistOpen(false)} />}
    {!maximized && <div className="project-toolbar"><div><div className="project-title-row"><h2>{graphReady ? graph?.project.title : '加载项目…'}</h2><IdChip label="项目 ID" value={projectId} /></div><small>{graphReady ? graph?.project.goal : ''}</small></div><div className="project-toolbar-actions"><AutonomyButton run={openRun} buttonRef={autonomyButton} onClick={() => { if (openRun) setRunPanel(previous => previous === openRun.id ? undefined : openRun.id); else setStartingRun(true); }} /><button type="button" className="layout-reset" title="恢复各区域的默认大小，展开所有收起的区域" onClick={resetLayout}>恢复默认布局</button></div></div>}
    <div className="task-message workbench-message" role="status">{message}</div>
    <ResizableSplit className="workbench-rows" direction="vertical" label="调整上下两行的高度" initialRatio={0.34} minFirst={140} minSecond={220} storageKey="harnessstudio:layout:v2:rows"
      collapsible="both" collapsedSize={ROW_TITLE_HEIGHT} collapsed={layout.rows} onCollapsedChange={rows => setLayout(previous => ({ ...previous, rows }))} resetKey={layoutReset}
      maximize={maximized === 'graph' || maximized === 'details' ? 'first' : maximized ? 'second' : undefined} first={topRow} second={bottomRow} />
    {runPanel && <AutonomyPanel runId={runPanel} projectId={projectId} choices={choices} detail={runDetail.detail} error={runDetail.error} tasks={activeTasks} chats={status.chats} onChanged={run => { runDetail.accept(run); void onProjectUpdate().catch(() => undefined); }} onReload={runDetail.reload}
      onClose={() => { setRunPanel(undefined); autonomyButton.current?.focus({ preventScroll: true }); }} onOpenChat={openChat} onOpenTask={openTask} onStartNew={() => setStartingRun(true)} />}
    {startingRun && graphReady && <AutonomyStartDialog projectId={projectId} task={task && { id: task.id, code: task.code, title: task.title, isFolder: isCompletionGroup }} choices={choices} fallbackModel={rememberedChoice}
      lastRun={latestRun} onClose={() => setStartingRun(false)} onStarted={runStarted} onShowRun={id => { setStartingRun(false); setRunPanel(id); }} />}
    {dependencyCandidate && graphReady && <DependencyChangeDialog key={dependencyCandidate.impactVersion} preview={dependencyCandidate} taskNames={new Map(activeTasks.map(row => [row.id, `${row.code} ${row.title}`]))} onClose={() => { setDependencyCandidate(undefined); void refresh().catch(error => setMessage(String(error))); }} onBusyChange={setBusy} onApplied={async () => {
      if (currentProject.current !== dependencyCandidate.projectId) return;
      const generation = projectGeneration.current.value;
      setFileRefresh(previous => previous + 1);
      await Promise.all([refresh(), onProjectUpdate()]);
      if (currentProject.current !== dependencyCandidate.projectId || projectGeneration.current.value !== generation) return;
      setDependencyCandidate(undefined); setMessage('依赖已调整。请按前序顺序逐项复核受影响的任务。');
    }} />}
    {newTask && graph && <QuickTaskDialog projectId={projectId} context={newTask} onClose={() => setNewTask(undefined)} onSaved={async row => {
      if (currentProject.current !== row.projectId) return;
      setGraph(previous => previous?.project.id === row.projectId ? { ...previous, tasks: [...previous.tasks.filter(task => task.id !== row.id), row] } : previous);
      setGraphParent(row.parentId); select(row.id); setResource('file'); setEditing(row);
      try { await Promise.all([refresh(), onProjectUpdate()]); }
      catch (error) { setMessage(`任务已创建，项目刷新失败：${error instanceof Error ? error.message : '请刷新页面'}`); }
    }} />}
    {editing && graph && <TaskEditor key={editing.id} initial={editing} onClose={() => setEditing(undefined)} onSaved={async row => {
      if (currentProject.current !== row.projectId) return;
      setGraph(previous => previous?.project.id === row.projectId ? { ...previous, tasks: previous.tasks.map(task => task.id === row.id ? row : task) } : previous);
      select(row.id);
      try { await Promise.all([refresh(), onProjectUpdate()]); }
      catch (error) { setMessage(`任务定义已保存，项目刷新失败：${error instanceof Error ? error.message : '请刷新页面'}`); }
    }} />}
    {completionCandidate && <TaskCompletionDialog key={`${completionCandidate.projectId}:${completionCandidate.id}`} task={completionCandidate} onClose={() => setCompletionCandidate(undefined)} onBusyChange={setBusy} onCompleted={async (completed, warning) => {
      setCompletionCandidate(undefined);
      if (currentProject.current !== completed.projectId) return;
      setGraph(previous => previous?.project.id === completed.projectId ? { ...previous, tasks: previous.tasks.map(row => row.id === completed.id ? completed : row) } : previous);
      setResource('file'); setFileRefresh(previous => previous + 1); setMessage(warning ? `任务已完成，结果已保存。${warning}` : '任务已完成，结果已保存为冻结快照。');
      try { await Promise.all([refresh(), onProjectUpdate()]); }
      catch (error) { setMessage(`任务已完成，项目刷新失败：${error instanceof Error ? error.message : '请刷新页面'}`); }
    }} />}
    {clearCandidate && <TaskClearDialog key={`${projectId}:${clearCandidate.id}`} task={clearCandidate} onClose={() => setClearCandidate(undefined)} onBusyChange={setBusy} onCleared={async result => {
      const cleared = result.task;
      const removedChats = new Set(status.chats.filter(row => row.taskId === cleared.id && row.scope !== 'project').map(row => row.id));
      forgetChatAttachmentDrafts([...removedChats, `new:${cleared.id}`]);
      setDrafts(previous => ({ ...previous, [cleared.id]: { chatId: '' } }));
      setChatMessages(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => !removedChats.has(key) && key !== `new:${cleared.id}`)));
      setClearCandidate(undefined); setEditing(previous => previous?.id === cleared.id ? undefined : previous);
      setCompletionCandidate(previous => previous?.id === cleared.id ? undefined : previous);
      if (currentProject.current !== result.projectId) return;
      setGraph(previous => previous?.project.id === result.projectId ? { ...previous, tasks: previous.tasks.map(row => row.id === cleared.id ? cleared : row) } : previous);
      if (selected === cleared.id) { setSnapshot(undefined); setChecklistOpen(false); setResource('file'); }
      setFileRefresh(previous => previous + 1); setMessage('进展已清空，任务回到待执行；任务定义和图谱关系已保留。');
      try { await Promise.all([refresh(), onProjectUpdate()]); }
      catch (error) { setMessage(`清空已完成，项目刷新失败：${error instanceof Error ? error.message : '请刷新页面'}`); }
    }} />}
    {deleteCandidate && <TaskDeleteDialog key={`${projectId}:${deleteCandidate.id}`} task={deleteCandidate} onClose={() => setDeleteCandidate(undefined)} onBusyChange={setBusy} onDeleted={async result => {
      const removedChats = new Set(status.chats.filter(row => row.taskId === result.taskId && row.scope !== 'project').map(row => row.id));
      forgetChatAttachmentDrafts([...removedChats, `new:${result.taskId}`]);
      setDrafts(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => key !== result.taskId)));
      setChatMessages(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => !removedChats.has(key) && key !== `new:${result.taskId}`)));
      setDeleteCandidate(undefined); setEditing(previous => previous?.id === result.taskId ? undefined : previous);
      if (currentProject.current !== result.projectId) return;
      setGraph(previous => previous?.project.id === result.projectId ? { ...previous, tasks: previous.tasks.filter(row => row.id !== result.taskId) } : previous);
      if (selected === result.taskId) { setGraphParent(undefined); onSelectTask(''); }
      else if (graphParent === result.taskId) setGraphParent(deleteCandidate.parentId);
      setFileRefresh(previous => previous + 1); setMessage('任务及其工作空间已永久删除。');
      try { await Promise.all([refresh(), onProjectUpdate()]); }
      catch (error) { setMessage(`任务已永久删除，项目刷新失败：${error instanceof Error ? error.message : '请刷新页面'}`); }
    }} />}
  </>;
}
