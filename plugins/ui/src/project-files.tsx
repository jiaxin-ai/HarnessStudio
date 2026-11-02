import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectWorkspaceDirectory, TaskView, WorkspaceFilePreview } from '@harnessstudio/studio/domain-types';
import { api } from './api.ts';
import { useNoSoftware } from './software-backend.ts';
import { FileTree, FileIcon, fileSize } from './file-tree.tsx';
import { DiscardDraftDialog } from './task-files.tsx';
import { RegionButtons, onTitleBarDoubleClick, type RegionControl } from './region.tsx';
import { BinaryPreview, DownloadButton, type FileSource } from './file-download.tsx';
import { PreviewModeSwitch, TextFilePreview, renderKind } from './file-preview.tsx';
import { UploadFileIcon, UploadFolderIcon, UploadStatus, droppedEntries, droppedItems, parentFolder, useUploadPickers, useUploads } from './task-file-actions.tsx';

/** Selection owner for the project shared folder (vm_manager F:); every other owner is a task ID (its D:). */
const SHARED = '@shared';
type FileSelection = { owner: string; path: string };
type Owner = Pick<TaskView, 'id' | 'code' | 'title' | 'rank'>;
interface SharedDraft { path: string; content: string; baseContent: string; version?: string; isNew?: boolean }
const errorText = (error: unknown) => error instanceof Error ? error.message : '文件读取失败';
/** Drive letters exist only with vm_manager; the no-software mode names the same folder plainly. */
const sharedLabelOf = (noSoftware: boolean) => (folder: string) => noSoftware ? (folder ? `项目公共空间 / ${folder.split('/').join(' / ')}` : '项目公共空间根目录') : folder ? `F: / ${folder.split('/').join(' / ')}` : 'F 盘根目录';
function TaskDirectory({ projectId, owner, refreshKey, selected, onFile }: {
  projectId: string; owner: Owner; refreshKey: string; selected?: FileSelection; onFile(selection: FileSelection): void;
}) {
  const loadDirectory = useCallback((path: string, offset: number) => api<ProjectWorkspaceDirectory>(`project/files?${new URLSearchParams({ projectId, taskId: owner.id, path, offset: String(offset), limit: '100' })}`), [projectId, owner.id]);
  return <FileTree loadDirectory={loadDirectory} refreshKey={refreshKey} label={owner.code} rootLabel={{ code: owner.code, title: owner.title }} selected={selected?.owner === owner.id ? selected.path : undefined} onFile={path => onFile({ owner: owner.id, path })} />;
}

