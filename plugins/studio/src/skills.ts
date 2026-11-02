/** Agent skills: a global library in Studio's data folder and each project's F:\skills, served through the native skill registry. */
import type { Context } from '@deepseek-ai/cordis';
import { isSkillName, type SkillCandidate, type SkillDefinition, type SkillLookupOptions, type SkillProvider, type SkillProviderControl } from '@deepseek-ai/dsh-skill';
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { extractZip } from './chat-zip.ts';
import type {} from './index.ts';
import type {} from './domain.ts';
import { throwIfAborted } from './abort.ts';

export const name = 'harnessstudio-skills';
export const inject = ['skills', 'studio', 'studioDomain', 'tools', 'connection'];
export interface Config { dataRoot: string; pollMs: number }
export const Config: z<Config> = z.object({ dataRoot: z.string().required(), pollMs: z.natural().min(200).default(3000) });

// The upstream provider parses frontmatter with `yaml`; resolve the same copy instead of adding a dependency.
interface YamlDocument { getIn(path: string[]): unknown; setIn(path: string[], value: unknown): void; deleteIn(path: string[]): void; createNode(value: unknown, options: { flow: boolean }): unknown; toString(options?: { flowCollectionPadding: boolean }): string; errors: { message: string }[] }
const yaml = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-skill-filesystem/package.json'))('yaml') as { parse(text: string): unknown; parseDocument(text: string): YamlDocument };

/** Skills users manage on the page; plugin skills are read-only and managed with their plugin. */
export type SkillScope = 'global' | 'project';
/** Where a skill's work runs: Studio itself, the Linux sandbox, or a Windows VM of the listed environments. */
export type SkillRunsIn = 'platform' | 'sandbox' | 'vm';
export interface SkillLocation { runsIn: SkillRunsIn; environments: string[] }
export interface StudioSkill {
  /** Folder (or flat .md file) inside the library root, or the folder inside the plugin; it identifies the skill in the page. */
  folder: string; name: string; description: string; whenToUse?: string;
  enabled: boolean; modelInvocable: boolean; userInvocable: boolean;
  files: number; bytes: number; error?: string;
  runsIn: SkillRunsIn; environments: string[];
  /** The plugin that brought this skill. */
  plugin?: string;
  /** A same-name skill that wins in this project's chats: project over global over plugin. */
  shadowedBy?: 'project' | 'global' | 'plugin';
}
export interface SkillLibraryView { global: StudioSkill[]; project?: { available: boolean; skills: StudioSkill[] }; plugins: StudioSkill[] }
/** One skill folder of an installed plugin, as the plugin library found it. */
export interface PluginSkillSource { plugin: string; enabled: boolean; folder: string; directory: string }
interface Parsed { name: string; description: string; whenToUse?: string; modelInvocable: boolean; userInvocable: boolean; metadata?: Record<string, unknown>; location: SkillLocation; content: string }
interface Entry { scope: SkillScope | 'plugin'; projectId?: string; plugin?: string; pluginEnabled?: boolean; folder: string; file: string; directory?: string; parsed?: Parsed; error?: string; files: number; bytes: number }
interface Settings { disabled: { global: string[]; projects: Record<string, string[]> } }
export interface StudioSkillsService { library: SkillLibrary; changed(): void }
declare module '@deepseek-ai/cordis' { interface Context { studioSkills: StudioSkillsService } }

