export const completionColumns = ['select', 'name', 'status', 'bytes', 'createdAt', 'modifiedAt'] as const;
export type CompletionColumn = typeof completionColumns[number];
export const completionColumnStorageKey = 'harnessstudio:completion-file-columns:v1';
const legacyColumns = ['select', 'name', 'createdAt', 'modifiedAt'] as const;

function validOrder(value: unknown): value is CompletionColumn[] {
  return Array.isArray(value) && value.length === completionColumns.length
    && new Set(value).size === completionColumns.length
    && value.every(column => completionColumns.includes(column));
}

function legacyOrder(value: unknown): value is typeof legacyColumns[number][] {
  return Array.isArray(value) && value.length === legacyColumns.length
    && new Set(value).size === legacyColumns.length
    && value.every(column => legacyColumns.includes(column));
}

export function readCompletionColumnOrder(): CompletionColumn[] {
  try {
    const saved = globalThis.localStorage?.getItem(completionColumnStorageKey);
    const parsed: unknown = saved ? JSON.parse(saved) : undefined;
    if (validOrder(parsed)) return parsed;
    if (legacyOrder(parsed)) {
      const migrated: CompletionColumn[] = [...parsed, 'status', 'bytes'];
      saveCompletionColumnOrder(migrated);
      return migrated;
    }
  } catch { /* Missing or denied storage should not prevent file selection. */ }
  return [...completionColumns];
}

export function saveCompletionColumnOrder(order: CompletionColumn[]): void {
  try {
    if (validOrder(order)) globalThis.localStorage?.setItem(completionColumnStorageKey, JSON.stringify(order));
  } catch { /* The current dialog can still use the chosen order. */ }
}

export function moveCompletionColumn(order: CompletionColumn[], source: CompletionColumn, target: CompletionColumn): CompletionColumn[] {
  if (!validOrder(order) || source === target) return order;
  const from = order.indexOf(source), to = order.indexOf(target);
  if (from < 0 || to < 0) return order;
  const next = [...order]; next.splice(from, 1); next.splice(to, 0, source);
  return next;
}
