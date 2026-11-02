import { useEffect, useRef, useState } from 'react';
import { CHAT_ATTACHMENT_LIMITS, type ChatAttachmentMediaType, type ChatAttachmentUpload, type ChatAttachmentView } from '@harnessstudio/studio/chat-attachment-types';
import { api } from './api.ts';
import { randomId } from './random-id.ts';

interface DraftFile { id: string; file: File }
const draftFiles = new Map<string, DraftFile[]>();
/** A confirmed permanent clear/delete must also forget unsent private drafts. */
export function forgetChatAttachmentDrafts(keys: Iterable<string>) {
  for (const key of keys) draftFiles.delete(key);
}
const formats = new Set<string>(['image/png', 'image/jpeg', 'image/webp', 'application/pdf']);
const size = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
export function useChatAttachmentDraft(key: string) {
  const [draft, setDraft] = useState<{ key: string; files: DraftFile[] }>(() => ({ key, files: draftFiles.get(key) ?? [] }));
  const [error, setError] = useState('');
  const files = draft.key === key ? draft.files : draftFiles.get(key) ?? [];
  useEffect(() => { setDraft({ key, files: draftFiles.get(key) ?? [] }); setError(''); }, [key]);
  const replace = (next: DraftFile[]) => { if (next.length) draftFiles.set(key, next); else draftFiles.delete(key); setDraft({ key, files: next }); };
  return { files, error, setError,
    add: (values: File[]) => {
      if (!values.length) return;
      const next = [...files, ...values.map(file => ({ id: randomId(), file }))];
      if (next.length > CHAT_ATTACHMENT_LIMITS.maxUploads) return setError('每条消息最多添加 4 个文件。');
      if (values.some(file => !formats.has(file.type))) return setError('请上传 PNG、JPEG、WebP 或 PDF。CAD / EDA 原始文件请先导出为图片或 PDF。');
      if (values.some(file => !file.size || file.size > CHAT_ATTACHMENT_LIMITS.maxFileBytes)) return setError('单个文件需大于 0 字节且不超过 10 MB。');
      if (next.reduce((total, row) => total + row.file.size, 0) > CHAT_ATTACHMENT_LIMITS.maxTotalBytes) return setError('每条消息的附件总大小不能超过 20 MB。');
      setError(''); replace(next);
    },
    remove: (id: string) => { setError(''); replace(files.filter(row => row.id !== id)); },
    clear: () => { setError(''); replace([]); },
    encode: async (): Promise<ChatAttachmentUpload[]> => Promise.all(files.map(({ file }) => new Promise<ChatAttachmentUpload>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(`无法读取附件：${file.name}`));
      reader.onload = () => { const value = reader.result; if (typeof value !== 'string' || !value.includes(',')) reject(new Error(`附件读取失败：${file.name}`)); else resolve({ name: file.name, mediaType: file.type as ChatAttachmentMediaType, data: value.slice(value.indexOf(',') + 1) }); };
      reader.readAsDataURL(file);
    }))),
  };
}
function DraftPreview({ row, disabled, onRemove }: { row: DraftFile; disabled: boolean; onRemove(): void }) {
  const [url, setUrl] = useState('');
  useEffect(() => { if (!row.file.type.startsWith('image/')) return; const value = URL.createObjectURL(row.file); setUrl(value); return () => URL.revokeObjectURL(value); }, [row.file]);
  return <div className="chat-attachment-draft">{url ? <img src={url} alt="" /> : <span className="chat-attachment-pdf" aria-hidden="true">PDF</span>}<span><strong title={row.file.name}>{row.file.name}</strong><small>{size(row.file.size)}</small></span><button type="button" aria-label={`移除附件：${row.file.name}`} title="移除附件" disabled={disabled} onClick={onRemove}>×</button></div>;
}
export function AttachmentDrafts({ files, disabled, onRemove }: { files: DraftFile[]; disabled: boolean; onRemove(id: string): void }) {
  if (!files.length) return null;
  return <div className="chat-attachment-drafts" aria-label="待发送附件">{files.map(row => <DraftPreview key={row.id} row={row} disabled={disabled} onRemove={() => onRemove(row.id)} />)}</div>;
}
export function AttachmentPicker({ disabled, onFiles }: { disabled: boolean; onFiles(files: File[]): void }) {
  const input = useRef<HTMLInputElement>(null);
  return <><input ref={input} type="file" className="chat-attachment-input" aria-label="上传图纸或图片" accept="image/png,image/jpeg,image/webp,application/pdf" multiple disabled={disabled} onChange={event => { onFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} /><button className="chat-attachment-button" type="button" disabled={disabled} aria-label="添加图纸或图片" title="添加图片或 PDF 图纸（单文件 ≤10 MB，PDF ≤6 页）" onClick={() => input.current?.click()}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 10 5-5a3 3 0 0 1 4 4l-7 7a4.5 4.5 0 0 1-6-6l7-7M6 12l7-7" /></svg></button></>;
}
const noAttachments: ChatAttachmentView[] = [];
export function useChatAttachmentHistory(id?: string, version?: number) {
  const [state, setState] = useState<{ id?: string; attachments: ChatAttachmentView[] }>({ attachments: [] });
  useEffect(() => {
    if (!id) { setState({ attachments: [] }); return; }
    let active = true;
    void api<{ id: string; attachments: ChatAttachmentView[] }>(`chat/attachments?id=${encodeURIComponent(id)}`).then(value => { if (active) setState(value); }, () => { /* Message image labels remain visible when metadata cannot be fetched. */ });
    return () => { active = false; };
  }, [id, version]);
  return state.id === id ? state.attachments : noAttachments;
}
export function MessageAttachments({ chatId, images, files }: { chatId?: string; images: { attachmentId: string; name?: string; uploadId?: string }[]; files: ChatAttachmentView[] }) {
  const matches = (file: ChatAttachmentView, image: { attachmentId: string; uploadId?: string }) => (!image.uploadId || file.id === image.uploadId) && file.images.some(row => row.attachmentId === image.attachmentId);
  const matched = files.filter(file => images.some(image => matches(file, image)));
  const unknown = images.filter(image => !matched.some(file => matches(file, image)));
  return <div className="chat-message-attachments" aria-label="已发送附件">{chatId && matched.map(file => {
    const query = `/api/studio/chat/attachment?id=${encodeURIComponent(chatId)}&attachmentId=${encodeURIComponent(file.id)}`;
    return <a key={file.id} href={query} target="_blank" rel="noreferrer noopener" className="chat-message-attachment"><img src={`${query}&page=1`} alt={file.mediaType === 'application/pdf' ? `${file.name}，第 1 页预览` : file.name} loading="lazy" /><span><strong>{file.name}</strong><small>{file.mediaType === 'application/pdf' ? `PDF · ${file.images.length} 页 · ` : ''}{size(file.bytes)}</small></span></a>;
  })}{unknown.map((image, index) => <span className="chat-attachment-unavailable" key={`${image.attachmentId}-${index}`}>{image.name || '图像附件'}</span>)}</div>;
}
