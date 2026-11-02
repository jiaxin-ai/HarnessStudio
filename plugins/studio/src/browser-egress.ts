import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse, type ClientRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { proxyRouteFor } from '@deepseek-ai/dsh-http-proxy';
import { WebError } from '@deepseek-ai/dsh-web';
import { publicHttpNetwork, createPinnedLookup, isNonPublicIpLiteral } from '../../../deepseek-harness/packages/web/web-fetch-http/src/network.ts';
import { validateFetchUrl } from '../../../deepseek-harness/packages/web/web-fetch-http/src/policy.ts';
import type { HttpFetchResolver } from '@deepseek-ai/dsh-web-fetch-http';
import { throwIfAborted } from './abort.ts';

/** All browser connections pass this per-read proxy; Chrome never resolves arbitrary destinations itself. */
export interface BrowserEgress {
  readonly server: string;
  readonly username: string;
  readonly password: string;
  readonly signal: AbortSignal;
  readonly diagnostics: { blockedRequests: number; requests: number; networkBytes: number };
  close(): Promise<void>;
}
export interface BrowserEgressOptions {
  signal: AbortSignal;
  maxNetworkBytes: number;
  maxRequests?: number;
  resolve?: HttpFetchResolver;
}

export function validateBrowserUrl(input: string): URL {
  const url = validateFetchUrl(input);
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (isNonPublicIpLiteral(hostname) || hostname === 'localhost' || hostname.endsWith('.localhost')
    || hostname.endsWith('.local') || hostname.endsWith('.internal') || (!hostname.includes('.') && !hostname.includes(':'))) {
    throw new WebError('browser URL is not a public Internet destination', 'WEB_BLOCKED_URL');
  }
  if (url.port && !['80', '443'].includes(url.port)) throw new WebError('browser reads support public HTTP(S) ports 80 and 443 only', 'WEB_BLOCKED_URL');
  return url;
}

