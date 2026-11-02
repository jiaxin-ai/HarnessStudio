/** Who changed what and when, for the project trajectory export: every state-changing request made from the Studio
 * page (a person) and every Agent file-tool write. Times come from the server's clock and are stored in UTC. */
export interface ActivityEvent {
  seq: number; at: string; atMs: number;
  actor: 'human' | 'agent'; source: 'web' | 'agent-tool';
  action: string; projectId?: string; taskId?: string; chatId?: string; vmId?: string;
  ok: boolean; error?: string; durationMs?: number;
  request?: unknown; before?: unknown; after?: unknown; result?: unknown;
}
export type ActivityInput = Omit<ActivityEvent, 'seq' | 'at' | 'atMs'> & { atMs?: number };
export interface ActivityIds { projectId?: string; taskId?: string; chatId?: string; vmId?: string }

/** POST routes that only compute a preview change nothing. */
export const isStateChanging = (method: string, path: string) => !['GET', 'HEAD', 'OPTIONS'].includes(method) && !path.endsWith('/preview');

const TEXT_LIMIT = 500, LIST_LIMIT = 50;
/** A bounded copy for the log: long text is cut (file contents and pasted text stay in the workspace and chats),
 * attachment bytes are reduced to their size. */
export function summarize(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > TEXT_LIMIT ? `${value.slice(0, TEXT_LIMIT)}…（共 ${value.length} 字符）` : value;
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 4) return Array.isArray(value) ? `[${value.length} 项]` : '{…}';
  if (Array.isArray(value)) return [...value.slice(0, LIST_LIMIT).map(item => summarize(item, depth + 1)), ...(value.length > LIST_LIMIT ? [`…（共 ${value.length} 项）`] : [])];
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if ((key === 'data' || key === 'content') && typeof item === 'string' && item.length > TEXT_LIMIT) result[key] = { chars: item.length };
    else result[key] = summarize(item, depth + 1);
  }
  return result;
}

const text = (value: unknown) => typeof value === 'string' && value ? value : undefined;
/** The project, task, conversation and VM a request is about. `id` means a project, a task or a conversation
 * depending on the route. */
export function activityIds(path: string, values: Record<string, unknown>): ActivityIds {
  const ids: ActivityIds = {}, id = text(values.id);
  if (text(values.projectId)) ids.projectId = text(values.projectId);
  if (text(values.taskId)) ids.taskId = text(values.taskId);
  if (text(values.chatId)) ids.chatId = text(values.chatId);
  if (text(values.vmId)) ids.vmId = text(values.vmId);
  if (id) {
    if (path === '/api/studio/projects' || path.startsWith('/api/studio/project/')) ids.projectId ??= id;
    else if (path === '/api/studio/task' || path.startsWith('/api/studio/task/')) ids.taskId ??= id;
    else if (path === '/api/studio/chat' || path.startsWith('/api/studio/chat/')) ids.chatId ??= id;
  }
  return ids;
}

/** The route without its common prefix, plus the sub-action a few routes carry in the body. */
export function routeAction(path: string, values: Record<string, unknown>): string {
  const name = path.replace(/^\/api\/studio\//, '');
  const detail = text(values.action) ?? (typeof values.controller === 'string' ? values.controller : undefined)
    ?? (typeof values.enabled === 'boolean' ? (values.enabled ? 'on' : 'off') : undefined) ?? (values.directory === true ? 'directory' : undefined);
  return detail ? `${name}:${detail}` : name;
}
