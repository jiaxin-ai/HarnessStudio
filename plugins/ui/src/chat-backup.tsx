import { useCallback, useEffect, useRef, useState } from 'react';

/** Ignore path separators and control characters even in a server-provided download name. */
export function backupDownloadName(disposition: string | null): string {
  const encoded = disposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain = disposition?.match(/filename="([^"]+)"/i)?.[1] ?? disposition?.match(/filename=([^;]+)/i)?.[1];
  let name = plain?.trim() ?? '';
  if (encoded) { try { name = decodeURIComponent(encoded); } catch { /* Fall back to the plain name. */ } }
  name = name.replace(/[\/\\\u0000-\u001f\u007f]/g, '_').slice(0, 200).trim();
  if (!name || name === '.' || name === '..') name = `conversation-${new Date().toISOString().replace(/[:.]/g, '-')}.debug.json`;
  if (/\.debug\.json$/iu.test(name)) return name;
  return `${name.replace(/(?:\.hsc)?\.json$/iu, '')}.debug.json`;
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  try { const value = await response.json(); return new Error(typeof value?.error === 'string' ? value.error : fallback); }
  catch { return new Error(fallback); }
}

/** A debug download is read-only and never stops a running Agent. */
export function useChatBackup(scopeKey: string) {
  const [busyId, setBusyId] = useState(''), [error, setError] = useState('');
  const request = useRef<AbortController>(), generation = useRef(0);
  useEffect(() => {
    generation.current++; request.current?.abort(); request.current = undefined; setBusyId(''); setError('');
    return () => { generation.current++; request.current?.abort(); request.current = undefined; };
  }, [scopeKey]);
  const download = useCallback(async (chatId: string) => {
    if (request.current) return;
    const controller = new AbortController(), sequence = generation.current;
    request.current = controller; setBusyId(chatId); setError('');
    try {
      const response = await fetch(`/api/studio/chat/backup?id=${encodeURIComponent(chatId)}`, { signal: controller.signal });
      if (!response.ok) throw await responseError(response, '对话调试 JSON 下载失败，请等本轮结束后重试。');
      const blob = await response.blob();
      if (controller.signal.aborted || sequence !== generation.current) return;
      const url = URL.createObjectURL(blob), anchor = document.createElement('a');
      anchor.href = url; anchor.download = backupDownloadName(response.headers.get('content-disposition')); anchor.style.display = 'none';
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      if (!controller.signal.aborted && sequence === generation.current) setError(error instanceof Error ? error.message : '对话调试 JSON 下载失败');
    } finally {
      if (sequence === generation.current) { request.current = undefined; setBusyId(''); }
    }
  }, []);
  return { busyId, error, download };
}
