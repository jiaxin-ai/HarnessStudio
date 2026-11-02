import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { JsonText } from './json-viewer.tsx';
import type { ChatPacket } from '@harnessstudio/studio/chat-types';
import { emptyChatState, foldChatPacket, conversationRows, observeWorkspaceUpdates, pendingToolCalls, reuseRows, toolLabel, type ConversationRow, type ConversationStep, type WorkspaceUpdateCursor } from './chat-state.ts';
import { ChatTabs } from './chat-tabs.tsx';
import type { RegionControl } from './region.tsx';
import { ChatStats } from './chat-stats.tsx';
import { ChatQuestionCards, useChatQuestions, type ChatQuestionController } from './chat-questions.tsx';
import { AssistantCall } from './chat-call.tsx';
import { ChatRequestDialog, UserMessageRequestButton } from './chat-request.tsx';
import { useChatBackup } from './chat-backup.tsx';
import { AttachmentDrafts, AttachmentPicker, MessageAttachments, useChatAttachmentDraft, useChatAttachmentHistory } from './chat-attachments.tsx';
import type { ChatAttachmentUpload, ChatAttachmentView } from '@harnessstudio/studio/chat-attachment-types';
import { ChatSkillPicker } from './skills.tsx';
import { autonomyMessageLabel } from './autonomy-model.ts';

