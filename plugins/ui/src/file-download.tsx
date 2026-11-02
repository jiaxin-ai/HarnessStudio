import { useEffect, useState } from 'react';

/** Where a previewed file lives; each source keeps the access check of the view that lists it. */
export type FileSource =
  | { source: 'task'; taskId: string }
  | { source: 'project'; projectId: string; taskId: string }
  | { source: 'shared'; projectId: string }
  | { source: 'snapshot'; taskId: string; snapshotId: string };

const PDF_PREVIEW_MAX_BYTES = 64 * 1024 * 1024;
export const isPdf = (path: string) => /\.pdf$/i.test(path);
const fileName = (path: string) => path.split('/').at(-1) || 'file';

export async function fetchFile(from: FileSource, path: string, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(`/api/studio/file/download?${new URLSearchParams({ ...from, path })}`, { ...(signal ? { signal } : {}) });
  if (!response.ok) {
    const value = await response.json().catch(() => undefined) as { error?: unknown } | undefined;
    throw new Error(typeof value?.error === 'string' ? value.error : `下载失败（HTTP ${response.status}）`);
  }
  return response.blob();
}

/** Saves the original bytes; nothing is rendered by the page. */
export function DownloadButton({ from, path, className = 'file-edit-button' }: { from: FileSource; path: string; className?: string }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <button type="button" className={className} disabled={busy} title={error || `下载原文件 ${fileName(path)}`} aria-label={`下载 ${fileName(path)}`} onClick={() => {
    setBusy(true); setError('');
    void fetchFile(from, path).then(blob => {
      const url = URL.createObjectURL(blob), anchor = document.createElement('a');
      anchor.href = url; anchor.download = fileName(path); anchor.style.display = 'none';
      document.body.append(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }, reason => setError(reason instanceof Error ? reason.message : '下载失败')).finally(() => setBusy(false));
  }}>{busy ? '正在下载…' : error ? '下载失败，重试' : '下载'}</button>;
}

/** PDF review in the browser's own viewer, from a typed blob; other binaries are offered for download only. */
export function PdfPreview({ from, path, bytes }: { from: FileSource; path: string; bytes?: number }) {
  const [url, setUrl] = useState<string>(), [error, setError] = useState('');
  const key = JSON.stringify([from, path]);
  useEffect(() => {
    if (bytes !== undefined && bytes > PDF_PREVIEW_MAX_BYTES) { setError('PDF 超过 64 MiB，请下载后查看。'); return; }
    const controller = new AbortController(); let created: string | undefined;
    setUrl(undefined); setError('');
    void fetchFile(from, path, controller.signal).then(async blob => {
      if (new TextDecoder().decode(await blob.slice(0, 5).arrayBuffer()) !== '%PDF-') throw new Error('文件扩展名为 PDF，但内容不是有效的 PDF。');
      created = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' })); setUrl(created);
    }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'PDF 读取失败'); });
    return () => { controller.abort(); if (created) URL.revokeObjectURL(created); };
  }, [key, bytes]);
  if (error) return <div className="file-preview-placeholder"><strong>无法在线预览此 PDF</strong><p>{error}</p><DownloadButton from={from} path={path} /></div>;
  if (!url) return <p role="status">正在载入 PDF…</p>;
  return <iframe className="file-pdf-preview" src={url} title={`PDF 预览：${fileName(path)}`} />;
}

/** Fallback for files without a text preview: PDFs are shown, other formats (DWG, STEP, …) are downloaded. */
export function BinaryPreview({ from, path, bytes, tooLarge }: { from: FileSource; path: string; bytes?: number; tooLarge: boolean }) {
  if (isPdf(path)) return <PdfPreview from={from} path={path} {...(bytes === undefined ? {} : { bytes })} />;
  return <div className="file-preview-placeholder"><strong>{tooLarge ? '文件超过文本预览大小上限' : '此格式暂不支持在线预览'}</strong><p>请下载后用对应软件打开，例如 DWG 用 AutoCAD、SLDPRT 用 SolidWorks。</p><DownloadButton from={from} path={path} /></div>;
}
