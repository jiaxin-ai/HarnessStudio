import { createRequire } from 'node:module';
import type { Readable } from 'node:stream';
import { crc32 } from 'node:zlib';

export interface ZipLimits {
  maxArchiveBytes: number;
  maxEntries: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxCompressionRatio: number;
  maxPathLength: number;
  maxDepth: number;
}

export interface ExtractedZipDirectory { type: 'directory'; path: string }
export interface ExtractedZipFile { type: 'file'; path: string; data: Uint8Array }
export type ExtractedZipEntry = ExtractedZipDirectory | ExtractedZipFile;
export interface ExtractedZip {
  entries: ExtractedZipEntry[];
  fileCount: number;
  directoryCount: number;
  totalBytes: number;
}

export const ZIP_LIMITS: Readonly<ZipLimits> = Object.freeze({
  maxArchiveBytes: 20 * 1024 * 1024,
  maxEntries: 1000,
  maxFileBytes: 96 * 1024 * 1024,
  maxTotalBytes: 96 * 1024 * 1024,
  maxCompressionRatio: 200,
  // Reserve `extracted/<uuid>/` so every successfully published path also
  // remains representable by the complete-chat JSON debug export.
  maxPathLength: 4049,
  maxDepth: 78,
});

export class ZipExtractionError extends Error {
  constructor(public readonly code: 'CHAT_ZIP_INVALID' | 'CHAT_ZIP_LIMIT' | 'CHAT_ZIP_CRC' | 'CHAT_ZIP_ABORTED', message: string, options?: ErrorOptions) {
    super(message, options); this.name = 'ZipExtractionError';
  }
}

interface YauzlEntry {
  versionMadeBy: number;
  generalPurposeBitFlag: number;
  compressionMethod: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  externalFileAttributes: number;
  relativeOffsetOfLocalHeader: number;
  fileName: string;
  fileNameRaw: Buffer;
  extraFields: { id: number; data: Buffer }[];
  isEncrypted(): boolean;
  canDecodeFileData(): boolean;
}
interface YauzlFile {
  eachEntry(): AsyncIterable<YauzlEntry>;
  openReadStreamPromise(entry: YauzlEntry): Promise<Readable>;
  close(): void;
}
interface YauzlModule {
  fromBufferPromise(bytes: Buffer, options: Record<string, unknown>): Promise<YauzlFile>;
}

interface CheckedEntry { raw: YauzlEntry; path: string; key: string; type: 'directory' | 'file' }

const require = createRequire(import.meta.url);
const yauzl = require('yauzl') as YauzlModule;
const fatalUtf8 = new TextDecoder('utf-8', { fatal: true });

function abort(): never { throw new ZipExtractionError('CHAT_ZIP_ABORTED', 'ZIP extraction was cancelled.'); }
function invalid(reason: string, cause?: unknown): never {
  throw new ZipExtractionError('CHAT_ZIP_INVALID', `Invalid or unsafe ZIP archive: ${reason}.`, cause === undefined ? undefined : { cause });
}
function limited(reason: string): never { throw new ZipExtractionError('CHAT_ZIP_LIMIT', `ZIP safety limit exceeded: ${reason}.`); }
function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) abort(); }

function resolveLimits(options: Partial<ZipLimits>): ZipLimits {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) invalid('invalid limits');
  for (const key of Object.keys(options)) if (!Object.hasOwn(ZIP_LIMITS, key)) invalid('unknown limit');
  const value = { ...ZIP_LIMITS, ...options };
  for (const key of Object.keys(ZIP_LIMITS) as (keyof ZipLimits)[]) {
    const candidate = value[key];
    if (!Number.isFinite(candidate) || candidate <= 0 || candidate > ZIP_LIMITS[key]
      || (key !== 'maxCompressionRatio' && !Number.isSafeInteger(candidate))) invalid(`invalid ${key}`);
  }
  return value;
}

function safeZip64Number(bytes: Buffer, offset: number, label: string): number {
  if (offset < 0 || offset + 8 > bytes.length) invalid(`truncated ZIP64 ${label}`);
  const value = bytes.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) invalid(`oversized ZIP64 ${label}`);
  return Number(value);
}

