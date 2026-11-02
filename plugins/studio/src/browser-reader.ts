import { access, constants, lstat, mkdir, open, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebError } from '@deepseek-ai/dsh-web';
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout';
import type { Browser, BrowserContext, Page, Request } from 'playwright-core';
import { createBrowserEgress, validateBrowserUrl, type BrowserEgressOptions } from './browser-egress.ts';
import { abortError, throwIfAborted } from './abort.ts';

export interface BrowserReadOptions {
  executablePath?: string;
  userAgent?: string;
  artifactsDirectory?: string;
  timeoutMs?: number;
  maxBodyChars?: number;
  maxNetworkBytes?: number;
  maxRedirects?: number;
  resolve?: BrowserEgressOptions['resolve'];
}
export interface BrowserReadArtifact {
  id: string;
  directory: string;
  screenshot: string;
  text: string;
  metadata: string;
}
export interface BrowserReadResult {
  method: 'browser';
  requestedUrl: string;
  url: string;
  statusCode: number;
  title: string;
  content: string;
  blocked: boolean;
  truncated: boolean;
  diagnostics: { blockedRequests: number; requests: number; networkBytes: number };
  artifact: BrowserReadArtifact;
}
const artifactFormat = 'harnessstudio.browser-read.v1';
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const screenshotName = 'screenshot.jpg';
const retentionMs = 24 * 60 * 60 * 1000;
const artifactCap = 50;

/** Chrome exposes `HeadlessChrome` by default in automated contexts. Some public
 * sites reject that transport before their page can run even though the same
 * installed browser is allowed. Report the installed Chrome version with its
 * ordinary platform token; this does not reuse a user profile or hide WebDriver. */
export function regularChromeUserAgent(version: string, platform = process.platform): string {
  const match = /(?:^|\/)(\d+)(?:\.\d+){0,3}/.exec(version.trim());
  if (!match) throw new WebError('installed browser version is unavailable', 'WEB_BROWSER_UNAVAILABLE');
  const chrome = `${match[1]}.0.0.0`;
  const system = platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7'
    : platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
}

let activeBrowserReads = 0;
const browserWaiters = new Set<() => void>();
async function acquireBrowserPermit(signal: AbortSignal): Promise<{ [Symbol.dispose](): void }> {
  while (activeBrowserReads >= 2) {
    await new Promise<void>((resolve, reject) => {
      const ready = () => { signal.removeEventListener('abort', aborted); browserWaiters.delete(ready); resolve(); };
      const aborted = () => { signal.removeEventListener('abort', aborted); browserWaiters.delete(ready); reject(abortError(signal)); };
      browserWaiters.add(ready); signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
    });
  }
  throwIfAborted(signal); activeBrowserReads++;
  let disposed = false;
  return { [Symbol.dispose]() { if (disposed) return; disposed = true; activeBrowserReads--; browserWaiters.values().next().value?.(); } };
}

