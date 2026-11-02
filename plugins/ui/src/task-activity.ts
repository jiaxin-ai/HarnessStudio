import type { ChatActivity } from '../../studio/src/chat-activity.ts';

export interface ActivityTask { id: string; projectId: string; parentId?: string; state: string; archived?: boolean }
export interface ActivityChat { scope?: 'project' | 'task'; projectId?: string; taskId?: string; status?: string; activity?: ChatActivity }
export interface TaskActivity { base: 'gray' | 'green'; attention: 'steady' | 'active' | 'waiting'; reason: 'none' | 'running' | 'awaiting-input' | 'question' | 'permission'; descendant: boolean }
export type TaskActivityMap = ReadonlyMap<string, TaskActivity>;
const priority = { none: 0, 'awaiting-input': 1, running: 2, question: 3, permission: 4 } as const;
const steady = (task: ActivityTask): TaskActivity => ({ base: task.state === 'completed' ? 'green' : 'gray', attention: 'steady', reason: 'none', descendant: false });
function reasonOf(chat: ActivityChat): TaskActivity['reason'] {
  // Older hosts may report live execution but not the new read-only activity projection.
  return chat.activity?.kind ?? (chat.status === 'running' ? 'running' : 'none');
}

/** One post-order walk; exact project ownership and archived ancestry are checked before aggregation. */
export function aggregateTaskActivity(tasks: readonly ActivityTask[], chats: readonly ActivityChat[]): TaskActivityMap {
  const byId = new Map(tasks.map(task => [task.id, task])), hidden = new Map<string, boolean>();
  for (const task of tasks) {
    const chain: string[] = [], seen = new Set<string>(); let cursor: ActivityTask | undefined = task, archived = false;
    while (cursor && !seen.has(cursor.id)) {
      if (hidden.has(cursor.id)) { archived = hidden.get(cursor.id)!; break; }
      chain.push(cursor.id); seen.add(cursor.id);
      if (cursor.archived) { archived = true; break; }
      const parent: ActivityTask | undefined = cursor.parentId ? byId.get(cursor.parentId) : undefined;
      cursor = parent?.projectId === task.projectId ? parent : undefined;
    }
    for (const id of chain) hidden.set(id, archived);
  }
  const own = new Map<string, TaskActivity['reason']>(), children = new Map<string, string[]>();
  for (const task of tasks) {
    if (hidden.get(task.id)) continue;
    const parent = task.parentId ? byId.get(task.parentId) : undefined;
    if (parent && parent.projectId === task.projectId && !hidden.get(parent.id)) children.set(parent.id, [...children.get(parent.id) ?? [], task.id]);
  }
  for (const chat of chats) {
    if (chat.scope === 'project' || !chat.taskId) continue;
    const task = byId.get(chat.taskId);
    if (!task || hidden.get(task.id) || chat.projectId !== undefined && chat.projectId !== task.projectId || task.state === 'completed') continue;
    const reason = reasonOf(chat);
    if (priority[reason] > priority[own.get(task.id) ?? 'none']) own.set(task.id, reason);
  }
  const result = new Map<string, TaskActivity>(), visiting = new Set<string>();
  const visit = (id: string): TaskActivity => {
    const task = byId.get(id)!;
    const known = result.get(id); if (known) return known;
    if (visiting.has(id)) return steady(task);
    visiting.add(id);
    let reason = own.get(id) ?? 'none', descendant = false;
    for (const child of children.get(id) ?? []) {
      const activity = visit(child);
      if (priority[activity.reason] > priority[reason]) { reason = activity.reason; descendant = true; }
    }
    visiting.delete(id);
    const activity: TaskActivity = { base: task.state === 'completed' ? 'green' : 'gray', attention: priority[reason] >= 3 ? 'waiting' : priority[reason] > 0 ? 'active' : 'steady', reason, descendant };
    result.set(id, activity); return activity;
  };
  for (const task of tasks) if (!hidden.get(task.id)) visit(task.id);
  return result;
}

export function taskActivityLabel(activity: TaskActivity): string {
  const reason = { none: activity.base === 'green' ? '已完成' : '暂无对话活动', running: '正在执行', 'awaiting-input': '等待下一次输入', question: '等待回答问题或选择选项', permission: '等待权限确认' }[activity.reason];
  return `${activity.descendant ? '子任务：' : ''}${reason}`;
}
export function taskActivityClass(activity: TaskActivity): string { return `task-activity-light activity-${activity.attention} activity-base-${activity.base}`; }
export function defaultTaskActivity(state: string): TaskActivity { return steady({ id: '', projectId: '', state }); }
