/** Owned upload originals plus the pinned Harness image-admission seam; no upstream patches. */
import type { AttachmentStore, ImageAttachmentRef, SaveImageAttachment } from '@deepseek-ai/dsh-attachment';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { constants } from 'node:fs';
import { mkdir, open, lstat, realpath, rename, rm, mkdtemp, readdir } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { CHAT_ATTACHMENT_LIMITS as limits } from './chat-attachment-types.ts';
import type { ChatAttachmentUpload, ChatAttachmentOwner, ChatAttachmentView } from './chat-attachment-types.ts';
import { removeManagedDirectory } from './managed-delete.ts';

const chatPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uploadPattern = /^[0-9a-f]{32}$/;
const imagePattern = /^sha256:[0-9a-f]{64}$/;
const maxManifestBytes = 4 * 1024 * 1024;
const absent = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';
const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
interface StoredUpload extends ChatAttachmentView { originalSha256: string }
interface Manifest { version: 1; owner: ChatAttachmentOwner; uploads: StoredUpload[] }

/** Reject unsupported or unadvertised vision before accepting an upload or creating a turn. */
export function assertAttachmentVision(modelInfo: { inputModalities?: readonly string[] }): void {
  if (!modelInfo.inputModalities?.includes('image')) throw new Error('当前模型未声明支持图片输入，请选择支持视觉的模型后上传设计图或图纸。');
}

/** Validate the complete wire batch before storage, including canonical base64 and real byte limits. */
export function parseChatAttachmentUploads(value: unknown): ChatAttachmentUpload[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > limits.maxUploads) throw new Error(`每条消息最多上传 ${limits.maxUploads} 个参考文件。`);
  let total = 0;
  return value.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('上传文件参数无效。');
    const row = raw as Record<string, unknown>;
    if (Object.keys(row).some(key => !['name', 'mediaType', 'data'].includes(key)) || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 255) throw new Error('上传文件名无效。');
    if (!['image/png', 'image/jpeg', 'image/webp', 'application/pdf'].includes(String(row.mediaType))) throw new Error('参考文件目前支持 PNG、JPEG、WebP 和 PDF；CAD/EDA 原生文件请先导出图片或 PDF。');
    if (typeof row.data !== 'string' || !row.data.length || row.data.length > 4 * Math.ceil(limits.maxFileBytes / 3)
      || row.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(row.data)) throw new Error('参考文件编码无效或超过 10 MiB。');
    const data = Buffer.from(row.data, 'base64');
    if (!data.length || data.length > limits.maxFileBytes || data.toString('base64') !== row.data) throw new Error('参考文件编码无效或超过 10 MiB。');
    total += data.length;
    if (total > limits.maxTotalBytes) throw new Error('每条消息的参考文件总大小不能超过 20 MiB。');
    const name = basename(row.name.replaceAll('\\', '/')).replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (!name || ['.', '..'].includes(name)) throw new Error('上传文件名无效。');
    return { name, mediaType: row.mediaType as ChatAttachmentUpload['mediaType'], data: row.data };
  });
}