const LIMITS = { files: 500, bytes: 20 * 1024 * 1024, depth: 8, skillFile: 256 * 1024, preview: 256 * 1024 };
const SKILL_FILE = /^skill\.md$/i;
const badSegment = (segment: string) => !segment || segment === '.' || segment === '..' || segment.startsWith('.') || segment.length > 120
  || /[<>:"/\\|?*\u0000-\u001f]/u.test(segment) || /[. ]$/u.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/iu.test(segment);

function boolean(value: unknown, key: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string' && /^(true|yes|on|1)$/iu.test(value.trim())) return true;
  if (typeof value === 'string' && /^(false|no|off|0)$/iu.test(value.trim())) return false;
  throw new Error(`${key} 只能写 true 或 false`);
}
const ENVIRONMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/u;
/**
 * metadata.runs-in (platform when absent) and, for vm, metadata.environments. The Agent Skills spec keeps metadata values
 * strings, so a comma-separated string is read as well as a YAML list.
 */
export function skillLocation(metadata: Record<string, unknown> | undefined): SkillLocation {
  const raw = metadata?.['runs-in'];
  const runsIn = raw === undefined || raw === null || raw === '' ? 'platform' : typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (runsIn !== 'platform' && runsIn !== 'sandbox' && runsIn !== 'vm') throw new Error('metadata 里的 runs-in 只能写 platform（平台）、sandbox（沙箱）或 vm（虚拟机）');
  if (runsIn !== 'vm') return { runsIn, environments: [] };
  const value = metadata?.environments;
  const items = value === undefined || value === null ? [] : Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,，\s]+/u) : undefined;
  if (!items) throw new Error('metadata 里的 environments 要写成列表，例如 [win11-autocad2026]');
  const environments = [...new Set(items.map(item => String(item ?? '').trim()).filter(Boolean))];
  const bad = environments.find(id => !ENVIRONMENT.test(id));
  if (bad) throw new Error(`环境名称“${bad}”无效：只能用字母、数字、点、连字符和下划线，例如 win11-autocad2026`);
  if (environments.length > 20) throw new Error('environments 最多写 20 个环境');
  return { runsIn, environments };
}
/** Rewrites only metadata.runs-in and metadata.environments of a SKILL.md, keeping the rest of the text as written. */
export function setSkillLocation(text: string, location: SkillLocation): string {
  const source = text.replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n');
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/u.exec(source);
  if (!match) throw new Error('SKILL.md 开头缺少 --- 包住的 name 和 description');
  const document = yaml.parseDocument(match[1]!);
  if (document.errors.length) throw new Error(`SKILL.md 开头的格式有误：${document.errors[0]!.message.split('\n')[0]}`);
  const checked = skillLocation({ 'runs-in': location.runsIn, environments: location.environments });
  if (checked.runsIn === 'platform') document.deleteIn(['metadata', 'runs-in']); else document.setIn(['metadata', 'runs-in'], checked.runsIn);
  if (checked.runsIn === 'vm' && checked.environments.length) document.setIn(['metadata', 'environments'], document.createNode(checked.environments, { flow: true }));
  else document.deleteIn(['metadata', 'environments']);
  const metadata = document.getIn(['metadata']) as { items?: unknown[] } | undefined;
  if (metadata && Array.isArray(metadata.items) && !metadata.items.length) document.deleteIn(['metadata']);
  return `---\n${document.toString({ flowCollectionPadding: false })}---\n${source.slice(match[0].length)}`;
}
/** SKILL.md: YAML frontmatter with name and description, then the instructions, as in the upstream provider and Claude Code. */
export function parseSkill(text: string, fallbackName: string): Parsed {
  const source = text.replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n');
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/u.exec(source);
  if (!match) throw new Error('SKILL.md 开头缺少 --- 包住的 name 和 description');
  let front: unknown;
  try { front = yaml.parse(match[1]!); } catch (error) { throw new Error(`SKILL.md 开头的格式有误：${error instanceof Error ? error.message.split('\n')[0] : 'YAML 无法解析'}`); }
  if (!front || typeof front !== 'object' || Array.isArray(front)) throw new Error('SKILL.md 开头需要写 name 和 description');
  const row = front as Record<string, unknown>;
  const name = row.name === undefined ? fallbackName : typeof row.name === 'string' ? row.name.trim() : '';
  if (!isSkillName(name)) throw new Error(`技能名称“${name || '（空）'}”无效：只能用小写字母、数字和连字符，例如 solidworks-modeling`);
  const description = typeof row.description === 'string' ? row.description.trim().replace(/\s+/gu, ' ') : '';
  if (!description) throw new Error('SKILL.md 开头缺少 description（一句话说明这个技能做什么、什么时候用）');
  const whenRaw = row.whenToUse ?? row.when_to_use;
  const whenToUse = typeof whenRaw === 'string' && whenRaw.trim() ? whenRaw.trim() : undefined;
  const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata as Record<string, unknown> : undefined;
  return { name, description, ...(whenToUse ? { whenToUse } : {}), modelInvocable: !(boolean(row['disable-model-invocation'], 'disable-model-invocation') ?? false),
    userInvocable: boolean(row['user-invocable'], 'user-invocable') ?? true, ...(metadata ? { metadata } : {}), location: skillLocation(metadata), content: source.slice(match[0].length).trim() };
}

/** Normalize uploaded paths: one top folder holding SKILL.md is stripped, and a single Markdown file becomes SKILL.md. */
export function normalizeUpload(files: { path: string; data: Uint8Array }[]): { path: string; data: Uint8Array }[] {
  const rows = files.map(file => ({ ...file, path: file.path.replaceAll('\\', '/').replace(/^\/+/u, '') })).filter(file => file.path && !file.path.endsWith('/'));
  if (!rows.length) throw new Error('没有收到文件');
  if (rows.length === 1 && /\.md$/iu.test(rows[0]!.path) && !rows[0]!.path.includes('/')) return [{ path: 'SKILL.md', data: rows[0]!.data }];
  const tops = new Set(rows.map(file => file.path.split('/')[0]));
  let output = rows;
  if (!rows.some(file => SKILL_FILE.test(file.path)) && tops.size === 1) {
    const top = [...tops][0]!;
    output = rows.map(file => ({ ...file, path: file.path.slice(top.length + 1) }));
  }
  const skill = output.filter(file => SKILL_FILE.test(file.path));
  if (skill.length !== 1) throw new Error('技能文件夹的第一层需要一个 SKILL.md');
  if (output.length > LIMITS.files) throw new Error(`一个技能最多 ${LIMITS.files} 个文件`);
  if (output.reduce((sum, file) => sum + file.data.byteLength, 0) > LIMITS.bytes) throw new Error('一个技能最多 20 MB');
  for (const file of output) {
    const segments = file.path.split('/');
    if (segments.length > LIMITS.depth || segments.some(badSegment)) throw new Error(`文件路径无效：${file.path}（不能有隐藏文件、.. 或 Windows 不允许的字符）`);
  }
  return output.map(file => SKILL_FILE.test(file.path) ? { ...file, path: 'SKILL.md' } : file);
}

async function walk(directory: string, depth = 0): Promise<{ path: string; bytes: number }[]> {
  if (depth > LIMITS.depth) return [];
  const rows: { path: string; bytes: number }[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) for (const child of await walk(path, depth + 1)) rows.push({ path: `${entry.name}/${child.path}`, bytes: child.bytes });
    else if (entry.isFile()) rows.push({ path: entry.name, bytes: (await stat(path).catch(() => ({ size: 0 }))).size });
    if (rows.length >= LIMITS.files) break;
  }
  return rows;
}

