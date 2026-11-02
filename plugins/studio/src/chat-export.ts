/** The project export's copy of one conversation: chat.json with the native session and every captured model call in
 * full, and the conversation's temporary files as files of their own (cli/设计.md §8).
 *
 * The chat download (chat-transfer.ts) builds one JSON in memory and keeps it under 136 MiB by dropping the bodies of
 * older calls; a long Agent run resends its whole context on every call and passes that quickly. Here the snapshot
 * (session events, the audit index, the list of temporary files) is taken inside the runtime's mutation queue, and the
 * calls are read and written one at a time outside it while the archive is consumed: memory stays at about one call,
 * and other conversations are not held up by a slow download. A running conversation is exported as saved so far, and
 * one a task clear made stale (no longer usable) is still exported: both are part of the project's trajectory. */
import type { Context } from '@deepseek-ai/cordis';
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import type {} from './index.ts';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatAuditStore } from './chat-audit.ts';
import type { ChatAuditSummary } from './chat-audit-types.ts';
import type { ChatSummary } from './chat-types.ts';
import { debugTransportBody, type ChatDebugSession, type ChatDebugUpload } from './chat-debug.ts';
import { callIssues, missingCalls, reportSentences, reportStatus, type ChatAuditReport } from './chat-audit-report.ts';
import { throwIfAborted } from './abort.ts';

export interface ChatExportSource extends ChatSummary { stale?: boolean }
export interface ChatExportFile { path: string; absolute: string; bytes: number; modified: Date }
export interface ChatExport {
  source: ChatExportSource;
  /** Native session events, for the project timeline. */
  events: readonly SessionEvent[];
  modifiedAt: string;
  /** Regular files of the conversation's temporary folder; written beside chat.json under temporary-files/. */
  temporaryFiles: ChatExportFile[];
  /** chat.json, produced while it is read. */
  json(signal?: AbortSignal): AsyncGenerator<Uint8Array>;
  /** Complete once json() has been read to its end (the bytes of each call are checked as they are read). */
  report: ChatAuditReport;
}

const encode = (text: string) => Buffer.from(text);
const EVENTS_PER_CHUNK = 200;
const auditStore = (ctx: Context): ChatAuditStore | undefined => ctx.get?.('studioAudit');

/** Regular files below a directory, without following links. Links and other special files are named in `skipped`. */
async function files(root: string, signal?: AbortSignal, prefix = '', found: ChatExportFile[] = [], skipped: string[] = []): Promise<{ found: ChatExportFile[]; skipped: string[] }> {
  let names: string[];
  try { names = (await readdir(join(root, prefix))).sort(); } catch { return { found, skipped }; }
  for (const name of names) {
    throwIfAborted(signal);
    const path = prefix ? `${prefix}/${name}` : name, absolute = join(root, path), info = await lstat(absolute);
    if (info.isDirectory()) await files(root, signal, path, found, skipped);
    // A hard link may point outside the conversation's own folder; the chat download refuses it for the same reason.
    else if (info.isFile() && info.nlink === 1) found.push({ path, absolute, bytes: info.size, modified: info.mtime });
    else skipped.push(path);
  }
  return { found, skipped };
}

