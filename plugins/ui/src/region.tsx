import { useEffect, useRef, useState, type MouseEvent } from 'react';

/** Workbench regions that can fill the main area, like a maximized VS Code panel. */
export type Region = 'graph' | 'details' | 'chat' | 'resources';
/** Folding collapses the whole row a region sits in down to its title bars, like a VS Code view. */
export interface RowFold { folded: boolean; direction: 'up' | 'down'; label: string; toggle(): void }
export interface RegionControl { maximized: boolean; toggle(): void; fold?: RowFold }

/** Title-bar buttons of a region: fold its row (when it can) and maximize it. */
export function RegionButtons({ control, name }: { control: RegionControl; name: string }) {
  const label = control.maximized ? `还原${name}` : `放大${name}`, fold = control.fold;
  // An unfolded top row folds upward; a folded one opens downward (and the reverse for the bottom row).
  const pointsUp = fold && (fold.direction === 'up') !== fold.folded;
  return <>
    {fold && !control.maximized && <button type="button" className="region-maximize region-fold" aria-pressed={fold.folded} aria-label={fold.folded ? `展开${fold.label}` : `收起${fold.label}`} title={fold.folded ? `展开${fold.label}` : `收起${fold.label}（拖动分隔线也可以）`} onClick={event => { event.stopPropagation(); fold.toggle(); }}>
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d={pointsUp ? 'm4 10 4-4 4 4' : 'm4 6 4 4 4-4'} /></svg>
    </button>}
    <button type="button" className="region-maximize" aria-pressed={control.maximized} aria-label={label} title={`${label}（双击标题栏也可切换）`} onClick={control.toggle}>
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">{control.maximized ? <path d="M6 2v4H2m8-4v4h4M6 14v-4H2m8 4v-4h4" /> : <path d="M2 6V2h4m4 0h4v4M2 10v4h4m4 0h4v-4" />}</svg>
    </button>
  </>;
}

/** Double-clicking empty title-bar space toggles the region; controls inside the bar keep their own meaning. */
export function onTitleBarDoubleClick(control: RegionControl | undefined) {
  return (event: MouseEvent<HTMLElement>) => {
    if (!control || (event.target as HTMLElement).closest('button, a, input, select, textarea, [role="tab"]')) return;
    control.toggle();
  };
}

/** Clipboard API exists only in secure contexts; Studio is also opened over plain HTTP on the LAN. */
export async function copyText(text: string): Promise<boolean> {
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; } } catch { /* Fall back to a selection copy. */ }
  const field = document.createElement('textarea');
  field.value = text; field.setAttribute('readonly', ''); field.style.position = 'fixed'; field.style.opacity = '0';
  document.body.append(field); field.select();
  try { return document.execCommand('copy'); } catch { return false; } finally { field.remove(); }
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle'), timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  return <button type="button" className={`copy-button is-${state}`} aria-label={`复制${label}`} title={`复制${label}`} onClick={() => { void copyText(text).then(ok => { setState(ok ? 'copied' : 'failed'); clearTimeout(timer.current); timer.current = setTimeout(() => setState('idle'), 1500); }); }}>
    {state === 'copied' ? '已复制' : state === 'failed' ? '复制失败' : '复制'}
  </button>;
}

/** A labelled identifier that can be selected or copied. */
export function IdChip({ label, value }: { label: string; value: string }) {
  return <span className="id-chip"><span className="id-chip-label">{label}</span><code>{value}</code><CopyButton text={value} label={label} /></span>;
}
