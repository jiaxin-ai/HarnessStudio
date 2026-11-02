import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { root } from './prepare.mjs';
export async function startApp(home, workflowMode = 'single-user') {
  const child = spawn(process.execPath, [join(root, 'scripts/start.mjs')], { cwd: root, env: { ...process.env, STUDIO_HOME: home, STUDIO_PORT: '0', STUDIO_SMOKE: '1', STUDIO_WORKFLOW_MODE: workflowMode }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { output += value; });
  let url; const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { url = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/)/)?.[1]; if (url) break; if (child.exitCode !== null) break; await delay(50); }
  if (!url) { await stopApp(child); throw new Error(`DSH startup failed: ${output.replace(/token=[^\s]+/g, 'token=[redacted]')}`); }
  const base = new URL(url).origin;
  async function call(path, body) { return fetch(`${base}/api/studio/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { origin: base, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
  async function json(path, body) { const response = await call(path, body), source = await response.text(); assert.equal(response.status, 200, `${path}: ${source}`); return JSON.parse(source); }
  // The HTTP listener announces its URL before every plugin has registered its
  // routes. Wait on a read-only Studio route before sending fixture mutations.
  let ready = false;
  const routeDeadline = Date.now() + 20000;
  while (Date.now() < routeDeadline && child.exitCode === null) {
    if ((await call('projects')).status === 200) { ready = true; break; }
    await delay(50);
  }
  if (!ready) { await stopApp(child); throw new Error(`Studio routes were not ready: ${output.replace(/token=[^\s]+/g, 'token=[redacted]')}`); }
  const page = await fetch(url, { redirect: 'manual' });
  assert.equal(page.status, 200, 'Studio index must be usable without a token or Cookie');
  assert.deepEqual(page.headers.getSetCookie(), [], 'Anonymous Studio must not require or create a browser identity cookie');
  return { child, base, url, call, json };
}
export async function stopApp(child) {
  if (child.exitCode !== null) return;
  const ended = new Promise(resolve => child.once('close', resolve)); child.kill('SIGTERM');
  if (!await Promise.race([ended.then(() => true), delay(10000, false, { ref: false })])) { child.kill('SIGKILL'); await ended; throw new Error('DSH shutdown failed'); }
}
export async function finishedChat(app, id) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { const value = await app.json(`chat?id=${id}`); if (value.status === 'idle' && value.events.some(event => event.type === 'turn/end')) return value; await delay(70); }
  throw new Error('Agent did not finish the controlled test');
}
