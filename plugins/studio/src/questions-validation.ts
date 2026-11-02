import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types';

export class StudioQuestionError extends Error {
  constructor(message: string, readonly code: string, readonly status = 400) { super(message); }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StudioQuestionError('问题回答必须使用对象格式', 'BAD_ANSWER');
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new StudioQuestionError(`${label}为空或过长`, 'BAD_ANSWER');
  return value;
}
/** Bound oversized/malformed model questions before accepting a long-lived UI wait. */
export function validateQuestions(questions: readonly AskUserQuestionItem[]): void {
  if (!Array.isArray(questions) || !questions.length || questions.length > 12) throw new StudioQuestionError('每批问题必须包含 1–12 个条目', 'BAD_QUESTIONS');
  const ids = new Set<string>();
  for (const question of questions) {
    text(question.id, 128, '问题 ID'); text(question.question, 4096, '问题');
    if (ids.has(question.id)) throw new StudioQuestionError('问题 ID 不能重复', 'BAD_QUESTIONS');
    ids.add(question.id);
    if (question.header !== undefined) text(question.header, 128, '问题标题');
    if (question.detail !== undefined) text(question.detail, 16384, '问题补充信息');
    if (question.multiSelect !== undefined && typeof question.multiSelect !== 'boolean') throw new StudioQuestionError('多选标记无效', 'BAD_QUESTIONS');
    const options = question.options ?? [];
    if (!Array.isArray(options) || options.length > 30) throw new StudioQuestionError('问题选项过多', 'BAD_QUESTIONS');
    const labels = new Set<string>();
    for (const option of options) {
      text(option.label, 256, '选项');
      if (labels.has(option.label)) throw new StudioQuestionError('同一问题的选项不能重复', 'BAD_QUESTIONS');
      labels.add(option.label);
      if (option.description !== undefined) text(option.description, 2048, '选项说明');
    }
  }
  if (JSON.stringify(questions).length > 65536) throw new StudioQuestionError('问题内容过大，请分批提问', 'BAD_QUESTIONS');
}

/** Require an explicit answer for every question; empty/default selections never count as consent. */
export function validateAnswers(questions: readonly AskUserQuestionItem[], value: unknown): AskUserQuestionAnswer {
  validateQuestions(questions);
  if (!Array.isArray(value) || value.length !== questions.length) throw new StudioQuestionError('请明确回答本批的每一个问题', 'BAD_ANSWER');
  const offered = new Map(questions.map(question => [question.id, question]));
  const seen = new Set<string>();
  const answers = value.map(entry => {
    const answer = record(entry), id = text(answer.id, 128, '问题 ID');
    if (Object.keys(answer).some(key => !['id', 'selected', 'custom'].includes(key))) throw new StudioQuestionError('回答包含未知字段', 'BAD_ANSWER');
    const question = offered.get(id);
    if (!question || seen.has(id)) throw new StudioQuestionError('回答包含未知或重复的问题 ID', 'BAD_ANSWER');
    seen.add(id);
    if (!Array.isArray(answer.selected) || answer.selected.some(label => typeof label !== 'string')) throw new StudioQuestionError('已选选项必须是文字列表', 'BAD_ANSWER');
    const selected = answer.selected as string[];
    const labels = new Set((question.options ?? []).map(option => option.label));
    if (new Set(selected).size !== selected.length || selected.some(label => !labels.has(label))) throw new StudioQuestionError('回答包含未提供或重复的选项', 'BAD_ANSWER');
    const custom = answer.custom === undefined ? undefined : text(answer.custom, 8192, '补充回答').trim();
    if (!selected.length && custom === undefined) throw new StudioQuestionError('请选择、补充回答，或明确选择暂不确定', 'BAD_ANSWER');
    if (!question.multiSelect && (selected.length > 1 || (selected.length && custom !== undefined))) throw new StudioQuestionError('单选题只能选择一个选项，或提供一项自定义回答', 'BAD_ANSWER');
    return { id, selected: [...selected], ...(custom === undefined ? {} : { custom }) };
  });
  if (JSON.stringify(answers).length > 65536) throw new StudioQuestionError('回答内容过大', 'BAD_ANSWER');
  return { answers };
}

export function questionAnswerRequest(value: unknown): { id: string; callId: string; answers: unknown } {
  const body = record(value);
  if (Object.keys(body).some(key => !['id', 'callId', 'answers'].includes(key))) throw new StudioQuestionError('问题提交包含未知字段', 'BAD_ANSWER');
  return { id: text(body.id, 128, '对话 ID'), callId: text(body.callId, 256, '问题调用 ID'), answers: body.answers };
}
