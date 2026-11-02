import type { Context } from '@deepseek-ai/cordis';
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId, type LlmModelInfo, type Message } from '@deepseek-ai/dsh-llm';
import { brandString } from '@deepseek-ai/dsh-brand';
import { SessionId } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-agent-preset-registry';
import type {} from '@deepseek-ai/dsh-compaction';
import type {} from '@deepseek-ai/dsh-client-connection';
import type {} from '@harnessstudio/studio';
import { estimateMessage } from '@deepseek-ai/dsh-token-meter/estimate';
import { randomUUID } from 'node:crypto';

interface ProbeCall {
  name: string;
  args: Record<string, unknown>;
  error?: boolean;
  includes?: string[];
  excludes?: string[];
  kinds?: string[];
  total?: number;
  count?: number;
  nextOffset?: number | null;
}
interface Fixture {
  calls: ProbeCall[];
  expectSystem?: string[];
  forbidSystem?: string[];
  requireCheckpoint?: boolean;
  forbidHistory?: boolean;
  expectNoFileTools?: boolean;
}
const blockText = (message: Pick<Message, 'content'>): string => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
const plainObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('M4 probe expected an object');
  return value as Record<string, unknown>;
};

/** Controlled provider counters use the public fixed-density estimator so a
 * large old prompt has a meaningful native occupancy before it is condensed.
 * These are fixture samples, never estimates advertised as real model billing. */
function probeUsage(options: GenerateOptions, outputTokens: number) {
  const input = options.messages.reduce((sum, message) => sum + estimateMessage(message as Message), 0)
    + Math.ceil(JSON.stringify(options.tools ?? []).length / 4) + 8;
  const cacheReadTokens = Math.min(60, input);
  return { inputTokens: input - cacheReadTokens, outputTokens, cacheReadTokens, cacheWriteTokens: 0, totalTokens: input + outputTokens };
}
async function* textAnswer(text: string, options: GenerateOptions): AsyncIterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } };
  yield { type: 'usage', usage: probeUsage(options, Math.ceil(text.length / 4)) };
  yield { type: 'finish', reason: { kind: 'stop' } };
}

/** Keyless provider only: the official backend, rather than this adapter, owns
 * selection, locking, the real LLM call, summary events and surface replacement. */
