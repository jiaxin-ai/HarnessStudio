import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { ReactFlow, Background, Position, MarkerType, type Node as FlowNode, type NodeChange, type Edge, type Connection, type ReactFlowInstance } from '@xyflow/react';
import { stateNames, type Project, type TaskView, type TaskState, type SingleUserTaskState } from '@harnessstudio/studio/domain-types';
import { TaskActivityLight } from './task-activity-light.tsx';
import { RegionButtons, onTitleBarDoubleClick, type RegionControl } from './region.tsx';
import { defaultTaskActivity, taskActivityLabel, type TaskActivityMap } from './task-activity.ts';
import { isGraphPoint, layoutTaskLayer, mergeGraphPositions, readGraphPositions, saveGraphPositions, type GraphPositions } from './graph-layout.js';

export interface TaskGraphProps {
  region?: RegionControl;
  project: Project;
  tasks: readonly TaskView[];
  activity?: TaskActivityMap;
  /** Tasks with a live autonomy worker; 'waiting' when that worker waits for a person. */
  agentWork?: ReadonlyMap<string, 'working' | 'waiting'>;
  parentId?: string;
  selectedId: string;
  disabled?: boolean;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onNavigate: (parentId?: string) => void;
  onAdd: (context: { parentId?: string; predecessorId?: string }) => void;
  onDependencies: (task: TaskView, ids: string[]) => void;
  onReconnect: (edge: { source: string; target: string }, connection: { source: string; target: string }) => void;
  onDelete: (task: TaskView) => void;
  onClear: (task: TaskView) => void;
  onEdit: (task: TaskView) => void;
}

type GraphTask = TaskView & { state: SingleUserTaskState; childCount?: number; isFolder?: boolean; leafStats?: { total: number; states: Partial<Record<TaskState, number>> } };
type GraphEdge = Edge<{ kind: 'dependency' | 'start' | 'finish' | 'empty'; sourceTask?: string; targetTask?: string }>;
type GraphMenu = { x: number; y: number } & ({ kind: 'add'; predecessorId?: string; taskId?: string } | { kind: 'remove'; sourceId: string; targetId: string });
const states = Object.keys(stateNames) as SingleUserTaskState[];

