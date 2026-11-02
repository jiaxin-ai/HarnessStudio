import { spawn } from 'node:child_process';
import { mkdir, open, readFile, writeFile, lstat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { root } from './prepare.mjs';

/** Compose two independent processes. No platform implementation is imported by Studio. */
export async function startMockSeat(home, env = process.env) {
  const directory = join(home, 'mock-seat'); await mkdir(directory, { recursive: true, mode: 0o700 });
  const tokenPath = join(directory, 'token');
  let token;
  try { const file = await open(tokenPath, 'wx', 0o600); try { token = randomBytes(32).toString('base64url'); await file.writeFile(token + '\n'); await file.sync(); } finally { await file.close(); } }
  catch (error) { if (error.code !== 'EEXIST') throw error; if (!(await lstat(tokenPath)).isFile() || (await lstat(tokenPath)).isSymbolicLink()) throw new Error('Invalid Mock Seat credential file'); token = (await readFile(tokenPath, 'utf8')).trim(); }
  if (!/^[A-Za-z0-9_-]{40,128}$/.test(token)) throw new Error('Invalid Mock Seat credential');
  const child = spawn(process.execPath, [join(root, 'apps/mock-seat/lib/cli.js')], { cwd: root, env: { ...env, STUDIO_MOCK_SEAT_ROOT: join(directory, 'data'), STUDIO_MOCK_SEAT_TOKEN: token, STUDIO_MOCK_SEAT_HOST: '127.0.0.1', STUDIO_MOCK_SEAT_PORT: env.STUDIO_MOCK_SEAT_PORT || '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', chunk => { output = (output + chunk).slice(-8192); });
  child.stderr.on('data', () => { /* subprocess diagnostics cannot accidentally expose inherited secrets */ });
  let processError; child.on('error', error => { processError = error; });
  const deadline = Date.now() + 10000; let url;
  while (Date.now() < deadline && child.exitCode === null && !processError) { url = output.match(/Mock Seat ready at (http:\/\/127\.0\.0\.1:\d+)/)?.[1]; if (url) break; await delay(25); }
  if (!url) { child.kill('SIGTERM'); throw new Error('独立 Mock 软件平台启动失败；请检查编译结果、端口或数据目录'); }
  await writeFile(join(directory, 'runtime.json'), JSON.stringify({ url }) + '\n', { mode: 0o600 });
  return { child, url, token, async stop() { if (child.exitCode !== null) return; const ended = new Promise(resolve => child.once('close', resolve)); child.kill('SIGTERM'); if (!await Promise.race([ended.then(() => true), delay(5000, false, { ref: false })])) { child.kill('SIGKILL'); await ended; } } };
}
