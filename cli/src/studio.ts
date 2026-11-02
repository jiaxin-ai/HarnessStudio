/** Studio's HTTP API, as this client uses it. Uploads and downloads stream; nothing large is held in memory. */
import { createReadStream, createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CommandError } from './args.ts';
import type { GraphTask, ModelChoice, ModelsView, Project, QuestionView, RunDetail, StatusView } from './types.ts';

/** A refusal from Studio ({error} with a 4xx status), as opposed to not reaching it at all. */
export class StudioError extends Error {
  override name = 'StudioError';
  readonly status: number;
  readonly code: string | undefined;
  constructor(message: string, status: number, code?: string) { super(message); this.status = status; this.code = code; }
}
/** Studio could not be reached at all (refused, timed out, reset). */
export class ConnectionError extends Error { override name = 'ConnectionError'; }
const REQUEST_TIMEOUT_MS = 30_000;

export function normalizeUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new CommandError(`Studio 地址写法不对：${value}（例如 http://10.0.0.5:3080）`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new CommandError(`Studio 地址要以 http:// 或 https:// 开头，不能带用户名、查询参数或 #：${value}`);
  return `${url.origin}${url.pathname.replace(/\/+$/u, '')}`;
}
/** The page route of plugins/ui/src/client.tsx: the project lives in the URL hash. */
export const projectUrl = (base: string, projectId: string) => `${base}/#${new URLSearchParams({ project: projectId })}`;

const reason = (error: unknown): string => {
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  if (error instanceof Error && error.name === 'TimeoutError') return '等待超时';
  return cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : String(error));
};

export class Studio {
  readonly base: string;
  constructor(base: string) { this.base = normalizeUrl(base); }
  private url(path: string, query?: Record<string, string>) { return `${this.base}/api/studio/${path}${query ? `?${new URLSearchParams(query)}` : ''}`; }
  private async send(path: string, init: RequestInit & { query?: Record<string, string> }, signal?: AbortSignal, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
    const signals = [AbortSignal.timeout(timeoutMs), ...signal ? [signal] : []];
    try { return await fetch(this.url(path, init.query), { ...init, signal: AbortSignal.any(signals) }); }
    catch (error) {
      if (signal?.aborted) throw error;
      throw new ConnectionError(`连不上 Studio（${this.base}）：${reason(error)}`, { cause: error });
    }
  }
  private async json<T>(response: Response): Promise<T> {
    const text = await response.text();
    let value: unknown;
    try { value = text ? JSON.parse(text) : undefined; } catch { value = undefined; }
    if (!response.ok) {
      const body = value as { error?: unknown; code?: unknown } | undefined;
      const message = typeof body?.error === 'string' ? body.error : response.status === 404 ? '这台 Studio 没有这个接口，可能版本太旧' : `Studio 返回了错误（HTTP ${response.status}）`;
      throw new StudioError(message, response.status, typeof body?.code === 'string' ? body.code : undefined);
    }
    if (value === undefined) throw new StudioError(`Studio 的回复不是 JSON（HTTP ${response.status}）`, response.status);
    return value as T;
  }
  get<T>(path: string, query?: Record<string, string>, signal?: AbortSignal): Promise<T> {
    return this.send(path, { method: 'GET', ...query ? { query } : {} }, signal).then(response => this.json<T>(response));
  }
  post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    return this.send(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, signal).then(response => this.json<T>(response));
  }

  models(signal?: AbortSignal) { return this.get<ModelsView>('models', undefined, signal); }
  status(signal?: AbortSignal) { return this.get<StatusView>('status', undefined, signal); }
  createProject(title: string, signal?: AbortSignal) { return this.post<Project>('projects', { title }, signal); }
  graph(projectId: string, signal?: AbortSignal) { return this.get<{ tasks: GraphTask[] }>('graph', { projectId }, signal); }
  startRun(body: { projectId: string; objective: string; settings: Record<string, unknown> }, signal?: AbortSignal) { return this.post<RunDetail>('autonomy/start', body, signal); }
  run(id: string, signal?: AbortSignal) { return this.get<RunDetail>('autonomy/run', { id }, signal); }
  stopRun(id: string, revision: number, signal?: AbortSignal) { return this.post<RunDetail>('autonomy/stop', { id, revision }, signal); }
  questions(chatId: string, signal?: AbortSignal) { return this.get<QuestionView>('chat/questions', { id: chatId }, signal); }
  answer(chatId: string, callId: string, answers: unknown[], signal?: AbortSignal) { return this.post<{ accepted: true }>('chat/questions/answer', { id: chatId, callId, answers }, signal); }

  /** One file to the root of the project's shared folder (F: in its VMs), streamed from disk. */
  async upload(projectId: string, target: string, source: string, bytes: number, signal?: AbortSignal): Promise<void> {
    const body = Readable.toWeb(createReadStream(source)) as ReadableStream<Uint8Array>;
    const response = await this.send('project/shared/upload', { method: 'POST', query: { projectId, path: target }, headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes) }, body, duplex: 'half' } as RequestInit & { duplex: 'half'; query: Record<string, string> }, signal, 60 * 60_000);
    await this.json(response);
  }

  /**
   * The project export as a ZIP, streamed to `file` through `file.part` so a broken download never looks finished.
   * Videos can make it several GB, so the deadline is for the server to start answering and then for silence.
   */
  async download(projectId: string, video: boolean, file: string, signal?: AbortSignal): Promise<number> {
    const query = { projectId, snapshots: '1', video: video ? '1' : '0', workspace: '1' };
    const response = await this.send('project/export', { method: 'GET', query }, signal, 10 * 60_000);
    if (!response.ok || !response.body) await this.json(response);
    const part = `${file}.part`, idle = new AbortController();
    let bytes = 0, timer: NodeJS.Timeout | undefined;
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => idle.abort(new Error('导出中途超过 2 分钟没有数据')), 120_000); };
    const count = new Transform({ transform(chunk: Buffer, _encoding, done) { bytes += chunk.length; arm(); done(null, chunk); } });
    try {
      arm();
      await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>), count, createWriteStream(part), { signal: AbortSignal.any([idle.signal, ...signal ? [signal] : []]) });
      await rename(part, file);
      return bytes;
    } catch (error) {
      await rm(part, { force: true });
      throw idle.signal.aborted ? idle.signal.reason as Error : error;
    } finally { clearTimeout(timer); }
  }
}

