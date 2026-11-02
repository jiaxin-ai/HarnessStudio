/** Output folder: safe task folder names, atomic JSON writes, summary.json / summary.csv and the final table. */
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RecordStatus, TaskRecord } from './types.ts';
import { STATUS_TEXT, displayWidth, formatDuration, formatTokens, pad, truncate } from './text.ts';

/** Names the batch itself writes at the top of the folder; a task folder may not take them. */
const RESERVED = new Set(['summary.json', 'summary.csv', 'batch-state.json', 'attempts']);
/** Windows device names: the folder may be copied to a Windows machine (or the VM's shared drive) later. */
const DEVICES = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/iu;
const MAX_FOLDER_BYTES = 120;

/** A folder name that works on Linux, macOS and Windows; `taken` holds names already used (any case). */
export function folderName(name: string, taken: ReadonlySet<string>): string {
  let base = name.normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/gu, '_').replace(/\s+/gu, ' ').replace(/^[\s.]+|[\s.]+$/gu, '');
  while (Buffer.byteLength(base) > MAX_FOLDER_BYTES) base = [...base].slice(0, -1).join('');
  base = base.replace(/[\s.]+$/u, '');
  if (!base) base = 'task';
  if (DEVICES.test(base)) base = `_${base}`;
  const used = new Set([...taken].map(item => item.toLowerCase()));
  let candidate = base;
  for (let index = 2; used.has(candidate.toLowerCase()) || RESERVED.has(candidate.toLowerCase()); index++) candidate = `${base}-${index}`;
  return candidate;
}

let sequence = 0;
/** Write through a temporary file and rename, so a crash leaves the old content or the new one, never half of it. */
export async function writeJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${++sequence}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

export interface SummaryRow { name: string; folder: string; status: RecordStatus; reason: string; elapsedMs?: number; weightedTokens?: number; projectUrl?: string; projectId?: string; runId?: string; earlier?: boolean }
export const summaryRows = (records: readonly TaskRecord[], earlier: ReadonlySet<string> = new Set()): SummaryRow[] => records.map(record => ({
  name: record.name, folder: record.folder, status: record.status, reason: record.reason ?? '',
  ...record.elapsedMs === undefined ? {} : { elapsedMs: record.elapsedMs }, ...record.weightedTokens === undefined ? {} : { weightedTokens: record.weightedTokens },
  ...record.projectUrl ? { projectUrl: record.projectUrl } : {}, ...record.projectId ? { projectId: record.projectId } : {}, ...record.runId ? { runId: record.runId } : {},
  ...earlier.has(record.name) ? { earlier: true } : {},
}));

export function counts(rows: readonly { status: RecordStatus }[]): Record<RecordStatus, number> {
  const result = { completed: 0, 'needs-human': 0, failed: 0, interrupted: 0, pending: 0, running: 0 };
  for (const row of rows) result[row.status]++;
  return result;
}

const csvCell = (value: string | number | undefined) => { const text = value === undefined ? '' : String(value); return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text; };
/** UTF-8 with a BOM: spreadsheet programs then read the Chinese text correctly. */
export function summaryCsv(rows: readonly SummaryRow[]): string {
  const header = ['任务', '结果', '原因', '用时（秒）', '折算 token', '网页链接', '输出文件夹'];
  const lines = rows.map(row => [row.name, STATUS_TEXT[row.status], row.reason, row.elapsedMs === undefined ? undefined : Math.round(row.elapsedMs / 1000), row.weightedTokens, row.projectUrl, row.folder].map(csvCell).join(','));
  return `\uFEFF${[header.join(','), ...lines].join('\r\n')}\r\n`;
}

export async function writeSummary(directory: string, summary: { startedAt: string; endedAt: string; studioUrl: string; manifest: string; interrupted: boolean; rows: SummaryRow[] }): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeJson(join(directory, 'summary.json'), { ...summary, counts: counts(summary.rows), tasks: summary.rows });
  await writeFile(join(directory, 'summary.csv'), summaryCsv(summary.rows));
}

/** The table printed at the end: task, result, time, weighted tokens, link. Wide names are cut so the link stays whole. */
export function summaryTable(rows: readonly SummaryRow[]): string {
  const cells = rows.map(row => [truncate(row.name, 30), `${STATUS_TEXT[row.status]}${row.earlier ? '（上次）' : ''}`, row.elapsedMs === undefined ? '-' : formatDuration(row.elapsedMs), row.weightedTokens === undefined ? '-' : formatTokens(row.weightedTokens), row.projectUrl ?? '-']);
  const header = ['任务', '结果', '用时', '折算 token', '网页链接'];
  const widths = header.map((title, column) => Math.max(displayWidth(title), ...cells.map(row => displayWidth(row[column]!))));
  const line = (row: string[]) => row.map((cell, column) => column === row.length - 1 ? cell : pad(cell, widths[column]!)).join('  ').trimEnd();
  const reasons = rows.filter(row => row.reason && row.status !== 'completed').map(row => `  ${truncate(row.name, 30)}：${row.reason}`);
  return [line(header), line(widths.map(width => '-'.repeat(width))), ...cells.map(line), ...reasons.length ? ['', '原因：', ...reasons] : []].join('\n');
}
