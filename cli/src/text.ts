/** Everything people read: labels, durations, token counts and column widths. */
import type { RecordStatus } from './types.ts';

export const STATUS_TEXT: Record<RecordStatus, string> = { completed: '完成', 'needs-human': '需要人', failed: '失败', interrupted: '已中断', pending: '未开始', running: '运行中' };

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} 分 ${seconds % 60} 秒` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}
const short = (value: number) => String(Number(value.toFixed(value < 100 ? 1 : 0)));
export function formatTokens(value: number): string {
  if (value < 10_000) return value.toLocaleString('en-US');
  return value < 100_000_000 ? `${short(value / 10_000)} 万` : `${short(value / 100_000_000)} 亿`;
}

const two = (value: number) => String(value).padStart(2, '0');
export const folderStamp = (date: Date) => `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
export const projectStamp = (date: Date) => `${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
export const clockStamp = (date: Date) => `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;

/** Agent-written text reaches the terminal: drop control characters so it cannot move the cursor or restyle the screen. */
export const printable = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, ' ');
/** printable, on one line with single spaces: for names and reasons inside a sentence. */
export const oneLine = (text: string) => printable(text).replace(/\s+/gu, ' ').trim();

const WIDE = /[\u{1100}-\u{115f}\u{2e80}-\u{a4cf}\u{ac00}-\u{d7a3}\u{f900}-\u{faff}\u{fe30}-\u{fe6f}\u{ff00}-\u{ff60}\u{ffe0}-\u{ffe6}\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u;
export const displayWidth = (text: string) => [...text].reduce((sum, char) => sum + (WIDE.test(char) ? 2 : 1), 0);
export function truncate(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  let used = 0, kept = '';
  for (const char of text) {
    const next = used + displayWidth(char);
    if (next > width - 1) break;
    kept += char; used = next;
  }
  return `${kept}…`;
}
export const pad = (text: string, width: number) => text + ' '.repeat(Math.max(0, width - displayWidth(text)));