/** Private per-chat original storage, with normalized images delegated to Harness attachment-local. */
export class ChatAttachments {
  private readonly root: string;
  private mutations: Promise<unknown> = Promise.resolve();
  private readonly renderer: string;
  constructor(dataRoot: string, private readonly store: AttachmentStore, options: { pdfRendererPath?: string } = {}) {
    this.root = join(resolve(dataRoot), 'chat-attachments');
    this.renderer = options.pdfRendererPath ?? 'pdftoppm';
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.catch(() => undefined).then(operation); this.mutations = result; return result;
  }
  private owner(value: ChatAttachmentOwner): ChatAttachmentOwner {
    if (!chatPattern.test(value.id) || !['project', 'task'].includes(value.scope)
      || typeof value.projectId !== 'string' || !value.projectId || value.projectId.length > 128
      || (value.scope === 'project' ? value.taskId !== undefined : typeof value.taskId !== 'string' || !value.taskId || value.taskId.length > 128)) throw new Error('参考文件会话归属无效。');
    return { id: value.id, scope: value.scope, projectId: value.projectId, ...(value.scope === 'task' ? { taskId: value.taskId } : {}) };
  }
  private async directory(path: string): Promise<void> {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('拒绝读取已改变的参考文件目录。');
    // Parent aliases such as macOS /tmp are legitimate; each managed path itself must be a real directory.
    const actual = await realpath(path), parent = await realpath(resolve(path, '..'));
    if (actual !== join(parent, basename(path))) throw new Error('参考文件目录归属已改变。');
  }
  private async ensure(owner: ChatAttachmentOwner): Promise<string> {
    await this.directory(resolve(this.root, '..'));
    await mkdir(this.root, { mode: 0o700 }).catch(error => { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error; });
    await this.directory(this.root);
    const directory = join(this.root, owner.id);
    await mkdir(directory, { mode: 0o700 }).catch(error => { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error; });
    await this.directory(directory); return directory;
  }
  private async readBytes(path: string, maxBytes: number): Promise<Buffer> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(error => {
      // Keep ENOENT for internal empty-manifest detection without disclosing host paths.
      throw Object.assign(new Error('参考文件读取失败，文件可能已被删除或替换。'), { code: error.code });
    });
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > maxBytes) throw new Error('参考文件不是有效的普通文件，或超过读取限制。');
      const data = await handle.readFile();
      if (data.length > maxBytes) throw new Error('参考文件超过读取限制。');
      return data;
    } finally { await handle.close(); }
  }
  private async manifest(owner: ChatAttachmentOwner): Promise<Manifest> {
    const directory = join(this.root, owner.id);
    try { await this.directory(this.root); await this.directory(directory); }
    catch (error) { if (absent(error)) return { version: 1, owner, uploads: [] }; throw error; }
    let raw: Manifest;
    try { raw = JSON.parse((await this.readBytes(join(directory, 'manifest.json'), maxManifestBytes)).toString('utf8')); }
    catch (error) { if (absent(error)) return { version: 1, owner, uploads: [] }; throw error; }
    if (raw?.version !== 1 || JSON.stringify(raw.owner) !== JSON.stringify(owner) || !Array.isArray(raw.uploads)) throw new Error('参考文件不属于当前对话。');
    const ids = new Set<string>();
    for (const row of raw.uploads) {
      if (!row || !uploadPattern.test(row.id) || ids.has(row.id) || typeof row.name !== 'string' || !row.name || row.name.length > 255
        || !['image/png', 'image/jpeg', 'image/webp', 'application/pdf'].includes(row.mediaType)
        || !Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > limits.maxFileBytes || !/^[0-9a-f]{64}$/.test(row.originalSha256)
        || typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt)) || !Array.isArray(row.images) || !row.images.length || row.images.length > limits.maxImages) throw new Error('参考文件清单损坏。');
      ids.add(row.id);
      for (const ref of row.images) if (!ref || !imagePattern.test(String(ref.attachmentId)) || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(ref.mediaType)
        || !Number.isSafeInteger(ref.bytes) || ref.bytes < 1 || !Number.isSafeInteger(ref.width) || ref.width < 1 || !Number.isSafeInteger(ref.height) || ref.height < 1) throw new Error('参考图片清单损坏。');
    }
    return raw;
  }
  private view(row: StoredUpload): ChatAttachmentView {
    const { originalSha256: _digest, ...view } = row; return structuredClone(view);
  }
  async list(value: ChatAttachmentOwner): Promise<ChatAttachmentView[]> {
    const owner = this.owner(value); return (await this.manifest(owner)).uploads.map(row => this.view(row));
  }
  private async pdfEnvironment(temporary: string): Promise<NodeJS.ProcessEnv> {
    const cache = join(temporary, 'font-cache'); await mkdir(cache, { mode: 0o700 });
    const configured = process.env.FONTCONFIG_FILE;
    if (configured) {
      try {
        const filename = resolve(configured), contents = (await this.readBytes(filename, 1024 * 1024)).toString('utf8');
        if (/<fontconfig(?:\s[^>]*)?>[\s\S]*<\/fontconfig\s*>/u.test(contents)) {
          // Respect an explicitly supplied readable configuration. XDG-style
          // caches still remain private to this conversion.
          return { ...process.env, FONTCONFIG_FILE: filename, XDG_CACHE_HOME: cache };
        }
      } catch { /* Broken bundled or administrator paths use a private fallback. */ }
    }
    const candidates = process.platform === 'darwin' ? ['/System/Library/Fonts', '/Library/Fonts']
      : process.platform === 'win32' ? [join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts')]
      : ['/usr/share/fonts', '/usr/local/share/fonts'];
    const directories: string[] = [];
    for (const path of candidates) {
      try { if ((await lstat(path)).isDirectory()) directories.push(path); } catch { /* Optional platform font directory. */ }
    }
    if (!directories.length) throw new Error('服务器没有可用的标准字体目录，无法可靠预览带文字的 PDF；请先导出 PNG、JPEG 或 WebP。');
    const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
    const filename = join(temporary, 'fonts.conf');
    const aliases = [['Helvetica', 'Arial', 'Liberation Sans', 'DejaVu Sans'], ['sans-serif', 'Arial', 'Liberation Sans', 'DejaVu Sans'],
      ['Times', 'Times New Roman', 'Liberation Serif', 'DejaVu Serif'], ['serif', 'Times New Roman', 'Liberation Serif', 'DejaVu Serif'],
      ['Courier', 'Courier New', 'Liberation Mono', 'DejaVu Sans Mono'], ['monospace', 'Courier New', 'Liberation Mono', 'DejaVu Sans Mono']];
    await this.write(filename, `<?xml version="1.0"?>\n<fontconfig>\n${directories.map(path => `<dir>${xml(path)}</dir>`).join('\n')}\n<cachedir>${xml(cache)}</cachedir>\n${aliases.map(([family, ...preferred]) => `<alias><family>${xml(family!)}</family><prefer>${preferred.map(name => `<family>${xml(name)}</family>`).join('')}</prefer></alias>`).join('\n')}\n</fontconfig>\n`);
    return { ...process.env, FONTCONFIG_FILE: filename, FONTCONFIG_PATH: temporary, XDG_CACHE_HOME: cache };
  }
  private async renderPdf(data: Buffer, temporary: string, name: string): Promise<SaveImageAttachment[]> {
    if (data.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('PDF 文件头无效，请导出为 PNG、JPEG 或 WebP 后重试。');
    const input = join(temporary, 'input.pdf'), prefix = join(temporary, 'page');
    await this.write(input, data);
    const environment = await this.pdfEnvironment(temporary);
    await new Promise<void>((accept, reject) => {
      const child = spawn(this.renderer, ['-f', '1', '-l', String(limits.maxPdfPages + 1), '-r', '100', '-scale-to', String(limits.maxImageDimension), '-png', input, prefix], { shell: false, env: environment, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      let settled = false, diagnostic = '';
      const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : accept(); };
      const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('PDF 预览转换超时，请将需要对齐的页面导出为 PNG、JPEG 或 WebP。')); }, 20000);
      child.stderr.on('data', chunk => { if (diagnostic.length < 4096) diagnostic += String(chunk).slice(0, 4096 - diagnostic.length); });
      child.once('error', () => finish(new Error('服务器未能启动 PDF 转换器（pdftoppm），请将图纸导出为 PNG、JPEG 或 WebP。')));
      child.once('close', code => finish(code === 0 ? undefined : new Error(/password|encrypted/i.test(diagnostic) ? 'PDF 已加密或需要密码，请上传未加密的 PDF 或导出为图片。' : 'PDF 无法转换为预览，请上传有效的 PDF 或导出为 PNG、JPEG、WebP。')));
    });
    const pages = (await readdir(temporary)).filter(file => /^page-\d+\.png$/.test(file)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
    if (!pages.length) throw new Error('PDF 中没有可读取的页面，请导出为图片。');
    if (pages.length > limits.maxPdfPages) throw new Error(`每份 PDF 最多 ${limits.maxPdfPages} 页，请拆分或仅上传需要对齐的页面。`);
    return Promise.all(pages.map(async (page, index) => ({ data: await this.readBytes(join(temporary, page), limits.maxFileBytes), mediaType: 'image/png' as const, name: `${name} · 第 ${index + 1} 页` })));
  }
  private async write(path: string, data: string | Uint8Array): Promise<void> {
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
  }
  async admit(value: ChatAttachmentOwner, uploads: unknown): Promise<{ content: ContentBlock[]; attachments: ChatAttachmentView[] }> {
    const owner = this.owner(value), parsed = parseChatAttachmentUploads(uploads);
    if (!parsed.length) return { content: [], attachments: [] };
    return this.serial(async () => {
      const directory = await this.ensure(owner), current = await this.manifest(owner), temporary = await mkdtemp(join(directory, '.upload-'));
      const originalPaths: string[] = []; let published = false;
      try {
        const prepared: { id: string; input: ChatAttachmentUpload; data: Buffer; images: SaveImageAttachment[] }[] = [];
        for (const input of parsed) {
          const data = Buffer.from(input.data, 'base64'), id = randomUUID().replaceAll('-', '');
          const pdfDirectory = join(temporary, id);
          if (input.mediaType === 'application/pdf') await mkdir(pdfDirectory, { mode: 0o700 });
          const images = input.mediaType === 'application/pdf' ? await this.renderPdf(data, pdfDirectory, input.name)
            : [{ data, mediaType: input.mediaType, name: input.name }];
          prepared.push({ id, input, data, images });
          if (prepared.reduce((total, row) => total + row.images.length, 0) > limits.maxImages) throw new Error(`每条消息最多包含 ${limits.maxImages} 张图片（包括 PDF 页面），请拆分发送。`);
        }
        const refs = await this.store.saveImages(prepared.flatMap(row => row.images));
        let cursor = 0; const createdAt = new Date().toISOString();
        const added: StoredUpload[] = [], content: ContentBlock[] = [];
        for (const row of prepared) {
          const images = refs.slice(cursor, cursor + row.images.length) as ImageAttachmentRef[]; cursor += row.images.length;
          const stored = { id: row.id, name: row.input.name, mediaType: row.input.mediaType, bytes: row.data.length, createdAt, images, originalSha256: digest(row.data) };
          const path = join(directory, `${row.id}.original`); await this.write(path, row.data); originalPaths.push(path); added.push(stored);
          content.push({ type: 'text', text: `\n[用户提供的参考文件：${stored.name}；附件 ID ${stored.id}；${stored.mediaType === 'application/pdf' ? `PDF 已转换为 ${images.length} 页图片，供视觉对齐；不代表 CAD 几何或精确尺寸解析。` : '以下为实际提供给模型的参考图片；图中尺寸与设计约束仍需向用户确认。'}]\n` });
          images.forEach(attachment => content.push({ type: 'image', attachment }));
        }
        const manifestPath = join(temporary, 'manifest.json');
        const manifest = JSON.stringify({ version: 1, owner, uploads: [...current.uploads, ...added] }) + '\n';
        if (Buffer.byteLength(manifest) > maxManifestBytes) throw new Error('当前对话的参考文件清单已达到容量上限，请创建新对话继续。');
        await this.write(manifestPath, manifest);
        await this.directory(directory); await rename(manifestPath, join(directory, 'manifest.json')); published = true;
        const handle = await open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); }
        return { content, attachments: added.map(row => this.view(row)) };
      } catch (error) { if (!published) for (const path of originalPaths) await rm(path, { force: true }); throw error; }
      finally { await rm(temporary, { recursive: true, force: true }); }
    });
  }
  async read(value: ChatAttachmentOwner, attachmentId: string, page?: number): Promise<{ data: Uint8Array; mediaType: string; name: string }> {
    const owner = this.owner(value);
    if (!uploadPattern.test(attachmentId)) throw new Error('参考文件标识无效。');
    const row = (await this.manifest(owner)).uploads.find(item => item.id === attachmentId);
    if (!row) throw new Error('参考文件不属于当前对话。');
    if (page !== undefined) {
      if (!Number.isSafeInteger(page) || page < 1 || page > row.images.length) throw new Error('参考文件页码无效。');
      const stored = await this.store.readImage(row.images[page - 1]!);
      return { data: stored.data, mediaType: stored.ref.mediaType, name: stored.ref.name ?? row.name };
    }
    const data = await this.readBytes(join(this.root, owner.id, `${row.id}.original`), limits.maxFileBytes);
    if (data.length !== row.bytes || digest(data) !== row.originalSha256) throw new Error('参考文件原件完整性检查失败。');
    return { data, mediaType: row.mediaType, name: row.name };
  }
  async remove(chatIds: string[]): Promise<void> {
    return this.serial(async () => {
      try { await this.directory(this.root); } catch (error) { if (absent(error)) return; throw error; }
      for (const id of chatIds) {
        if (!chatPattern.test(id)) throw new Error('参考文件会话标识无效。');
        await removeManagedDirectory(this.root, join(this.root, id));
      }
    });
  }
}