/** The models people can choose on the page (plugins/ui/src/workbench.tsx): configured providers plus the test adapters. */
export interface Catalog { choices: ModelChoice[]; unkeyed: Set<string>; defaults?: ModelChoice }
export function catalog(models: ModelsView, status: StatusView): Catalog {
  const choices = models.providers.flatMap(provider => provider.models.map(model => ({ provider: provider.id, model: model.id })));
  if (status.providers.some(row => row.id === 'studio-smoke')) choices.push({ provider: 'studio-smoke', model: 'm1-smoke' });
  if (status.providers.some(row => row.id === 'studio-vision-smoke')) choices.push({ provider: 'studio-vision-smoke', model: 'vision-smoke' });
  const unkeyed = new Set(models.providers.filter(provider => provider.credentialConfigured === false).map(provider => provider.id));
  const { provider, model } = models.defaults ?? { provider: '', model: '' };
  return { choices, unkeyed, ...provider && model ? { defaults: { provider, model } } : {} };
}
/** `model` alone when one provider has it, `provider/model` otherwise. Returns a message for people when it cannot decide. */
export function resolveModel(name: string, models: Catalog): ModelChoice | string {
  const found = models.choices.filter(choice => choice.model === name || `${choice.provider}/${choice.model}` === name);
  const unique = [...new Map(found.map(choice => [`${choice.provider}/${choice.model}`, choice])).values()];
  if (unique.length === 1) {
    const [choice] = unique as [ModelChoice];
    return models.unkeyed.has(choice.provider) ? `模型 ${name} 所在的 ${choice.provider} 还没有填 API Key，请先在 Studio「模型配置」里填好` : choice;
  }
  if (unique.length > 1) return `有多个 provider 都有模型 ${name}（${unique.map(choice => choice.provider).join('、')}），请写成 provider/模型名，例如 ${unique[0]!.provider}/${name}`;
  const names = models.choices.map(choice => `${choice.provider}/${choice.model}`);
  return `Studio「模型配置」里没有模型 ${name}。${names.length ? `可以用的有：${names.join('、')}` : '那里还没有配置任何模型'}`;
}
