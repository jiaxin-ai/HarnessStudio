import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import WebRuntime, { WebError } from '@deepseek-ai/dsh-web';
import { HttpFetchProvider } from '@deepseek-ai/dsh-web-fetch-http';
import { formatFetchOutput } from '@deepseek-ai/dsh-tool-web';
import { installProxyFromEnvironment, proxyRouteFor } from '@deepseek-ai/dsh-http-proxy';
import { resolveNetworkEnvironment } from './network-env.mjs';

const limits = { maxResponseBytes: 5_000_000, maxBodyChars: 100_000, timeoutMs: 25_000, maxRedirects: 5, userAgent: 'HarnessStudio-network-check/1.0' };
const lookup = env => ({ get: name => env[name] === undefined ? undefined : { value: env[name] } });
const blocked = error => error.code === 'WEB_BLOCKED_URL';

async function withWeb(env, resolve, action) {
  const dispose = await installProxyFromEnvironment(lookup(env), () => {});
  const ctx = new Context();
  try {
    await ctx.plugin(WebRuntime, { fetchProvider: 'http' });
    ctx.web.registerFetchProvider(new HttpFetchProvider(limits, resolve));
    return await action(ctx.web);
  } finally {
    try { await ctx.fiber.dispose(); } finally { await dispose(); }
  }
}

if (process.argv.includes('--live')) {
  // Public URLs already attempted in G5quW. No conversation, LLM, credentials or writes.
  const network = await resolveNetworkEnvironment({ home: process.env.STUDIO_HOME || fileURLToPath(new URL('../.studio/home', import.meta.url)) });
  if (network.status === 'explicit-home') throw new Error('The service uses explicit Harness-home proxy settings. This standalone anonymous check does not load home credentials; supply the intended proxy in the diagnostic launch environment.');
  console.log(`Native web network check: routing=${network.status}`);
  await withWeb(network.env, undefined, async web => {
    for (const url of [
      'https://raw.githubusercontent.com/xArm-Developer/ufactory_docs/refs/heads/ufactory_doc_850/zhHans/4.robotic_electrical_interface.md',
      'https://www.manualslib.com/manual/3455299/Dobot-Magician-E6.html?page=30',
      'https://techshare.co.jp/faq/dobot/es01.html',
    ]) {
      try {
        const result = await web.fetch({ url });
        console.log(JSON.stringify({ host: new URL(url).hostname, status: result.statusCode, kind: result.body.kind, characters: result.body.content.length, renderedCharacters: formatFetchOutput(result, 200_000).length, truncated: result.truncated }));
      } catch (error) {
        console.log(JSON.stringify({ host: new URL(url).hostname, code: error.code ?? 'UNKNOWN', message: error.message }));
        process.exitCode = 1;
      }
    }
  });
} else {
  const requests = [];
  const proxy = createServer((request, response) => {
    requests.push(request.url);
    if (request.url.endsWith('/redirect')) response.writeHead(302, { location: 'http://other.fixture.invalid/page' });
    else response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<h1>Proxy fixture</h1><p>Native web transport works.</p>');
  });
  const origin = createServer((_request, response) => response.end('LOOPBACK-DIRECT'));
  await Promise.all([proxy, origin].map(server => new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  })));
  try {
    const port = proxy.address().port;
    const network = await resolveNetworkEnvironment({ env: {}, platform: 'darwin', readSystemProxy: async () => `<dictionary> {\n  HTTPEnable : 1\n  HTTPProxy : 127.0.0.1\n  HTTPPort : ${port}\n  HTTPSEnable : 1\n  HTTPSProxy : 127.0.0.1\n  HTTPSPort : ${port}\n}` });
    assert.equal(network.status, 'system');
    let resolutions = 0;
    const fakeIpBlocked = async () => { resolutions++; throw new WebError('Fixture hostname resolves to a non-public IP address', 'WEB_BLOCKED_URL'); };
    await withWeb({}, fakeIpBlocked, web => assert.rejects(web.fetch({ url: 'http://origin.fixture.invalid/page' }), blocked));
    assert.equal(resolutions, 1);
    await withWeb(network.env, fakeIpBlocked, async web => {
      const result = await web.fetch({ url: 'http://origin.fixture.invalid/page' });
      assert.equal(result.statusCode, 200);
      assert.match(formatFetchOutput(result, 200_000), /Native web transport works/);
      assert.equal(resolutions, 1, 'Proxy resolves the public hostname; local Fake-IP resolver is not used');
      assert.deepEqual(requests, ['http://origin.fixture.invalid/page']);
      for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '198.18.1.1']) {
        await assert.rejects(new HttpFetchProvider(limits).fetch({ url: `http://${ip}/` }), blocked);
      }
      assert.equal(requests.length, 1, 'Non-public literals never reach the proxy');
      await assert.rejects(web.fetch({ url: 'http://origin.fixture.invalid/redirect' }), error => error.code === 'WEB_REDIRECT_BLOCKED');
      assert.equal(proxyRouteFor(new URL(`http://127.0.0.1:${origin.address().port}`)).proxied, false);
      assert.equal(await (await fetch(`http://127.0.0.1:${origin.address().port}`)).text(), 'LOOPBACK-DIRECT');
    });
    const disabled = await resolveNetworkEnvironment({ env: {}, platform: 'darwin', readSystemProxy: async () => '<dictionary> {\n  HTTPEnable : 0\n  HTTPSEnable : 0\n}' });
    assert.equal(disabled.status, 'none');
    await withWeb(disabled.env, fakeIpBlocked, async () => {
      assert.equal(proxyRouteFor(new URL('http://origin.fixture.invalid/page')).proxied, false);
      assert.equal(await (await fetch(`http://127.0.0.1:${origin.address().port}`)).text(), 'LOOPBACK-DIRECT');
    });
    console.log('Native web network verification passed: system proxy bridge, public hostname proxy resolution, HTML rendering, private/Fake-IP literal rejection, redirect guard, localhost bypass and disabled direct mode. Isolated local fixture; no external network or model.');
  } finally {
    await Promise.all([proxy, origin].map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
  }
}
