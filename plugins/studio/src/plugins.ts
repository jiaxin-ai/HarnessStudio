/** Plugins in the Claude Code format: one folder bundling skills and HTTP MCP servers, installed once for every project. */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { extractZip } from './chat-zip.ts';
import type { PluginMcpEntry, PluginMcpView } from './mcp.ts';
import type { PluginSkillSource, StudioSkill } from './skills.ts';
import type {} from './domain.ts';

export const name = 'harnessstudio-plugins';
export const inject = ['studioSkills', 'studioMcp', 'studioDomain', 'connection'];
export interface Config { dataRoot: string; pollMs: number }
export const Config: z<Config> = z.object({ dataRoot: z.string().required(), pollMs: z.natural().min(200).default(3000) });

export type ConfigValue = string | number | boolean;
/** One userConfig option of plugin.json; sensitive values never return to the page. */
export interface PluginConfigField {
  key: string; type: 'string' | 'number' | 'boolean'; title: string; description: string; required: boolean; sensitive: boolean;
  options?: string[]; min?: number; max?: number; default?: ConfigValue; set: boolean; value?: ConfigValue;
}
export interface PluginView {
  folder: string; name: string; displayName?: string; description?: string; version?: string; author?: string; homepage?: string;
  enabled: boolean; error?: string; files: number; bytes: number;
  skills: StudioSkill[]; mcp: PluginMcpView[];
  /** Parts of the plugin Studio does not load, in words. */
  unsupported: string[];
  config: PluginConfigField[];
}
interface Manifest {
  name: string; displayName?: string; description?: string; version?: string; author?: string; homepage?: string; defaultEnabled: boolean;
  skills: string[]; mcpServers: unknown[]; fields: PluginConfigField[]; unsupported: string[]; keys: Record<string, unknown>;
}
interface RawServer { name: string; config: unknown }
interface Scanned {
  folder: string; directory: string; manifest?: Manifest; error?: string;
  skills: { folder: string; directory: string; stamp: string }[]; servers: RawServer[]; unsupported: string[]; files: number; bytes: number;
}

export const LIMITS = { files: 2000, bytes: 50 * 1024 * 1024, depth: 16, json: 256 * 1024 };
const PLUGIN_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/u;
const CONFIG_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SKILL_FILE = /^skill\.md$/iu;

export function validPluginName(value: string): string {
  if (value.length > 64 || !PLUGIN_NAME.test(value)) throw new Error(`插件名称“${value || '（空）'}”无效：只能用小写字母、数字和连字符，例如 cad-tools`);
  return value;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const optionalText = (row: Record<string, unknown>, key: string): string | undefined => typeof row[key] === 'string' && row[key].trim() ? row[key].trim().slice(0, 500) : undefined;
const list = (value: unknown): unknown[] => value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];

function configFields(value: unknown): { fields: PluginConfigField[]; unsupported: string[] } {
  if (value === undefined) return { fields: [], unsupported: [] };
  if (!object(value)) throw new Error('plugin.json 里的 userConfig 要写成对象');
  const fields: PluginConfigField[] = [], unsupported: string[] = [];
  for (const [key, raw] of Object.entries(value)) {
    if (!CONFIG_KEY.test(key) || !object(raw)) throw new Error(`plugin.json 里的设置项 ${key} 格式无效`);
    const title = optionalText(raw, 'title') ?? key, type = raw.type;
    if (type !== 'string' && type !== 'number' && type !== 'boolean' || raw.multiple === true) { unsupported.push(`设置项“${title}”（${raw.multiple === true ? '多个值' : String(type)}类型）`); continue; }
    const options = type === 'string' && Array.isArray(raw.options) ? raw.options.filter((item): item is string => typeof item === 'string') : undefined;
    const fallback = typeof raw.default === type ? raw.default as ConfigValue : undefined;
    fields.push({ key, type, title, description: optionalText(raw, 'description') ?? '', required: raw.required === true, sensitive: raw.sensitive === true,
      ...(options?.length ? { options } : {}), ...(typeof raw.min === 'number' ? { min: raw.min } : {}), ...(typeof raw.max === 'number' ? { max: raw.max } : {}),
      ...(fallback !== undefined ? { default: fallback } : {}), set: false });
  }
  return { fields, unsupported };
}

