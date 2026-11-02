import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useEffect, useState } from 'react';
import { JsonText } from './json-viewer.tsx';
import { fetchFile, type FileSource } from './file-download.tsx';
import { safeWebUrl } from './chat-state.ts';

/** Text files with a rendered view next to their source. */
export type RenderKind = 'markdown' | 'html';
export const renderKind = (path: string): RenderKind | undefined => /\.(md|markdown|mdown|mkd|mkdn)$/i.test(path) ? 'markdown' : /\.html?$/i.test(path) ? 'html' : undefined;

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon', avif: 'image/avif' };
const IMAGE_MAX_BYTES = 20 * 1024 * 1024, HTML_IMAGE_LIMIT = 50;
const imageType = (path: string) => IMAGE_TYPES[path.split('.').at(-1)?.toLowerCase() ?? ''];

/** A link or image path of a document, resolved against the document's folder; undefined when it leaves the file root
 * or is not a plain relative path (a URL, a data: or a bare #anchor). */
export function resolveRelative(documentPath: string, reference: string | undefined): string | undefined {
  if (!reference || /^[a-z][a-z0-9+.-]*:/i.test(reference) || reference.startsWith('//') || reference.startsWith('#')) return;
  let path = reference.split(/[?#]/)[0]!;
  try { path = decodeURIComponent(path); } catch { return; }
  const parts = path.startsWith('/') ? [] : documentPath.split('/').slice(0, -1);
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return; parts.pop(); } else parts.push(part);
  }
  return parts.length ? parts.join('/') : undefined;
}

/** The 预览 / 源码 switch of a Markdown or HTML file. */
export function PreviewModeSwitch({ source, onChange }: { source: boolean; onChange(source: boolean): void }) {
  return <div className="file-view-switch" role="group" aria-label="显示方式">
    <button type="button" aria-pressed={!source} onClick={() => onChange(false)}>预览</button>
    <button type="button" aria-pressed={source} onClick={() => onChange(true)}>源码</button>
  </div>;
}

/** A text file's body: rendered Markdown or sandboxed HTML unless the source is asked for; JSON as a tree; other text as is. */
export function TextFilePreview({ path, content, source, from, onOpen }: { path: string; content: string; source: boolean; from: FileSource; onOpen?(path: string): void }) {
  const kind = renderKind(path);
  if (!source && kind === 'markdown') return <MarkdownPreview path={path} content={content} from={from} {...(onOpen ? { onOpen } : {})} />;
  if (!source && kind === 'html') return <HtmlPreview path={path} content={content} from={from} />;
  return <JsonText text={content} allowPrimitive={/\.json$/i.test(path)} fallback={<pre>{content || '（空文件）'}</pre>} />;
}

/** Markdown in Studio's own page: raw HTML in the file stays text, links to other files open them in this panel,
 * web links open a new tab, and only images stored next to the file are loaded. */
function MarkdownPreview({ path, content, from, onOpen }: { path: string; content: string; from: FileSource; onOpen?(path: string): void }) {
  if (!content.trim()) return <p className="file-markdown-empty">（空文件）</p>;
  return <div className="file-markdown"><Markdown remarkPlugins={[remarkGfm]} components={{
    a: ({ href, children }) => {
      const web = safeWebUrl(href) ?? (href?.startsWith('mailto:') ? href : undefined);
      if (web) return <a href={web} target="_blank" rel="noreferrer noopener">{children}</a>;
      const target = resolveRelative(path, href);
      return target && onOpen ? <button type="button" className="file-markdown-link" title={target} onClick={() => onOpen(target)}>{children}</button> : <span className="file-markdown-anchor">{children}</span>;
    },
    img: ({ src, alt }) => <MarkdownImage from={from} documentPath={path} src={typeof src === 'string' ? src : undefined} alt={alt ?? ''} />,
  }}>{content}</Markdown></div>;
}

