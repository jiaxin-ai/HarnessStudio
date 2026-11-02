import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type {} from './index.ts';
import { foldTextFrame, type ChatEvent, type ChatRecord, type ChatPacket, type ChatMetrics, type LiveAttempt, type TextFrame } from './chat-types.ts';

export function publicEvent(event: SessionEvent): ChatEvent | undefined {
  const { seq, type, data } = event;
  switch (type) {
    case 'turn/start': case 'turn/end': case 'tool/call': return { seq, type, data };
    case 'user/message': return { seq, type, data: { id: data.id, content: data.content, source: { kind: data.source.kind, ...(data.source.kind === 'user-question-reply' ? { callId: data.source.callId } : {}),
      // Orchestrator instructions and controller notices show as such, never as the person's bubble.
      ...(data.source.kind === 'harnessstudio-autonomy' ? { runId: data.source.runId, from: data.source.from } : {}) } } };
    case 'assistant/message': return { seq, type, data: { turn: data.turn, step: data.step, interrupted: data.interrupted, message: { id: data.message.id, content: data.message.content } } };
    case 'tool/result': return { seq, type, data: { turn: data.turn, step: data.step, message: { callId: data.message.source.callId, content: data.message.content, isError: data.message.isError, ...(data.meta === undefined ? {} : { meta: data.meta }), ...(data.error?.code === 'TOOL_OUTCOME_UNKNOWN' ? { questionOutcome: 'continued' } : data.error?.code === 'ASK_ABORTED' ? { questionOutcome: 'aborted' } : {}) } } };
    default: return undefined;
  }
}
function textFrame(frame: AssistantStreamFrame): TextFrame | undefined {
  if (frame.type === 'start') return frame;
  if (frame.type === 'end') return { type: 'end', attemptId: frame.attemptId, revision: frame.revision };
  const { chunk } = frame;
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta'
    || chunk.type === 'block-start' && (chunk.blockType === 'text' || chunk.blockType === 'reasoning')
    || chunk.type === 'block-end' && (chunk.block.type === 'text' || chunk.block.type === 'reasoning')) {
    return { type: 'chunk', attemptId: frame.attemptId, revision: frame.revision, chunk: chunk as Extract<TextFrame, { type: 'chunk' }>['chunk'] };
  }
}

/** Authenticated SSE over public DSH notifications; disconnect never cancels the Agent. */
export class ChatStreams {
  private live = new Map<string, LiveAttempt[]>();
  private listeners = new Map<string, Set<(packet: ChatPacket) => void>>();
  private connections = new Set<() => void>();
  private chatConnections = new Map<string, Set<() => void>>();
  private emit(id: string, packet: ChatPacket) { for (const listener of this.listeners.get(id) ?? []) listener(packet); }
  frame(id: string, raw: AssistantStreamFrame) {
    const frame = textFrame(raw); if (!frame) return;
    const next = foldTextFrame(this.live.get(id) ?? [], frame);
    if (next.length) this.live.set(id, next); else this.live.delete(id);
    this.emit(id, { type: 'frame', frame });
  }
  event(id: string, raw: SessionEvent) { const event = publicEvent(raw); if (event) this.emit(id, { type: 'event', event }); }
  metrics(id: string, metrics: ChatMetrics) { this.emit(id, { type: 'metrics', metrics }); }
  status(id: string, status: string) { this.emit(id, { type: 'status', status }); }
  forget(id: string) { this.live.delete(id); this.status(id, 'stored'); }
  remove(id: string) { for (const close of [...this.chatConnections.get(id) ?? []]) close(); this.live.delete(id); this.listeners.delete(id); }
  close() { for (const close of [...this.connections]) close(); this.live.clear(); this.listeners.clear(); }
  response(id: string, signal: AbortSignal, load: () => Promise<Omit<ChatRecord, 'events'> & { events: readonly SessionEvent[] }>): Response {
    const encoder = new TextEncoder(); let close = () => {};
    const body = new ReadableStream<Uint8Array>({
      start: controller => {
        let active = true, ready = false, buffered: ChatPacket[] = [], bufferedBytes = 0;
        let queuedBytes = 0;
        const write = (value: string) => {
          if (!active) return;
          // A slow reader reconnects from a fresh snapshot instead of retaining an unbounded queue.
          if ((controller.desiredSize ?? 0) > 0) queuedBytes = 0;
          const bytes = encoder.encode(value); queuedBytes += bytes.byteLength;
          if (queuedBytes > 2 * 1024 * 1024) { close(); return; }
          controller.enqueue(bytes);
        };
        const send = (packet: ChatPacket) => write(`data: ${JSON.stringify(packet)}\n\n`);
        const receive = (packet: ChatPacket) => {
          if (ready) send(packet);
          else { bufferedBytes += JSON.stringify(packet).length; if (bufferedBytes > 2 * 1024 * 1024) close(); else buffered.push(packet); }
        };
        const listeners = this.listeners.get(id) ?? new Set(); this.listeners.set(id, listeners); listeners.add(receive);
        const heartbeat = setInterval(() => write(': heartbeat\n\n'), 15000); heartbeat.unref();
        close = () => {
          if (!active) return; active = false; clearInterval(heartbeat); listeners.delete(receive);
          if (!listeners.size) this.listeners.delete(id);
          signal.removeEventListener('abort', close); this.connections.delete(close); this.chatConnections.get(id)?.delete(close);
          if (!this.chatConnections.get(id)?.size) this.chatConnections.delete(id); buffered = [];
          controller.close();
        };
        this.connections.add(close);
        const chatConnections = this.chatConnections.get(id) ?? new Set(); this.chatConnections.set(id, chatConnections); chatConnections.add(close);
        signal.addEventListener('abort', close, { once: true });
        if (signal.aborted) { close(); return; }
        write('retry: 1000\n\n');
        // Subscribe before asynchronous history reads. The browser de-duplicates the overlapping prefix.
        void load().then(chat => {
          if (!active) return;
          const events = chat.events.flatMap(event => { const projected = publicEvent(event); return projected ? [projected] : []; });
          send({ type: 'snapshot', chat: { ...chat, events }, live: this.live.get(id) ?? [] });
          ready = true; for (const packet of buffered) send(packet); buffered = [];
        }, error => { if (active) { send({ type: 'error', error: error instanceof Error ? error.message : '会话读取失败' }); close(); } });
      },
      cancel() { close(); },
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' } });
  }
}
