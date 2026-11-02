import { mkdir, lstat, realpath, open, readdir, opendir, unlink, link, rename, type FileHandle } from 'node:fs/promises';
import { constants, type Stats } from 'node:fs';
import { resolve, join, isAbsolute, relative, sep, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { WorkspaceDirectoryListing, WorkspaceDirectoryEntry, WorkspaceFilePreview } from './domain-types.ts';
import { removeManagedDirectory } from './managed-delete.ts';
import { throwIfAborted } from './abort.ts';

/** A task-scoped file capability; reset revokes every previously issued lease. */
export interface WorkspaceLease { readonly taskId: string; readonly generation: number }
export interface FileValue { content: string; version: string }
export interface FileWriteOptions { expectedVersion?: string; createOnly?: boolean }
export interface FileDeleteOptions { expectedVersion?: string }
export interface FileDeleteResult { path: string }
export interface ScratchFileValue extends FileValue { path: string; bytes: number }
export interface ScratchFileInfo { path: string; bytes: number; modifiedAt: string }
export interface ScratchFileList { files: ScratchFileInfo[]; truncated: boolean; nextOffset?: number }
export interface ScratchBinaryValue { path: string; bytes: number; version: string; data: Uint8Array }
export interface ScratchTextPageValue extends Omit<ScratchFileValue, 'content'> {
  content: string; totalChars: number; offset: number; nextOffset?: number;
}
export interface ScratchTextMatch { line: number; column: number; text: string }
export interface ScratchTextSearchValue { path: string; query: string; matches: ScratchTextMatch[]; truncated: boolean }
export interface ScratchTreeEntry { path: string; kind: 'file' | 'directory'; data?: Uint8Array }
export interface ScratchTreeValue { path: string; files: number; directories: number; bytes: number }
/** Ordinary files of a workspace may live in an external store (vm_manager task spaces). Chat scratch never does. */
export interface ExternalWorkspaceStorage {
  /** Absolute directory for ordinary files, or undefined to keep the managed root layout. */
  locate(id: string): string | undefined;
  /** Create or register the external directory before first use. */
  prepare(id: string): Promise<void>;
  /** Remove the external directory with its files when the task is cleared or deleted. Without it the store keeps them
   * (vm_manager keeps its task spaces); with it the files belong to Studio, as in the managed layout. */
  remove?(id: string): Promise<void>;
}
export const CHAT_SCRATCH_ROOT = '.chat-tmp';
export const CHAT_SCRATCH_MAX_BYTES = 1024 * 1024;
/** Downloaded archives and extracted engineering text remain bounded but may be much larger than model-written notes. */
export const CHAT_SCRATCH_ARTIFACT_MAX_BYTES = 96 * 1024 * 1024;
export const CHAT_SCRATCH_TREE_MAX_BYTES = 102 * 1024 * 1024;
export const CHAT_SCRATCH_TOTAL_MAX_BYTES = 512 * 1024 * 1024;
const CHAT_SCRATCH_MAX_ENTRIES = 1000;
const CHAT_SCRATCH_TOTAL_MAX_ENTRIES = 10000;
const CHAT_SCRATCH_MAX_LINE_CHARS = 1024 * 1024;
/** Files people add from the task file panel are streamed to disk, never held in memory. */
export const WORKSPACE_UPLOAD_MAX_BYTES = 1024 * 1024 * 1024;
/** An upload in progress, beside its target; hidden from listings and ignored by the VM recorder's snapshots (*.tmp). */
const UPLOAD_TEMPORARY = /^\.[0-9a-f-]{36}\.upload\.tmp$/;
/** `createFolders` makes the missing folders of the path (a folder upload); otherwise the target folder must exist. */
export interface FileUploadOptions { overwrite?: boolean; createFolders?: boolean }
export interface FileUploadResult { path: string; bytes: number; version: string; replaced: boolean }
export interface FileRenameResult { from: string; to: string; kind: 'file' | 'directory' }
/** A create-only upload or a rename found an existing entry; the file panel asks before replacing it. */
export class WorkspaceEntryExistsError extends Error {
  override readonly name = 'WorkspaceEntryExistsError';
  constructor(readonly path: string) { super(`同名文件或文件夹已存在：${path}`); }
}
/** By name: the Studio and domain plugins are bundled separately, each with its own copy of this class. */
export const isEntryExists = (error: unknown): error is WorkspaceEntryExistsError => error instanceof Error && error.name === 'WorkspaceEntryExistsError';
/** Names people create from the file panel must also be usable on the VM's Windows D: drive. */
export function assertPortableName(path: string): void {
  const name = path.split('/').at(-1) ?? '';
  if (!name || name.length > 255 || /[<>:"|?*\\\u0000-\u001f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name)) {
    throw new Error('名称无效：不能为空，不能包含 \\ / : * ? " < > |，不能以空格或句点结尾，也不能使用 CON、NUL 等 Windows 保留名');
  }
}
/** Every folder and file name of a path, for uploads that create the folders they need. */
export function assertPortablePath(path: string): void { for (const part of path.split('/')) assertPortableName(part); }
const exists = (path: string) => lstat(path).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; });
const syncDirectory = async (path: string) => { const handle = await open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); } };

/** Managed API file access; it is not an OS sandbox for arbitrary subprocesses. */
export class WorkspaceFiles {
  private readonly generations = new Map<string, number>();
  private readonly blocked = new Set<string>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly writeListeners = new Set<(taskId: string, path: string, version: string) => void>();
  private readonly deleteListeners = new Set<(taskId: string, path: string) => void>();
  readonly root: string;

  constructor(root: string, ids: readonly string[], private readonly maxBytes: number, private readonly guardWrite: (id: string) => void = () => {},
    private readonly guardScratchWrite?: (id: string) => void, private readonly external?: ExternalWorkspaceStorage) {
    this.root = resolve(root);
    for (const id of ids) this.register(id);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid file size limit');
  }

  /** Successful ordinary writes notify metadata subscribers; scratch files never do. */
  onWrite(listener: (taskId: string, path: string, version: string) => void): () => void { this.writeListeners.add(listener); return () => { this.writeListeners.delete(listener); }; }
  /** Successful ordinary deletes notify metadata subscribers; scratch files never do. */
  onDelete(listener: (taskId: string, path: string) => void): () => void { this.deleteListeners.add(listener); return () => { this.deleteListeners.delete(listener); }; }