class M4Adapter extends LlmAdapter {
  override providerInfo(provider: string) { return { id: provider, name: 'M4 受控压缩与恢复验收（非真实模型）' }; }
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider, id: 'm4-smoke', name: 'M4 deterministic engineering context recovery' }]);
  }
  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, context: { contextWindow: 1000000 } };
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted();
    if (options.purpose === 'compaction') {
      const instruction = blockText(options.messages.at(-1)!);
      if (!instruction.includes('You are now acting as a compaction engine') || !options.messages.some(message => blockText(message).includes('M4_HISTORY_TO_BE_SHADOWED'))) throw new Error('M4 summary adapter was not called with the official instruction and actual older history');
      // Deliberately omit exact goals, checklist, snapshot IDs, file hashes and
      // private research values. Recovery must read authoritative live tools.
      const summary = [
        '## Primary Request and Intent\n- M4_CONTROLLED_NATIVE_CHECKPOINT: continue the scoped engineering verification.',
        '## Key Technical Concepts\n- Use current task definitions and explicitly authorized immutable inputs.',
        '## Files and Code\n- Re-list conversation-private research files before using their contents.',
        '## Errors and Fixes\n- (none)',
        '## Pending Jobs\n- Recover current engineering facts through the bound read-only tools.',
        '## Current Work\n- Verify context recovery and ownership after history reduction.',
        '## Next Step\n- Query the live context index, then read authorized evidence.',
        '## Critical Context\n- Human completion and project/task/chat boundaries remain unchanged.',
      ].join('\n\n');
      yield* textAnswer(summary, options); return;
    }
    const userIndex = options.messages.findLastIndex(message => message.role === 'user' && message.source?.kind === 'user');
    const source = userIndex < 0 ? '' : blockText(options.messages[userIndex]!);
    const match = /^\[m4-(seed|recover)\][ \t]*(\{[^\n]*\})(?:\n|$)/u.exec(source);
    if (!match) throw new Error('M4 adapter accepts only its declared isolated probes');
    const fixture = JSON.parse(match[2]!) as Fixture;
    if (!Array.isArray(fixture.calls) || fixture.calls.length > 60) throw new Error('M4 fixture requires a bounded call plan');
    const system = options.messages.filter(message => message.role === 'system').map(blockText).join('\n');
    for (const value of fixture.expectSystem ?? []) if (!system.includes(value)) throw new Error(`M4 actual request omitted expected live system fact: ${value}`);
    for (const value of fixture.forbidSystem ?? []) if (system.includes(value)) throw new Error('M4 actual request leaked an out-of-scope system fact');
    const older = options.messages.slice(0, userIndex).map(blockText).join('\n');
    if (fixture.requireCheckpoint && !older.includes('M4_CONTROLLED_NATIVE_CHECKPOINT')) throw new Error('M4 recovery request did not derive the official landed checkpoint');
    if (fixture.forbidHistory && older.includes('M4_HISTORY_TO_BE_SHADOWED')) throw new Error('M4 recovery request still contains the original shadowed history');
    if (fixture.expectNoFileTools && ['studio_task_context', 'studio_read_file', 'studio_write_file'].some(name => options.tools?.some(tool => tool.name === name))) throw new Error('M4 project recovery was granted task file authority');
    const schema = options.tools?.find(tool => tool.name === 'studio_retrieve_context');
    if (!schema || schema.parameters.additionalProperties !== false) throw new Error('M4 actual request omitted the closed bound context-retrieval schema');
    const parameters = Object.keys((schema.parameters as { properties?: Record<string, unknown> }).properties ?? {}).sort();
    if (JSON.stringify(parameters) !== JSON.stringify(['category', 'limit', 'offset', 'query', 'revision'])) throw new Error('M4 native context schema permits an arbitrary owner or differs from its bounded contract');
    const results = options.messages.slice(userIndex + 1).filter(message => message.role === 'tool');
    if (results.length > fixture.calls.length) throw new Error('M4 native loop executed an unexpected extra call');
    for (let index = 0; index < results.length; index++) {
      const expected = fixture.calls[index]!, result = results[index]!, text = blockText(result);
      if ((result.isError === true) !== (expected.error === true)) throw new Error(`M4 native ${expected.name} outcome differs from its expected permission result`);
      // The bounded index echoes the caller's query outside the returned items.
      // Only actual retrieved facts count as either recovery or a scope leak.
      const facts = expected.name === 'studio_retrieve_context' && !result.isError ? JSON.stringify(plainObject(JSON.parse(text)).items) : text;
      for (const value of expected.includes ?? []) if (!facts.includes(value)) throw new Error(`M4 ${expected.name} did not recover expected fact: ${value}`);
      for (const value of expected.excludes ?? []) if (facts.includes(value)) throw new Error(`M4 ${expected.name} leaked an excluded fact at call ${index + 1}`);
      if (expected.kinds || expected.total !== undefined || expected.count !== undefined || expected.nextOffset !== undefined) {
        const value = plainObject(JSON.parse(text));
        if (!Array.isArray(value.items)) throw new Error('M4 retrieval did not return a bounded item page');
        if (expected.kinds && JSON.stringify(value.items.map(item => plainObject(item).kind)) !== JSON.stringify(expected.kinds)) throw new Error('M4 retrieval item kinds differ from the requested category');
        if (expected.total !== undefined && value.total !== expected.total) throw new Error('M4 retrieval total mismatch');
        if (expected.count !== undefined && value.items.length !== expected.count) throw new Error('M4 retrieval page size mismatch');
        if (expected.nextOffset !== undefined && (value.nextOffset ?? null) !== expected.nextOffset) throw new Error('M4 retrieval nextOffset mismatch');
      }
    }
    const next = fixture.calls[results.length];
    if (next) {
      if (!options.tools?.some(tool => tool.name === next.name)) throw new Error(`M4 native schema unavailable: ${next.name}`);
      const call = { type: 'tool-call' as const, id: brandString<ToolCallId>(randomUUID()), name: next.name, arguments: JSON.stringify(next.args) };
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'block-end', index: 0, block: call };
      yield { type: 'usage', usage: probeUsage(options, 10) };
      yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
    }
    yield* textAnswer(match[1] === 'seed' ? 'M4_SEED_READY: actual native tool results and research files are persisted.' : 'M4_RECOVERY_VERIFIED: current goal, checklist, authorized input evidence and private research were recovered through real native tools; no completion or approval was performed.', options);
  }
}

/** Registers only under the explicit smoke overlay; normal profile gets neither
 * this provider nor a compaction test route. No privileged loop/persistence access. */
export function installM4Probe(ctx: Context): void {
  if (process.env.STUDIO_SMOKE !== '1') return;
  ctx.llm.registerAdapter(['studio-m4-smoke'], new M4Adapter());
  ctx.connection.fetch.register({ path: '/api/studio/m4/compact', methods: ['POST'], requestBody: 'buffered', async fetch(request) {
    try {
      const data = plainObject(await request.json());
      if (Object.keys(data).some(key => key !== 'id') || typeof data.id !== 'string') throw new Error('M4 compaction accepts only the owned chat id');
      const binding = await ctx.studio.chat(data.id);
      if (binding.provider !== 'studio-m4-smoke' || binding.model !== 'm4-smoke') throw new Error('M4 compaction requires its isolated test model');
      const agent = ctx.agents.get(SessionId(data.id));
      if (!agent) throw new Error('M4 test agent is not live');
      const engine = ctx.agentPresets.serviceFor(agent, 'compaction');
      if (!engine) throw new Error('M4 agent preset lacks official compaction');
      const before = [...agent.session.surface.nodes], derivedBefore = agent.session.deriveMessages().map(blockText).join('\n');
      const result = await engine.compactNow(agent, request.signal);
      const after = [...agent.session.surface.nodes], messages = agent.session.deriveMessages();
      const derivedAfter = messages.map(blockText).join('\n');
      return Response.json({ result, before, after,
        derived: { hadOriginalHistory: derivedBefore.includes('M4_HISTORY_TO_BE_SHADOWED'), hasOriginalHistory: derivedAfter.includes('M4_HISTORY_TO_BE_SHADOWED'),
          checkpointCount: messages.filter(message => message.source?.kind === 'compact-checkpoint').length,
          hasCheckpointText: derivedAfter.includes('M4_CONTROLLED_NATIVE_CHECKPOINT') } });
    } catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'M4 compaction probe failed' }, { status: 400 }); }
  } });
}
