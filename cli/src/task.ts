/** One task of the batch (cli/设计.md §7.3): project, files, run, people's items, stop, export, result.json. */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { objectiveOf, type TaskSpec } from './spec.ts';
import { writeJson } from './output.ts';
import { Studio, StudioError, projectUrl } from './studio.ts';
import { oneLine } from './text.ts';
import { exportWarnings } from './zip.ts';
import { UNFINISHED, type AttentionKind, type AutoAnswer, type PreviousAttempt, type RunAttention, type RunDetail, type TaskResult, type TaskStatus } from './types.ts';

/** cli/设计.md §1: the answer every question gets in a batch. */
export const AUTO_ANSWER = '没有更多信息，请按合理假设继续，并在结果里写明你的假设。';
const ATTENTION_TEXT: Record<Exclude<AttentionKind, 'question'>, string> = {
  blocked: '子 Agent 报告需要人处理', stuck: '有 Agent 卡住了', budget: '预算用完了', restart: 'Studio 服务重启过', incomplete: '总 Agent 提前宣布完成，但还有任务没做完',
};
/** How Studio's own item texts begin (autonomy.ts): such a text already names the situation, so it takes no label. */
const SAYS: Record<Exclude<AttentionKind, 'question'>, readonly string[]> = {
  blocked: ['子 Agent'], stuck: ['子 Agent', '总 Agent'], budget: ['折算 token 预算', '运行时长', '总 Agent 的轮数'], restart: ['Studio 服务重启'], incomplete: ['总 Agent 报告目标已完成'],
};
/** `label：text`, or the text alone when it already begins with the label or with how Studio words this situation. */
export function labelled(label: string, text: string, says: readonly string[] = []): string {
  const plain = oneLine(text);
  return [label, ...says].some(prefix => plain.startsWith(prefix)) ? plain : `${label}：${plain}`;
}

export interface Timings {
  /** Between two reads of the run (§7.3: 2–5 seconds). */
  pollMs: number;
  /** How long a question may stay open with nothing this client can answer before a person is needed. */
  questionTimeoutMs: number;
  /** How long Studio may be unreachable while a run is watched before the task counts as failed. */
  lostAfterMs: number;
  /** Before the one retry of a failed export. */
  exportRetryMs: number;
  /** How long the run's conversations may take to finish their last turn before the export goes ahead anyway. */
  settleMs: number;
}
export const DEFAULT_TIMINGS: Timings = { pollMs: 3000, questionTimeoutMs: 120_000, lostAfterMs: 300_000, exportRetryMs: 5000, settleMs: 60_000 };

export type Phase = 'creating' | 'uploading' | 'starting' | 'running' | 'stopping' | 'exporting';
export interface Hooks {
  /** Durable facts for batch-state.json, as soon as they exist. */
  record(change: { projectId?: string; projectUrl?: string; runId?: string }): Promise<void> | void;
  progress(phase: Phase, run?: RunDetail): void;
  log(text: string): void;
}
export interface TaskInput {
  spec: TaskSpec; settings: Record<string, unknown>; projectTitle: string; folder: string;
  previousAttempts?: PreviousAttempt[];
  /** A run a previous, killed client started: watch it instead of starting a new one. */
  attach?: { projectId: string; runId: string; startedAt?: string };
}
export interface TaskEnv { studio: Studio; publicBase: string; noVideo: boolean; timings: Timings; interrupt: AbortSignal; softwareBackend?: string; now?: () => Date }

const message = (error: unknown) => oneLine(error instanceof Error ? error.message : String(error));
const latest = (run: RunDetail, type: string) => run.events.find(event => event.type === type)?.summary;
const pause = (ms: number, signal: AbortSignal) => sleep(ms, undefined, { signal }).catch(() => undefined);