const hopHeaders = new Set(['connection', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer']);
function headersFor(message: IncomingMessage): Record<string, string | string[]> {
  const blocked = new Set([...hopHeaders, ...(message.headers.connection ?? '').split(',').map(name => name.trim().toLowerCase()), 'authorization']);
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(message.headers)) if (!blocked.has(name) && value !== undefined) result[name] = value;
  return result;
}
function proxyHeaders(proxy: URL, authority: string): Record<string, string> {
  const headers: Record<string, string> = { host: authority };
  if (proxy.username || proxy.password) headers['proxy-authorization'] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`;
  return headers;
}

/** Fresh loopback endpoint, credentials and socket set per read. Direct routes pin validated DNS; configured proxies keep their existing trusted DNS semantics. */
export async function createBrowserEgress(options: BrowserEgressOptions): Promise<BrowserEgress> {
  const failure = new AbortController();
  const signal = AbortSignal.any([options.signal, failure.signal]);
  const username = randomBytes(12).toString('hex'), password = randomBytes(24).toString('hex');
  const expectedAuth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const sockets = new Set<Duplex>(), requests = new Set<ClientRequest>();
  const diagnostics = { blockedRequests: 0, requests: 0, networkBytes: 0 };
  const maxRequests = options.maxRequests ?? 160;
  const resolver = options.resolve ?? publicHttpNetwork.resolve;
  const remember = <T extends Duplex>(socket: T): T => {
    sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); return socket;
  };
  const count = (length: number) => {
    diagnostics.networkBytes += length;
    if (diagnostics.networkBytes > options.maxNetworkBytes) failure.abort(new WebError('browser read exceeded its total network byte limit', 'WEB_FETCH_TOO_LARGE'));
  };
  const guard = (message: IncomingMessage): void => {
    throwIfAborted(signal);
    if (message.headers['proxy-authorization'] !== expectedAuth) throw new WebError('browser proxy authentication required', 'WEB_BROWSER_PROXY_AUTH');
    if (++diagnostics.requests > maxRequests) {
      failure.abort(new WebError('browser read exceeded its request limit', 'WEB_FETCH_TOO_LARGE')); throwIfAborted(signal);
    }
  };
  const denyHttp = (response: ServerResponse, error: unknown) => {
    diagnostics.blockedRequests++; const auth = error instanceof WebError && error.code === 'WEB_BROWSER_PROXY_AUTH';
    if (!response.headersSent) response.writeHead(auth ? 407 : 403, { 'content-type': 'text/plain', connection: 'close', ...(auth ? { 'proxy-authenticate': 'Basic realm="HarnessStudio browser"' } : {}) });
    response.end(error instanceof WebError ? error.message : 'Browser request refused');
  };
  const server = createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 30_000, headersTimeout: 10_000 }, (message, response) => {
    void (async () => {
      guard(message);
      if (message.method !== 'GET' || !message.url || message.headers.upgrade) throw new WebError('browser reads allow GET requests only', 'WEB_BLOCKED_URL');
      const url = validateBrowserUrl(message.url);
      if (url.protocol !== 'http:') throw new WebError('HTTPS browser requests must use a tunnel', 'WEB_BLOCKED_URL');
      const route = proxyRouteFor(url);
      const headers = headersFor(message); headers.host = url.host;
      const target = route.proxied ? new URL(route.proxy) : url;
      if (route.proxied) Object.assign(headers, proxyHeaders(target, url.host));
      const addresses = route.proxied ? undefined : await resolver(url.hostname, signal);
      const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)({
        hostname: target.hostname.replace(/^\[|\]$/g, ''), port: target.port || (target.protocol === 'https:' ? 443 : 80),
        method: 'GET', path: route.proxied ? url.toString() : `${url.pathname}${url.search}`, headers,
        agent: false, signal, ...(addresses ? { lookup: createPinnedLookup(addresses), autoSelectFamily: true } : {}),
      }, upstream => {
        const outgoing: Record<string, string | string[]> = {};
        for (const [key, value] of Object.entries(upstream.headers)) if (value !== undefined && !hopHeaders.has(key)) outgoing[key] = value;
        response.writeHead(upstream.statusCode ?? 502, outgoing);
        upstream.on('data', chunk => count(chunk.length));
        upstream.on('error', () => response.destroy()); upstream.pipe(response);
      });
      requests.add(request); request.once('close', () => requests.delete(request));
      request.on('socket', remember); request.on('error', error => denyHttp(response, error));
      message.on('data', chunk => count(chunk.length)); request.end();
    })().catch(error => denyHttp(response, error));
  });
  server.on('connection', remember);
  server.on('connect', (message, rawClient, head) => {
    const client = remember(rawClient);
    void (async () => {
      guard(message);
      const url = validateBrowserUrl(`https://${message.url ?? ''}/`);
      // CONNECT is a TLS tunnel only. The browser's route hook also checks each full URL and redirect.
      if (url.port && url.port !== '443') throw new WebError('browser TLS tunnels support port 443 only', 'WEB_BLOCKED_URL');
      const route = proxyRouteFor(url);
      let upstream: Socket;
      if (route.proxied) {
        const proxy = new URL(route.proxy);
        upstream = await new Promise<Socket>((resolve, reject) => {
          const request = (proxy.protocol === 'https:' ? httpsRequest : httpRequest)({
            hostname: proxy.hostname.replace(/^\[|\]$/g, ''), port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80),
            method: 'CONNECT', path: `${url.hostname}:443`,
            headers: proxyHeaders(proxy, url.host), agent: false, signal,
          });
          requests.add(request); request.once('close', () => requests.delete(request)); request.on('socket', remember);
          request.once('connect', (response, socket, extra) => {
            remember(socket);
            if (response.statusCode !== 200) { socket.destroy(); reject(new WebError(`configured proxy refused browser tunnel (HTTP ${response.statusCode})`, 'WEB_PROVIDER_ERROR')); return; }
            if (extra.length) socket.unshift(extra);
            resolve(socket);
          });
          request.once('error', reject); request.end();
        });
      } else {
        const addresses = await resolver(url.hostname, signal);
        upstream = await new Promise<Socket>((resolve, reject) => {
          const socket = remember(connect({ host: url.hostname.replace(/^\[|\]$/g, ''), port: 443,
            lookup: createPinnedLookup(addresses), autoSelectFamily: true, signal }));
          socket.once('connect', () => resolve(socket)); socket.once('error', reject);
        });
      }
      if (signal.aborted || client.destroyed) { upstream.destroy(); return; }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) { count(head.length); upstream.write(head); }
      client.on('data', data => count(data.length)); upstream.on('data', data => count(data.length));
      client.pipe(upstream); upstream.pipe(client);
      client.once('close', () => upstream.destroy()); upstream.once('close', () => client.destroy());
    })().catch(error => {
      diagnostics.blockedRequests++;
      if (!client.destroyed) { const auth = error instanceof WebError && error.code === 'WEB_BROWSER_PROXY_AUTH';
        client.end(auth ? 'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="HarnessStudio browser"\r\nConnection: close\r\nContent-Length: 0\r\n\r\n' : 'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); }
    });
  });
  server.on('upgrade', (_message, socket) => socket.destroy());
  let closed = false;
  const onAbort = () => { for (const request of requests) request.destroy(); for (const socket of sockets) socket.destroy(); };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    throwIfAborted(signal);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    throwIfAborted(signal);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('browser proxy failed to listen');
    return { server: `http://127.0.0.1:${address.port}`, username, password, signal, diagnostics,
      async close() {
        if (closed) return; closed = true; signal.removeEventListener('abort', onAbort); onAbort();
        await new Promise<void>(resolve => server.close(() => resolve()));
      } };
  } catch (error) {
    signal.removeEventListener('abort', onAbort); onAbort(); server.close(); throw error;
  }
}