function TaskIcon({ folder }: { folder: boolean }) {
  return <svg className={`graph-task-icon ${folder ? 'is-folder' : 'is-file'}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false">{folder ? <path d="M3 6a2 2 0 0 1 2-2h5l3 3h6a2 2 0 0 1 2 2v10H3V6Zm0 4h18" /> : <><path d="M6 3h8l4 4v14H6V3Zm8 0v5h4" /><path d="M9 12h6M9 16h6" /></>}</svg>;
}

/** A graph layer contains only direct children; virtual endpoints never enter the business DAG. */
export function TaskGraph({ region, project, tasks, activity, agentWork, parentId, selectedId, disabled = false, onSelect, onOpen, onNavigate, onAdd, onDependencies, onReconnect, onDelete, onClear, onEdit }: TaskGraphProps) {
  const root = useRef<HTMLElement>(null), menuElement = useRef<HTMLDivElement>(null), previousFocus = useRef<HTMLElement>();
  const measurements = useRef(new Map<string, { width: number; height: number }>());
  const previousNodes = useRef(new Map<string, { base: FlowNode; node: FlowNode }>());
  const flow = useRef<ReactFlowInstance<FlowNode, GraphEdge>>(), reconnecting = useRef<GraphEdge>();
  const [menu, setMenu] = useState<GraphMenu>();
  const currentParent = parentId || undefined;
  const layoutKey = `${project.id}:${currentParent ?? 'root'}`, storageKey = `harnessstudio:graph-layout:v1:${layoutKey}`;
  const loadedPositions = useMemo(() => readGraphPositions(storageKey), [storageKey]);
  const [layout, setLayout] = useState<{ key: string; positions: GraphPositions; dragging?: Record<string, boolean> }>({ key: layoutKey, positions: loadedPositions });
  const [layoutPass, setLayoutPass] = useState(0);
  const currentLayoutKey = useRef(layoutKey); currentLayoutKey.current = layoutKey;
  const all = useMemo(() => {
    const scoped = tasks.filter(task => task.projectId === project.id), rawById = new Map(scoped.map(task => [task.id, task])), hidden = new Map<string, boolean>();
    for (const task of scoped) {
      const chain: string[] = [], seen = new Set<string>(); let cursor: string | undefined = task.id, archived = false;
      while (cursor && !seen.has(cursor)) {
        if (hidden.has(cursor)) { archived = hidden.get(cursor)!; break; }
        const row = rawById.get(cursor); if (!row) break;
        chain.push(cursor); seen.add(cursor); if (row.archived) { archived = true; break; } cursor = row.parentId;
      }
      for (const id of chain) hidden.set(id, archived);
    }
    return scoped.filter((task): task is GraphTask => !hidden.get(task.id) && Object.hasOwn(stateNames, task.state));
  }, [tasks, project.id]);
  const byId = new Map(all.map(task => [task.id, task]));
  const children = new Map<string | undefined, GraphTask[]>();
  for (const task of all) { const key = task.parentId || undefined, rows = children.get(key); if (rows) rows.push(task); else children.set(key, [task]); }
  const visible = [...children.get(currentParent) ?? []].sort((a, b) => a.rank - b.rank);
  const visibleIds = new Set(visible.map(task => task.id));
  const startId = `graph-start:${project.id}:${currentParent ?? 'root'}`, endId = `graph-end:${project.id}:${currentParent ?? 'root'}`;
  const showEndpoints = !!currentParent || visible.length > 0;

  // A legacy graph can contain a missing parent or a cycle. Diagnose it without
  // flattening its children into the project root, which would hide the problem.
  const hierarchy = new Map<string, 'valid' | 'missing' | 'cycle'>();
  for (const task of all) {
    const chain: string[] = [], visited = new Set<string>();
    let cursor: string | undefined = task.id, status: 'valid' | 'missing' | 'cycle' = 'valid';
    while (cursor) {
      const known = hierarchy.get(cursor);
      if (known) { status = known; break; }
      if (visited.has(cursor)) { status = 'cycle'; break; }
      const row = byId.get(cursor);
      if (!row) { status = 'missing'; break; }
      visited.add(cursor); chain.push(cursor); cursor = row.parentId;
    }
    for (const id of chain) hierarchy.set(id, status);
  }
  const invalidHierarchy = [...hierarchy.values()].filter(status => status !== 'valid').length;
  const currentLayerValid = !currentParent || hierarchy.get(currentParent) === 'valid';
  const parent = currentParent ? byId.get(currentParent) : undefined;
  const canMutate = !disabled && currentLayerValid && (!currentParent || parent?.canDiscuss === true && (parent.state === 'unstarted' || parent.state === 'working' && parent.isFolder));
  // Human relation edits have their own server-side impact preview and consent.
  // An immutable completed result must not make its graph handles unusable.
  const canEditRelations = !disabled && currentLayerValid && (!currentParent || !!parent && !parent.pending && ['unstarted', 'working', 'completed', 'recheck'].includes(parent.state));
  const editableTarget = (id: string) => visibleIds.has(id) && hierarchy.get(id) === 'valid' && ['unstarted', 'working', 'completed', 'recheck'].includes(byId.get(id)?.state ?? '') && !byId.get(id)?.pending;
  // Include hidden/archived children in the destructive-action guard. The
  // server repeats this check; a completed parent does not prevent leaf deletion.
  const deleteTask = menu?.kind === 'add' && menu.taskId ? byId.get(menu.taskId) : undefined;
  const clearBlocker = deleteTask && (deleteTask.archived ? '归档任务不能清空' : deleteTask.pending && (deleteTask.pendingAction !== 'clear' || deleteTask.pendingOwnerId !== deleteTask.id) ? '当前操作尚未完成，暂不能清空' : disabled ? '当前操作处理中' : '');
  const deletionBlocker = deleteTask && (tasks.some(row => row.projectId === project.id && row.parentId === deleteTask.id) ? '包含下一级子任务，不能删除' : deleteTask.kind !== 'task' ? '任务组暂不支持删除' : deleteTask.pending && (deleteTask.pendingAction !== 'delete' || deleteTask.pendingOwnerId !== deleteTask.id) ? '当前操作尚未完成，暂不能删除' : disabled ? '当前操作处理中' : '');

  const ancestors: GraphTask[] = [], seenAncestors = new Set<string>();
  for (let cursor = currentParent; cursor && !seenAncestors.has(cursor); ) {
    seenAncestors.add(cursor); const ancestor = byId.get(cursor); if (!ancestor) break;
    ancestors.unshift(ancestor); cursor = ancestor.parentId;
  }

  const leafStats = (task: GraphTask) => {
    if (task.leafStats) return task.leafStats;
    const result: { total: number; states: Partial<Record<TaskState, number>> } = { total: 0, states: {} }, visited = new Set<string>();
    const pending = [task];
    while (pending.length) {
      const row = pending.pop()!;
      if (visited.has(row.id)) continue; visited.add(row.id);
      const nested = children.get(row.id) ?? [];
      if (nested.length) { for (const child of nested) pending.push(child); }
      else if (row.kind === 'task') { result.total++; result.states[row.state] = (result.states[row.state] ?? 0) + 1; }
    }
    return result;
  };
  const successors = new Map<string, string[]>();
  for (const task of visible) {
    const predecessors = [...new Set(task.dependencies.filter(id => visibleIds.has(id)))];
    for (const id of predecessors) { const next = successors.get(id); if (next) next.push(task.id); else successors.set(id, [task.id]); }
  }
  const automaticLayout = useMemo(() => layoutTaskLayer(visible, new Map(visible.map(task => [task.id, measurements.current.get(task.id)?.height ?? (task.isFolder ? 175 : 130)]))), [all, currentParent, layoutPass]);
  const positions = useMemo(() => mergeGraphPositions(automaticLayout.positions, layout.key === layoutKey ? layout.positions : loadedPositions), [automaticLayout, layout, layoutKey, loadedPositions]);
  const nodeIdsKey = visible.map(task => task.id).join(',');
  useEffect(() => {
    // Capture automatic positions once. Later state/label/dependency changes and
    // additions retain all existing positions; deleted-node entries are pruned.
    setLayout({ key: layoutKey, positions }); saveGraphPositions(storageKey, positions);
  }, [layoutKey, nodeIdsKey]);
  const blockedTopology = automaticLayout.blockedTopology;
  const agentMark = (task: GraphTask, folder: boolean): { text: string; tone: 'working' | 'waiting' | 'done'; title: string } | undefined => {
    const own = agentWork?.get(task.id);
    if (own) return own === 'waiting' ? { text: 'Agent 等你处理', tone: own, title: '做这个任务的子 Agent 在等你处理，见自主运行面板' } : { text: 'Agent 工作中', tone: own, title: '自主运行的子 Agent 正在做这个任务' };
    if (folder && agentWork?.size) {
      // The graph shows one layer; a group tells how many tasks below it have a worker.
      let working = 0, waiting = false; const pending = [...children.get(task.id) ?? []], seen = new Set<string>();
      while (pending.length) { const row = pending.pop()!; if (seen.has(row.id)) continue; seen.add(row.id); const mark = agentWork.get(row.id); if (mark) { working++; waiting ||= mark === 'waiting'; } pending.push(...children.get(row.id) ?? []); }
      if (working) return { text: `${working} 个子任务有 Agent 在做`, tone: waiting ? 'waiting' : 'working', title: waiting ? '下面有子 Agent 在等你处理，见自主运行面板' : '下面的子任务正由自主运行的子 Agent 在做' };
    }
    if (task.state === 'completed' && task.completedBy === 'agent') return { text: 'Agent 完成', tone: 'done', title: '由 Agent 检查清单并确认完成；可以抽查，需要改的点「继续修改」' };
  };
  const realNodes = useMemo<FlowNode[]>(() => visible.map(task => {
    const folder = task.isFolder ?? (task.kind === 'group' || (task.childCount ?? children.get(task.id)?.length ?? 0) > 0), stats = folder ? leafStats(task) : undefined;
    const mark = agentMark(task, folder);
    const outside = [...new Set(task.dependencies.filter(id => !visibleIds.has(id)))], missing = outside.filter(id => !byId.has(id));
    const inputTitle = outside.map(id => { const input = byId.get(id); return input ? `${input.code} ${input.title}：${stateNames[input.state]}（本层外）` : `${id}：依赖缺失或不属于本项目`; }).join('\n');
    const inputLabel = missing.length ? `${missing.length} 个依赖缺失${outside.length > missing.length ? ` · ${outside.length - missing.length} 个本层外依赖` : ''}` : `${outside.length} 个本层外依赖`;
    return { id: task.id, position: automaticLayout.positions[task.id],
      style: { width: 248 }, sourcePosition: Position.Right, targetPosition: Position.Left,
      ariaLabel: `${task.title}，${stateNames[task.state]}${mark ? `，${mark.tone === 'done' ? '由 Agent 确认完成' : mark.text}` : ''}，${taskActivityLabel(activity?.get(task.id) ?? defaultTaskActivity(task.state))}${folder ? `，包含 ${stats?.total ?? 0} 个末端任务` : ''}${outside.length ? `，${inputLabel}` : ''}，双击进入子任务图谱`,
      data: { label: <div className={`graph-task-card ${folder ? 'is-folder' : 'is-file'}`}>
        <header><TaskIcon folder={folder} /><div><strong>{task.title}</strong><code>{task.code}</code></div><button className="graph-metadata-button nodrag nopan" type="button" aria-label={`编辑任务定义：${task.code} ${task.title}`} title="编辑任务定义" disabled={disabled || !task.canEditMetadata} onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onEdit(task); }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9.5 4 .6-2h3.8l.6 2 1.8 1 2-.4 1.9 3.3-1.4 1.6v2l1.4 1.6-1.9 3.3-2-.4-1.8 1-.6 2h-3.8l-.6-2-1.8-1-2 .4-1.9-3.3L5.3 12v-2L3.9 8.4l1.9-3.3 2 .4z" /><circle cx="12" cy="10.5" r="3" /></svg></button></header>
        {stats ? <><small className={`graph-folder-state graph-state state-${task.state}`}><TaskActivityLight state={task.state} activity={activity?.get(task.id)} />当前状态：{stateNames[task.state]}</small><small className="graph-folder-count">{stats.total} 个末端任务</small><div className="graph-state-counts" aria-label="末端任务状态统计">{states.filter(state => (stats.states[state] ?? 0) > 0).map(state => <span key={state} className={`graph-state state-${state}`}>{stateNames[state]} <b>{stats.states[state]}</b></span>)}</div></> : <small className={`graph-leaf-state state-${task.state}`}><TaskActivityLight state={task.state} activity={activity?.get(task.id)} />{stateNames[task.state]}</small>}
        {mark && <small className={`graph-agent-mark is-${mark.tone}`} title={mark.title}><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.2 7 4.4l3.3.1-2.6 2 .9 3.2L6 7.8 3.4 9.7l.9-3.2-2.6-2 3.3-.1z" /></svg>{mark.text}</small>}
        {!folder && task.goal && <p className="graph-task-goal">{task.goal}</p>}
        {outside.length > 0 && <small className={`graph-input-warning${missing.length ? ' is-missing' : ''}`} title={inputTitle}>{inputLabel}</small>}
        {task.dependencyRepairRequired && <small className="graph-input-warning is-missing">依赖已被删除，请重新确认依赖</small>}
        {task.state === 'recheck' && <small className="graph-input-warning is-recheck">{task.recheckReason || '前序节点有修正，请手动复核'}</small>}
        {task.pending && <small className="graph-input-warning is-missing" title={task.pending}>{task.pendingAction === 'clear' ? '清空尚未完成，节点已冻结' : task.pendingAction === 'delete' ? '删除尚未完成，节点已冻结' : task.pendingAction === 'resume' ? '继续修改尚未完成' : task.pendingAction === 'dependencies' ? '依赖调整未完成，节点已冻结' : '结果尚未保存成功'}</small>}
      </div> } };
  }), [all, currentParent, automaticLayout, disabled, onEdit, activity, agentWork]);
  const baseNodes = useMemo<FlowNode[]>(() => showEndpoints ? [
    { id: startId, type: 'input', className: 'graph-endpoint graph-start', position: automaticLayout.start, width: 58, height: 58, sourcePosition: Position.Right, ariaLabel: '本层图谱入口，不代表任务可执行', data: { label: <span title="本层图谱入口。创建连线到任务会清除它的计划前驱；重新连接只改变当前连线。">开始</span> }, focusable: false, draggable: false },
    ...realNodes,
    { id: endId, type: 'output', className: 'graph-endpoint graph-end', position: automaticLayout.end, width: 58, height: 58, targetPosition: Position.Left, ariaLabel: '本层图谱出口，不代表任务已完成', data: { label: <span title="本层图谱出口，表示本层没有后继；不代表任务已经完成。">结束</span> }, focusable: false, draggable: false },
  ] : realNodes, [realNodes, showEndpoints, startId, endId, automaticLayout]);
  const nodes = useMemo(() => {
    const next = new Map<string, { base: FlowNode; node: FlowNode }>();
    const result = baseNodes.map(base => {
      const measured = measurements.current.get(base.id), selected = base.id === selectedId, previous = previousNodes.current.get(base.id), position = positions[base.id] ?? base.position;
      const dragging = layout.key === layoutKey && !!layout.dragging?.[base.id];
      const node = previous?.base === base && previous.node.selected === selected && previous.node.measured === measured && previous.node.position === position && previous.node.dragging === dragging ? previous.node : { ...base, position, selected, dragging, ...(measured ? { measured } : {}) };
      next.set(base.id, { base, node }); return node;
    });
    previousNodes.current = next; return result;
  }, [baseNodes, selectedId, positions, layout, layoutKey]);
  const keepMeasurements = useCallback((changes: NodeChange[]) => {
    // Controlled nodes must carry measured dimensions into subsequent updates.
    // Otherwise XYFlow resets them when selection creates a new userNode and
    // hides the node while remeasuring, swallowing the second mouse click.
    for (const change of changes) if (change.type === 'dimensions' && change.dimensions) measurements.current.set(change.id, change.dimensions);
    const moved = changes.filter(change => change.type === 'position' && visibleIds.has(change.id));
    if (!moved.length) return;
    setLayout(previous => {
      const next = { ...mergeGraphPositions(automaticLayout.positions, previous.key === layoutKey ? previous.positions : loadedPositions) }, dragging = { ...previous.key === layoutKey ? previous.dragging : {} };
      let changed = previous.key !== layoutKey;
      for (const change of moved) {
        if (change.type !== 'position') continue;
        if (change.position && isGraphPoint(change.position) && (next[change.id]?.x !== change.position.x || next[change.id]?.y !== change.position.y)) { next[change.id] = change.position; changed = true; }
        if (change.dragging !== undefined && !!dragging[change.id] !== change.dragging) { dragging[change.id] = change.dragging; changed = true; }
      }
      if (moved.some(change => change.type === 'position' && change.dragging !== true)) saveGraphPositions(storageKey, next);
      return changed ? { key: layoutKey, positions: next, dragging } : previous;
    });
  }, [layoutKey, storageKey, nodeIdsKey, automaticLayout, loadedPositions]);
  const edgeStyle = { stroke: '#a9b7c8', strokeWidth: 1.25 }, markerEnd = { type: MarkerType.ArrowClosed, width: 14, height: 14, color: '#a9b7c8' };
  const edges: GraphEdge[] = visible.flatMap(task => [...new Set(task.dependencies.filter(id => visibleIds.has(id)))].map(id => ({ id: `dependency:${id}:${task.id}`, source: id, target: task.id, style: edgeStyle, markerEnd, reconnectable: canEditRelations && editableTarget(task.id), ariaLabel: `${byId.get(id)?.title ?? id} 到 ${task.title} 的依赖，拖动连线端点可重新连接`, data: { kind: 'dependency' as const, sourceTask: id, targetTask: task.id } })));
  if (showEndpoints) {
    for (const task of visible) {
      if (!task.dependencies.length) edges.push({ id: `start:${task.id}`, source: startId, target: task.id, ariaLabel: '本层入口到无计划前驱的任务，拖动起点可设置前驱，不表示任务可执行', style: edgeStyle, markerEnd, reconnectable: canEditRelations && editableTarget(task.id) ? 'source' : false, data: { kind: 'start', targetTask: task.id } });
      if (!(successors.get(task.id)?.length)) edges.push({ id: `finish:${task.id}`, source: task.id, target: endId, ariaLabel: '本层无后继的任务到图谱出口，拖动终点可设置后继，不表示任务已完成', style: edgeStyle, markerEnd, reconnectable: canEditRelations && !task.pending ? 'target' : false, data: { kind: 'finish', sourceTask: task.id } });
    }
    if (!visible.length) edges.push({ id: `empty:${startId}`, source: startId, target: endId, style: edgeStyle, markerEnd, reconnectable: false, data: { kind: 'empty' } });
  }

  useEffect(() => { setMenu(undefined); reconnecting.current = undefined; }, [project.id, currentParent]);
  useEffect(() => {
    if (!menu) return;
    menuElement.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => { if (!menuElement.current?.contains(event.target as HTMLElement)) setMenu(undefined); };
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setMenu(undefined); if (previousFocus.current?.isConnected) previousFocus.current.focus({ preventScroll: true }); }
      else if (event.key === 'Tab') setMenu(undefined);
    };
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', keydown); };
  }, [menu]);

  const openMenu = (event: ReactMouseEvent | MouseEvent, item: Omit<Extract<GraphMenu, { kind: 'add' }>, 'x' | 'y'> | Omit<Extract<GraphMenu, { kind: 'remove' }>, 'x' | 'y'>) => {
    event.preventDefault(); event.stopPropagation();
    const rectangle = root.current?.getBoundingClientRect(); if (!rectangle) return;
    if (document.activeElement instanceof HTMLElement) previousFocus.current = document.activeElement;
    const height = item.kind === 'add' && item.taskId ? byId.get(item.taskId)?.dependencyRepairRequired ? 152 : 112 : 50;
    setMenu({ ...item, x: Math.max(6, Math.min(event.clientX - rectangle.left, rectangle.width - 210)), y: Math.max(6, Math.min(event.clientY - rectangle.top, rectangle.height - height)) });
  };
  const validReconnect = (edge: GraphEdge, connection: Pick<Connection, 'source' | 'target'>) => {
    if (!canEditRelations || !connection.source || !connection.target || !edge.data || edge.data.kind === 'empty') return false;
    const source = connection.source, target = connection.target;
    if (!(source === startId || visibleIds.has(source)) || !(target === endId || visibleIds.has(target)) || source === target || source === startId && target === endId) return false;
    if (edge.data.kind === 'start' && target !== edge.target || edge.data.kind === 'finish' && source !== edge.source) return false;
    if (visibleIds.has(edge.target) && !editableTarget(edge.target) || visibleIds.has(target) && !editableTarget(target)) return false;
    if (visibleIds.has(source) && (hierarchy.get(source) !== 'valid' || byId.get(source)?.pending)) return false;
    const inputs = new Map(all.map(task => [task.id, [...task.dependencies]]));
    if (visibleIds.has(edge.source) && visibleIds.has(edge.target)) inputs.set(edge.target, inputs.get(edge.target)!.filter(id => id !== edge.source));
    if (visibleIds.has(source) && visibleIds.has(target)) {
      const dependencies = inputs.get(target)!;
      if (dependencies.includes(source)) return false;
      inputs.set(target, [...dependencies, source]);
      // Evaluate the resulting DAG after removal, rather than checking against
      // the old edge, which would incorrectly reject valid direction reversals.
      const visited = new Set<string>(), pending = [source];
      while (pending.length) {
        const id = pending.pop()!;
        if (id === target) return false;
        if (visited.has(id)) continue; visited.add(id);
        for (const predecessor of inputs.get(id) ?? []) pending.push(predecessor);
      }
    }
    return true;
  };
  const validConnection = (connection: Pick<Connection, 'source' | 'target'>) => {
    if (reconnecting.current) return validReconnect(reconnecting.current, connection);
    if (!canEditRelations || !connection.source || !connection.target || !editableTarget(connection.target)) return false;
    if (connection.source === startId) return true;
    if (!visibleIds.has(connection.source) || hierarchy.get(connection.source) !== 'valid' || byId.get(connection.source)?.pending || connection.source === connection.target || byId.get(connection.target)?.dependencies.includes(connection.source)) return false;
    // Follow all existing project inputs, including legacy cross-layer inputs.
    // A new source -> target edge is cyclic if source already depends on target.
    const visited = new Set<string>(), pending = [connection.source];
    while (pending.length) {
      const id = pending.pop()!;
      if (id === connection.target) return false;
      if (visited.has(id)) continue; visited.add(id);
      for (const predecessor of byId.get(id)?.dependencies ?? []) pending.push(predecessor);
    }
    return true;
  };
  const connect = (connection: Connection) => {
    if (!validConnection(connection)) return;
    const task = byId.get(connection.target!); if (!task) return;
    const next = connection.source === startId ? [] : [...task.dependencies, connection.source!];
    if (next.length !== task.dependencies.length || next.some((id, index) => id !== task.dependencies[index])) onDependencies(task, next);
  };
  const reconnect = (edge: GraphEdge, connection: Connection) => {
    if (!validReconnect(edge, connection) || edge.source === connection.source && edge.target === connection.target) return;
    onReconnect({ source: edge.source, target: edge.target }, { source: connection.source!, target: connection.target! });
  };
  const arrange = () => {
    const next = layoutTaskLayer(visible, new Map(visible.map(task => [task.id, measurements.current.get(task.id)?.height ?? (task.isFolder ? 175 : 130)])));
    setLayout({ key: layoutKey, positions: next.positions }); setLayoutPass(value => value + 1);
    saveGraphPositions(storageKey, next.positions); setMenu(undefined);
    // Let controlled positions reach XYFlow before fitting the arranged nodes.
    requestAnimationFrame(() => requestAnimationFrame(() => { if (currentLayoutKey.current === layoutKey) void flow.current?.fitView({ padding: .22, maxZoom: 1, duration: 240 }); }));
  };
  const fit = () => { void flow.current?.fitView({ padding: .22, maxZoom: 1, duration: 240 }); };
  // Maximizing, restoring or reopening a collapsed row changes the canvas size; refit once the new size is measured.
  const maximized = !!region?.maximized, firstFit = useRef(true), canvas = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (firstFit.current) { firstFit.current = false; return; }
    const frame = requestAnimationFrame(() => requestAnimationFrame(fit));
    return () => cancelAnimationFrame(frame);
  }, [maximized]);
  useEffect(() => {
    const element = canvas.current; if (!element) return;
    let tiny = element.clientHeight < 80 || element.clientWidth < 80;
    const observer = new ResizeObserver(() => {
      const now = element.clientHeight < 80 || element.clientWidth < 80;
      if (tiny && !now) requestAnimationFrame(fit);
      tiny = now;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const keyboardMenu = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
    const target = event.target as HTMLElement, node = target.closest<HTMLElement>('.react-flow__node'), id = node?.dataset.id;
    const point = (node ?? root.current)?.getBoundingClientRect(); if (!point) return;
    openMenu({ preventDefault: () => event.preventDefault(), stopPropagation: () => event.stopPropagation(), clientX: point.left + 30, clientY: point.top + 25 } as MouseEvent,
      { kind: 'add', ...(id && visibleIds.has(id) ? { predecessorId: id, taskId: id } : {}) });
  };
  const menuKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    if (!items.length) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
    items[index]?.focus({ preventScroll: true });
  };

  return <section className="studio-graph task-graph" aria-label="项目任务图谱" ref={root} onKeyDown={keyboardMenu}>
    <header className="graph-titlebar" onDoubleClick={onTitleBarDoubleClick(region)}><nav className="graph-breadcrumbs" aria-label="任务图谱层级"><button type="button" aria-current={!currentParent ? 'page' : undefined} title={project.title} onClick={() => onNavigate()}>{project.title}</button>{ancestors.map((task, index) => <span key={task.id}><svg viewBox="0 0 12 12" aria-hidden="true"><path d="m4 2 4 4-4 4" /></svg><button type="button" aria-current={index === ancestors.length - 1 ? 'page' : undefined} title={`${task.code} ${task.title}`} onClick={() => onNavigate(task.id)}>{task.title}</button></span>)}</nav>
      <div className="region-actions">
        <button type="button" className="graph-tool" onClick={arrange} disabled={!showEndpoints} title="一键排版" aria-label="一键排版"><svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><rect x="1.5" y="7.5" width="4" height="5" rx="1" /><rect x="14.5" y="1.5" width="4" height="5" rx="1" /><rect x="14.5" y="13.5" width="4" height="5" rx="1" /><path d="M5.5 10H10V4h4.5M10 10v6h4.5" /></svg></button>
        <button type="button" className="graph-tool" onClick={fit} title="适应画布（滚轮平移，Ctrl/⌘ + 滚轮或双指捏合缩放）" aria-label="适应画布"><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M2 5.5V2h3.5M10.5 2H14v3.5M2 10.5V14h3.5M10.5 14H14v-3.5" /><rect x="5.5" y="5.5" width="5" height="5" rx="1" /></svg></button>
        {region && <RegionButtons control={region} name="任务图谱" />}
      </div>
    </header>
    <div className="task-graph-canvas" ref={canvas}><ReactFlow<FlowNode, GraphEdge> key={layoutKey} nodes={nodes} edges={edges} onInit={instance => { flow.current = instance; }} onNodesChange={keepMeasurements} nodesDraggable={!disabled} nodesConnectable={canEditRelations} edgesReconnectable={canEditRelations} reconnectRadius={14} deleteKeyCode={null} nodeDragThreshold={3}
      onNodeClick={(event, node) => { setMenu(undefined); if (event.button === 0 && visibleIds.has(node.id)) onSelect(node.id); }} onNodeDoubleClick={(event, node) => { setMenu(undefined); if (event.button === 0 && visibleIds.has(node.id)) onOpen(node.id); }}
      onPaneClick={() => setMenu(undefined)} onPaneContextMenu={event => openMenu(event, { kind: 'add' })}
      onNodeContextMenu={(event, node) => openMenu(event, { kind: 'add', ...(visibleIds.has(node.id) ? { predecessorId: node.id, taskId: node.id } : {}) })}
      onEdgeContextMenu={(event, edge) => { const data = (edge as GraphEdge).data; openMenu(event, data?.kind === 'dependency' && data.sourceTask && data.targetTask ? { kind: 'remove', sourceId: data.sourceTask, targetId: data.targetTask } : { kind: 'add', ...(data?.sourceTask ? { predecessorId: data.sourceTask } : {}) }); }}
      onConnect={connect} isValidConnection={validConnection} onReconnect={reconnect} onReconnectStart={(_event, edge) => { reconnecting.current = edge; setMenu(undefined); }} onReconnectEnd={() => { reconnecting.current = undefined; }} fitView fitViewOptions={{ padding: .22, maxZoom: 1 }} minZoom={.08} maxZoom={1.5} zoomOnDoubleClick={false} panOnScroll zoomActivationKeyCode={['Control', 'Meta']}>
      <Background />
    </ReactFlow>
      {(!currentLayerValid || invalidHierarchy > 0 || blockedTopology > 0) && <div className="graph-layer-notice" role="status">{!currentLayerValid ? '当前层级的父节点缺失或存在循环，请返回项目检查。' : invalidHierarchy > 0 ? `${invalidHierarchy} 个任务的父节点缺失或存在循环，未自动改变其所属层级。` : ''}{blockedTopology > 0 ? ` ${blockedTopology} 个本层任务存在依赖循环或受其阻塞。` : ''}</div>}
      {!currentParent && !all.length && <div className="graph-empty-hint"><strong>从需求开始，逐步形成任务图谱</strong><span>在下方描述你想完成的工作，或右键添加任务。</span></div>}
    </div>
    {menu && <div className="graph-context-menu" ref={menuElement} role="menu" aria-label="图谱操作" style={{ left: menu.x, top: menu.y }} onKeyDown={menuKeyboard}>
      <button type="button" role="menuitem" disabled={menu.kind === 'add' ? !canMutate : !canEditRelations || !editableTarget(menu.targetId)} onClick={() => {
        setMenu(undefined);
        if (menu.kind === 'add') { if (!canMutate || menu.predecessorId && !visibleIds.has(menu.predecessorId)) return; onAdd({ ...(currentParent ? { parentId: currentParent } : {}), ...(menu.predecessorId ? { predecessorId: menu.predecessorId } : {}) }); }
        else { const task = byId.get(menu.targetId); if (canEditRelations && task && editableTarget(task.id)) onDependencies(task, task.dependencies.filter(id => id !== menu.sourceId)); }
      }}><svg viewBox="0 0 16 16" aria-hidden="true">{menu.kind === 'add' ? <path d="M8 3v10M3 8h10" /> : <path d="M3 8h10" />}</svg>{menu.kind === 'add' ? '添加新任务' : '移除此依赖'}</button>
      {deleteTask?.dependencyRepairRequired && <button type="button" role="menuitem" disabled={!canEditRelations || !editableTarget(deleteTask.id)} title="确认当前连线；没有前驱时确认无需上游任务" onClick={() => {
        if (!canEditRelations || !editableTarget(deleteTask.id)) return;
        setMenu(undefined); onDependencies(deleteTask, [...deleteTask.dependencies]);
      }}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7" /></svg>确认当前依赖</button>}
      {deleteTask && <button type="button" role="menuitem" disabled={!!clearBlocker} title={clearBlocker || '清空工作资料，保留任务定义和图谱'} onClick={() => { if (clearBlocker) return; setMenu(undefined); onClear(deleteTask); }}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 6a5.5 5.5 0 1 1-.5 4M3 2v4h4" /></svg>{deleteTask.pendingAction === 'clear' ? '重新确认清空…' : '清空进展…'}</button>}
      {deleteTask && <><div className="graph-menu-divider" role="separator" /><button type="button" role="menuitem" className="graph-menu-delete" disabled={!!deletionBlocker} title={deletionBlocker || '永久删除这个任务及其工作空间'} onClick={() => { if (deletionBlocker) return; setMenu(undefined); onDelete(deleteTask); }}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4h10M6 4V2h4v2M4 4l.7 9h6.6l.7-9M6.5 6.5v4M9.5 6.5v4" /></svg>{deleteTask.pendingAction === 'delete' ? '重新确认删除…' : '删除任务…'}</button>{deletionBlocker && <small className="graph-menu-hint">{deletionBlocker}</small>}</>}
    </div>}
  </section>;
}
