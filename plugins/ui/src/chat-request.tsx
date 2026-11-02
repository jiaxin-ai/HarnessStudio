import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { JsonViewer as ChatRequestJson } from './json-viewer.tsx';
export { ChatRequestJson };
import type { ChatAuditBody, ChatAuditRecord } from '@harnessstudio/studio/chat-audit-types';

interface RequestSummary {
  id: string; turn: number | null; step: number | null; attempt: number; provider: string; model: string;
  purpose?: 'conversation' | 'compaction' | 'session-title';
  startedAt?: string; status: string; requestAvailable: boolean; responseAvailable: boolean;
}
interface RequestIndex {
  id: string; userSeq: number; asOfSeq: number; modifiedAt?: string; requests: RequestSummary[];
  completeness?: { status: string; notes?: string[] };
}
interface RequestDetail {
  id: string; record: ChatAuditRecord; notes?: string[];
}

export function userMessageSequence(rowId: string): number | undefined {
  const match = /^user-(\d+)$/.exec(rowId), value = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function UserMessageRequestButton({ chatId, rowId, onInspect }: { chatId?: string; rowId: string; onInspect(userSeq: number): void }) {
  const userSeq = userMessageSequence(rowId);
  if (!chatId || userSeq === undefined) return null;
  return <button className="user-request-button" type="button" onClick={() => onInspect(userSeq)}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5 4-3 4 3 4m6-8 3 4-3 4M9 3 7 13" /></svg>查看模型请求</button>;
}

async function readJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  const value = await response.json();
  if (!response.ok) throw new Error(typeof value?.error === 'string' ? value.error : '模型请求读取失败，请重试。');
  return value;
}

