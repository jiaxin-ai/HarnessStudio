import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ProjectWorkspaceDirectory, Snapshot, TaskView, WorkspaceDirectoryListing, WorkspaceFilePreview } from '@harnessstudio/studio/domain-types';
import { api } from './api.ts';
import { FileTree, FileIcon, fileSize } from './file-tree.tsx';
import { useVmStorage } from './vm-panel.tsx';
import { BinaryPreview, DownloadButton, type FileSource } from './file-download.tsx';
import { FileActionDialog, UploadFileIcon, UploadFolderIcon, UploadStatus, droppedEntries, droppedItems, folderLabel, joinPath, nameProblem, parentFolder, useUploadPickers, useUploads } from './task-file-actions.tsx';
import { PreviewModeSwitch, TextFilePreview, renderKind } from './file-preview.tsx';

export interface TaskFileDraft { path: string; content: string; baseContent: string; version?: string; isNew?: boolean }
const errorText = (error: unknown) => error instanceof Error ? error.message : '文件操作失败';

/** Snapshot manifests contain files; derive only their actual ancestor folders. */
function snapshotDirectory(snapshot: Snapshot, path: string, offset: number): WorkspaceDirectoryListing {
  const prefix = path ? `${path}/` : '', rows = new Map<string, WorkspaceDirectoryListing['entries'][number]>();
  for (const file of snapshot.files) {
    if (!file.path.startsWith(prefix)) continue;
    const relative = file.path.slice(prefix.length), slash = relative.indexOf('/');
    const name = slash < 0 ? relative : relative.slice(0, slash);
    if (!name) continue;
    rows.set(name, slash < 0 ? { name, path: file.path, kind: 'file', bytes: file.bytes, modifiedAt: file.modifiedAt } : { name, path: `${prefix}${name}`, kind: 'directory' });
  }
  const entries = [...rows.values()].sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name, 'zh-CN', { numeric: true }) : a.kind === 'directory' ? -1 : 1);
  const limit = 100;
  return { path, entries: entries.slice(offset, offset + limit), offset, limit, total: entries.length, ...(offset + limit < entries.length ? { nextOffset: offset + limit } : {}) };
}
export function DiscardDraftDialog({ onCancel, onDiscard }: { onCancel(): void; onDiscard(): void }) {
  const form = useRef<HTMLFormElement>(null), cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => { const previous = document.activeElement; cancel.current?.focus(); return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); }; }, []);
  return <div className="studio-dialog file-discard-dialog" role="alertdialog" aria-modal="true" aria-labelledby="file-discard-title" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
    if (event.key !== 'Tab') return;
    const items = [...form.current?.querySelectorAll<HTMLButtonElement>('button') ?? []], first = items[0], last = items.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}><form ref={form} onSubmit={event => { event.preventDefault(); onDiscard(); }}><h2 id="file-discard-title">放弃未保存的修改？</h2><p>当前文件还有未保存的内容。可以继续编辑并保存后再切换。</p><footer><button ref={cancel} type="button" onClick={onCancel}>继续编辑</button><button type="submit">放弃修改</button></footer></form></div>;
}

