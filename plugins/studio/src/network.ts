import type { Context } from '@deepseek-ai/cordis';
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import z from '@deepseek-ai/schemastery';

export const name = 'harnessstudio-system-proxy';
export const inject: string[] = [];
export interface Config { pollIntervalMs: number }
export const Config: z<Config> = z.object({ pollIntervalMs: z.natural().min(1000).default(5000) });

type Environment = Readonly<Record<string, string | undefined>>;
type Disposer = () => Promise<void>;
export interface NetworkResolution { env: Environment; status: string; messages?: readonly string[] }
export interface ProxyRuntimeOptions {
  read(): Promise<NetworkResolution>;
  install(env: Environment): Promise<Disposer>;
  warn(message: string): void;
  pollIntervalMs?: number;
  readTimeoutMs?: number;
  schedule?(callback: () => void, delay: number): () => void;
}

const PROXY_NAMES = ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY', 'no_proxy', 'NO_PROXY'] as const;
const ROUTE_NAMES = PROXY_NAMES.filter(name => name.toUpperCase() !== 'NO_PROXY');
const LOOPBACK = 'localhost,127.0.0.1,::1,[::1]';
const FAILURE_WARNING = '[Studio network] Could not read a valid system proxy configuration; the last known routing remains active.';
const STOP_WARNING = '[Studio network] Explicit proxy configuration now takes precedence. Automatic synchronization stopped; restart Studio to load the new configuration.';

function proxyEnvironment(env: Environment): Record<string, string | undefined> {
  return Object.fromEntries(PROXY_NAMES.map(name => [name, env[name]]));
}
function defaultSchedule(callback: () => void, delay: number): () => void {
  const timer = setTimeout(callback, delay); timer.unref();
  return () => clearTimeout(timer);
}

/** Own one native policy layer. Reads and replacements are serialized; old agents drain separately. */
export function createProxyRuntime(options: ProxyRuntimeOptions) {
  const schedule = options.schedule ?? defaultSchedule;
  const draining = new Set<Promise<void>>();
  let release: Disposer | undefined;
  let lastEnvironment: Environment | undefined;
  let lastKey: string | undefined;
  let pending: Promise<void> | undefined;
  let reading: Promise<NetworkResolution> | undefined;
  let cancelTimer: (() => void) | undefined;
  let started = false;
  let closed = false;
  let stopped = false;
  let disposal: Promise<void> | undefined;
  let warned = false;
  function warnOnce(message: string) { if (!warned) { warned = true; options.warn(message); } }
  function drainCurrent() {
    const dispose = release; release = undefined;
    if (!dispose) return;
    // Native disposal restores its parent before its first await. Do not wait for ongoing
    // HTTP requests to drain before installing the next layer, or a proxy switch can stall.
    let closing: Promise<void>;
    try { closing = dispose(); }
    catch { warnOnce('[Studio network] A previous proxy transport did not close cleanly.'); return; }
    const tracked = Promise.resolve(closing).catch(() => {
      warnOnce('[Studio network] A previous proxy transport did not close cleanly.');
    });
    draining.add(tracked);
    void tracked.then(() => draining.delete(tracked));
  }
  async function readBounded(): Promise<NetworkResolution> {
    // A timeout does not cancel an injected reader. Its late answer is ignored and
    // the next poll waits until it settles, preventing overlapping OS queries.
    if (reading) throw new Error('Previous system proxy query is still finishing.');
    const raw = Promise.resolve().then(() => options.read());
    reading = raw;
    void raw.then(() => { if (reading === raw) reading = undefined; }, () => { if (reading === raw) reading = undefined; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        raw,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('System proxy query timed out.')), options.readTimeoutMs ?? 2000);
          timer.unref();
        }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }
  async function update() {
    let resolved: NetworkResolution;
    try { resolved = await readBounded(); }
    catch { if (!closed) warnOnce(FAILURE_WARNING); return; }
    if (closed || stopped) return;
    if (['disabled', 'unsupported-platform', 'explicit-env', 'explicit-home'].includes(resolved.status)) {
      stopped = true; cancelTimer?.(); cancelTimer = undefined;
      warnOnce(STOP_WARNING); return;
    }
    // Unsupported manual settings are not an instruction to silently replace a working
    // proxy with direct routing. Only a successful, explicitly disabled OS setting is.
    if (resolved.status !== 'system' && resolved.status !== 'none') { warnOnce(FAILURE_WARNING); return; }
    const env = proxyEnvironment(resolved.env);
    const key = JSON.stringify(PROXY_NAMES.map(name => env[name] ?? null));
    warned = false;
    if (key === lastKey && release) return;
    drainCurrent();
    try {
      const installed = await options.install(env);
      release = installed;
      if (closed) { drainCurrent(); return; }
      lastEnvironment = env; lastKey = key;
    } catch {
      warnOnce('[Studio network] Could not apply the new proxy policy; retaining the last known routing when available.');
      // Installation owns the dispatcher, so restore the preceding good layer rather
      // than claiming a failed replacement was applied. A later poll retries it.
      if (!closed && lastEnvironment) {
        try { release = await options.install(lastEnvironment); if (closed) drainCurrent(); }
        catch { warnOnce('[Studio network] Could not restore the previous proxy policy.'); }
      }
    }
  }
  function arm() {
    if (!started || closed || stopped || cancelTimer) return;
    cancelTimer = schedule(() => { cancelTimer = undefined; void refresh(); }, options.pollIntervalMs ?? 5000);
  }
  function refresh(): Promise<void> {
    if (closed || stopped) return Promise.resolve();
    if (pending) return pending;
    const operation = update();
    pending = operation.finally(() => { pending = undefined; arm(); });
    return pending;
  }
  async function start() { if (closed || started) return; started = true; await refresh(); }
  function dispose(): Promise<void> {
    if (disposal) return disposal;
    closed = true; cancelTimer?.(); cancelTimer = undefined;
    disposal = (async () => { await pending; drainCurrent(); await Promise.all([...draining]); })();
    return disposal;
  }
  return { start, refresh, dispose };
}

