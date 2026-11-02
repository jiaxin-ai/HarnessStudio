/** Recordings of the trajectory recorder inside each VM (winvm_traj_recorder, started by the VM's agent service when
 * vm_manager starts a recording). vm_manager keeps them under <projects>/<projectId>/recordings/<vmId>/<recordingId>,
 * the VM's G:\<recordingId>: trajectory.jsonl (one step per action), recording.mp4, screenshots/, raw/, snapshots/,
 * and agent_requests.jsonl, the time window of every agent-service request Studio made (OPERATION_HEADER). */
import { constants } from 'node:fs';
import { open, readdir, readFile, realpath, stat, type FileHandle } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { Readable } from 'node:stream';

import type { RecordingEpisode, RecordingStep } from './seat-types.ts';
import { zipStream } from './zip-stream.ts';

/** One Studio operation from vm-operations/<taskId>.jsonl. */
export interface OperationRecord { tool: string; summary: string; kind: string; chatId: string | null }
interface AgentRequest { operation: string; start: number; end: number }

const TRAJECTORY_LIMIT = 64 * 1024 * 1024, REQUESTS_LIMIT = 16 * 1024 * 1024, OPERATIONS_LIMIT = 32 * 1024 * 1024;
// Injected input is delivered while the agent-service request runs: in VM tests every Agent step fell inside its
// request window. The small margins keep human actions right after an Agent operation the human's.
const BEFORE_MS = 100, AFTER_MS = 300;

const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const string = (value: unknown, limit = 300) => typeof value === 'string' ? value.slice(0, limit) : null;
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;

export async function jsonLines(path: string, limit: number): Promise<Record<string, unknown>[]> {
  let text: string;
  try { if ((await stat(path)).size > limit) return []; text = await readFile(path, 'utf8'); } catch { return []; }
  const rows: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) { if (!line.trim()) continue; try { const row = record(JSON.parse(line)); if (row) rows.push(row); } catch { /* a line cut by a crash */ } }
  return rows;
}

/** Operations by ID from Studio's audit log of Agent VM tools. */
export async function readOperations(path: string): Promise<Map<string, OperationRecord>> {
  const operations = new Map<string, OperationRecord>();
  for (const row of await jsonLines(path, OPERATIONS_LIMIT)) {
    const id = string(row.operation, 100); if (!id) continue;
    operations.set(id, { tool: string(row.tool, 100) ?? '', summary: string(row.summary, 500) ?? '', kind: string(row.kind, 20) ?? '', chatId: string(row.chatId, 200) });
  }
  return operations;
}

const buttons: Record<string, string> = { left: '左键', right: '右键', middle: '中键' };
const target = (value: unknown) => { const name = string(record(value)?.name, 80); return name ? ` “${name}”` : ''; };
const point = (value: unknown) => Array.isArray(value) && value.length === 2 ? `(${value.map(Number).join(', ')})` : '';
/** A short Chinese description of one trajectory action. */
export function describeAction(raw: unknown): string {
  const action = record(raw); if (!action) return '（无操作，仅记录状态）';
  switch (action.type) {
    case 'mouse_click': return `${buttons[String(action.button)] ?? ''}单击 ${point(action.position)}${target(action.target)}`;
    case 'mouse_double_click': return `${buttons[String(action.button)] ?? ''}双击 ${point(action.position)}${target(action.target)}`;
    case 'mouse_drag': return `拖动 ${point(action.start)} → ${point(action.end)}${target(action.target)}`;
    case 'scroll': return `滚动 ${finite(action.dy) ?? 0}${point(action.position) ? ` 于 ${point(action.position)}` : ''}`;
    case 'type_text': return `输入“${string(action.text, 200) ?? ''}”${target(action.target)}`;
    case 'key_press': return `按键 ${string(action.key, 40) ?? ''}`;
    case 'hotkey': return `组合键 ${Array.isArray(action.keys) ? action.keys.map(key => String(key)).join('+') : ''}`;
    case 'shell_command': return `命令 ${string(action.command, 200) ?? ''}`;
    default: return string(action.type, 60) ?? '未知操作';
  }
}