/** The whole project: its shared folder (F:, editable) and every task's workspace (D:, read-only). */
export function ProjectFilesPanel({ projectId, tasks, refreshVersion, region }: { projectId: string; tasks: TaskView[]; refreshVersion: number; region?: RegionControl }) {
  const noSoftware = useNoSoftware(), sharedLabel = sharedLabelOf(noSoftware), F = noSoftware ? '项目公共空间' : 'F 盘';
  const owners = tasks.filter(task => task.kind === 'task').sort((a, b) => a.rank - b.rank);
  const [shared, setShared] = useState(false), [refresh, setRefresh] = useState(0), [poll, setPoll] = useState(0), [selected, setSelected] = useState<FileSelection>();
  const [preview, setPreview] = useState<WorkspaceFilePreview>(), [loading, setLoading] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [draft, setDraft] = useState<SharedDraft>(), [saving, setSaving] = useState(false), [deleting, setDeleting] = useState(false), [pendingAction, setPendingAction] = useState<{ run(): void }>();
  const panel = useRef<HTMLElement>(null), closePreview = useRef<HTMLButtonElement>(null), returnFocus = useRef<HTMLElement>(), alive = useRef(true);
  const previewKey = `${refreshVersion}:${refresh}`, treeKey = `${previewKey}:${poll}`;
  const isShared = selected?.owner === SHARED, owner = owners.find(task => task.id === selected?.owner);
  const dirty = !!draft && (!!draft.isNew || draft.content !== draft.baseContent), editing = !!draft, hasPreview = !!selected || editing;
  // Uploads go to the F: folder clicked last, else the folder of the open F: file, else the F: root.
  const [sharedFolder, setSharedFolder] = useState<string>(), [source, setSource] = useState(false);
  const [uploadError, setUploadError] = useState(''), [dropping, setDropping] = useState(false);
  const uploadTarget = sharedFolder ?? (isShared && selected ? parentFolder(selected.path) : '');
  const uploads = useUploads(shared ? {
    stat: path => api<{ kind?: 'file' | 'directory' }>(`project/shared/stat?${new URLSearchParams({ projectId, path })}`),
    url: (path, overwrite, folders) => `/api/studio/project/shared/upload?${new URLSearchParams({ projectId, path, overwrite: overwrite ? '1' : '0', ...(folders ? { folders: '1' } : {}) })}`,
    label: sharedLabel,
  } : undefined, { notice: setNotice, error: setUploadError, done: () => setRefresh(value => value + 1) });
  const pickers = useUploadPickers(items => { void uploads.start(items, uploadTarget); });
  const busy = saving || uploads.busy;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => setSource(false), [selected?.owner, selected?.path]);
  useEffect(() => {
    let valid = true; setShared(false);
    void api<{ enabled: boolean }>(`project/shared/status?${new URLSearchParams({ projectId })}`).then(value => { if (valid) setShared(value.enabled); }, () => undefined);
    return () => { valid = false; };
  }, [projectId]);
  // Files written inside VMs (F: and D:) have no change feed, so open folders are re-read while the panel is on screen.
  useEffect(() => {
    if (!shared || editing || uploads.busy) return;
    const timer = setInterval(() => { if (!document.hidden && panel.current?.offsetParent) setPoll(value => value + 1); }, 10000);
    return () => clearInterval(timer);
  }, [shared, editing, uploads.busy]);
  const navigate = (run: () => void) => {
    if (busy) return;
    if (dirty) setPendingAction({ run });
    else { setDraft(undefined); setError(''); setNotice(''); setDeleting(false); run(); }
  };
  const selectFile = (value: FileSelection) => {
    if (selected?.owner === value.owner && selected.path === value.path && !draft?.isNew) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    navigate(() => { setSelected(value); if (value.owner === SHARED) setSharedFolder(undefined); });
  };
  useEffect(() => {
    if (hasPreview && panel.current && panel.current.getBoundingClientRect().height <= 200 && panel.current.closest('.project-file-resource')) closePreview.current?.focus();
    else if (!hasPreview && returnFocus.current?.isConnected) { returnFocus.current.focus(); returnFocus.current = undefined; }
  }, [hasPreview]);
  useEffect(() => { if (selected && selected.owner !== SHARED && !owner) setSelected(undefined); }, [selected, owner?.id]);
  useEffect(() => {
    let valid = true; setPreview(undefined); setError(''); setLoading(!!selected);
    if (selected) void api<WorkspaceFilePreview>(selected.owner === SHARED ? `project/shared/file?${new URLSearchParams({ projectId, path: selected.path })}` : `project/file?${new URLSearchParams({ projectId, taskId: selected.owner, path: selected.path })}`).then(value => {
      if (valid) setPreview(value);
    }, error => { if (valid) setError(errorText(error)); }).finally(() => { if (valid) setLoading(false); });
    return () => { valid = false; };
  }, [projectId, selected?.owner, selected?.path, previewKey]);
  const loadShared = useCallback((path: string, offset: number) => api<ProjectWorkspaceDirectory>(`project/shared?${new URLSearchParams({ projectId, path, offset: String(offset), limit: '100' })}`), [projectId]);
  const save = async () => {
    if (!draft || saving || !draft.path.trim()) return;
    const current = draft, path = current.path.trim(); setSaving(true); setError(''); setNotice('');
    try {
      await api('project/shared/file', { projectId, path, content: current.content, ...(current.isNew ? { createOnly: true } : { expectedVersion: current.version }) });
      if (alive.current) { setDraft(undefined); setSelected({ owner: SHARED, path }); setRefresh(value => value + 1); setNotice(`已保存到${F}`); }
    } catch (error) { if (alive.current) setError(errorText(error)); }
    finally { if (alive.current) setSaving(false); }
  };
  const remove = async () => {
    if (!selected || !isShared || saving) return;
    const target = selected; setSaving(true); setError(''); setNotice('');
    try {
      await api('project/shared/delete', { projectId, path: target.path, ...(preview?.status === 'text' ? { expectedVersion: preview.version } : {}) });
      if (alive.current) { setSelected(undefined); setDeleting(false); setRefresh(value => value + 1); setNotice(`已从${F}删除`); }
    } catch (error) { if (alive.current) setError(errorText(error)); }
    finally { if (alive.current) setSaving(false); }
  };
  const fileSource: FileSource | undefined = !selected ? undefined : isShared ? { source: 'shared', projectId } : { source: 'project', projectId, taskId: selected.owner };
  const location = draft?.isNew || isShared ? (noSoftware ? '项目公共空间' : 'F 盘 · 项目公共空间') : owner ? `${owner.code} ${owner.title} · ${noSoftware ? '' : 'D 盘 · '}只读` : '';
  return <section ref={panel} className={`project-files-panel task-files-panel project-wide-files${hasPreview ? ' has-file-preview' : ''}`} aria-label="项目文件">
    <header className="project-files-header" onDoubleClick={onTitleBarDoubleClick(region)}><div><h3>项目文件</h3><small>{shared ? noSoftware ? `项目公共空间可编辑 · ${owners.length} 个任务的文件只读` : `F 盘项目公共空间可编辑 · ${owners.length} 个任务的 D 盘只读` : `全项目 · ${owners.length} 个任务工作空间 · 只读`}</small></div>
      <div className="task-file-tools">
        {shared && <>{pickers.inputs}<button aria-label={`上传文件到${F}`} title={`上传文件到：${sharedLabel(uploadTarget)}`} disabled={busy} onClick={pickers.pickFiles}><UploadFileIcon /></button><button aria-label={`上传文件夹到${F}`} title={`上传文件夹到：${sharedLabel(uploadTarget)}`} disabled={busy} onClick={pickers.pickFolder}><UploadFolderIcon /></button></>}
        {shared && <button aria-label={`在${F}新建文件`} title={noSoftware ? '在项目公共空间新建文本文件' : '在 F 盘（项目公共空间）新建文本文件'} disabled={busy} onClick={() => navigate(() => { setSelected(undefined); setDraft({ path: '', content: '', baseContent: '', isNew: true }); })}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" /></svg></button>}
        <button aria-label="刷新项目文件" title="刷新项目文件" disabled={saving} onClick={() => setRefresh(previous => previous + 1)}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16 8a6 6 0 1 0 0 4M16 3v5h-5" /></svg></button>
        {region && <RegionButtons control={region} name="项目文件" />}
      </div>
    </header>
    <div className="task-file-browser">
      <div className="project-files-tree" aria-label="项目文件树">
        {shared && <section className={`project-files-group project-shared-drop${dropping ? ' is-dropping' : ''}`} aria-label={noSoftware ? '项目公共空间' : 'F 盘 项目公共空间'} onDragOver={event => {
          if (busy || !event.dataTransfer.types.includes('Files')) return;
          event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDropping(true);
        }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false); }} onDrop={event => {
          if (busy || !event.dataTransfer.types.includes('Files')) return;
          event.preventDefault(); setDropping(false);
          const dropped = droppedEntries(event.dataTransfer), destination = uploadTarget;
          void droppedItems(dropped).then(items => uploads.start(items, destination), error => setUploadError(error instanceof Error ? error.message : '读取拖入的文件失败'));
        }}><h4>{noSoftware ? '项目公共空间' : 'F 盘 · 项目公共空间'}<small>{noSoftware ? '本项目所有任务共享' : '本项目所有虚拟机共享'}</small>{uploadTarget && <button type="button" className="shared-upload-target" title={`上传的文件会放到这个文件夹，点击改回${noSoftware ? '' : ' F 盘'}根目录`} disabled={busy} onClick={() => setSharedFolder('')}>上传到：{uploadTarget.split('/').join(' / ')}<span aria-hidden="true">×</span></button>}</h4>
          {dropping && <div className="task-file-drop-hint">松开以上传到 {sharedLabel(uploadTarget)}</div>}
          <FileTree loadDirectory={loadShared} refreshKey={treeKey} label={noSoftware ? '项目公共空间' : 'F:'} selected={isShared ? selected.path : undefined} onFile={path => selectFile({ owner: SHARED, path })} selectedFolder={sharedFolder} onFolder={setSharedFolder} emptyHint={noSoftware ? { title: '项目公共空间还没有文件', detail: '在这里保存或沙箱写入的文件会显示在这里，也可以上传或把文件、文件夹拖到这里。' } : { title: 'F 盘还没有文件', detail: '虚拟机或这里保存到 F 盘的文件会显示在这里，也可以上传或把文件、文件夹拖到这里。' }} />
        </section>}
        <section className="project-files-group" aria-label="任务工作空间">{shared && <h4>{noSoftware ? '各任务工作空间' : 'D 盘 · 各任务工作空间'}<small>只读</small></h4>}
          {owners.length ? <div className="project-task-groups">{owners.map(task => <TaskDirectory key={task.id} projectId={projectId} owner={task} refreshKey={treeKey} selected={selected} onFile={selectFile} />)}</div> : <div className="project-files-empty"><FileIcon folder /><p>任务文件会集中显示在这里</p><small>先通过对话或图谱添加任务。</small></div>}
        </section>
      </div>
      {hasPreview ? <section className="project-file-preview task-file-preview" aria-label="项目文件预览">
        <header><div><strong title={draft?.isNew ? '新建文件' : selected?.path}>{draft?.isNew ? `新建${F}文件` : selected?.path.split('/').at(-1)}</strong><small title={selected?.path}>{draft ? '编辑中' : location}{preview && !draft ? ` · ${fileSize(preview.bytes)}` : ''}{dirty ? ' · 未保存' : ''}</small></div>
          <div className="task-file-preview-actions">
            {!draft && selected && preview?.status === 'text' && renderKind(selected.path) && <PreviewModeSwitch source={source} onChange={setSource} />}
            {!draft && selected && preview && fileSource && <DownloadButton from={fileSource} path={selected.path} />}
            {!draft && isShared && preview?.status === 'text' && <button className="file-edit-button" disabled={loading || saving} onClick={() => { setNotice(''); setDraft({ path: selected.path, content: preview.content, baseContent: preview.content, version: preview.version }); }}>编辑</button>}
            {!draft && isShared && preview && (deleting ? <><button className="file-edit-button file-delete-confirm" disabled={saving} onClick={() => { void remove(); }}>确认删除</button><button className="file-edit-button" disabled={saving} onClick={() => setDeleting(false)}>取消</button></>
              : <button className="file-edit-button" disabled={saving} onClick={() => setDeleting(true)}>删除</button>)}
            {draft && <><button className="file-save-button file-edit-button" disabled={saving || !draft.path.trim()} onClick={() => { void save(); }}>{saving ? '正在保存…' : '保存'}</button><button className="file-edit-button" disabled={saving} onClick={() => navigate(() => undefined)}>取消</button></>}
            <button ref={closePreview} aria-label="关闭文件预览" title="关闭文件预览" disabled={saving} onClick={() => navigate(() => setSelected(undefined))}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" /></svg></button>
          </div>
        </header>
        {!draft?.isNew && selected?.path.includes('/') && <div className="task-file-location" title={selected.path}>{selected.path.split('/').slice(0, -1).join(' / ')}</div>}
        <div className={`project-file-preview-body${draft ? ' is-editing' : ''}`}>
          {draft ? <>{draft.isNew && <label className="new-file-name">文件名<input autoFocus aria-label="新文件名称" value={draft.path} disabled={saving} placeholder="例如：资料/参数.md" onChange={event => setDraft({ ...draft, path: event.target.value })} /></label>}<textarea className="task-file-editor" aria-label="文件内容" autoFocus={!draft.isNew} spellCheck={false} disabled={saving} value={draft.content} onChange={event => setDraft({ ...draft, content: event.target.value })} /><p className="project-files-hint">F 盘由本项目的所有虚拟机共享，保存后它们立即可见。</p></>
            : loading ? <p role="status">正在读取文件…</p> : preview?.status === 'text' && selected && fileSource ? <TextFilePreview path={preview.path} content={preview.content} source={source} from={fileSource} onOpen={path => selectFile({ owner: selected.owner, path })} /> : preview && fileSource && selected ? <BinaryPreview from={fileSource} path={selected.path} bytes={preview.bytes} tooLarge={preview.status === 'tooLarge'} /> : null}
          {error && <p className="project-files-error" role="status">{error}</p>}
        </div>
      </section> : <div className="task-file-preview-empty"><FileIcon /><p>选择文件以预览内容</p><small>{noSoftware ? '项目公共空间可在这里新建、上传和编辑；各任务的文件请在该任务的“任务文件”中修改。' : 'F 盘可在这里新建、上传和编辑；各任务的 D 盘请在该任务的“任务文件”中修改。'}</small></div>}
    </div>
    {uploads.progress || uploads.checking ? <UploadStatus progress={uploads.progress} checking={uploads.checking} onCancel={uploads.cancel} />
      : (notice || dirty) && <div className="task-file-status" role="status">{dirty ? '有未保存的修改' : notice}</div>}
    {uploadError && <div className="task-file-status is-error" role="alert"><span>{uploadError}</span><button aria-label="关闭错误提示" title="关闭" onClick={() => setUploadError('')}>×</button></div>}
    {uploads.dialog}
    {pendingAction && <DiscardDraftDialog onCancel={() => setPendingAction(undefined)} onDiscard={() => { const next = pendingAction; setPendingAction(undefined); setDraft(undefined); setError(''); setNotice(''); setDeleting(false); next.run(); }} />}
  </section>;
}