async function uploads(root: string, source: ChatExportSource): Promise<ChatDebugUpload[]> {
  let text: string;
  try { text = await readFile(join(root, 'chat-attachments', source.id, 'manifest.json'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const value = JSON.parse(text);
  if (value.version !== 1 || value.owner?.id !== source.id || value.owner?.projectId !== source.projectId || value.owner?.scope !== source.scope || value.owner?.taskId !== source.taskId) throw new Error('附件归属不匹配');
  return value.uploads;
}

function modifiedAt(events: readonly SessionEvent[], createdAt: number, records: readonly ChatAuditSummary[]): string {
  let latest = createdAt;
  for (const event of events) latest = Math.max(latest, event.time);
  for (const row of records) for (const value of [row.startedAt, row.endedAt]) if (value && Number.isFinite(Date.parse(value))) latest = Math.max(latest, Date.parse(value));
  return new Date(latest).toISOString();
}

/** The snapshot of one conversation; the caller holds the runtime's mutation queue while this runs. `scratch` is its
 * existing temporary folder, if any. */
export async function readChatExport(ctx: Context, root: string, source: ChatExportSource, scratch: string | undefined, exportedAt: Date, signal?: AbortSignal): Promise<ChatExport> {
  throwIfAborted(signal);
  const store = auditStore(ctx);
  await ctx.sessionPersistence.flush(); await store?.flush(source.id);
  const reader = await ctx.sessionPersistence.open(SessionId(source.id), 'read');
  let session: ChatDebugSession;
  try { session = { header: reader.header, inheritedEventCount: Number(reader.inheritedEventCount), events: (await reader.read()).events }; } finally { await reader.close(); }
  const records = (await store?.index(source.id))?.records ?? [];
  const temporary = scratch ? await files(scratch, signal) : { found: [], skipped: [] };
  const attached = await uploads(root, source);
  const report: ChatAuditReport = { status: 'complete', calls: records.length, complete: 0, notSent: 0, incomplete: [], missing: missingCalls(session.events, session.inheritedEventCount, records), notes: [] };
  const notes = [
    'Model calls below are the captured provider traffic, every call in full: request and response bytes as sent and received (raw), parsed when they are JSON (body) or an event stream (events). request.body of a call is the Harness\'s provider-neutral input, not the wire body.',
    'Credentials in HTTP headers are never captured. Uploaded binary originals are listed by their metadata; their payload is in the captured requests.',
    'temporaryFiles are the conversation\'s private temporary files; each is exported beside this file under temporary-files/.',
    ...source.status === 'running' ? ['The conversation was running when it was exported: this is what was saved up to then.'] : [],
    ...source.stale ? ['A task clear made this conversation stale; it can no longer be continued.'] : [],
    ...temporary.skipped.length ? [`Not exported (links or special files): ${temporary.skipped.slice(0, 20).join(', ')}${temporary.skipped.length > 20 ? ' …' : ''}`] : [],
  ];
  const changed = modifiedAt(session.events, session.header.createdAt, records);
  async function* json(stop = signal): AsyncGenerator<Uint8Array> {
    const head = { format: 'harnessstudio-chat-debug', version: 1, variant: 'project-export', exportedAt: exportedAt.toISOString(), modifiedAt: changed, source, notes };
    yield encode(`{\n${Object.entries(head).map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(',\n')},\n`);
    yield encode(`  "sessions": [{\n    "header": ${JSON.stringify(session.header)},\n    "inheritedEventCount": ${session.inheritedEventCount},\n    "events": [\n`);
    for (let at = 0; at < session.events.length; at += EVENTS_PER_CHUNK) {
      if (stop?.aborted) return;
      const last = at + EVENTS_PER_CHUNK >= session.events.length;
      yield encode(session.events.slice(at, at + EVENTS_PER_CHUNK).map(event => `      ${JSON.stringify(event)}`).join(',\n') + (last ? '\n' : ',\n'));
    }
    yield encode('    ]\n  }],\n  "modelCalls": [\n');
    for (const [index, summary] of records.entries()) {
      if (stop?.aborted) return;
      let value: unknown, issues: ReturnType<typeof callIssues>;
      try {
        if (!store) throw new Error('对话审计插件没有加载');
        const record = await store.read(source.id, summary.recordId);
        issues = callIssues(record);
        value = { ...record, transports: record.transports.map(transport => ({ ...transport, request: debugTransportBody(transport.request), response: debugTransportBody(transport.response) })) };
      } catch (error) {
        // Deleted or damaged while the export ran: the call's metadata stays, and the reason is reported.
        const found = callIssues(summary);
        issues = [...found === 'not-sent' ? [] : found, { part: 'call', reason: 'export-read-failed' }];
        value = { ...summary, exportError: error instanceof Error ? error.message : String(error) };
      }
      if (issues === 'not-sent') report.notSent++;
      else if (issues.length) report.incomplete.push({ recordId: summary.recordId, purpose: summary.purpose, turn: summary.turn, step: summary.step, attempt: summary.attempt, ...(summary.toolCallId ? { toolCallId: summary.toolCallId } : {}), startedAt: summary.startedAt, status: summary.status, issues });
      else report.complete++;
      yield encode(`    ${JSON.stringify(value)}${index < records.length - 1 ? ',' : ''}\n`);
    }
    report.status = reportStatus(report);
    report.notes = reportSentences('这个对话', report);
    yield encode(`  ],\n  "uploadedAttachments": ${JSON.stringify(attached)},\n  "temporaryFiles": ${JSON.stringify(temporary.found.map(file => ({ path: file.path, bytes: file.bytes, file: `temporary-files/${file.path}` })))},\n`);
    yield encode(`  "completeness": ${JSON.stringify(report, null, 2).replace(/\n/g, '\n  ')}\n}\n`);
  }
  return { source, events: session.events, modifiedAt: changed, temporaryFiles: temporary.found, json, report };
}
