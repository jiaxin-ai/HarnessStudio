/** Third-party tools over MCP: servers added on the page are mounted at runtime through the native MCP client. */
import type { Context, Fiber } from '@deepseek-ai/cordis';
import * as McpClient from '@deepseek-ai/dsh-mcp-client';
import z from '@deepseek-ai/schemastery';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {} from '@deepseek-ai/dsh-tools';

export const name = 'harnessstudio-mcp';
export const inject = ['tools', 'connection'];
export interface Config { dataRoot: string; toolCallTimeoutMs: number }
export const Config: z<Config> = z.object({ dataRoot: z.string().required(), toolCallTimeoutMs: z.natural().min(1000).default(120000) });

// The probe uses the same MCP SDK copy as the native client.
const sdk = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-mcp-client/package.json'))('@modelcontextprotocol/client') as {
  Client: new (info: { name: string; version: string }, options: { capabilities: Record<string, never> }) => { connect(transport: unknown): Promise<void>; listTools(): Promise<{ tools: { name: string; description?: string }[] }>; close(): Promise<void> };
  StreamableHTTPClientTransport: new (url: URL, options: { requestInit: { headers: Record<string, string> } }) => unknown;
};

export interface McpServerSetting { name: string; url: string; headers: Record<string, string>; enabled: boolean; note?: string }
export interface McpTool { name: string; description: string }
export interface McpServerView { name: string; url: string; headerNames: string[]; enabled: boolean; note?: string; state: 'connected' | 'unreachable' | 'disabled'; tools: McpTool[]; error?: string }
export interface McpProbe { ok: boolean; tools: McpTool[]; error?: string }
/** One server of an installed plugin's .mcp.json, resolved by the plugin library; only http servers without a problem are mounted. */
export interface PluginMcpEntry { plugin: string; name: string; enabled: boolean; transport: 'http' | 'stdio' | 'sse' | 'ws' | 'unknown'; url?: string;
  /** The address with sensitive option values masked, when one is part of it. */
  displayUrl?: string; headers?: Record<string, string>; problem?: string }
export interface PluginMcpView { plugin: string; name: string; url?: string; headerNames: string[]; transport: PluginMcpEntry['transport'];
  state: 'connected' | 'unreachable' | 'disabled' | 'unsupported' | 'incomplete' | 'conflict'; tools: McpTool[]; error?: string }
declare module '@deepseek-ai/cordis' { interface Context { studioMcp: McpServers } }

const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
export function validServerName(value: string): string {
  if (!SERVER_NAME.test(value)) throw new Error('名称只能用字母、数字、- 和 _，最多 32 个字符，例如 freecad');
  return value;
}
export function validUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('地址无效，请填完整的 http:// 或 https:// 地址'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('目前只支持 http:// 或 https:// 地址的 MCP 服务');
  if (url.username || url.password) throw new Error('不要把账号密码写进地址，请放在请求头里');
  return url.href;
}
const short = (error: unknown) => {
  const text = error instanceof Error ? `${error.message}${error.cause instanceof Error ? `：${error.cause.message}` : ''}` : String(error);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
};
/** Says what to check for the usual failures and keeps the original error for the person who runs the server. */
export function explain(error: unknown): string {
  const text = short(error);
  if (/\b40[13]\b|unauthori[sz]ed|forbidden/iu.test(text)) return `服务拒绝了请求，请检查请求头里的密钥（${text}）`;
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|ECONNRESET|bad port/iu.test(text)) return `连不上这个地址，请确认服务已经启动、地址和端口正确（${text}）`;
  if (/\b404\b|not found/iu.test(text)) return `这个地址上没有 MCP 服务，请检查路径，通常以 /mcp 结尾（${text}）`;
  return text;
}

