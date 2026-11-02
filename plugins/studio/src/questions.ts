import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-client-connection';
import type {} from '@deepseek-ai/dsh-session-projection';
import type {} from '@deepseek-ai/dsh-session-persistence';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { UserQuestionError, type AskUserQuestionAnswer, type AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions';
import type { StudioQuestionView } from './questions-types.ts';
import { StudioQuestionError, questionAnswerRequest, validateAnswers, validateQuestions } from './questions-validation.ts';
import type {} from './index.ts';

export const name = 'harnessstudio-planning-questions';
export const inject = ['studio', 'studioDomain', 'tools', 'agents', 'userQuestions', 'sessionProjections', 'sessionPersistence', 'connection'];
interface Waiter {
  agent: Agent;
  callId: string;
  questions: AskUserQuestionRequest['questions'];
  settle: (answer?: AskUserQuestionAnswer, error?: unknown) => void;
}
declare module '@deepseek-ai/cordis' { interface Context { studioQuestions: StudioQuestions } }

/** Product answerer; all tool waits/results/recovery remain owned by the official Harness. */
export class StudioQuestions {
  private readonly waits = new Map<string, Map<string, Waiter>>();
  constructor(private readonly ctx: Context) {}

  private projection(agent: Agent) {
    return this.ctx.sessionProjections.stateOf(agent.session, 'userQuestions')?.questions ?? { active: [], settled: [] };
  }
  private queued(agent: Agent, callId: string): boolean {
    return [...agent.inbox.nextStep, ...agent.inbox.nextTurn].some(message => message.source.kind === 'user-question-reply' && message.source.callId === callId);
  }
  /** Only the actual Studio-bound runtime root may be claimed by this UI provider. */
  accepts(agent: Agent | undefined): agent is Agent {
    if (!agent) return false;
    try { this.ctx.studio.graphPlanningScope(agent, true); return true; }
    catch { return false; }
  }

  async ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
    if (!this.accepts(request.agent) || !request.wait?.callId) return Promise.reject(new UserQuestionError('Question is not owned by an editable Studio conversation', 'NO_PROVIDER'));
    const agent = request.agent, callId = request.wait.callId;
    validateQuestions(request.questions);
    // A suspended tool has not reached turn/end. Make the native tool/call durable
    // before showing an answerable card, using the public persistence contract.
    await this.ctx.sessionPersistence.flush();
    if (request.signal?.aborted) return Promise.reject(new UserQuestionError('问题已停止', 'ASK_ABORTED'));
    const calls = this.waits.get(agent.id) ?? new Map<string, Waiter>();
    if (calls.has(callId)) return Promise.reject(new UserQuestionError('Duplicate pending question', 'DUPLICATE_WAIT'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const onAbort = () => waiter.settle(undefined, new UserQuestionError('问题已停止，未提交任何回答', 'ASK_ABORTED'));
      const waiter: Waiter = { agent, callId, questions: structuredClone(request.questions), settle: (answer, error) => {
        if (settled) return;
        settled = true; request.signal?.removeEventListener('abort', onAbort);
        calls.delete(callId); if (!calls.size) this.waits.delete(agent.id);
        if (error !== undefined) reject(error); else if (answer) resolve(answer);
        else reject(new UserQuestionError('问题已停止', 'ASK_ABORTED'));
      } };
      calls.set(callId, waiter); this.waits.set(agent.id, calls);
      request.signal?.addEventListener('abort', onAbort, { once: true });
      if (request.signal?.aborted) onAbort();
    });
  }

  async view(id: string): Promise<StudioQuestionView> {
    const agent = await this.ctx.studio.ensureQuestionAgent(id);
    await this.ctx.sessionPersistence.flush();
    const projection = this.projection(agent);
    return { id, pending: projection.active.map(item => {
      const replyQueued = this.queued(agent, item.callId);
      return { callId: item.callId, state: item.state, questions: structuredClone(item.questions),
        canAnswer: !replyQueued && (item.state === 'continued' || this.waits.get(id)?.has(item.callId) === true),
        ...(replyQueued ? { replyQueued: true } : {}) };
    }), settled: projection.settled.map(item => ({ callId: item.callId, answers: structuredClone(item.answers) })) };
  }

  async answer(id: string, callId: string, value: unknown): Promise<{ accepted: true }> {
    const agent = await this.ctx.studio.ensureQuestionAgent(id);
    const question = this.projection(agent).active.find(item => item.callId === callId);
    if (!question) throw new StudioQuestionError('该问题已结束或被停止，请查看当前对话', 'STALE_QUESTION', 409);
    const answer = validateAnswers(question.questions, value);
    if (this.queued(agent, callId)) throw new StudioQuestionError('回答已提交，正在等待模型继续', 'REPLY_QUEUED', 409);
    if (question.state === 'continued') {
      if (!this.ctx.userQuestions.answer(agent, ToolCallId(callId), answer)) throw new StudioQuestionError('该问题已结束，请刷新后重试', 'STALE_QUESTION', 409);
    } else {
      const waiter = this.waits.get(id)?.get(callId);
      if (!waiter || waiter.agent !== agent) throw new StudioQuestionError('该问题已不在等待回答，请刷新后重试', 'STALE_QUESTION', 409);
      waiter.settle(answer);
    }
    return { accepted: true };
  }

  guard(agent: Agent | undefined, toolName: string, callId: string): string | undefined {
    if (!this.accepts(agent)) return undefined;
    const pending = this.projection(agent).active.filter(item => item.callId !== callId);
    if (!pending.length) return undefined;
    if (['ask_user_question', 'studio_create_task', 'studio_apply_graph_patch', 'studio_update_checklist'].includes(toolName)) return '当前对话仍有未明确回答的问题。请等待用户回答后再修改任务图谱；超时、切换对话或重启都不代表用户同意。';
    return undefined;
  }
  dispose(agentId?: string): void {
    for (const [id, calls] of this.waits) if (agentId === undefined || agentId === id) {
      for (const waiter of [...calls.values()]) waiter.settle(undefined, new UserQuestionError('等待已停止，未提交任何回答', 'ASK_ABORTED'));
    }
  }
}

export function apply(ctx: Context): void {
  const service = new StudioQuestions(ctx);
  ctx.effect(() => ctx.provide('studioQuestions', service), 'studio-questions: service');
  ctx.on('user-questions/request', (request, next) => service.accepts(request.agent) && request.wait?.callId ? service.ask(request) : next(), { global: true });
  ctx.tools.guard(exec => service.guard(exec.agent, exec.name, exec.callId));
  ctx.on('agent/disposed', ({ agent }) => service.dispose(agent.id), { global: true });
  ctx.effect(() => () => service.dispose(), 'studio-questions: pending wait cleanup');
  for (const [path, methods, operation] of [
    ['/api/studio/chat/questions', ['GET'], async (request: Request) => {
      const id = new URL(request.url).searchParams.get('id');
      if (!id) throw new StudioQuestionError('缺少对话 ID', 'BAD_REQUEST');
      return service.view(id);
    }],
    ['/api/studio/chat/questions/answer', ['POST'], async (request: Request) => {
      const { id, callId, answers } = questionAnswerRequest(await request.json());
      return service.answer(id, callId, answers);
    }],
  ] as const) ctx.connection.fetch.register({ path, methods: [...methods], requestBody: 'buffered', async fetch(request) {
    try { return Response.json(await ctx.studioDomain.webAction(request, async () => operation(request))); }
    catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : '问题交互失败',
        ...(error instanceof StudioQuestionError ? { code: error.code } : {}) }, { status: error instanceof StudioQuestionError ? error.status : 400 });
    }
  } });
}
