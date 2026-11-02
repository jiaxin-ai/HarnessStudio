export async function api<T>(path: string, body?: object, options: { timeoutMs?: number } = {}): Promise<T> {
  const signal = options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined;
  let response: Response;
  try {
    response = await fetch(`/api/studio/${path}`, { ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), ...(signal ? { signal } : {}) });
  } catch (error) {
    // A request lost while the service restarts must not leave the page waiting forever.
    if (signal?.aborted) throw new Error('请求超时，服务器没有响应。请刷新页面查看最新状态，不要重复操作。');
    throw error;
  }
  const value = await response.json();
  if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : `HTTP ${response.status}`);
  return value as T;
}