  register(id: string): void {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error(`Invalid workspace id: ${id}`);
    if (!this.generations.has(id)) this.generations.set(id, 0);
  }

  async allocate(id: string): Promise<void> {
    this.register(id);
    await mkdir(this.localDirectory(id), { recursive: true, mode: 0o700 });
    if ((await lstat(this.localDirectory(id))).isSymbolicLink()) throw new Error('Task directory cannot be a symlink');
    if (!this.isExternal(id)) return;
    await this.external!.prepare(id);
    const info = await lstat(this.directory(id));
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('External task directory must be a real directory');
  }

  /** Initialize private, real task directories. An unreachable external store is retried on first use. */
  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if ((await lstat(this.root)).isSymbolicLink()) throw new Error('Workspace root cannot be a symlink');
    for (const taskId of this.generations.keys()) {
      try { await this.allocate(taskId); } catch (error) { if (!this.isExternal(taskId)) throw error; }
    }
  }

  /** Ordinary task files: the external store when configured, otherwise root/taskId. */
  directory(taskId: string): string {
    if (!this.generations.has(taskId)) throw new Error('Unknown task workspace');
    return this.external?.locate(taskId) ?? join(this.root, taskId);
  }

  /** Studio-private storage of a workspace; chat scratch always stays here. */
  localDirectory(taskId: string): string {
    if (!this.generations.has(taskId)) throw new Error('Unknown task workspace');
    return join(this.root, taskId);
  }

  isExternal(taskId: string): boolean { return this.directory(taskId) !== this.localDirectory(taskId); }

  lease(taskId: string): WorkspaceLease {
    this.localDirectory(taskId);
    const lease = { taskId, generation: this.generations.get(taskId)! };
    this.assertLease(lease);
    return lease;
  }

  readLease(taskId: string): WorkspaceLease { this.localDirectory(taskId); return { taskId, generation: this.generations.get(taskId)! }; }

  /** Keep a bounded domain read/copy operation ordered with managed workspace IO. */
  withReadLease<T>(lease: WorkspaceLease, operation: () => Promise<T>): Promise<T> {
    return this.serial(lease.taskId, async () => {
      this.assertLease(lease, false);
      const result = await operation();
      this.assertLease(lease, false);
      return result;
    });
  }

  private assertLease(lease: WorkspaceLease, write = true): void {
    if ((write && this.blocked.has(lease.taskId)) || this.generations.get(lease.taskId) !== lease.generation) {
      throw new Error('Workspace permission was revoked');
    }
  }

  /** Optional discussion permission grants scratch IO without granting task artifact writes. */
  private assertScratchWrite(lease: WorkspaceLease): void {
    this.assertLease(lease, this.guardScratchWrite === undefined);
    (this.guardScratchWrite ?? this.guardWrite)(lease.taskId);
  }

  private serial<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(taskId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.queues.set(taskId, next);
    void next.then(() => { if (this.queues.get(taskId) === next) this.queues.delete(taskId); },
      () => { if (this.queues.get(taskId) === next) this.queues.delete(taskId); });
    return next;
  }

  private validatePath(name: string, scratch = false): void {
    if (!name || isAbsolute(name) || name.includes('\\') || name.includes('\0') || name.split('/').some(part => part === '..' || part === '' || part === '.')) {
      throw new Error('Use a relative file path without traversal');
    }
    if (!scratch && name.split('/')[0].toLowerCase() === CHAT_SCRATCH_ROOT) throw new Error('Chat temporary files require a chat-scoped capability');
  }

  /** Account for all persisted material in one conversation before adding another artifact. */
  private async scratchUsage(directory: string): Promise<{ bytes: number; entries: number }> {
    let bytes = 0, entries = 0;
    const walk = async (folder: string): Promise<void> => {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        if (++entries > CHAT_SCRATCH_TOTAL_MAX_ENTRIES) throw new Error('Conversation temporary storage entry limit exceeded');
        const path = join(folder, entry.name), info = await lstat(path);
        if (info.isSymbolicLink()) throw new Error('Symlink access refused');
        if (info.isDirectory()) await walk(path);
        else if (info.isFile()) {
          bytes += info.size;
          if (bytes > CHAT_SCRATCH_TOTAL_MAX_BYTES) throw new Error('Conversation temporary storage quota exceeded');
        } else throw new Error('Scratch entry is not a regular file or directory');
      }
    };
    await walk(directory); return { bytes, entries };
  }

  /** Inspect a chat-relative target without creating any quota-consuming parents. */
  private async scratchTargetState(directory: string, name: string): Promise<{ existing?: Stats; missingEntries: number }> {
    this.validatePath(name);
    const parts = name.split('/'); let cursor = directory, missingEntries = 0, missing = false, existing: Stats | undefined;
    for (let index = 0; index < parts.length; index++) {
      cursor = join(cursor, parts[index]);
      if (missing) { missingEntries++; continue; }
      try {
        const info = await lstat(cursor);
        if (info.isSymbolicLink()) throw new Error('Symlink access refused');
        if (index < parts.length - 1 && !info.isDirectory()) throw new Error('Parent is not a directory');
        if (index === parts.length - 1) {
          if (!info.isFile()) throw new Error('Scratch target is not a regular file');
          existing = info;
        }
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        missing = true; missingEntries++;
      }
    }
    return { ...(existing === undefined ? {} : { existing }), missingEntries };
  }

  private async checkedDirectory(taskId: string, scratch = false): Promise<string> {
    const directory = scratch ? this.localDirectory(taskId) : this.directory(taskId);
    if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) {
      throw new Error('Task directory changed');
    }
    return directory;
  }

  private async filePath(taskId: string, name: string, createParents: boolean, scratch = false): Promise<string> {
    this.validatePath(name, scratch);
    const directory = await this.checkedDirectory(taskId, scratch);
    const target = resolve(directory, name);
    const child = relative(directory, target);
    if (child.startsWith(`..${sep}`) || child === '..' || isAbsolute(child)) throw new Error('Path outside task workspace');
    let cursor = directory;
    const parts = name.split('/');
    for (let i = 0; i < parts.length; i++) {
      cursor = join(cursor, parts[i]);
      try {
        const info = await lstat(cursor);
        if (info.isSymbolicLink()) throw new Error('Symlink access refused');
        if (i < parts.length - 1 && !info.isDirectory()) throw new Error('Parent is not a directory');
        if (i === parts.length - 1 && !info.isFile()) throw new Error('Target is not a regular file');
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        if (i < parts.length - 1 && createParents) await mkdir(cursor, { mode: 0o700 });
        else if (i < parts.length - 1) throw error;
      }
    }
    return target;
  }

  /** An existing file or folder, reached without following links. */
  private async entry(taskId: string, name: string): Promise<{ path: string; info: Stats }> {
    this.validatePath(name);
    let path = await this.checkedDirectory(taskId), info: Stats | undefined;
    const parts = name.split('/');
    for (let i = 0; i < parts.length; i++) {
      path = join(path, parts[i]); info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error('Symlink access refused');
      if (i < parts.length - 1 && !info.isDirectory()) throw new Error('Parent is not a directory');
    }
    if (!info!.isFile() && !info!.isDirectory()) throw new Error('Target is not a regular file or directory');
    return { path, info: info! };
  }

  private async browseDirectory(taskId: string, name: string): Promise<string> {
    if (name !== '') this.validatePath(name);
    let directory = await this.checkedDirectory(taskId);
    for (const part of name === '' ? [] : name.split('/')) {
      directory = join(directory, part);
      const info = await lstat(directory);
      if (info.isSymbolicLink()) throw new Error('Symlink access refused');
      if (!info.isDirectory()) throw new Error('Target is not a directory');
    }
    return directory;
  }

  /** List one real directory without allocating a draft workspace or exposing chat storage. */
  listDirectory(lease: WorkspaceLease, name = '', offset = 0, limit = 100, signal?: AbortSignal): Promise<WorkspaceDirectoryListing> {
    return this.serial(lease.taskId, async () => {
      throwIfAborted(signal);
      this.assertLease(lease, false);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('List offset must be a nonnegative integer');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('List limit must be between 1 and 200');
      if (name !== '') this.validatePath(name);
      const empty = (): WorkspaceDirectoryListing => ({ path: name, entries: [], offset, limit, total: 0 });
      let directory: string;
      try { directory = await this.browseDirectory(lease.taskId, name); }
      catch (error) {
        // Only an unallocated root is empty. A missing user-selected subdirectory
        // is an error, so the UI can distinguish deletion from an empty folder.
        if (name === '' && error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          this.assertLease(lease, false); return empty();
        }
        throw error;
      }
      const entries: WorkspaceDirectoryEntry[] = [];
      // Stream directory entries and cap the sorting buffer before it can grow unbounded.
      for await (const entry of await opendir(directory)) {
        throwIfAborted(signal);
        if (name === '' && entry.name.toLowerCase() === CHAT_SCRATCH_ROOT || UPLOAD_TEMPORARY.test(entry.name)) continue;
        if (entries.length >= 10000) throw new Error('Directory listing exceeds 10000 entries; split files into smaller directories');
        const info = await lstat(join(directory, entry.name));
        if (info.isSymbolicLink()) throw new Error('Symlink access refused');
        if (!info.isDirectory() && !info.isFile()) throw new Error('Workspace entry is not a regular file or directory');
        entries.push({ name: entry.name, path: name === '' ? entry.name : `${name}/${entry.name}`,
          kind: info.isDirectory() ? 'directory' : 'file', ...(info.isFile() ? { bytes: info.size } : {}), modifiedAt: info.mtime.toISOString() });
      }
      throwIfAborted(signal);
      entries.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'directory' ? -1 : 1)
        || a.name.localeCompare(b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      this.assertLease(lease, false);
      const total = entries.length, page = entries.slice(offset, offset + limit);
      return { path: name, entries: page, offset, limit, total, ...(offset + page.length < total ? { nextOffset: offset + page.length } : {}) };
    });
  }

  /** A read handle on one regular file for a human download; the caller streams and closes it. */
  openFile(lease: WorkspaceLease, name: string): Promise<{ handle: FileHandle; bytes: number }> {
    return this.serial(lease.taskId, async () => {
      this.assertLease(lease, false);
      const handle = await open(await this.filePath(lease.taskId, name, false), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new Error('Target is not a regular file');
        this.assertLease(lease, false);
        return { handle, bytes: info.size };
      } catch (error) { await handle.close(); throw error; }
    });
  }

  /** Bounded human preview detects binary bytes instead of rendering lossy UTF-8. */
  preview(lease: WorkspaceLease, name: string): Promise<WorkspaceFilePreview> {
    return this.serial(lease.taskId, async () => {
      this.assertLease(lease, false);
      const path = await this.filePath(lease.taskId, name, false);
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new Error('Target is not a regular file');
        if (info.size > this.maxBytes) { this.assertLease(lease, false); return { path: name, bytes: info.size, status: 'tooLarge' }; }
        // Read at most one byte beyond the limit even if another producer grows
        // the file after stat. This keeps a preview bounded throughout the IO.
        const bytes = Buffer.alloc(this.maxBytes + 1);
        let length = 0;
        while (length < bytes.length) {
          const part = await handle.read(bytes, length, bytes.length - length, length);
          if (!part.bytesRead) break;
          length += part.bytesRead;
        }
        this.assertLease(lease, false);
        if (length > this.maxBytes) return { path: name, bytes: Math.max(length, (await handle.stat()).size), status: 'tooLarge' };
        const contentBytes = bytes.subarray(0, length);
        if (contentBytes.includes(0)) return { path: name, bytes: length, status: 'binary' };
        let content: string;
        try { content = new TextDecoder('utf-8', { fatal: true }).decode(contentBytes); }
        catch { return { path: name, bytes: length, status: 'binary' }; }
        return { path: name, bytes: length, status: 'text', content, version: createHash('sha256').update(contentBytes).digest('hex') };
      } finally { await handle.close(); }
    });
  }

  private scratchName(chatId: string, name?: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(chatId)) throw new Error('Invalid chat UUID');
    if (name !== undefined) this.validatePath(name);
    return name === undefined ? `${CHAT_SCRATCH_ROOT}/${chatId}` : `${CHAT_SCRATCH_ROOT}/${chatId}/${name}`;
  }

  private async scratchDirectory(lease: WorkspaceLease, chatId: string, create: boolean): Promise<string> {
    const name = this.scratchName(chatId);
    let cursor = await this.checkedDirectory(lease.taskId, true);
    for (const part of name.split('/')) {
      cursor = join(cursor, part);
      try {
        const info = await lstat(cursor);
        if (info.isSymbolicLink()) throw new Error('Symlink access refused');
        if (!info.isDirectory()) throw new Error('Scratch directory is not a directory');
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT') || !create) throw error;
        this.assertScratchWrite(lease);
        await mkdir(cursor, { mode: 0o700 });
      }
    }
    return cursor;
  }

  /** Read-only lookup for exports: an absent tree is not allocated, so finished or frozen tasks need no write access. */
  existingScratch(lease: WorkspaceLease, chatId: string): Promise<string | undefined> {
    return this.serial(lease.taskId, async () => {
      this.assertLease(lease, false);
      try { return await this.scratchDirectory(lease, chatId, false); }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
        throw error;
      }
    });
  }

  /** Dedicated capability entry points; ordinary file access cannot reach this reserved tree. */
  ensureScratch(lease: WorkspaceLease, chatId: string): Promise<string> {
    return this.serial(lease.taskId, async () => {
      this.assertLease(lease, false);
      if (this.guardScratchWrite !== undefined) this.assertScratchWrite(lease);
      return this.scratchDirectory(lease, chatId, true);
    });
  }

  readScratch(lease: WorkspaceLease, chatId: string, name: string): Promise<ScratchFileValue> {
    return this.serial(lease.taskId, async () => {
      this.assertLease(lease, false);
      const path = await this.filePath(lease.taskId, this.scratchName(chatId, name), false, true);
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if ((await handle.stat()).size > CHAT_SCRATCH_MAX_BYTES) throw new Error('File exceeds size limit');
        const content = await handle.readFile('utf8');
        const bytes = Buffer.byteLength(content);
        if (bytes > CHAT_SCRATCH_MAX_BYTES) throw new Error('File exceeds size limit');
        return { path: name, content, bytes, version: createHash('sha256').update(content).digest('hex') };
      } finally { await handle.close(); }
    });
  }

  writeScratch(lease: WorkspaceLease, chatId: string, name: string, content: string): Promise<ScratchFileValue> {
    return this.serial(lease.taskId, async () => {
      this.assertScratchWrite(lease);
      const bytes = Buffer.byteLength(content);
      if (bytes > CHAT_SCRATCH_MAX_BYTES) throw new Error('File exceeds size limit');
      this.scratchName(chatId, name);
      const directory = await this.scratchDirectory(lease, chatId, true);
      const state = await this.scratchTargetState(directory, name), previous = state.existing;
      const usage = await this.scratchUsage(directory);
      if (usage.bytes - (previous?.size ?? 0) + bytes > CHAT_SCRATCH_TOTAL_MAX_BYTES) throw new Error('Conversation temporary storage quota exceeded');
      if (usage.entries + state.missingEntries > CHAT_SCRATCH_TOTAL_MAX_ENTRIES) throw new Error('Conversation temporary storage entry limit exceeded');
      const path = await this.filePath(lease.taskId, this.scratchName(chatId, name), true, true);
      const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(content, 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      return { path: name, content, bytes, version: createHash('sha256').update(content).digest('hex') };
    });
  }

  /** Store one server-fetched binary artifact without exposing host paths or ordinary task-file authority. */
  writeScratchBytes(lease: WorkspaceLease, chatId: string, name: string, data: Uint8Array, signal?: AbortSignal): Promise<Omit<ScratchBinaryValue, 'data'>> {
    return this.serial(lease.taskId, async () => {
      throwIfAborted(signal); this.assertScratchWrite(lease);
      if (!(data instanceof Uint8Array) || data.byteLength > CHAT_SCRATCH_ARTIFACT_MAX_BYTES) throw new Error('Temporary artifact exceeds size limit');
      const owned = this.scratchName(chatId, name);
      const directory = await this.scratchDirectory(lease, chatId, true);
      const usage = await this.scratchUsage(directory), materializedEntries = name.split('/').length;
      if (usage.bytes + data.byteLength > CHAT_SCRATCH_TOTAL_MAX_BYTES) throw new Error('Conversation temporary storage quota exceeded');
      if (usage.entries + materializedEntries > CHAT_SCRATCH_TOTAL_MAX_ENTRIES) throw new Error('Conversation temporary storage entry limit exceeded');
      const target = await this.filePath(lease.taskId, owned, true, true);
      const temporary = await this.filePath(lease.taskId, `${owned}.${randomUUID()}.tmp`, true, true);
      let published = false;
      try {
        const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await handle.writeFile(data); await handle.sync(); }
        finally { await handle.close(); }
        throwIfAborted(signal); this.assertScratchWrite(lease);
        // A hard-link publish is atomic and cannot replace an existing artifact.
        await link(temporary, target); published = true; await unlink(temporary);
        const parent = await open(dirname(target), 'r'); try { await parent.sync(); } finally { await parent.close(); }
        return { path: name, bytes: data.byteLength, version: createHash('sha256').update(data).digest('hex') };
      } catch (error) {
        await unlink(temporary).catch(() => {});
        if (published) await unlink(target).catch(() => {});
        throw error;
      }
    });
  }

  /** Read a bounded binary artifact for a trusted parser such as the ZIP extractor. */
  readScratchBytes(lease: WorkspaceLease, chatId: string, name: string, maxBytes = CHAT_SCRATCH_ARTIFACT_MAX_BYTES, signal?: AbortSignal): Promise<ScratchBinaryValue> {
    return this.serial(lease.taskId, async () => {
      throwIfAborted(signal); this.assertLease(lease, false);
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > CHAT_SCRATCH_ARTIFACT_MAX_BYTES) throw new Error('Invalid temporary artifact read limit');
      const path = await this.filePath(lease.taskId, this.scratchName(chatId, name), false, true);
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.size > maxBytes) throw new Error('Temporary artifact exceeds size limit');
        const data = Buffer.alloc(before.size); let offset = 0;
        while (offset < data.length) {
          throwIfAborted(signal); const part = await handle.read(data, offset, data.length - offset, offset);
          if (!part.bytesRead) break; offset += part.bytesRead;
        }
        const after = await handle.stat();
        if (offset !== before.size || after.size !== before.size || after.ino !== before.ino || after.dev !== before.dev
          || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('Temporary artifact changed while being read');
        this.assertLease(lease, false);
        return { path: name, bytes: data.length, data, version: createHash('sha256').update(data).digest('hex') };
      } finally { await handle.close(); }
    });
  }

  /** Stream-scan a large UTF-8 artifact; memory stays bounded by the requested page and one IO chunk. */
  readScratchPage(lease: WorkspaceLease, chatId: string, name: string, offset = 0, limit = 6000, signal?: AbortSignal): Promise<ScratchTextPageValue> {
    return this.serial(lease.taskId, async () => {
      throwIfAborted(signal); this.assertLease(lease, false);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Offset must be a non-negative integer');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 12000) throw new Error('Read limit must be between 1 and 12000 characters');
      const path = await this.filePath(lease.taskId, this.scratchName(chatId, name), false, true);
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.size > CHAT_SCRATCH_ARTIFACT_MAX_BYTES) throw new Error('Temporary text artifact exceeds size limit');
        const decoder = new TextDecoder('utf-8', { fatal: true }), hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
        const selected: string[] = []; let position = 0, totalChars = 0;
        const consume = (text: string) => {
          const chars = Array.from(text), start = Math.max(0, offset - totalChars), end = Math.min(chars.length, offset + limit - totalChars);
          if (end > start) selected.push(chars.slice(start, end).join(''));
          totalChars += chars.length;
        };
        while (position < before.size) {
          throwIfAborted(signal); const part = await handle.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
          if (!part.bytesRead) break;
          const bytes = buffer.subarray(0, part.bytesRead); hash.update(bytes); position += part.bytesRead;
          try { consume(decoder.decode(bytes, { stream: true })); }
          catch { throw new Error('Temporary file is binary or not valid UTF-8'); }
        }
        try { consume(decoder.decode()); } catch { throw new Error('Temporary file is binary or not valid UTF-8'); }
        const after = await handle.stat();
        if (position !== before.size || after.size !== before.size || after.ino !== before.ino || after.dev !== before.dev
          || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('Temporary file changed while being read');
        if (offset > totalChars) throw new Error('Offset exceeds file length');
        this.assertLease(lease, false);
        const content = selected.join(''), readChars = Array.from(content).length, next = offset + readChars;
        return { path: name, bytes: before.size, totalChars, version: hash.digest('hex'), content, offset,
          ...(next < totalChars ? { nextOffset: next } : {}) };
      } finally { await handle.close(); }
    });
  }

  /** Literal line search over large UTF-8 artifacts without loading the whole file. */
  searchScratchText(lease: WorkspaceLease, chatId: string, name: string, query: string, limit = 20, signal?: AbortSignal): Promise<ScratchTextSearchValue> {
    return this.serial(lease.taskId, async () => {
      throwIfAborted(signal); this.assertLease(lease, false);
      if (!query || query.includes('\n') || query.includes('\r') || Array.from(query).length > 1024) throw new Error('Use a non-empty single-line search query of at most 1024 characters');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Search limit must be between 1 and 100');
      const path = await this.filePath(lease.taskId, this.scratchName(chatId, name), false, true);
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.size > CHAT_SCRATCH_ARTIFACT_MAX_BYTES) throw new Error('Temporary text artifact exceeds size limit');
        const decoder = new TextDecoder('utf-8', { fatal: true }), buffer = Buffer.alloc(64 * 1024), matches: ScratchTextMatch[] = [];
        let position = 0, pending = '', lineNumber = 1, truncated = false;
        const inspectLine = (line: string) => {
          let from = 0;
          while (true) {
            const index = line.indexOf(query, from); if (index < 0) return;
            if (matches.length >= limit) { truncated = true; return; }
            const chars = Array.from(line), column = Array.from(line.slice(0, index)).length;
            const start = Math.max(0, column - 80), end = Math.min(chars.length, start + 240);
            matches.push({ line: lineNumber, column: column + 1,
              text: `${start ? '…' : ''}${chars.slice(start, end).join('')}${end < chars.length ? '…' : ''}` });
            from = index + query.length;
          }
        };
        const consume = (text: string) => {
          pending += text;
          let newline: number;
          while (!truncated && (newline = pending.indexOf('\n')) >= 0) {
            inspectLine(pending.slice(0, newline)); pending = pending.slice(newline + 1); lineNumber++;
          }
          if (!truncated && pending.length > CHAT_SCRATCH_MAX_LINE_CHARS
            && (pending.length > CHAT_SCRATCH_MAX_LINE_CHARS * 2 || Array.from(pending).length > CHAT_SCRATCH_MAX_LINE_CHARS)) {
            throw new Error('Temporary text line exceeds search limit');
          }
        };
        while (!truncated && position < before.size) {
          throwIfAborted(signal); const part = await handle.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
          if (!part.bytesRead) break; position += part.bytesRead;
          try { consume(decoder.decode(buffer.subarray(0, part.bytesRead), { stream: true })); }
          catch (error) { if (error instanceof Error && error.message.includes('line exceeds')) throw error; throw new Error('Temporary file is binary or not valid UTF-8'); }
        }
        if (!truncated) {
          try { consume(decoder.decode()); } catch (error) { if (error instanceof Error && error.message.includes('line exceeds')) throw error; throw new Error('Temporary file is binary or not valid UTF-8'); }
          if (!truncated) inspectLine(pending);
        }
        const after = await handle.stat();
        if (after.size !== before.size || after.ino !== before.ino || after.dev !== before.dev
          || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('Temporary file changed while being searched');
        this.assertLease(lease, false);
        return { path: name, query, matches, truncated };
      } finally { await handle.close(); }
    });
  }

  /** Publish a validated extracted tree atomically beneath this chat's private mounted directory. */
  writeScratchTree(lease: WorkspaceLease, chatId: string, destination: string, entries: readonly ScratchTreeEntry[], signal?: AbortSignal): Promise<ScratchTreeValue> {
    return this.serial(lease.taskId, async () => {
      throwIfAborted(signal); this.assertScratchWrite(lease); this.validatePath(destination);
      if (!entries.length || entries.length > CHAT_SCRATCH_MAX_ENTRIES) throw new Error('Temporary artifact tree entry count is invalid');
      let bytes = 0, files = 0, directories = 0;
      const seen = new Map<string, 'file' | 'directory'>();
      const materialized = new Set<string>();
      for (const entry of entries) {
        this.validatePath(entry.path);
        const normalizedPath = entry.path.normalize('NFC'), key = normalizedPath.toLocaleLowerCase('en-US');
        if (seen.has(key)) throw new Error('Temporary artifact tree contains duplicate paths');
        const parts = key.split('/');
        const materializedParts = normalizedPath.split('/');
        for (let depth = 1; depth <= materializedParts.length; depth++) materialized.add(materializedParts.slice(0, depth).join('/'));
        for (let i = 1; i < parts.length; i++) if (seen.get(parts.slice(0, i).join('/')) === 'file') throw new Error('Temporary artifact tree has a file/directory conflict');
        if (entry.kind === 'file') {
          if (!(entry.data instanceof Uint8Array) || entry.data.byteLength > CHAT_SCRATCH_ARTIFACT_MAX_BYTES) throw new Error('Temporary artifact tree file exceeds size limit');
          bytes += entry.data.byteLength; files++;
        } else { if (entry.data !== undefined) throw new Error('Temporary artifact directory cannot contain bytes'); directories++; }
        if (bytes > CHAT_SCRATCH_TREE_MAX_BYTES) throw new Error('Temporary artifact tree exceeds total size limit');
        seen.set(key, entry.kind);
      }
      for (const [key, kind] of seen) if (kind === 'file') {
        for (const other of seen.keys()) if (other.startsWith(`${key}/`)) throw new Error('Temporary artifact tree has a file/directory conflict');
      }
      const root = await this.scratchDirectory(lease, chatId, true);
      const usage = await this.scratchUsage(root);
      if (usage.bytes + bytes > CHAT_SCRATCH_TOTAL_MAX_BYTES) throw new Error('Conversation temporary storage quota exceeded');
      // Count every implicit parent plus the server-generated destination path
      // before creating the staging tree. This prevents sparse, deeply nested
      // archives from bypassing the per-conversation inode budget.
      if (usage.entries + materialized.size + destination.split('/').length > CHAT_SCRATCH_TOTAL_MAX_ENTRIES) {
        throw new Error('Conversation temporary storage entry limit exceeded');
      }
      const stage = join(root, `.publish-${randomUUID()}.tmp`);
      const target = resolve(root, destination), child = relative(root, target);
      if (child.startsWith(`..${sep}`) || child === '..' || isAbsolute(child)) throw new Error('Path outside chat temporary directory');
      const ensureDirectory = async (base: string, path: string) => {
        let cursor = base;
        for (const part of path ? path.split('/') : []) {
          cursor = join(cursor, part);
          try { const info = await lstat(cursor); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Temporary artifact parent is unsafe'); }
          catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; await mkdir(cursor, { mode: 0o700 }); }
        }
      };
      try {
        const existing = await lstat(target).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
        if (existing) throw new Error('Temporary artifact destination already exists');
        await mkdir(stage, { mode: 0o700 });
        const ordered = [...entries].sort((a, b) => (a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === 'directory' ? -1 : 1));
        for (const entry of ordered) {
          throwIfAborted(signal); this.assertScratchWrite(lease);
          const parent = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '';
          await ensureDirectory(stage, parent);
          const path = join(stage, ...entry.path.split('/'));
          if (entry.kind === 'directory') await ensureDirectory(stage, entry.path);
          else {
            const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
            try { await handle.writeFile(entry.data!); await handle.sync(); } finally { await handle.close(); }
          }
        }
        const parent = destination.includes('/') ? destination.slice(0, destination.lastIndexOf('/')) : '';
        await ensureDirectory(root, parent);
        throwIfAborted(signal); this.assertScratchWrite(lease);
        if (await lstat(target).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) throw new Error('Temporary artifact destination already exists');
        await rename(stage, target);
        const owner = await open(dirname(target), 'r'); try { await owner.sync(); } finally { await owner.close(); }
        return { path: destination, files, directories, bytes };
      } catch (error) { await removeManagedDirectory(root, stage); throw error; }
    });
  }

  listScratch(lease: WorkspaceLease, chatId: string, limit = 100, offset = 0): Promise<ScratchFileList> {
    return this.serial(lease.taskId, async () => {
      this.assertLease(lease, false);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('List limit must be between 1 and 200');
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('List offset must be a non-negative integer');
      // Chats created before temporary storage was introduced may be frozen and
      // have no scratch tree. Reading their empty listing must not allocate it.
      await this.checkedDirectory(lease.taskId, true);
      this.scratchName(chatId);
      let directory: string;
      try { directory = await this.scratchDirectory(lease, chatId, false); }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { files: [], truncated: false };
        throw error;
      }
      const files: ScratchFileInfo[] = [];
      let visited = 0;
      const walk = async (folder: string): Promise<void> => {
        for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
          if (++visited > CHAT_SCRATCH_TOTAL_MAX_ENTRIES) throw new Error('Conversation temporary storage entry limit exceeded');
          const path = join(folder, entry.name);
          const info = await lstat(path);
          if (info.isSymbolicLink()) throw new Error('Symlink access refused');
          if (info.isDirectory()) await walk(path);
          else if (info.isFile()) {
            files.push({ path: relative(directory, path).split(sep).join('/'), bytes: info.size, modifiedAt: info.mtime.toISOString() });
          } else throw new Error('Scratch entry is not a regular file or directory');
        }
      };
      await walk(directory);
      files.sort((a, b) => a.path.localeCompare(b.path));
      const page = files.slice(offset, offset + limit), next = offset + page.length;
      return { files: page, truncated: next < files.length, ...(next < files.length ? { nextOffset: next } : {}) };
    });
  }

  read(lease: WorkspaceLease, name: string): Promise<FileValue> {
    return this.serial(lease.taskId, async () => {
      this.assertLease(lease, false);
      const path = await this.filePath(lease.taskId, name, false);
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if ((await handle.stat()).size > this.maxBytes) throw new Error('File exceeds size limit');
        const content = await handle.readFile('utf8');
        if (Buffer.byteLength(content) > this.maxBytes) throw new Error('File exceeds size limit');
        return { content, version: createHash('sha256').update(content).digest('hex') };
      } finally { await handle.close(); }
    });
  }

  write(lease: WorkspaceLease, name: string, content: string, options: FileWriteOptions = {}): Promise<FileValue> {
    return this.serial(lease.taskId, async () => {
      this.assertLease(lease);
      this.guardWrite(lease.taskId);
      if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['expectedVersion', 'createOnly'].includes(key))) throw new Error('Invalid file write options');
      if (options.expectedVersion !== undefined && (typeof options.expectedVersion !== 'string' || !/^[0-9a-f]{64}$/.test(options.expectedVersion))) throw new Error('Invalid expected file version');
      if (options.createOnly !== undefined && typeof options.createOnly !== 'boolean') throw new Error('Invalid file creation flag');
      if (options.createOnly && options.expectedVersion !== undefined) throw new Error('Choose either new-file creation or existing-file editing');
      if (Buffer.byteLength(content) > this.maxBytes) throw new Error('File exceeds size limit');
      const path = await this.filePath(lease.taskId, name, options.expectedVersion === undefined);
      if (options.expectedVersion !== undefined) {
        const current = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(error => {
          if (error?.code === 'ENOENT') throw new Error('File changed or no longer exists; refresh before saving'); throw error;
        });
        try {
          const info = await current.stat(); if (!info.isFile() || info.size > this.maxBytes) throw new Error('File changed or is not editable text; refresh before saving');
          const bytes = Buffer.alloc(this.maxBytes + 1); let length = 0;
          while (length < bytes.length) { const part = await current.read(bytes, length, bytes.length - length, length); if (!part.bytesRead) break; length += part.bytesRead; }
          const value = bytes.subarray(0, length);
          if (length > this.maxBytes || value.includes(0)) throw new Error('File changed or is not editable text; refresh before saving');
          try { new TextDecoder('utf-8', { fatal: true }).decode(value); } catch { throw new Error('File changed or is not editable text; refresh before saving'); }
          if (createHash('sha256').update(value).digest('hex') !== options.expectedVersion) throw new Error('File changed since preview; refresh before saving');
        } finally { await current.close(); }
      }
      // This compare-and-write is serialized with all managed writes in the
      // task queue. Exclusive creation never truncates an existing file.
      const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | (options.createOnly ? constants.O_EXCL : constants.O_TRUNC);
      const handle = await open(path, flags, 0o600).catch(error => { if (options.createOnly && error?.code === 'EEXIST') throw new Error('File already exists; choose another name'); throw error; });
      try { await handle.writeFile(content, 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      const version = createHash('sha256').update(content).digest('hex');
      for (const listener of this.writeListeners) { try { listener(lease.taskId, name, version); } catch { /* Metadata must never turn a durable write into a failure. */ } }
      return { content, version };
    });
  }

  /** Delete one owned regular file. Directories and chat scratch remain outside this capability. */
  delete(lease: WorkspaceLease, name: string, options: FileDeleteOptions = {}): Promise<FileDeleteResult> {
    return this.serial(lease.taskId, async () => {
      this.assertLease(lease);
      this.guardWrite(lease.taskId);
      if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'expectedVersion')) throw new Error('Invalid file delete options');
      if (options.expectedVersion !== undefined && (typeof options.expectedVersion !== 'string' || !/^[0-9a-f]{64}$/.test(options.expectedVersion))) throw new Error('Invalid expected file version');
      const path = await this.filePath(lease.taskId, name, false);
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let opened: Stats;
      try {
        opened = await handle.stat();
        if (!opened.isFile()) throw new Error('Target is not a regular file');
        if (options.expectedVersion !== undefined) {
          if (opened.size > this.maxBytes) throw new Error('File changed or is too large for a version-checked delete');
          const bytes = Buffer.alloc(this.maxBytes + 1); let length = 0;
          while (length < bytes.length) { const part = await handle.read(bytes, length, bytes.length - length, length); if (!part.bytesRead) break; length += part.bytesRead; }
          if (length > this.maxBytes || createHash('sha256').update(bytes.subarray(0, length)).digest('hex') !== options.expectedVersion) throw new Error('File changed since preview; refresh before deleting');
        }
      } finally { await handle.close(); }
      const current = await lstat(path);
      if (!current.isFile() || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) throw new Error('File changed since it was opened; refresh before deleting');
      this.assertLease(lease); this.guardWrite(lease.taskId);
      await unlink(path);
      const parent = await open(dirname(path), 'r');
      try { await parent.sync(); } finally { await parent.close(); }
      for (const listener of this.deleteListeners) { try { listener(lease.taskId, name); } catch { /* Metadata must never turn a durable delete into a failure. */ } }
      return { path: name };
    });
  }

  /**
   * Store one file streamed from the browser into an existing folder. The bytes go to a temporary file beside the
   * target without holding any lock, so a long upload never blocks other workspace IO or the domain; only admission
   * and the final link (new file) or rename (replacement) run under `admit` (the domain write guard) and the task queue.
   */
  async upload(taskId: string, name: string, body: AsyncIterable<Uint8Array>, options: FileUploadOptions = {}, signal?: AbortSignal,
    admit: <T>(step: () => Promise<T>) => Promise<T> = step => step(), maxBytes = WORKSPACE_UPLOAD_MAX_BYTES): Promise<FileUploadResult> {
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['overwrite', 'createFolders'].includes(key))
      || (options.overwrite !== undefined && typeof options.overwrite !== 'boolean') || (options.createFolders !== undefined && typeof options.createFolders !== 'boolean')) throw new Error('Invalid file upload options');
    this.validatePath(name);
    if (options.createFolders) assertPortablePath(name); else assertPortableName(name);
    const { lease, temporary, handle } = await admit(() => this.serial(taskId, async () => {
      const lease = this.lease(taskId); this.guardWrite(taskId);
      const target = await this.filePath(taskId, name, !!options.createFolders);
      if (!options.overwrite && await exists(target)) throw new WorkspaceEntryExistsError(name);
      const temporary = join(dirname(target), `.${randomUUID()}.upload.tmp`);
      return { lease, temporary, handle: await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) };
    }));
    let placed = false;
    try {
      const hash = createHash('sha256'); let bytes = 0;
      try {
        for await (const chunk of body) {
          throwIfAborted(signal);
          bytes += chunk.byteLength;
          if (bytes > maxBytes) throw new Error(`文件超过上传上限 ${Math.round(maxBytes / 1024 / 1024)} MB`);
          hash.update(chunk);
          for (let offset = 0; offset < chunk.byteLength;) offset += (await handle.write(chunk, offset, chunk.byteLength - offset)).bytesWritten;
        }
        throwIfAborted(signal);
        await handle.sync();
      } finally { await handle.close(); }
      const replaced = await admit(() => this.serial(taskId, async () => {
        this.assertLease(lease); this.guardWrite(taskId);
        const target = await this.filePath(taskId, name, false);
        if (dirname(target) !== dirname(temporary)) throw new Error('上传位置已改变，请刷新后重试');
        const existed = await exists(target);
        if (options.overwrite) { await rename(temporary, target); placed = true; }
        else {
          if (existed) throw new WorkspaceEntryExistsError(name);
          // link never replaces an entry another producer (the VM) created meanwhile.
          await link(temporary, target).catch((error: NodeJS.ErrnoException) => { if (error.code === 'EEXIST') throw new WorkspaceEntryExistsError(name); throw error; });
          placed = true; await unlink(temporary).catch(() => undefined);
        }
        await syncDirectory(dirname(target));
        return existed;
      }));
      const version = hash.digest('hex');
      for (const listener of this.writeListeners) { try { listener(taskId, name, version); } catch { /* Metadata must never turn a durable write into a failure. */ } }
      return { path: name, bytes, version, replaced };
    } finally { if (!placed) await unlink(temporary).catch(() => undefined); }
  }

  /** Whether a file or folder exists, so the file panel can ask about replacing before sending an upload. */
  stat(lease: WorkspaceLease, name: string): Promise<{ path: string; kind?: 'file' | 'directory' }> {
    return this.serial(lease.taskId, async () => {
      this.assertLease(lease, false);
      try { const { info } = await this.entry(lease.taskId, name); return { path: name, kind: info.isDirectory() ? 'directory' : 'file' }; }
      catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { path: name }; throw error; }
    });
  }

  /** Rename or move one file or folder inside the workspace. An existing target is never replaced. */
  rename(lease: WorkspaceLease, from: string, to: string): Promise<FileRenameResult> {
    return this.serial(lease.taskId, async () => {
      this.assertLease(lease); this.guardWrite(lease.taskId);
      this.validatePath(from); this.validatePath(to); assertPortableName(to);
      if (from === to) throw new Error('新名称与原名称相同');
      if (to.startsWith(`${from}/`)) throw new Error('不能把文件夹移动到它自己的子文件夹中');
      const source = await this.entry(lease.taskId, from), slash = to.lastIndexOf('/');
      const target = join(await this.browseDirectory(lease.taskId, slash < 0 ? '' : to.slice(0, slash)), to.slice(slash + 1));
      if (await exists(target)) throw new WorkspaceEntryExistsError(to);
      this.assertLease(lease); this.guardWrite(lease.taskId);
      const kind = source.info.isDirectory() ? 'directory' : 'file';
      if (kind === 'file') {
        await link(source.path, target).catch((error: NodeJS.ErrnoException) => { if (error.code === 'EEXIST') throw new WorkspaceEntryExistsError(to); throw error; });
        await unlink(source.path);
      } else await rename(source.path, target);
      for (const directory of new Set([dirname(source.path), dirname(target)])) await syncDirectory(directory);
      // Folder contents and the new name are reconciled by the domain's file watcher.
      if (kind === 'file') for (const listener of this.deleteListeners) { try { listener(lease.taskId, from); } catch { /* Metadata must never turn a durable rename into a failure. */ } }
      return { from, to, kind };
    });
  }

  /** Delete one folder with everything in it. A link or special file anywhere inside refuses the delete before anything is removed. */
  deleteDirectory(lease: WorkspaceLease, name: string): Promise<FileDeleteResult> {
    return this.serial(lease.taskId, async () => {
      this.assertLease(lease); this.guardWrite(lease.taskId);
      const { path, info } = await this.entry(lease.taskId, name);
      if (!info.isDirectory()) throw new Error('Target is not a directory');
      this.assertLease(lease); this.guardWrite(lease.taskId);
      await removeManagedDirectory(dirname(path), path);
      await syncDirectory(dirname(path));
      return { path: name };
    });
  }

  /** Revoke before stopping producers, so no queued or old producer can start another write. */
  revoke(taskId: string): void { this.localDirectory(taskId); this.blocked.add(taskId); this.generations.set(taskId, this.generations.get(taskId)! + 1); }

  /** Revoke all tasks first; then wait for admitted manual and Agent IO to finish. */
  async drain(): Promise<void> { await Promise.allSettled([...this.queues.values()]); }

  /** Drain admitted IO and replace work data. Failure leaves the workspace blocked. */
  async purge(taskId: string): Promise<void> {
    if (!this.blocked.has(taskId)) throw new Error('Revoke workspace before purge');
    await this.serial(taskId, async () => {
      // Studio-private data is replaced; external task files too when Studio owns them (vm_manager keeps its task spaces).
      const directory = this.localDirectory(taskId);
      const existing = await lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (existing?.isSymbolicLink()) throw new Error('Refusing linked task directory');
      // The process may have stopped after removal and before recreation. The
      // managed remover is idempotent and rejects links throughout the tree.
      await removeManagedDirectory(this.root, directory);
      await mkdir(directory, { mode: 0o700 });
      if (this.external?.remove && this.isExternal(taskId)) { await this.external.remove(taskId); await this.external.prepare(taskId); }
      this.generations.set(taskId, this.generations.get(taskId)! + 1);
    });
  }

  /** Permanent removal remains revoked and is idempotent for a pending deletion retry. */
  async deleteTask(taskId: string): Promise<void> {
    if (!this.blocked.has(taskId)) throw new Error('Revoke workspace before deletion');
    await this.serial(taskId, async () => {
      if (this.external?.remove && this.isExternal(taskId)) await this.external.remove(taskId);
      await removeManagedDirectory(this.root, this.localDirectory(taskId));
    });
  }

  /** Only called after all work records have been removed successfully. */
  reopen(taskId: string): void { this.localDirectory(taskId); this.blocked.delete(taskId); }
}
