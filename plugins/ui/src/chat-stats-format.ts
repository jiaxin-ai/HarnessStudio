/** Counts come from provider accounting, never an estimate of displayed characters. */
export function formatStatTokens(value?: number): string {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) return '—';
  if (value < 1000) return String(value);
  const unit = value >= 1_000_000_000 ? 'B' : value >= 1_000_000 ? 'M' : 'K';
  const divisor = unit === 'B' ? 1_000_000_000 : unit === 'M' ? 1_000_000 : 1000;
  return `${Number((value / divisor).toFixed(2))}${unit}`;
}

/** Preserve an unknown reading and avoid reporting a partial cache hit as 100%. */
export function formatStatPercent(value?: number): string {
  if (value === undefined || !Number.isFinite(value) || value < 0 || value > 100) return '—';
  if (value > 0 && value < 0.1) return '<0.1%';
  const rounded = Math.round(value * 10) / 10;
  if (value < 100 && rounded === 100) return '>99.9%';
  return `${rounded}%`;
}

export const exactStatTokens = (value?: number): string => value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('zh-CN') : '—';
