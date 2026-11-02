import { chmod, lstat, mkdir, open, realpath, readdir, rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { CompletionFileSubmission, SubmittedFile } from './domain-types.ts';
import { removeManagedDirectory } from './managed-delete.ts';

const MAX_BYTES = 100 * 1024 * 1024;
function relativeFile(path: string) {
  if (!path || path.startsWith('/') || /[\\\0]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..') || path.split('/')[0].toLowerCase() === '.chat-tmp') throw new Error('提交区文件路径不合法');
}
async function checkedDirectory(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw new Error('提交区目录已改变，拒绝符号链接');
}
async function syncDirectory(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Task-private immutable commits. A durable SQLite pointer publishes only a fully written commit. */
export class CompletionFileStore {
  readonly root: string;
  constructor(root: string) { this.root = resolve(root); }
  private owner(taskId: string): string {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(taskId)) throw new Error('提交区任务标识不合法');
    return join(this.root, taskId);
  }
  private commitDirectory(taskId: string, id: string): string {
    if (!/^fs-[a-f0-9-]{36}$/.test(id)) throw new Error('提交区版本标识不合法');
    return join(this.owner(taskId), id);
  }
  private validate(submission: CompletionFileSubmission) {
    if (submission.storageVersion !== 1 || !Array.isArray(submission.files) || !submission.files.length || submission.files.length > 1000) throw new Error('提交区清单版本或文件数量不合法');
    let total = 0; const paths = new Set<string>();
    for (const file of submission.files) {
      relativeFile(file.path);
      if (paths.has(file.path) || !/^[a-f0-9]{64}$/.test(file.version) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || typeof file.description !== 'string' || !file.description.trim() || file.description.length > 2000) throw new Error('提交区文件清单不合法');
      paths.add(file.path); total += file.bytes;
      if (total > MAX_BYTES) throw new Error('提交区累计文件超过 100 MiB');
    }
    for (const path of paths) {
      const parts = path.split('/');
      while (parts.length > 1) { parts.pop(); if (paths.has(parts.join('/'))) throw new Error('提交区已有文件与新文件夹路径冲突，请调整文件路径'); }
    }
  }
  /** Stream verified bytes into a new tree, or verify without allocating a copy. */
  private async file(sourceRoot: string, file: SubmittedFile, targetRoot?: string) {
    relativeFile(file.path); const source = join(sourceRoot, file.path);
    if (await realpath(source) !== source) throw new Error('提交区文件路径已改变，拒绝符号链接');
    const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    let output: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const info = await input.stat();
      if (!info.isFile() || info.size !== file.bytes) throw new Error('提交区文件完整性校验失败');
      if (targetRoot) {
        const target = join(targetRoot, file.path); await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        if (await realpath(dirname(target)) !== dirname(target)) throw new Error('提交区目标目录已改变');
        output = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
      }
      const hash = createHash('sha256'), buffer = Buffer.alloc(65536); let length = 0;
      while (true) {
        const part = await input.read(buffer, 0, Math.min(buffer.length, file.bytes - length + 1), null);
        if (!part.bytesRead) break;
        length += part.bytesRead; if (length > file.bytes) throw new Error('提交区文件在复制时发生变化');
        const bytes = buffer.subarray(0, part.bytesRead); hash.update(bytes);
        if (output) { let offset = 0; while (offset < bytes.length) { const written = await output.write(bytes, offset, bytes.length - offset, null); if (!written.bytesWritten) throw new Error('提交区文件复制未完成'); offset += written.bytesWritten; } }
      }
      if (length !== file.bytes || hash.digest('hex') !== file.version) throw new Error('提交区文件完整性校验失败，工作文件可能在提交时发生变化');
      await output?.sync();
    } finally { await output?.close(); await input.close(); }
  }
  private async manifest(taskId: string, submission: CompletionFileSubmission) {
    this.validate(submission); const directory = this.commitDirectory(taskId, submission.id);
    await checkedDirectory(this.root); await checkedDirectory(this.owner(taskId)); await checkedDirectory(directory); await checkedDirectory(join(directory, 'files'));
    const target = join(directory, 'manifest.json'); if (await realpath(target) !== target) throw new Error('提交区清单路径已改变');
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat(); if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error('提交区清单大小不合法');
      const bytes = Buffer.alloc(info.size + 1); let length = 0;
      while (length < bytes.length) { const part = await handle.read(bytes, length, bytes.length - length, null); if (!part.bytesRead) break; length += part.bytesRead; }
      if (length !== info.size || JSON.stringify(JSON.parse(bytes.subarray(0, length).toString('utf8'))) !== JSON.stringify({ taskId, submission })) throw new Error('提交区清单完整性校验失败');
    } finally { await handle.close(); }
    return directory;
  }
  async verify(taskId: string, submission: CompletionFileSubmission) {
    const directory = await this.manifest(taskId, submission);
    for (const file of submission.files) await this.file(join(directory, 'files'), file);
  }
  async copyInto(taskId: string, submission: CompletionFileSubmission, targetFiles: string) {
    const directory = await this.manifest(taskId, submission);
    for (const file of submission.files) await this.file(join(directory, 'files'), file, targetFiles);
  }
  private async freeze(directory: string, freezeRoot = true) {
    await checkedDirectory(directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('提交区拒绝符号链接');
      if (entry.isDirectory()) await this.freeze(path);
      else if (entry.isFile()) await chmod(path, 0o400);
      else throw new Error('提交区文件类型不受支持');
    }
    await syncDirectory(directory); if (freezeRoot) await chmod(directory, 0o500);
  }
  async create(taskId: string, submission: CompletionFileSubmission, workspace: string, selectedPaths: ReadonlySet<string>, previous: CompletionFileSubmission | undefined, validateCurrent: () => Promise<void>) {
    this.validate(submission);
    await mkdir(this.root, { recursive: true, mode: 0o700 }); await checkedDirectory(this.root);
    const owner = this.owner(taskId); await mkdir(owner, { mode: 0o700 }).catch(error => { if (error?.code !== 'EEXIST') throw error; }); await checkedDirectory(owner);
    if (previous) await this.verify(taskId, previous);
    const destination = this.commitDirectory(taskId, submission.id), temporary = `${destination}.tmp`;
    await mkdir(temporary, { mode: 0o700 });
    try {
      await mkdir(join(temporary, 'files'), { mode: 0o700 });
      for (const file of submission.files) {
        const source = selectedPaths.has(file.path) ? workspace : previous ? join(this.commitDirectory(taskId, previous.id), 'files') : undefined;
        if (!source) throw new Error('提交区文件缺少已保存版本');
        await this.file(source, file, join(temporary, 'files'));
      }
      await validateCurrent();
      const handle = await open(join(temporary, 'manifest.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
      try { await handle.writeFile(JSON.stringify({ taskId, submission }), 'utf8'); await handle.sync(); } finally { await handle.close(); }
      // macOS requires the moved root itself to remain writable until rename.
      // Its nested tree is already frozen; freeze the root before publishing.
      await this.freeze(temporary, false); await rename(temporary, destination); await chmod(destination, 0o500); await syncDirectory(owner); await syncDirectory(this.root);
    } catch (error) { await removeManagedDirectory(owner, temporary); await removeManagedDirectory(owner, destination); throw error; }
  }
  async removeCommit(taskId: string, id: string) { await removeManagedDirectory(this.owner(taskId), this.commitDirectory(taskId, id)); }
  async removeTask(taskId: string) { await removeManagedDirectory(this.root, this.owner(taskId)); }
}
