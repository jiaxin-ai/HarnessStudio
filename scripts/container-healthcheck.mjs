import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readSecretFile, loginFilename } from './container-entrypoint.mjs';

export async function containerHealthy(role, env = process.env, fetchRequest = fetch) {
  const signal = AbortSignal.timeout(4000);
  if (role === 'mock-seat') {
    const token = (await readSecretFile(env.STUDIO_MOCK_SEAT_TOKEN_FILE)).trim();
    const url = `http://127.0.0.1:${env.STUDIO_MOCK_SEAT_PORT || 8080}/v1/images`;
    const response = await fetchRequest(url, { signal, headers: { authorization: `Bearer ${token}` }, redirect: 'error' });
    if (!response.ok) return false;
    const value = await response.json();
    return Array.isArray(value.images) && value.images.length > 0;
  }
  if (role !== 'studio') throw new Error('Invalid healthcheck role.');
  const announced = new URL((await readFile(join(env.STUDIO_HOME || '/var/lib/harnessstudio', loginFilename), 'utf8')).trim());
  if (announced.searchParams.has('token') || announced.username || announced.password) return false;
  const base = `http://127.0.0.1:${env.STUDIO_PORT || 3080}`;
  // Health is local, even when the advertised URL points at an external TLS proxy.
  const page = await fetchRequest(`${base}/`, { signal, redirect: 'error' });
  if (page.status !== 200 || page.headers.get('set-cookie') || !page.headers.get('content-type')?.startsWith('text/html')) return false;
  await page.body?.cancel();
  const response = await fetchRequest(`${base}/api/studio/projects`, { signal, headers: { origin: base }, redirect: 'error' });
  return response.ok && Array.isArray(await response.json());
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try { process.exitCode = await containerHealthy(process.argv[2]) ? 0 : 1; }
  catch { process.exitCode = 1; }
}