export interface ModelChoice { provider: string; model: string; providerName: string; supportsImages?: boolean }
const selection = (provider: string, model: string) => JSON.stringify([provider, model]);
const asks = (step: ConversationStep) => step.tools.some(tool => tool.name === 'ask_user_question');
const UserRow = memo(function UserRow({ row, chatId, attachments, onInspect }: {
  row: Extract<ConversationRow, { role: 'user' }>; chatId?: string; attachments: ChatAttachmentView[]; onInspect(userSeq: number): void;
}) {
  return <article className="chat-row user-row"><div className="user-message"><div className="user-bubble"><JsonText text={row.text} fallback={row.text} />{row.images?.length ? <MessageAttachments chatId={chatId} images={row.images} files={attachments} /> : null}</div><UserMessageRequestButton chatId={chatId} rowId={row.id} onInspect={onInspect} /></div></article>;
});
/** Studio wrote this message for an autonomy run, so it is not shown as the person's own bubble. Long instructions fold. */
const AutonomyRow = memo(function AutonomyRow({ row }: { row: Extract<ConversationRow, { role: 'autonomy' }> }) {
  const long = row.text.length > 280 || row.text.split('\n').length > 6, [open, setOpen] = useState(false);
  return <article className={`chat-row autonomy-row is-${row.from}`} aria-label={autonomyMessageLabel(row.from)}><div className="autonomy-message-card">
    <header><svg viewBox="0 0 16 16" aria-hidden="true">{row.from === 'orchestrator' ? <path d="M8 2 9.3 5.6 13 5.8 10.1 8.1 11.1 12 8 9.8 4.9 12 5.9 8.1 3 5.8 6.7 5.6z" /> : <path d="M8 2.5a4 4 0 0 0-4 4v2.7L2.8 11.5h10.4L12 9.2V6.5a4 4 0 0 0-4-4ZM6.5 13a1.5 1.5 0 0 0 3 0" />}</svg>{autonomyMessageLabel(row.from)}</header>
    <div className={`autonomy-message-body${long && !open ? ' is-folded' : ''}`}><JsonText text={row.text} fallback={row.text} /></div>
    {long && <button type="button" className="autonomy-message-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? '收起' : '展开全文'}</button>}
  </div></article>;
});
const AssistantRow = memo(function AssistantRow({ row, activeToolIds, questions, enabled }: {
  row: Extract<ConversationRow, { role: 'assistant' }>; activeToolIds?: ReadonlySet<string>; questions?: ChatQuestionController; enabled: boolean;
}) {
  return <article className="chat-row assistant-row"><span className="assistant-avatar" aria-hidden="true">✦</span><div className="assistant-timeline" aria-label="本轮模型调用">
    {row.steps.map(step => <AssistantCall key={step.id} step={step} activeToolIds={step === row.steps.at(-1) ? activeToolIds : undefined} questions={asks(step) ? questions : undefined} enabled={enabled} />)}
    {row.interrupted && <small className="chat-notice">生成已停止</small>}{row.notice && <small className="chat-notice">{row.notice}</small>}
  </div></article>;
});
/** The transcript only re-renders when the conversation changes, never while the composer is typed in. */
const ConversationLog = memo(function ConversationLog({ rows, chatId, attachments, liveTurn, activeToolIds, questions, enabled, onInspect }: {
  rows: ConversationRow[]; chatId?: string; attachments: ChatAttachmentView[]; liveTurn: unknown; activeToolIds: ReadonlySet<string>; questions: ChatQuestionController; enabled: boolean; onInspect(userSeq: number): void;
}) {
  return <>{rows.map(row => row.role === 'user' ? <UserRow key={row.id} row={row} chatId={chatId} attachments={attachments} onInspect={onInspect} />
    : row.role === 'autonomy' ? <AutonomyRow key={row.id} row={row} />
    : <AssistantRow key={row.id} row={row} activeToolIds={row.turn === liveTurn ? activeToolIds : undefined} questions={row.steps.some(asks) ? questions : undefined} enabled={enabled} />)}</>;
});
export function ChatPane({ region, projectId, taskId, taskLabel, contextKind = 'task', chatId, canWork, disabledCopy, busy, message, onMessage, choices, provider, model, chats, onSelectChat, onSelectModel, onSend, onStop, onSettled, onWorkspaceChanged }: {
  region?: RegionControl; projectId?: string; taskId: string; taskLabel: string; contextKind?: 'task' | 'project'; chatId?: string; canWork: boolean; disabledCopy?: string; busy: boolean; message: string; onMessage: (text: string) => void;
  choices: ModelChoice[]; provider: string; model: string; chats: { id: string; taskId?: string; taskLabel: string; provider: string; model: string; status?: string; role?: 'orchestrator' | 'worker' }[];
  onSelectChat: (id: string) => void; onSelectModel: (choice: ModelChoice) => void;
  onSend: (provider: string, model: string, attachments: ChatAttachmentUpload[]) => Promise<boolean>; onStop: (id: string) => Promise<void>; onSettled?: () => void; onWorkspaceChanged?: () => void;
}) {
  const [state, setState] = useState(emptyChatState), [connection, setConnection] = useState(''), [sending, setSending] = useState(false);
  const [questionPending, setQuestionPending] = useState(false);
  const [requestView, setRequestView] = useState<{ chatId: string; userSeq: number }>();
  const backup = useChatBackup(`${contextKind}:${taskId}`);
  const attachmentDraft = useChatAttachmentDraft(chatId || `new:${taskId}`);
  const panelId = useId();
  const scroll = useRef<HTMLDivElement>(null), follow = useRef(true), input = useRef<HTMLTextAreaElement>(null);
  const observed = useRef<{ id?: string; status?: string; endSeq?: number; awaitingEnd?: boolean }>({});
  const workspaceUpdates = useRef<WorkspaceUpdateCursor>({ results: [] });
  useEffect(() => { setRequestView(undefined); }, [taskId, chatId]);
  useEffect(() => {
    setState(emptyChatState()); setConnection(''); follow.current = true; observed.current = { id: chatId }; workspaceUpdates.current = { chatId, results: [] };
    if (!chatId) return;
    let active = true;
    const source = new EventSource(`/api/studio/chat/stream?id=${encodeURIComponent(chatId)}`);
    source.onopen = () => { if (active) setConnection(''); };
    source.onmessage = event => {
      if (!active) return;
      try { const packet: ChatPacket = JSON.parse(event.data); setState(previous => foldChatPacket(previous, packet)); }
      catch { setConnection('会话数据读取失败，请重新打开对话。'); source.close(); }
    };
    source.onerror = () => { if (active) setConnection('连接中断，正在重连…'); };
    return () => { active = false; source.close(); };
  }, [taskId, chatId]);
  const current = useMemo(() => state.chat?.id === chatId ? state : emptyChatState(), [state, chatId]);
  const stableRows = useRef<ConversationRow[]>([]);
  const rows = useMemo(() => stableRows.current = reuseRows(stableRows.current, state.chat?.id === chatId ? conversationRows(state) : []), [state, chatId]), running = current.status === 'running';
  const activeTools = useMemo(() => pendingToolCalls(current).filter(tool => !questionPending || tool.name !== 'ask_user_question'), [current, questionPending]);
  const activeKey = activeTools.map(tool => tool.id).join('\n'), activeToolIds = useMemo(() => new Set(activeKey ? activeKey.split('\n') : []), [activeKey]);
  const eventVersion = current.events.at(-1)?.seq;
  const questions = useChatQuestions({ chatId, eventVersion, running, enabled: canWork, onPendingChange: setQuestionPending });
  const placedQuestionIds = useMemo(() => new Set(rows.flatMap(row => row.role === 'assistant' ? row.steps.flatMap(step => step.tools.filter(tool => tool.name === 'ask_user_question').map(tool => tool.id)) : [])), [rows]);
  const { liveTurn, latestEnd, latestUser } = useMemo(() => ({ liveTurn: current.events.findLast(event => event.type === 'turn/start')?.data.turn,
    latestEnd: current.events.findLast(event => event.type === 'turn/end')?.seq, latestUser: current.events.findLast(event => event.type === 'user/message')?.seq }), [current.events]);
  // Attachments only arrive with a user message, so other events never refetch their list.
  const attachments = useChatAttachmentHistory(chatId, latestUser);
  const inspect = useCallback((userSeq: number) => { if (chatId) setRequestView({ chatId, userSeq }); }, [chatId]);
  useEffect(() => {
    const update = observeWorkspaceUpdates(workspaceUpdates.current, state, chatId);
    workspaceUpdates.current = update.cursor;
    if (update.changed) onWorkspaceChanged?.();
  }, [chatId, state.chat?.id, state.events, onWorkspaceChanged]);
  useEffect(() => {
    if (!chatId || current.chat?.id !== chatId) return;
    const previous = observed.current;
    if (current.status === 'running') {
      // Keep the end sequence from before this run, even when its end event precedes the idle status.
      observed.current = { id: chatId, status: current.status, endSeq: previous.status === 'running' ? previous.endSeq : latestEnd, awaitingEnd: false };
      return;
    }
    const ended = latestEnd !== undefined && latestEnd !== previous.endSeq;
    const becameIdle = previous.id === chatId && previous.status === 'running' && current.status === 'idle';
    observed.current = { id: chatId, status: current.status, endSeq: latestEnd ?? previous.endSeq,
      awaitingEnd: ended ? false : becameIdle ? true : previous.awaitingEnd };
    // An idle snapshot can contain a completed fast response that finished before SSE subscription.
    // If idle preceded its end event, the fallback above already notified for that same completion.
    if (current.status === 'idle' && (becameIdle || ended && !previous.awaitingEnd)) onSettled?.();
  }, [chatId, current.chat?.id, current.status, latestEnd, onSettled]);
  useEffect(() => { if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [state, sending, questionPending]);
  const boundChat = chats.find(chat => chat.id === chatId);
  const activeProvider = current.chat?.provider ?? boundChat?.provider ?? provider, activeModel = current.chat?.model ?? boundChat?.model ?? model;
  const selected = selection(activeProvider, activeModel), knownChoice = choices.some(row => selection(row.provider, row.model) === selected);
  const supportsImages = choices.find(row => selection(row.provider, row.model) === selected)?.supportsImages;
  const send = async () => {
    if (sending || running || questionPending || busy || !canWork || !message.trim() && !attachmentDraft.files.length || !activeProvider || !activeModel) return;
    setSending(true); follow.current = true;
    try { const uploads = await attachmentDraft.encode(); if (await onSend(activeProvider, activeModel, uploads)) attachmentDraft.clear(); }
    catch (error) { attachmentDraft.setError(error instanceof Error ? error.message : '附件发送失败，请重试。'); }
    finally { setSending(false); input.current?.focus(); }
  };
  const project = contextKind === 'project';
  const chatTabs = chats.map(chat => ({ ...chat, status: chat.id === chatId && current.chat?.id === chatId ? current.status : chat.status }));
  return <section className={`chat-panel${project ? ' project-chat-panel' : ''}`} aria-label={project ? '项目需求对话' : '对话'}>
    <ChatTabs tabs={chatTabs} activeId={chatId} taskId={taskId} currentTaskLabel={taskLabel} contextKind={contextKind} panelId={panelId} disabled={busy || sending} onSelect={onSelectChat} onNew={() => onSelectChat('')} onBackup={id => { void backup.download(id); }} backupBusyId={backup.busyId} region={region} />
    {backup.error && <div className="chat-transfer-notice" role="status">{backup.error}</div>}
    <div id={panelId} role="tabpanel" aria-labelledby={`${panelId}-tab-${chats.some(chat => chat.id === chatId) ? chatId : `new-${taskId}`}`} className="conversation-scroll" ref={scroll} onScroll={() => { const node = scroll.current; if (node) follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 64; }}>
      <div className="conversation-content" role="log" aria-label="聊天记录">
      {rows.length === 0 && !sending && !running && <div className={`conversation-empty${project ? ' project-conversation-empty' : ''}`}>{project ? <svg className="project-idea-icon" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path d="M11 22c0-2-4-5-4-10a9 9 0 0 1 18 0c0 5-4 8-4 10M11 22h10M12 26h8M14 29h4M16 10v7M12 14h8" /></svg> : <span>✦</span>}<h4>{project ? '从一个想法开始' : '从这个任务开始'}</h4><p>{project ? '说说你想做什么，或上传一份草图。先一起明确设计条件，再整理任务图谱。' : '讨论目标、拆解子任务，或调整当前任务图谱。'}</p></div>}
      <ConversationLog rows={rows} chatId={chatId} attachments={attachments} liveTurn={liveTurn} activeToolIds={activeToolIds} questions={questions} enabled={canWork} onInspect={inspect} />
      <ChatQuestionCards controller={questions} enabled={canWork} excludeCallIds={placedQuestionIds} />
      {activeTools.length > 0 && <div className="tool-call-indicator" role="status" aria-live="polite" aria-atomic="true"><span className="tool-call-spinner" aria-hidden="true" /><div><strong>正在调用工具{activeTools.length > 1 ? ` · ${activeTools.length} 个` : ''}</strong><ul>{activeTools.map(tool => <li key={tool.id} title={tool.name}>{toolLabel(tool.name)}</li>)}</ul></div></div>}
      {!activeTools.length && (sending || running && !questionPending && !current.live.some(attempt => attempt.parts.length)) && <div className="generating-indicator"><span /><span /><span /><small>正在生成…</small></div>}
      </div>
    </div>
    {(current.error || connection) && <div className="chat-connection" role="status">{current.error || connection}</div>}
    <form className="chat-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
      <AttachmentDrafts files={attachmentDraft.files} disabled={sending} onRemove={attachmentDraft.remove} />
      <textarea ref={input} aria-label="对话输入" value={message} disabled={!canWork || sending} placeholder={canWork ? project ? '说说你想做什么，以及目前已知的条件…' : '描述你想完成的工作…' : disabledCopy ?? (project ? '当前项目暂时不可发送消息' : '当前任务暂时不可发送消息')} onChange={event => onMessage(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
      {attachmentDraft.error && <p className="chat-attachment-error" role="status">{attachmentDraft.error}</p>}
      {attachmentDraft.files.length > 0 && supportsImages === false && <p className="chat-attachment-error">当前模型未声明图片输入能力，请选择支持图片的模型。</p>}
      <div className="composer-footer"><div className="composer-secondary"><AttachmentPicker disabled={!canWork || sending || busy} onFiles={attachmentDraft.add} /><ChatSkillPicker projectId={projectId} disabled={!canWork || sending || busy} onPick={name => { onMessage(`/${name} ${message.replace(new RegExp(`^/${name}\\s*`), '')}`); input.current?.focus(); }} /><small>{!canWork ? disabledCopy ?? (project ? '当前项目不可编辑' : '当前任务不可编辑') : questionPending ? '请先回答上方问题' : 'Enter 发送 · Shift + Enter 换行'}</small></div><div className="composer-actions">
        <select aria-label="模型选择" title="使用后台已保存的模型；切换模型会开启新对话，历史仍保留" value={selected} disabled={busy || sending || running} onChange={event => { const row = choices.find(item => selection(item.provider, item.model) === event.target.value); if (row) onSelectModel(row); }}>
          {!knownChoice && <option value={selected}>{activeModel || (choices.length ? '请选择模型' : '请先配置 Provider')}</option>}
          {[...new Set(choices.map(row => row.provider))].map(id => <optgroup key={id} label={choices.find(row => row.provider === id)!.providerName}>{choices.filter(row => row.provider === id).map(row => <option key={row.model} value={selection(row.provider, row.model)}>{row.model}</option>)}</optgroup>)}
        </select>
        {running && chatId ? <button className="send-button stop-button" type="button" aria-label="停止生成" title="停止生成" disabled={busy} onClick={() => { void onStop(chatId); }}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2" /></svg></button> : <button className="send-button" type="submit" aria-label="发送" title="发送" disabled={busy || sending || questionPending || !canWork || !activeProvider || !activeModel || !message.trim() && !attachmentDraft.files.length}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m-5 5 5-5 5 5" /></svg></button>}
      </div></div>
    </form>
    <ChatStats key={chatId ?? 'new'} metrics={current.metrics} />
    {requestView && requestView.chatId === chatId && <ChatRequestDialog key={`${requestView.chatId}:${requestView.userSeq}`} chatId={requestView.chatId} userSeq={requestView.userSeq} onClose={() => setRequestView(undefined)} />}
  </section>;
}
