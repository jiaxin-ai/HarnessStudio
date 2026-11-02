/**
 * Reads one small entry of a stored ZIP on disk through its central directory, without loading the archive: an
 * export with videos can be several GB, and only project.json (its warnings) is needed. ZIP64 records are followed,
 * since Studio's zip-stream.ts switches to them for large archives.
 */
import { open, type FileHandle } from 'node:fs/promises';

const EOCD = 0x06054b50, ZIP64_LOCATOR = 0x07064b50, ZIP64_EOCD = 0x06064b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50;
const MAX_SMALL_ENTRY = 64 * 1024 * 1024;

async function read(file: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length), { bytesRead } = await file.read(buffer, 0, length, position);
  if (bytesRead !== length) throw new Error('ZIP 文件不完整');
  return buffer;
}
const u64 = (buffer: Buffer, at: number) => Number(buffer.readBigUInt64LE(at));

/** The content of the first entry whose name passes `wanted`, or undefined when there is none. Throws on a damaged file. */
export async function readZipEntry(path: string, wanted: (name: string) => boolean): Promise<Buffer | undefined> {
  const file = await open(path, 'r');
  try {
    const size = (await file.stat()).size, tailLength = Math.min(size, 22 + 65535 + 20);
    const tail = await read(file, size - tailLength, tailLength);
    let end = -1;
    for (let at = tail.length - 22; at >= 0; at--) if (tail.readUInt32LE(at) === EOCD) { end = at; break; }
    if (end < 0) throw new Error('不是 ZIP 文件，或文件不完整');
    let count = tail.readUInt16LE(end + 10), directorySize = tail.readUInt32LE(end + 12), directoryAt = tail.readUInt32LE(end + 16);
    if (count === 0xffff || directorySize === 0xffffffff || directoryAt === 0xffffffff) {
      if (end < 20 || tail.readUInt32LE(end - 20) !== ZIP64_LOCATOR) throw new Error('ZIP64 记录缺失');
      const record = await read(file, u64(tail, end - 20 + 8), 56);
      if (record.readUInt32LE(0) !== ZIP64_EOCD) throw new Error('ZIP64 记录损坏');
      count = u64(record, 32); directorySize = u64(record, 40); directoryAt = u64(record, 48);
    }
    const directory = await read(file, directoryAt, directorySize);
    for (let at = 0, index = 0; index < count; index++) {
      if (directory.readUInt32LE(at) !== CENTRAL) throw new Error('ZIP 目录损坏');
      const method = directory.readUInt16LE(at + 10), nameLength = directory.readUInt16LE(at + 28), extraLength = directory.readUInt16LE(at + 30), commentLength = directory.readUInt16LE(at + 32);
      let entrySize = directory.readUInt32LE(at + 20), uncompressed = directory.readUInt32LE(at + 24), local = directory.readUInt32LE(at + 42);
      const name = directory.subarray(at + 46, at + 46 + nameLength).toString('utf8');
      if (wanted(name)) {
        // ZIP64 extended information (0x0001) holds, in this order, only the fields marked 0xffffffff above.
        const extra = directory.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength);
        for (let field = 0; field + 4 <= extra.length;) {
          const id = extra.readUInt16LE(field), length = extra.readUInt16LE(field + 2);
          if (id === 0x0001) {
            let value = field + 4;
            if (uncompressed === 0xffffffff) { uncompressed = u64(extra, value); value += 8; }
            if (entrySize === 0xffffffff) { entrySize = u64(extra, value); value += 8; }
            if (local === 0xffffffff) local = u64(extra, value);
          }
          field += 4 + length;
        }
        if (method !== 0) throw new Error('ZIP 条目是压缩的，读不了');
        if (entrySize > MAX_SMALL_ENTRY) throw new Error(`${name} 太大`);
        const header = await read(file, local, 30);
        if (header.readUInt32LE(0) !== LOCAL) throw new Error('ZIP 条目损坏');
        return read(file, local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28), entrySize);
      }
      at += 46 + nameLength + extraLength + commentLength;
    }
    return undefined;
  } finally { await file.close(); }
}

/** project.json sits directly in the export's single root folder (project-export.ts). */
export async function exportWarnings(path: string): Promise<string[]> {
  const data = await readZipEntry(path, name => /^[^/]+\/project\.json$/u.test(name));
  if (!data) throw new Error('导出包里没有 project.json');
  const warnings = (JSON.parse(data.toString('utf8')) as { warnings?: unknown }).warnings;
  return Array.isArray(warnings) ? warnings.filter((row): row is string => typeof row === 'string') : [];
}