/** plugin.json; without one the folder name is the plugin name, as in Claude Code. Unknown fields are ignored like Claude Code strips them. */
export function parseManifest(text: string | undefined, folder: string): Manifest {
  let row: Record<string, unknown> = {};
  if (text !== undefined) {
    let value: unknown;
    try { value = JSON.parse(text.replace(/^\uFEFF/u, '')); } catch (error) { throw new Error(`.claude-plugin/plugin.json 不是有效的 JSON：${error instanceof Error ? error.message : ''}`); }
    if (!object(value)) throw new Error('.claude-plugin/plugin.json 要写成一个对象');
    row = value;
    if (typeof row.name !== 'string' || !row.name.trim()) throw new Error('.claude-plugin/plugin.json 缺少 name');
  }
  const name = validPluginName(typeof row.name === 'string' ? row.name.trim() : folder);
  const author = typeof row.author === 'string' ? row.author : object(row.author) && typeof row.author.name === 'string' ? row.author.name : undefined;
  const { fields, unsupported } = configFields(row.userConfig);
  const experimental = object(row.experimental) ? row.experimental : {};
  const labels: [unknown, string][] = [[row.commands, '命令（commands）'], [row.agents, '子 Agent（agents）'], [row.hooks, 'Hooks（hooks）'], [row.lspServers, 'LSP 语言服务（lspServers）'],
    [row.outputStyles, '输出风格（outputStyles）'], [row.workflows, '工作流（workflows）'], [row.themes ?? experimental.themes, '主题（themes）'], [row.monitors ?? experimental.monitors, '监视器（monitors）'],
    [row.settings, '默认设置（settings）'], [row.channels, '消息通道（channels）'], [Array.isArray(row.dependencies) && row.dependencies.length ? row.dependencies : undefined, '依赖其他插件（dependencies）']];
  for (const [value, label] of labels) if (value !== undefined && value !== null) unsupported.push(label);
  for (const path of list(row.skills)) if (typeof path !== 'string') throw new Error('plugin.json 里的 skills 要写成路径或路径列表');
  return { name, ...(optionalText(row, 'displayName') ? { displayName: optionalText(row, 'displayName')! } : {}), ...(optionalText(row, 'description') ? { description: optionalText(row, 'description')! } : {}),
    ...(optionalText(row, 'version') ? { version: optionalText(row, 'version')! } : {}), ...(author?.trim() ? { author: author.trim().slice(0, 200) } : {}),
    ...(optionalText(row, 'homepage') ? { homepage: optionalText(row, 'homepage')! } : {}),
    defaultEnabled: row.defaultEnabled !== false, skills: list(row.skills) as string[], mcpServers: list(row.mcpServers), fields, unsupported, keys: row };
}

/** A component path of plugin.json: relative, starting with ./, inside the plugin folder, as Claude Code validates them. */
function componentPath(root: string, value: string, key: string): string {
  if (value !== '.' && !value.startsWith('./')) throw new Error(`plugin.json 里 ${key} 的路径要以 ./ 开头：${value}`);
  const path = resolve(root, value), inside = relative(root, path);
  if (inside.startsWith('..') || resolve(inside) === inside || value.split('/').includes('..')) throw new Error(`plugin.json 里 ${key} 的路径不能指向插件文件夹外面：${value}`);
  return path;
}
async function contained(root: string, path: string): Promise<boolean> {
  const [base, real] = await Promise.all([realpath(root), realpath(path).catch(() => undefined)]);
  return !!real && (real === base || real.startsWith(base + sep));
}
async function jsonFile(path: string, label: string): Promise<unknown> {
  const info = await lstat(path);
  if (!info.isFile()) throw new Error(`${label} 不是普通文件`);
  if (info.size > LIMITS.json) throw new Error(`${label} 超过 256 KB`);
  try { return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/u, '')); } catch (error) { throw new Error(`${label} 不是有效的 JSON：${error instanceof Error ? error.message : ''}`); }
}
/** An MCP config file holds { mcpServers: {...} }; a bare map of servers is read too. */
function serverMap(value: unknown, label: string): RawServer[] {
  if (!object(value)) throw new Error(`${label} 要写成对象`);
  const map = object(value.mcpServers) ? value.mcpServers : value;
  return Object.entries(map).map(([name, config]) => ({ name, config }));
}
async function walk(directory: string, depth = 0): Promise<{ files: number; bytes: number }> {
  let files = 0, bytes = 0;
  if (depth > LIMITS.depth) return { files, bytes };
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (entry.name === '.git') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { const child = await walk(path, depth + 1); files += child.files; bytes += child.bytes; }
    else if (entry.isFile()) { files++; bytes += (await stat(path).catch(() => ({ size: 0 }))).size; }
    if (files > LIMITS.files) break;
  }
  return { files, bytes };
}
const exists = (path: string) => lstat(path).then(() => true, () => false);
async function skillStamp(directory: string): Promise<string | undefined> {
  const file = (await readdir(directory).catch(() => [] as string[])).find(value => SKILL_FILE.test(value));
  if (!file) return;
  const info = await stat(join(directory, file)).catch(() => undefined);
  return info ? `${info.size}:${info.mtimeMs}` : undefined;
}

