/** Cancellation as an Error a model can read. DSH cancels a turn with a plain reason such as {kind: 'user'}, and keeps a
 * tool's own error when the turn is stopped, so a reason thrown as it is reaches the model as "[object Object]". */
export const STOPPED = '操作已中断：本轮被停止（人点了停止，或自主运行暂停、停止）。';
/** The signal's reason when it is already an Error (timeouts, AbortError), otherwise an AbortError with `message`. */
export function abortError(signal: AbortSignal | undefined, message = STOPPED): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(message); error.name = 'AbortError';
  return error;
}
export function throwIfAborted(signal: AbortSignal | undefined, message?: string): void {
  if (signal?.aborted) throw abortError(signal, message);
}
