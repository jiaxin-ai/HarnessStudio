import { lstat, mkdir, open, readdir, realpath, rename, rm, rmdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { removeManagedDirectory } from './managed-delete.ts';

const chatIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const absent = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';

/** A minimal retry manifest survives partial chat-index cleanup; success leaves no record. */
export class ConversationDeletion {
  private readonly root: string;
  private readonly jobs: string;
  constructor(root: string) { this.root = resolve(root); this.jobs = join(this.root, 'conversation-deletions'); }
  private path(taskId: string): string {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(taskId)) throw new Error('Invalid deletion workspace');
    return join(this.jobs, `${taskId}.json`);
  }
  private async checkDirectory(path: string): Promise<void> {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw new Error('会话清理目录已改变');
  }
  async prepare(taskId: string, current: string[]): Promise<string[]> {
    const filename = this.path(taskId);
    await this.checkDirectory(this.root);
    await mkdir(this.jobs, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    // mkdir must tolerate an existing real journal, never follow a replacement link.
    return this.prepareExisting(filename, taskId, current);
  }
  private async prepareExisting(filename: string, taskId: string, current: string[]): Promise<string[]> {
    await this.checkDirectory(this.jobs);
    let stored: string[] = [];
    try {
      const reader = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!(await reader.stat()).isFile()) throw new Error('会话清理清单不是文件');
        const value = JSON.parse(await reader.readFile('utf8'));
        if (value?.taskId !== taskId || !Array.isArray(value.chatIds) || value.chatIds.some((id: unknown) => typeof id !== 'string' || !chatIdPattern.test(id))) throw new Error('会话清理清单无效');
        stored = value.chatIds;
      } finally { await reader.close(); }
    } catch (error) { if (!absent(error)) throw error; }
    const ids = [...new Set([...stored, ...current])];
    if (ids.some(id => !chatIdPattern.test(id))) throw new Error('会话清理标识无效');
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      const writer = await open(temporary, 'wx', 0o600);
      try { await writer.writeFile(JSON.stringify({ taskId, chatIds: ids }) + '\n'); await writer.sync(); }
      finally { await writer.close(); }
      await rename(temporary, filename);
      const directory = await open(this.jobs, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await rm(temporary, { force: true }); }
    return ids;
  }
  async removeSessions(ids: string[]): Promise<void> {
    const sessions = join(this.root, 'sessions');
    try { await this.checkDirectory(sessions); }
    catch (error) { if (absent(error)) return; throw error; }
    for (const parent of await readdir(sessions, { withFileTypes: true })) {
      const directory = join(sessions, parent.name), info = await lstat(directory);
      if (info.isSymbolicLink()) throw new Error('拒绝链接会话目录');
      if (!info.isDirectory()) continue;
      await this.checkDirectory(directory);
      const owned = (await readdir(directory)).some(name => ids.includes(name));
      for (const id of ids) {
        if (!chatIdPattern.test(id)) throw new Error('会话清理标识无效');
        // UUIDs are unchanged by the pinned DSH segment encoder. No cwd encoder is duplicated.
        await removeManagedDirectory(directory, join(directory, id));
      }
      // Remove a now-empty owner directory with rmdir only. A concurrent or
      // unrelated Session makes it nonempty and is preserved rather than swept.
      if (owned) await rmdir(directory).catch(error => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; });
    }
  }
  async finish(taskId: string): Promise<void> { await this.checkDirectory(this.jobs); await rm(this.path(taskId), { force: true }); }
}
