import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';

type Direction = 'horizontal' | 'vertical';
type Ratios = Record<Direction, number | null>;
interface Metrics { width: number; height: number; handle: number }
interface Drag { pointerId: number; coordinate: number; first: number; direction: Direction; moved: boolean; ratio: number }

export interface ResizableSplitProps {
  /** Horizontal lays panels out side by side; vertical lays them out top to bottom. */
  direction: Direction;
  label: string;
  first: ReactNode;
  second: ReactNode;
  initialRatio: number;
  /** Optional pixel default before the user saves a layout; reset also uses this size. */
  initialFirstSize?: number;
  minFirst: number;
  minSecond: number;
  maxFirst?: number;
  storageKey: string;
  className?: string;
  /** A horizontal split stacks vertically at or below this viewport width. */
  stackAt?: number;
  /** Optional compact-pane minimum, without reducing its desktop minimum width. */
  stackedMinSecond?: number;
  /** Show only one pane; the other stays mounted (a chat stream or VNC session keeps running) but hidden. */
  maximize?: 'first' | 'second';
  /**
   * Panes that collapse (VS Code style): dragging one below half its minimum collapses it; dragging back, clicking the
   * handle or onCollapsedChange(null) restores it at its previous size. A collapsed pane keeps `collapsedSize` pixels
   * (its title bar stays visible) or, at 0, is hidden behind the handle.
   */
  collapsible?: 'first' | 'second' | 'both';
  collapsed?: 'first' | 'second' | null;
  onCollapsedChange?(collapsed: 'first' | 'second' | null): void;
  collapsedSize?: number;
  /** Changing this value restores the default size (both orientations) and forgets the saved one. */
  resetKey?: number;
}
type Pane = 'first' | 'second';

const bounded = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));
const validRatio = (value: number) => Number.isFinite(value) ? bounded(value, 0, 1) : 0.5;
const safeMinimum = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 0;
function readRatio(key: string, direction: Direction, fallback: number | null): number | null {
  try {
    const stored = window.localStorage.getItem(`${key}:${direction}`);
    if (stored === null || stored.trim() === '') return fallback;
    const value = Number(stored);
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
  } catch { return fallback; }
}
function saveRatio(key: string, direction: Direction, ratio: number) {
  try { window.localStorage.setItem(`${key}:${direction}`, String(ratio)); } catch { /* Layout remains usable when storage is unavailable. */ }
}

