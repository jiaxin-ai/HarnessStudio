import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNoSoftware } from './software-backend.ts';

/** Same limit as the server (WORKSPACE_UPLOAD_MAX_BYTES). */
export const UPLOAD_MAX_BYTES = 1024 * 1024 * 1024;
/** Files in one upload, so a dropped folder cannot stall the page. */
export const UPLOAD_MAX_FILES = 5000;
export const joinPath = (folder: string, name: string) => folder ? `${folder}/${name}` : name;
export const parentFolder = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
export const folderLabel = (folder: string) => folder ? folder.split('/').join(' / ') : '任务根目录';

/** Mirrors the server's check, so a name the VM's Windows D: drive cannot hold is reported before any request. */
export function nameProblem(name: string): string | undefined {
  if (!name) return '名称不能为空';
  if (name === '.' || name === '..' || /[\\/<>:"|?*\u0000-\u001f]/.test(name)) return '名称不能包含 \\ / : * ? " < > |';
  if (/[. ]$/.test(name)) return '名称不能以空格或句点结尾';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name)) return '不能使用 CON、NUL 等 Windows 保留名';
  if (name.length > 255) return '名称不能超过 255 个字符';
  return undefined;
}

export interface UploadProgress { index: number; total: number; name: string; percent: number }
/** One file of an upload; `path` is relative to the destination folder and has folders for a folder upload. */
export interface UploadItem { file: File; path: string }
/** Where a panel uploads to: a task's D: or the project's F:. */
export interface UploadTarget {
  stat(path: string): Promise<{ kind?: 'file' | 'directory' }>;
  url(path: string, overwrite: boolean, folders: boolean): string;
  label(folder: string): string;
}

/** Picked files keep their folder path when a folder was chosen. */
export const pickedItems = (files: FileList | null): UploadItem[] => Array.from(files ?? [], file => ({ file, path: file.webkitRelativePath || file.name }));

/** Dropped entries must be taken while the drop event runs; their contents are read afterwards. */
export function droppedEntries(data: DataTransfer): { entries: FileSystemEntry[]; files: File[] } {
  const entries = [...data.items].flatMap(item => { const entry = item.kind === 'file' ? item.webkitGetAsEntry() : null; return entry ? [entry] : []; });
  return { entries, files: [...data.files] };
}
/** Files of dropped files and folders, walking each folder; stops once past the file limit. */
export async function droppedItems({ entries, files }: { entries: FileSystemEntry[]; files: File[] }): Promise<UploadItem[]> {
  if (!entries.length) return files.map(file => ({ file, path: file.name }));
  const items: UploadItem[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (items.length > UPLOAD_MAX_FILES) return;
    if (entry.isFile) items.push({ file: await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject)), path: `${prefix}${entry.name}` });
    else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
      }
    }
  };
  for (const entry of entries) await walk(entry, '');
  return items;
}

/** Runs `step` over `values` with a few requests in flight. */
async function eachLimited<T>(values: T[], step: (value: T) => Promise<void>, limit = 6) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => { while (next < values.length) await step(values[next++]!); }));
}
const listed = (lines: string[], limit = 10) => [...lines.slice(0, limit), ...(lines.length > limit ? [`……另有 ${lines.length - limit} 个`] : [])].join('\n');
const errorText = (error: unknown) => error instanceof Error ? error.message : '文件操作失败';

/**
 * Upload of picked or dropped files and folders into one folder of a panel. Names and sizes are checked first, then
 * existing names, so a replacement is confirmed before any bytes are sent; files then go one at a time, and 停止
 * ends the upload after cancelling the file in flight.
 */
