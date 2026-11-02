import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { StudioPendingQuestion, StudioQuestionAnswer, StudioQuestionView } from '@harnessstudio/studio/questions-types';
import { api } from './api.ts';

interface DraftAnswer { selected: string[]; custom: string; mode?: 'custom' | 'unknown' }
const drafts = new Map<string, Record<string, DraftAnswer>>();
const blank = (): DraftAnswer => ({ selected: [], custom: '' });
const noQuestions: StudioPendingQuestion[] = [];
const unknownAnswer = '暂不确定，待后续明确';
const displayLabel = (label: string) => label.replace(/\s*(?:\((?:Recommended|推荐)\)|（(?:Recommended|推荐)）)\s*$/i, '');

function QuestionCard({ chatId, pending, disabled, onAnswered }: {
  chatId: string; pending: StudioPendingQuestion; disabled: boolean; onAnswered(): Promise<void>;
}) {
  const key = `${chatId}:${pending.callId}`;
  const [answers, setAnswers] = useState<Record<string, DraftAnswer>>(() => drafts.get(key) ?? {});
  const [index, setIndex] = useState(0), [sending, setSending] = useState(false), [submitted, setSubmitted] = useState(false), [error, setError] = useState('');
  const question = pending.questions[index], heading = useRef<HTMLHeadingElement>(null);
  const complete = (id: string) => { const answer = answers[id]; return !!answer && (answer.mode === 'unknown' || !!answer.selected.length || !!answer.custom.trim()); };
  const answered = pending.questions.filter(item => complete(item.id)).length;
  const locked = disabled || sending || submitted || !pending.canAnswer;
  useEffect(() => { drafts.set(key, answers); }, [key, answers]);
  if (!question) return null;
  const draft = answers[question.id] ?? blank();
  const update = (value: DraftAnswer) => { setError(''); setAnswers(previous => ({ ...previous, [question.id]: value })); };
  const navigate = (value: number) => { setIndex(value); requestAnimationFrame(() => heading.current?.focus()); };
  const choose = (label: string) => question.multiSelect
    ? update({ ...draft, selected: draft.selected.includes(label) ? draft.selected.filter(item => item !== label) : [...draft.selected, label], mode: draft.mode === 'custom' ? 'custom' : undefined, custom: draft.mode === 'unknown' ? '' : draft.custom })
    : update({ selected: [label], custom: '', mode: undefined });
  const submit = async () => {
    if (locked || answered !== pending.questions.length) return;
    setSending(true); setError('');
    try {
      const batch: StudioQuestionAnswer[] = pending.questions.map(item => {
        const answer = answers[item.id]!;
        return { id: item.id, selected: answer.mode === 'unknown' ? [] : answer.selected,
          ...(answer.mode === 'unknown' ? { custom: unknownAnswer } : answer.custom.trim() ? { custom: answer.custom.trim() } : {}) };
      });
      await api('chat/questions/answer', { id: chatId, callId: pending.callId, answers: batch });
      setSubmitted(true);
      drafts.delete(key); await onAnswered();
    } catch (error) { setError(error instanceof Error ? error.message : '回答提交失败，请重试'); }
    finally { setSending(false); }
  };
  return <section className="planning-question-card" aria-label="需求对齐问题" aria-busy={sending}>
    <header><span className="planning-question-symbol" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="M4 3h12v10H9l-4 4v-4H4zM7 6h6M7 9h4" /></svg></span><div><strong>一起明确需求</strong><small>{pending.replyQueued || submitted ? '回答已提交，等待模型继续' : pending.canAnswer ? '选择后提交，也可以填写自己的想法' : '问题正在恢复，请稍候'}</small></div><span>{index + 1} / {pending.questions.length}</span></header>
    {pending.questions.length > 1 && <nav aria-label="需求问题导航">{pending.questions.map((item, position) => <button key={item.id} type="button" aria-current={position === index ? 'step' : undefined} disabled={sending} onClick={() => navigate(position)}><span aria-hidden="true">{complete(item.id) ? '✓' : position + 1}</span>{item.header || `问题 ${position + 1}`}</button>)}</nav>}
    <h4 ref={heading} tabIndex={-1}>{question.question}</h4>
    {question.detail && <p className="planning-question-detail">{question.detail}</p>}
    <fieldset disabled={locked} aria-label={question.question}>
      {(question.options ?? []).map(option => <label className={`planning-question-option${draft.selected.includes(option.label) ? ' is-selected' : ''}`} key={option.label}><input type={question.multiSelect ? 'checkbox' : 'radio'} name={`${key}:${question.id}`} checked={draft.selected.includes(option.label)} onChange={() => choose(option.label)} /><span><strong>{displayLabel(option.label)}</strong>{option.description && <small>{option.description}</small>}</span></label>)}
      {!!question.options?.length && <div className="planning-question-alternatives"><label><input type={question.multiSelect ? 'checkbox' : 'radio'} name={`${key}:${question.id}`} checked={draft.mode === 'custom'} onChange={() => update({ selected: question.multiSelect ? draft.selected : [], custom: '', mode: draft.mode === 'custom' && question.multiSelect ? undefined : 'custom' })} />自行填写</label><label><input type="radio" name={`${key}:${question.id}`} checked={draft.mode === 'unknown'} onChange={() => update({ selected: [], custom: '', mode: 'unknown' })} />暂不确定</label></div>}
      {(!question.options?.length || draft.mode === 'custom') && <textarea aria-label={`补充回答：${question.header || question.question}`} value={draft.custom} maxLength={8000} rows={3} placeholder="填写你的回答、想法或补充信息；不确定的部分也可以说明…" onChange={event => update({ ...draft, custom: event.target.value, mode: question.options?.length ? 'custom' : undefined })} />}
      {!question.options?.length && <label className="planning-question-unknown"><input type="checkbox" checked={draft.mode === 'unknown'} onChange={event => update({ selected: [], custom: '', mode: event.target.checked ? 'unknown' : undefined })} />暂不确定，后续再明确</label>}
    </fieldset>
    {error && <p className="planning-question-error" role="status">{error}</p>}
    <footer><span>{answered} / {pending.questions.length} 项已填写</span><div>{index > 0 && <button type="button" disabled={sending} onClick={() => navigate(index - 1)}>上一题</button>}{index < pending.questions.length - 1 ? <button type="button" disabled={locked || !complete(question.id)} onClick={() => navigate(index + 1)}>下一题</button> : <button className="planning-question-submit" type="button" disabled={locked || answered !== pending.questions.length} onClick={() => { void submit(); }}>{submitted ? '回答已提交' : sending ? '正在提交…' : '提交回答'}</button>}</div></footer>
  </section>;
}

