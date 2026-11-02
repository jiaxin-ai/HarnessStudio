import { seatOrigin } from './seat-origin.ts';

export class VmPlatformError extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message); } }
export function vmObject(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('虚拟机平台响应格式无效'); return value as Record<string, unknown>; }

/** vm_manager v1 answers {data} or {error:{code,message}}; responses are bounded and redirects refused. */
export class VmClient {
  readonly endpoint: string;
  constructor(endpoint: string, trustedHttpOrigins: unknown, private readonly timeoutMs: number) { this.endpoint = seatOrigin(endpoint, trustedHttpOrigins); }
  async call<T>(path: string, method = 'GET', body?: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    if (!this.endpoint) throw new Error('虚拟机平台未配置，请设置 STUDIO_VMM_URL');
    let response: Response;
    try { response = await fetch(this.endpoint + path, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs), redirect: 'error' }); }
    catch { throw new VmPlatformError(0, 'UNREACHABLE', '虚拟机平台暂时不可达或请求超时；请刷新状态确认结果，不要重复创建'); }
    const reader = response.body?.getReader(); const parts: Uint8Array[] = []; let bytes = 0;
    if (reader) try { while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > 2 * 1024 * 1024) throw new Error('虚拟机平台响应超过限制'); parts.push(part.value); } } finally { await reader.cancel().catch(() => {}); }
    let value: unknown; try { value = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw new VmPlatformError(response.status, 'INVALID_RESPONSE', `虚拟机平台返回了无法解析的响应（HTTP ${response.status}）`); }
    if (!response.ok) {
      const error = (value as { error?: { code?: unknown; message?: unknown } } | null)?.error, code = typeof error?.code === 'string' ? error.code : String(response.status);
      throw new VmPlatformError(response.status, code, `虚拟机平台 ${code}: ${typeof error?.message === 'string' ? error.message.slice(0, 500) : '请求失败'}`);
    }
    return vmObject(value).data as T;
  }
}

export interface VmWorkspace { id: string; projectId: string; taskId: string; frozen: boolean; path: string }
function workspace(raw: unknown): VmWorkspace {
  const row = vmObject(raw);
  if (typeof row.workspace_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(row.workspace_id) || typeof row.path !== 'string' || !['writable', 'frozen'].includes(String(row.status))) throw new Error('虚拟机平台返回的任务空间无效');
  return { id: row.workspace_id, projectId: String(row.project_id), taskId: String(row.task_id), frozen: row.status === 'frozen', path: row.path };
}

/** vm_manager task spaces (D: drive): at most one per task, no delete API. Freeze/unfreeze may block on chattr of large trees. */
export class VmWorkspaces {
  constructor(private readonly client: VmClient, private readonly longTimeoutMs: number) {}
  async find(projectId: string, taskId: string): Promise<VmWorkspace | null> {
    const data = vmObject(await this.client.call<unknown>(`/v1/workspaces?${new URLSearchParams({ project_id: projectId, task_id: taskId })}`));
    if (!Array.isArray(data.items)) throw new Error('虚拟机平台响应格式无效');
    const rows = data.items.map(workspace).filter(row => row.projectId === projectId && row.taskId === taskId);
    return rows[0] ?? null;
  }
  async ensure(projectId: string, taskId: string): Promise<VmWorkspace> {
    try { return workspace(await this.client.call<unknown>('/v1/workspaces', 'POST', { project_id: projectId, task_id: taskId })); }
    catch (error) {
      if (!(error instanceof VmPlatformError && error.code === 'WORKSPACE_EXISTS')) throw error;
      const existing = await this.find(projectId, taskId); if (!existing) throw error; return existing;
    }
  }
  async freeze(id: string): Promise<VmWorkspace> { return workspace(await this.client.call<unknown>(`/v1/workspaces/${encodeURIComponent(id)}/freeze`, 'POST', undefined, this.longTimeoutMs)); }
  async unfreeze(id: string): Promise<VmWorkspace> { return workspace(await this.client.call<unknown>(`/v1/workspaces/${encodeURIComponent(id)}/unfreeze`, 'POST', undefined, this.longTimeoutMs)); }
}
