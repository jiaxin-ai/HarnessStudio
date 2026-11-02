import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Children, isValidElement, memo, useState, type ReactNode } from 'react';
import { JsonText } from './json-viewer.tsx';
import { webActivities, graphActivities, questionActivities, toolLabel, safeWebUrl, type ConversationStep, type ToolTrace } from './chat-state.ts';
import { ChatQuestionCards, type ChatQuestionController } from './chat-questions.tsx';
import { useNoSoftware } from './software-backend.ts';

function JsonCodeBlock({ children }: { children?: ReactNode }) {
  const code = Children.toArray(children)[0];
  if (!isValidElement<{ children?: ReactNode; className?: string }>(code) || typeof code.props.children !== 'string') return <pre>{children}</pre>;
  const language = code.props.className, json = /(?:^|\s)language-json(?:\s|$)/i.test(language ?? '');
  if (language && !json) return <pre>{children}</pre>;
  return <JsonText text={code.props.children} allowPrimitive={json} fallback={<pre>{children}</pre>} />;
}
/** Markdown parsing dominates long chats: parse each text once, not on every keystroke or stream frame. */
const Prose = memo(function Prose({ text }: { text: string }) {
  return <JsonText text={text} fallback={<Markdown remarkPlugins={[remarkGfm]} components={{ pre: JsonCodeBlock, a: ({ href, children, ...props }) => { const url = safeWebUrl(href); return url ? <a {...props} href={url} target="_blank" rel="noreferrer noopener">{children}</a> : <span>{children}</span>; }, img: props => <span className="chat-image-reference">图片：{props.alt || '附件'}</span> }}>{text}</Markdown>} />;
});
function WebEvidence({ steps }: { steps: ConversationStep[] }) {
  const activities = webActivities(steps);
  if (!activities.length) return null;
  return <div className="web-evidence" aria-label="联网检索来源">{activities.map(activity => <section className={`web-activity web-${activity.status}`} key={activity.id}>
    <header><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" /><path d="M3 10h14M10 3c4 4 4 10 0 14M10 3c-4 4-4 10 0 14" /></svg><span>{activity.kind === 'search' ? '联网搜索' : '读取网页'}</span><small>{activity.status === 'pending' ? '进行中…' : activity.status === 'failed' ? '未完成' : activity.kind === 'search' ? `${activity.sources.length} 个来源` : `已读取${activity.statusCode !== undefined ? ` · HTTP ${activity.statusCode}` : ''}`}</small></header>
    {activity.label && <p className="web-query" title={activity.label}>{activity.label}</p>}
    {activity.status === 'failed' && <p className="web-note">检索失败，可展开此卡片下的工具详情。</p>}
    {activity.status === 'complete' && !activity.sources.length && <p className="web-note">暂无可展示的来源链接。</p>}
    {activity.sources.length > 0 && <ol className="web-source-list">{activity.sources.map((source, index) => <li key={`${source.url}-${index}`}><a href={source.url} target="_blank" rel="noreferrer noopener" title={source.url}><span className="web-source-number">{index + 1}</span><span className="web-source-title">{source.title || new URL(source.url).hostname}</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3h8v8M13 3 3 13" /></svg></a><div className="web-source-details"><span>{new URL(source.url).hostname}</span>{source.publishedAt && <span>· {source.publishedAt}</span>}</div>{source.snippet && <p className="web-snippet">{source.snippet}</p>}</li>)}</ol>}
    {activity.truncated && <p className="web-note">结果已按上限截断。</p>}
    {activity.artifact && <p className="web-artifact" title={activity.artifact.path}>本对话临时结果：<code>{activity.artifact.path}</code><span>{Math.max(1, Math.ceil(activity.artifact.bytes / 1024))} KB</span></p>}
  </section>)}</div>;
}
function GraphChanges({ steps }: { steps: ConversationStep[] }) {
  const activities = graphActivities(steps);
  if (!activities.length) return null;
  return <div className="web-evidence" aria-label="任务图谱调整">{activities.map(activity => <section className={`web-activity web-${activity.status}`} key={activity.id}>
    <header><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="2" width="6" height="4" rx="1" /><rect x="2" y="14" width="6" height="4" rx="1" /><rect x="12" y="14" width="6" height="4" rx="1" /><path d="M10 6v4M5 14v-4h10v4" /></svg><span>调整任务图谱</span><small>{activity.status === 'pending' ? '进行中…' : activity.status === 'failed' ? '未完成' : '已更新'}</small></header>
    <p className="web-note">{activity.summary.replace('可展开思考过程查看详情', '可展开此卡片下的工具详情')}</p>
  </section>)}</div>;
}
function QuestionHistory({ steps }: { steps: ConversationStep[] }) {
  return <>{questionActivities(steps).map(activity => activity.status === 'complete'
    ? <details className="planning-answer-summary" key={activity.id}><summary>{activity.summary}</summary><dl>{activity.questions.map(question => <div key={question.id}><dt>{question.question}</dt><dd>{[...question.selected, ...(question.custom ? [question.custom] : [])].join('；') || '未填写'}</dd></div>)}</dl></details>
    : <div className="planning-answer-summary" key={activity.id}><p>{activity.summary}</p></div>)}</>;
}
function Thought({ step }: { step: ConversationStep }) {
  const [expanded, setExpanded] = useState(false);
  if (!step.reasoning.length) return null;
  // Collapsed thoughts hold most of a long chat's text; render them only once opened, like tool details.
  return <details className="thought-tree" onToggle={event => setExpanded(event.currentTarget.open)}><summary><svg className="thought-chevron" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="m6 3 5 5-5 5" /></svg>{step.streaming ? '思考中' : '思考过程'}</summary>
    {expanded && <ol className="thought-branches">{step.reasoning.map((text, index) => <li key={index}><div className="thought-prose"><Prose text={text} /></div></li>)}</ol>}
  </details>;
}
function ToolTraceContents({ tool }: { tool: ToolTrace }) {
  return <div className="tool-trace"><small>参数</small><JsonText text={tool.arguments} allowPrimitive />{tool.result !== undefined && <><small>{tool.failed ? '执行失败' : '结果'}</small><JsonText text={tool.result} allowPrimitive /></>}</div>;
}
function ToolCard({ step, tool, active, questions, enabled }: {
  step: ConversationStep; tool: ToolTrace; active: boolean; questions?: ChatQuestionController; enabled: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const onToggle = (event: { currentTarget: HTMLDetailsElement }) => setExpanded(event.currentTarget.open);
  const noSoftware = useNoSoftware();
  const one = { ...step, tools: [tool] }, steps = [one];
  const web = tool.name === 'web_search' || tool.name === 'web_fetch';
  const graph = graphActivities(steps).length > 0;
  const question = tool.name === 'ask_user_question';
  const answers = questionActivities(steps);
  const pending = questions?.pending.some(item => item.callId === tool.id);
  // A cold persisted conversation may end at a tool/call after the Host was
  // interrupted. Only a live native run may claim the operation is running;
  // don't invent an outcome or restart an engineering operation from the UI.
  if (tool.result === undefined && !active && !pending) return <details className="call-tool is-unknown" data-tool={tool.name} onToggle={onToggle}><summary>
    <svg className="thought-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg><span>{toolLabel(tool.name)}</span><small>结果未明</small>
  </summary>{expanded && <><p className="chat-notice">这次调用尚无已保存的结果。请核对工作文件{noSoftware ? '' : '或软件操作记录'}，再决定是否继续；重新打开对话不会自动执行该操作。</p><ToolTraceContents tool={tool} /></>}</details>;
  if (web || graph || question) return <div className="call-tool-card" data-tool={tool.name}>
    {web ? <WebEvidence steps={steps} /> : graph ? <GraphChanges steps={steps} /> : <>
      <QuestionHistory steps={steps} />
      {!answers.length && !pending && <div className="call-question-placeholder">{active ? '正在准备提问…' : '需求澄清问题'}</div>}
      {questions && !answers.length && <ChatQuestionCards controller={questions} callId={tool.id} enabled={enabled} />}
    </>}
    <details className="call-tool-details" onToggle={onToggle}><summary>工具详情</summary>{expanded && <ToolTraceContents tool={tool} />}</details>
  </div>;
  return <details className={`call-tool${active ? ' is-running' : ''}`} data-tool={tool.name} onToggle={onToggle}><summary>
    <svg className="thought-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg>
    <span>{toolLabel(tool.name)}</span><small>{tool.failed ? '未完成' : tool.result !== undefined ? '已完成' : active ? '正在调用工具' : '尚无结果'}</small>
  </summary>{expanded && <ToolTraceContents tool={tool} />}</details>;
}

/** One native model call, followed by its own tools in their actual call order. Unchanged calls skip re-rendering. */
export const AssistantCall = memo(function AssistantCall({ step, activeToolIds, questions, enabled = false }: {
  step: ConversationStep; activeToolIds?: ReadonlySet<string>; questions?: ChatQuestionController; enabled?: boolean;
}) {
  const waiting = step.tools.some(tool => questions?.pending.some(item => item.callId === tool.id));
  const usingTools = step.tools.some(tool => activeToolIds?.has(tool.id));
  return <section className="assistant-bubble assistant-step" role="group" aria-label={`模型调用 · 步骤 ${step.number}`} data-step={step.number}>
    <header className="assistant-step-header"><span className="assistant-step-number">步骤 {step.number}</span><span className="assistant-call-label">模型调用</span>{(step.streaming || waiting || usingTools) && <small className="assistant-step-status">{waiting ? '等待回答' : usingTools ? '调用工具中' : '生成中'}</small>}</header>
    <Thought step={step} />
    {step.text.map((text, index) => <div className={`answer-prose ${step.streaming ? 'streaming-answer' : ''}`} key={index}><Prose text={text} /></div>)}
    {step.tools.length > 0 && <div className="assistant-step-tools" aria-label={`步骤 ${step.number} 的工具调用`}>{step.tools.map(tool => <ToolCard key={tool.id} step={step} tool={tool} active={activeToolIds?.has(tool.id) ?? false} questions={questions} enabled={enabled} />)}</div>}
  </section>;
});