export function TaskFilesPanel({ projectId, task, tasks, snapshot, refreshVersion, draft, onDraftChange, onSaved, completionRecord }: {
  projectId: string; task: TaskView; tasks: TaskView[]; snapshot?: Snapshot; refreshVersion: number;
  draft?: TaskFileDraft; onDraftChange(draft?: TaskFileDraft): void; onSaved(savedDraft: TaskFileDraft): void; completionRecord?: ReactNode;
}) {
  const [scope, setScope] = useState(''), [selected, setSelected] = useState(draft?.isNew ? '' : draft?.path ?? '');
  const [refresh, setRefresh] = useState(0), [manifest, setManifest] = useState<Snapshot>(), [manifestLoading, setManifestLoading] = useState(false), [manifestError, setManifestError] = useState('');
  const [preview, setPreview] = useState<WorkspaceFilePreview>(), [loading, setLoading] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [saving, setSaving] = useState(false);
  const [pendingAction, setPendingAction] = useState<{ run(): void }>();
  // A clicked folder is the target of uploads and of folder rename/delete; it closes any file preview.
  const [folder, setFolder] = useState<string>(), [panelError, setPanelError] = useState(''), [dropping, setDropping] = useState(false);
  const [action, setAction] = useState<{ kind: 'rename' | 'delete'; target: { kind: 'file' | 'directory'; path: string } }>();
  const [newName, setNewName] = useState(''), [actionError, setActionError] = useState(''), [actionBusy, setActionBusy] = useState(false);
  const [source, setSource] = useState(false);
  // The project shared folder (vm_manager F:) is browsed in 项目文件, next to every task's D:.
  const vmStorage = useVmStorage(projectId), snapshotScope = scope;
  const panel = useRef<HTMLElement>(null), closePreview = useRef<HTMLButtonElement>(null), returnFocus = useRef<HTMLElement>();
  const dirty = !!draft && (!!draft.isNew || draft.content !== draft.baseContent), hasPreview = !!selected || !!draft || folder !== undefined;
  const writable = task.writable && !scope, refreshKey = `${refreshVersion}:${refresh}`, alive = useRef(true);
  const uploadTarget = folder ?? (selected && !draft?.isNew ? parentFolder(selected) : '');
  const uploads = useUploads(writable ? {
    stat: path => api<{ kind?: 'file' | 'directory' }>(`file/stat?${new URLSearchParams({ taskId: task.id, path })}`),
    url: (path, overwrite, folders) => `/api/studio/file/upload?${new URLSearchParams({ taskId: task.id, path, overwrite: overwrite ? '1' : '0', ...(folders ? { folders: '1' } : {}) })}`,
    label: folderLabel,
  } : undefined, { notice: setNotice, error: setPanelError, done: () => setRefresh(value => value + 1) });
  const busy = saving || uploads.busy || actionBusy;
  const pickers = useUploadPickers(items => { void uploads.start(items, uploadTarget); });
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => setSource(false), [selected]);
  const navigate = (run: () => void) => {
    if (busy) return;
    if (dirty) setPendingAction({ run });
    else { onDraftChange(undefined); setError(''); setNotice(''); setPanelError(''); run(); }
  };
  const selectFile = (path: string) => {
    if (path === selected && !draft?.isNew) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    navigate(() => { setFolder(undefined); setSelected(path); });
  };
  const selectFolder = (path: string) => {
    if (path === folder && !selected && !draft) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    navigate(() => { setSelected(''); setFolder(path); });
  };
  const openAction = (kind: 'rename' | 'delete', target: { kind: 'file' | 'directory'; path: string }) => {
    setActionError(''); setNewName(target.path.split('/').at(-1) ?? ''); setAction({ kind, target });
  };
  const submitAction = async () => {
    if (!action || actionBusy) return;
    const { kind, target } = action, name = target.path.split('/').at(-1) ?? target.path;
    let to = '';
    if (kind === 'rename') {
      const problem = nameProblem(newName);
      if (problem) return setActionError(problem);
      to = joinPath(parentFolder(target.path), newName);
      if (to === target.path) return setAction(undefined);
    }
    setActionBusy(true); setActionError('');
    try {
      if (kind === 'rename') await api('file/rename', { taskId: task.id, from: target.path, to });
      else await api('file/delete', target.kind === 'directory' ? { taskId: task.id, path: target.path, directory: true } : { taskId: task.id, path: target.path });
      if (!alive.current) return;
      const inside = (path: string) => path === target.path || path.startsWith(`${target.path}/`), moved = (path: string) => `${to}${path.slice(target.path.length)}`;
      if (selected && inside(selected)) setSelected(kind === 'rename' ? moved(selected) : '');
      if (folder !== undefined && inside(folder)) setFolder(kind === 'rename' ? moved(folder) : undefined);
      setAction(undefined); setRefresh(value => value + 1); setPanelError('');
      setNotice(kind === 'rename' ? `已将 ${name} 重命名为 ${newName}` : `已删除${target.kind === 'directory' ? '文件夹' : ''} ${name}`);
    } catch (error) { if (alive.current) setActionError(errorText(error)); }
    finally { if (alive.current) setActionBusy(false); }
  };
  useEffect(() => {
    const bounds = panel.current?.getBoundingClientRect();
    if (hasPreview && bounds && (bounds.height <= 200 || bounds.width < 560 && bounds.height <= 420)) closePreview.current?.focus();
    else if (!hasPreview && returnFocus.current?.isConnected) { returnFocus.current.focus(); returnFocus.current = undefined; }
  }, [hasPreview]);
  useEffect(() => {
    let valid = true; setManifest(undefined); setManifestError(''); setManifestLoading(!!snapshotScope);
    if (snapshotScope) {
      if (snapshot?.id === snapshotScope) { setManifest(snapshot); setManifestLoading(false); }
      else void api<{ snapshot: Snapshot }>(`snapshot/manifest?${new URLSearchParams({ taskId: task.id, snapshotId: snapshotScope })}`).then(value => { if (valid) setManifest(value.snapshot); }, error => { if (valid) setManifestError(errorText(error)); }).finally(() => { if (valid) setManifestLoading(false); });
    }
    return () => { valid = false; };
  }, [snapshotScope, snapshot, task.id, refreshKey]);
  useEffect(() => {
    let valid = true; setPreview(undefined); setError(''); setLoading(!!selected);
    if (selected) void api<WorkspaceFilePreview>(scope ? `snapshot/preview?${new URLSearchParams({ taskId: task.id, snapshotId: scope, path: selected })}` : `project/file?${new URLSearchParams({ projectId, taskId: task.id, path: selected })}`).then(value => { if (valid) setPreview(value); }, error => { if (valid) setError(errorText(error)); }).finally(() => { if (valid) setLoading(false); });
    return () => { valid = false; };
  }, [projectId, task.id, selected, scope, refreshKey]);
  const loadDirectory = useCallback((path: string, offset: number) => scope ? Promise.resolve(snapshotDirectory(manifest!, path, offset)) : api<ProjectWorkspaceDirectory>(`project/files?${new URLSearchParams({ projectId, taskId: task.id, path, offset: String(offset), limit: '100' })}`), [scope, manifest, projectId, task.id]);
  const save = async () => {
    if (!draft || !writable || saving || !draft.path.trim()) return;
    const current = draft; setSaving(true); setError(''); setNotice('');
    try {
      await api('file', { taskId: task.id, path: current.path.trim(), content: current.content, ...(current.isNew ? { createOnly: true } : { expectedVersion: current.version }) });
      // A task switch keeps its draft; never apply this response to another task.
      onSaved(current);
      if (alive.current) { setSelected(current.path.trim()); setRefresh(value => value + 1); setNotice('文件已保存'); }
    } catch (error) { if (alive.current) setError(errorText(error)); }
    finally { if (alive.current) setSaving(false); }
  };
  const isHistoricalScope = !!snapshotScope && scope !== snapshot?.id && !task.inputs.some(input => input.snapshotId === scope);
  // Snapshot and upstream-input scopes are snapshot IDs this task may read.
  const fileSource: FileSource = scope ? { source: 'snapshot', taskId: task.id, snapshotId: scope } : { source: 'task', taskId: task.id };
  const sourceName = !scope ? '当前工作空间' : scope === snapshot?.id ? task.state === 'completed' ? '完成快照' : '保留的旧快照' : isHistoricalScope ? '历史快照' : '上游输入';
  return <section ref={panel} className={`project-files-panel task-files-panel${hasPreview ? ' has-file-preview' : ''}`} aria-label="任务文件">
    <header className="project-files-header"><div><h3>任务工作区</h3><small>浏览文件与子文件夹</small></div><div className="task-file-tools">{writable && <>{pickers.inputs}<button aria-label="上传文件" title={`上传文件到：${folderLabel(uploadTarget)}`} disabled={busy} onClick={pickers.pickFiles}><UploadFileIcon /></button><button aria-label="上传文件夹" title={`上传文件夹到：${folderLabel(uploadTarget)}`} disabled={busy} onClick={pickers.pickFolder}><UploadFolderIcon /></button></>}{writable && <button aria-label="新建文件" title="新建文本文件" disabled={busy} onClick={() => navigate(() => { setSelected(''); onDraftChange({ path: '', content: '', baseContent: '', isNew: true }); })}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" /></svg></button>}<button aria-label="刷新任务文件" title="刷新任务文件" disabled={busy} onClick={() => setRefresh(value => value + 1)}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16 8a6 6 0 1 0 0 4M16 3v5h-5" /></svg></button></div></header>
    <div className="task-file-source"><FileIcon folder /><select aria-label="文件版本" value={scope} disabled={busy} onChange={event => { const value = event.target.value; navigate(() => { setScope(value); setSelected(''); setFolder(undefined); }); }}><option value="">{vmStorage ? '当前工作空间（D 盘）' : '当前工作空间'}</option>{snapshot && <option value={snapshot.id}>{task.state === 'completed' ? '完成快照' : '保留的旧快照'}</option>}{isHistoricalScope && <option value={scope}>历史快照</option>}{task.inputs.filter(input => input.snapshotId !== snapshot?.id).map(input => <option key={input.snapshotId} value={input.snapshotId}>{task.state === 'recheck' ? '原上游输入（历史）：' : '上游输入：'}{tasks.find(row => row.id === input.taskId)?.title ?? input.taskId}</option>)}</select><span className={`file-access-badge${writable ? ' is-writable' : ''}`}>{writable ? '可编辑' : '只读'}</span></div>
    <div className={`task-file-browser${dropping ? ' is-dropping' : ''}`} onDragOver={event => {
      if (!writable || busy || !event.dataTransfer.types.includes('Files')) return;
      event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDropping(true);
    }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false); }} onDrop={event => {
      if (!writable || busy || !event.dataTransfer.types.includes('Files')) return;
      event.preventDefault(); setDropping(false);
      const dropped = droppedEntries(event.dataTransfer), destination = uploadTarget;
      void droppedItems(dropped).then(items => uploads.start(items, destination), error => setPanelError(error instanceof Error ? error.message : '读取拖入的文件失败'));
    }}>
      {dropping && <div className="task-file-drop-hint">松开以上传到 {folderLabel(uploadTarget)}</div>}
      <div className="project-files-tree" aria-label="任务文件树">{manifestLoading ? <p className="project-files-hint" role="status">正在读取快照目录…</p> : manifestError ? <p className="project-files-error" role="status">{manifestError}<button onClick={() => setRefresh(value => value + 1)}>重试</button></p> : (!snapshotScope || manifest) && <FileTree key={scope} loadDirectory={loadDirectory} refreshKey={refreshKey} label={task.code} selected={selected} onFile={selectFile} selectedFolder={folder} onFolder={selectFolder} />}</div>
      {selected || draft ? <section className="project-file-preview task-file-preview" aria-label="任务文件预览">
        <header><div><strong title={draft?.isNew ? '新建文件' : selected}>{draft?.isNew ? '新建文件' : selected.split('/').at(-1)}</strong><small title={selected}>{draft ? '编辑中' : sourceName}{preview ? ` · ${fileSize(preview.bytes)}` : ''}{dirty ? ' · 未保存' : ''}</small></div><div className="task-file-preview-actions">{!draft && preview?.status === 'text' && renderKind(selected) && <PreviewModeSwitch source={source} onChange={setSource} />}{!draft && selected && preview && <DownloadButton from={fileSource} path={selected} />}{!draft && writable && preview?.status === 'text' && <button className="file-edit-button" disabled={loading || busy} onClick={() => { if (preview?.status === 'text') { setNotice(''); onDraftChange({ path: selected, content: preview.content, baseContent: preview.content, version: preview.version }); } }}>编辑</button>}{!draft && writable && selected && <><button className="file-edit-button" disabled={busy} onClick={() => openAction('rename', { kind: 'file', path: selected })}>重命名</button><button className="file-edit-button file-delete-button" disabled={busy} onClick={() => openAction('delete', { kind: 'file', path: selected })}>删除</button></>}{draft && <><button className="file-edit-button" disabled={saving} onClick={() => navigate(() => {})}>取消</button><button className="file-save-button" disabled={saving || !writable || !draft.path.trim() || !dirty} onClick={() => { void save(); }}>{saving ? '保存中…' : '保存'}</button></>}<button ref={closePreview} aria-label="关闭任务文件预览" title="关闭预览" disabled={busy} onClick={() => navigate(() => setSelected(''))}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" /></svg></button></div></header>
        {!draft?.isNew && selected.includes('/') && <div className="task-file-location" title={selected}>{selected.split('/').slice(0, -1).join(' / ')}</div>}
        <div className={`project-file-preview-body${draft ? ' is-editing' : ''}`}>
          {draft ? <>{draft.isNew && <label className="new-file-name">文件名<input autoFocus aria-label="新文件名称" value={draft.path} disabled={saving || !writable} placeholder="例如：notes/design.md" onChange={event => onDraftChange({ ...draft, path: event.target.value })} /></label>}<textarea className="task-file-editor" aria-label="文件内容" autoFocus={!draft.isNew} spellCheck={false} disabled={saving || !writable} value={draft.content} onChange={event => onDraftChange({ ...draft, content: event.target.value })} />{!writable && <p className="project-files-hint">当前任务为只读，未保存的草稿仍保留。</p>}</> : loading ? <p role="status">正在读取文件…</p> : preview?.status === 'text' ? <TextFilePreview path={preview.path} content={preview.content} source={source} from={fileSource} onOpen={selectFile} /> : preview ? <BinaryPreview from={fileSource} path={selected} bytes={preview.bytes} tooLarge={preview.status === 'tooLarge'} /> : null}
          {error && <p className="project-files-error" role="status">{error}</p>}
        </div>
      </section> : folder !== undefined ? <section className="project-file-preview task-file-preview task-folder-preview" aria-label="所选文件夹">
        <header><div><strong title={folder}>{folder.split('/').at(-1)}</strong><small title={folder}>文件夹 · {sourceName}</small></div><div className="task-file-preview-actions">{writable && <><button className="file-edit-button" disabled={busy} onClick={pickers.pickFiles}>上传文件</button><button className="file-edit-button" disabled={busy} onClick={pickers.pickFolder}>上传文件夹</button><button className="file-edit-button" disabled={busy} onClick={() => openAction('rename', { kind: 'directory', path: folder })}>重命名</button><button className="file-edit-button file-delete-button" disabled={busy} onClick={() => openAction('delete', { kind: 'directory', path: folder })}>删除</button></>}<button ref={closePreview} aria-label="取消选择文件夹" title="取消选择" disabled={busy} onClick={() => navigate(() => setFolder(undefined))}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" /></svg></button></div></header>
        {folder.includes('/') && <div className="task-file-location" title={folder}>{folder.split('/').slice(0, -1).join(' / ')}</div>}
        <div className="project-file-preview-body"><p className="project-files-hint">{writable ? '上传的文件和文件夹会放到这个文件夹。也可以把文件或文件夹拖到左侧文件列表中。' : '当前为只读，不能修改这个文件夹。'}</p></div>
      </section> : <div className="task-file-preview-empty"><FileIcon /><p>选择文件以预览内容</p><small>{writable ? '展开文件夹浏览文件；点击上方的上传按钮，或把文件、文件夹拖到这里即可上传。' : '展开文件夹，浏览任务资料与工作成果。'}</small></div>}
    </div>
    {uploads.progress || uploads.checking ? <UploadStatus progress={uploads.progress} checking={uploads.checking} onCancel={uploads.cancel} />
      : (notice || dirty) && <div className="task-file-status" role="status">{dirty ? '有未保存的修改' : notice}</div>}
    {panelError && <div className="task-file-status is-error" role="alert"><span>{panelError}</span><button aria-label="关闭错误提示" title="关闭" onClick={() => setPanelError('')}>×</button></div>}
    {completionRecord && <div className="task-file-record">{completionRecord}</div>}
    {uploads.dialog}
    {action?.kind === 'rename' && <FileActionDialog title={action.target.kind === 'directory' ? '重命名文件夹' : '重命名文件'} confirmLabel="重命名" busy={actionBusy} error={actionError} onCancel={() => setAction(undefined)} onConfirm={() => { void submitAction(); }}>
      <label className="new-file-name">新名称<input aria-label="新名称" value={newName} disabled={actionBusy} onChange={event => { setNewName(event.target.value); setActionError(''); }} /></label>
    </FileActionDialog>}
    {action?.kind === 'delete' && <FileActionDialog title={action.target.kind === 'directory' ? '删除文件夹？' : '删除文件？'} confirmLabel="删除" danger busy={actionBusy} error={actionError} onCancel={() => setAction(undefined)} onConfirm={() => { void submitAction(); }}>
      <p>{action.target.kind === 'directory' ? <>将删除文件夹 <strong>{action.target.path}</strong> 及其中的全部内容。</> : <>将删除 <strong>{action.target.path}</strong>。</>}{vmStorage ? '删除后无法恢复，虚拟机 D 盘中的也会一起删除。' : '删除后无法恢复。'}</p>
    </FileActionDialog>}
    {pendingAction && <DiscardDraftDialog onCancel={() => setPendingAction(undefined)} onDiscard={() => { const next = pendingAction; setPendingAction(undefined); onDraftChange(undefined); setError(''); setNotice(''); next.run(); }} />}
  </section>;
}