const statusLabel = (status: string) => ({ completed: '已返回', success: '已返回', finished: '已返回', running: '进行中', pending: '等待中', failed: '失败', error: '失败', interrupted: '已中断', unknown: '结果未知' }[status] ?? status);
const timeLabel = (value?: string) => {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

export function auditBodyValue(body: ChatAuditBody): unknown {
  if (body.body !== undefined) return body.body;
  if (body.events !== undefined) return body.events;
  return body.raw !== undefined ? { encoding: body.encoding, raw: body.raw } : undefined;
}

const bodyStatus = (body: ChatAuditBody) => ({ capturing: '正在采集，内容可能尚未齐全', complete: '已完整采集', partial: '部分内容未保存', unavailable: '未保存实际传输内容' }[body.status]);

function saveRawBody(body: ChatAuditBody, recordId: string, ordinal: number, side: 'request' | 'response') {
  if (body.raw === undefined) return;
  const bytes = body.encoding === 'base64' ? Uint8Array.from(atob(body.raw), character => character.charCodeAt(0)) : body.raw;
  const blob = new Blob([bytes], { type: body.encoding === 'base64' ? 'application/octet-stream' : body.format === 'json' ? 'application/json;charset=utf-8' : 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = `${recordId}-transport-${ordinal}-${side}.${body.encoding === 'base64' ? 'bin' : body.format === 'json' ? 'json' : 'txt'}`;
  anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Mounting this modal is the first and only trigger for loading request metadata. */
export function ChatRequestDialog({ chatId, userSeq, onClose }: { chatId: string; userSeq: number; onClose(): void }) {
  const titleId = useId(), dialog = useRef<HTMLDivElement>(null), close = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose); onCloseRef.current = onClose;
  const [index, setIndex] = useState<RequestIndex>(), [indexError, setIndexError] = useState(''), [indexRetry, setIndexRetry] = useState(0);
  const [selected, setSelected] = useState(''), [detail, setDetail] = useState<RequestDetail>(), [detailError, setDetailError] = useState(''), [detailRetry, setDetailRetry] = useState(0);
  const [side, setSide] = useState<'request' | 'response' | 'logical'>('request'), [transportOrdinal, setTransportOrdinal] = useState(0);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    close.current?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCloseRef.current(); return; }
      if (event.key !== 'Tab' || !dialog.current) return;
      const nodes = [...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]')].filter(node => node.getClientRects().length > 0);
      if (!nodes.length) { event.preventDefault(); dialog.current.focus(); return; }
      const first = nodes[0], last = nodes.at(-1)!;
      if (event.shiftKey && (document.activeElement === first || !dialog.current.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.current.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keyboard, true);
    return () => { document.removeEventListener('keydown', keyboard, true); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setIndex(undefined); setSelected(''); setIndexError('');
    void readJson<RequestIndex>(`/api/studio/chat/requests?id=${encodeURIComponent(chatId)}&userSeq=${userSeq}`, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      if (value.id !== chatId || value.userSeq !== userSeq || !Array.isArray(value.requests)) throw new Error('模型请求与当前发言不匹配，请重新打开。');
      setIndex(value); setSelected(value.requests[0]?.id ?? '');
    }).catch(error => { if (!controller.signal.aborted) setIndexError(error instanceof Error ? error.message : '模型请求读取失败'); });
    return () => controller.abort();
  }, [chatId, userSeq, indexRetry]);

  useEffect(() => {
    setDetail(undefined); setDetailError('');
    if (!selected) return;
    const controller = new AbortController();
    void readJson<RequestDetail>(`/api/studio/chat/request?id=${encodeURIComponent(chatId)}&requestId=${encodeURIComponent(selected)}`, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      if (value.id !== selected || value.record?.recordId !== selected || !Array.isArray(value.record.transports)) throw new Error('返回的请求记录不匹配，请重试。');
      setDetail(value); setTransportOrdinal(value.record.transports.find(row => row.classification === 'model-json')?.ordinal ?? value.record.transports[0]?.ordinal ?? 0);
    }).catch(error => { if (!controller.signal.aborted) setDetailError(error instanceof Error ? error.message : '请求详情读取失败'); });
    return () => controller.abort();
  }, [chatId, selected, detailRetry]);

  const current = detail?.id === selected ? detail : undefined, summary = index?.requests.find(row => row.id === selected);
  const transport = current?.record.transports.find(row => row.ordinal === transportOrdinal);
  const body = side === 'logical' ? undefined : transport?.[side];
  const value = side === 'logical' ? current?.record.request : body ? auditBodyValue(body) : undefined;
  return createPortal(<div className="chat-request-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="chat-request-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialog} tabIndex={-1}>
      <header className="chat-request-heading"><div><h3 id={titleId}>模型请求</h3><p>按本次发言的模型调用逐步查看请求与响应</p></div><div className="chat-request-heading-actions"><button type="button" className="chat-request-refresh" title="刷新已保存的调用记录" onClick={() => setIndexRetry(value => value + 1)}>刷新</button><button ref={close} type="button" className="chat-request-close" aria-label="关闭模型请求" title="关闭" onClick={onClose}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg></button></div></header>
      {indexError ? <div className="chat-request-empty" role="status"><p>{indexError}</p><button type="button" onClick={() => setIndexRetry(value => value + 1)}>重试</button></div>
        : !index ? <div className="chat-request-empty" role="status">正在读取调用记录…</div>
        : !index.requests.length ? <div className="chat-request-empty">这条发言尚无已保存的模型请求。旧版本未记录的原始请求无法追溯补录。</div>
        : <div className="chat-request-body"><nav className="chat-request-list" aria-label="本次发言的模型请求">{index.requests.map((row, position) => <button key={row.id} type="button" className={row.id === selected ? 'is-active' : ''} aria-current={row.id === selected ? 'true' : undefined} onClick={() => { setSelected(row.id); setSide('request'); }}>
          <span><strong>{row.purpose === 'compaction' ? '上下文整理' : row.purpose === 'session-title' ? '对话命名' : row.step === null ? '辅助调用' : `步骤 ${row.step}`}</strong><small>{row.attempt > 1 ? `尝试 ${row.attempt}` : `调用 ${position + 1}`}</small></span><span className="chat-request-model">{row.model || '未知模型'}</span><small>{statusLabel(row.status)}</small>
        </button>)}</nav><section className="chat-request-detail" aria-label="模型调用详情">
          <div className="chat-request-toolbar"><div className="chat-request-switch" aria-label="请求或响应"><button type="button" aria-pressed={side === 'request'} onClick={() => setSide('request')}>实际请求</button><button type="button" aria-pressed={side === 'response'} onClick={() => setSide('response')}>实际响应</button><button type="button" aria-pressed={side === 'logical'} onClick={() => setSide('logical')}>逻辑输入</button></div><span title={summary?.startedAt}>{summary?.provider}{summary?.startedAt ? ` · ${timeLabel(summary.startedAt)}` : ''}</span></div>
          {detailError ? <div className="chat-request-empty" role="status"><p>{detailError}</p><button type="button" onClick={() => setDetailRetry(value => value + 1)}>重试</button></div>
            : !current ? <div className="chat-request-empty" role="status">正在读取该次调用…</div>
            : <>{side === 'logical' ? <div className="chat-request-source-note">Harness 提供的逻辑输入，用于理解上下文；这是转换为 Provider 请求之前的数据。</div> : <><div className="chat-request-transport"><label>传输<select aria-label="选择实际传输" value={transportOrdinal} disabled={!current.record.transports.length} onChange={event => setTransportOrdinal(Number(event.target.value))}>{!current.record.transports.length && <option value={0}>暂无传输记录</option>}{current.record.transports.map(row => <option key={row.ordinal} value={row.ordinal}>传输 {row.ordinal}{row.classification === 'auxiliary-json' ? ' · 附加请求' : ''}{row.statusCode ? ` · HTTP ${row.statusCode}` : ''}</option>)}</select></label>{body?.raw !== undefined && <button type="button" onClick={() => saveRawBody(body, selected, transportOrdinal, side)}>下载原始{side === 'request' ? '请求' : '响应'}</button>}</div>{body && <div className={`chat-request-body-status${body.status !== 'complete' ? ' is-partial' : ''}`}><span>{bodyStatus(body)}{body.reason ? ` · ${body.reason}` : ''}</span><small>{body.bytes.toLocaleString()} 字节{body.observedBytes !== body.bytes ? ` / 已接收 ${body.observedBytes.toLocaleString()}` : ''}</small></div>}</>}
              <div className="chat-request-json">{value !== undefined ? <ChatRequestJson key={`${selected}:${side}:${transportOrdinal}`} value={value} /> : <div className="chat-request-empty">{side === 'request' ? '该次调用没有保存实际请求内容。' : '该次调用尚无已保存的实际响应内容。'}</div>}</div>{!!current.notes?.length && <ul className="chat-request-notes">{current.notes.map((note, i) => <li key={i}>{note}</li>)}</ul>}</>}
        </section></div>}
      {!!index?.completeness?.notes?.length && <ul className="chat-request-notes">{index.completeness.notes.map((note, i) => <li key={i}>{note}</li>)}</ul>}
      <footer className="chat-request-footer">嵌套字段默认折叠，长文本可单独展开。此视图只读取已保存的调用记录。</footer>
    </div>
  </div>, document.body);
}
