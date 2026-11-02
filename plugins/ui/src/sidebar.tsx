import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { stateNames, type Project, type TaskDirectoryEntry, type SingleUserTaskState } from '@harnessstudio/studio/domain-types';
import { TaskActivityLight } from './task-activity-light.tsx';
import { defaultTaskActivity, taskActivityLabel, type TaskActivityMap } from './task-activity.ts';
import { AutonomyProjectMark } from './autonomy.tsx';
import { isOpenRun, type RunSummary } from './autonomy-model.ts';

function Chevron({ open }: { open: boolean }) {
  return <svg className={`sidebar-chevron ${open ? 'is-open' : ''}`} viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>;
}
function Folder() {
  return <svg className="sidebar-folder" viewBox="0 0 20 20" aria-hidden="true"><path d="M2.5 5.5h6l2 2h7v8.5h-15z" /></svg>;
}
function FileIcon() {
  return <svg className="sidebar-folder" viewBox="0 0 20 20" aria-hidden="true"><path d="M5 2.5h6l4 4v11H5zM11 2.5v4h4" /></svg>;
}
export function isProjectMenuKey(key: string, shiftKey: boolean) { return key === 'ContextMenu' || key === 'F10' && shiftKey; }
export function nextProjectMenuIndex(key: string, current: number, length: number): number | undefined {
  if (!length || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key)) return;
  return key === 'Home' ? 0 : key === 'End' ? length - 1 : (current + (key === 'ArrowUp' ? -1 : 1) + length) % length;
}
export function ProjectContextMenuItems({ project, onRename, onExport, onDelete }: { project: Project; onRename(): void; onExport(): void; onDelete(): void }) {
  return <>
    <button type="button" role="menuitem" onClick={onRename}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 11-.5 2.5L5 13l7.5-7.5-2-2zM9.5 4.5l2 2" /></svg>重命名项目…</button>
    <button type="button" role="menuitem" onClick={onExport}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v7M5.5 7 8 9.5 10.5 7M3 10.5v3h10v-3" /></svg>导出项目…</button>
    <div className="sidebar-menu-divider" role="separator" />
    <button type="button" role="menuitem" className="sidebar-menu-delete" onClick={onDelete}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4h10M6 4V2h4v2M4 4l.7 9h6.6l.7-9M6.5 6.5v4M9.5 6.5v4" /></svg>删除项目…</button>
  </>;
}
export function ProjectSidebar({ projects, tasks, activity, autonomy, projectId, selectedTaskId, active, onNewProject, onProject, onTask, onModels, onSkills, onMcp, onPlugins, onRenameProject, onExportProject, onDeleteProject, message }: {
  projects: Project[]; tasks: TaskDirectoryEntry[]; activity?: TaskActivityMap; projectId: string; selectedTaskId: string; active: 'workspace' | 'models' | 'skills' | 'mcp' | 'plugins';
  /** The newest autonomy run of each project; an open one is marked on its project row. */
  autonomy?: ReadonlyMap<string, RunSummary>;
  onNewProject: () => void; onProject: (id: string) => void; onTask: (projectId: string, id: string) => void; onModels: () => void; onSkills: () => void; onMcp: () => void; onPlugins: () => void;
  onRenameProject: (project: Project) => void; onExportProject: (project: Project) => void; onDeleteProject: (project: Project) => void; message: string;
}) {
  const [sectionOpen, setSectionOpen] = useState(true), [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [taskExpanded, setTaskExpanded] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{ project: Project; x: number; y: number }>();
  const menuElement = useRef<HTMLDivElement>(null), previousFocus = useRef<HTMLElement>();
  useEffect(() => { if (projectId) setExpanded(previous => ({ ...previous, [projectId]: true })); }, [projectId]);
  useEffect(() => {
    const ancestors: Record<string, boolean> = {}, seen = new Set<string>();
    let row = tasks.find(task => task.id === selectedTaskId);
    while (row?.parentId && !seen.has(row.parentId)) {
      seen.add(row.parentId); ancestors[row.parentId] = true; row = tasks.find(task => task.id === row!.parentId);
    }
    if (seen.size) setTaskExpanded(previous => ({ ...previous, ...ancestors }));
  }, [selectedTaskId, tasks]);
  useEffect(() => {
    if (!menu) return;
    if (!projects.some(project => project.id === menu.project.id)) { setMenu(undefined); return; }
    menuElement.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => { if (!menuElement.current?.contains(event.target as Node)) setMenu(undefined); };
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); setMenu(undefined);
        if (previousFocus.current?.isConnected) previousFocus.current.focus({ preventScroll: true });
      } else if (event.key === 'Tab') setMenu(undefined);
    };
    const dismiss = () => setMenu(undefined);
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', keydown);
    window.addEventListener('resize', dismiss); document.addEventListener('scroll', dismiss, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', keydown);
      window.removeEventListener('resize', dismiss); document.removeEventListener('scroll', dismiss, true);
    };
  }, [menu, projects]);
  const openProjectMenu = (event: ReactMouseEvent | MouseEvent, project: Project) => {
    event.preventDefault(); event.stopPropagation();
    if (document.activeElement instanceof HTMLElement) previousFocus.current = document.activeElement;
    const width = 190, height = 124;
    setMenu({ project, x: Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8)) });
  };
  const keyboardProjectMenu = (event: KeyboardEvent<HTMLButtonElement>, project: Project) => {
    if (!isProjectMenuKey(event.key, event.shiftKey)) return;
    const rectangle = event.currentTarget.getBoundingClientRect();
    openProjectMenu({ preventDefault: () => event.preventDefault(), stopPropagation: () => event.stopPropagation(), clientX: rectangle.left + Math.min(36, rectangle.width / 2), clientY: rectangle.top + rectangle.height } as MouseEvent, project);
  };
  const menuKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const index = nextProjectMenuIndex(event.key, current, items.length); if (index === undefined) return;
    event.preventDefault(); event.stopPropagation();
    items[index]?.focus({ preventScroll: true });
  };
  const toggleTask = (id: string) => setTaskExpanded(previous => ({ ...previous, [id]: !(previous[id] ?? false) }));
  const renderTask = (task: TaskDirectoryEntry, entries: TaskDirectoryEntry[], current: boolean, visited: Set<string> = new Set()): React.ReactNode => {
    if (visited.has(task.id)) return null;
    const children = entries.filter(row => row.parentId === task.id), folder = task.isFolder || children.length > 0, open = taskExpanded[task.id] ?? false;
    const next = new Set(visited).add(task.id);
    const activityLabel = taskActivityLabel(activity?.get(task.id) ?? defaultTaskActivity(task.state));
    const description = `${task.code} ${task.title} · ${stateNames[task.state as SingleUserTaskState]} · ${activityLabel}${folder ? ` · ${task.leafStats.total} 个末端任务；${(Object.keys(stateNames) as SingleUserTaskState[]).map(state => `${stateNames[state]} ${task.leafStats.states[state] ?? 0}`).join('，')}` : ''}`;
    return <li key={task.id}>
      <div className="sidebar-task-line">
        {folder ? <button className="sidebar-toggle" aria-label={`${open ? '折叠' : '展开'}任务：${task.title}`} aria-expanded={open} onClick={() => toggleTask(task.id)}><Chevron open={open} /></button> : <span className="sidebar-toggle-spacer" />}
        <button className={`sidebar-row sidebar-task ${folder ? 'is-group' : ''}`} aria-current={current && selectedTaskId === task.id ? 'page' : undefined} aria-label={description} title={description} onClick={event => { if (event.detail <= 1) onTask(task.projectId, task.id); }} onDoubleClick={folder ? () => toggleTask(task.id) : undefined}>{folder ? <Folder /> : <FileIcon />}<span className="task-code">{task.code}</span><span className="sidebar-task-name">{task.title}</span><TaskActivityLight className="sidebar-task-state" state={task.state} activity={activity?.get(task.id)} />{folder && <small className="sidebar-leaf-count">{task.leafStats.total}</small>}</button>
      </div>
      {folder && open && <ul className="sidebar-tasks">{children.map(row => renderTask(row, entries, current, next))}</ul>}
    </li>;
  };
  return <aside className="studio-sidebar" aria-label="项目导航">
    <button className="sidebar-row sidebar-new" onClick={onNewProject}><span className="sidebar-plus" aria-hidden="true">＋</span>新建项目</button>
    <nav className="sidebar-directory" aria-label="项目目录">
      <details className="sidebar-section" open={sectionOpen} onToggle={event => setSectionOpen(event.currentTarget.open)}>
        <summary><Chevron open={sectionOpen} /><span>项目</span><small>{projects.length}</small></summary>
        <ul className="sidebar-projects">{projects.map(project => {
          const open = expanded[project.id] ?? false, current = active === 'workspace' && projectId === project.id;
          const scoped = tasks.filter(task => task.projectId === project.id), byId = new Map(scoped.map(task => [task.id, task])), hidden = new Map<string, boolean>();
          for (const task of scoped) {
            const chain: string[] = [], seen = new Set<string>(); let cursor: string | undefined = task.id, archived = false;
            while (cursor && !seen.has(cursor)) {
              if (hidden.has(cursor)) { archived = hidden.get(cursor)!; break; }
              const row = byId.get(cursor); if (!row) break;
              chain.push(cursor); seen.add(cursor); if (row.archived) { archived = true; break; } cursor = row.parentId;
            }
            for (const id of chain) hidden.set(id, archived);
          }
          const entries = scoped.filter(task => !hidden.get(task.id) && Object.hasOwn(stateNames, task.state)).sort((a, b) => a.rank - b.rank);
          const run = autonomy?.get(project.id), openRun = run && isOpenRun(run.state) ? run : undefined;
          return <li key={project.id}>
            <div className={`sidebar-project ${current ? 'is-current' : ''}`} onContextMenu={event => openProjectMenu(event, project)}>
              <button className="sidebar-toggle" aria-label={`${open ? '折叠' : '展开'}项目：${project.title}`} aria-expanded={open} onClick={() => setExpanded(previous => ({ ...previous, [project.id]: !open }))}><Chevron open={open} /></button>
              <button className="sidebar-row sidebar-project-name" data-project-id={project.id} aria-current={current && !selectedTaskId ? 'page' : undefined} title={project.title} onKeyDown={event => keyboardProjectMenu(event, project)} onClick={() => { setMenu(undefined); setExpanded(previous => ({ ...previous, [project.id]: true })); onProject(project.id); }}><Folder /><span>{project.title}</span>{openRun && <AutonomyProjectMark run={openRun} />}</button>
            </div>
            {open && <ul className="sidebar-tasks" aria-label={`${project.title}任务目录`}>{entries.length ? entries.filter(task => !task.parentId || !entries.some(row => row.id === task.parentId)).map(task => renderTask(task, entries, current)) : <li className="sidebar-empty">暂无任务</li>}</ul>}
          </li>;
        })}</ul>
      </details>
    </nav>
    {menu && <div className="sidebar-context-menu" ref={menuElement} role="menu" aria-label={`${menu.project.title} 项目操作`} style={{ left: menu.x, top: menu.y }} onKeyDown={menuKeyboard}>
      <ProjectContextMenuItems project={menu.project} onRename={() => { const project = menu.project; setMenu(undefined); onRenameProject(project); }} onExport={() => { const project = menu.project; setMenu(undefined); onExportProject(project); }} onDelete={() => { const project = menu.project; setMenu(undefined); onDeleteProject(project); }} />
    </div>}
    <footer className="sidebar-footer"><button className="sidebar-row sidebar-settings" aria-pressed={active === 'skills'} onClick={onSkills}><span aria-hidden="true"><svg viewBox="0 0 20 20"><path d="M4 3.5h9.5a2 2 0 0 1 2 2v11H6a2 2 0 0 1-2-2zM4 14.5a2 2 0 0 1 2-2h9.5M7.5 7h5M7.5 9.5h3" /></svg></span>技能</button><button className="sidebar-row sidebar-settings" aria-pressed={active === 'mcp'} onClick={onMcp}><span aria-hidden="true"><svg viewBox="0 0 20 20"><path d="M7 2.5v4M13 2.5v4M5 6.5h10v3a5 5 0 0 1-10 0zM10 14.5v3" /></svg></span>MCP 工具</button><button className="sidebar-row sidebar-settings" aria-pressed={active === 'plugins'} onClick={onPlugins}><span aria-hidden="true"><svg viewBox="0 0 20 20"><path d="M3.5 7.5h3.2a1.8 1.8 0 1 1 3.6 0h3.2v3.2a1.8 1.8 0 1 1 0 3.6v3.2h-10z" /></svg></span>插件</button><button className="sidebar-row sidebar-settings" aria-pressed={active === 'models'} onClick={onModels}><span aria-hidden="true">⚙</span>模型配置</button><small>HarnessStudio · 单用户</small><div className="sidebar-status" role="status">{message}</div></footer>
  </aside>;
}