function zip64EntryDisk(bytes: Buffer, extraStart: number, extraLength: number, header: number): number {
  let cursor = extraStart, end = extraStart + extraLength;
  while (cursor + 4 <= end) {
    const id = bytes.readUInt16LE(cursor), size = bytes.readUInt16LE(cursor + 2), data = cursor + 4;
    if (data + size > end) invalid('truncated central-directory extra field');
    if (id === 0x0001) {
      let position = data;
      if (bytes.readUInt32LE(header + 24) === 0xffffffff) position += 8;
      if (bytes.readUInt32LE(header + 20) === 0xffffffff) position += 8;
      if (bytes.readUInt32LE(header + 42) === 0xffffffff) position += 8;
      if (position + 4 > data + size) invalid('ZIP64 entry omits its starting disk');
      return bytes.readUInt32LE(position);
    }
    cursor = data + size;
  }
  invalid('ZIP64 entry has no extended information');
}

/** Locate the complete EOCD and inspect every central header before trusting a single-volume archive. */
function assertSingleDisk(bytes: Buffer, cap: ZipLimits): void {
  const minimum = 22, first = Math.max(0, bytes.length - minimum - 0xffff); let offset = -1;
  for (let cursor = bytes.length - minimum; cursor >= first; cursor--) {
    if (bytes.readUInt32LE(cursor) === 0x06054b50 && cursor + minimum + bytes.readUInt16LE(cursor + 20) === bytes.length) { offset = cursor; break; }
  }
  if (offset < 0) invalid('end of central directory is missing');
  const disk = bytes.readUInt16LE(offset + 4), centralDisk = bytes.readUInt16LE(offset + 6);
  const diskEntries = bytes.readUInt16LE(offset + 8); let entries = bytes.readUInt16LE(offset + 10);
  let centralSize = bytes.readUInt32LE(offset + 12), centralOffset = bytes.readUInt32LE(offset + 16);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entries) invalid('multi-volume ZIP archives are not supported');
  if (offset >= 20 && bytes.readUInt32LE(offset - 20) === 0x07064b50) {
    const locator = offset - 20;
    if (bytes.readUInt32LE(locator + 4) !== 0 || bytes.readUInt32LE(locator + 16) !== 1) invalid('multi-volume ZIP64 archives are not supported');
    const record = safeZip64Number(bytes, locator + 8, 'record offset');
    if (record + 56 > locator || bytes.readUInt32LE(record) !== 0x06064b50) invalid('ZIP64 end record is missing');
    if (bytes.readUInt32LE(record + 16) !== 0 || bytes.readUInt32LE(record + 20) !== 0
      || safeZip64Number(bytes, record + 24, 'disk entry count') !== safeZip64Number(bytes, record + 32, 'entry count')) {
      invalid('multi-volume ZIP64 archives are not supported');
    }
    entries = safeZip64Number(bytes, record + 32, 'entry count');
    centralSize = safeZip64Number(bytes, record + 40, 'central-directory size');
    centralOffset = safeZip64Number(bytes, record + 48, 'central-directory offset');
  } else if (entries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) invalid('ZIP64 locator is missing');
  if (entries > cap.maxEntries) limited('entry count');
  const centralEnd = centralOffset + centralSize;
  if (!Number.isSafeInteger(centralEnd) || centralOffset < 0 || centralEnd > offset) invalid('central directory is out of bounds');
  let cursor = centralOffset;
  for (let index = 0; index < entries; index++) {
    if (cursor + 46 > centralEnd || bytes.readUInt32LE(cursor) !== 0x02014b50) invalid('truncated central directory');
    const nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32);
    const diskStart = bytes.readUInt16LE(cursor + 34), next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > centralEnd) invalid('central-directory entry is out of bounds');
    const actualDisk = diskStart === 0xffff ? zip64EntryDisk(bytes, cursor + 46 + nameLength, extraLength, cursor) : diskStart;
    if (actualDisk !== 0) invalid('multi-volume entry is not supported');
    cursor = next;
  }
}