/** Connects once, lists the tools and closes, so the page can say whether a server works before and after saving it. */
export async function probe(url: string, headers: Record<string, string>, timeoutMs = 8000): Promise<McpProbe> {
  const client = new sdk.Client({ name: 'harnessstudio-probe', version: '1.0.0' }, { capabilities: {} });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const listed = await Promise.race([
      (async () => { await client.connect(new sdk.StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } })); return client.listTools(); })(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${Math.round(timeoutMs / 1000)} 秒内没有响应`)), timeoutMs); }),
    ]);
    return { ok: true, tools: listed.tools.map(tool => ({ name: tool.name, description: tool.description ?? '' })) };
  } catch (error) { return { ok: false, tools: [], error: explain(error) }; }
  finally { clearTimeout(timer); await client.close().catch(() => undefined); }
}

export class McpServers {
  private readonly path: string;
  private servers: McpServerSetting[] = [];
  private readonly fibers = new Map<string, Fiber>();
  private writes = Promise.resolve();
  private plugins: PluginMcpEntry[] = [];
  /** Mounted plugin servers by name, with the url and headers they were mounted with. */
  private readonly pluginMounted = new Map<string, string>();
  constructor(private readonly ctx: Context, private readonly config: Config, private readonly test: typeof probe = probe) { this.path = resolve(config.dataRoot, 'mcp-servers.json'); }
  async start(): Promise<void> {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8')) as { servers?: McpServerSetting[] };
      this.servers = (value.servers ?? []).filter(row => SERVER_NAME.test(row.name) && typeof row.url === 'string');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (const server of this.servers) if (server.enabled) this.mount(server);
  }
  /** Each enabled server is one native mcp-client instance; it reconnects on its own after an outage. */
  private mount(server: Pick<McpServerSetting, 'name' | 'url' | 'headers'>): void {
    this.unmount(server.name);
    this.fibers.set(server.name, this.ctx.plugin(McpClient, McpClient.Config({ transport: 'streamable-http', serverName: server.name, url: server.url, headers: server.headers,
      toolCallTimeoutMs: this.config.toolCallTimeoutMs, failOnStartupError: false })));
  }
  /**
   * Plugin servers in plugin order: a disabled plugin, a transport other than http or a missing value keeps a server
   * unmounted, and a name already taken by a page server or an earlier plugin server is a conflict, never a replacement.
   */
  private pluginStates(): { entry: PluginMcpEntry; state: 'mount' | 'disabled' | 'unsupported' | 'incomplete' | 'conflict'; error?: string }[] {
    const taken = new Map<string, string>();
    return this.plugins.map(entry => {
      if (!entry.enabled) return { entry, state: 'disabled' as const };
      if (entry.transport !== 'http') return { entry, state: 'unsupported' as const, error: entry.problem ?? '暂不支持' };
      if (entry.problem || !entry.url) return { entry, state: 'incomplete' as const, error: entry.problem ?? '缺少地址' };
      const page = this.servers.find(row => row.name === entry.name), other = taken.get(entry.name);
      if (page || other) return { entry, state: 'conflict' as const, error: page ? `和 MCP 工具页面里的服务 ${entry.name} 同名，没有接入` : `和插件 ${other} 的 MCP 服务同名，没有接入` };
      taken.set(entry.name, entry.plugin);
      return { entry, state: 'mount' as const };
    });
  }
  /** The plugin library pushes every plugin server after each change; only what changed is remounted. */
  async setPluginServers(entries: PluginMcpEntry[]): Promise<void> {
    this.plugins = entries;
    const wanted = new Map(this.pluginStates().filter(row => row.state === 'mount').map(row => [row.entry.name, row.entry]));
    const signature = (entry: PluginMcpEntry) => JSON.stringify([entry.url, entry.headers ?? {}]);
    for (const [name, mounted] of [...this.pluginMounted]) {
      const next = wanted.get(name);
      if (!next || signature(next) !== mounted) { this.unmount(name); this.pluginMounted.delete(name); }
    }
    const started: string[] = [];
    for (const [name, entry] of wanted) if (!this.pluginMounted.has(name)) { this.mount({ name, url: entry.url!, headers: entry.headers ?? {} }); this.pluginMounted.set(name, signature(entry)); started.push(name); }
    await Promise.all(started.map(name => this.fibers.get(name)?.await().catch(() => undefined)));
  }
  async pluginView(): Promise<PluginMcpView[]> {
    return Promise.all(this.pluginStates().map(async ({ entry, state, error }) => {
      const base = { plugin: entry.plugin, name: entry.name, ...(entry.url ? { url: entry.displayUrl ?? entry.url } : {}), headerNames: Object.keys(entry.headers ?? {}), transport: entry.transport };
      if (state !== 'mount') return { ...base, state, tools: [], ...(error ? { error } : {}) };
      const tools = this.tools(entry.name);
      if (tools.length) return { ...base, state: 'connected' as const, tools };
      const result = await this.test(entry.url!, entry.headers ?? {}, 5000);
      return { ...base, state: 'unreachable' as const, tools: [], error: result.ok ? '已连通，但它没有提供工具，或正在重新连接' : result.error ?? '连接失败' };
    }));
  }
  private unmount(name: string): void {
    const fiber = this.fibers.get(name);
    if (fiber) { this.fibers.delete(name); void fiber.dispose(); }
  }
  dispose(): void { for (const name of [...this.fibers.keys()]) this.unmount(name); this.pluginMounted.clear(); }
  /** Tools the Agent sees now from one server, as the native client registered them. */
  tools(name: string): McpTool[] {
    const prefix = `mcp__${name}__`;
    return this.ctx.tools.schemas().filter(tool => tool.name.startsWith(prefix)).map(tool => ({ name: tool.name.slice(prefix.length), description: tool.description ?? '' }));
  }
  async view(): Promise<McpServerView[]> {
    return Promise.all(this.servers.map(async server => {
      const base = { name: server.name, url: server.url, headerNames: Object.keys(server.headers), enabled: server.enabled, ...(server.note ? { note: server.note } : {}) };
      if (!server.enabled) return { ...base, state: 'disabled' as const, tools: [] };
      const tools = this.tools(server.name);
      if (tools.length) return { ...base, state: 'connected' as const, tools };
      const result = await this.test(server.url, server.headers, 5000);
      return { ...base, state: 'unreachable' as const, tools: [], error: result.ok ? '已连通，但它没有提供工具，或正在重新连接' : result.error ?? '连接失败' };
    }));
  }
  private save(): Promise<void> {
    const next = this.writes.then(async () => {
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ servers: this.servers }, null, 2) + '\n', { mode: 0o600 });
      await chmod(temporary, 0o600); await rename(temporary, this.path);
    });
    this.writes = next.catch(() => undefined);
    return next;
  }
  /** Header values are write-only: a blank value keeps the saved one, so secrets never return to the page. */
  headersFor(previous: Record<string, string> | undefined, input: unknown): Record<string, string> {
    if (input === undefined) return previous ?? {};
    if (!Array.isArray(input) || input.length > 20) throw new Error('请求头格式无效');
    const headers: Record<string, string> = {};
    for (const row of input) {
      const item = row as Record<string, unknown>, name = typeof item.name === 'string' ? item.name.trim() : '';
      if (!name) continue;
      if (!HEADER_NAME.test(name)) throw new Error(`请求头名称无效：${name}`);
      const value = typeof item.value === 'string' ? item.value : '';
      if (/[\r\n]/u.test(value)) throw new Error(`请求头 ${name} 的值不能换行`);
      if (/[^\u0000-\u00ff]/u.test(value)) throw new Error(`请求头 ${name} 的值只能用英文字母、数字和符号，HTTP 请求头不支持中文`);
      const kept = value === '' ? Object.entries(previous ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] : undefined;
      if (value === '' && kept === undefined) throw new Error(`请求头 ${name} 还没有填值`);
      headers[name] = value === '' ? kept! : value;
    }
    return headers;
  }
  async upsert(input: Record<string, unknown>): Promise<McpServerView> {
    const original = typeof input.originalName === 'string' ? input.originalName : undefined;
    const previous = original ? this.servers.find(row => row.name === original) : undefined;
    if (original && !previous) throw new Error('这个 MCP 服务已被删除，请刷新');
    const name = validServerName(typeof input.name === 'string' ? input.name.trim() : '');
    if (this.servers.some(row => row.name === name && row !== previous)) throw new Error(`已有名为 ${name} 的 MCP 服务`);
    if (this.pluginMounted.has(name)) throw new Error(`插件 ${this.plugins.find(row => row.name === name)?.plugin ?? ''} 已经提供了名为 ${name} 的 MCP 服务，请换一个名称`);
    const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, 200) : undefined;
    const server: McpServerSetting = { name, url: validUrl(typeof input.url === 'string' ? input.url : ''), headers: this.headersFor(previous?.headers, input.headers),
      enabled: input.enabled === undefined ? previous?.enabled ?? true : input.enabled === true, ...(note ? { note } : {}) };
    if (previous) { this.unmount(previous.name); this.servers = this.servers.map(row => row === previous ? server : row); }
    else this.servers.push(server);
    await this.save();
    if (server.enabled) { this.mount(server); await this.fibers.get(server.name)?.await().catch(() => undefined); }
    if (previous && previous.name !== name) await this.setPluginServers(this.plugins);
    return (await this.view()).find(row => row.name === name)!;
  }
  async toggle(name: string, enabled: boolean): Promise<void> {
    const server = this.servers.find(row => row.name === name);
    if (!server) throw new Error('这个 MCP 服务已被删除，请刷新');
    server.enabled = enabled; await this.save();
    if (enabled) { this.mount(server); await this.fibers.get(name)?.await().catch(() => undefined); } else this.unmount(name);
  }
  async remove(name: string): Promise<void> {
    if (!this.servers.some(row => row.name === name)) throw new Error('这个 MCP 服务已被删除，请刷新');
    this.unmount(name); this.servers = this.servers.filter(row => row.name !== name); await this.save();
    await this.setPluginServers(this.plugins);
  }
  /** Tests a form before saving; a blank header value reuses the saved server's value. */
  async check(input: Record<string, unknown>): Promise<McpProbe> {
    const original = typeof input.originalName === 'string' ? this.servers.find(row => row.name === input.originalName) : undefined;
    return this.test(validUrl(typeof input.url === 'string' ? input.url : ''), this.headersFor(original?.headers, input.headers));
  }
  async reconnect(name: string): Promise<void> {
    const plugin = this.pluginMounted.has(name) ? this.plugins.find(row => row.name === name && row.enabled && row.url) : undefined;
    if (plugin) { this.mount({ name, url: plugin.url!, headers: plugin.headers ?? {} }); await this.fibers.get(name)?.await().catch(() => undefined); return; }
    const server = this.servers.find(row => row.name === name);
    if (!server?.enabled) throw new Error('这个 MCP 服务没有启用');
    this.mount(server); await this.fibers.get(name)?.await().catch(() => undefined);
  }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const servers = new McpServers(ctx, config);
  await servers.start();
  ctx.effect(() => () => servers.dispose(), 'studio-mcp: servers');
  ctx.effect(() => ctx.provide('studioMcp', servers), 'studio-mcp: service');
  const body = async (request: Request) => { const value = await request.json(); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求格式无效'); return value as Record<string, unknown>; };
  const nameOf = (data: Record<string, unknown>) => { if (typeof data.name !== 'string' || !data.name) throw new Error('缺少名称'); return data.name; };
  const routes: [string, ('GET' | 'POST')[], (request: Request) => Promise<unknown>][] = [
    ['/api/studio/mcp', ['GET'], async () => ({ servers: await servers.view(), plugins: await servers.pluginView() })],
    ['/api/studio/mcp/save', ['POST'], async request => servers.upsert(await body(request))],
    ['/api/studio/mcp/test', ['POST'], async request => servers.check(await body(request))],
    ['/api/studio/mcp/toggle', ['POST'], async request => { const data = await body(request); if (typeof data.enabled !== 'boolean') throw new Error('缺少 enabled'); await servers.toggle(nameOf(data), data.enabled); return { saved: true }; }],
    ['/api/studio/mcp/reconnect', ['POST'], async request => { await servers.reconnect(nameOf(await body(request))); return { saved: true }; }],
    ['/api/studio/mcp/delete', ['POST'], async request => { await servers.remove(nameOf(await body(request))); return { deleted: true }; }],
  ];
  for (const [path, methods, action] of routes) ctx.connection.fetch.register({ path, methods, requestBody: 'buffered', async fetch(request) {
    // Like the model settings, server settings stay out of the activity log: header values can be credentials.
    try { return Response.json(await action(request)); }
    catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'MCP 操作失败' }, { status: 400 }); }
  } });
}