export function isBrowserAccessChallenge(status: number, text: string, title = ''): boolean {
  if (status === 403 || status === 429 || status === 401) return true;
  // A nominally successful navigation with neither a title nor readable body is
  // not a successful page read. WAFs sometimes return this instead of 403 when
  // the HTTP User-Agent looks graphical but the wider browser fingerprint does not.
  if (status >= 200 && status < 300 && !title.trim() && !text.trim()) return true;
  const head = `${title}\n${text.slice(0, 2400)}`;
  return /(?:^|\n|<title[^>]*>)\s*(?:access denied|just a moment|attention required|robot check|security verification)/i.test(head)
    || /(?:verify (?:that )?you (?:are|are a)|checking your browser|enable javascript and cookies to continue|captcha verification required)/i.test(head);
}
export function shouldAttemptBrowserFallback(status: number, body: string): boolean {
  return status === 403 || status === 429 || (status >= 200 && status < 300 && isBrowserAccessChallenge(status, body));
}
async function browserExecutable(configured?: string): Promise<string> {
  const candidates = configured ? [configured] : [process.env.STUDIO_BROWSER_EXECUTABLE, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter((value): value is string => Boolean(value));
  for (const path of candidates) {
    try { await access(path, constants.X_OK); if (!(await lstat(path)).isFile()) continue; return path; } catch { /* try the next installed browser */ }
  }
  throw new WebError('browser reading is unavailable: configure an installed Chrome/Chromium executable', 'WEB_BROWSER_UNAVAILABLE');
}
async function checkedRoot(input?: string): Promise<string> {
  const directory = resolve(input ?? '.studio/browser-reads');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) throw new WebError('browser artifact directory must not use symlinks', 'WEB_BROWSER_ARTIFACT_ERROR');
  return directory;
}
async function saveFile(path: string, content: string | Uint8Array): Promise<void> {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
}
async function ownedArtifact(root: string, id: string): Promise<string | undefined> {
  if (!idPattern.test(id)) throw new WebError('invalid browser artifact ID', 'WEB_BROWSER_ARTIFACT_ERROR');
  const directory = join(root, id);
  try {
    const stats = await lstat(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink() || await realpath(directory) !== directory) return undefined;
    const metadataPath = join(directory, 'metadata.json');
    const metadataStats = await lstat(metadataPath);
    if (!metadataStats.isFile() || metadataStats.isSymbolicLink() || metadataStats.size > 64 * 1024) return undefined;
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    if (metadata.format !== artifactFormat || metadata.id !== id) return undefined;
    return directory;
  } catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined; throw error; }
}
/** Remove only an artifact generated by this reader, never an arbitrary caller path. */
export async function removeBrowserReadArtifact(id: string, artifactsDirectory?: string): Promise<void> {
  const directory = await ownedArtifact(await checkedRoot(artifactsDirectory), id);
  if (directory) await rm(directory, { recursive: true, force: true });
}
export async function getBrowserReadArtifact(id: string, artifactsDirectory?: string): Promise<BrowserReadArtifact | undefined> {
  const directory = await ownedArtifact(await checkedRoot(artifactsDirectory), id);
  if (!directory) return undefined;
  return { id, directory, screenshot: join(directory, screenshotName), text: join(directory, 'page.txt'), metadata: join(directory, 'metadata.json') };
}
async function pruneArtifacts(root: string): Promise<void> {
  const entries: { id: string; time: number }[] = [];
  for (const id of await readdir(root)) {
    if (!idPattern.test(id)) continue;
    const directory = await ownedArtifact(root, id);
    if (directory) { try { entries.push({ id, time: (await lstat(directory)).mtimeMs }); } catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error; } }
  }
  entries.sort((left, right) => right.time - left.time);
  for (let index = 0; index < entries.length; index++) {
    if (Date.now() - entries[index].time > retentionMs || index >= artifactCap - 1) await removeBrowserReadArtifact(entries[index].id, root);
  }
}
export function validateBrowserRequest(request: Request, maxRedirects: number): void {
  if (request.method() !== 'GET') throw new WebError('browser reads do not send form submissions or other write requests', 'WEB_BLOCKED_URL');
  const url = validateBrowserUrl(request.url());
  let previous = request.redirectedFrom(), hops = 0;
  if (previous && new URL(previous.url()).protocol === 'https:' && url.protocol === 'http:') throw new WebError('browser HTTPS-to-HTTP redirect blocked', 'WEB_REDIRECT_BLOCKED');
  while (previous) { if (++hops > maxRedirects) throw new WebError('browser redirect limit exceeded', 'WEB_REDIRECT_BLOCKED'); previous = previous.redirectedFrom(); }
}

/** CDP pauses every redirect hop; Playwright's ordinary route hook skips redirected requests. */
async function installRedirectGuard(context: BrowserContext, page: Page, maxRedirects: number): Promise<void> {
  const session = await context.newCDPSession(page);
  const chains = new Map<string, { url: URL; hops: number }>();
  session.on('Fetch.requestPaused', (event: { requestId: string; redirectedRequestId?: string; request: { url: string; method: string } }) => {
    void (async () => {
      try {
        if (event.request.method !== 'GET') throw new WebError('browser reads allow GET only', 'WEB_BLOCKED_URL');
        const url = validateBrowserUrl(event.request.url);
        const previous = event.redirectedRequestId ? chains.get(event.redirectedRequestId) : undefined;
        if (event.redirectedRequestId && !previous) throw new WebError('browser redirect chain unavailable', 'WEB_REDIRECT_BLOCKED');
        const hops = previous ? previous.hops + 1 : 0;
        if (hops > maxRedirects || (previous?.url.protocol === 'https:' && url.protocol === 'http:')) throw new WebError('browser redirect refused', 'WEB_REDIRECT_BLOCKED');
        if (chains.size >= 500) throw new WebError('browser request limit reached', 'WEB_FETCH_TOO_LARGE');
        chains.set(event.requestId, { url, hops });
        await session.send('Fetch.continueRequest', { requestId: event.requestId });
      } catch { await session.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }).catch(() => {}); }
    })();
  });
  await session.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
}

