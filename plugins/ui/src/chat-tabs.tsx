import { useEffect, useRef, type KeyboardEvent } from 'react';
import { RegionButtons, onTitleBarDoubleClick, type RegionControl } from './region.tsx';
import { chatRoleLabel } from './autonomy-model.ts';

/** `role` marks the conversations of an autonomy run's orchestrator and workers. */
export interface ChatTab { id: string; taskId?: string; model: string; taskLabel: string; status?: string; role?: 'orchestrator' | 'worker' }
export interface ChatTabsProps {
  tabs: readonly ChatTab[];
  activeId?: string;
  taskId: string;
  currentTaskLabel: string;
  contextKind?: 'task' | 'project';
  panelId: string;
  disabled?: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onBackup?: (id: string) => void;
  backupBusyId?: string;
  /** Maximize control shown at the end of the strip; double-clicking empty strip space toggles it too. */
  region?: RegionControl;
}

/** Conversations belonging to the current project page or task page only. */
export function ChatTabs({ tabs, activeId, taskId, currentTaskLabel, contextKind = 'task', panelId, disabled = false, onSelect, onNew, onBackup, backupBusyId, region }: ChatTabsProps) {
  const track = useRef<HTMLDivElement>(null), buttons = useRef(new Map<string, HTMLButtonElement>());
  const storedActive = activeId ? tabs.find(tab => tab.id === activeId) : undefined;
  const draftKey = `new-${taskId}`;
  const rows: (ChatTab & { key: string; title: string; draft: boolean })[] = tabs.map((tab, index) => ({ ...tab, key: tab.id, title: `对话 ${index + 1}`, draft: false }));
  if (!storedActive) rows.push({ id: '', taskId, model: '', taskLabel: currentTaskLabel, key: draftKey, title: '新对话', draft: true });
  const selectedKey = storedActive?.id ?? draftKey;
  const rowKeys = rows.map(row => row.key).join('|');
  const fallbackLabel = contextKind === 'project' ? '当前项目' : '当前任务';

  useEffect(() => {
    const viewport = track.current, selected = buttons.current.get(selectedKey);
    if (!viewport || !selected) return;
    const reveal = () => {
      const visible = viewport.getBoundingClientRect(), tab = selected.getBoundingClientRect();
      // Scroll only this horizontal track, so selecting a tab never moves the workbench or transcript.
      const delta = tab.left < visible.left ? tab.left - visible.left : tab.right > visible.right ? tab.right - visible.right : 0;
      if (delta) viewport.scrollBy({ left: delta, behavior: 'auto' });
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(viewport); observer.observe(selected);
    return () => observer.disconnect();
  }, [selectedKey, rowKeys]);

  const select = (index: number) => {
    const row = rows[index];
    if (!row || disabled || row.key === selectedKey) return;
    if (row.draft) onNew(); else onSelect(row.id);
  };
  const navigate = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (disabled || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.key === 'ArrowRight' ? (index + 1) % rows.length
      : event.key === 'ArrowLeft' ? (index + rows.length - 1) % rows.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : undefined;
    if (target === undefined) return;
    event.preventDefault();
    select(target);
    buttons.current.get(rows[target].key)?.focus({ preventScroll: true });
  };

  return <div className="chat-tab-strip" onDoubleClick={onTitleBarDoubleClick(region)}>
    <div className="chat-tab-track" ref={track} role="tablist" aria-label={contextKind === 'project' ? '项目对话' : '任务对话'} aria-orientation="horizontal">{rows.map((row, index) => {
      const selected = row.key === selectedKey;
      const role = row.role && chatRoleLabel(row.role);
      const title = `${row.taskLabel || fallbackLabel}${role ? `\n自主运行的${role}` : ''}${row.model ? `\n模型：${row.model}` : '\n选择模型后开始对话'}`;
      const canBackup = row.status === 'idle' || row.status === 'stored';
      const saving = backupBusyId === row.id;
      return <div className={`chat-tab-item${selected ? ' is-active' : ''}${row.draft ? ' is-draft' : ''}`} key={row.key} role="presentation"><button ref={element => { if (element) buttons.current.set(row.key, element); else buttons.current.delete(row.key); }}
        className={`chat-tab${selected ? ' is-active' : ''}${row.draft ? ' is-draft' : ''}`} type="button" role="tab"
        id={`${panelId}-tab-${row.key}`} aria-controls={panelId} aria-selected={selected} aria-label={`${row.title}${role ? `，${role}` : ''}，${row.taskLabel || fallbackLabel}${row.model ? `，${row.model}` : ''}`}
        tabIndex={selected ? 0 : -1} disabled={disabled} title={title} onClick={() => select(index)} onKeyDown={event => navigate(event, index)}>
        {row.role && <span className={`chat-tab-role is-${row.role}`} aria-hidden="true">{role}</span>}<span className="chat-tab-title">{row.title}</span>
      </button>{selected && !row.draft && onBackup && <button className="chat-tab-backup" type="button" aria-label="下载当前对话调试 JSON" title={saving ? '正在下载调试 JSON…' : canBackup ? '下载当前对话调试 JSON' : row.status === 'running' ? '请等本轮结束后下载对话' : '正在确认对话状态，请稍候'} disabled={disabled || !canBackup || !!backupBusyId} onClick={() => onBackup(row.id)}>
        {saving ? <span className="chat-transfer-spinner" aria-hidden="true" /> : <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M10 3v10m-3-3 3 3 3-3M4 13v4h12v-4" /></svg>}
      </button>}</div>;
    })}</div>
    <button className="chat-tab-new" type="button" aria-label="新建对话" title={contextKind === 'project' ? '在当前项目下新建需求对话' : '在当前任务下新建对话'} disabled={disabled} onClick={onNew}>
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 3v10M3 8h10" /></svg>
    </button>
    {region && <div className="region-actions"><RegionButtons control={region} name="对话区" /></div>}
  </div>;
}