function MarkdownImage({ from, documentPath, src, alt }: { from: FileSource; documentPath: string; src: string | undefined; alt: string }) {
  const target = resolveRelative(documentPath, src), type = target && imageType(target);
  const [url, setUrl] = useState<string>(), [error, setError] = useState('');
  const key = JSON.stringify([from, target]);
  useEffect(() => {
    if (!target || !type) return;
    const controller = new AbortController(); let created: string | undefined;
    setUrl(undefined); setError('');
    void fetchFile(from, target, controller.signal).then(blob => {
      if (blob.size > IMAGE_MAX_BYTES) throw new Error('图片超过 20 MB');
      created = URL.createObjectURL(new Blob([blob], { type })); setUrl(created);
    }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '图片读取失败'); });
    return () => { controller.abort(); if (created) URL.revokeObjectURL(created); };
  }, [key, type]);
  const web = safeWebUrl(src);
  if (web) return <a className="file-markdown-image-note" href={web} target="_blank" rel="noreferrer noopener" title={web}>图片：{alt || web}（外部图片，点击打开）</a>;
  if (!target || !type) return <span className="file-markdown-image-note">图片：{alt || src || '无地址'}</span>;
  if (error) return <span className="file-markdown-image-note" title={target}>图片 {target} 无法显示：{error}</span>;
  return url ? <img src={url} alt={alt} title={alt || target} /> : <span className="file-markdown-image-note">正在载入图片…</span>;
}

// The page renders with no script, no network and no navigation; images stored next to the file are inlined.
const HTML_POLICY = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; media-src data:; form-action 'none'";
const dataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });

/** The document given to the sandboxed frame. DOMParser builds an inert document: nothing in it runs or loads here. */
export async function sandboxedHtml(content: string, documentPath: string, load?: (path: string) => Promise<Blob>): Promise<string> {
  const parsed = new DOMParser().parseFromString(content, 'text/html');
  for (const element of parsed.querySelectorAll('base, meta[http-equiv="refresh" i]')) element.remove();
  let inlined = 0;
  for (const image of parsed.querySelectorAll('img')) {
    image.removeAttribute('srcset');
    const target = resolveRelative(documentPath, image.getAttribute('src') ?? undefined), type = target && imageType(target);
    if (!load || !target || !type || inlined >= HTML_IMAGE_LIMIT) continue;
    try { const blob = await load(target); if (blob.size <= IMAGE_MAX_BYTES) { image.setAttribute('src', await dataUrl(new Blob([blob], { type }))); inlined++; } } catch { /* the image stays missing */ }
  }
  const policy = parsed.createElement('meta'); policy.httpEquiv = 'Content-Security-Policy'; policy.content = HTML_POLICY;
  // Links open nothing: the frame may not open windows, and _blank keeps it from navigating itself.
  const base = parsed.createElement('base'); base.target = '_blank';
  parsed.head.prepend(policy, base);
  return `${parsed.doctype ? '<!DOCTYPE html>\n' : ''}${parsed.documentElement.outerHTML}`;
}

function HtmlPreview({ path, content, from }: { path: string; content: string; from: FileSource }) {
  const [html, setHtml] = useState<string>(), [error, setError] = useState('');
  const key = JSON.stringify([from, path]);
  useEffect(() => {
    const controller = new AbortController(); setHtml(undefined); setError('');
    void sandboxedHtml(content, path, target => fetchFile(from, target, controller.signal)).then(value => { if (!controller.signal.aborted) setHtml(value); },
      reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'HTML 预览失败'); });
    return () => controller.abort();
  }, [key, content]);
  if (error) return <p className="project-files-error" role="status">{error}</p>;
  if (html === undefined) return <p role="status">正在生成预览…</p>;
  return <div className="file-html-preview"><p>安全预览：不运行脚本，不加载外部资源，链接不可点击。需要完整效果请下载后用浏览器打开。</p>
    <iframe sandbox="" srcDoc={html} referrerPolicy="no-referrer" title={`HTML 预览：${path.split('/').at(-1) ?? path}`} /></div>;
}

