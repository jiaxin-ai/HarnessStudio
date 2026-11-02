import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import WebRuntime, { WebError } from '@deepseek-ai/dsh-web';
import { formatFetchOutput } from '@deepseek-ai/dsh-tool-web';
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy';
import { StudioHttpFetchProvider } from '../plugins/studio/lib/web-fetch.js';
import { resolveNetworkEnvironment } from './network-env.mjs';

const limits = { maxResponseBytes: 20 * 1024 * 1024, maxBodyChars: 100_000, timeoutMs: 45_000,
  maxRedirects: 5, userAgent: 'HarnessStudio-PDF-check/1.0', maxPdfPages: 80, pdfTimeoutMs: 15_000 };
const lookup = env => ({ get: name => env[name] === undefined ? undefined : { value: env[name] } });

async function withWeb(env, resolve, action, overrides = {}) {
  const dispose = await installProxyFromEnvironment(lookup(env), () => {});
  const ctx = new Context();
  try {
    await ctx.plugin(WebRuntime, { fetchProvider: 'studio-http' });
    ctx.web.registerFetchProvider(new StudioHttpFetchProvider({ ...limits, ...overrides }, resolve));
    return await action(ctx.web);
  } finally {
    try { await ctx.fiber.dispose(); } finally { await dispose(); }
  }
}

