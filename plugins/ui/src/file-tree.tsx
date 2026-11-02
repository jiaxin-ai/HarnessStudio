import { useEffect, useRef, useState } from 'react';
import type { WorkspaceDirectoryListing } from '@harnessstudio/studio/domain-types';

export function fileSize(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
export function FileIcon({ folder = false, name = '' }: { folder?: boolean; name?: string }) {
  const kind = folder ? 'folder' : /\.(step|stp|iges|igs|dwg|dxf|stl|obj|sldprt|fcstd)$/i.test(name) ? 'drawing' : /\.(md|txt|csv|json|yaml|yml|log)$/i.test(name) ? 'text' : 'file';
  return <svg className={`project-file-icon file-icon-${kind}`} viewBox="0 0 20 20" aria-hidden="true">{folder ? <path d="M2.5 5.5h6l2 2h7v8.5h-15z" /> : <><path d="M5 2.5h6l4 4v11H5zM11 2.5v4h4" />{kind === 'text' && <path d="M7.5 10h5m-5 3h5" />}{kind === 'drawing' && <path d="m7.5 13 2.5-4 2.5 4z" />}</>}</svg>;
}
export type DirectoryLoader = (path: string, offset: number) => Promise<WorkspaceDirectoryListing>;
interface TreeProps {
  loadDirectory: DirectoryLoader; refreshKey: string; label: string; selected?: string;
  onFile(path: string): void; rootLabel?: { code: string; title: string };
  /** Panels that act on folders (upload, rename, delete) highlight and report the clicked folder. */
  selectedFolder?: string; onFolder?(path: string): void;
  /** Empty-state text of an unwrapped root; defaults to the task workspace wording. */
  emptyHint?: { title: string; detail: string };
}

/** Both file panels use the same lazy, paginated filesystem tree. */
export function FileTree(props: TreeProps) {
  return <ul className="project-task-workspaces"><DirectoryBranch {...props} path="" /></ul>;
}
function DirectoryBranch({ loadDirectory, refreshKey, label, selected, onFile, rootLabel, emptyHint, selectedFolder, onFolder, path, name }: TreeProps & { path: string; name?: string }) {
  const showRow = !!path || !!rootLabel;
  const [open, setOpen] = useState(!showRow), [listing, setListing] = useState<WorkspaceDirectoryListing>();
  const [entries, setEntries] = useState<WorkspaceDirectoryListing['entries']>([]), [loading, setLoading] = useState(false), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  // Children refresh only after this folder's own reload still lists them, so a renamed or deleted folder is never re-read.
  const [childRefreshKey, setChildRefreshKey] = useState(refreshKey);
  const request = useRef(0), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current++; }; }, []);
  useEffect(() => {
    if (!open) { request.current++; setLoading(false); return; }
    const sequence = ++request.current; let alive = true; setLoading(true); setError('');
    void loadDirectory(path, 0).then(value => {
      if (alive && mounted.current && sequence === request.current) { setListing(value); setEntries(value.entries); setChildRefreshKey(refreshKey); }
    }, error => { if (alive && mounted.current && sequence === request.current) setError(error instanceof Error ? error.message : '目录读取失败'); }).finally(() => {
      if (alive && mounted.current && sequence === request.current) setLoading(false);
    });
    return () => { alive = false; };
  }, [loadDirectory, path, open, refreshKey, retry]);
  const loadMore = async () => {
    if (loading || listing?.nextOffset === undefined) return;
    const sequence = ++request.current; setLoading(true); setError('');
    try {
      const value = await loadDirectory(path, listing.nextOffset);
      if (mounted.current && sequence === request.current) {
        setListing(value); setEntries(previous => [...previous, ...value.entries.filter(entry => !previous.some(row => row.path === entry.path))]);
      }
    } catch (error) { if (mounted.current && sequence === request.current) setError(error instanceof Error ? error.message : '目录读取失败'); }
    finally { if (mounted.current && sequence === request.current) setLoading(false); }
  };
  const root = path === '', title = rootLabel ? `${rootLabel.code} ${rootLabel.title}` : name ?? label;
  return <li className={`project-file-branch${root && rootLabel ? ' is-task-root' : ''}${!showRow ? ' is-unwrapped-root' : ''}`}>
    {showRow && <button className={`project-file-row project-directory-row${onFolder && path && selectedFolder === path ? ' is-selected' : ''}`} aria-expanded={open} aria-label={`${open ? '折叠' : '展开'}${root ? '任务工作空间' : '文件夹'}：${root ? title : `${label} / ${path}`}`} title={root ? title : path} onClick={() => { setOpen(previous => !previous); if (path) onFolder?.(path); }}>
      <svg className={`project-file-chevron${open ? ' is-open' : ''}`} viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg><FileIcon folder />{root && rootLabel && <code>{rootLabel.code}</code>}<span className="project-file-name">{root && rootLabel ? rootLabel.title : name}</span>{listing && <small>{listing.total}</small>}
    </button>}
    {open && <ul className={`project-file-children${!showRow ? ' is-tree-root' : ''}`} aria-label={`${title}文件`}>
      {entries.map(entry => entry.kind === 'directory' ? <DirectoryBranch key={entry.path} loadDirectory={loadDirectory} refreshKey={childRefreshKey} label={label} selected={selected} onFile={onFile} selectedFolder={selectedFolder} onFolder={onFolder} path={entry.path} name={entry.name} /> : <li key={entry.path}>
        <button className={`project-file-row project-file-leaf${selected === entry.path ? ' is-selected' : ''}`} aria-label={`预览文件：${label} / ${entry.path}`} aria-pressed={selected === entry.path} title={`${entry.path}${entry.bytes !== undefined ? ` · ${fileSize(entry.bytes)}` : ''}`} onClick={() => onFile(entry.path)}>
          <span className="project-file-spacer" /><FileIcon name={entry.name} /><span className="project-file-name">{entry.name}</span>{entry.bytes !== undefined && <small>{fileSize(entry.bytes)}</small>}
        </button>
      </li>)}
      {loading && !listing && <li className="project-files-hint" role="status">正在加载…</li>}
      {!loading && !error && listing && entries.length === 0 && <li className={showRow ? 'project-files-hint' : 'task-files-empty'}>{showRow ? '暂无文件' : <><FileIcon folder /><strong>{emptyHint?.title ?? '暂无任务文件'}</strong><span>{emptyHint?.detail ?? '此任务生成或保存的文件会显示在这里。'}</span></>}</li>}
      {error && <li className="project-files-error" role="status">{error}<button onClick={() => setRetry(previous => previous + 1)}>重试</button></li>}
      {!error && listing?.nextOffset !== undefined && <li><button className="project-files-more" disabled={loading} onClick={() => { void loadMore(); }}>加载更多 · 已显示 {entries.length} / {listing.total}</button></li>}
    </ul>}
  </li>;
}
