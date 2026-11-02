export interface GraphPoint { x: number; y: number }
export interface LayoutTask { id: string; rank: number; dependencies: readonly string[] }
export type GraphPositions = Record<string, GraphPoint>;

export function isGraphPoint(value: unknown): value is GraphPoint {
  return !!value && typeof value === 'object' && 'x' in value && 'y' in value &&
    typeof value.x === 'number' && typeof value.y === 'number' && Number.isFinite(value.x) && Number.isFinite(value.y) &&
    Math.abs(value.x) <= 10_000_000 && Math.abs(value.y) <= 10_000_000;
}

/** Deterministic left-to-right DAG layers, vertically centered with even branch gaps. */
export function layoutTaskLayer(tasks: readonly LayoutTask[], heights: ReadonlyMap<string, number> = new Map()) {
  const ordered = [...tasks].sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
  const ids = new Set(ordered.map(task => task.id)), levels = new Map(ordered.map(task => [task.id, 0]));
  const incoming = new Map<string, number>(), successors = new Map<string, string[]>();
  for (const task of ordered) {
    const dependencies = [...new Set(task.dependencies.filter(id => ids.has(id)))];
    incoming.set(task.id, dependencies.length);
    for (const id of dependencies) successors.set(id, [...successors.get(id) ?? [], task.id]);
  }
  const ready = ordered.filter(task => incoming.get(task.id) === 0).map(task => task.id);
  for (let index = 0; index < ready.length; index++) {
    const id = ready[index];
    for (const next of successors.get(id) ?? []) {
      levels.set(next, Math.max(levels.get(next) ?? 0, (levels.get(id) ?? 0) + 1));
      const remaining = incoming.get(next)! - 1; incoming.set(next, remaining);
      if (!remaining) ready.push(next);
    }
  }
  // Diagnose legacy cycles elsewhere, while still giving every node a safe position.
  const processed = new Set(ready), lastValid = Math.max(0, ...levels.values());
  for (const task of ordered) if (!processed.has(task.id)) levels.set(task.id, lastValid + 1);
  const columns = new Map<number, LayoutTask[]>();
  for (const task of ordered) columns.set(levels.get(task.id)!, [...columns.get(levels.get(task.id)!) ?? [], task]);
  const height = (id: string) => Math.max(110, Math.min(320, heights.get(id) ?? 145));
  const columnHeights = new Map([...columns].map(([column, rows]) => [column, rows.reduce((sum, task) => sum + height(task.id), 0) + Math.max(0, rows.length - 1) * 72]));
  const fullHeight = Math.max(145, ...columnHeights.values()), positions: GraphPositions = {};
  for (const [column, rows] of columns) {
    let y = (fullHeight - columnHeights.get(column)!) / 2 + 28;
    for (const task of rows) { positions[task.id] = { x: (column + 1) * 320, y }; y += height(task.id) + 72; }
  }
  return { positions, start: { x: 35, y: fullHeight / 2 - 1 }, end: { x: (Math.max(0, ...levels.values()) + 2) * 320 + 24, y: fullHeight / 2 - 1 }, blockedTopology: ordered.length - ready.length };
}

/** Prune removed nodes; retain every surviving position when inputs or labels change. */
export function mergeGraphPositions(defaults: GraphPositions, saved: GraphPositions): GraphPositions {
  const result: GraphPositions = {};
  for (const id of Object.keys(defaults)) if (isGraphPoint(saved[id])) result[id] = saved[id];
  for (const [id, point] of Object.entries(defaults)) {
    if (result[id]) continue;
    let y = point.y;
    // New nodes get a nearby free row instead of covering an existing dragged node.
    while (Object.values(result).some(existing => Math.abs(existing.x - point.x) < 280 && Math.abs(existing.y - y) < 180)) y += 225;
    result[id] = { x: point.x, y };
  }
  return result;
}

export function readGraphPositions(key: string): GraphPositions {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, point]) => isGraphPoint(point)));
  } catch { return {}; }
}

export function saveGraphPositions(key: string, positions: GraphPositions) {
  try { localStorage.setItem(key, JSON.stringify(positions)); } catch { /* Layout remains usable when browser storage is unavailable. */ }
}
