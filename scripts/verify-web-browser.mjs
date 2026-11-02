import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, readFile, rm, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy';
import { readBrowserPage, removeBrowserReadArtifact } from '../plugins/studio/lib/browser-reader.js';
import { createBrowserEgress } from '../plugins/studio/lib/browser-egress.js';
import { WebError } from '@deepseek-ai/dsh-web';
import { StudioHttpFetchProvider } from '../plugins/studio/lib/web-fetch.js';
import { resolveNetworkEnvironment } from './network-env.mjs';
const lookup = env => ({ get: name => env[name] === undefined ? undefined : { value: env[name] } });
const limits = { maxResponseBytes: 20 * 1024 * 1024, maxBodyChars: 100000, timeoutMs: 30000, maxRedirects: 5, userAgent: 'HarnessStudio-browser-check/1.0', maxPdfPages: 80, pdfTimeoutMs: 15000 };
const canonical = 'https://community.element14.com/products/raspberry-pi/b/blog/posts/raspberry-pi-5-technical-specifications-and-mechanical-drawings';
if (process.argv.includes('--live')) {
  const network = await resolveNetworkEnvironment({ home: process.env.STUDIO_HOME || join(process.cwd(), '.studio/home') });
  if (network.status === 'explicit-home') throw new Error('Supply the intended proxy in this diagnostic launch environment; do not load private home credentials.');
  const dispose = await installProxyFromEnvironment(lookup(network.env), () => {});
  try {
    const result = await readBrowserPage(canonical);
    assert.equal(result.url, canonical);
    assert.equal(result.blocked, false, `Browser remained blocked: HTTP ${result.statusCode} ${result.title}`);
    assert.match(result.title, /Raspberry Pi 5 Technical Specifications/i);
    assert.match(result.content, /Raspberry Pi 5 Key Features/i);
    assert.ok((await stat(result.artifact.screenshot)).size > 1000);
    console.log(JSON.stringify({ url: result.url, status: result.statusCode, title: result.title, blocked: result.blocked, chars: result.content.length, artifact: result.artifact, diagnostics: result.diagnostics }, null, 2));
  } finally { await dispose(); }
} else {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'studio-browser-fixture-'))), requests = [];
  const timers = new Set();
  const proxy = createServer((request, response) => {
    const url = new URL(request.url), path = url.pathname;
    requests.push({ path, method: request.method, agent: request.headers['user-agent'], cookie: request.headers.cookie });
    if (path === '/download-only') {
      if (!request.headers['user-agent']?.includes('Chrome/')) { response.writeHead(403, { 'content-type': 'text/html' }); response.end('<title>Access Denied</title>Download UA denied'); return; }
    }
    if (path.startsWith('/redirect/')) { const number = Number(path.split('/').at(-1)); response.writeHead(302, { location: `http://browser-fixture.invalid/redirect/${number + 1}` }); response.end(); return; }
    if (path === '/private-redirect') { response.writeHead(302, { location: 'http://127.0.0.1/' }); response.end(); return; }
    if (path === '/slow') { const timer = setTimeout(() => { timers.delete(timer); response.end('late'); }, 5000); timers.add(timer); return; }
    if (path === '/large') { response.writeHead(200, { 'content-type': 'text/html' }); response.end(`<title>Large fixture</title>${'x'.repeat(50000)}`); return; }
    response.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'anonymous=fixture' });
    response.end(`<!doctype html><title>Browser fixture</title><main>Initial HTML</main><script>
      document.querySelector('main').innerText = 'Browser-rendered fixture';
      fetch('/write',{method:'POST',body:'must-not-send'}).catch(()=>{});
      fetch('http://127.0.0.1:53983/private').catch(()=>{});
      const iframe=document.createElement('iframe'); iframe.src='http://browser-fixture.invalid/iframe'; document.body.append(iframe);
      try { new Worker('/worker.js'); } catch {}
      try { new WebSocket('ws://browser-fixture.invalid/socket'); } catch {}
    </script>`);
  });
  await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve); });
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  const dispose = await installProxyFromEnvironment(lookup({ HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, NO_PROXY: '' }), () => {});
  let routingDisposed = false;
  let resolverCalls = 0;
  const fakeIpResolver = async () => { resolverCalls++; throw new Error('Proxy DNS must not be preflighted through local fake-IP DNS'); };
  try {
    const result = await readBrowserPage('http://browser-fixture.invalid/article', { artifactsDirectory: root, timeoutMs: 10000, resolve: fakeIpResolver });
    assert.equal(result.statusCode, 200); assert.equal(result.blocked, false); assert.equal(result.content, 'Browser-rendered fixture');
    assert.equal(requests.find(row => row.path === '/article')?.cookie, undefined);
    assert.match(requests.find(row => row.path === '/article')?.agent ?? '', /Chrome\//);
    assert.doesNotMatch(requests.find(row => row.path === '/article')?.agent ?? '', /HeadlessChrome/);
    assert.equal(resolverCalls, 0); assert.ok((await stat(result.artifact.screenshot)).size > 1000);
    assert.equal((await readFile(result.artifact.metadata, 'utf8')).includes('harnessstudio.browser-read.v1'), true);
    assert.ok(requests.every(row => row.method === 'GET' && !['/write', '/iframe', '/worker.js', '/socket', '/private'].includes(row.path)), 'No write/background/private requests reach the fixture');
    const reader = new StudioHttpFetchProvider({ ...limits, browserFallback: true, browserArtifactsDirectory: root });
    const fallback = await reader.fetch({ url: 'http://browser-fixture.invalid/download-only' });
    assert.equal(fallback.statusCode, 200); assert.match(fallback.body.content, /original HTTP status: 403; browser HTTP status: 200/);
    assert.match(fallback.body.content, /Browser-rendered fixture/);
    assert.ok(requests.filter(row => row.path === '/download-only').every(row => row.cookie === undefined), 'A new read starts without cookies from prior pages');
    const start = requests.length;
    await assert.rejects(readBrowserPage('http://browser-fixture.invalid/redirect/0', { artifactsDirectory: root, timeoutMs: 10000, maxRedirects: 2 }), error => error.code === 'WEB_BROWSER_ERROR');
    assert.deepEqual(requests.slice(start).map(row => row.path), ['/redirect/0', '/redirect/1', '/redirect/2'], 'Every redirect is paused before network dispatch');
    await assert.rejects(readBrowserPage('http://browser-fixture.invalid/private-redirect', { artifactsDirectory: root, timeoutMs: 10000 }), error => error.code === 'WEB_BROWSER_ERROR');
    await assert.rejects(readBrowserPage('http://browser-fixture.invalid/large', { artifactsDirectory: root, timeoutMs: 10000, maxNetworkBytes: 1024 }), error => error.code === 'WEB_FETCH_TOO_LARGE');
    await assert.rejects(readBrowserPage('http://browser-fixture.invalid/slow', { artifactsDirectory: root, timeoutMs: 300 }), error => error.code === 'WEB_BROWSER_TIMEOUT');
    const cancellation = new AbortController(); setTimeout(() => cancellation.abort(), 200);
    await assert.rejects(readBrowserPage('http://browser-fixture.invalid/slow', { artifactsDirectory: root, timeoutMs: 10000 }, cancellation.signal), error => error.code === 'WEB_ABORTED');
    // Test direct routing separately: a hostname resolving privately must never reach a socket.
    await dispose(); routingDisposed = true;
    const disposeDirect = await installProxyFromEnvironment(lookup({}), () => {});
    let directResolutions = 0;
    const egress = await createBrowserEgress({ signal: new AbortController().signal, maxNetworkBytes: 4096,
      resolve: async () => { directResolutions++; throw new WebError('hostname resolves to non-public IP', 'WEB_BLOCKED_URL'); } });
    const proxyRequest = (url, auth = true, method = 'GET') => new Promise((resolve, reject) => {
      const target = new URL(egress.server);
      const request = httpRequest({ hostname: target.hostname, port: target.port, path: url, method,
        headers: auth ? { 'proxy-authorization': `Basic ${Buffer.from(`${egress.username}:${egress.password}`).toString('base64')}` } : {} }, response => {
          response.resume(); response.once('end', () => resolve(response.statusCode)); });
      request.once('error', reject); request.end();
    });
    try {
      assert.equal(await proxyRequest('http://public-fixture.invalid/', false), 407);
      assert.equal(directResolutions, 0);
      assert.equal(await proxyRequest('http://127.0.0.1/'), 403);
      assert.equal(await proxyRequest('http://public-fixture.invalid/', true, 'POST'), 403);
      assert.equal(directResolutions, 0);
      assert.equal(await proxyRequest('http://public-fixture.invalid/'), 403);
      assert.equal(directResolutions, 1, 'Direct hostname is checked exactly once before any connection');
    } finally { await egress.close(); await disposeDirect(); }
    await removeBrowserReadArtifact(result.artifact.id, root);
    console.log('Browser fixture passed: real Chrome JavaScript+screenshot, HTTP403 automatic fallback, isolated cookies, proxy-DNS routing, forbidden actions/private redirects, exact redirect cap, bytes/timeout/abort, artifact teardown.');
  } finally { for (const timer of timers) clearTimeout(timer); if (!routingDisposed) await dispose(); proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); await rm(root, { recursive: true, force: true }); }
}