/** The first event's time: recording.mp4 starts there, so it is the zero of video times. */
export async function recordingStart(directory: string): Promise<number | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(join(directory, 'raw', 'events.jsonl'), 'r');
    const buffer = Buffer.alloc(4096), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const first = record(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0]!));
    return first?.type === 'recording_start' ? finite(first.t_ms) : null;
  } catch { return null; } finally { await handle?.close(); }
}

export async function contents(directory: string): Promise<{ files: { path: string; absolute: string; bytes: number; modified: Date }[]; bytes: number }> {
  const files: { path: string; absolute: string; bytes: number; modified: Date }[] = []; let bytes = 0;
  const walk = async (absolute: string, prefix: string) => {
    for (const entry of (await readdir(absolute, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, child = join(absolute, entry.name);
      if (entry.isDirectory()) await walk(child, path);
      else if (entry.isFile()) { const info = await stat(child); files.push({ path, absolute: child, bytes: info.size, modified: info.mtime }); bytes += info.size; }
      if (files.length > 200000) throw new Error('采集目录中的文件过多');
    }
  };
  await walk(directory, ''); return { files, bytes };
}

/** Summary and labelled steps of one recording, or null while its directory does not exist yet. Steps whose
 * time falls in the window of an Agent operation that changes the VM (kind other than read) are the Agent's;
 * other actions are the human's (noVNC/RDP input). */
export async function loadEpisode(directory: string, operations: Map<string, OperationRecord>): Promise<{ episode: RecordingEpisode; steps: RecordingStep[] } | null> {
  try { if (!(await stat(directory)).isDirectory()) return null; } catch { return null; }
  const [lines, requestRows, start, index, task, listing] = await Promise.all([
    jsonLines(join(directory, 'trajectory.jsonl'), TRAJECTORY_LIMIT), jsonLines(join(directory, 'agent_requests.jsonl'), REQUESTS_LIMIT), recordingStart(directory),
    readFile(join(directory, 'snapshots', 'index.json'), 'utf8').then(text => record(JSON.parse(text)), () => undefined),
    readFile(join(directory, 'task.json'), 'utf8').then(text => record(JSON.parse(text)), () => undefined),
    contents(directory).catch(() => ({ files: [], bytes: 0 })),
  ]);
  const requests: AgentRequest[] = requestRows.flatMap(row => {
    const operation = string(row.operation, 100), begin = finite(row.start_ms), end = finite(row.end_ms);
    return operation && begin !== null && end !== null && operations.get(operation)?.kind !== 'read' ? [{ operation, start: begin, end }] : [];
  }).sort((a, b) => a.start - b.start);
  const milestones: { step: number | null; name: string }[] = [];
  for (const row of Array.isArray(index?.checkpoints) ? index.checkpoints : []) {
    const checkpoint = record(row); if (checkpoint?.reason === 'milestone') milestones.push({ step: finite(checkpoint.step_id), name: string(checkpoint.name, 200) ?? '' });
  }
  const steps: RecordingStep[] = lines.flatMap(row => {
    const id = finite(row.step_id), time = finite(row.t_ms); if (id === null || time === null) return [];
    const observation = record(row.observation), action = record(row.action), window = record(observation?.window), events = record(row.events);
    const request = action ? requests.find(item => time >= item.start - BEFORE_MS && time <= item.end + AFTER_MS) : undefined, operation = request && operations.get(request.operation);
    return [{
      id, time: new Date(time).toISOString(), actor: action ? request ? 'agent' as const : 'human' as const : null, action: describeAction(action),
      window: window ? [string(window.title, 200), string(window.process, 80)].filter(Boolean).join(' · ') || null : null,
      screenshot: string(action?.screenshot, 200) ?? string(observation?.screenshot, 200), videoTime: start === null ? null : Math.max(0, (time - start) / 1000),
      files: Array.isArray(events?.files) ? [...new Set(events.files.map(file => string(record(file)?.path, 300)).filter((path): path is string => !!path))].slice(0, 20) : [],
      milestone: milestones.filter(item => item.step === id).map(item => item.name).join('、') || null,
      operation: request ? { id: request.operation, tool: operation?.tool ?? '', summary: operation?.summary ?? '', kind: operation?.kind ?? '', chatId: operation?.chatId ?? null } : null,
    }];
  });
  const last = steps.length ? Date.parse(steps.at(-1)!.time) : null;
  return {
    episode: {
      trajectory: listing.files.some(file => file.path === 'trajectory.jsonl'), steps: steps.length,
      agentSteps: steps.filter(step => step.actor === 'agent').length, humanSteps: steps.filter(step => step.actor === 'human').length,
      durationSeconds: start !== null && last !== null ? Math.max(0, Math.round((last - start) / 1000)) : null,
      screenshots: listing.files.filter(file => file.path.startsWith('screenshots/')).length, video: listing.files.some(file => file.path === 'recording.mp4'),
      milestones: milestones.map(item => item.name), agentOperations: new Set(requests.map(item => item.operation)).size, bytes: listing.bytes, taskTitle: string(task?.title, 200),
    },
    steps,
  };
}

const mediaTypes: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', mp4: 'video/mp4' };
/** A regular file inside the recording directory; only images and the video are shown inline. */
export async function openEpisodeFile(directory: string, path: unknown): Promise<{ handle: FileHandle; bytes: number; mediaType: string; inline: boolean; name: string }> {
  if (typeof path !== 'string' || !path || path.length > 1024 || /[\\\0]/.test(path)) throw new Error('无效的文件路径');
  const parts = path.split('/'); if (parts.some(part => !part || part === '.' || part === '..')) throw new Error('无效的文件路径');
  const root = await realpath(directory), target = await realpath(join(root, ...parts)).catch(() => { throw new Error('采集文件不存在'); });
  if (!target.startsWith(root + sep)) throw new Error('无效的文件路径');
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW), info = await handle.stat();
  if (!info.isFile()) { await handle.close(); throw new Error('采集文件不存在'); }
  const extension = /\.([A-Za-z0-9]+)$/.exec(parts.at(-1)!)?.[1]?.toLowerCase() ?? '', mediaType = mediaTypes[extension];
  return { handle, bytes: info.size, mediaType: mediaType ?? 'application/octet-stream', inline: !!mediaType, name: parts.at(-1)! };
}

const disposition = (kind: 'inline' | 'attachment', name: string) => `${kind}; filename*=UTF-8''${encodeURIComponent(name)}`;
/** The file with HTTP Range support (single ranges), so the video can be seeked. */
export function episodeFileResponse(file: Awaited<ReturnType<typeof openEpisodeFile>>, range: string | null): Response {
  const headers: Record<string, string> = { 'content-type': file.mediaType, 'content-disposition': disposition(file.inline ? 'inline' : 'attachment', file.name), 'x-content-type-options': 'nosniff', 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=300', 'content-security-policy': "sandbox; default-src 'none'" };
  let start = 0, end = file.bytes - 1, status = 200;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match && (match[1] || match[2])) {
      if (match[1]) { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
      else start = Math.max(0, file.bytes - Number(match[2]));
      if (start > end || start >= file.bytes) { void file.handle.close(); return new Response(null, { status: 416, headers: { 'content-range': `bytes */${file.bytes}` } }); }
      status = 206; headers['content-range'] = `bytes ${start}-${end}/${file.bytes}`;
    }
  }
  headers['content-length'] = String(Math.max(0, end - start + 1));
  if (file.bytes === 0) { void file.handle.close(); return new Response(null, { status, headers }); }
  return new Response(Readable.toWeb(file.handle.createReadStream({ start, end })) as ReadableStream<Uint8Array>, { status, headers });
}

/** The whole recording as a stored ZIP, streamed (zipStream). Opened offline, trajectory.html plays it. */
export async function zipEpisode(directory: string, folder: string): Promise<ReadableStream<Uint8Array>> {
  const { files } = await contents(directory);
  return zipStream((async function* () { for (const file of files) yield { name: `${folder}/${file.path}`, modified: file.modified, file: file.absolute, bytes: file.bytes }; })());
}
export const zipDisposition = (name: string) => disposition('attachment', name);
