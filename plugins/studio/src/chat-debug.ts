import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session';
import type { ChatAuditRecord, ChatAuditBody } from './chat-audit-types.ts';
import type { ChatAttachmentView } from './chat-attachment-types.ts';
import type { ChatSummary } from './chat-types.ts';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { throwIfAborted } from './abort.ts';

export interface ChatDebugSession {
  header: SessionHeader;
  inheritedEventCount: number;
  events: readonly SessionEvent[];
}
export interface ChatDebugUpload extends ChatAttachmentView { originalSha256: string }
export interface ChatDebugCompleteness {
  status: 'complete' | 'partial' | 'unavailable';
  notes: string[];
}
export interface ChatDebugLimits {
  maxJsonBytes: number;
  maxTotalBytes: number;
  maxFileBytes: number;
  maxFiles: number;
  maxDepth: number;
}
export const CHAT_DEBUG_LIMITS: Readonly<ChatDebugLimits> = Object.freeze({
  maxJsonBytes: 136 * 1024 * 1024,
  maxTotalBytes: 96 * 1024 * 1024,
  maxFileBytes: 96 * 1024 * 1024,
  maxFiles: 10000,
  maxDepth: 80,
});

function fail(reason: string): never { throw new Error(`Invalid chat debug export: ${reason}`); }
function positiveLimit(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) fail('invalid limit');
  return value as number;
}
function limits(options: Partial<ChatDebugLimits> = {}): ChatDebugLimits {
  if (Object.keys(options).some(key => !Object.hasOwn(CHAT_DEBUG_LIMITS, key))) fail('unknown limit');
  const value = { ...CHAT_DEBUG_LIMITS, ...options };
  for (const key of Object.keys(value) as (keyof ChatDebugLimits)[]) positiveLimit(value[key], CHAT_DEBUG_LIMITS[key]);
  return value;
}
/** Portable names keep the JSON inventory readable and never expose host paths. */
export function validateChatDebugPath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) fail('invalid path');
  if (value.startsWith('/') || /[\\:]/u.test(value) || value.split('/').some(part => !part || part === '.' || part === '..'
    || /[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) fail('unsafe portable path');
  return value;
}

/** Read one private conversation tree in full; never follow links or silently truncate debug data. */
export async function readChatDebugTree(root: string, options: Partial<ChatDebugLimits> = {}, signal?: AbortSignal): Promise<{ path: string; data: Uint8Array }[]> {
  const cap = limits(options), absolute = resolve(root), info = await lstat(absolute);
  if (!info.isDirectory() || info.isSymbolicLink()) fail('unsafe source directory');
  const canonical = await realpath(absolute), files: { path: string; data: Uint8Array }[] = []; let total = 0, visited = 0;
  const walk = async (directory: string, depth: number): Promise<void> => {
    throwIfAborted(signal); if (depth > cap.maxDepth) fail('directory depth limit');
    if (++visited > cap.maxFiles * 2) fail('directory count limit');
    if (await realpath(directory) !== directory) fail('source directory replaced');
    for (const name of (await readdir(directory)).sort()) {
      throwIfAborted(signal); const path = join(directory, name), stat = await lstat(path);
      if (stat.isSymbolicLink()) fail('source symlink refused');
      if (stat.isDirectory()) { await walk(path, depth + 1); continue; }
      if (!stat.isFile() || stat.nlink !== 1 || files.length >= cap.maxFiles || stat.size > cap.maxFileBytes) fail('unsafe source file or count limit');
      const portable = validateChatDebugPath(relative(canonical, path).split(sep).join('/'));
      const reader = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await reader.stat();
        if (!before.isFile() || before.size !== stat.size || before.ino !== stat.ino || before.dev !== stat.dev) fail('source file changed');
        const buffer = Buffer.alloc(before.size + 1); let offset = 0;
        while (offset < buffer.length) {
          throwIfAborted(signal); const part = await reader.read(buffer, offset, buffer.length - offset, offset);
          if (!part.bytesRead) break; offset += part.bytesRead;
        }
        const data = buffer.subarray(0, offset), after = await reader.stat();
        if (data.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
          || await realpath(directory) !== directory) fail('source file changed during export');
        total += data.length; if (total > cap.maxTotalBytes) fail('source total byte limit');
        files.push({ path: portable, data });
      } finally { await reader.close(); }
    }
  };
  await walk(canonical, 0); throwIfAborted(signal); return files;
}

/** Downloaded debug JSON is directly readable; there is no encoded archive/blob envelope. */
export function debugTransportBody(body: ChatAuditBody): unknown {
  if (body.encoding !== 'base64' || body.raw === undefined) return body;
  const { raw, encoding: _encoding, ...rest } = body;
  return { ...rest, encoding: 'bytes', rawBytes: [...Buffer.from(raw, 'base64')] };
}
export function createChatDebugExport(input: {
  source: ChatSummary; sessions: ChatDebugSession[]; records: ChatAuditRecord[];
  uploads: ChatDebugUpload[]; temporaryFiles: { path: string; data: Uint8Array }[];
  modifiedAt: string; completeness: ChatDebugCompleteness;
}): Uint8Array {
  const value = {
    format: 'harnessstudio-chat-debug', version: 1, exportedAt: new Date().toISOString(), modifiedAt: input.modifiedAt,
    source: input.source, completeness: input.completeness,
    notes: [
      'This is a debug export, not a restorable archive. Requests/responses below are the actually captured provider traffic.',
      'Native image data URLs or other encodings already present in the original provider request are preserved unchanged.',
      'Uploaded binary originals are represented by their metadata; their original model payload remains in captured requests. Credentials in HTTP headers are never captured.',
    ],
    sessions: input.sessions,
    modelCalls: input.records.map(record => ({ ...record, transports: record.transports.map(transport => ({
      ...transport, request: debugTransportBody(transport.request), response: debugTransportBody(transport.response),
    })) })),
    uploadedAttachments: input.uploads,
    temporaryFiles: input.temporaryFiles.map(file => {
      let text: string | undefined;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(file.data); } catch { /* Binary metadata remains readable. */ }
      return { path: file.path, bytes: file.data.byteLength, sha256: createHash('sha256').update(file.data).digest('hex'),
        ...(text === undefined ? { contentUnavailable: 'Binary temporary file: content is not embedded in this JSON debug export.' } : { text }) };
    }),
  };
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  if (bytes.byteLength > CHAT_DEBUG_LIMITS.maxJsonBytes) throw new Error('对话调试 JSON 超过 136 MiB 上限。');
  return bytes;
}