export async function runTask(env: TaskEnv, input: TaskInput, hooks: Hooks): Promise<TaskResult> {
  const { studio, timings, interrupt } = env, now = env.now ?? (() => new Date());
  const startedAt = input.attach?.startedAt ?? now().toISOString(), autoAnswers: AutoAnswer[] = [], warnings: string[] = [];
  let projectId = input.attach?.projectId, runId = input.attach?.runId, detail: RunDetail | undefined, status: TaskStatus | undefined, reason = '';
  const end = (value: TaskStatus, why = '') => { status = value; reason = why; };
  const interrupted = () => end('interrupted', '批量命令被中断（Ctrl+C），这个任务还没有启动运行');

  /** Stop the run; a stale revision means it changed between two reads, so read it again and retry. */
  async function stop(): Promise<string | undefined> {
    let last: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const current = await studio.run(runId!);
        if (!UNFINISHED.includes(current.state)) { detail = current; return undefined; }
        detail = await studio.stopRun(runId!, current.revision);
        return undefined;
      } catch (error) { last = error; await sleep(500); }
    }
    return `停止运行失败：${message(last)}`;
  }

  /** undefined while it is handled or may still become answerable; otherwise why a person is needed. */
  const answered = new Set<string>(), questionSince = new Map<string, number>();
  async function question(item: RunAttention): Promise<string | undefined> {
    if (!questionSince.has(item.id)) questionSince.set(item.id, Date.now());
    const overdue = () => Date.now() - questionSince.get(item.id)! > timings.questionTimeoutMs ? `有一个问题一直没法自动回答：${oneLine(item.message)}` : undefined;
    if (!item.chatId) return overdue();
    let view;
    try { view = await studio.questions(item.chatId); }
    catch (error) { return error instanceof StudioError ? `读取问题失败，没法自动回答：${message(error)}` : overdue(); }
    for (const pending of view.pending) {
      if (answered.has(pending.callId) || pending.replyQueued || !pending.canAnswer) continue;
      // A tagged question (DSH AskUserQuestionIntent, e.g. plan-review) asks a person to approve something; a free-text
      // answer would decide it for them, so it waits for a person instead.
      const special = pending.questions.find(row => row.intent);
      if (special) return `有一个需要人来决定的问题，不能自动回答：${oneLine(special.question)}`;
      // Every DSH question accepts free text (`custom`) with no option selected (questions-validation.ts), so option
      // questions are answered the same way rather than by picking an option for the person.
      try { await studio.answer(item.chatId, pending.callId, pending.questions.map(row => ({ id: row.id, selected: [], custom: AUTO_ANSWER }))); }
      catch (error) {
        if (error instanceof StudioError && error.status === 409) continue;
        return error instanceof StudioError ? `自动回答被拒绝：${message(error)}` : overdue();
      }
      answered.add(pending.callId); questionSince.set(item.id, Date.now());
      for (const row of pending.questions) {
        autoAnswers.push({ at: now().toISOString(), chatId: item.chatId, question: row.question, answer: AUTO_ANSWER });
        hooks.log(`自动回答了一个问题：${oneLine(row.question)}`);
      }
    }
    return overdue();
  }

  /** True once no conversation of the run is in a turn (the same check the export makes), false after settleMs. */
  async function settle(): Promise<boolean> {
    if (!runId) return true;
    const deadline = Date.now() + timings.settleMs;
    for (;;) {
      try { if (!(await studio.status()).chats?.some(chat => chat.runId === runId && !['idle', 'stored'].includes(chat.status ?? 'stored'))) return true; }
      catch { /* Studio may be briefly unreachable; the export reports what it could not include. */ }
      if (Date.now() >= deadline) return false;
      await sleep(Math.min(500, timings.pollMs));
    }
  }

  async function watch(): Promise<void> {
    let stopReason: string | undefined, stopping = false, lostSince: number | undefined;
    for (;;) {
      if (interrupt.aborted) {
        const failed = await stop();
        if (detail?.state === 'completed') return end('completed');
        // Already being stopped for a person: that stays the result, a rerun would only hit the same item.
        if (stopReason) return end('needs-human', failed ? `${stopReason}（${failed}，运行可能还在继续）` : stopReason);
        return end('interrupted', `批量命令被中断（Ctrl+C）${failed ? `，${failed}，运行可能还在继续` : '，运行已停止'}`);
      }
      try { detail = await studio.run(runId!); lostSince = undefined; }
      catch (error) {
        if (error instanceof StudioError) return end('failed', `读取运行状态失败：${message(error)}`);
        lostSince ??= Date.now();
        if (Date.now() - lostSince > timings.lostAfterMs) return end('failed', `和 Studio 的连接断开超过 ${Math.round(timings.lostAfterMs / 60000)} 分钟：${message(error)}。运行可能还在 Studio 里继续`);
        await pause(timings.pollMs, interrupt); continue;
      }
      hooks.progress(stopping ? 'stopping' : 'running', detail);
      if (detail.state === 'completed') return end('completed');
      if (detail.state === 'stopped') return end('needs-human', stopReason ?? '有人在网页上停止了这个运行');
      if (detail.state === 'failed') return end('failed', oneLine(latest(detail, 'failed') ?? '运行失败'));
      if (!stopReason && detail.state === 'blocked') stopReason = labelled('总 Agent 报告目标受阻', latest(detail, 'blocked') ?? '没有说明原因');
      for (const item of stopReason ? [] : detail.attention.filter(row => !row.resolvedAt)) {
        if (item.kind === 'question') { stopReason = await question(item); if (stopReason) break; continue; }
        // A kind added to Studio later still stops the run: anything but a question needs a person (cli/设计.md §7.3).
        const kind = item.kind as keyof typeof ATTENTION_TEXT;
        const label = item.kind === 'stuck' && item.chatId === detail.orchestratorChatId ? '总 Agent 停了下来' : ATTENTION_TEXT[kind] ?? '需要人处理';
        stopReason = labelled(label, item.message, SAYS[kind] ?? []); break;
      }
      if (stopReason && !stopping) {
        stopping = true; hooks.progress('stopping', detail);
        const failed = await stop();
        if (failed) return end('needs-human', `${stopReason}（${failed}，运行可能还在继续）`);
        continue;
      }
      await pause(timings.pollMs, interrupt);
    }
  }

  try {
    if (!input.attach) {
      hooks.progress('creating');
      const project = await studio.createProject(input.projectTitle);
      projectId = project.id; await hooks.record({ projectId, projectUrl: projectUrl(env.publicBase, projectId) });
      for (const file of input.spec.files) {
        if (interrupt.aborted) break;
        hooks.progress('uploading');
        try { await studio.upload(projectId, file.target, file.source, file.bytes, interrupt); }
        catch (error) { if (!interrupt.aborted) end('failed', `上传文件 ${file.target} 失败：${message(error)}`); break; }
      }
      if (interrupt.aborted) interrupted();
      if (!status) {
        hooks.progress('starting');
        try {
          detail = await studio.startRun({ projectId, objective: objectiveOf(input.spec.goal, input.spec.files, env.softwareBackend), settings: input.settings });
          runId = detail.id; await hooks.record({ runId });
        } catch (error) { end('failed', `启动自主运行失败：${message(error)}`); }
      }
    }
    if (!status) await watch();
  } catch (error) { end('failed', `出错了：${message(error)}`); }

  const trajectory: TaskResult['trajectory'] = { file: null, bytes: 0, warnings };
  let tasks: TaskResult['tasks'] = [];
  await mkdir(input.folder, { recursive: true });
  if (projectId) {
    hooks.progress('exporting', detail);
    // A run ends while its conversations finish their last turn, and an export leaves out (or cuts) a conversation that
    // is still running. Studio's export waits for them as well once it has the trajectory export work; until then this
    // wait is what keeps the orchestrator's conversation in. Only a failed download is retried: what project.json says
    // is missing (for example a model call cut by stopping the run) stays missing in a second export.
    const settled = await settle(), file = join(input.folder, 'trajectory.zip');
    for (let attempt = 1; attempt <= 2; attempt++) {
      try { trajectory.bytes = await studio.download(projectId, !env.noVideo, file); trajectory.file = 'trajectory.zip'; break; }
      catch (error) {
        if (attempt === 2) warnings.push(`导出轨迹失败（试了两次）：${message(error)}。可以稍后在网页上导出这个项目`);
        else { await sleep(timings.exportRetryMs); await settle(); }
      }
    }
    if (!settled) warnings.push(`运行结束后，有对话 ${Math.round(timings.settleMs / 1000)} 秒内没有停下来`);
    // project.json's warnings are sentences for people (cli/设计.md §10, trajectory export): kept as they are.
    if (trajectory.file) try { warnings.push(...(await exportWarnings(file)).map(oneLine)); }
    catch (error) { warnings.push(`读不了导出包里的 project.json：${message(error)}`); }
    try { tasks = (await studio.graph(projectId)).tasks.filter(task => !task.archived).map(task => ({ code: task.code, title: task.title, state: task.state, ...task.completedBy ? { completedBy: task.completedBy } : {} })); }
    catch (error) { warnings.push(`读取任务图谱失败：${message(error)}`); }
    if (runId) try { detail = await studio.run(runId); } catch { /* The last read is still the best there is. */ }
  } else warnings.push('项目没有建成，没有轨迹可导出');

  const ended = now(), usage = detail?.usage;
  const result: TaskResult = {
    name: input.spec.name, status: status!, reason, ...projectId ? { projectId, projectUrl: projectUrl(env.publicBase, projectId) } : {}, ...runId ? { runId } : {},
    startedAt, endedAt: ended.toISOString(), elapsedMs: ended.getTime() - new Date(startedAt).getTime(),
    usage: { weightedTokens: usage?.tokens ?? 0, tokenBreakdown: usage?.tokenBreakdown ?? { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, rounds: usage?.rounds ?? 0 },
    tasks, autoAnswers, trajectory, ...input.previousAttempts?.length ? { previousAttempts: input.previousAttempts } : {},
  };
  await writeJson(join(input.folder, 'result.json'), result);
  return result;
}