/** Anonymous real-browser read. Imports/launches Chrome only on an actual read and closes every process/socket after it. */
export async function readBrowserPage(input: string, options: BrowserReadOptions = {}, upstream?: AbortSignal): Promise<BrowserReadResult> {
  const requestedUrl = validateBrowserUrl(input).toString();
  const timeoutMs = Math.min(options.timeoutMs ?? 20_000, 60_000), maxBodyChars = options.maxBodyChars ?? 100_000;
  using timer = deadline(upstream, timeoutMs, 'WEB_BROWSER_TIMEOUT');
  throwIfAborted(timer.signal);
  using permit = await acquireBrowserPermit(timer.signal);
  const executablePath = await browserExecutable(options.executablePath);
  const { chromium } = await import('playwright-core');
  const egress = await createBrowserEgress({ signal: timer.signal, maxNetworkBytes: options.maxNetworkBytes ?? 32 * 1024 * 1024,
    ...(options.resolve ? { resolve: options.resolve } : {}) });
  let browser: Browser | undefined, artifactDirectory: string | undefined;
  const closeOnAbort = () => { void browser?.close().catch(() => {}); };
  egress.signal.addEventListener('abort', closeOnAbort, { once: true });
  try {
    browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true, timeout: timeoutMs,
      proxy: { server: egress.server, username: egress.username, password: egress.password },
      args: ['--proxy-bypass-list=<-loopback>', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--disable-background-networking'],
    });
    throwIfAborted(egress.signal);
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US',
      userAgent: options.userAgent ?? regularChromeUserAgent(browser.version()),
      acceptDownloads: false, serviceWorkers: 'block', ignoreHTTPSErrors: false });
    await context.routeWebSocket('**/*', socket => socket.close());
    // This is a page reader: no worker execution or secondary page/iframe browsing.
    await context.addInitScript(() => {
      const denied = () => { throw new Error('Background workers are disabled in read-only browser pages'); };
      Object.defineProperty(window, 'Worker', { value: denied });
      Object.defineProperty(window, 'SharedWorker', { value: denied });
    });
    await context.route('**/*', async route => {
      try {
        throwIfAborted(egress.signal); validateBrowserRequest(route.request(), options.maxRedirects ?? 5);
        if ((route.request().isNavigationRequest() && route.request().frame().parentFrame()) || ['media', 'font'].includes(route.request().resourceType())) { await route.abort(); return; }
        await route.continue();
      } catch { egress.diagnostics.blockedRequests++; await route.abort().catch(() => {}); }
    });
    const page = await context.newPage();
    await installRedirectGuard(context, page, options.maxRedirects ?? 5);
    context.on('page', other => { if (other !== page) void other.close().catch(() => {}); });
    let statusCode = 0;
    page.on('response', response => {
      if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) statusCode = response.status();
    });
    const started = Date.now();
    await page.goto(requestedUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    // Let public-page JS render, without requiring trackers/long-polling to become idle.
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining > 2000 && statusCode >= 200 && statusCode < 300) await page.waitForLoadState('networkidle', { timeout: Math.min(2000, remaining - 500) }).catch(() => {});
    throwIfAborted(egress.signal);
    const url = validateBrowserUrl(page.url()).toString();
    const title = (await page.title()).slice(0, 512);
    const extracted = await page.evaluate((limit: number) => {
      const element = document.querySelector('article') ?? document.querySelector('main') ?? document.body;
      const text = String((element as HTMLElement | null)?.innerText ?? element?.textContent ?? '').trim();
      return { content: text.slice(0, limit), truncated: text.length > limit };
    }, maxBodyChars);
    const blocked = isBrowserAccessChallenge(statusCode, extracted.content, title);
    const screenshot = await page.screenshot({ type: 'jpeg', quality: 75, fullPage: false, animations: 'disabled', timeout: Math.max(1, timeoutMs - (Date.now() - started)) });
    if (screenshot.byteLength > 4 * 1024 * 1024) throw new WebError('browser screenshot exceeds its size limit', 'WEB_FETCH_TOO_LARGE');
    throwIfAborted(egress.signal);
    const root = await checkedRoot(options.artifactsDirectory);
    await pruneArtifacts(root); throwIfAborted(egress.signal);
    const id = randomUUID(), directory = join(root, id);
    await mkdir(directory, { mode: 0o700 }); artifactDirectory = directory;
    const artifact = { id, directory, screenshot: join(directory, screenshotName), text: join(directory, 'page.txt'), metadata: join(directory, 'metadata.json') };
    const diagnostics = { ...egress.diagnostics };
    await saveFile(artifact.screenshot, screenshot);
    await saveFile(artifact.text, extracted.content);
    await saveFile(artifact.metadata, `${JSON.stringify({ format: artifactFormat, id, createdAt: new Date().toISOString(), requestedUrl, url,
      statusCode, title, blocked, truncated: extracted.truncated, diagnostics, screenshot: screenshotName, text: 'page.txt', retentionHours: 24 }, null, 2)}\n`);
    throwIfAborted(egress.signal);
    artifactDirectory = undefined;
    return { method: 'browser', requestedUrl, url, statusCode, title, content: extracted.content,
      blocked, truncated: extracted.truncated, diagnostics, artifact };
  } catch (error) {
    if (timeoutOf(timer.signal, 'WEB_BROWSER_TIMEOUT')) throw new WebError('browser read timed out', 'WEB_BROWSER_TIMEOUT', { cause: error });
    if (egress.signal.aborted) {
      const reason: unknown = egress.signal.reason;
      if (reason instanceof WebError) throw reason;
      throw new WebError('browser read aborted', 'WEB_ABORTED', { cause: error });
    }
    if (error instanceof WebError) throw error;
    throw new WebError(`browser read failed: ${error instanceof Error ? error.message.slice(0, 500) : String(error)}`, 'WEB_BROWSER_ERROR', { cause: error });
  } finally {
    egress.signal.removeEventListener('abort', closeOnAbort);
    await browser?.close().catch(() => {}); await egress.close();
    if (artifactDirectory) await rm(artifactDirectory, { recursive: true, force: true });
  }
}