export function useUploads(target: UploadTarget | undefined, report: { notice(text: string): void; error(text: string): void; done(): void }) {
  const noSoftware = useNoSoftware();
  const [progress, setProgress] = useState<UploadProgress>(), [checking, setChecking] = useState(false);
  const [replace, setReplace] = useState<{ items: UploadItem[]; folder: string; existing: string[] }>();
  const alive = useRef(true), stop = useRef<AbortController>();
  useEffect(() => { alive.current = true; return () => { alive.current = false; stop.current?.abort(); }; }, []);
  const run = async (items: UploadItem[], folder: string, overwrite: boolean) => {
    if (!target) return;
    const controller = new AbortController(); stop.current = controller;
    const failures: string[] = []; let done = 0;
    for (const [index, item] of items.entries()) {
      if (controller.signal.aborted) break;
      const show = (percent: number) => { if (alive.current) setProgress({ index: index + 1, total: items.length, name: item.path, percent }); };
      show(0);
      try { await sendFile(target.url(joinPath(folder, item.path), overwrite, item.path.includes('/')), item.file, show, controller.signal); done++; }
      catch (error) { if (!controller.signal.aborted) failures.push(`${item.path}：${errorText(error)}`); }
    }
    stop.current = undefined;
    if (!alive.current) return;
    setProgress(undefined); report.done();
    const left = items.length - done - failures.length;
    if (done || controller.signal.aborted) report.notice(controller.signal.aborted ? `已停止上传：已上传 ${done} 个文件，${left} 个未上传` : `已上传 ${done} 个文件到 ${target.label(folder)}`);
    if (failures.length) report.error(`${failures.length} 个文件上传失败：\n${listed(failures)}`);
  };
  const start = async (items: UploadItem[], folder: string) => {
    if (!target || progress || checking) return;
    report.error(''); report.notice('');
    if (!items.length) return report.error('没有可上传的文件（空文件夹不会上传）');
    if (items.length > UPLOAD_MAX_FILES) return report.error(`一次最多上传 ${UPLOAD_MAX_FILES} 个文件，请分批上传`);
    const tooLarge = items.find(item => item.file.size > UPLOAD_MAX_BYTES);
    if (tooLarge) return report.error(`${tooLarge.path} 超过 1 GB，不能上传`);
    const badNames = items.flatMap(item => { const problem = item.path.split('/').map(nameProblem).find(Boolean); return problem ? [`${item.path}：${problem}`] : []; });
    if (badNames.length) return report.error(`有 ${badNames.length} 个名称${noSoftware ? '不能使用（含 Windows 不允许的字符或保留名）' : '在虚拟机的 Windows 中不能使用'}，请改名后再上传：\n${listed(badNames)}`);
    if (new Set(items.map(item => item.path.toLowerCase())).size !== items.length) return report.error('选择的文件中有重名文件，请分开上传');
    setChecking(true);
    try {
      // Only folders that already exist need their files checked one by one.
      const groups = new Map<string, UploadItem[]>(), existing: string[] = [], problems: string[] = [];
      for (const item of items) { const top = item.path.split('/')[0]!; groups.set(top, [...groups.get(top) ?? [], item]); }
      await eachLimited([...groups], async ([top, members]) => {
        const kind = (await target.stat(joinPath(folder, top))).kind, single = members.length === 1 && members[0]!.path === top;
        if (single) { if (kind === 'directory') problems.push(`已有同名文件夹：${top}`); else if (kind === 'file') existing.push(top); return; }
        if (kind === 'file') { problems.push(`已有同名文件，不能放入文件夹：${top}`); return; }
        if (kind === 'directory') await eachLimited(members, async item => {
          const inner = (await target.stat(joinPath(folder, item.path))).kind;
          if (inner === 'directory') problems.push(`已有同名文件夹：${item.path}`); else if (inner === 'file') existing.push(item.path);
        });
      });
      if (!alive.current) return;
      if (problems.length) return report.error(`${target.label(folder)} 中${listed(problems)}`);
      setChecking(false);
      if (existing.length) setReplace({ items, folder, existing: existing.sort() });
      else await run(items, folder, false);
    } catch (error) { if (alive.current) report.error(errorText(error)); }
    finally { if (alive.current) setChecking(false); }
  };
  const dialog = replace && <FileActionDialog title="替换已有文件？" confirmLabel="覆盖" danger busy={false} onCancel={() => setReplace(undefined)}
    secondary={replace.existing.length < replace.items.length ? { label: '跳过已有的', onClick: () => { const next = replace; setReplace(undefined); void run(next.items.filter(item => !next.existing.includes(item.path)), next.folder, false); } } : undefined}
    onConfirm={() => { const next = replace; setReplace(undefined); void run(next.items, next.folder, true); }}>
    <p>{target?.label(replace.folder)} 中已有 {replace.existing.length} 个同名文件，覆盖后原文件无法恢复：</p>
    <ul className="file-action-list">{replace.existing.slice(0, 50).map(name => <li key={name}>{name}</li>)}{replace.existing.length > 50 && <li>……另有 {replace.existing.length - 50} 个</li>}</ul>
  </FileActionDialog>;
  return { busy: !!progress || checking || !!replace, progress, checking, start, cancel: () => stop.current?.abort(), dialog };
}

