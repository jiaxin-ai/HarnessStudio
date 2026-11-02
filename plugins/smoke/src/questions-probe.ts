import type { GenerateOptions, StreamChunk, ToolCallId } from '@deepseek-ai/dsh-llm';
import { brandString } from '@deepseek-ai/dsh-brand';
import { randomUUID } from 'node:crypto';

interface Fixture { questions: Array<Record<string, unknown>>; timeout?: number; expectAnswers?: unknown; after?: 'graph'; }
interface DemoAnswer { id: string; selected: string[]; custom?: string }

async function* demoText(text: string, finish = true): AsyncIterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } };
  if (finish) yield { type: 'finish', reason: { kind: 'stop' } };
}
async function* demoCall(name: string, args: unknown, index = 0): AsyncIterable<StreamChunk> {
  yield { type: 'block-start', index, blockType: 'tool-call' };
  yield { type: 'block-end', index, block: { type: 'tool-call', id: brandString<ToolCallId>(randomUUID()), name, arguments: JSON.stringify(args) } };
  yield { type: 'finish', reason: { kind: 'tool-calls' } };
}

/** Browser-QA-only natural-language scenario; the three stages consume actual native answer results. */
async function* guidedDemo(options: GenerateOptions, prompt: string, userIndex: number): AsyncIterable<StreamChunk> {
  const tools = options.tools?.map(tool => tool.name) ?? [];
  if (!tools.includes('ask_user_question') || !tools.includes('studio_create_task')) throw new Error('Guided planning demo requires the actual native question and owned graph tools');
  const results = options.messages.slice(userIndex + 1).filter(message => message.role === 'tool');
  const batches: DemoAnswer[][] = [];
  for (const result of results.slice(0, 3)) {
    const value = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
    let parsed: { answers?: DemoAnswer[] };
    try { parsed = JSON.parse(value); }
    catch { yield* demoText('本轮提问已停止，没有记录明确回答；任务图谱保持不变。'); return; }
    if (result.isError || !Array.isArray(parsed.answers)) { yield* demoText('本轮尚未获得明确回答；不会据此生成任务图谱。'); return; }
    batches.push(parsed.answers);
  }
  if (batches.length === 0) {
    yield* demoCall('ask_user_question', { questions: [
      { id: 'demo_domain', header: '工程方向', question: '这次工作的主要方向是什么？先确定方向，再细化相应的设计条件。', options: [
        { label: 'CAD', description: '关注几何、装配与制造要求。' },
        { label: 'CAE', description: '关注工况、边界条件与分析判据。' },
        { label: 'EDA', description: '关注电气接口、原理与布板条件。' },
      ] },
      { id: 'demo_constraints', header: '设计边界', question: '哪些边界希望纳入这次规划？可以多选，也可以补充其他条件或明确暂不确定。', multi_select: true, options: [
        { label: '应用场景', description: '明确使用环境与实际用途。' },
        { label: '尺寸空间', description: '明确外形、布局与接口空间。' },
        { label: '工况', description: '明确载荷、物理或电气运行条件。' },
      ] },
    ] }); return;
  }
  if (batches.length === 1) {
    yield* demoCall('ask_user_question', { questions: [{ id: 'demo_deliverable', header: '预期产物', question: '这次希望最终形成哪一种主要产物？未确定时可以直接选择暂不确定。', options: [
      { label: '2D 图纸', description: '形成可继续核查的工程图纸。' },
      { label: '3D 模型', description: '形成零件或装配模型。' },
      { label: '分析报告', description: '记录分析输入、依据与结果。' },
      { label: '电路资料', description: '形成原理、布局或接口资料。' },
    ] }] }); return;
  }
  const valueOf = (id: string): string => {
    const answer = batches.flat().find(item => item.id === id);
    return [...(answer?.selected ?? []), ...(answer?.custom ? [answer.custom] : [])].join('；') || '尚未明确';
  };
  const domain = valueOf('demo_domain'), constraints = valueOf('demo_constraints'), deliverable = valueOf('demo_deliverable');
  const uncertain = /不确定|未知|尚未|待后续|待明确/u.test(deliverable);
  const summary = `已确认的规划方向：${domain}。\n需纳入的设计边界：${constraints}。\n预期产物：${deliverable}。\n待明确：${uncertain ? '交付格式与验收方式仍待明确；' : ''}尚未提供的具体参数保持未知，不由模型补齐。\n建议先建立一个明确交付要求与验收依据的子任务，之后再根据确认的输入细化设计。`;
  if (batches.length === 2) {
    yield* demoText(`我们先核对这份理解：\n\n${summary}\n\n是否按这份理解生成初始任务图谱？`, false);
    yield* demoCall('ask_user_question', { questions: [{ id: 'demo_plan_approval', header: '确认规划', question: '是否按上方需求摘要创建初始子任务？这只确认规划，不表示工程任务已经完成。', options: [
      { label: '生成任务图谱', description: '按已确认方向建图，并保留尚未明确的条件。' },
      { label: '修正条件', description: '先修正当前理解，再继续规划。' },
      { label: '继续澄清', description: '继续讨论，不创建任务节点。' },
    ] }] }, 1); return;
  }
  const approval = batches[2]?.find(item => item.id === 'demo_plan_approval');
  if (approval?.selected.length !== 1 || approval.selected[0] !== '生成任务图谱' || approval.custom) {
    yield* demoText('已保留当前需求讨论，任务图谱没有变化。你可以继续说明需要修正的条件或尚未明确的问题。'); return;
  }
  if (results.length === 3) {
    const initial = prompt.replace('[guided-planning-demo]', '').split('\n[用户提供的参考文件')[0]?.trim() ?? '';
    yield* demoCall('studio_create_task', { definition: JSON.stringify({
      title: `${domain}：确认交付要求与验收依据`,
      goal: `用户初始需求：${initial}\n${summary}\n通过已有资料与用户沟通明确交付要求，记录依据与仍待确定的条件，再进入详细工程任务拆解。`,
      checklist: [{ text: `记录 ${domain} 方向与用户提出的设计边界` }, { text: '明确交付格式和可检查的验收要求' }, { text: '列出尚未确认的参数及其后续确认方式' }],
    }) }); return;
  }
  yield* demoText(results[3]?.isError ? '需求已对齐，但实际创建工具失败，请查看错误后再决定下一步。' : '已根据你明确确认的需求创建初始子任务。尚未确认的工程参数仍保留为待明确，后续可以继续细化。');
}
/** Deterministic native-tool probe only; real Providers continue to choose their own questions. */
export function questionProbe(options: GenerateOptions, prompt: string, userIndex: number): AsyncIterable<StreamChunk> | undefined {
  if (prompt.includes('[guided-planning-demo]')) return guidedDemo(options, prompt, userIndex);
  const match = /^\[questions-[a-z-]+\][ \t]*(\{[^\n]*\})(?:\n|$)/u.exec(prompt);
  if (!match) return undefined;
  const fixture = JSON.parse(match[1]!) as Fixture;
  return (async function* () {
    const schema = options.tools?.find(tool => tool.name === 'ask_user_question');
    const properties = schema?.parameters.properties as Record<string, unknown> | undefined;
    if (!schema || schema.parameters.type !== 'object' || !properties || !('timeout' in properties)) throw new Error('Native timed ask_user_question schema is missing');
    const after = options.messages.slice(userIndex + 1);
    const toolResults = after.filter(message => message.role === 'tool');
    const result = toolResults[0];
    const reply = after.find(message => message.role === 'user' && message.source?.kind === 'user-question-reply');
    const answerMessage = reply ?? result;
    let answer: { pending?: boolean; answers?: unknown } | undefined;
    if (answerMessage) {
      const text = answerMessage.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
      try { answer = JSON.parse(text); } catch { /* Native stop result is an error, never an answer. */ }
    }
    const emitCall = async function* (name: string, args: unknown): AsyncIterable<StreamChunk> {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: brandString<ToolCallId>(randomUUID()), name, arguments: JSON.stringify(args) } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    };
    if (!result && !reply) { yield* emitCall('ask_user_question', { questions: fixture.questions, ...(fixture.timeout === undefined ? {} : { timeout: fixture.timeout }) }); return; }
    if (fixture.expectAnswers !== undefined && answer?.answers !== undefined && JSON.stringify(answer.answers) !== JSON.stringify(fixture.expectAnswers)) throw new Error('The resumed model did not receive the exact explicit native human answer batch');
    const graphResults = toolResults.slice(1);
    const retryAfterExplicitReply = !!reply && graphResults.length === 1 && graphResults[0]?.isError;
    if (fixture.after === 'graph' && (!graphResults.length || retryAfterExplicitReply)) {
      yield* emitCall('studio_create_task', { definition: JSON.stringify({ title: '对齐后创建的受控子任务', goal: '验证明确回答后才允许图谱变更', checklist: [{ text: '检查原生回答与创建顺序' }] }) }); return;
    }
    const text = `Native planning question continuation verified: ${answer?.pending ? 'pending, no answer assumed' : answer?.answers ? 'explicit answers received' : 'stopped without answer'}.`;
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })();
}
