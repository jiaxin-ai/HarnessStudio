import { mkdir, open, lstat, readFile, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = resolve(process.argv[2] || join(root, '.studio/deploy/secrets'));
await mkdir(directory, { recursive: true, mode: 0o700 });
if (!(await lstat(directory)).isDirectory()) throw new Error('Secrets directory must be an ordinary directory.');
await chmod(directory, 0o700);
for (const [name, content] of [
  ['mock-seat-token', randomBytes(32).toString('base64url') + '\n'],
  ['provider.env', '# Optional provider credentials for the official home .env layer.\n'],
]) {
  const path = join(directory, name);
  try { const file = await open(path, 'wx', 0o600); try { await file.writeFile(content); await file.sync(); } finally { await file.close(); } }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) throw new Error('Invalid existing secret file.');
    if (name === 'mock-seat-token' && !/^[A-Za-z0-9_-]{40,128}$/u.test((await readFile(path, 'utf8')).trim())) throw new Error('Invalid existing Mock Seat credential.');
    await chmod(path, 0o600);
  }
}
console.log(`Deployment secret files ready in ${directory}; existing credentials preserved. No values printed.`);
