import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { JsonText } from './json-viewer.tsx';
import { BinaryPreview } from './file-download.tsx';
import type { ProjectWorkspaceFilePreview, SnapshotFile, TaskCompletionPreview, TaskCompletionResult, TaskView } from '@harnessstudio/studio/domain-types';
import { currentStateNames } from '@harnessstudio/studio/domain-types';
import { api } from './api.ts';
import { useNoSoftware } from './software-backend.ts';
import { completionColumnStorageKey, moveCompletionColumn, readCompletionColumnOrder, saveCompletionColumnOrder, type CompletionColumn } from './completion-columns.ts';
import { completionFileState, formatFileSize, isSubmittedFile } from './completion-files.ts';
import { descriptionDraftValue, descriptionPlaceholder, descriptionSubmissionFiles, hasDescriptionEdit, mergeDescriptionHints, missingEditedDescriptions, type DescriptionFile, type FileDescriptionDrafts } from './completion-descriptions.ts';

const errorText = (error: unknown) => error instanceof Error ? error.message : '无法读取完成预览';
const columnNames: Record<CompletionColumn, string> = { select: '选择', name: '文件名', status: '状态', bytes: '文件大小', createdAt: '创建时间', modifiedAt: '修改时间' };
const fileDate = (value?: string) => {
  if (!value || Number.isNaN(Date.parse(value))) return '—';
  return new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
};

export function CompletionDescriptionInput({ file, drafts, disabled, invalid, errorId, onChange }: {
  file: DescriptionFile; drafts: FileDescriptionDrafts; disabled: boolean; invalid: boolean; errorId: string; onChange(text: string): void;
}) {
  return <><textarea aria-label={`${file.path} 的文件说明`} aria-invalid={invalid} aria-describedby={invalid ? errorId : undefined}
    value={descriptionDraftValue(drafts, file.path)} placeholder={descriptionPlaceholder(file)} maxLength={2000} disabled={disabled} rows={2}
    onChange={event => onChange(event.target.value)} /><small className="completion-section-note">{hasDescriptionEdit(drafts, file.path) ? '使用你填写的说明' : file.submissionDescription?.status === 'pending' ? '正在完善自动说明；未填写时使用当前提示' : '未填写时使用自动说明'}</small></>;
}

