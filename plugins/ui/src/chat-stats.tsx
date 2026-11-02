import { useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import type { ChatMetrics } from '@harnessstudio/studio/chat-types';
import { exactStatTokens, formatStatPercent, formatStatTokens } from './chat-stats-format.ts';

export function ChatStats({ metrics }: { metrics?: ChatMetrics }) {
  const [open, setOpen] = useState(false), [anchorVersion, setAnchorVersion] = useState(0), [position, setPosition] = useState<{ left: number; top: number }>();
  const panelId = useId(), titleId = useId(), bar = useRef<HTMLDivElement>(null), panel = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement | null>(null), closeButton = useRef<HTMLButtonElement>(null);
  const context = metrics?.context, usage = metrics?.usage;
  const contextPercent = formatStatPercent(context?.percent), cachePercent = formatStatPercent(usage?.cacheReported ? usage.cacheHitPercent : undefined);
  const close = (restoreFocus = true) => { setOpen(false); if (restoreFocus && trigger.current?.isConnected) trigger.current.focus(); };
  const show = (event: MouseEvent<HTMLButtonElement>) => {
    if (open && trigger.current === event.currentTarget) { close(); return; }
    trigger.current = event.currentTarget; setPosition(undefined); setAnchorVersion(value => value + 1); setOpen(true);
  };
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect(), bounds = panel.current?.getBoundingClientRect();
      if (!anchor || !bounds) return;
      const left = Math.max(12, Math.min(anchor.left, window.innerWidth - bounds.width - 12));
      const preferredTop = anchor.top - bounds.height - 8;
      const top = Math.max(12, Math.min(preferredTop >= 12 ? preferredTop : anchor.bottom + 8, window.innerHeight - bounds.height - 12));
      setPosition({ left, top });
    };
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, metrics, anchorVersion]);
  useEffect(() => {
    if (!open) return;
    closeButton.current?.focus();
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !panel.current?.contains(event.target) && !bar.current?.contains(event.target)) close(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  const inputTotal = usage ? usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens : undefined;
  return <><div ref={bar} className="chat-statbar" role="group" aria-label="对话用量统计">
    <button type="button" className={`chat-stat-button${(context?.percent ?? 0) >= 90 ? ' is-high' : ''}`} aria-label="查看上下文统计" aria-expanded={open && trigger.current?.getAttribute('aria-label') === '查看上下文统计'} aria-controls={open ? panelId : undefined} title={context?.percent === undefined ? '尚未取得上下文占用与模型容量' : `上下文参考占用：约 ${exactStatTokens(context.tokens)} / ${exactStatTokens(context.capacity)} tokens`} onClick={show}><svg className="chat-context-ring" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="6" /><circle cx="9" cy="9" r="6" className="chat-context-ring-value" pathLength="100" strokeDasharray={`${Math.min(100, Math.max(0, context?.percent ?? 0))} 100`} transform="rotate(-90 9 9)" /></svg><span>上下文 <strong>{context?.percent === undefined ? '—' : `≈${contextPercent}`}</strong></span></button>
    <button type="button" className="chat-stat-button" aria-label="查看 Token 用量" aria-expanded={open && trigger.current?.getAttribute('aria-label') === '查看 Token 用量'} aria-controls={open ? panelId : undefined} title={usage ? `当前对话累计记录 ${exactStatTokens(usage.totalTokens)} tokens，点击查看输入、输出及缓存明细` : 'Provider 尚未返回 token 用量'} onClick={show}><span>Token <strong>{formatStatTokens(usage?.totalTokens)}</strong></span></button>
    <button type="button" className="chat-stat-button" aria-label="查看缓存统计" aria-expanded={open && trigger.current?.getAttribute('aria-label') === '查看缓存统计'} aria-controls={open ? panelId : undefined} title={usage?.cacheReported && usage.cacheHitPercent !== undefined ? `累计输入缓存命中率 ${usage.cacheHitPercent.toLocaleString('zh-CN', { maximumFractionDigits: 4 })}%，并非下一次请求的命中概率` : 'Provider 尚未返回可用的缓存命中统计'} onClick={show}><span>缓存命中 <strong>{cachePercent}</strong></span></button>
  </div>{open && createPortal(<div ref={panel} id={panelId} className="chat-stats-popover" role="dialog" aria-labelledby={titleId} style={{ left: position?.left ?? 12, top: position?.top ?? 12, visibility: position ? 'visible' : 'hidden' }}>
    <header><h4 id={titleId}>对话统计</h4><button ref={closeButton} type="button" aria-label="关闭对话统计" onClick={() => close()}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" /></svg></button></header>
    <section><h5>当前上下文 <span>{context?.percent === undefined ? '—' : `≈${contextPercent}`}</span></h5><dl><div><dt>参考占用</dt><dd>{exactStatTokens(context?.tokens)} tokens</dd></div><div><dt>模型容量</dt><dd>{exactStatTokens(context?.capacity)} tokens</dd></div></dl><p>基于 DSH 原生上下文投影的参考值，可能包含估算；用于了解上下文占用，不作为计费用量。</p></section>
    <section><h5>当前对话累计用量 <span>{exactStatTokens(usage?.totalTokens)}</span></h5><dl><div><dt>输入合计</dt><dd>{exactStatTokens(inputTotal)}</dd></div><div><dt>未缓存输入</dt><dd>{exactStatTokens(usage?.uncachedInputTokens)}</dd></div><div><dt>缓存读取</dt><dd>{usage?.cacheReported ? exactStatTokens(usage.cacheReadTokens) : '—'}</dd></div><div><dt>缓存写入</dt><dd>{usage?.cacheReported ? exactStatTokens(usage.cacheWriteTokens) : '—'}</dd></div><div><dt>输出（含思考）</dt><dd>{exactStatTokens(usage?.outputTokens)}</dd></div></dl><p>沿用 DSH 的对话调用计量，随 Provider 返回更新；思考 token 已包含在输出中。压缩摘要等辅助调用未计入，此处不代表完整账单。</p></section>
    <section><h5>输入缓存命中率 <span>{cachePercent}</span></h5><p>{usage?.cacheReported && usage.cacheHitPercent !== undefined ? '缓存读取 ÷（未缓存输入 + 缓存读取 + 缓存写入）。这是本对话累计已发生请求的输入比例，不是下一次请求的命中概率。' : 'Provider 尚未报告可计算的缓存统计，暂不显示命中率。'}</p></section>
  </div>, document.body)}</>;
}