/** Everything Studio reads from one plugin folder; a broken plugin.json makes the whole plugin unusable, with the reason. */
export async function readPlugin(directory: string, folder: string): Promise<Scanned> {
  const result: Scanned = { folder, directory, skills: [], servers: [], unsupported: [], files: 0, bytes: 0 };
  try {
    validPluginName(folder);
    Object.assign(result, await walk(directory));
    const manifestPath = join(directory, '.claude-plugin', 'plugin.json');
    const manifest = parseManifest(await exists(manifestPath) ? JSON.stringify(await jsonFile(manifestPath, '.claude-plugin/plugin.json')) : undefined, folder);
    result.manifest = manifest;
    // Skills: skills/<name>/SKILL.md, plus the manifest's extra folders; a plugin that is one SKILL.md at its root is one skill.
    const containers = [join(directory, 'skills'), ...await Promise.all(manifest.skills.map(async path => {
      const target = componentPath(directory, path, 'skills');
      if (!await contained(directory, target)) throw new Error(`plugin.json 里 skills 的路径不存在或指向插件外面：${path}`);
      return target;
    }))];
    const seen = new Set<string>();
    const add = async (path: string) => {
      const real = await realpath(path).catch(() => path);
      if (seen.has(real) || !await contained(directory, path)) return;
      const stamp = await skillStamp(path);
      if (stamp) { seen.add(real); result.skills.push({ folder: relative(directory, path).split(sep).join('/') || '.', directory: path, stamp }); }
    };
    for (const container of containers) {
      if (await skillStamp(container)) { await add(container); continue; }
      for (const item of (await readdir(container, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) if (item.isDirectory() && !item.name.startsWith('.')) await add(join(container, item.name));
    }
    if (!result.skills.length && !manifest.skills.length && !await exists(join(directory, 'skills'))) await add(directory);
    // MCP: .mcp.json first, then plugin.json mcpServers in order; a later server of the same name replaces an earlier one.
    const servers = new Map<string, unknown>();
    if (await exists(join(directory, '.mcp.json'))) for (const row of serverMap(await jsonFile(join(directory, '.mcp.json'), '.mcp.json'), '.mcp.json')) servers.set(row.name, row.config);
    for (const item of manifest.mcpServers) {
      if (typeof item === 'string') {
        if (/\.(mcpb|dxt)$/iu.test(item)) { result.unsupported.push(`MCP 安装包（${item}）`); continue; }
        const path = componentPath(directory, item, 'mcpServers');
        if (!await contained(directory, path)) throw new Error(`plugin.json 里 mcpServers 的文件不存在：${item}`);
        for (const row of serverMap(await jsonFile(path, item), item)) servers.set(row.name, row.config);
      } else for (const row of serverMap(item, 'plugin.json 里的 mcpServers')) servers.set(row.name, row.config);
    }
    result.servers = [...servers].map(([name, config]) => ({ name, config }));
    const defaults: [string, string, string][] = [['commands', 'commands', '命令（commands）'], ['agents', 'agents', '子 Agent（agents）'], ['hooks', 'hooks', 'Hooks（hooks）'],
      ['bin', 'bin', '可执行文件（bin）'], ['.lsp.json', 'lspServers', 'LSP 语言服务（.lsp.json）'], ['output-styles', 'outputStyles', '输出风格（output-styles）'],
      ['monitors', 'monitors', '监视器（monitors）'], ['workflows', 'workflows', '工作流（workflows）'], ['themes', 'themes', '主题（themes）'], ['settings.json', 'settings', '默认设置（settings.json）']];
    const unsupported = new Set(manifest.unsupported);
    for (const [path, , label] of defaults) if (await exists(join(directory, path))) {
      const same = [...unsupported].find(item => item.startsWith(label.split('（')[0]!));
      if (!same) unsupported.add(label);
    }
    result.unsupported = [...unsupported, ...result.unsupported];
    if (!result.skills.length && !result.servers.length && !manifest.keys.name) throw new Error('没有找到插件内容：插件文件夹里需要 .claude-plugin/plugin.json、skills/ 或 .mcp.json');
  } catch (error) { result.error = error instanceof Error ? error.message : '插件无法读取'; }
  return result;
}

/**
 * ${user_config.KEY} takes a value from the plugin page, ${VAR:-default} its default (Studio sets no environment
 * variables for plugins); anything else cannot be resolved and keeps the server unmounted.
 */
export function substitute(text: string, fields: PluginConfigField[], values: Record<string, ConfigValue>): { text: string; shown: string; problem?: string } {
  let problem: string | undefined, secret = false;
  const replace = (body: string) => {
    const option = /^user_config\.([A-Za-z_][A-Za-z0-9_]*)$/u.exec(body);
    if (option) {
      const field = fields.find(row => row.key === option[1]);
      if (!field) { problem ??= `用到了 plugin.json 里没有声明的设置项 ${option[1]}`; return ''; }
      const value = values[field.key] ?? field.default;
      if (value === undefined && field.required) { problem ??= `等待在插件页面填写设置项“${field.title}”`; return ''; }
      if (field.sensitive && value !== undefined) secret = true;
      return value === undefined ? '' : String(value);
    }
    const variable = /^([A-Za-z_][A-Za-z0-9_]*)(?::-(.*))?$/su.exec(body);
    if (variable?.[2] !== undefined) return variable[2];
    if (variable && /^CLAUDE_/u.test(variable[1]!)) { problem ??= `用到了 \${${variable[1]}}，它指向本机文件，HTTP 服务用不到，Studio 不支持`; return ''; }
    problem ??= variable ? `需要环境变量 ${variable[1]}，Studio 不支持给插件设置环境变量` : `无法识别的占位符 \${${body}}`;
    return '';
  };
  const result = text.replace(/\$\{([^}]*)\}/gu, (_match, body: string) => replace(body));
  // The page shows the address; a sensitive value written into it is masked there.
  const shown = text.replace(/\$\{([^}]*)\}/gu, (_match, body: string) => { const option = /^user_config\.(\w+)$/u.exec(body), field = option && fields.find(row => row.key === option[1]); return field?.sensitive ? '***' : replace(body); });
  return { text: result, shown: secret ? shown : result, ...(problem ? { problem } : {}) };
}
function checkUrl(value: string): string | undefined {
  let url: URL;
  try { url = new URL(value.trim()); } catch { return `地址无效：${value}`; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '地址要以 http:// 或 https:// 开头';
  if (url.username || url.password) return '地址里不能写账号密码，请放在请求头里';
  return;
}
/** One .mcp.json entry as the MCP module mounts it: only "type": "http" servers are installed; the rest say why not. */
export function resolveServer(plugin: string, enabled: boolean, server: RawServer, fields: PluginConfigField[], values: Record<string, ConfigValue>): PluginMcpEntry {
  const base = { plugin, name: server.name, enabled };
  const config = server.config;
  if (!object(config)) return { ...base, transport: 'unknown', problem: '配置格式无效' };
  const type = typeof config.type === 'string' ? config.type.toLowerCase() : undefined;
  if (type === 'stdio' || (!type && typeof config.command === 'string')) return { ...base, transport: 'stdio', problem: '需要在本机启动程序（stdio 类），暂不支持' };
  if (type === 'sse') return { ...base, transport: 'sse', problem: 'SSE 类服务暂不支持，只支持 "type": "http"' };
  if (type === 'ws') return { ...base, transport: 'ws', problem: 'WebSocket 类服务暂不支持，只支持 "type": "http"' };
  if (type !== 'http') return { ...base, transport: 'unknown', problem: type ? `无法识别的服务类型 ${type}，只支持 "type": "http"` : '缺少 "type": "http"' };
  if (typeof config.url !== 'string') return { ...base, transport: 'http', problem: '缺少 url' };
  const url = substitute(config.url, fields, values);
  const problems = [url.problem];
  const headers: Record<string, string> = {};
  if (config.headers !== undefined && !object(config.headers)) problems.push('headers 要写成对象');
  for (const [key, value] of Object.entries(object(config.headers) ? config.headers : {})) {
    if (typeof value !== 'string') { problems.push(`请求头 ${key} 的值要写成文字`); continue; }
    const resolved = substitute(value, fields, values);
    if (/[\r\n]/u.test(resolved.text)) problems.push(`请求头 ${key} 的值不能换行`);
    // fetch sends header values as Latin-1 bytes and refuses anything else before connecting.
    else if (/[^\u0000-\u00ff]/u.test(resolved.text)) problems.push(`请求头 ${key} 的值只能用英文字母、数字和符号，HTTP 请求头不支持中文`);
    problems.push(resolved.problem); headers[key] = resolved.text;
  }
  if (config.headersHelper !== undefined) problems.push('headersHelper 需要运行本机命令，暂不支持');
  if (config.oauth !== undefined) problems.push('OAuth 登录暂不支持，请改用请求头里的密钥');
  if (!SERVER_NAME.test(server.name)) problems.push('名称只能用字母、数字、- 和 _，最多 32 个字符');
  const problem = problems.find(Boolean) ?? (url.text ? checkUrl(url.text) : '缺少 url');
  return { ...base, transport: 'http', ...(url.text ? { url: url.text.trim() } : {}), ...(url.shown !== url.text ? { displayUrl: url.shown.trim() } : {}), headers, ...(problem ? { problem } : {}) };
}

const segmentOk = (segment: string) => !!segment && segment !== '.' && segment !== '..' && segment.length <= 255 && !/[\u0000-\u001f]/u.test(segment);
const ignored = (path: string) => /(^|\/)(\.git|__MACOSX)(\/|$)|(^|\/)\.DS_Store$/u.test(path);
const marker = (path: string) => path === '.claude-plugin/plugin.json' || path === '.mcp.json' || /^skills\/.+/u.test(path) || SKILL_FILE.test(path);
/**
 * Uploaded paths become one plugin folder: a single top folder is stripped when the plugin's files are inside it, and the
 * name is plugin.json's name, else the top folder's (or the ZIP's) name.
 */
export function normalizePluginUpload(files: { path: string; data: Uint8Array }[], fallbackName?: string): { name: string; files: { path: string; data: Uint8Array }[] } {
  let rows = files.map(file => ({ ...file, path: file.path.replaceAll('\\', '/').replace(/^\/+/u, '') })).filter(file => file.path && !file.path.endsWith('/') && !ignored(file.path));
  if (!rows.length) throw new Error('没有收到文件');
  let fallback = fallbackName?.replace(/\.zip$/iu, '');
  const tops = new Set(rows.map(file => file.path.split('/')[0]));
  if (!rows.some(file => marker(file.path)) && tops.size === 1 && rows.every(file => file.path.includes('/'))) {
    const top = [...tops][0]!;
    rows = rows.map(file => ({ ...file, path: file.path.slice(top.length + 1) })); fallback = top;
  }
  if (!rows.some(file => marker(file.path))) throw new Error('没有找到插件内容：插件文件夹里需要 .claude-plugin/plugin.json、skills/ 或 .mcp.json');
  if (rows.length > LIMITS.files) throw new Error(`一个插件最多 ${LIMITS.files} 个文件`);
  if (rows.reduce((sum, file) => sum + file.data.byteLength, 0) > LIMITS.bytes) throw new Error('一个插件最多 50 MB');
  for (const file of rows) {
    const segments = file.path.split('/');
    if (segments.length > LIMITS.depth || !segments.every(segmentOk)) throw new Error(`文件路径无效：${file.path}`);
  }
  if (new Set(rows.map(file => file.path)).size !== rows.length) throw new Error('上传的文件里有重复的路径');
  const manifest = rows.find(file => file.path === '.claude-plugin/plugin.json');
  let name: string;
  if (manifest) name = parseManifest(Buffer.from(manifest.data).toString('utf8'), '').name;
  else {
    if (!fallback) throw new Error('无法确定插件名称：请在 .claude-plugin/plugin.json 里写 name');
    try { name = validPluginName(fallback); } catch { throw new Error(`插件名称“${fallback}”无效：只能用小写字母、数字和连字符；可以改文件夹名，或在 .claude-plugin/plugin.json 里写 name`); }
  }
  return { name, files: rows };
}

interface Settings { enabled: Record<string, boolean> }
export class PluginLibrary {
  readonly root: string;
  private readonly settingsPath: string;
  private readonly configPath: string;
  private settings: Settings = { enabled: {} };
  private values: Record<string, Record<string, ConfigValue>> = {};
  private plugins: Scanned[] = [];
  private signature = '';
  private writes = Promise.resolve();
  constructor(config: Pick<Config, 'dataRoot'>) {
    this.root = resolve(config.dataRoot, 'plugins');
    this.settingsPath = resolve(config.dataRoot, 'plugin-settings.json');
    this.configPath = resolve(config.dataRoot, 'plugin-config.json');
  }
  async start(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const load = async (path: string) => { try { return JSON.parse(await readFile(path, 'utf8')) as unknown; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; } };
    const settings = await load(this.settingsPath), values = await load(this.configPath);
    if (object(settings) && object(settings.enabled)) this.settings = { enabled: Object.fromEntries(Object.entries(settings.enabled).filter(([, value]) => typeof value === 'boolean')) as Record<string, boolean> };
    if (object(values) && object(values.values)) this.values = Object.fromEntries(Object.entries(values.values).filter(([, row]) => object(row))) as Record<string, Record<string, ConfigValue>>;
  }
  /** Rescans the folder; true when anything Studio reads from it changed. */
  async refresh(): Promise<boolean> {
    const plugins: Scanned[] = [], names = new Map<string, string>();
    for (const item of (await readdir(this.root, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.name.startsWith('.') || !item.isDirectory()) continue;
      const plugin = await readPlugin(join(this.root, item.name), item.name);
      const name = plugin.manifest?.name;
      if (name && names.has(name)) { plugin.error = `和文件夹 ${names.get(name)} 里的插件同名（${name}），没有加载`; delete plugin.manifest; }
      else if (name) names.set(name, item.name);
      plugins.push(plugin);
    }
    this.plugins = plugins;
    const signature = JSON.stringify(plugins);
    const changed = signature !== this.signature;
    this.signature = signature;
    return changed;
  }
  list(): readonly Scanned[] { return this.plugins; }
  enabled(plugin: Scanned): boolean { return !!plugin.manifest && !plugin.error && (this.settings.enabled[plugin.folder] ?? plugin.manifest.defaultEnabled); }
  skillSources(): PluginSkillSource[] {
    return this.plugins.flatMap(plugin => plugin.manifest && !plugin.error ? plugin.skills.map(skill => ({ plugin: plugin.manifest!.name, enabled: this.enabled(plugin), folder: skill.folder, directory: skill.directory })) : []);
  }
  mcpEntries(): PluginMcpEntry[] {
    return this.plugins.flatMap(plugin => plugin.manifest && !plugin.error
      ? plugin.servers.map(server => resolveServer(plugin.manifest!.name, this.enabled(plugin), server, plugin.manifest!.fields, this.values[plugin.folder] ?? {})) : []);
  }
  find(folder: string): Scanned {
    const plugin = this.plugins.find(row => row.folder === folder);
    if (!plugin) throw new Error('插件不存在或已被删除，请刷新');
    return plugin;
  }
  view(skills: StudioSkill[], mcp: PluginMcpView[]): PluginView[] {
    return this.plugins.map(plugin => {
      const manifest = plugin.manifest, name = manifest?.name ?? plugin.folder, values = this.values[plugin.folder] ?? {};
      return { folder: plugin.folder, name, ...(manifest?.displayName ? { displayName: manifest.displayName } : {}), ...(manifest?.description ? { description: manifest.description } : {}),
        ...(manifest?.version ? { version: manifest.version } : {}), ...(manifest?.author ? { author: manifest.author } : {}), ...(manifest?.homepage ? { homepage: manifest.homepage } : {}),
        enabled: this.enabled(plugin), ...(plugin.error ? { error: plugin.error } : {}), files: plugin.files, bytes: plugin.bytes,
        skills: manifest ? skills.filter(skill => skill.plugin === name) : [], mcp: manifest ? mcp.filter(server => server.plugin === name) : [], unsupported: plugin.unsupported,
        config: (manifest?.fields ?? []).map(({ default: fallback, ...field }) => ({ ...field, ...(fallback !== undefined && !field.sensitive ? { default: fallback } : {}),
          set: values[field.key] !== undefined, ...(!field.sensitive && values[field.key] !== undefined ? { value: values[field.key] } : {}) })) };
    });
  }
  private persist(path: string, value: unknown, mode?: number): Promise<void> {
    const next = this.writes.then(async () => {
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', mode ? { mode } : {});
      if (mode) await chmod(temporary, mode);
      await rename(temporary, path);
    });
    this.writes = next.catch(() => undefined);
    return next;
  }
  async toggle(folder: string, enabled: boolean): Promise<void> {
    const plugin = this.find(folder);
    if (plugin.error && enabled) throw new Error(`插件无法使用：${plugin.error}`);
    this.settings.enabled[folder] = enabled;
    await this.persist(this.settingsPath, this.settings);
  }
  async remove(folder: string): Promise<void> {
    const plugin = this.find(folder), target = join(this.root, plugin.folder);
    if (relative(this.root, target).includes(sep) || relative(this.root, target).startsWith('..')) throw new Error('插件路径无效');
    await rm(target, { recursive: true, force: true });
    delete this.settings.enabled[folder]; delete this.values[folder];
    await this.persist(this.settingsPath, this.settings); await this.persist(this.configPath, { values: this.values }, 0o600);
  }
  /** Values of userConfig options. A blank sensitive value keeps the saved one; a blank other value returns to the default. */
  async configure(folder: string, input: unknown): Promise<void> {
    const plugin = this.find(folder);
    if (!plugin.manifest) throw new Error(`插件无法使用：${plugin.error ?? ''}`);
    if (!object(input)) throw new Error('设置格式无效');
    const values = { ...this.values[folder] };
    for (const [key, raw] of Object.entries(input)) {
      const field = plugin.manifest.fields.find(row => row.key === key);
      if (!field) throw new Error(`没有设置项 ${key}，请刷新`);
      if (raw === '' || raw === null) { if (!field.sensitive) delete values[key]; continue; }
      if (field.type === 'boolean') { if (typeof raw !== 'boolean') throw new Error(`“${field.title}”只能选是或否`); values[key] = raw; continue; }
      if (field.type === 'number') {
        const number = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
        if (!Number.isFinite(number)) throw new Error(`“${field.title}”要填数字`);
        if (field.min !== undefined && number < field.min || field.max !== undefined && number > field.max) throw new Error(`“${field.title}”要在 ${field.min ?? '-∞'} 到 ${field.max ?? '∞'} 之间`);
        values[key] = number; continue;
      }
      if (typeof raw !== 'string' || raw.length > 4000 || /[\r\n]/u.test(raw)) throw new Error(`“${field.title}”要填一行文字`);
      if (field.options && !field.options.includes(raw)) throw new Error(`“${field.title}”只能选 ${field.options.join('、')}`);
      values[key] = raw;
    }
    for (const field of plugin.manifest.fields) if (field.required && values[field.key] === undefined && field.default === undefined) throw new Error(`请填写“${field.title}”`);
    // A value that cannot go into the request header it fills is refused here, where the person typed it.
    const header = plugin.servers.map(server => resolveServer(plugin.manifest!.name, true, server, plugin.manifest!.fields, values).problem).find(problem => problem?.startsWith('请求头 '));
    if (header) throw new Error(header);
    this.values[folder] = values;
    await this.persist(this.configPath, { values: this.values }, 0o600);
  }
  /** Installs one plugin folder, named after the plugin; an existing one is replaced only when confirmed and keeps its switch and settings. */
  async install(files: { path: string; data: Uint8Array }[], overwrite: boolean, fallbackName?: string): Promise<string> {
    const normalized = normalizePluginUpload(files, fallbackName), target = join(this.root, normalized.name);
    await mkdir(this.root, { recursive: true });
    const present = await exists(target);
    if (present && !overwrite) throw Object.assign(new Error(`已有同名插件 ${normalized.name}，确认后会替换它`), { code: 'PLUGIN_EXISTS' });
    const staging = join(this.root, `.upload-${randomUUID()}`);
    try {
      for (const file of normalized.files) {
        const path = join(staging, ...file.path.split('/'));
        await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, file.data);
      }
      const checked = await readPlugin(staging, normalized.name);
      if (checked.error) throw new Error(checked.error);
      if (present) await rm(target, { recursive: true, force: true });
      await rename(staging, target);
    } finally { await rm(staging, { recursive: true, force: true }); }
    return normalized.name;
  }
}

/** Reads a streamed upload up to the limit, so a large body is refused without buffering all of it. */
async function readBody(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  if (Number(request.headers.get('content-length') ?? 0) > limit) throw new Error('一个插件最多 50 MB');
  const chunks: Uint8Array[] = []; let total = 0;
  const reader = request.body?.getReader();
  if (!reader) throw new Error('没有收到文件');
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) { await reader.cancel().catch(() => undefined); throw new Error('一个插件最多 50 MB'); }
    chunks.push(value);
  }
  const data = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  return data;
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const library = new PluginLibrary(config);
  await library.start();
  let syncing = Promise.resolve();
  /** Pushes the plugins' skills and MCP servers into their modules; runs one at a time. */
  const sync = () => {
    const next = syncing.then(async () => {
      ctx.studioSkills.library.setPluginSkills(library.skillSources()); ctx.studioSkills.changed();
      await ctx.studioMcp.setPluginServers(library.mcpEntries());
    });
    syncing = next.catch(() => undefined);
    return next;
  };
  /** Rescans and pushes when something changed, or always after the page changed a plugin. */
  const update = async (always = false) => { if (await library.refresh() || always) await sync(); };
  const changed = () => update(true);
  await update(true);
  // Folders copied into plugins/ outside the page take effect within a poll, like skills.
  ctx.effect(() => {
    let running = false;
    const timer = setInterval(() => {
      if (running) return; running = true;
      void update().catch(() => undefined).finally(() => { running = false; });
    }, config.pollMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }, 'studio-plugins: change poll');
  const view = async () => library.view((await ctx.studioSkills.library.view()).plugins, await ctx.studioMcp.pluginView());
  const body = async (request: Request) => { const value = await request.json(); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求格式无效'); return value as Record<string, unknown>; };
  const folderOf = (data: Record<string, unknown>) => { if (typeof data.folder !== 'string' || !data.folder) throw new Error('缺少插件'); return data.folder; };
  const failure = (error: unknown) => {
    const code = error instanceof Error && 'code' in error ? String(error.code) : '';
    const message = ['EPERM', 'EACCES', 'EROFS'].includes(code) ? '没有写权限' : code === 'ENOSPC' ? '磁盘空间不足' : error instanceof Error ? error.message : '插件操作失败';
    return Response.json({ error: message, ...(code === 'PLUGIN_EXISTS' ? { exists: true } : {}) }, { status: code === 'PLUGIN_EXISTS' ? 409 : 400 });
  };
  const routes: [string, ('GET' | 'POST')[], (request: Request) => Promise<unknown>][] = [
    ['/api/studio/plugins', ['GET'], async () => { await update(); return { plugins: await view() }; }],
    ['/api/studio/plugins/toggle', ['POST'], async request => {
      const data = await body(request); if (typeof data.enabled !== 'boolean') throw new Error('缺少 enabled');
      await library.toggle(folderOf(data), data.enabled); await changed(); return { saved: true };
    }],
    ['/api/studio/plugins/delete', ['POST'], async request => { await library.remove(folderOf(await body(request))); await changed(); return { deleted: true }; }],
  ];
  for (const [path, methods, action] of routes) ctx.connection.fetch.register({ path, methods, requestBody: 'buffered', async fetch(request) {
    try { return Response.json(await ctx.studioDomain.webAction(request, () => action(request))); } catch (error) { return failure(error); }
  } });
  // A folder or ZIP as multipart form data, streamed: a whole plugin may exceed the buffered request limit.
  ctx.connection.fetch.register({ path: '/api/studio/plugins/upload', methods: ['POST'], requestBody: 'streaming', async fetch(request) {
    try {
      return Response.json(await ctx.studioDomain.webAction(request, async () => {
        const data = await readBody(request, LIMITS.bytes + 2 * 1024 * 1024);
        const form = await new Response(data, { headers: { 'content-type': request.headers.get('content-type') ?? '' } }).formData().catch(() => { throw new Error('上传格式无效'); });
        const zip = form.get('zip'), fallback = typeof form.get('name') === 'string' ? form.get('name') as string : undefined;
        let files: { path: string; data: Uint8Array }[];
        if (zip instanceof Blob) {
          // The shared ZIP reader only lowers its own caps (20 MB archive, 1000 entries); bigger plugins upload as a folder.
          const archive = await extractZip(new Uint8Array(await zip.arrayBuffer()), request.signal, { maxTotalBytes: LIMITS.bytes, maxFileBytes: LIMITS.bytes, maxDepth: LIMITS.depth + 1 }).catch((error: unknown) => {
            const code = error instanceof Error && 'code' in error ? String(error.code) : '';
            if (code === 'CHAT_ZIP_LIMIT') throw new Error('ZIP 太大：ZIP 文件最多 20 MB、1000 个条目，解压后最多 50 MB；更大的插件请上传文件夹');
            if (code === 'CHAT_ZIP_INVALID' || code === 'CHAT_ZIP_CRC') throw new Error('ZIP 文件无效或已损坏，请重新打包');
            throw error;
          });
          files = archive.entries.flatMap(entry => entry.type === 'file' ? [{ path: entry.path, data: entry.data }] : []);
        } else {
          const paths = form.getAll('path'), blobs = form.getAll('file');
          if (!blobs.length || paths.length !== blobs.length) throw new Error('请上传插件文件夹或 ZIP');
          files = await Promise.all(blobs.map(async (blob, index) => {
            const path = paths[index];
            if (typeof path !== 'string' || !(blob instanceof Blob)) throw new Error('上传格式无效');
            return { path, data: new Uint8Array(await blob.arrayBuffer()) };
          }));
        }
        const name = await library.install(files, form.get('overwrite') === '1', fallback);
        await changed();
        return (await view()).find(row => row.name === name) ?? { name };
      }));
    } catch (error) { return failure(error); }
  } });
  // Option values can be credentials, so like MCP headers they stay out of the activity log.
  ctx.connection.fetch.register({ path: '/api/studio/plugins/config', methods: ['POST'], requestBody: 'buffered', async fetch(request) {
    try { const data = await body(request); await library.configure(folderOf(data), data.values); await changed(); return Response.json({ saved: true }); }
    catch (error) { return failure(error); }
  } });
}
