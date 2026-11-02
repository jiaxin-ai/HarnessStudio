/** STUDIO_SMOKE_WIRE=1 (tests only): each smoke model call and each smoke web search travels through a loopback HTTP
 * exchange with the global fetch, so Studio's conversation audit captures exact request and response bytes as it does
 * for a real provider. The answers do not change: the adapter's own chunks are relayed back as SSE frames, in order,
 * as they are produced, and an adapter error is rethrown unchanged after the stream. */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';

class Relay {
  private readonly frames: string[] = [];
  private wake: (() => void) | undefined;
  private ended = false;
  push(frame: string) { this.frames.push(frame); this.wake?.(); }
  end() { this.ended = true; this.wake?.(); }
  async *drain(): AsyncGenerator<string> {
    for (;;) {
      while (this.frames.length) yield this.frames.shift()!;
      if (this.ended) return;
      await new Promise<void>(resolve => { this.wake = resolve; }); this.wake = undefined;
    }
  }
}
const body = async (request: IncomingMessage) => { const parts: Buffer[] = []; for await (const part of request) parts.push(part as Buffer); return Buffer.concat(parts).toString('utf8'); };

export class SmokeWire {
  private server: Server | undefined;
  private listening: Promise<string> | undefined;
  private readonly relays = new Map<string, Relay>();

  private base(): Promise<string> {
    this.listening ??= new Promise((resolve, reject) => {
      const server = createServer((request, response) => void (async () => {
        await body(request);
        const relay = this.relays.get(String(request.headers['x-smoke-relay'] ?? ''));
        if (request.method === 'POST' && request.url === '/v1/messages' && relay) {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          for await (const frame of relay.drain()) response.write(frame);
          response.end('data: [DONE]\n\n');
        } else if (request.method === 'POST' && request.url === '/v1/messages' && request.headers['x-smoke-search']) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'web_search_tool_result', content: [] }], stop_reason: 'end_turn' }));
        } else { response.writeHead(404); response.end(); }
      })().catch(() => { response.destroy(); }));
      this.server = server;
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { const address = server.address(); resolve(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`); });
    });
    return this.listening;
  }
  close(): void { this.server?.close(); this.server = undefined; this.listening = undefined; }

  /** The chunks of one call, after they crossed HTTP. */
  async *stream(options: GenerateOptions, chunks: AsyncIterable<StreamChunk>): AsyncGenerator<StreamChunk> {
    const id = randomUUID(), relay = new Relay(); this.relays.set(id, relay);
    const { signal, ...request } = options;
    let failure: { error: unknown } | undefined;
    const pump = (async () => {
      try { for await (const chunk of chunks) relay.push(`data: ${JSON.stringify(chunk)}\n\n`); }
      catch (error) { failure = { error }; relay.push('event: error\ndata: {}\n\n'); }
      finally { relay.end(); }
    })();
    try {
      const response = await fetch(`${await this.base()}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-smoke-relay': id },
        body: JSON.stringify({ ...request, stream: true }), ...(signal ? { signal } : {}) });
      const decoder = new TextDecoder(); let buffer = '';
      for await (const part of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(part, { stream: true });
        for (let at = buffer.indexOf('\n\n'); at >= 0; at = buffer.indexOf('\n\n')) {
          const frame = buffer.slice(0, at); buffer = buffer.slice(at + 2);
          if (frame.startsWith('event: error')) { await pump; throw failure!.error; }
          if (frame === 'data: [DONE]') continue;
          yield JSON.parse(frame.slice('data: '.length)) as StreamChunk;
        }
      }
      await pump;
      if (failure) throw failure.error;
    } finally { this.relays.delete(id); }
  }

  /** One model request a web search provider would make for `query`. */
  async search(query: string, signal?: AbortSignal): Promise<void> {
    const response = await fetch(`${await this.base()}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-smoke-search': '1' },
      body: JSON.stringify({ model: 'smoke-web-search', max_tokens: 512, messages: [{ role: 'user', content: [{ type: 'text', text: `Perform a web search for the query: ${query}` }] }], tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }] }),
      ...(signal ? { signal } : {}) });
    await response.json();
  }
}