/** Direct native layers route fetch correctly but restore the launcher's inherited proxy
 * variables. Clear those automatic values for subprocesses too, restoring them on disposal. */
export async function installManagedProxy(env: Environment, report: (message: string) => void): Promise<Disposer> {
  const previous = proxyEnvironment(process.env);
  let nativeDispose: Disposer;
  try {
    nativeDispose = await installProxyFromEnvironment({ get: name => env[name] === undefined ? undefined : { value: env[name]! } }, report);
  } catch (error) {
    for (const name of PROXY_NAMES) previous[name] === undefined ? delete process.env[name] : process.env[name] = previous[name];
    throw error;
  }
  if (ROUTE_NAMES.some(name => env[name] !== undefined && env[name] !== '')) return nativeDispose;
  for (const name of ROUTE_NAMES) delete process.env[name];
  const noProxy = [env.no_proxy ?? env.NO_PROXY, LOOPBACK].filter(Boolean).join(',');
  process.env.no_proxy = process.env.NO_PROXY = [...new Set(noProxy.split(',').map(value => value.trim()).filter(Boolean))].join(',');
  return () => {
    const closing = nativeDispose();
    // Restore synchronously, while this is still the top layer; closing may take time.
    for (const name of PROXY_NAMES) previous[name] === undefined ? delete process.env[name] : process.env[name] = previous[name];
    return closing;
  };
}

interface NetworkHelper {
  resolveNetworkEnvironment(options: { env: Environment; home?: string }): Promise<NetworkResolution>;
}

/** The launcher marks only genuinely automatic candidates. Explicit user routes stay native. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const launch = launchEnvironmentOf(ctx);
  if (launch.get('STUDIO_SYSTEM_PROXY_MANAGED')?.value !== '1') return;
  // A project .env belongs to the user too; the startup bridge only examines the home.
  if (ROUTE_NAMES.some(name => launch.getFrom(name, ['project-env', 'user-env']) !== undefined)) return;
  let baseline: Record<string, string | undefined> = { STUDIO_SYSTEM_PROXY: '1' };
  try {
    const raw = launch.get('STUDIO_SYSTEM_PROXY_NO_PROXY_BASELINE')?.value;
    if (raw === undefined || raw.length > 32768) throw new Error('Invalid automatic proxy baseline.');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid automatic proxy baseline.');
    for (const [name, value] of Object.entries(parsed)) {
      if (!['NO_PROXY', 'no_proxy'].includes(name) || typeof value !== 'string') throw new Error('Invalid automatic proxy baseline.');
      baseline[name] = value;
    }
    if (baseline.NO_PROXY === undefined && baseline.no_proxy === undefined) {
      for (const name of ['NO_PROXY', 'no_proxy']) {
        const value = launch.getFrom(name, ['project-env', 'user-env'])?.value;
        if (value !== undefined) baseline[name] = value;
      }
    }
  } catch { ctx.logger.warn('[Studio network] Automatic proxy baseline was invalid; runtime synchronization was skipped.'); return; }
  const helper = await import(new URL('../../../scripts/network-env.mjs', import.meta.url).href) as NetworkHelper;
  const runtime = createProxyRuntime({
    read: () => helper.resolveNetworkEnvironment({ env: baseline, home: launch.get('DSH_HOME')?.value }),
    install: env => installManagedProxy(env, message => ctx.logger.warn(message)),
    warn: message => ctx.logger.warn(message),
    pollIntervalMs: config.pollIntervalMs,
  });
  ctx.effect(() => () => runtime.dispose(), 'studio-network: system proxy routing');
  await runtime.start();
}