export function TaskCompletionDialog({ task, onClose, onBusyChange, onCompleted }: {
  task: TaskView; onClose(): void; onBusyChange(busy: boolean): void; onCompleted(task: TaskView, warning?: string): Promise<void>;
}) {
  const titleId = useId(), descriptionId = useId(), submissionErrorId = useId(), noFilesTitleId = useId(), noFilesDescriptionId = useId(), overallGoalTitleId = useId();
  const [preview, setPreview] = useState<TaskCompletionPreview>(), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [submitting, setSubmitting] = useState(false), [error, setError] = useState('');
  const [checked, setChecked] = useState<Set<string>>(new Set()), [completed, setCompleted] = useState<TaskView>();
  const [completedWarning, setCompletedWarning] = useState<string>();
  // vm_manager storage: completion first stops the task's VMs, then freezes its D: drive.
  const [vmMode, setVmMode] = useState(false), [vmActive, setVmActive] = useState(0), [vmProgress, setVmProgress] = useState('');
  // The no-software mode has a shared folder too, but no VMs to stop or D: drive to freeze.
  const noSoftware = useNoSoftware();
  useEffect(() => {
    let valid = true;
    if (noSoftware) { setVmMode(false); return; }
    void api<{ enabled: boolean }>(`project/shared/status?${new URLSearchParams({ projectId: task.projectId })}`).then(async value => {
      if (!valid || !value.enabled) return; setVmMode(true);
      const { seats } = await api<{ seats: { backend?: string; state: string }[] }>(`software/seats?${new URLSearchParams({ taskId: task.id })}`);
      if (valid) setVmActive(seats.filter(row => row.backend === 'vm-manager' && ['provisioning', 'ready', 'stopping'].includes(row.state)).length);
    }).catch(() => undefined);
    return () => { valid = false; };
  }, [task.id, task.projectId, noSoftware]);
  useEffect(() => {
    if (!vmMode || !busy) { setVmProgress(''); return; }
    let valid = true;
    const poll = () => { void api<{ progress: { detail: string } | null }>(`software/progress?${new URLSearchParams({ taskId: task.id })}`).then(value => { if (valid && value.progress) setVmProgress(value.progress.detail); }, () => undefined); };
    poll(); const timer = setInterval(poll, 1500);
    return () => { valid = false; clearInterval(timer); };
  }, [vmMode, busy, task.id]);
  const [withoutFilesPrompt, setWithoutFilesPrompt] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set()), [descriptions, setDescriptions] = useState<Record<string, string>>({}), [preparingSubmission, setPreparingSubmission] = useState(false);
  const [showAllSubmitted, setShowAllSubmitted] = useState(false), [submissionNotice, setSubmissionNotice] = useState('');
  const [submissionError, setSubmissionError] = useState(''), [missingDescriptions, setMissingDescriptions] = useState<Set<string>>(new Set());
  const [previewStale, setPreviewStale] = useState(false), [descriptionNotice, setDescriptionNotice] = useState('');
  const [columns, setColumns] = useState(readCompletionColumnOrder), [draggedColumn, setDraggedColumn] = useState<CompletionColumn>();
  const [selectedPath, setSelectedPath] = useState<string>(), [file, setFile] = useState<ProjectWorkspaceFilePreview>(), [fileLoading, setFileLoading] = useState(false), [fileError, setFileError] = useState('');
  const form = useRef<HTMLFormElement>(null), cancel = useRef<HTMLButtonElement>(null), confirmButton = useRef<HTMLButtonElement>(null), submissionEditor = useRef<HTMLElement>(null), noFilesDialog = useRef<HTMLDivElement>(null), noFilesCancel = useRef<HTMLButtonElement>(null), selectAll = useRef<HTMLInputElement>(null), alive = useRef(true), request = useRef(0), fileRequest = useRef(0);
  const hintRequest = useRef(0), latestPreview = useRef<TaskCompletionPreview>(); latestPreview.current = preview;
  const latestDraft = useRef({ paths: [] as string[], descriptions: {} as FileDescriptionDrafts, preparing: false });
  latestDraft.current = { paths: [...selectedFiles], descriptions, preparing: preparingSubmission };
  const applyPreview = useCallback((value: TaskCompletionPreview) => {
    hintRequest.current++; latestPreview.current = value; latestDraft.current = { paths: [], descriptions: {}, preparing: false };
    setPreview(value); setChecked(new Set()); setWithoutFilesPrompt(false);
    setSelectedFiles(new Set()); setPreparingSubmission(false);
    setDescriptions({}); setPreviewStale(false); setDescriptionNotice('');
    setSubmissionError(''); setMissingDescriptions(new Set());
  }, []);
  const loadPreview = useCallback(async (notice = '', draft?: { paths: string[]; descriptions: Record<string, string>; preparing: boolean }) => {
    const preserved = draft ?? latestDraft.current;
    const sequence = ++request.current;
    hintRequest.current++; latestPreview.current = undefined;
    setPreview(undefined); setChecked(new Set()); setWithoutFilesPrompt(false); setSelectedFiles(new Set(preserved.paths)); setDescriptions(preserved.descriptions); setPreparingSubmission(preserved.preparing); setSubmissionError(''); setMissingDescriptions(new Set()); setSubmissionNotice('');
    setSelectedPath(undefined); setFile(undefined); setFileError(''); setLoading(true); setError(notice); setPreviewStale(false); setDescriptionNotice('');
    try {
      const value = await api<TaskCompletionPreview>(`task/completion?taskId=${encodeURIComponent(task.id)}`);
      if (alive.current && sequence === request.current) {
        applyPreview(value);
        const paths = preserved.paths.filter(path => value.files.some(row => row.path === path && !isSubmittedFile(row, value.submittedFiles)));
        const retained = { paths, descriptions: preserved.descriptions, preparing: preserved.preparing && !!paths.length };
        latestDraft.current = retained;
        setSelectedFiles(new Set(paths)); setDescriptions(retained.descriptions); setPreparingSubmission(retained.preparing);
      }
    } catch (error) {
      if (alive.current && sequence === request.current) setError([notice, errorText(error)].filter(Boolean).join('；'));
    } finally { if (alive.current && sequence === request.current) setLoading(false); }
  }, [task.id, applyPreview]);
  useEffect(() => {
    alive.current = true; const previous = document.activeElement; cancel.current?.focus(); void loadPreview();
    return () => { alive.current = false; request.current++; fileRequest.current++; hintRequest.current++; if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [loadPreview]);
  useEffect(() => {
    const changed = (event: StorageEvent) => { if (event.key === completionColumnStorageKey || event.key === null) setColumns(readCompletionColumnOrder()); };
    window.addEventListener('storage', changed); return () => window.removeEventListener('storage', changed);
  }, []);
  useEffect(() => {
    if (form.current) form.current.inert = withoutFilesPrompt;
    if (!withoutFilesPrompt) return;
    noFilesCancel.current?.focus();
    return () => {
      if (form.current) form.current.inert = false;
      if (confirmButton.current?.isConnected && !confirmButton.current.disabled) confirmButton.current.focus();
      else form.current?.focus();
    };
  }, [withoutFilesPrompt]);
  useEffect(() => {
    const selectableCount = preview?.files.filter(row => !isSubmittedFile(row, preview.submittedFiles)).length ?? 0;
    if (selectAll.current) selectAll.current.indeterminate = !!selectedFiles.size && selectedFiles.size < selectableCount;
  }, [selectedFiles, preview]);
  useEffect(() => { if (preparingSubmission && !loading) submissionEditor.current?.querySelector('textarea')?.focus(); }, [preparingSubmission, loading]);
  useEffect(() => {
    const sequence = ++fileRequest.current; setFile(undefined); setFileError(''); setFileLoading(!!selectedPath);
    if (selectedPath && preview) void api<ProjectWorkspaceFilePreview>(`project/file?${new URLSearchParams({ projectId: preview.projectId, taskId: preview.taskId, path: selectedPath })}`).then(value => {
      if (alive.current && sequence === fileRequest.current) setFile(value);
    }, error => { if (alive.current && sequence === fileRequest.current) setFileError(errorText(error)); }).finally(() => {
      if (alive.current && sequence === fileRequest.current) setFileLoading(false);
    });
    return () => { fileRequest.current++; };
  }, [preview?.projectId, preview?.taskId, preview?.workspaceVersion, selectedPath]);
  const humanGoals = preview?.goals.filter(goal => !goal.system) ?? [];
  const overallGoal = humanGoals.find(goal => goal.id === 'goal');
  const checklistGoals = humanGoals.filter(goal => goal.id !== 'goal');
  const allChecked = humanGoals.every(goal => checked.has(goal.id));
  const validSubmission = !!preview?.submittedFiles && preview.goals.some(goal => goal.system && goal.checked);
  const submittedRows = validSubmission ? preview!.submittedFiles!.files : [];
  const visibleSubmittedRows = showAllSubmitted ? submittedRows : submittedRows.slice(0, 4);
  const selectableFiles = preview?.files.filter(row => !isSubmittedFile(row, preview.submittedFiles)) ?? [];
  const pendingFiles = selectableFiles.length;
  const completionStateNames: Record<string, string> = currentStateNames(task.workflowMode);
  const isRecheck = preview?.isRecheck ?? task.state === 'recheck';
  const readyChildren = preview?.children.filter(child => child.ready).length ?? 0;
  const canConfirm = !!preview && !loading && !busy && !previewStale && !preview.blockers.length && allChecked && !selectedFiles.size && !preparingSubmission && !fileLoading && !fileError;
  const chosenRows = selectableFiles.filter(row => selectedFiles.has(row.path));
  const pendingDescription = preparingSubmission && chosenRows.some(row => (row as DescriptionFile).submissionDescription?.status === 'pending');
  useEffect(() => {
    if (!pendingDescription || loading || busy || completed || previewStale || !preview) return;
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined;
    const generation = ++hintRequest.current;
    const poll = async () => {
      const current = latestPreview.current;
      if (!current || disposed || !alive.current || generation !== hintRequest.current) return;
      try {
        const next = await api<TaskCompletionPreview>(`task/completion?taskId=${encodeURIComponent(current.taskId)}`);
        if (disposed || !alive.current || generation !== hintRequest.current) return;
        const merged = mergeDescriptionHints(current, next);
        if (!merged) { setPreviewStale(true); setDescriptionNotice('文件或任务信息已变化，请刷新预览后再提交。你填写的说明会保留。'); return; }
        latestPreview.current = merged; setPreview(merged); setDescriptionNotice('');
      } catch { if (!disposed && alive.current && generation === hintRequest.current) setDescriptionNotice('自动说明暂时未更新，可以使用当前提示或自行填写。'); }
      if (!disposed && alive.current && generation === hintRequest.current) timer = setTimeout(() => { void poll(); }, 1500);
    };
    void poll();
    return () => { disposed = true; hintRequest.current++; clearTimeout(timer); };
  }, [pendingDescription, loading, busy, !!completed, previewStale, preview?.taskId, preview?.taskRevision, preview?.workspaceVersion, preview?.childrenVersion, preview?.submittedFiles?.id]);
  const changeSelection = (path: string, selected: boolean) => {
    if (!selectableFiles.some(row => row.path === path)) return;
    setSubmissionError(''); setSubmissionNotice(''); setMissingDescriptions(new Set());
    setSelectedFiles(previous => { const next = new Set(previous); if (selected) next.add(path); else next.delete(path); return next; });
  };
  const reorder = (source: CompletionColumn, target: CompletionColumn) => {
    setColumns(previous => { const next = moveCompletionColumn(previous, source, target); saveCompletionColumnOrder(next); return next; });
  };
  const submitFiles = async () => {
    if (!preview || busy || completed || previewStale || !preparingSubmission) return;
    const missing = missingEditedDescriptions(chosenRows, descriptions);
    setMissingDescriptions(missing);
    if (!chosenRows.length || missing.size) { setSubmissionError(chosenRows.length ? '手动填写的文件说明不能为空，请填写后再提交。' : '请至少选择一个工作文件。'); return; }
    setBusy(true); setSubmitting(true); onBusyChange(true); setError(''); setSubmissionError('');
    try {
      const value = await api<TaskCompletionPreview>('task/completion/files', {
        taskId: preview.taskId, revision: preview.taskRevision, workspaceVersion: preview.workspaceVersion,
        files: descriptionSubmissionFiles(chosenRows, descriptions),
      });
      if (alive.current) { applyPreview(value); setSubmissionNotice(`已提交 ${chosenRows.length} 个文件，提交区快照已保存。`); }
    } catch (error) {
      if (alive.current) await loadPreview(`${errorText(error)}。已保留文件说明，请检查刷新后的文件再提交。`, { paths: [...selectedFiles], descriptions, preparing: true });
    } finally { if (alive.current) { setBusy(false); setSubmitting(false); } onBusyChange(false); }
  };
  const finish = async (confirmWithoutFiles = false) => {
    if (busy || (!completed && (!canConfirm || (!validSubmission && !confirmWithoutFiles)))) return;
    const confirmed = preview; setBusy(true); onBusyChange(true); setError('');
    let result = completed, warning = completedWarning;
    try {
      if (!result && confirmed) {
        const response = await api<TaskCompletionResult>('task/completion', {
          taskId: confirmed.taskId, revision: confirmed.taskRevision, workspaceVersion: confirmed.workspaceVersion,
          ...(confirmed.isFolder ? { childrenVersion: confirmed.childrenVersion } : {}),
          checkedGoalIds: humanGoals.filter(goal => checked.has(goal.id)).map(goal => goal.id),
          ...(confirmWithoutFiles ? { confirmWithoutFiles: true } : { submissionId: confirmed.submittedFiles?.id }),
        });
        result = response.task; warning = response.warning; if (alive.current) { setCompleted(result); setCompletedWarning(warning); }
      }
      if (result) await onCompleted(result, warning);
    } catch (error) {
      if (alive.current) {
        if (result) setError(`工作已经完成，但页面更新失败：${errorText(error)}。请重新加载任务。`);
        else await loadPreview(`${errorText(error)}。请重新查看文件和目标，并逐项确认后重试。`);
      }
    } finally { if (alive.current) { setBusy(false); setWithoutFilesPrompt(false); } onBusyChange(false); }
  };
  const requestFinish = () => {
    if (busy || (!completed && !canConfirm)) return;
    if (!completed && !validSubmission) setWithoutFilesPrompt(true);
    else void finish();
  };
  const renderCell = (row: SnapshotFile, column: CompletionColumn) => {
    if (column === 'select') { const submitted = isSubmittedFile(row, preview?.submittedFiles); return <input type="checkbox" aria-label={`选择提交文件：${row.path}`} title={submitted ? '已提交且未修改，无需重复提交' : undefined} checked={submitted || selectedFiles.has(row.path)} disabled={busy || !!completed || previewStale || preparingSubmission || submitted} onChange={event => changeSelection(row.path, event.target.checked)} />; }
    if (column === 'name') return <button className="completion-file-name" type="button" disabled={busy || !!completed} aria-pressed={selectedPath === row.path} aria-label={`预览工作区文件：${row.path}`} title={row.path} onClick={() => setSelectedPath(row.path)}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 2.5h6l4 4v11H5zM11 2.5v4h4" /></svg><span>{row.path}</span></button>;
    if (column === 'status') { const state = completionFileState(row, preview?.submittedFiles); const label = { pending: '待提交', submitted: '已提交', modified: '已修改' }[state]; return <span className={`completion-file-state${state === 'pending' ? '' : ` is-${state}`}`} title={state === 'modified' ? '文件在提交后有修改，可以重新提交' : undefined}><span aria-hidden="true">{state === 'submitted' ? '✓' : state === 'modified' ? '●' : '○'}</span>{label}</span>; }
    if (column === 'bytes') return <span className="completion-file-size" title={`${row.bytes.toLocaleString('zh-CN')} 字节`}>{formatFileSize(row.bytes)}</span>;
    return <time dateTime={row[column]} title={row[column]}>{fileDate(row[column])}</time>;
  };
  const renderHumanGoal = (goal: TaskCompletionPreview['goals'][number]) => <label key={goal.id}><input type="checkbox" checked={checked.has(goal.id)} disabled={busy || !!completed} onChange={event => { const selected = event.target.checked; setChecked(previous => { const next = new Set(previous); if (selected) next.add(goal.id); else next.delete(goal.id); return next; }); }} /><span>{goal.label}</span></label>;
  return <><div className="studio-dialog task-completion-dialog" role="dialog" aria-modal={!withoutFilesPrompt} aria-hidden={withoutFilesPrompt || undefined} aria-labelledby={titleId} aria-describedby={descriptionId} onKeyDown={event => {
    if (withoutFilesPrompt) return;
    if (event.key === 'Escape') { event.preventDefault(); if (!busy) onClose(); }
    if (event.key !== 'Tab') return;
    const items = [...form.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? []];
    if (!items.length) { event.preventDefault(); return; }
    const first = items[0]!, last = items[items.length - 1]!;
    if (event.shiftKey && (document.activeElement === first || !items.includes(document.activeElement as HTMLElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !items.includes(document.activeElement as HTMLElement))) { event.preventDefault(); first.focus(); }
  }}>
    <form ref={form} tabIndex={-1} aria-busy={busy || loading} onSubmit={event => { event.preventDefault(); requestFinish(); }}>
      <header className="completion-dialog-header"><span className="completion-dialog-symbol" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m7 12 3 3 7-7M20 12v7H4V4h12" /></svg></span><div><h2 id={titleId}>{isRecheck ? '复核并完成工作' : '确认完成工作'}</h2><p id={descriptionId}>先提交需要交付的文件，再根据提交区的成果逐项确认任务目标。</p></div></header>
      <div className="completion-dialog-target"><code>{preview?.code ?? task.code}</code><strong>{preview?.title ?? task.title}</strong></div>
      <div className="completion-dialog-body">
        {isRecheck && <div className="completion-recheck-note"><strong>{task.recheckReason || '前序节点有修正，请手动复核'}</strong><p>请依据当前前序任务的完成结果重新检查文件、Checklist 与总体目标。旧确认不会自动勾选；确认后会保存新的完成快照。</p></div>}
        {loading ? <p className="completion-loading" role="status">正在读取工作区文件和验收要求…</p> : preview && <>
          {preview.isFolder && <section className="completion-children" aria-label="子任务完成检查"><div className="completion-section-heading"><h3>子任务完成检查</h3><small>{readyChildren} / {preview.children.length} 个已完成</small></div><p className="completion-section-note">全部直属子任务和子任务组完成后，才能确认当前任务组。这里的状态由系统检查。</p><ul>{preview.children.map(child => <li key={child.taskId}><svg viewBox="0 0 20 20" aria-hidden="true">{child.isFolder ? <path d="M2.5 5h6l2 2h7v9h-15z" /> : <path d="M5 2.5h6l4 4v11H5zM11 2.5v4h4" />}</svg><div><span><code>{child.code}</code>{child.title}</span><small>{child.isFolder ? '子任务组' : '子任务'}{child.state === 'completed' && !child.ready ? ' · 完成结果当前不可用' : ''}</small></div><span className={`completion-child-state${child.ready ? ' is-ready' : ''}`}><span aria-hidden="true">{child.ready ? '✓' : '○'}</span>{completionStateNames[child.state] ?? child.state}</span></li>)}</ul>{!preview.children.length && <p className="completion-empty-files">当前任务组没有可检查的子任务。</p>}</section>}
          <div className="completion-review-columns">
            <section className="completion-files" aria-label="工作区文件预览"><div className="completion-section-heading"><h3>工作区文件 <span className="completion-zone-tag">暂存区</span></h3><small>{preview.files.length} 个文件{selectedFiles.size ? ` · 本次已选 ${selectedFiles.size} 个` : ''}</small></div><p className="completion-section-note">勾选文件后点击「提交」，可使用自动说明或自行填写，再保存到提交区。已提交且未修改的文件无需再选；已修改文件可重新提交。点击文件名可预览；拖动表头可调整列顺序。{preview.isFolder && '这里显示当前任务组自身的文件，子任务的完成结果会随任务组一并记录。'}</p>
              {preview.files.length ? <div className="completion-detail-table-scroll"><table className="completion-detail-table" aria-label="工作区文件详细信息"><colgroup>{columns.map(column => <col key={column} className={`completion-column-${column}`} />)}</colgroup><thead><tr>{columns.map((column, index) => <th key={column} scope="col" draggable={!busy && !completed} className={draggedColumn === column ? 'is-dragging' : undefined} onDragStart={event => { setDraggedColumn(column); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', column); }} onDragEnd={() => setDraggedColumn(undefined)} onDragOver={event => { if (draggedColumn && !busy && !completed) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } }} onDrop={event => { event.preventDefault(); if (draggedColumn && !busy && !completed) reorder(draggedColumn, column); setDraggedColumn(undefined); }}><div><button type="button" className="completion-column-handle" aria-label={`调整${columnNames[column]}列顺序`} title="拖动表头调整顺序，或使用左右方向键" disabled={busy || !!completed} onKeyDown={event => { const offset = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0; const target = columns[index + offset]; if (offset && target) { event.preventDefault(); reorder(column, target); } }}><svg viewBox="0 0 12 16" aria-hidden="true"><path d="M3 4h.01M8 4h.01M3 8h.01M8 8h.01M3 12h.01M8 12h.01" /></svg></button>{column === 'select' ? <input ref={selectAll} type="checkbox" aria-label="选择全部待提交或已修改文件" title={pendingFiles ? "只选择待提交或已修改的工作文件" : "所有工作文件均已提交且未修改"} checked={pendingFiles > 0 && selectedFiles.size === pendingFiles} disabled={busy || !!completed || previewStale || preparingSubmission || !pendingFiles} onChange={event => { setSubmissionError(''); setSubmissionNotice(''); setMissingDescriptions(new Set()); setSelectedFiles(new Set(event.target.checked ? selectableFiles.map(row => row.path) : [])); }} /> : <span>{columnNames[column]}</span>}</div></th>)}</tr></thead><tbody>{preview.files.map(row => <tr key={row.path} className={selectedFiles.has(row.path) ? 'is-selected' : undefined}>{columns.map(column => <td key={column}>{renderCell(row, column)}</td>)}</tr>)}</tbody></table></div> : <p className="completion-empty-files">当前工作区没有已保存文件；确认验收要求后，也可以无文件完成。</p>}
              {chosenRows.length > 0 && !preparingSubmission && <div className="completion-selection-actions"><span>{chosenRows.length} 个文件待提交</span><button type="button" disabled={busy || !!completed} onClick={() => { setSelectedFiles(new Set()); setSubmissionError(''); }}>取消选择</button><button className="completion-stage-submit" type="button" disabled={busy || !!completed || previewStale} onClick={() => { setPreparingSubmission(true); setSubmissionNotice(''); setSubmissionError(''); }}>提交</button></div>}
              {preparingSubmission && chosenRows.length > 0 && <section ref={submissionEditor} className="completion-submission" aria-label="待提交文件列表"><div className="completion-section-heading"><h3>待提交文件列表</h3><small>{chosenRows.length} 个</small></div><p className="completion-section-note">未填写时使用自动说明；手动输入后使用你填写的内容。确认提交后会保存独立快照，工作区仍可继续编辑。</p><div className="completion-submission-table-scroll"><table className="completion-submission-table"><thead><tr><th scope="col">文件名</th><th scope="col">文件说明</th></tr></thead><tbody>{chosenRows.map(row => <tr key={row.path}><td title={row.path}>{row.path}</td><td><CompletionDescriptionInput file={row} drafts={descriptions} invalid={missingDescriptions.has(row.path)} errorId={submissionErrorId} disabled={busy || !!completed} onChange={value => { setSubmissionError(''); setMissingDescriptions(previous => new Set([...previous].filter(path => path !== row.path))); setDescriptions(previous => ({ ...previous, [row.path]: value })); }} /></td></tr>)}</tbody></table></div><div className="completion-submission-actions"><span>本次选择会合并到提交区，同名文件更新提交版本。</span><button type="button" disabled={busy || !!completed} onClick={() => { setPreparingSubmission(false); setSelectedFiles(new Set()); setSubmissionError(''); setMissingDescriptions(new Set()); }}>取消提交</button><button className="completion-stage-submit" type="button" disabled={busy || !!completed || previewStale} onClick={() => { void submitFiles(); }}>{submitting ? '正在保存快照…' : '确认提交'}</button></div></section>}
              {descriptionNotice && <p className={previewStale ? 'completion-submission-error' : 'completion-section-note'} role="status">{descriptionNotice}</p>}
              {submissionNotice && <p className="completion-submission-notice" role="status"><span aria-hidden="true">✓</span>{submissionNotice}</p>}
              {submissionError && <p id={submissionErrorId} className="completion-submission-error" role="status">{submissionError}</p>}
              {selectedPath ? <section className="completion-file-preview" aria-label="所选文件内容"><header><strong>{selectedPath}</strong><button type="button" aria-label="关闭所选文件预览" disabled={busy} onClick={() => { setSelectedPath(undefined); cancel.current?.focus(); }}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" /></svg></button></header><div tabIndex={0}>{fileLoading ? <p role="status">正在读取文件…</p> : fileError ? <p role="status">{fileError}</p> : file?.status === 'text' ? <JsonText text={file.content} allowPrimitive={/\.json$/i.test(selectedPath)} fallback={<pre>{file.content || '（空文件）'}</pre>} /> : file && preview ? <BinaryPreview from={{ source: 'project', projectId: preview.projectId, taskId: preview.taskId }} path={selectedPath} bytes={file.bytes} tooLarge={file.status === 'tooLarge'} /> : null}</div></section> : preview.files.length > 0 && <p className="completion-file-prompt">点击文件名查看只读预览。</p>}
            </section>
            <section className="completion-goals" aria-label="任务目标确认"><div className="completion-section-heading"><h3>逐项确认目标</h3><small>{checked.size} / {humanGoals.length} 项已确认</small></div><p className="completion-section-note">按提交区的文件版本核对验收要求；没有提交文件时，完成前会再次询问。</p><div className="completion-goal-list">{checklistGoals.map(renderHumanGoal)}<div className="completion-submitted-goal"><label className="completion-system-goal"><input type="checkbox" aria-label="已提交工作文件" checked={validSubmission} disabled /><span>已提交工作文件<small>{validSubmission ? `提交区 · ${submittedRows.length} 个文件 · 快照已保存` : '可选；提交成功后由系统自动确认'}</small></span></label>{validSubmission && <div className="completion-committed-files" aria-label="提交区文件"><ul tabIndex={0} aria-label="已提交文件列表">{visibleSubmittedRows.map(row => <li key={row.path}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 2.5h6l4 4v11H5zM11 2.5v4h4" /></svg><div><strong title={row.path}>{row.path}</strong><p title={row.description}>{row.description}</p></div><small>{formatFileSize(row.bytes)}</small></li>)}</ul>{submittedRows.length > 4 && <button type="button" className="completion-show-submitted" aria-expanded={showAllSubmitted} disabled={busy || !!completed} onClick={() => setShowAllSubmitted(previous => !previous)}>{showAllSubmitted ? '收起列表' : `显示全部（${submittedRows.length} 个文件）`}</button>}<p className="completion-commit-note">后续工作区修改不会覆盖这些已提交版本。{pendingFiles > 0 && `当前工作区还有 ${pendingFiles} 个待提交或已修改的文件，完成快照仅包含提交区文件。`}</p></div>}</div></div>{overallGoal && <section className="completion-overall-goal" aria-labelledby={overallGoalTitleId}><h4 id={overallGoalTitleId}><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" /><circle cx="10" cy="10" r="3.5" /><circle cx="10" cy="10" r=".8" /></svg>该任务的总体目标</h4><div className="completion-goal-list">{renderHumanGoal(overallGoal)}</div></section>}</section>
          </div>
          {!!preview.blockers.length && <section className="completion-blockers" aria-label="当前无法完成的原因"><strong>当前还不能完成</strong><ul>{preview.blockers.map((blocker, index) => <li key={index}>{blocker}</li>)}</ul></section>}
          {preview.retry && <p className="completion-retry-note">上次保存尚未完成。请重新检查当前文件和目标，确认后继续保存。</p>}
          {!!selectedFiles.size && <p className="completion-file-prompt">请先提交所选文件，或取消选择，再确认完成任务。</p>}
          {preview.submissionWarning && <p className="completion-submission-error" role="status">{preview.submissionWarning}</p>}
        </>}
        {vmMode && !completed && <p className="vm-complete-progress" role="status">{busy && vmProgress ? `${vmProgress}…` : vmActive ? `本任务有 ${vmActive} 台虚拟机正在运行。确认完成后，Studio 会先让它们正常关机（软件中未保存的内容会丢失），再冻结 D 盘并生成快照，最长约需 3 分钟。请先在软件中保存。` : '完成后，本任务的 D 盘（任务文件）会被冻结为只读；选择继续修改时会自动解冻。'}</p>}
        {error && <p className="completion-dialog-error" role="status">{error}</p>}
      </div>
      <footer><button ref={cancel} type="button" disabled={busy} onClick={onClose}>取消</button>{!completed && <button type="button" disabled={busy || loading} onClick={() => { void loadPreview(); }}>刷新预览</button>}<button ref={confirmButton} className="completion-confirm-button" type="submit" disabled={busy || (!completed && !canConfirm)}>{busy && !submitting ? '正在保存…' : completed ? '重新加载任务' : isRecheck ? '确认复核并完成' : '确认完成'}</button></footer>
    </form>
  </div>{withoutFilesPrompt && <div className="studio-dialog completion-no-files-dialog" role="alertdialog" aria-modal="true" aria-labelledby={noFilesTitleId} aria-describedby={noFilesDescriptionId} onKeyDown={event => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); if (!busy) setWithoutFilesPrompt(false); return; }
    if (event.key !== 'Tab') return;
    const items = [...noFilesDialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []];
    const first = items[0], last = items[items.length - 1];
    if (!first || !last) { event.preventDefault(); return; }
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }}><div ref={noFilesDialog} className="completion-no-files-card" aria-busy={busy}>
    <span className="completion-no-files-symbol" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h4" /></svg></span>
    <h2 id={noFilesTitleId}>是否无提交文件</h2>
    <p id={noFilesDescriptionId}>当前没有有效的已提交文件。是否仍将此任务标记为已完成？</p>
    <p className="completion-no-files-note">工作区文件会保留，尚未提交的文件不会纳入完成快照。{chosenRows.length > 0 && '已选择的文件与说明也尚未提交。'}</p>
    <footer><button ref={noFilesCancel} type="button" disabled={busy} onClick={() => setWithoutFilesPrompt(false)}>返回检查</button><button className="completion-confirm-button" type="button" disabled={busy || !canConfirm} onClick={() => { void finish(true); }}>{busy ? '正在保存…' : '确认无文件完成'}</button></footer>
  </div></div>}</>;
}