/** The name a SKILL.md without `name` gets: its folder, or the plugin for a plugin that is one skill at its root. */
const fallbackName = (entry: Entry) => entry.scope === 'plugin' ? entry.folder === '.' ? entry.plugin! : basename(entry.directory!) : entry.directory ? entry.folder : basename(entry.folder, '.md');

export class SkillLibrary {
  private readonly settingsPath: string;
  private settings: Settings = { disabled: { global: [], projects: {} } };
  private writes = Promise.resolve();
  readonly globalRoot: string;
  constructor(private readonly ctx: Context, config: Config) {
    this.globalRoot = resolve(config.dataRoot, 'skills');
    this.settingsPath = resolve(config.dataRoot, 'skill-settings.json');
  }
  async start(): Promise<void> {
    await mkdir(this.globalRoot, { recursive: true });
    try {
      const value = JSON.parse(await readFile(this.settingsPath, 'utf8')) as Partial<Settings>;
      const disabled = value.disabled ?? { global: [], projects: {} };
      this.settings = { disabled: { global: Array.isArray(disabled.global) ? disabled.global.filter(isSkillName) : [],
        projects: Object.fromEntries(Object.entries(disabled.projects ?? {}).map(([id, names]) => [id, Array.isArray(names) ? names.filter(isSkillName) : []])) } };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  /** Project skills live in the F: drive every VM of the project sees (or the same shared folder of the no-software mode);
   * deployments without one have only the global library. */
  projectRoot(projectId: string): string | undefined {
    const domain = this.ctx.studioDomain;
    if (!domain.fileStorage) return;
    domain.graph(projectId);
    return join(domain.sharedSpaceDirectory(projectId), 'skills');
  }
  /** Whether skills may point to VMs: every backend except the no-software one, which has none to mention. */
  get vms(): boolean { return this.ctx.studioDomain.softwareBackend !== 'none'; }
  /** A chat's cwd is its task space or the project's shared folder under the projects root. */
  projectOf(cwd: string | undefined): string | undefined {
    const storage = this.ctx.studioDomain.fileStorage;
    if (!cwd || !storage) return;
    const path = relative(resolve(storage.projectsRoot), resolve(cwd));
    if (!path || path.startsWith('..')) return;
    const id = path.split(sep)[0]!;
    try { this.ctx.studioDomain.graph(id); return id; } catch { return; }
  }
  root(scope: SkillScope, projectId?: string): string {
    if (scope === 'global') return this.globalRoot;
    const root = projectId ? this.projectRoot(projectId) : undefined;
    if (!root) throw new Error('当前部署没有项目公共空间（F 盘），项目技能不可用');
    return root;
  }
  async scan(scope: SkillScope, projectId?: string): Promise<Entry[]> {
    const root = this.root(scope, projectId), entries: Entry[] = [];
    for (const item of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (item.name.startsWith('.')) continue;
      const path = join(root, item.name);
      if (item.isDirectory()) {
        const names = await readdir(path).catch(() => [] as string[]), skillFile = names.find(value => SKILL_FILE.test(value));
        if (!skillFile) continue;
        const files = await walk(path);
        entries.push(await this.read({ scope, ...(projectId ? { projectId } : {}), folder: item.name, file: join(path, skillFile), directory: path,
          files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0) }));
      } else if (item.isFile() && /\.md$/iu.test(item.name) && !/^readme\.md$/iu.test(item.name)) {
        entries.push(await this.read({ scope, ...(projectId ? { projectId } : {}), folder: item.name, file: path, files: 1, bytes: (await stat(path)).size }));
      }
    }
    return entries.sort((a, b) => (a.parsed?.name ?? a.folder).localeCompare(b.parsed?.name ?? b.folder));
  }
  private async read(entry: Entry): Promise<Entry> {
    try {
      const info = await lstat(entry.file);
      if (!info.isFile()) throw new Error('SKILL.md 不是普通文件');
      if (info.size > LIMITS.skillFile) throw new Error('SKILL.md 超过 256 KB，请把长内容拆到其他文件');
      return { ...entry, parsed: parseSkill(await readFile(entry.file, 'utf8'), fallbackName(entry)) };
    } catch (error) { return { ...entry, error: error instanceof Error ? error.message : '无法读取 SKILL.md' }; }
  }
  disabled(scope: SkillScope, projectId?: string): Set<string> {
    return new Set(scope === 'global' ? this.settings.disabled.global : this.settings.disabled.projects[projectId ?? ''] ?? []);
  }
  private pluginSources: PluginSkillSource[] = [];
  /** The plugin library pushes every installed plugin's skill folders, in plugin order; a disabled plugin's skills stay listable. */
  setPluginSkills(sources: PluginSkillSource[]): void { this.pluginSources = sources; }
  async pluginEntries(): Promise<Entry[]> {
    const entries: Entry[] = [];
    for (const source of this.pluginSources) {
      const skillFile = (await readdir(source.directory).catch(() => [] as string[])).find(value => SKILL_FILE.test(value));
      if (!skillFile) continue;
      const files = await walk(source.directory);
      entries.push(await this.read({ scope: 'plugin', plugin: source.plugin, pluginEnabled: source.enabled, folder: source.folder, file: join(source.directory, skillFile), directory: source.directory,
        files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0) }));
    }
    return entries;
  }
  /** The skills one chat's Agent sees: enabled and valid; for one name a project skill wins over a global one, which wins over a plugin's. */
  async available(projectId: string | undefined): Promise<Entry[]> {
    const project = projectId && this.projectRoot(projectId) ? (await this.scan('project', projectId)).filter(entry => entry.parsed && !this.disabled('project', projectId).has(entry.parsed.name)) : [];
    const global = (await this.scan('global')).filter(entry => entry.parsed && !this.disabled('global').has(entry.parsed.name));
    const plugins = (await this.pluginEntries()).filter(entry => entry.parsed && entry.pluginEnabled);
    const seen = new Set<string>(), result: Entry[] = [];
    for (const entry of [...project, ...global, ...plugins]) if (!seen.has(entry.parsed!.name)) { seen.add(entry.parsed!.name); result.push(entry); }
    return result;
  }
  describe(entry: Entry, enabled: boolean, shadowedBy?: StudioSkill['shadowedBy']): StudioSkill {
    return { folder: entry.folder, name: entry.parsed?.name ?? entry.folder, description: entry.parsed?.description ?? '',
      ...(entry.parsed?.whenToUse ? { whenToUse: entry.parsed.whenToUse } : {}),
      enabled, modelInvocable: entry.parsed?.modelInvocable ?? false, userInvocable: entry.parsed?.userInvocable ?? false,
      files: entry.files, bytes: entry.bytes, ...(entry.error ? { error: entry.error } : {}),
      runsIn: entry.parsed?.location.runsIn ?? 'platform', environments: entry.parsed?.location.environments ?? [],
      ...(entry.plugin ? { plugin: entry.plugin } : {}), ...(shadowedBy ? { shadowedBy } : {}) };
  }
  async view(projectId?: string): Promise<SkillLibraryView> {
    const projectAvailable = !!projectId && !!this.projectRoot(projectId);
    const project = projectAvailable ? await this.scan('project', projectId) : [];
    const projectDisabled = this.disabled('project', projectId), globalDisabled = this.disabled('global');
    const on = (entry: Entry, disabled: Set<string>) => !!entry.parsed && !disabled.has(entry.parsed.name);
    const projectNames = new Set(project.filter(entry => on(entry, projectDisabled)).map(entry => entry.parsed!.name));
    const global = await this.scan('global'), globalNames = new Set(global.filter(entry => on(entry, globalDisabled)).map(entry => entry.parsed!.name));
    const pluginNames = new Set<string>();
    const plugins = (await this.pluginEntries()).map(entry => {
      const name = entry.parsed?.name, enabled = !!entry.parsed && !!entry.pluginEnabled;
      const shadowedBy = !name ? undefined : projectNames.has(name) ? 'project' as const : globalNames.has(name) ? 'global' as const : enabled && pluginNames.has(name) ? 'plugin' as const : undefined;
      if (name && enabled) pluginNames.add(name);
      return this.describe(entry, enabled, shadowedBy);
    });
    return { global: global.map(entry => this.describe(entry, on(entry, globalDisabled), entry.parsed && projectNames.has(entry.parsed.name) ? 'project' : undefined)),
      ...(projectId ? { project: { available: projectAvailable, skills: project.map(entry => this.describe(entry, on(entry, projectDisabled))) } } : {}), plugins };
  }
  async find(scope: SkillScope | 'plugin', projectId: string | undefined, folder: string, plugin?: string): Promise<Entry> {
    const found = scope === 'plugin' ? (await this.pluginEntries()).find(entry => entry.plugin === plugin && entry.folder === folder)
      : (await this.scan(scope, projectId)).find(entry => entry.folder === folder);
    if (!found) throw new Error('技能不存在或已被删除，请刷新');
    return found;
  }
  private save(): Promise<void> {
    const next = this.writes.then(async () => {
      const temporary = `${this.settingsPath}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(this.settings, null, 2) + '\n'); await rename(temporary, this.settingsPath);
    });
    this.writes = next.catch(() => undefined);
    return next;
  }
  async toggle(scope: SkillScope, projectId: string | undefined, name: string, enabled: boolean): Promise<void> {
    if (!isSkillName(name)) throw new Error('技能名称无效');
    if (scope === 'project') this.root(scope, projectId);
    const list = new Set(this.disabled(scope, projectId));
    if (enabled) list.delete(name); else list.add(name);
    if (scope === 'global') this.settings.disabled.global = [...list].sort();
    else this.settings.disabled.projects[projectId!] = [...list].sort();
    await this.save();
  }
  private writable(scope: SkillScope, projectId?: string): string {
    if (scope === 'project') {
      this.ctx.studio.sharedLease(projectId!, true);
    }
    return this.root(scope, projectId);
  }
  /** Installs one skill folder, named after its frontmatter name; an existing folder is replaced only when confirmed. */
  async install(scope: SkillScope, projectId: string | undefined, files: { path: string; data: Uint8Array }[], overwrite: boolean): Promise<StudioSkill> {
    const root = this.writable(scope, projectId);
    if (scope === 'project') await this.ctx.studio.projectFiles.allocate(projectId!);
    const normalized = normalizeUpload(files), skill = normalized.find(file => file.path === 'SKILL.md')!;
    const parsed = parseSkill(Buffer.from(skill.data).toString('utf8'), '');
    const target = join(root, parsed.name);
    await mkdir(root, { recursive: true });
    const exists = await lstat(target).then(() => true, () => false);
    const flat = await lstat(join(root, `${parsed.name}.md`)).then(() => true, () => false);
    if ((exists || flat) && !overwrite) throw Object.assign(new Error(`已有同名技能 ${parsed.name}，确认后会替换它`), { code: 'SKILL_EXISTS' });
    const staging = join(root, `.upload-${randomUUID()}`);
    try {
      for (const file of normalized) {
        const path = join(staging, ...file.path.split('/'));
        await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, file.data);
      }
      if (exists) await rm(target, { recursive: true, force: true });
      if (flat) await rm(join(root, `${parsed.name}.md`), { force: true });
      await rename(staging, target);
    } finally { await rm(staging, { recursive: true, force: true }); }
    return this.describeOne(await this.find(scope, projectId, parsed.name), scope, projectId);
  }
  private describeOne(entry: Entry, scope: SkillScope, projectId?: string): StudioSkill {
    return this.describe(entry, !!entry.parsed && !this.disabled(scope, projectId).has(entry.parsed.name));
  }
  /** Saves SKILL.md text from the page editor: a new skill gets its own folder, an existing one keeps its folder. */
  async saveText(scope: SkillScope, projectId: string | undefined, content: string, folder?: string): Promise<StudioSkill> {
    if (Buffer.byteLength(content) > LIMITS.skillFile) throw new Error('SKILL.md 超过 256 KB，请把长内容拆到其他文件');
    if (folder === undefined) {
      try { return await this.install(scope, projectId, [{ path: 'SKILL.md', data: Buffer.from(content) }], false); }
      catch (error) {
        if ((error as { code?: string }).code !== 'SKILL_EXISTS') throw error;
        throw new Error(`已有同名技能 ${parseSkill(content, '').name}，请换一个名称，或在列表里编辑它`);
      }
    }
    this.writable(scope, projectId);
    const entry = await this.find(scope, projectId, folder);
    parseSkill(content, entry.directory ? entry.folder : basename(entry.folder, '.md'));
    const temporary = `${entry.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, content); await rename(temporary, entry.file);
    return this.describeOne(await this.find(scope, projectId, folder), scope, projectId);
  }
  async remove(scope: SkillScope, projectId: string | undefined, folder: string): Promise<void> {
    const root = this.writable(scope, projectId), entry = await this.find(scope, projectId, folder);
    const target = entry.directory ?? entry.file;
    if (relative(root, target).includes(sep) || relative(root, target).startsWith('..')) throw new Error('技能路径无效');
    await rm(target, { recursive: true, force: true });
  }
  async files(entry: Entry): Promise<{ path: string; bytes: number }[]> {
    return entry.directory ? walk(entry.directory) : [{ path: basename(entry.file), bytes: entry.bytes }];
  }
  /** Reads one text file of a skill, never outside its folder. */
  async readText(entry: Entry, path: string): Promise<{ path: string; bytes: number; content?: string; binary?: boolean; truncated?: boolean }> {
    const base = entry.directory ?? resolve(entry.file, '..');
    const segments = path.replaceAll('\\', '/').split('/').filter(Boolean);
    if (!segments.length || segments.some(segment => segment === '..' || segment.startsWith('.'))) throw new Error('文件路径无效');
    const file = entry.directory ? join(base, ...segments) : entry.file;
    if (!entry.directory && segments.join('/') !== basename(entry.file)) throw new Error('文件不存在');
    const info = await lstat(file).catch(() => undefined);
    if (!info?.isFile()) throw new Error('文件不存在');
    const data = await readFile(file);
    const slice = data.subarray(0, LIMITS.preview);
    if (slice.includes(0)) return { path: segments.join('/'), bytes: info.size, binary: true };
    return { path: segments.join('/'), bytes: info.size, content: slice.toString('utf8'), ...(info.size > LIMITS.preview ? { truncated: true } : {}) };
  }
  /** One signature per root, so edits made outside the page (F: in a VM, the file panel) refresh the Agent's catalog. */
  async signature(root: string): Promise<string> {
    const parts: string[] = [];
    for (const item of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (item.name.startsWith('.')) continue;
      const path = join(root, item.name);
      if (item.isDirectory()) {
        const skillFile = (await readdir(path).catch(() => [] as string[])).find(value => SKILL_FILE.test(value));
        const info = skillFile ? await stat(join(path, skillFile)).catch(() => undefined) : undefined;
        parts.push(`${item.name}:${info ? `${info.size}:${info.mtimeMs}` : '-'}`);
      } else if (item.isFile()) { const info = await stat(path).catch(() => undefined); parts.push(`${item.name}:${info?.size}:${info?.mtimeMs}`); }
    }
    return parts.sort().join('|');
  }
}

const libraryName = (entry: Entry) => entry.scope === 'plugin' ? `the Studio plugin "${entry.plugin}"` : 'Studio\'s global skill library';
/** Catalog lines show only name and description, so the run location leads the description, where truncation cannot cut it. */
export function locationTag(entry: Pick<Entry, 'scope'> & { parsed?: Pick<Parsed, 'location'> }, vms = true): string {
  const { runsIn, environments } = entry.parsed?.location ?? { runsIn: 'platform', environments: [] };
  if (runsIn === 'platform') return '[Runs in: Studio]';
  if (runsIn === 'sandbox') return '[Runs in: Linux sandbox]';
  if (!vms) return `[Needs engineering software${environments.length ? ` (${environments.join(' or ')})` : ''}; cannot run here: this deployment has no software]`;
  const where = `a VM of ${environments.length ? environments.join(' or ') : 'any environment'}`;
  return entry.scope === 'project' ? `[Runs in: ${where}]` : `[Runs in: ${where}; cannot run here: VMs cannot see ${entry.scope === 'plugin' ? 'plugin' : 'global'} skills]`;
}
/** A skill's folder inside the Linux sandbox: the global library at /skills, the project's F: at /shared, plugins at /plugins. */
export function sandboxPath(entry: Pick<Entry, 'scope' | 'folder' | 'file' | 'directory'>, globalRoot: string): string {
  if (entry.scope === 'project') return `/shared/skills/${entry.folder}${entry.directory ? '/' : ''}`;
  if (entry.scope === 'global') return `/skills/${entry.folder}${entry.directory ? '/' : ''}`;
  return `/plugins/${relative(resolve(globalRoot, '..', 'plugins'), entry.directory ?? entry.file).split(sep).join('/')}${entry.directory ? '/' : ''}`;
}
/** Where the skill's files are and, by its run location, how to run it; shown when the skill is loaded. */
function resourceHint(entry: Entry, globalRoot: string, vms = true): string {
  const location = entry.parsed?.location ?? { runsIn: 'platform', environments: [] };
  if (!vms) return noSoftwareHint(entry, globalRoot, location);
  const folder = entry.directory ? `skills/${entry.folder}/` : 'skills/', windows = `F:\\${folder.replaceAll('/', '\\')}`;
  const files = entry.scope === 'project'
    ? `This skill is in the project shared folder at ${folder} (inside the project's virtual machines: ${windows}). List and read its other files with studio_skill_files, or with studio_list_project_shared / studio_read_project_shared under ${folder}.`
    : `This skill is in ${libraryName(entry)}, which virtual machines cannot see. List and read its other files with studio_skill_files.`;
  const environments = location.environments.length ? `one of these environments: ${location.environments.join(', ')}` : 'any environment';
  const run = location.runsIn === 'platform' ? 'It runs in Studio with Studio\'s own tools; do not start a virtual machine for it.'
    : location.runsIn === 'sandbox' ? `It runs in the Linux sandbox: run its scripts with studio_sandbox_run from ${sandboxPath(entry, globalRoot)} (read-only there; write results to /workspace or /shared). If studio_sandbox_run is not offered in this conversation, the sandbox is switched off or not installed: tell the user plainly that the skill cannot run now, and do not run it in a virtual machine or in Studio instead.`
    : entry.scope === 'project' ? `It runs inside a virtual machine of ${environments}. First check with studio_software_status that this conversation has a ready VM of that environment; if it has none, tell the user which environment is needed and ask before launching one. Then run its scripts with studio_vm_run from ${windows}.`
    : `It is marked to run inside a virtual machine of ${environments}, but virtual machines cannot see ${entry.scope === 'plugin' ? 'plugin' : 'global'} skills, so it cannot run: tell the user to put it into this project's skills (F:\\skills) first. Do not copy its scripts elsewhere to work around this.`;
  return `${files} ${run}`;
}
/** resourceHint of the no-software mode: the same folders, without virtual machines. */
function noSoftwareHint(entry: Entry, globalRoot: string, location: Parsed['location']): string {
  const folder = entry.directory ? `skills/${entry.folder}/` : 'skills/';
  const files = entry.scope === 'project'
    ? `This skill is in the project shared folder at ${folder}. List and read its other files with studio_skill_files, or with studio_list_project_shared / studio_read_project_shared under ${folder}.`
    : `This skill is in ${libraryName(entry)}. List and read its other files with studio_skill_files.`;
  const run = location.runsIn === 'platform' ? 'It runs in Studio with Studio\'s own tools.'
    : location.runsIn === 'sandbox' ? `It runs in the Linux sandbox: run its scripts with studio_sandbox_run from ${sandboxPath(entry, globalRoot)} (read-only there; write results to /workspace or /shared). If studio_sandbox_run is not offered in this conversation, the sandbox is switched off or not installed: tell the user plainly that the skill cannot run now, and do not run it in Studio instead.`
    : 'It needs engineering software, which this deployment does not have, so it cannot run here: tell the user plainly. Do not imitate the software with scripts.';
  return `${files} ${run}`;
}

/** The skill instructions without software: no virtual machines, project skills in the project's shared folder. */
export const NO_SOFTWARE_SKILL_INSTRUCTIONS = [
  'Skills are reusable instructions that users added to this Studio (global library), to this project (the skills folder of its shared folder) or through Studio plugins. The skill catalog lists them; load a skill with the skill tool before following it, and never act on its summary alone.',
  'A user message containing /skill-name asks you to use that skill. Read a skill\'s other files with studio_skill_files only when its instructions need them.',
  'Each catalog entry starts with where the skill runs (runs-in in its SKILL.md metadata):',
  '- [Runs in: Studio]: follow it with Studio\'s own tools.',
  '- [Runs in: Linux sandbox]: run the skill\'s scripts with studio_sandbox_run from the sandbox folder named when the skill is loaded (/skills for global skills, /shared/skills for project skills, /plugins for plugin skills). If studio_sandbox_run is not offered in this conversation, the sandbox is switched off or not installed: tell the user plainly that the skill cannot run now; do not run it in Studio instead.',
  '- [Needs engineering software ...]: this deployment has no engineering software, so the skill cannot run here: tell the user plainly, and do not imitate the software with scripts.',
];

class StudioSkillProvider implements SkillProvider {
  readonly name = 'studio';
  constructor(private readonly library: SkillLibrary, private readonly watched: Map<string, string | undefined>) {}
  async list(options: SkillLookupOptions): Promise<SkillCandidate[]> {
    const projectId = this.library.projectOf(options.cwd);
    this.watch(this.library.globalRoot);
    if (projectId) { const root = this.library.projectRoot(projectId); if (root) this.watch(root); }
    return (await this.library.available(projectId)).map(entry => ({
      name: entry.parsed!.name, description: `${locationTag(entry, this.library.vms)} ${entry.parsed!.description}`, ...(entry.parsed!.whenToUse ? { whenToUse: entry.parsed!.whenToUse } : {}),
      invocation: { modelInvocable: entry.parsed!.modelInvocable, userInvocable: entry.parsed!.userInvocable },
      source: `studio-${entry.scope}`, provider: this.name, rank: entry.scope === 'project' ? 100 : entry.scope === 'global' ? 300 : 400,
      path: entry.file, locator: entry, resourceBase: { kind: 'opaque', description: resourceHint(entry, this.library.globalRoot, this.library.vms) },
      ...(entry.parsed!.metadata ? { metadata: entry.parsed!.metadata } : {}),
    } satisfies SkillCandidate));
  }
  async get(candidate: SkillCandidate): Promise<SkillDefinition | undefined> {
    const entry = candidate.locator as Entry;
    try {
      const parsed = parseSkill(await readFile(entry.file, 'utf8'), fallbackName(entry));
      if (parsed.name !== candidate.name) return;
      return { name: parsed.name, description: `${locationTag({ scope: entry.scope, parsed }, this.library.vms)} ${parsed.description}`, ...(parsed.whenToUse ? { whenToUse: parsed.whenToUse } : {}),
        invocation: { modelInvocable: parsed.modelInvocable, userInvocable: parsed.userInvocable }, source: candidate.source, provider: this.name,
        path: entry.file, resourceBase: { kind: 'opaque', description: resourceHint({ ...entry, parsed }, this.library.globalRoot, this.library.vms) }, ...(parsed.metadata ? { metadata: parsed.metadata } : {}), content: parsed.content };
    } catch { return; }
  }
  private watch(root: string) { if (!this.watched.has(root)) this.watched.set(root, undefined); }
}

const scopeOf = (value: unknown): SkillScope => { if (value === 'plugin') throw new Error('插件里的技能请在“插件”页面管理'); if (value !== 'global' && value !== 'project') throw new Error('技能范围无效'); return value; };
const text = (value: unknown, key: string): string => { if (typeof value !== 'string' || !value) throw new Error(`缺少 ${key}`); return value; };
const optionalProject = (scope: SkillScope, value: unknown): string | undefined => scope === 'project' ? text(value, 'projectId') : undefined;
function decode(data: unknown, path: string): Uint8Array {
  if (typeof data !== 'string') throw new Error(`文件内容无效：${path}`);
  return Buffer.from(data, 'base64');
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const library = new SkillLibrary(ctx, config);
  await library.start();
  const watched = new Map<string, string | undefined>();
  let control: SkillProviderControl | undefined;
  ctx.effect(() => ctx.skills.registerProvider(next => { control = next; return new StudioSkillProvider(library, watched); }), 'studio-skills: provider');
  const changed = () => control?.invalidate();
  ctx.effect(() => ctx.provide('studioSkills', { library, changed } satisfies StudioSkillsService), 'studio-skills: service');
  ctx.effect(() => {
    let running = false;
    const timer = setInterval(() => {
      if (running) return; running = true;
      void (async () => {
        let dirty = false;
        for (const [root, previous] of watched) {
          const next = await library.signature(root);
          if (previous !== undefined && next !== previous) dirty = true;
          watched.set(root, next);
        }
        if (dirty) changed();
      })().finally(() => { running = false; });
    }, config.pollMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }, 'studio-skills: change poll');
  ctx.effect(() => ctx.studio.registerInstructions('skills', 112, (library.vms ? [
    'Skills are reusable instructions that users added to this Studio (global library), to this project (F:\\skills) or through Studio plugins. The skill catalog lists them; load a skill with the skill tool before following it, and never act on its summary alone.',
    'A user message containing /skill-name asks you to use that skill. Read a skill\'s other files with studio_skill_files only when its instructions need them.',
    'Each catalog entry starts with where the skill runs (runs-in in its SKILL.md metadata):',
    '- [Runs in: Studio]: follow it with Studio\'s own tools. It needs no virtual machine.',
    '- [Runs in: a VM of ...]: it drives engineering software inside a Windows virtual machine, and only a project skill can run, because only the project\'s F:\\skills folder is visible inside its VMs. First check with studio_software_status that this conversation has a ready VM of one of the listed environments. If it has none, tell the user which environment the skill needs and ask whether to start one; do not launch it on your own. Then run the skill\'s scripts with studio_vm_run from F:\\skills\\<skill folder>\\. Virtual machines belong to task conversations: in a project conversation, tell the user to use the skill in a task\'s conversation. A global or plugin skill marked to run in a VM cannot run: tell the user to put it into this project\'s skills, and do not copy its scripts elsewhere to work around this.',
    '- [Runs in: Linux sandbox]: run the skill\'s scripts with studio_sandbox_run from the sandbox folder named when the skill is loaded (/skills for global skills, /shared/skills for project skills, /plugins for plugin skills). If studio_sandbox_run is not offered in this conversation, the sandbox is switched off or not installed: tell the user plainly that the skill cannot run now; do not run it in a virtual machine or in Studio instead.',
    'Never start a virtual machine only to run a script that needs no engineering software.',
  ] : NO_SOFTWARE_SKILL_INSTRUCTIONS).join('\n')), 'studio-skills: instructions');

  const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] };
  ctx.tools.register(defineTool({ name: 'studio_skill_files',
    description: 'List or read the files bundled with one skill from this conversation\'s skill catalog (for one name a project skill wins over a global one, which wins over a plugin\'s). Without path, list the skill\'s files with sizes; with a relative path, read one text file (binary files report their size only; text over 256 KB is truncated). Read-only.',
    parameters: { skill: { type: 'string', required: true, description: 'Exact skill name from the catalog.' }, path: { type: 'string', description: 'Relative file path inside the skill folder, from the listing.' } }, output,
    async execute(args, exec) {
      throwIfAborted(exec.signal);
      const { projectId } = ctx.studio.graphPlanningScope(exec.agent);
      const entry = (await library.available(projectId)).find(row => row.parsed!.name === args.skill);
      if (!entry) throw new Error(`Unknown or disabled skill "${args.skill}"`);
      return JSON.stringify(args.path ? await library.readText(entry, args.path) : { skill: args.skill, scope: entry.scope, files: await library.files(entry) });
    } }));

  const routes: [string, string[], (request: Request) => Promise<unknown>][] = [
    ['/api/studio/skills', ['GET'], async request => {
      const query = Object.fromEntries(new URL(request.url).searchParams);
      return library.view(query.projectId || undefined);
    }],
    ['/api/studio/skills/available', ['GET'], async request => {
      const projectId = text(new URL(request.url).searchParams.get('projectId'), 'projectId');
      ctx.studioDomain.graph(projectId);
      return { skills: (await library.available(projectId)).map(entry => ({ name: entry.parsed!.name, description: entry.parsed!.description, scope: entry.scope, userInvocable: entry.parsed!.userInvocable,
        runsIn: entry.parsed!.location.runsIn, environments: entry.parsed!.location.environments, ...(entry.plugin ? { plugin: entry.plugin } : {}) })) };
    }],
    ['/api/studio/skills/file', ['GET'], async request => {
      const query = Object.fromEntries(new URL(request.url).searchParams);
      const entry = query.scope === 'plugin' ? await library.find('plugin', undefined, text(query.folder, 'folder'), text(query.plugin, 'plugin'))
        : await (async () => { const scope = scopeOf(query.scope); return library.find(scope, optionalProject(scope, query.projectId), text(query.folder, 'folder')); })();
      return { folder: entry.folder, files: await library.files(entry), skill: await library.readText(entry, basename(entry.file)), ...(query.path ? { file: await library.readText(entry, query.path) } : {}) };
    }],
    ['/api/studio/skills/toggle', ['POST'], async request => {
      const data = await request.json() as Record<string, unknown>, scope = scopeOf(data.scope);
      if (typeof data.enabled !== 'boolean') throw new Error('缺少 enabled');
      await library.toggle(scope, optionalProject(scope, data.projectId), text(data.name, 'name'), data.enabled); changed();
      return { saved: true };
    }],
    ['/api/studio/skills/save', ['POST'], async request => {
      const data = await request.json() as Record<string, unknown>, scope = scopeOf(data.scope);
      const skill = await library.saveText(scope, optionalProject(scope, data.projectId), text(data.content, 'content'), data.folder === undefined ? undefined : text(data.folder, 'folder'));
      changed(); return skill;
    }],
    ['/api/studio/skills/upload', ['POST'], async request => {
      const data = await request.json() as Record<string, unknown>, scope = scopeOf(data.scope), projectId = optionalProject(scope, data.projectId);
      let files: { path: string; data: Uint8Array }[];
      if (typeof data.zip === 'string') {
        const archive = await extractZip(Buffer.from(data.zip, 'base64'), request.signal, { maxEntries: LIMITS.files * 2, maxTotalBytes: LIMITS.bytes, maxFileBytes: LIMITS.bytes });
        files = archive.entries.flatMap(entry => entry.type === 'file' ? [{ path: entry.path, data: entry.data }] : []);
      } else if (Array.isArray(data.files)) files = data.files.map(row => { const file = row as Record<string, unknown>, path = text(file.path, 'path'); return { path, data: decode(file.data, path) }; });
      else throw new Error('请上传技能文件夹、ZIP 或 SKILL.md');
      const skill = await library.install(scope, projectId, files, data.overwrite === true);
      changed(); return skill;
    }],
    ['/api/studio/skills/delete', ['POST'], async request => {
      const data = await request.json() as Record<string, unknown>, scope = scopeOf(data.scope);
      await library.remove(scope, optionalProject(scope, data.projectId), text(data.folder, 'folder')); changed();
      return { deleted: true };
    }],
  ];
  // The editor's run-location picker: reads it from SKILL.md text, or writes it back keeping the rest. Changes nothing on disk.
  ctx.connection.fetch.register({ path: '/api/studio/skills/location', methods: ['POST'], requestBody: 'buffered', async fetch(request) {
    try {
      const data = await request.json() as Record<string, unknown>, content = text(data.content, 'content');
      if (data.runsIn === undefined) return Response.json({ content, location: parseSkill(content, 'skill').location });
      if (data.environments !== undefined && !Array.isArray(data.environments)) throw new Error('environments 格式无效');
      const next = setSkillLocation(content, { runsIn: data.runsIn as SkillRunsIn, environments: (data.environments as unknown[] | undefined ?? []).map(String) });
      return Response.json({ content: next, location: parseSkill(next, 'skill').location });
    } catch (error) { return Response.json({ error: error instanceof Error ? error.message : '运行位置无法读取' }, { status: 400 }); }
  } });
  for (const [path, methods, action] of routes) ctx.connection.fetch.register({ path, methods: methods as ('GET' | 'POST')[], requestBody: 'buffered', async fetch(request) {
    try { return Response.json(await ctx.studioDomain.webAction(request, () => action(request))); }
    catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : '';
      const message = ['EPERM', 'EACCES', 'EROFS'].includes(code) ? '没有写权限' : code === 'ENOSPC' ? '磁盘空间不足' : error instanceof Error ? error.message : '技能操作失败';
      return Response.json({ error: message, ...(code === 'SKILL_EXISTS' ? { exists: true } : {}) }, { status: code === 'SKILL_EXISTS' ? 409 : 400 });
    }
  } });
}
