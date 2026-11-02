import { useCallback, useEffect, useRef, useState } from 'react';
import flowCss from '@xyflow/react/dist/style.css';
import studioCss from './studio.css';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type { SlotScopeAdapter, StandardSourceBinding } from '@deepseek-ai/dsh-client-ui-slots';
import type { Project, TaskDirectoryEntry } from '@harnessstudio/studio/domain-types';
import { api } from './api.ts';
import { ModelSettingsPage, type ModelSettings } from './models.tsx';
import { SkillsPage } from './skills.tsx';
import { McpPage } from './mcp.tsx';
import { PluginsPage } from './plugins.tsx';
import { forgetProjectWorkspaceDrafts, ProjectWorkbench, type RuntimeStatus } from './workbench.tsx';
import { ProjectSidebar } from './sidebar.tsx';
import { aggregateTaskActivity } from './task-activity.ts';
import { ResizableSplit } from './resizable-split.tsx';
import { forgetChatAttachmentDrafts } from './chat-attachments.tsx';
import { ProjectDeleteDialog, ProjectExportDialog, ProjectRenameDialog } from './project-actions.tsx';
import { useAutonomyRuns } from './autonomy.tsx';
import { SoftwareBackendContext } from './software-backend.ts';

export const inject = ['slots'];
const SIDEBAR_COLLAPSED = 'harnessstudio:layout:sidebar-collapsed';
/** The open project and task live in the URL hash (#project=…&task=…), so a refresh or a shared link reopens them. */
function readLocation(): { projectId: string; taskId: string } {
  const values = new URLSearchParams(window.location.hash.slice(1));
  return { projectId: values.get('project') ?? '', taskId: values.get('task') ?? '' };
}
function writeLocation(projectId: string, taskId: string) {
  const hash = projectId ? `#${new URLSearchParams({ project: projectId, ...(taskId ? { task: taskId } : {}) })}` : '';
  if (window.location.hash !== hash) window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`);
}
interface Status extends RuntimeStatus { tools: string[] }
function StudioApp() {
  const [status, setStatus] = useState<Status>();
  const [page, setPage] = useState<'workspace' | 'models' | 'skills' | 'mcp' | 'plugins'>('workspace');
  const [models, setModels] = useState<ModelSettings>();
  const [projects, setProjects] = useState<Project[]>([]), [projectId, setProjectId] = useState('');
  const [directory, setDirectory] = useState<TaskDirectoryEntry[]>([]), [selectedTasks, setSelectedTasks] = useState<Record<string, string>>({});
  const [message, setMessage] = useState(''), [creating, setCreating] = useState(false), [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<Project>(), [deleting, setDeleting] = useState<Project>(), [exporting, setExporting] = useState<Project>();
  const [title, setTitle] = useState('');
  const [sidebarDefaultWidth, setSidebarDefaultWidth] = useState(() => window.matchMedia('(max-width: 850px)').matches ? 150 : 250);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => { try { return window.localStorage.getItem(SIDEBAR_COLLAPSED) === 'true'; } catch { return false; } });
  useEffect(() => { try { window.localStorage.setItem(SIDEBAR_COLLAPSED, String(sidebarCollapsed)); } catch { /* The layout still works without storage. */ } }, [sidebarCollapsed]);
  useEffect(() => {
    // Ctrl+B (⌘B) toggles the side bar, as in VS Code.
    const toggle = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'b' || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      event.preventDefault(); setSidebarCollapsed(previous => !previous);
    };
    window.addEventListener('keydown', toggle);
    return () => window.removeEventListener('keydown', toggle);
  }, []);
  const directoryRequest = useRef(0), mounted = useRef(true);
  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout> | undefined, controller: AbortController | undefined;
    const poll = async () => {
      if (!alive || document.hidden || controller) return;
      controller = new AbortController(); const current = controller;
      const timeout = setTimeout(() => current.abort(), 5000);
      try {
        const response = await fetch('/api/studio/status', { signal: current.signal, cache: 'no-store' });
        if (!response.ok) return;
        const next = await response.json() as Status;
        if (alive && !current.signal.aborted) setStatus(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
      } catch { /* A transient transport error preserves the last observed lights. */ }
      finally {
        clearTimeout(timeout); if (controller === current) controller = undefined;
        if (alive && !document.hidden) timer = setTimeout(poll, 1000);
      }
    };
    const visible = () => {
      clearTimeout(timer);
      if (document.hidden) controller?.abort(); else void poll();
    };
    document.addEventListener('visibilitychange', visible); void poll();
    return () => { alive = false; clearTimeout(timer); controller?.abort(); document.removeEventListener('visibilitychange', visible); };
  }, []);
  const activity = aggregateTaskActivity(directory, status?.chats ?? []);
  const autonomy = useAutonomyRuns();
  useEffect(() => {
    const media = window.matchMedia('(max-width: 850px)');
    const update = () => setSidebarDefaultWidth(media.matches ? 150 : 250);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    let alive = true; mounted.current = true; const request = ++directoryRequest.current;
    void Promise.all([api<Status>('status'), api<ModelSettings>('models'), api<Project[]>('projects'), api<TaskDirectoryEntry[]>('directory')]).then(([status, models, projects, directory]) => {
      if (alive && directoryRequest.current === request) {
        setStatus(status); setModels(models); setProjects(projects); setDirectory(directory);
        // Reopen the project and task of the URL when they still exist; otherwise fall back to the first project.
        const location = readLocation(), project = projects.find(row => row.id === location.projectId) ?? projects[0];
        setProjectId(project?.id ?? '');
        if (project && project.id === location.projectId && directory.some(task => task.id === location.taskId && task.projectId === project.id)) setSelectedTasks({ [project.id]: location.taskId });
      }
    }, error => { if (alive) setMessage(String(error)); });
    return () => { alive = false; mounted.current = false; };
  }, []);
  const refreshProjects = useCallback(async () => {
    const request = ++directoryRequest.current;
    const [projects, status, directory] = await Promise.all([api<Project[]>('projects'), api<Status>('status'), api<TaskDirectoryEntry[]>('directory')]);
    if (mounted.current && directoryRequest.current === request) { setProjects(projects); setStatus(status); setDirectory(directory); }
  }, []);
  const updateModels = async (next: ModelSettings) => { setModels(next); setStatus(await api<Status>('status')); };
  useEffect(() => { if (projectId) writeLocation(projectId, selectedTasks[projectId] ?? ''); }, [projectId, selectedTasks]);
  const selectTask = (projectId: string, id: string) => { setPage('workspace'); setProjectId(projectId); setSelectedTasks(previous => ({ ...previous, [projectId]: id })); };
  const currentProject = projects.find(project => project.id === projectId);
  return <SoftwareBackendContext.Provider value={status?.softwareBackend}><div className="studio-m1">
    <ResizableSplit className="studio-layout" direction="horizontal" label="调整项目侧栏宽度" initialRatio={0.18} initialFirstSize={sidebarDefaultWidth} minFirst={150} minSecond={440} maxFirst={480} storageKey="harnessstudio:layout:sidebar-workspace" collapsible="first" collapsed={sidebarCollapsed ? 'first' : null} onCollapsedChange={pane => setSidebarCollapsed(pane === 'first')}
      first={<ProjectSidebar projects={projects} tasks={directory} activity={activity} autonomy={autonomy} projectId={projectId} selectedTaskId={selectedTasks[projectId] ?? ''} active={page} onNewProject={() => { setCreating(true); setMessage(''); }} onProject={id => selectTask(id, '')} onTask={selectTask} onModels={() => setPage('models')} onSkills={() => setPage('skills')} onMcp={() => setPage('mcp')} onPlugins={() => setPage('plugins')} onRenameProject={project => { setRenaming(project); setDeleting(undefined); setExporting(undefined); setMessage(''); }} onExportProject={project => { setExporting(project); setRenaming(undefined); setDeleting(undefined); setMessage(''); }} onDeleteProject={project => { setDeleting(project); setRenaming(undefined); setExporting(undefined); setMessage(''); }} message={message} />}
      second={<main>{page === 'plugins' ? <PluginsPage /> : page === 'mcp' ? <McpPage onPlugins={() => setPage('plugins')} /> : page === 'skills' ? <SkillsPage projects={projects} projectId={projectId} onPlugins={() => setPage('plugins')} /> : page === 'models' ? models ? <ModelSettingsPage value={models} onChange={updateModels} /> : <p>正在加载模型配置…</p> : status && projectId ? <ProjectWorkbench key={`${projectId}:${currentProject?.title ?? ''}`} projectId={projectId} selectedTaskId={selectedTasks[projectId] ?? ''} onSelectTask={id => selectTask(projectId, id)} status={status} models={models} onProjectUpdate={refreshProjects} /> : <p>{status ? '请创建项目，开始建立具体任务图谱。' : '连接中…'}</p>}</main>} />
    {creating && <div className="studio-dialog" role="dialog" aria-label="新建项目"><form onSubmit={event => {
      event.preventDefault(); setBusy(true); setMessage(''); void (async () => {
        try { const project = await api<Project>('projects', { title: title.trim() }); await refreshProjects(); selectTask(project.id, ''); setCreating(false); setTitle(''); }
        catch (error) { setMessage(error instanceof Error ? error.message : '创建失败'); } finally { setBusy(false); }
      })();
    }}><h2>新建项目</h2><fieldset disabled={busy}>
      <label>项目名称<input aria-label="项目名称" autoFocus required value={title} onChange={event => setTitle(event.target.value)} /></label>
      <div role="status">{message}</div><div><button type="submit" disabled={!title.trim()}>创建项目</button><button type="button" onClick={() => setCreating(false)}>取消</button></div>
    </fieldset></form></div>}
    {renaming && <ProjectRenameDialog key={`${renaming.id}:${renaming.revision}`} project={renaming} onClose={() => setRenaming(undefined)} onRenamed={async renamed => {
      setProjects(previous => previous.map(project => project.id === renamed.id ? renamed : project)); setRenaming(undefined); setMessage('项目已重命名。');
      try { await refreshProjects(); } catch (error) { setMessage(`项目已重命名，列表刷新失败：${error instanceof Error ? error.message : '请刷新页面'}`); }
    }} />}
    {exporting && <ProjectExportDialog key={exporting.id} projectId={exporting.id} title={exporting.title} onClose={() => setExporting(undefined)} />}
    {deleting && <ProjectDeleteDialog key={`${deleting.id}:${deleting.revision}`} project={deleting} onClose={() => setDeleting(undefined)} onDeleted={async result => {
      const deleted = deleting, removedTaskIds = result.taskIds;
      const removedChats = status?.chats.filter(chat => chat.projectId === deleted.id).map(chat => chat.id) ?? [];
      forgetProjectWorkspaceDrafts(deleted.id, removedTaskIds);
      forgetChatAttachmentDrafts([...removedChats, `new:project:${deleted.id}`, ...removedTaskIds.map(id => `new:${id}`)]);
      const remaining = projects.filter(project => project.id !== deleted.id), index = projects.findIndex(project => project.id === deleted.id);
      const nextProjectId = remaining[Math.min(Math.max(index, 0), Math.max(remaining.length - 1, 0))]?.id ?? '';
      setProjects(remaining); setDirectory(previous => previous.filter(task => task.projectId !== deleted.id));
      setStatus(previous => previous ? { ...previous, chats: previous.chats.filter(chat => chat.projectId !== deleted.id) } : previous);
      setSelectedTasks(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => id !== deleted.id)));
      if (projectId === deleted.id) setProjectId(nextProjectId);
      setDeleting(undefined); setMessage('项目及其全部数据已永久删除。');
      try { await refreshProjects(); } catch (error) { setMessage(`项目已永久删除，列表刷新失败：${error instanceof Error ? error.message : '请刷新页面'}`); }
    }} />}
  </div></SoftwareBackendContext.Provider>;
}

/** Register into DSH's real root slot and own both third-party and Studio styles. */
export function apply(ctx: Context): void {
  // This Studio root uses Studio's authenticated API, without native Session-scoped widgets.
  // DSH's root renderer still requires an explicit absent Session binding.
  const absent: StandardSourceBinding = { key: undefined, hooks: {}, keyedHooks: {}, props: {} };
  const source = { getSnapshot: () => absent, subscribe: () => () => {} };
  const adapter: SlotScopeAdapter = {
    current: source,
    bindingSource: target => {
      if (target !== undefined) throw new Error('Studio does not expose native Session-scoped UI');
      return source;
    },
  };
  ctx.slots.installScope('session', adapter);
  ctx.effect(() => {
    const title = document.title;
    document.title = 'HarnessStudio';
    const style = document.createElement('style');
    style.dataset.plugin = '@harnessstudio/ui';
    style.textContent = flowCss + studioCss;
    document.head.append(style);
    return () => { style.remove(); document.title = title; };
  }, 'studio-ui: styles');
  ctx.slots.register({ name: 'root', registrant: 'harnessstudio' }, StudioApp);
}
