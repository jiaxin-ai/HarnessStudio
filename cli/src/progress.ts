/** One live line per running task in a terminal; elsewhere one line each time something changes (cli/设计.md §7.3). */
import { clockStamp, oneLine, printable, truncate } from './text.ts';

export interface Output { write(text: string): unknown; isTTY?: boolean; columns?: number }
const REDRAW_MS = 1000;

export class Progress {
  private readonly stream: Output;
  private readonly header: () => string;
  private readonly live = new Map<string, string>();
  private readonly changes = new Map<string, string>();
  private readonly timer: NodeJS.Timeout | undefined;
  private drawn = 0;
  constructor(stream: Output, header: () => string = () => '') {
    this.stream = stream; this.header = header;
    if (stream.isTTY) { this.timer = setInterval(() => this.draw(), REDRAW_MS); this.timer.unref(); }
  }
  /** `change` is what counts as a change for non-terminal output; time and token counts alone do not. */
  set(name: string, line: string, change: string): void {
    if (this.stream.isTTY) { this.live.set(name, line); return; }
    if (this.changes.get(name) === change) return;
    this.changes.set(name, change);
    this.stream.write(`[${clockStamp(new Date())}] ${oneLine(`${name}：${change}`)}\n`);
  }
  remove(name: string): void { this.live.delete(name); this.changes.delete(name); }
  /** A permanent line. In a terminal it goes above the live block, which is redrawn below it. */
  log(text: string): void {
    if (!this.stream.isTTY) { this.stream.write(`[${clockStamp(new Date())}] ${text}\n`); return; }
    this.erase(); this.stream.write(`${text}\n`); this.draw(false);
  }
  private erase(): void { if (this.drawn) this.stream.write(`\x1b[${this.drawn}A\r\x1b[J`); this.drawn = 0; }
  private draw(clear = true): void {
    if (clear) this.erase();
    // Cut to the width: a wrapped line would break the count of lines to move back over.
    const width = Math.max(20, (this.stream.columns ?? 80) - 1), header = this.header();
    const lines = [...header ? [header] : [], ...this.live.values()].map(line => truncate(printable(line).trimEnd(), width));
    if (lines.length) this.stream.write(`${lines.join('\n')}\n`);
    this.drawn = lines.length;
  }
  close(): void { clearInterval(this.timer); if (this.stream.isTTY) this.erase(); this.live.clear(); }
}
