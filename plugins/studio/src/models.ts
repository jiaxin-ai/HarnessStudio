import type { Context, Volatile } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection';
import type {} from '@deepseek-ai/dsh-settings';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { supportedProtocols } from '@deepseek-ai/dsh-llm-pi-ai';
import { PUBLIC_BASE_URL } from '@deepseek-ai/dsh-llm-deepseek';
import z from '@deepseek-ai/schemastery';

export const name = 'harnessstudio-model-settings';
export const inject = ['llm', 'credentials', 'settings', 'connection'];
export interface Config { defaultProvider: Volatile<string>; defaultModel: Volatile<string> }
export const Config = z.object({ defaultProvider: z.string().default('').volatile(), defaultModel: z.string().default('').volatile() });
const official = 'deepseek-official';
const customNamespace = 'llm-configurable';
const defaultsNamespace = 'studio-model-settings';
const protocols = ['deepseek-messages', ...supportedProtocols()];
type Row = Record<string, unknown>;
function object(value: unknown): Row {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置必须为对象');
  return value as Row;
}
function text(value: unknown, label: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label}不能为空且须在长度限制内`);
  return value.trim();
}
function capacity(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 10_000_000) throw new Error(`${label}须为有效正整数`);
  return value as number;
}
function endpoint(value: unknown): string {
  const input = text(value, 'API 地址', 2000);
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('API 地址格式不正确'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('API 地址须为 HTTP(S)，且不能含凭据、查询参数或片段');
  }
  return input.replace(/\/+$/, '');
}

declare module '@deepseek-ai/cordis' { interface Context { studioModels: StudioModels } }

/** Narrow settings surface over DSH's official live configuration and credential seams. */
export class StudioModels {
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private readonly ctx: Context, private readonly config: Config) {}
  defaults() { return { provider: this.config.defaultProvider.get(), model: this.config.defaultModel.get() }; }
  private descriptor(ns: string) {
    const descriptor = this.ctx.settings.describe({ redactSecrets: true }).find(row => row.ns === ns);
    if (!descriptor) throw new Error('模型配置尚未就绪');
    return descriptor;
  }
  private keyRef(id: string) { return credentialRef(id === official ? 'DEEPSEEK_API_KEY' : `STUDIO_PROVIDER_${id.toUpperCase().replaceAll('-', '_')}`); }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.catch(() => undefined).then(operation); this.writes = result; return result;
  }
  async view() {
    const deepseek = this.descriptor('llm-deepseek');
    const custom = this.descriptor(customNamespace);
    const defaults = this.descriptor(defaultsNamespace);
    const declared = object(object(custom.value).providers ?? {});
    const deepseekValue = object(deepseek.value);
    const candidates = [
      { id: official, value: deepseekValue, revision: deepseek.revision, protocol: 'deepseek-messages', name: 'DeepSeek' },
      ...Object.entries(declared).map(([id, raw]) => { const value = object(raw); return {
        id, value, revision: custom.revision, protocol: String(value.api), name: String(value.displayName ?? id),
      }; }),
    ];
    const providers = await Promise.all(candidates.map(async ({ id, value, revision, protocol, name }) => {
      const credential = await this.ctx.credentials.describe(this.keyRef(id));
      const models = Array.isArray(value.models) ? await Promise.all(value.models.map(async raw => {
        const model = object(raw);
        let supportsImages = false;
        try { supportsImages = (await this.ctx.llm.resolveModelInfo(id, String(model.id))).inputModalities?.includes('image') === true; }
        catch { /* An unresolved model cannot truthfully advertise visual input. */ }
        return { id: String(model.id), ...(typeof model.contextWindow === 'number' ? { contextWindow: model.contextWindow } : {}),
          ...(typeof model.maxTokens === 'number' ? { maxTokens: model.maxTokens } : typeof value.maxTokens === 'number' ? { maxTokens: value.maxTokens } : {}), supportsImages };
      })) : [];
      return { id, name, protocol, baseURL: typeof value.baseURL === 'string' ? value.baseURL : id === official ? PUBLIC_BASE_URL : '', models, revision,
        credentialConfigured: credential.configured, credentialWritable: credential.writable, credentialSource: credential.source };
    }));
    return { providers, defaults: this.defaults(), defaultsRevision: defaults.revision, customRevision: custom.revision, protocols };
  }
  async validateSelection(provider: string, model: string): Promise<void> {
    if (!(await this.ctx.llm.listModels(provider)).some(item => item.id === model)) throw new Error('请选择该 Provider 已配置的模型');
  }
  save(input: unknown) {
    return this.serial(async () => {
      const data = object(input);
      const id = text(data.id, 'Provider 标识', 64);
      if (!/^[a-z][a-z0-9-]{1,63}$/.test(id) || ['__proto__', 'prototype', 'constructor'].includes(id)) throw new Error('Provider 标识须为小写字母、数字和连字符');
      const protocol = text(data.protocol, '协议');
      if (!protocols.includes(protocol) || (id === official) !== (protocol === 'deepseek-messages')) throw new Error('Provider 与协议不匹配');
      const name = text(data.name, '名称');
      const baseURL = endpoint(data.baseURL);
      if (!Array.isArray(data.models) || data.models.length < 1 || data.models.length > 30) throw new Error('请填写 1 至 30 个模型名称');
      const ids = data.models.map(value => text(value, '模型名称'));
      if (new Set(ids).size !== ids.length) throw new Error('模型名称不能重复');
      const visionModels = data.visionModels;
      if (visionModels !== undefined && (!Array.isArray(visionModels) || visionModels.some(value => typeof value !== 'string' || !ids.includes(value)) || new Set(visionModels).size !== visionModels.length)) throw new Error('图片模型列表须是当前模型名称的不重复子集');
      const contextWindow = capacity(data.contextWindow, '上下文容量');
      const maxTokens = capacity(data.maxTokens, '输出上限');
      if (maxTokens > contextWindow) throw new Error('输出上限不能大于上下文容量');
      if (!Number.isSafeInteger(data.revision) || (data.revision as number) < 0) throw new Error('缺少配置版本，请刷新后重试');
      const ns = id === official ? 'llm-deepseek' : customNamespace;
      const descriptor = this.descriptor(ns);
      if (descriptor.revision !== data.revision) throw new Error('配置已更新，请刷新后重试');
      const declared = id === official ? {} : object(object(descriptor.value).providers ?? {});
      if (id !== official && !Object.hasOwn(declared, id) && this.ctx.llm.listProviders().some(item => item.id === id)) throw new Error('Provider 标识已被其他适配器占用');
      if (data.apiKey !== undefined && (typeof data.apiKey !== 'string' || data.apiKey.length > 8192 || !data.apiKey.trim() || /\s/.test(data.apiKey))) throw new Error('API Key 格式不正确');
      const ref = this.keyRef(id);
      if (data.apiKey !== undefined && !(await this.ctx.credentials.describe(ref)).writable) throw new Error('该凭据由环境提供，不能在页面覆盖');
      const previousProvider = id === official ? object(descriptor.value) : Object.hasOwn(declared, id) ? object(declared[id]) : {};
      const previousModels = new Map((Array.isArray(previousProvider.models) ? previousProvider.models : []).map(value => { const model = object(value); return [String(model.id), model] as const; }));
      // Missing visionModels is an older client: preserve the installed native
      // facts and catalog defaults. Explicit choices declare the provider's actual
      // capabilities through its own native configuration field.
      const models = ids.map(modelId => {
        const model = { ...previousModels.get(modelId), id: modelId, contextWindow, maxTokens } as Row;
        if (Array.isArray(visionModels)) {
          const hasImage = visionModels.includes(modelId);
          model[id === official ? 'inputModalities' : 'input'] = hasImage ? ['text', 'image'] : ['text'];
          if (id === official && !hasImage) {
            // The native adapter rejects image request limits on text-only models.
            delete model.imagePixelBudget; delete model.imageMaxBytes;
          }
        }
        return model;
      });
      // Validate and save the non-secret configuration before writing the optional key.
      // Both stores are independently durable; report any key failure instead of claiming full success.
      if (id === official) await this.ctx.settings.update(ns, { baseURL, models, apiKeyEnv: ref }, descriptor.revision);
      else await this.ctx.settings.mutate(ns, [{ op: 'set', path: ['providers', id], value: {
        displayName: name, api: protocol, baseURL, models, apiKeyEnv: ref,
        ...(Array.isArray(previousProvider.defaultInput) ? { defaultInput: [...previousProvider.defaultInput] } : {}),
      } }], descriptor.revision);
      if (typeof data.apiKey === 'string') {
        try { await this.ctx.credentials.set(ref, data.apiKey); }
        catch { throw new Error('Provider 配置已保存，但 API Key 保存失败，请重新填写后保存'); }
      }
      return this.view();
    });
  }
  // Retained for older API clients/configurations; Studio UI selects a model in the conversation.
  setDefault(input: unknown) {
    return this.serial(async () => {
      const data = object(input);
      const provider = text(data.provider, 'Provider');
      const model = text(data.model, '模型');
      if (!Number.isSafeInteger(data.revision)) throw new Error('缺少配置版本');
      await this.validateSelection(provider, model);
      await this.ctx.settings.update(defaultsNamespace, { defaultProvider: provider, defaultModel: model }, data.revision as number);
      return this.view();
    });
  }
}

export function apply(ctx: Context, config: Config): void {
  const models = new StudioModels(ctx, config);
  ctx.effect(() => ctx.provide('studioModels', models), 'studio: model settings');
  for (const path of ['/api/studio/models', '/api/studio/models/default']) {
    ctx.connection.fetch.register({ path, methods: path.endsWith('/default') ? ['POST'] : ['GET', 'POST'], requestBody: 'buffered', async fetch(request) {
      try {
        const result = path.endsWith('/default') ? await models.setDefault(await request.json()) : request.method === 'GET' ? await models.view() : await models.save(await request.json());
        return Response.json(result);
      } catch (error) { return Response.json({ error: error instanceof Error ? error.message : '模型配置操作失败' }, { status: 400 }); }
    } });
  }
}