/** Complete, selectable two-page PDF with a real xref table and distinct page text. */
function twoPagePdf() {
  const streams = ['HarnessStudio PDF first page: design interface', 'HarnessStudio PDF second page: acceptance checklist']
    .map(line => `BT /F1 12 Tf 20 180 Td (${line}) Tj ET`);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 200] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${streams[0].length} >>\nstream\n${streams[0]}\nendstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 200] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
    `<< /Length ${streams[1].length} >>\nstream\n${streams[1]}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let content = '%PDF-1.7\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(content));
    content += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(content);
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) content += `${String(offset).padStart(10, '0')} 00000 n \n`;
  content += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(content);
}

function assertPdfText(result) {
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.kind, 'text');
  assert.match(result.body.content, /PDF/i);
  assert.match(result.body.content, /(?:page|页)\s*1/i, 'The extraction identifies page 1');
  assert.ok(result.body.content.trim().length > 100, 'The PDF contains usable extracted body text');
}

const urlOption = process.argv.indexOf('--url');
const specificUrl = urlOption < 0 ? undefined : process.argv[urlOption + 1];
if (urlOption >= 0 && (!process.argv.includes('--live') || !specificUrl || specificUrl.startsWith('--') || process.argv.indexOf('--url', urlOption + 1) >= 0)) {
  throw new Error('Use --live --url <anonymous-public-PDF-URL> to verify one document.');
}

if (process.argv.includes('--live')) {
  // Anonymous public downloads previously encountered in G5quW. No model, chat, home or files are written.
  const network = await resolveNetworkEnvironment({ home: process.env.STUDIO_HOME || fileURLToPath(new URL('../.studio/home', import.meta.url)) });
  if (network.status === 'explicit-home') throw new Error('The service uses explicit Harness-home proxy settings. This anonymous check does not load home credentials; supply the intended proxy in the diagnostic launch environment.');
  console.log(`Studio PDF web check: routing=${network.status}`);
  await withWeb(network.env, undefined, async web => {
    for (const url of specificUrl ? [specificUrl] : [
      'https://www.phoenix-mecano.ch/files/18DAD12F1AD/datasheet-magician-e6-en.pdf',
      'https://static.rapidonline.com/pdf/70-0476_v1.pdf',
      'https://download.dobot.cc/DobotStudio-pro/20231129/manual%20del%20usuario%20%28Robot%20de%20seis%20ejes%29_es.pdf',
    ]) {
      try {
        const result = await web.fetch({ url });
        assertPdfText(result);
        const content = result.body.content;
        const pages = [...content.matchAll(/(?:page|页)\s+(\d+)/gi)].map(match => Number(match[1]));
        const words = specificUrl ? /\.raspberrypi\.com$/i.test(new URL(url).hostname) ? /\b(?:Raspberry|Pi)\b/gi : undefined
          : /\b(?:DOBOT|Magician|robot|robots|mecano|interface|interfaz|usuario)\b/gi;
        const matches = words ? [...new Set(content.match(words) ?? [])].slice(0, 5) : [];
        if (words) assert.ok(matches.length, 'The returned PDF text includes document-specific words');
        console.log(JSON.stringify({ host: new URL(url).hostname, finalURL: result.url, status: result.statusCode,
          pages: pages.length ? Math.max(...pages) : null, characters: content.length, truncated: result.truncated, matchedWords: matches }));
      } catch (error) {
        console.log(JSON.stringify({ host: new URL(url).hostname, code: error.code ?? 'UNKNOWN', message: error.message }));
        process.exitCode = 1;
      }
    }
  });
} else {
  // Also exercises the compiled upstream helper's error identity: it must use native WebError,
  // rather than accidentally bundling a second DSH runtime via upstream tsconfig paths.
  await withWeb({}, undefined, web => assert.rejects(web.fetch({ url: 'http://localhost/two.pdf' }),
    error => error.code === 'WEB_BLOCKED_URL'));
  const pdf = twoPagePdf();
  const requests = [];
  const requestHeaders = [];
  const pending = new Set();
  let onSecondDelayedHop;
  const proxy = createServer((request, response) => {
    requests.push(request.url);
    requestHeaders.push({ url: request.url, headers: { ...request.headers } });
    const target = new URL(request.url, 'http://origin.fixture.invalid'), path = target.pathname;
    const redirect = (location, status = 302) => { response.writeHead(status, { location }); response.end(); };
    if (path === '/same-redirect') {
      response.writeHead(302, { location: '/two.pdf' }); response.end(); return;
    }
    if (path === '/cross-redirect') {
      response.writeHead(302, { location: 'http://other.fixture.invalid/two.pdf', 'set-cookie': 'fixture-cookie=synthetic; Path=/' }); response.end(); return;
    }
    if (path === '/chain/start') { redirect('http://cdn.fixture.invalid/assets/step?seed=alpha%2Bbeta&repeat=1&repeat=2', 301); return; }
    if (path === '/assets/step') {
      redirect(target.searchParams.has('stage') ? '//downloads.fixture.invalid/files/two.pdf?download=1&name=gear%20study' : '?stage=2&file=two.pdf', 307); return;
    }
    const blockedLocations = {
      '/redirect-private': 'http://10.0.0.1/two.pdf', '/redirect-fake-ip': 'http://198.18.1.1/two.pdf',
      '/redirect-loopback': 'http://[::1]/two.pdf', '/redirect-credentials': 'http://fixture-user:fixture-password@other.fixture.invalid/two.pdf',
      '/redirect-scheme': 'file:///tmp/two.pdf', '/redirect-direct-dns': 'http://direct.fixture.invalid/two.pdf',
      '/redirect-oversized': 'http://other.fixture.invalid/oversized.pdf', '/redirect-stream-overflow': 'http://other.fixture.invalid/stream-overflow.pdf',
      '/redirect-text-limit': 'http://other.fixture.invalid/large-text',
    };
    if (blockedLocations[path]) { redirect(blockedLocations[path]); return; }
    if (path === '/missing-location') { response.writeHead(302); response.end(); return; }
    if (path === '/loop') { redirect(`http://${target.hostname === 'origin.fixture.invalid' ? 'other' : 'origin'}.fixture.invalid/loop`); return; }
    if (path === '/large-text') { response.writeHead(200, { 'content-type': 'text/plain' }); response.end('T'.repeat(10_000)); return; }
    if (path === '/delayed-redirect') {
      const hop = Number(target.searchParams.get('hop') ?? 0);
      if (hop === 1) onSecondDelayedHop?.();
      const timer = setTimeout(() => {
        pending.delete(timer);
        if (!response.destroyed) redirect(hop < 3 ? `http://delay${hop + 1}.fixture.invalid/delayed-redirect?hop=${hop + 1}` : 'http://downloads.fixture.invalid/two.pdf');
      }, 80);
      pending.add(timer); response.on('close', () => { clearTimeout(timer); pending.delete(timer); }); return;
    }
    if (path === '/forbidden.pdf') {
      response.writeHead(403, { 'content-type': 'text/html' });
      response.end('<h1>Forbidden</h1><p>Fixture access policy.</p>'); return;
    }
    if (path === '/page') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<h1>HTML fixture</h1><p>Existing HTML extraction remains available.</p>'); return;
    }
    if (path === '/oversized.pdf') {
      response.writeHead(200, { 'content-type': 'application/pdf', 'content-length': '100000' });
      response.end(pdf); return;
    }
    if (path === '/stream-overflow.pdf') {
      response.writeHead(200, { 'content-type': 'application/pdf' });
      response.write(pdf); response.end(Buffer.alloc(8192, 32)); return;
    }
    if (path === '/slow.pdf') {
      const timer = setTimeout(() => {
        pending.delete(timer);
        if (!response.destroyed) { response.writeHead(200, { 'content-type': 'application/pdf' }); response.end(pdf); }
      }, 750);
      pending.add(timer);
      response.on('close', () => { clearTimeout(timer); pending.delete(timer); });
      return;
    }
    response.writeHead(200, { 'content-type': path === '/mislabel.pdf' ? 'application/octet-stream' : 'application/pdf' });
    response.end(pdf);
  });
  await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve); });
  try {
    const port = proxy.address().port;
    const env = { HTTP_PROXY: `http://127.0.0.1:${port}`, HTTPS_PROXY: `http://127.0.0.1:${port}`, NO_PROXY: '' };
    let resolutions = 0;
    const resolvedHosts = [];
    const fakeIpBlocked = async host => { resolutions++; resolvedHosts.push(host); throw new WebError('Fixture hostname resolves to a non-public IP address', 'WEB_BLOCKED_URL'); };
    await withWeb(env, fakeIpBlocked, async web => {
      for (const path of ['/two.pdf', '/mislabel.pdf', '/same-redirect']) {
        const result = await web.fetch({ url: `http://origin.fixture.invalid${path}` });
        assertPdfText(result);
        assert.match(result.body.content, /(?:page|页)\s*2/i);
        assert.match(result.body.content, /first page: design interface/);
        assert.match(result.body.content, /second page: acceptance checklist/);
        assert.match(formatFetchOutput(result, 200_000), /acceptance checklist/);
        assert.equal(result.truncated, false);
      }
      assert.equal(resolutions, 0, 'Public hostnames are resolved by the active proxy');
      const page = await web.fetch({ url: 'http://origin.fixture.invalid/page' });
      assert.equal(page.body.kind, 'html');
      assert.match(formatFetchOutput(page, 200_000), /Existing HTML extraction remains available/);
      const forbidden = await web.fetch({ url: 'http://origin.fixture.invalid/forbidden.pdf' });
      assert.equal(forbidden.statusCode, 403);
      assert.equal(forbidden.body.kind, 'html', 'A .pdf URL may return an HTML error page');
      assert.match(formatFetchOutput(forbidden, 200_000), /Fixture access policy/);
      const beforeCross = requests.length;
      const cross = await web.fetch({ url: 'http://origin.fixture.invalid/cross-redirect' });
      assertPdfText(cross); assert.equal(cross.url, 'http://other.fixture.invalid/two.pdf');
      const secondRequest = requestHeaders[beforeCross + 1];
      assert.equal(secondRequest.url, 'http://other.fixture.invalid/two.pdf');
      for (const header of ['cookie', 'authorization', 'referer']) assert.equal(secondRequest.headers[header], undefined, `Cross-origin hops remain anonymous: no ${header}`);
      assert.equal(secondRequest.headers['user-agent'], limits.userAgent);
      const beforeChain = requests.length;
      const chain = await web.fetch({ url: 'http://origin.fixture.invalid/chain/start?source=fixture' });
      assertPdfText(chain); assert.equal(chain.url, 'http://downloads.fixture.invalid/files/two.pdf?download=1&name=gear%20study');
      assert.deepEqual(requests.slice(beforeChain), [
        'http://origin.fixture.invalid/chain/start?source=fixture',
        'http://cdn.fixture.invalid/assets/step?seed=alpha%2Bbeta&repeat=1&repeat=2',
        'http://cdn.fixture.invalid/assets/step?stage=2&file=two.pdf',
        'http://downloads.fixture.invalid/files/two.pdf?download=1&name=gear%20study',
      ]);
      for (const [path, code] of [['/redirect-private', 'WEB_BLOCKED_URL'], ['/redirect-fake-ip', 'WEB_BLOCKED_URL'], ['/redirect-loopback', 'WEB_BLOCKED_URL'], ['/redirect-credentials', 'WEB_BLOCKED_URL'], ['/redirect-scheme', 'WEB_INVALID_URL'], ['/missing-location', 'WEB_PROVIDER_ERROR']]) {
        const before = requests.length;
        await assert.rejects(web.fetch({ url: `http://origin.fixture.invalid${path}` }), error => error.code === code);
        assert.deepEqual(requests.slice(before), [`http://origin.fixture.invalid${path}`], 'A rejected redirect target never reaches the proxy');
      }
      const requestCount = requests.length;
      for (const ip of ['10.0.0.1', '198.18.1.1']) {
        await assert.rejects(new StudioHttpFetchProvider(limits).fetch({ url: `http://${ip}/two.pdf` }), error => error.code === 'WEB_BLOCKED_URL');
      }
      assert.equal(requests.length, requestCount, 'Private literals never reach the proxy');
      const abort = new AbortController();
      const stopped = web.fetch({ url: 'http://origin.fixture.invalid/slow.pdf' }, abort.signal);
      const timer = setTimeout(() => abort.abort(), 50);
      try { await assert.rejects(stopped, error => error.code === 'WEB_ABORTED'); } finally { clearTimeout(timer); }
      let secondHop;
      const seen = new Promise(resolve => { secondHop = resolve; });
      onSecondDelayedHop = secondHop;
      const chainAbort = new AbortController();
      const canceledChain = web.fetch({ url: 'http://origin.fixture.invalid/delayed-redirect?hop=0' }, chainAbort.signal);
      void canceledChain.catch(() => {});
      const deadline = setTimeout(() => chainAbort.abort(), 2000);
      try {
        await Promise.race([seen, canceledChain]);
        chainAbort.abort(); await assert.rejects(canceledChain, error => error.code === 'WEB_ABORTED');
      } finally { clearTimeout(deadline); onSecondDelayedHop = undefined; }
    });
    await withWeb(env, fakeIpBlocked, async web => {
      for (const path of ['/oversized.pdf', '/stream-overflow.pdf', '/redirect-oversized', '/redirect-stream-overflow']) {
        await assert.rejects(web.fetch({ url: `http://origin.fixture.invalid${path}` }), error => error.code === 'WEB_FETCH_TOO_LARGE', 'A partial binary PDF must never be parsed or returned as successful text');
      }
    }, { maxResponseBytes: 2048 });
    await withWeb(env, fakeIpBlocked, async web => {
      const result = await web.fetch({ url: 'http://origin.fixture.invalid/redirect-text-limit' });
      assert.equal(result.url, 'http://other.fixture.invalid/large-text');
      assert.equal(result.body.content.length, 64); assert.equal(result.truncated, true);
    }, { maxResponseBytes: 2048, maxBodyChars: 64 });
    await withWeb(env, fakeIpBlocked, async web => {
      const before = requests.length;
      await assert.rejects(web.fetch({ url: 'http://origin.fixture.invalid/loop' }), error => error.code === 'WEB_REDIRECT_BLOCKED');
      assert.equal(requests.length - before, 3, 'A two-hop budget stops a cross-origin loop at the third response');
    }, { maxRedirects: 2 });
    await withWeb(env, fakeIpBlocked, async web => {
      const before = requests.length;
      await assert.rejects(web.fetch({ url: 'http://origin.fixture.invalid/cross-redirect' }), error => error.code === 'WEB_REDIRECT_BLOCKED');
      assert.deepEqual(requests.slice(before), ['http://origin.fixture.invalid/cross-redirect'], 'A zero-hop budget never sends the redirected request');
    }, { maxRedirects: 0 });
    await withWeb({ ...env, NO_PROXY: 'direct.fixture.invalid' }, fakeIpBlocked, async web => {
      const before = requests.length, beforeDns = resolutions;
      await assert.rejects(web.fetch({ url: 'http://origin.fixture.invalid/redirect-direct-dns' }), error => error.code === 'WEB_BLOCKED_URL');
      assert.equal(resolutions, beforeDns + 1); assert.equal(resolvedHosts.at(-1), 'direct.fixture.invalid');
      assert.deepEqual(requests.slice(before), ['http://origin.fixture.invalid/redirect-direct-dns'], 'The next hop recomputes NO_PROXY and fails direct DNS before any request');
    });
    await withWeb(env, fakeIpBlocked, web => assert.rejects(
      web.fetch({ url: 'http://origin.fixture.invalid/slow.pdf' }), error => error.code === 'WEB_FETCH_TIMEOUT'), { timeoutMs: 100 });
    await withWeb(env, fakeIpBlocked, async web => {
      const before = requests.length;
      await assert.rejects(web.fetch({ url: 'http://origin.fixture.invalid/delayed-redirect?hop=0' }), error => error.code === 'WEB_FETCH_TIMEOUT');
      assert.ok(requests.length - before >= 2, 'The shared deadline expires after the redirect chain has progressed');
    }, { timeoutMs: 180 });
    console.log('Studio PDF web verification passed: two-page PDF extraction, cross-origin and relative-query chains/final URL, invalid and private redirect targets blocked before transport, per-hop NO_PROXY DNS, hop cap/loop, bounded final PDF/text bodies, chain cancellation and shared deadline. Isolated proxy fixture; no external network or model.');
  } finally {
    for (const timer of pending) clearTimeout(timer);
    await new Promise(resolve => { proxy.close(resolve); proxy.closeAllConnections(); });
  }
}
