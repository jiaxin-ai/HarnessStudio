import type { Context } from '@deepseek-ai/cordis';
import { SpillStore, SpillLocator, type SaveTextSpill, type SpillRef } from '@deepseek-ai/dsh-spill';
import type { PostToolDecision } from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-settings';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { randomUUID, createHash } from 'node:crypto';
import type {} from './index.ts';

export const name = 'harnessstudio-web';
export const inject = ['studio', 'tools', 'connection', 'credentials', 'settings'];

/** DSH's retention policy stores its full output in the producing chat's guarded workspace. */
export class StudioSpillStore extends SpillStore {
  private readonly saved = new Map<string, SpillRef>();
  constructor(private readonly studioCtx: Context) { super(studioCtx); }
  async saveText(input: SaveTextSpill): Promise<SpillRef> {
    const id = input.owner.sessionId;
    const lease = this.studioCtx.studio.boundLease(id);
    const hash = createHash('sha256').update(input.content).digest('hex');
    const source = input.source;
    const key = `${id}:${source.kind === 'tool' ? source.callId : source.sessionId}:${hash}`;
    const existing = this.saved.get(key);
    if (existing) return existing;
    const base = input.suggestedName.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40) || 'result';
    const path = `results/${base}-${randomUUID()}.txt`;
    const file = await this.studioCtx.studio.scratchFor(id).write(lease, id, path, input.content);
    const ref = { locator: SpillLocator(path), bytes: file.bytes,
      retrievalHint: `This path is private to the current conversation. Use studio_read_temp_file with path=${JSON.stringify(path)}, offset=0, limit=6000, then nextOffset to continue; or studio_search_temp_file to find relevant passages.` };
    // One result can pass both the native spill policy and the web archive policy. Reuse that file.
    this.saved.set(key, ref);
    if (this.saved.size > 200) this.saved.delete(this.saved.keys().next().value!);
    return ref;
  }
}

const searchNamespace = 'web-search-deepseek';
function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('搜索配置须为对象');
  return value as Record<string, unknown>;
}

export function apply(ctx: Context): void {
  const store = new StudioSpillStore(ctx);
  // Archive small web results too; oversized results are already retained by DSH's spill policy.
  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const decision = await next();
    if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value') || result.isError
      || !['web_search', 'web_fetch'].includes(exec.name) || !exec.agent) return decision;
    const content = result.content;
    if (!content.every(block => block.type === 'text')) return decision;
    try {
      const ref = await store.saveText({ owner: { sessionId: exec.agent.session.header.id },
        source: { kind: 'tool', toolName: exec.name, callId: exec.callId, label: 'result' },
        suggestedName: `${exec.name}.txt`, content: content.map(block => block.type === 'text' ? block.text : '').join('') });
      if (decision.content?.some(block => block.type === 'text' && block.text.includes(ref.locator))) return decision;
      return { kind: 'accept', additionalContexts: decision.additionalContexts, content: [...decision.content ?? content, { type: 'text', text: `\n\nFull formatted web result saved to this conversation's temporary file: ${ref.locator}. ${ref.retrievalHint}` }] };
    } catch {
      ctx.logger.warn('studio-web: could not archive web output; keeping the visible result');
      return { kind: 'accept', additionalContexts: decision.additionalContexts, content: [...decision.content ?? content, { type: 'text', text: '\n\nTemporary result storage failed. This result is not saved for later retrieval.' }] };
    }
  }, { prepend: true });

  const descriptor = () => {
    const value = ctx.settings.describe({ redactSecrets: true }).find(item => item.ns === searchNamespace);
    if (!value) throw new Error('搜索配置尚未就绪');
    return value;
  };
  const view = async () => {
    const config = descriptor(), value = row(config.value);
    return { provider: 'DeepSeek', baseURL: String(value.baseURL ?? process.env.DEEPSEEK_SEARCH_BASE_URL ?? 'https://api.deepseek.com/anthropic/v1'),
      model: String(value.model ?? 'deepseek-v4-flash'), revision: config.revision,
      credentialConfigured: (await ctx.credentials.describe(credentialRef(String(value.apiKeyEnv ?? 'DEEPSEEK_API_KEY')))).configured,
      maxQueries: 4, maxSources: 8, maxInlineTokens: 8000 };
  };
  ctx.connection.fetch.register({ path: '/api/studio/web', methods: ['GET', 'POST'], requestBody: 'buffered', async fetch(request) {
    try {
      if (request.method === 'POST') {
        const data = row(await request.json());
        if (typeof data.baseURL !== 'string' || data.baseURL.length > 2000 || typeof data.model !== 'string' || !data.model.trim() || data.model.length > 200 || !Number.isSafeInteger(data.revision)) throw new Error('请填写有效的搜索地址、模型和配置版本');
        const endpoint = new URL(data.baseURL);
        if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('搜索地址须为无凭据和查询参数的 HTTP(S) 地址');
        await ctx.settings.update(searchNamespace, { baseURL: data.baseURL.replace(/\/+$/, ''), model: data.model.trim() }, data.revision as number);
      }
      return Response.json(await view());
    } catch (error) { return Response.json({ error: error instanceof Error ? error.message : '搜索配置失败' }, { status: 400 }); }
  } });
}