/** Poll native pending state while waiting; SSE durable tool events trigger an immediate refresh. */
export function useChatQuestions({ chatId, eventVersion, running, enabled, onPendingChange }: {
  chatId?: string; eventVersion?: number; running: boolean; enabled: boolean; onPendingChange?(pending: boolean): void;
}) {
  const [view, setView] = useState<StudioQuestionView>(), [error, setError] = useState('');
  const generation = useRef(0), mounted = useRef(true), inFlight = useRef(false);
  const load = useCallback(async () => {
    if (!chatId || !enabled || inFlight.current) return;
    const sequence = generation.current; inFlight.current = true;
    try {
      const value = await api<StudioQuestionView>(`chat/questions?id=${encodeURIComponent(chatId)}`);
      // Polling usually returns the same view; keeping it avoids re-rendering every question call in the transcript.
      if (mounted.current && sequence === generation.current) { setView(previous => previous && JSON.stringify(previous) === JSON.stringify(value) ? previous : value); setError(''); onPendingChange?.(!!value.pending.length); }
    } catch (error) { if (mounted.current && sequence === generation.current) setError(error instanceof Error ? error.message : '需求问题读取失败'); }
    finally { if (sequence === generation.current) inFlight.current = false; }
  }, [chatId, enabled, onPendingChange]);
  useEffect(() => {
    mounted.current = true; generation.current++; inFlight.current = false; setView(undefined); setError(''); onPendingChange?.(false); void load();
    return () => { mounted.current = false; generation.current++; inFlight.current = false; };
  }, [chatId, enabled, load]);
  useEffect(() => { void load(); }, [eventVersion, load]);
  useEffect(() => {
    if (!chatId || !enabled || !running && !view?.pending.length) return;
    const timer = window.setInterval(() => { void load(); }, 1200); return () => window.clearInterval(timer);
  }, [chatId, enabled, running, !!view?.pending.length, load]);
  return useMemo(() => ({ chatId, pending: chatId && view?.id === chatId ? view.pending : noQuestions, error, reload: load }), [chatId, view, error, load]);
}

export type ChatQuestionController = ReturnType<typeof useChatQuestions>;
/** One native polling controller; its cards can live at their original tool positions. */
export function ChatQuestionCards({ controller, enabled, callId, excludeCallIds }: {
  controller: ChatQuestionController; enabled: boolean; callId?: string; excludeCallIds?: ReadonlySet<string>;
}) {
  const { chatId, pending, error, reload } = controller;
  const visible = pending.filter(item => (callId === undefined || item.callId === callId) && !excludeCallIds?.has(item.callId));
  if (!chatId || !visible.length) return null;
  return <div className="planning-question-area">{visible.map(item => <QuestionCard key={`${chatId}:${item.callId}`} chatId={chatId} pending={item} disabled={!enabled} onAnswered={reload} />)}{error && <p className="planning-question-error" role="status">{error}<button type="button" onClick={() => { void reload(); }}>重试</button></p>}</div>;
}
