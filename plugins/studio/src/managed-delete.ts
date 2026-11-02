import { chmod, lstat, realpath, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/** Remove one owned direct child, without following links or retaining a backup. */
export async function removeManagedDirectory(root: string, path: string): Promise<void> {
  const base = resolve(root), target = resolve(path);
  if (dirname(target) !== base) throw new Error('清理路径不属于受管目录');
  const check = async (directory: string) => {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) throw new Error('清理目录已改变，拒绝链接或非真实目录');
  };
  try { await check(base); await check(target); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return; throw error; }
  const directories: string[] = [];
  const inspect = async (directory: string): Promise<void> => {
    await check(directory);
    directories.push(directory);
    for (const row of await readdir(directory, { withFileTypes: true })) {
      const child = join(directory, row.name), info = await lstat(child);
      if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) throw new Error('清理目录包含链接或特殊文件，拒绝删除');
      if (info.isDirectory()) await inspect(child);
    }
  };
  // Inspect the whole tree before changing frozen directory permissions.
  await inspect(target);
  for (const directory of directories) { await check(directory); await chmod(directory, 0o700); }
  await check(base); await check(target);
  await rm(target, { recursive: true, force: true });
}