/** A native pointer and keyboard splitter; pane content owns its scrolling. */
export function ResizableSplit({ direction, label, first, second, initialRatio, initialFirstSize, minFirst, minSecond, maxFirst, storageKey, className = '', stackAt, stackedMinSecond, maximize, collapsible, collapsed = null, onCollapsedChange, collapsedSize = 0, resetKey = 0 }: ResizableSplitProps) {
  const fallback = validRatio(initialRatio);
  const pixelDefault = initialFirstSize !== undefined && Number.isFinite(initialFirstSize) && initialFirstSize >= 0;
  const storedFallback = pixelDefault ? null : fallback;
  const root = useRef<HTMLDivElement>(null), handle = useRef<HTMLDivElement>(null);
  const ids = useId();
  const mediaQuery = direction === 'horizontal' && stackAt !== undefined && Number.isFinite(stackAt) ? `(max-width: ${Math.max(0, stackAt)}px)` : '';
  const [stacked, setStacked] = useState(() => !!mediaQuery && typeof window !== 'undefined' && window.matchMedia(mediaQuery).matches);
  const actualDirection: Direction = direction === 'horizontal' && stacked ? 'vertical' : direction;
  const [ratios, setRatios] = useState<Ratios>(() => ({ horizontal: readRatio(storageKey, 'horizontal', storedFallback), vertical: readRatio(storageKey, 'vertical', storedFallback) }));
  const ratiosRef = useRef(ratios), drag = useRef<Drag>();
  const [resizing, setResizing] = useState(false);
  const [metrics, setMetrics] = useState<Metrics>({ width: 0, height: 0, handle: 10 });
  const current = useRef({ available: 0, minimum: 0, maximum: 0, first: 0, firstMinimum: 0, secondMinimum: 0 });

  useEffect(() => {
    const next = { horizontal: readRatio(storageKey, 'horizontal', storedFallback), vertical: readRatio(storageKey, 'vertical', storedFallback) };
    ratiosRef.current = next; setRatios(next);
  }, [storageKey, storedFallback]);
  const appliedReset = useRef(resetKey);
  useEffect(() => {
    if (appliedReset.current === resetKey) return;
    appliedReset.current = resetKey;
    const next = { horizontal: storedFallback, vertical: storedFallback };
    ratiosRef.current = next; setRatios(next);
    for (const direction of ['horizontal', 'vertical'] as const) try { window.localStorage.removeItem(`${storageKey}:${direction}`); } catch { /* ignored */ }
  }, [resetKey, storageKey, storedFallback]);
  useEffect(() => {
    if (!mediaQuery) { setStacked(false); return; }
    const media = window.matchMedia(mediaQuery);
    const update = () => setStacked(media.matches);
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [mediaQuery]);
  useEffect(() => {
    const element = root.current, separator = handle.current;
    if (!element || !separator) return;
    const measure = () => {
      const rectangle = separator.getBoundingClientRect();
      const next = { width: element.clientWidth, height: element.clientHeight, handle: (actualDirection === 'horizontal' ? rectangle.width : rectangle.height) || 10 };
      setMetrics(previous => previous.width === next.width && previous.height === next.height && previous.handle === next.handle ? previous : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element); observer.observe(separator);
    return () => observer.disconnect();
  }, [actualDirection]);
  useEffect(() => {
    // End a captured drag if the layout changes while crossing the mobile breakpoint.
    const active = drag.current;
    if (!active || active.direction === actualDirection) return;
    drag.current = undefined; setResizing(false);
    saveRatio(storageKey, active.direction, ratiosRef.current[active.direction] ?? fallback);
    if (handle.current?.hasPointerCapture(active.pointerId)) handle.current.releasePointerCapture(active.pointerId);
  }, [actualDirection, storageKey]);

  const available = Math.max(0, (actualDirection === 'horizontal' ? metrics.width : metrics.height) - metrics.handle);
  const firstMinimum = stacked ? Math.min(160, safeMinimum(minFirst)) : safeMinimum(minFirst);
  const secondMinimum = stacked ? safeMinimum(stackedMinSecond ?? Math.min(140, safeMinimum(minSecond))) : safeMinimum(minSecond);
  const minimumTotal = firstMinimum + secondMinimum;
  // Small windows shrink both minimums proportionally instead of overflowing the app.
  const shrink = minimumTotal > available && minimumTotal > 0 ? available / minimumTotal : 1;
  const minimum = firstMinimum * shrink;
  const firstMaximum = maxFirst !== undefined && Number.isFinite(maxFirst) ? safeMinimum(maxFirst) : available;
  const maximum = Math.max(minimum, Math.min(firstMaximum, available - secondMinimum * shrink));
  const defaultRatio = pixelDefault && available > 0 ? validRatio(initialFirstSize! / available) : fallback;
  const ratio = ratios[actualDirection] ?? defaultRatio;
  const firstSize = bounded(available * ratio, minimum, maximum);
  current.current = { available, minimum, maximum, first: firstSize, firstMinimum, secondMinimum };
  const percentage = available > 0 ? firstSize / available * 100 : ratio * 100;
  const canCollapse = (pane: Pane) => !!onCollapsedChange && (collapsible === 'both' || collapsible === pane);
  const shut = collapsed && canCollapse(collapsed) ? collapsed : null, keep = safeMinimum(collapsedSize);
  // Panes have fixed grid lines (studio.css), so a hidden pane keeps the others in place.
  const tracks = maximize ? maximize === 'first' ? 'minmax(0, 1fr) 0px 0px' : '0px 0px minmax(0, 1fr)'
    : shut === 'first' ? `${keep}px var(--split-handle-size, 10px) minmax(0, 1fr)` : shut === 'second' ? `minmax(0, 1fr) var(--split-handle-size, 10px) ${keep}px`
    : available > 0 ? `${firstSize}px var(--split-handle-size, 10px) minmax(0, 1fr)` : `minmax(0, ${ratio}fr) var(--split-handle-size, 10px) minmax(0, ${1 - ratio}fr)`;
  const style: CSSProperties = actualDirection === 'horizontal' ? { gridTemplateColumns: tracks } : { gridTemplateRows: tracks };


  const changeRatio = (ratio: number, persist: boolean) => {
    const value = validRatio(ratio);
    const next = { ...ratiosRef.current, [actualDirection]: value };
    ratiosRef.current = next; setRatios(next);
    if (persist) saveRatio(storageKey, actualDirection, value);
  };
  const resizeTo = (pixels: number, persist: boolean) => {
    const size = current.current;
    if (size.available > 0) changeRatio(bounded(pixels, size.minimum, size.maximum) / size.available, persist);
  };
  const beginDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || drag.current || current.current.available <= 0) return;
    event.preventDefault(); event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    if (!shut) changeRatio(current.current.first / current.current.available, false);
    const start = shut === 'first' ? keep : shut === 'second' ? current.current.available - keep : current.current.first;
    drag.current = { pointerId: event.pointerId, coordinate: actualDirection === 'horizontal' ? event.clientX : event.clientY, first: start, direction: actualDirection, moved: false, ratio: ratiosRef.current[actualDirection] ?? defaultRatio };
    setResizing(true);
  };
  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId || active.direction !== actualDirection) return;
    event.preventDefault();
    const delta = (actualDirection === 'horizontal' ? event.clientX : event.clientY) - active.coordinate, size = active.first + delta;
    if (Math.abs(delta) > 3) active.moved = true;
    // Past half its minimum a collapsible pane snaps closed; dragging back out reopens it.
    const limits = current.current;
    const next: Pane | null = canCollapse('first') && size < limits.firstMinimum / 2 ? 'first' : canCollapse('second') && limits.available - size < limits.secondMinimum / 2 ? 'second' : null;
    if (next !== shut) onCollapsedChange!(next);
    // Collapsing keeps the size the pane had before this drag, so reopening it restores that size.
    if (next) changeRatio(active.ratio, false); else resizeTo(size, false);
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    drag.current = undefined; setResizing(false);
    // A plain click on the collapsed handle reopens the pane at its previous size.
    if (shut && !active.moved && event.type === 'pointerup') onCollapsedChange!(null);
    saveRatio(storageKey, active.direction, ratiosRef.current[active.direction] ?? fallback);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const size = current.current, step = event.shiftKey ? 50 : 10;
    const backward = actualDirection === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
    const forward = actualDirection === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
    let value: number;
    if (event.key === backward) value = size.first - step;
    else if (event.key === forward) value = size.first + step;
    else if (event.key === 'Home') value = size.minimum;
    else if (event.key === 'End') value = size.maximum;
    else return;
    event.preventDefault();
    if (shut) { if (shut === 'first' ? event.key === forward || event.key === 'End' : event.key === backward || event.key === 'Home') onCollapsedChange!(null); return; }
    resizeTo(value, true);
  };

  const hidden = (pane: Pane) => maximize ? maximize !== pane : shut === pane && keep === 0;
  // A pane collapsed to its title bar opens again when that bar is clicked; the click still reaches its tab or button.
  const expandOnClick = (pane: Pane) => shut === pane && keep > 0 ? () => onCollapsedChange?.(null) : undefined;
  const paneClass = (pane: Pane) => `split-pane split-${pane}${hidden(pane) ? ' is-hidden' : ''}${shut === pane ? ' is-collapsed' : ''}`;
  return <div ref={root} className={`resizable-split split-${actualDirection}${resizing ? ' is-resizing' : ''}${maximize ? ' is-maximized' : ''}${shut ? ` is-collapsed is-collapsed-${shut}` : ''}${className ? ` ${className}` : ''}`} style={style}>
    <div id={`${ids}-first`} className={paneClass('first')} onClick={expandOnClick('first')}>{first}</div>
    <div ref={handle} role="separator" className={`split-handle${maximize ? ' is-hidden' : ''}`} tabIndex={0} aria-label={label} title={shut ? `${label}；单击或拖动展开` : `${label}；拖动或方向键调整，双击恢复默认${collapsible ? '，拖到边缘可收起' : ''}`} aria-orientation={actualDirection === 'horizontal' ? 'vertical' : 'horizontal'} aria-controls={`${ids}-first ${ids}-second`}
      aria-valuenow={shut === 'first' ? 0 : shut === 'second' ? 100 : Math.round(percentage)} aria-valuemin={canCollapse('first') ? 0 : available > 0 ? Math.floor(minimum / available * 100) : 0} aria-valuemax={canCollapse('second') ? 100 : available > 0 ? Math.ceil(maximum / available * 100) : 100} aria-valuetext={shut ? `${shut === 'first' ? '前一' : '后一'}区域已收起` : `${Math.round(percentage)}%`}
      onPointerDown={beginDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag} onKeyDown={onKeyDown} onDoubleClick={() => { if (shut) onCollapsedChange?.(null); changeRatio(defaultRatio, true); }}>
      <span className="split-grip" aria-hidden="true" />
    </div>
    <div id={`${ids}-second`} className={paneClass('second')} onClick={expandOnClick('second')}>{second}</div>
  </div>;
}
