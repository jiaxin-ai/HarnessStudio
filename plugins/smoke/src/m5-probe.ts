import type { Context } from '@deepseek-ai/cordis';
import { type GenerateOptions, type StreamChunk, type ToolCallId } from '@deepseek-ai/dsh-llm';
import { brandString } from '@deepseek-ai/dsh-brand';
import type {} from '@deepseek-ai/dsh-client-connection';
import type {} from '@harnessstudio/studio';
import type {} from '@harnessstudio/studio/domain';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

interface Call { name: string; args: Record<string, unknown>; error?: boolean; includes?: string[] }
interface Fixture { calls: Call[]; delayMs?: number }

/** A keyless normal native-loop fixture, never a replacement loop or tool. */
export function m5Probe(options: GenerateOptions, prompt: string, userIndex: number): AsyncIterable<StreamChunk> | undefined {
  const match = /^\[m5-recovery\]\s*(\{.*\})$/su.exec(prompt);
  if (!match) return;
  return (async function* () {
    const fixture = JSON.parse(match[1]!) as Fixture;
    if (!Array.isArray(fixture.calls) || fixture.calls.length > 30 || fixture.delayMs !== undefined && (!Number.isSafeInteger(fixture.delayMs) || fixture.delayMs < 0 || fixture.delayMs > 5000)) throw new Error('M5 fixture requires a bounded declared call plan');
    if (options.tools?.some(tool => /(?:complete|clear|delete|purge|submit|action|ack_unknown)/u.test(tool.name))) throw new Error('M5 model was granted human completion, destructive or confirmation authority');
    const results = options.messages.slice(userIndex + 1).filter(message => message.role === 'tool');
    if (results.length > fixture.calls.length) throw new Error('M5 native loop issued an unexpected extra call');
    for (let index = 0; index < results.length; index++) {
      const expected = fixture.calls[index]!, result = results[index]!;
      if ((result.isError === true) !== (expected.error === true)) throw new Error(`M5 ${expected.name} permission outcome differs from its declared assertion`);
      const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
      for (const value of expected.includes ?? []) if (!text.includes(value)) throw new Error(`M5 ${expected.name} did not return the expected fixture bytes`);
    }
    const next = fixture.calls[results.length];
    if (next) {
      // An intentionally unavailable name is also sent through the real DSH
      // dispatcher, proving that a model cannot invent a destructive tool.
      await delay(fixture.delayMs ?? 0, undefined, { signal: options.signal });
      const call = { type: 'tool-call' as const, id: brandString<ToolCallId>(randomUUID()), name: next.name, arguments: JSON.stringify(next.args) };
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'block-end', index: 0, block: call };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    } else {
      const text = 'M5_NATIVE_RECOVERY_VERIFIED: scoped calls settled; no model completion, confirmation, clear or deletion was performed.';
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  })();
}

/** Faults live in memory only, under the explicit test overlay. The Host still
 * owns real chat disposal, persistence flush and producer quiescence. */
export function installM5Probe(ctx: Context): void {
  if (process.env.STUDIO_SMOKE !== '1') return;
  const failures = new Set<string>();
  ctx.effect(() => ctx.studio.registerQuiescence('m5-controlled-failure', async ids => {
    if (ids.some(id => failures.has(id))) throw new Error('M5_CONTROLLED_QUIESCE_FAILURE');
  }), 'm5-smoke: quiescence fault');
  ctx.effect(() => () => failures.clear(), 'm5-smoke: transient faults');
  ctx.connection.fetch.register({ path: '/api/studio/m5/fault', methods: ['POST'], requestBody: 'buffered', async fetch(request) {
    try {
      const raw: unknown = await request.json();
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('M5 fault requires an object');
      const data = raw as Record<string, unknown>;
      if (Object.keys(data).some(key => !['taskId', 'enabled'].includes(key)) || typeof data.taskId !== 'string' || typeof data.enabled !== 'boolean') throw new Error('M5 fault accepts only taskId and a boolean enabled');
      ctx.studioDomain.view(data.taskId);
      if (data.enabled) failures.add(data.taskId); else failures.delete(data.taskId);
      return Response.json({ taskId: data.taskId, enabled: failures.has(data.taskId) });
    } catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'M5 fault probe failed' }, { status: 400 }); }
  } });
  ctx.connection.fetch.register({ path: '/api/studio/m5/crash', methods: ['POST'], requestBody: 'buffered', async fetch(request) {
    const data: unknown = await request.json();
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length !== 1 || !('confirm' in data) || data.confirm !== true) return Response.json({ error: 'M5 isolated crash requires explicit boolean confirmation' }, { status: 400 });
    // Kill only this test Host after the response is delivered. Its parent
    // wrapper observes exit and stops its owned Mock platform normally.
    const timer = setTimeout(() => process.kill(process.pid, 'SIGKILL'), 150); timer.unref();
    return Response.json({ crashing: true });
  } });
}