/** Upload progress, with 停止 for the rest of the files. */
export function UploadStatus({ progress, checking, onCancel }: { progress?: UploadProgress; checking: boolean; onCancel(): void }) {
  if (checking) return <div className="task-file-status" role="status">正在检查同名文件…</div>;
  if (!progress) return null;
  return <div className="task-file-status task-file-upload-status" role="status"><span>正在上传 {progress.index}/{progress.total}：{progress.name} · {progress.percent}%</span><button type="button" onClick={onCancel}>停止</button></div>;
}

/** The hidden file and folder pickers behind a panel's upload buttons. */
export function useUploadPickers(onPick: (items: UploadItem[]) => void) {
  const files = useRef<HTMLInputElement>(null), folders = useRef<HTMLInputElement>(null);
  const change = (event: { target: HTMLInputElement }) => { const items = pickedItems(event.target.files); event.target.value = ''; onPick(items); };
  const inputs = <><input ref={files} type="file" multiple hidden onChange={change} /><input ref={input => { (folders as { current: HTMLInputElement | null }).current = input; if (input) input.webkitdirectory = true; }} type="file" hidden onChange={change} /></>;
  return { inputs, pickFiles: () => files.current?.click(), pickFolder: () => folders.current?.click() };
}
export const UploadFileIcon = () => <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 13V4M6.5 7.5 10 4l3.5 3.5M4 12.5V16h12v-3.5" /></svg>;
export const UploadFolderIcon = () => <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2.5 5h5.5l1.8 2h7.7v9h-15zM10 14.5V10M8 12l2-2 2 2" /></svg>;

/** Sends one file's raw bytes. XMLHttpRequest because fetch reports no upload progress. */
export function sendFile(url: string, file: File, onProgress: (percent: number) => void, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', url);
    request.setRequestHeader('content-type', 'application/octet-stream');
    request.upload.onprogress = event => { if (event.lengthComputable && event.total) onProgress(Math.floor(event.loaded / event.total * 100)); };
    const abort = () => request.abort();
    request.onloadend = () => signal?.removeEventListener('abort', abort);
    request.onerror = () => reject(new Error('上传中断，请检查网络后重试'));
    request.onabort = () => reject(new Error('已停止'));
    signal?.addEventListener('abort', abort, { once: true });
    request.onload = () => {
      let value: { error?: unknown } | undefined;
      try { value = JSON.parse(request.responseText); } catch { /* The status line still explains the failure. */ }
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new Error(typeof value?.error === 'string' ? value.error : `HTTP ${request.status}`));
    };
    request.send(file);
  });
}

/** The file panel's rename, delete and replace questions. Focus stays inside like the draft dialog; Escape cancels. */
export function FileActionDialog({ title, children, confirmLabel, danger = false, busy, error, secondary, onCancel, onConfirm }: {
  title: string; children: ReactNode; confirmLabel: string; danger?: boolean; busy: boolean; error?: string;
  secondary?: { label: string; onClick(): void }; onCancel(): void; onConfirm(): void;
}) {
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    const input = form.current?.querySelector<HTMLInputElement>('input');
    if (input) { input.focus(); const dot = input.value.lastIndexOf('.'); input.setSelectionRange(0, dot > 0 ? dot : input.value.length); }
    // A replace or delete starts on 取消, so Enter alone never destroys a file.
    else form.current?.querySelector<HTMLButtonElement>(danger ? 'button[type="button"]' : 'button[type="submit"]')?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return <div className="studio-dialog file-action-dialog" role="dialog" aria-modal="true" aria-labelledby="file-action-title" onKeyDown={event => {
    if (event.key === 'Escape' && !busy) { event.preventDefault(); onCancel(); }
    if (event.key !== 'Tab') return;
    const items = [...form.current?.querySelectorAll<HTMLElement>('input, button:not(:disabled)') ?? []], first = items[0], last = items.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}><form ref={form} onSubmit={event => { event.preventDefault(); if (!busy) onConfirm(); }}>
    <h2 id="file-action-title">{title}</h2>{children}
    {error && <p role="status">{error}</p>}
    <footer><button type="button" disabled={busy} onClick={onCancel}>取消</button>{secondary && <button type="button" disabled={busy} onClick={secondary.onClick}>{secondary.label}</button>}<button type="submit" className={danger ? 'is-danger' : undefined} disabled={busy}>{busy ? '处理中…' : confirmLabel}</button></footer>
  </form></div>;
}