function validateUtf8(entry: YauzlEntry): void {
  try {
    if ((entry.generalPurposeBitFlag & 0x800) !== 0) fatalUtf8.decode(entry.fileNameRaw);
    for (const field of entry.extraFields) if (field.id === 0x7075 && field.data.length >= 6 && field.data[0] === 1) fatalUtf8.decode(field.data.subarray(5));
  } catch (error) { invalid('an entry name is not decodable UTF-8', error); }
  if (entry.fileName.includes('\ufffd')) invalid('an entry name contains a decoding replacement character');
}

function checkedPath(fileName: string, directory: boolean, cap: ZipLimits): { path: string; key: string } {
  if (!fileName || /[\\\u0000\p{Cc}]/u.test(fileName) || fileName.startsWith('/') || /^[A-Za-z]:/u.test(fileName)) invalid('unsafe entry path');
  const raw = directory && fileName.endsWith('/') ? fileName.slice(0, -1) : fileName;
  if (!raw || raw.endsWith('/')) invalid('unsafe entry path');
  if (raw.length > cap.maxPathLength) limited('entry path length');
  const parts = raw.split('/');
  if (parts.length > cap.maxDepth) limited('entry path depth');
  if (parts.some(part => !part || part === '.' || part === '..' || part.includes(':') || /[. ]$/u.test(part)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) invalid('unsafe or non-portable entry path segment');
  if (parts.some(part => Buffer.byteLength(part) > 255)) limited('entry path component byte length');
  const path = raw.normalize('NFC');
  if (!path || path.split('/').some(part => !part || part === '.' || part === '..' || part.includes(':') || /[. ]$/u.test(part)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) invalid('unsafe normalized entry path');
  if (path.split('/').some(part => Buffer.byteLength(part) > 255)) limited('normalized entry path component byte length');
  if (path.length > cap.maxPathLength) limited('normalized entry path length');
  return { path, key: path.toLowerCase() };
}

function checkedType(entry: YauzlEntry): 'directory' | 'file' {
  const host = entry.versionMadeBy >>> 8, unixMode = entry.externalFileAttributes >>> 16;
  const kind = host === 3 || host === 19 ? unixMode & 0o170000 : 0;
  if (kind === 0o120000 || kind === 0o010000 || kind === 0o020000 || kind === 0o060000 || kind === 0o140000) {
    invalid('links, devices, FIFOs, and sockets are not extractable');
  }
  if (kind !== 0 && kind !== 0o040000 && kind !== 0o100000) invalid('unsupported entry type');
  const nameDirectory = entry.fileName.endsWith('/');
  const metadataDirectory = kind === 0o040000 || (entry.externalFileAttributes & 0x10) !== 0;
  if (nameDirectory !== metadataDirectory && (kind !== 0 || metadataDirectory)) invalid('directory metadata conflicts with its path');
  if (nameDirectory && (entry.compressedSize !== 0 || entry.uncompressedSize !== 0)) invalid('directory entry contains file data');
  return nameDirectory ? 'directory' : 'file';
}

function preflightEntry(entry: YauzlEntry, cap: ZipLimits): CheckedEntry {
  validateUtf8(entry);
  if (!Number.isSafeInteger(entry.compressedSize) || !Number.isSafeInteger(entry.uncompressedSize)
    || entry.compressedSize < 0 || entry.uncompressedSize < 0) invalid('invalid entry size');
  if (entry.isEncrypted() || (entry.generalPurposeBitFlag & 0x40) !== 0) invalid('encrypted entries are not supported');
  if ((entry.compressionMethod !== 0 && entry.compressionMethod !== 8) || !entry.canDecodeFileData()) invalid('unsupported entry compression');
  const type = checkedType(entry), safe = checkedPath(entry.fileName, type === 'directory', cap);
  if (type === 'file') {
    if (entry.uncompressedSize > cap.maxFileBytes) limited('single file size');
    if (entry.uncompressedSize > 0 && (entry.compressedSize === 0 || entry.uncompressedSize / entry.compressedSize > cap.maxCompressionRatio)) limited('compression ratio');
  }
  return { raw: entry, ...safe, type };
}

function validateTree(entries: CheckedEntry[]): void {
  const explicit = new Map<string, CheckedEntry>();
  for (const entry of entries) {
    if (explicit.has(entry.key)) invalid('duplicate entry path after NFC and case folding');
    explicit.set(entry.key, entry);
  }
  for (const entry of entries) {
    const parts = entry.key.split('/');
    for (let depth = 1; depth < parts.length; depth++) {
      if (explicit.get(parts.slice(0, depth).join('/'))?.type === 'file') invalid('file and directory paths conflict');
    }
  }
}

async function readFile(zip: YauzlFile, entry: CheckedEntry, cap: ZipLimits, alreadyRead: number, signal?: AbortSignal): Promise<Uint8Array> {
  checkAbort(signal);
  let stream: Readable;
  try { stream = await zip.openReadStreamPromise(entry.raw); } catch (error) { checkAbort(signal); invalid(`cannot open ${entry.path}`, error); }
  const output = new Uint8Array(entry.raw.uncompressedSize); let offset = 0, checksum = 0;
  const onAbort = () => stream.destroy(new ZipExtractionError('CHAT_ZIP_ABORTED', 'ZIP extraction was cancelled.'));
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for await (const value of stream) {
      checkAbort(signal); const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
      offset += chunk.byteLength;
      if (offset > cap.maxFileBytes || alreadyRead + offset > cap.maxTotalBytes || offset > output.byteLength) limited('actual expanded byte size');
      output.set(chunk, offset - chunk.byteLength); checksum = crc32(chunk, checksum);
    }
  } catch (error) {
    checkAbort(signal); if (error instanceof ZipExtractionError) throw error;
    invalid(`cannot decode ${entry.path}`, error);
  } finally { signal?.removeEventListener('abort', onAbort); }
  checkAbort(signal);
  if (offset !== entry.raw.uncompressedSize) invalid(`expanded size mismatch for ${entry.path}`);
  if ((checksum >>> 0) !== (entry.raw.crc32 >>> 0)) throw new ZipExtractionError('CHAT_ZIP_CRC', `ZIP CRC check failed for ${entry.path}.`);
  return output;
}

/**
 * Safely decode an in-memory ZIP. All central-directory metadata is validated before
 * the first entry stream is opened; callers decide separately where entries are stored.
 */
export async function extractZip(bytes: Uint8Array, signal?: AbortSignal, options: Partial<ZipLimits> = {}): Promise<ExtractedZip> {
  checkAbort(signal); const cap = resolveLimits(options);
  if (!(bytes instanceof Uint8Array)) invalid('archive is not a byte array');
  if (bytes.byteLength > cap.maxArchiveBytes) limited('archive byte size');
  const archive = Buffer.from(bytes); assertSingleDisk(archive, cap); checkAbort(signal);
  let zip: YauzlFile | undefined;
  try {
    zip = await yauzl.fromBufferPromise(archive, { autoClose: false, decodeStrings: true, validateEntrySizes: true, strictFileNames: true });
    const entries: CheckedEntry[] = []; let predictedTotal = 0, predictedCompressed = 0;
    for await (const raw of zip.eachEntry()) {
      checkAbort(signal); if (entries.length >= cap.maxEntries) limited('entry count');
      const entry = preflightEntry(raw, cap); entries.push(entry);
      if (entry.type === 'file') {
        predictedTotal += raw.uncompressedSize; predictedCompressed += raw.compressedSize;
        if (!Number.isSafeInteger(predictedTotal) || predictedTotal > cap.maxTotalBytes) limited('total expanded byte size');
      }
    }
    if (predictedTotal > 0 && (predictedCompressed === 0 || predictedTotal / predictedCompressed > cap.maxCompressionRatio)) limited('aggregate compression ratio');
    validateTree(entries); checkAbort(signal);
    const output: ExtractedZipEntry[] = []; let totalBytes = 0, fileCount = 0, directoryCount = 0;
    for (const entry of entries) {
      checkAbort(signal);
      if (entry.type === 'directory') { output.push({ type: 'directory', path: entry.path }); directoryCount++; continue; }
      const data = await readFile(zip, entry, cap, totalBytes, signal); totalBytes += data.byteLength; fileCount++;
      output.push({ type: 'file', path: entry.path, data });
    }
    return { entries: output, fileCount, directoryCount, totalBytes };
  } catch (error) {
    if (error instanceof ZipExtractionError) throw error;
    checkAbort(signal); return invalid('ZIP parser rejected the archive', error);
  } finally { zip?.close(); }
}
