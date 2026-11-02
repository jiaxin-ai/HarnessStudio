import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types';

/** Native DSH question vocabulary; choices are returned by their exact offered labels. */
export type StudioQuestion = AskUserQuestionItem;
export type StudioQuestionAnswer = AskUserQuestionAnswerItem;
export interface StudioPendingQuestion {
  callId: string;
  state: 'open' | 'continued';
  questions: readonly StudioQuestion[];
  canAnswer: boolean;
  replyQueued?: boolean;
}
export interface StudioQuestionView {
  id: string;
  pending: StudioPendingQuestion[];
  settled: Array<{ callId: string; answers: readonly StudioQuestionAnswer[] }>;
}
