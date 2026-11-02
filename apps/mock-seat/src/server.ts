import { createServer, type Server, type ServerResponse, type IncomingMessage } from 'node:http';
import { mkdir, open, rename, rm, lstat, realpath, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash, randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SeatView, PlatformError, ControlLease, BridgeOperation, BridgeOperationIndex, BridgeRequest, MockDocument, MockAnalysis, MockShape, MockFault, SeatRecord, ArtifactContent, SoftwareDescriptor, PlatformConnection } from '../../../plugins/studio/src/seat-types.ts';

export interface MockSeatOptions { dataRoot: string; token: string; provisionDelayMs?: number; operationDelayMs?: number; maxSeats?: number; imageIds?: string[] }
export type MockSeatServer = Server & { ready: Promise<void> };
type StoredOperation = { view: BridgeOperation; fingerprint: string; request: Omit<BridgeRequest, 'controlToken'>; fence: number };
type StoredSeat = { view: SeatView; fence: number; delayMs?: number; operations: StoredOperation[]; artifacts: ArtifactContent[]; records: SeatRecord[]; nextSequence: number };
type Store = { version: 1; seats: StoredSeat[]; requests: Record<string, { fingerprint: string; seatId: string }> };
const faults = new Set<MockFault>(['none', 'provision-failed', 'resource-exhausted', 'operation-failed', 'timeout', 'unknown']);
const terminal = new Set(['succeeded', 'failed', 'canceled', 'unknown']);
const maximumContent = 256 * 1024;
const drawingCapabilities: SoftwareDescriptor['capabilities'] = [
  { id: 'document.inspect', title: '查看文档', mutates: false, description: 'parameters: {}. Returns the simulated document and documentRevision; coordinates use mm.' },
  { id: 'document.rename', title: '重命名文档', mutates: true, description: 'parameters: {name:string}. name is required, nonempty, at most 200 characters. Renames the simulated document.' },
  { id: 'shape.add', title: '添加图形', mutates: true, description: 'parameters: {kind:"rectangle"|"circle",x:number,y:number,width:number,height:number,label?:string}. kind, x, y, width, height are required; finite x/y in [-10000,10000] mm, width/height in [0.01,10000] mm; label at most 200 characters. Returns shapeId and documentRevision. Simulated drawing only; no CAD solver.' },
  { id: 'shape.update', title: '更新图形', mutates: true, description: 'parameters: {id:string,kind?:"rectangle"|"circle",x?:number,y?:number,width?:number,height?:number,label?:string}. id and at least one changed field are required; same bounds as shape.add. Returns shapeId and documentRevision.' },
  { id: 'shape.delete', title: '删除图形', mutates: true, description: 'parameters: {id:string}. id is a required existing shape ID returned by inspect/add. Removes the shape and returns documentRevision.' },
  { id: 'document.export', title: '导出文档', mutates: false, description: 'parameters: {format:"json"|"svg",name?:string}. format is required; optional name is a file name of at most 120 characters without path separators. Returns artifactId for an immutable Mock snapshot (at most 256 KiB). Export does not submit files or complete a task.' },
];
const images: SoftwareDescriptor[] = [
  { id: 'mock-solidworks', name: 'SolidWorks（Mock）', version: '1.0', mock: true, imageRef: 'harnessstudio/mock-solidworks:1.0', category: 'mechanical', workbench: 'drawing', aliases: ['mock-cad'],
    description: '机械设计流程演示：二维图形编辑、参数调整与产物导出。', capabilities: drawingCapabilities },
  { id: 'mock-ansys', name: 'ANSYS（Mock）', version: '1.0', mock: true, imageRef: 'harnessstudio/mock-ansys:1.0', category: 'simulation', workbench: 'simulation', aliases: [],
    description: '分析流程演示：工况配置、模拟运行与合成结果。', capabilities: [
      drawingCapabilities[0], drawingCapabilities[1],
      { id: 'analysis.configure', title: '配置模拟分析', mutates: true, description: 'parameters: {type:"static"|"modal",loadN:number,elasticModulusMPa:number,meshSizeMm:number}. All fields required; finite loadN in [0,1000000000], elasticModulusMPa in [0.001,1000000000], meshSizeMm in [0.001,10000]. Replaces configuration and clears old synthetic results.' },
      { id: 'analysis.run', title: '运行模拟分析', mutates: true, description: 'parameters: {}. Requires prior analysis.configure. Returns deterministic synthetic results marked mock:true; never a real ANSYS solve or engineering validation.' },
      { id: 'document.export', title: '导出模拟分析', mutates: false, description: 'parameters: {format:"json",name?:string}. JSON only; optional filename at most 120 characters without path separators. Exports an immutable Mock analysis snapshot and returns artifactId. No SVG, file submission or task completion.' },
    ] },
  { id: 'mock-autocad', name: 'AutoCAD（Mock）', version: '1.0', mock: true, imageRef: 'harnessstudio/mock-autocad:1.0', category: 'drafting', workbench: 'drawing', aliases: [],
    description: '二维制图流程演示：图形绘制、说明编辑与图纸导出。', capabilities: drawingCapabilities },
];
class ApiError extends Error {
  status: number; detail: PlatformError;
  constructor(status: number, code: string, message: string, retryable = false) { super(message); this.status = status; this.detail = { code, message, retryable }; }
}
function failure(status: number, code: string, message: string, retryable = false): never { throw new ApiError(status, code, message, retryable); }
function image(id: string): SoftwareDescriptor {
  const found = images.find(value => value.id === id || value.aliases?.includes(id));
  if (!found) failure(404, 'IMAGE_NOT_FOUND', 'Requested software image is not available.');
  return found;
}
const now = () => new Date().toISOString();
const copy = <T>(value: T): T => structuredClone(value);
const secret = () => randomBytes(32).toString('base64url');
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) failure(400, 'INVALID_REQUEST', 'JSON object required.');
  return value as Record<string, unknown>;
}
function fields(value: unknown, allowed: string[]): Record<string, unknown> {
  const data = object(value);
  if (Object.keys(data).some(key => !allowed.includes(key))) failure(400, 'INVALID_REQUEST', 'Unexpected request fields.');
  return data;
}
function text(value: unknown, field: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/u.test(value)) failure(400, 'INVALID_REQUEST', `Invalid ${field}.`);
  return value.trim();
}
function integer(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) failure(400, 'INVALID_REQUEST', `Invalid ${field}.`);
  return value;
}
function numeric(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) failure(400, 'INVALID_REQUEST', `Invalid ${field}.`);
  return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
const fingerprint = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const xml = (value: string) => value.replace(/[&<>"']/gu, letter => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[letter]!);
function svg(document: MockDocument, softwareName: string): string {
  const shapes = document.shapes.map(shape => {
    const geometry = shape.kind === 'circle'
      ? `<ellipse cx="${shape.x + shape.width / 2}" cy="${shape.y + shape.height / 2}" rx="${shape.width / 2}" ry="${shape.height / 2}"/>`
      : `<rect x="${shape.x}" y="${shape.y}" width="${shape.width}" height="${shape.height}" rx="3"/>`;
    return `<g fill="#dbeafe" stroke="#3b82f6">${geometry}<text x="${shape.x + 4}" y="${shape.y + 16}" fill="#172554" stroke="none" font-size="12">${xml(shape.label)}</text></g>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-50 -50 1100 700"><title>${xml(document.name)} · ${xml(softwareName)}</title><rect x="-50" y="-50" width="1100" height="700" fill="#f8fafc"/><text x="0" y="-20" font-size="16">${xml(softwareName)} · ${xml(document.name)} · mm</text>${shapes}</svg>`;
}

class Runtime {
  readonly root: string; readonly options: Required<MockSeatOptions>; readonly ready: Promise<void>;
  private store: Store = { version: 1, seats: [], requests: {} };
  private queue: Promise<unknown>; private unavailable = false; private closing = false;
  private timers = new Set<NodeJS.Timeout>();
  private streams = new Map<string, Set<ServerResponse>>();
  private tickets = new Map<string, { seatId: string; expires: number }>();
  constructor(options: MockSeatOptions) {
    if (!options.token || options.token.length > 4096) throw new Error('Mock Seat service token is required.');
    this.root = resolve(options.dataRoot);
    const imageIds = options.imageIds ?? images.map(value => value.id);
    if (!Array.isArray(imageIds) || imageIds.length < 1 || imageIds.length > images.length || imageIds.some(value => typeof value !== 'string' || !images.some(row => row.id === value)) || new Set(imageIds).size !== imageIds.length) throw new Error('Invalid available Mock image IDs.');
    this.options = { ...options, dataRoot: this.root, provisionDelayMs: options.provisionDelayMs ?? 180, operationDelayMs: options.operationDelayMs ?? 300, maxSeats: options.maxSeats ?? 16, imageIds: [...imageIds] };
    for (const field of ['provisionDelayMs', 'operationDelayMs'] as const) if (!Number.isSafeInteger(this.options[field]) || this.options[field] < 0 || this.options[field] > 60_000) throw new Error(`Invalid ${field}.`);
    if (!Number.isSafeInteger(this.options.maxSeats) || this.options.maxSeats < 1 || this.options.maxSeats > 100) throw new Error('Invalid maxSeats.');
    this.ready = this.initialize(); this.queue = this.ready;
    void this.ready.catch(() => { this.unavailable = true; });
  }
  run<T>(action: () => Promise<T> | T): Promise<T> {
    const work = this.queue.then(() => { if (this.unavailable || this.closing) failure(503, 'PLATFORM_UNAVAILABLE', 'Mock platform is unavailable.', true); return action(); });
    this.queue = work.catch(() => {}); return work;
  }
  private async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const directory = await lstat(this.root);
    if (!directory.isDirectory() || directory.isSymbolicLink() || await realpath(this.root) !== this.root) throw new Error('Mock data root must be a real directory.');
    await chmod(this.root, 0o700);
    try {
      const handle = await open(join(this.root, 'state.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat(); if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new Error('Invalid Mock platform state.');
        const data = JSON.parse(await handle.readFile('utf8'));
        if (data.version !== 1 || !Array.isArray(data.seats) || !data.requests || typeof data.requests !== 'object') throw new Error('Invalid Mock platform state.');
        this.store = data;
      } finally { await handle.close(); }
    } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    for (const seat of this.store.seats) {
      // Canonicalize the previous Mock CAD alias without replacing any document,
      // operation, artifact or task identity. Allocation retries stay idempotent.
      seat.view.softwareId = image(seat.view.softwareId).id;
      seat.view.document.kind ??= image(seat.view.softwareId).workbench;
      seat.view.control = null; seat.fence++;
      for (const operation of seat.operations) if (!terminal.has(operation.view.state)) {
        operation.view.state = 'unknown'; operation.view.updatedAt = now(); operation.view.error = { code: 'OPERATION_RESULT_UNKNOWN', message: 'Platform restarted during this operation; inspect before retrying.', retryable: false };
      }
      if (seat.view.state === 'provisioning') this.schedule(() => this.provision(seat), seat.delayMs ?? this.options.provisionDelayMs);
    }
    for (const request of Object.values(this.store.requests)) {
      const seat = this.store.seats.find(row => row.view.id === request.seatId);
      if (seat) request.fingerprint = fingerprint({ softwareId: seat.view.softwareId, taskId: seat.view.taskId, projectId: seat.view.projectId });
    }
    await this.persist();
  }
  private async persist(): Promise<void> {
    const target = join(this.root, 'state.json'), temporary = join(this.root, `state-${randomUUID()}.tmp`);
    // Lease and connection credentials are memory-only; no secrets enter the persistent log.
    const data = copy(this.store); for (const seat of data.seats) seat.view.control = null;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(data)); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, target);
      const directory = await open(this.root, 'r'); try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) { this.unavailable = true; throw new ApiError(503, 'PERSISTENCE_FAILED', 'Mock platform storage failed.', true); }
    finally { await rm(temporary, { force: true }); }
  }
  private schedule(action: () => Promise<void>, delay: number): void {
    if (this.closing) return;
    const timer = setTimeout(() => { this.timers.delete(timer); void this.run(action).catch(() => {}); }, delay);
    timer.unref(); this.timers.add(timer);
  }
  private seat(id: string, ready = false): StoredSeat {
    const seat = this.store.seats.find(row => row.view.id === id);
    if (!seat) failure(404, 'SEAT_NOT_FOUND', 'Seat does not exist.');
    if (ready && seat.view.state !== 'ready') failure(409, seat.view.state === 'released' ? 'SEAT_RELEASED' : 'SEAT_NOT_READY', 'Seat is not ready for this operation.');
    return seat;
  }
  private touch(seat: StoredSeat): void { seat.view.revision++; seat.view.updatedAt = now(); }
  private emit(id: string, event: string, data: unknown): void {
    const text = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const response of this.streams.get(id) ?? []) {
      if (response.destroyed || response.writableLength > 1024 * 1024) { response.end(); continue; }
      response.write(text);
    }
  }
  private record(seat: StoredSeat, event: string, operationId?: string, lease?: ControlLease, detail?: string): void {
    if (!seat.view.recorderEnabled) return;
    const record: SeatRecord = { sequence: seat.nextSequence++, timestamp: now(), event, documentRevision: seat.view.document.revision,
      ...(operationId ? { operationId } : {}), ...(lease ? { actor: lease.actor, ownerId: lease.ownerId } : {}), ...(detail ? { detail } : {}) };
    seat.records.push(record); if (seat.records.length > 2000) seat.records.shift();
    this.emit(seat.view.id, 'record', record);
  }
  private expire(seat: StoredSeat): void {
    if (seat.view.control && Date.parse(seat.view.control.expiresAt) <= Date.now()) {
      seat.view.control = null; seat.fence++; this.cancelOwned(seat, 'CONTROL_EXPIRED', 'Control lease expired.'); this.touch(seat);
    }
  }
  private cancelOwned(seat: StoredSeat, code: string, message: string): void {
    for (const operation of seat.operations) if (!terminal.has(operation.view.state)) {
      operation.view.state = 'canceled'; operation.view.updatedAt = now(); operation.view.error = { code, message, retryable: false };
      this.emit(seat.view.id, 'operation', operation.view); this.record(seat, 'operation.canceled', operation.view.id);
    }
  }
  private control(seat: StoredSeat, token: unknown): ControlLease {
    this.expire(seat); const lease = seat.view.control;
    if (!lease || typeof token !== 'string' || !this.equal(token, lease.token)) failure(409, 'CONTROL_REQUIRED', 'A current control lease is required.');
    return lease;
  }
  equal(left: string, right: string): boolean { const a = Buffer.from(left), b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
  authorized(request: IncomingMessage): boolean { const value = request.headers.authorization; return typeof value === 'string' && value.startsWith('Bearer ') && this.equal(value.slice(7), this.options.token); }
  private async provision(seat: StoredSeat): Promise<void> {
    if (seat.view.state !== 'provisioning') return;
    if (seat.view.fault === 'provision-failed' || seat.view.fault === 'resource-exhausted') {
      seat.view.state = 'failed'; seat.view.error = { code: seat.view.fault === 'resource-exhausted' ? 'RESOURCE_EXHAUSTED' : 'PROVISION_FAILED', message: 'Injected Mock Seat provisioning failure.', retryable: true };
    } else seat.view.state = 'ready';
    this.touch(seat); await this.persist(); this.emit(seat.view.id, 'seat', seat.view);
  }
  private availableImages() { return images.filter(value => this.options.imageIds.includes(value.id)).map(copy); }
  listImages() { return { images: this.availableImages() }; }
  listSoftware() { return { software: this.availableImages() }; }
  async createSeat(input: unknown): Promise<SeatView> {
    const data = fields(input, ['requestId', 'imageId', 'softwareId', 'taskId', 'projectId']);
    const requestId = text(data.requestId, 'requestId', 100), taskId = text(data.taskId, 'taskId', 100), projectId = text(data.projectId, 'projectId', 100);
    if (data.imageId === undefined && data.softwareId === undefined) failure(400, 'IMAGE_REQUIRED', 'Select an available software image explicitly.');
    const selected = image(text(data.imageId !== undefined ? data.imageId : data.softwareId, 'imageId', 100));
    if (data.imageId !== undefined && data.softwareId !== undefined && selected.id !== image(text(data.softwareId, 'softwareId', 100)).id) failure(400, 'IMAGE_ID_CONFLICT', 'imageId and softwareId select different images.');
    if (!this.options.imageIds.includes(selected.id)) failure(404, 'IMAGE_NOT_FOUND', 'Requested software image is not available in this profile.');
    const softwareId = selected.id;
    const hash = fingerprint({ softwareId, taskId, projectId }), previous = Object.hasOwn(this.store.requests, requestId) ? this.store.requests[requestId] : undefined;
    if (previous) { if (previous.fingerprint !== hash) failure(409, 'REQUEST_ID_CONFLICT', 'Request ID was already used for different data.'); return copy(this.seat(previous.seatId).view); }
    if (this.store.seats.filter(row => row.view.state !== 'released').length >= this.options.maxSeats) failure(503, 'RESOURCE_EXHAUSTED', 'Mock Seat capacity is exhausted.', true);
    if (this.store.seats.length >= 1000) failure(503, 'RESOURCE_EXHAUSTED', 'Mock Seat history capacity is exhausted.', true);
    const stamp = now(), id = `s-${randomUUID()}`;
    const view: SeatView = { id, apiVersion: '1', softwareId, taskId, projectId, state: 'provisioning', revision: 1, createdAt: stamp, updatedAt: stamp, mock: true,
      document: { name: '未命名 Mock 文档', kind: selected.workbench, revision: 0, units: 'mm', shapes: [], modifiedAt: stamp }, control: null, artifacts: [], recorderEnabled: false, fault: 'none' };
    const seat: StoredSeat = { view, fence: 0, operations: [], artifacts: [], records: [], nextSequence: 1 };
    this.store.seats.push(seat); this.store.requests = { ...this.store.requests, [requestId]: { fingerprint: hash, seatId: id } }; await this.persist();
    this.schedule(() => this.provision(seat), this.options.provisionDelayMs); return copy(view);
  }
  async getSeat(id: string): Promise<SeatView> { const seat = this.seat(id); const old = seat.fence; this.expire(seat); if (old !== seat.fence) await this.persist(); return copy(seat.view); }
  async releaseSeat(id: string): Promise<SeatView> {
    const seat = this.seat(id); if (seat.view.state === 'released') return copy(seat.view);
    this.cancelOwned(seat, 'SEAT_RELEASED', 'Seat was released.'); seat.view.state = 'released'; seat.view.control = null; seat.fence++;
    seat.operations = []; seat.records = []; seat.artifacts = []; seat.view.artifacts = []; seat.view.recorderEnabled = false; seat.view.fault = 'none'; delete seat.view.error; delete seat.delayMs;
    seat.view.document = { name: '', units: 'mm', revision: seat.view.document.revision + 1, shapes: [], modifiedAt: now() };
    for (const [token, ticket] of this.tickets) if (ticket.seatId === id) this.tickets.delete(token);
    this.touch(seat); await this.persist(); this.emit(id, 'seat', seat.view); for (const response of this.streams.get(id) ?? []) response.end(); return copy(seat.view);
  }
  async purgeSeat(id: string): Promise<{ deleted: true }> {
    const seat = this.store.seats.find(row => row.view.id === id);
    if (seat) {
      this.cancelOwned(seat, 'SEAT_DELETED', 'Seat was permanently deleted.');
      seat.view.state = 'released'; seat.view.control = null; seat.fence++;
      seat.operations = []; seat.records = []; seat.artifacts = []; seat.view.artifacts = [];
      seat.view.document = { name: '', units: 'mm', revision: 0, shapes: [], modifiedAt: now() };
      this.store.seats = this.store.seats.filter(row => row !== seat);
    }
    const requests = Object.entries(this.store.requests).filter(([, value]) => value.seatId !== id);
    const changed = !!seat || requests.length !== Object.keys(this.store.requests).length;
    this.store.requests = Object.fromEntries(requests);
    for (const [token, ticket] of this.tickets) if (ticket.seatId === id) this.tickets.delete(token);
    if (changed) await this.persist();
    this.emit(id, 'deleted', { deleted: true });
    for (const response of this.streams.get(id) ?? []) response.end(); this.streams.delete(id);
    return { deleted: true };
  }
  connection(id: string): PlatformConnection {
    this.seat(id, true); const credential = secret(), expires = Date.now() + 60_000;
    for (const [token, value] of this.tickets) if (value.expires <= Date.now()) this.tickets.delete(token);
    if (this.tickets.size >= 1000) failure(429, 'CONNECTION_LIMIT', 'Too many active connection tickets.', true);
    this.tickets.set(credential, { seatId: id, expires });
    return { seatId: id, protocol: 'sse', display: 'mock-scene', eventsPath: `/v1/seats/${id}/events`, expiresAt: new Date(expires).toISOString(), credential, capabilities: image(this.seat(id).view.softwareId).capabilities.map(row => row.id) };
  }
  stream(id: string, credential: string | null, response: ServerResponse): void {
    const seat = this.seat(id, true); if (credential !== null) { const ticket = this.tickets.get(credential); if (!ticket || ticket.seatId !== id || ticket.expires <= Date.now()) failure(401, 'CONNECTION_EXPIRED', 'Connection credential expired or invalid.'); }
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff' });
    const streams = this.streams.get(id) ?? new Set(); this.streams.set(id, streams); streams.add(response);
    response.write(`event: seat\ndata: ${JSON.stringify(seat.view)}\n\n`);
    const heartbeat = setInterval(() => { if (!response.destroyed) response.write(': heartbeat\n\n'); }, 15_000); heartbeat.unref();
    response.on('close', () => { clearInterval(heartbeat); streams.delete(response); if (!streams.size) this.streams.delete(id); });
  }
  async acquire(id: string, input: unknown): Promise<ControlLease> {
    const seat = this.seat(id, true), data = fields(input, ['actor', 'ownerId', 'ttlMs', 'takeover']);
    if (data.actor !== 'human' && data.actor !== 'agent') failure(400, 'INVALID_REQUEST', 'Invalid control actor.');
    const ownerId = text(data.ownerId, 'ownerId', 100), ttl = data.ttlMs === undefined ? 30_000 : integer(data.ttlMs, 'ttlMs', 10, 600_000);
    if (data.takeover !== undefined && typeof data.takeover !== 'boolean') failure(400, 'INVALID_REQUEST', 'Invalid takeover flag.');
    this.expire(seat);
    if (seat.view.control && (seat.view.control.ownerId !== ownerId || seat.view.control.actor !== data.actor) && !data.takeover) failure(409, 'CONTROL_BUSY', 'Another actor currently controls this Seat.', true);
    // Every grant/renewal fences older operations, including the same owner's old token.
    this.cancelOwned(seat, 'CONTROL_CHANGED', 'Control was transferred or renewed.');
    const lease: ControlLease = { actor: data.actor, ownerId, revision: ++seat.fence, token: secret(), expiresAt: new Date(Date.now() + ttl).toISOString() };
    seat.view.control = lease; this.touch(seat); this.record(seat, 'control.acquired', undefined, lease); await this.persist(); this.emit(id, 'seat', seat.view); return copy(lease);
  }
  async relinquish(id: string, input: unknown) {
    const seat = this.seat(id, true), data = fields(input, ['token']), lease = this.control(seat, data.token);
    this.cancelOwned(seat, 'CONTROL_RELEASED', 'Control was released.'); seat.view.control = null; seat.fence++; this.touch(seat); this.record(seat, 'control.released', undefined, lease);
    await this.persist(); this.emit(id, 'seat', seat.view); return { released: true };
  }
  private parameters(capability: string, value: unknown, selected: SoftwareDescriptor): Record<string, unknown> {
    let data: Record<string, unknown>;
    if (capability === 'document.inspect' || capability === 'analysis.run') return fields(value, []);
    if (capability === 'analysis.configure') {
      data = fields(value, ['type', 'loadN', 'elasticModulusMPa', 'meshSizeMm']);
      if (data.type !== 'static' && data.type !== 'modal') failure(400, 'INVALID_REQUEST', 'Analysis type must be static or modal.');
      return { type: data.type, loadN: numeric(data.loadN, 'loadN', 0, 1_000_000_000), elasticModulusMPa: numeric(data.elasticModulusMPa, 'elasticModulusMPa', 0.001, 1_000_000_000), meshSizeMm: numeric(data.meshSizeMm, 'meshSizeMm', 0.001, 10_000) };
    }
    if (capability === 'document.rename') { data = fields(value, ['name']); return { name: text(data.name, 'name', 200) }; }
    if (capability === 'document.export') {
      data = fields(value, ['format', 'name']); if (data.format !== 'json' && data.format !== 'svg') failure(400, 'INVALID_REQUEST', 'Export format must be json or svg.');
      if (selected.workbench === 'simulation' && data.format !== 'json') failure(400, 'INVALID_REQUEST', 'Simulation profile supports JSON export only.');
      const name = data.name === undefined ? `mock-document.${data.format}` : text(data.name, 'name', 120);
      if (/[\\/]/u.test(name) || name === '.' || name === '..') failure(400, 'INVALID_REQUEST', 'Artifact name must be a file name.');
      return { format: data.format, name };
    }
    if (capability === 'shape.delete') { data = fields(value, ['id']); return { id: text(data.id, 'id', 100) }; }
    data = fields(value, capability === 'shape.add' ? ['kind', 'x', 'y', 'width', 'height', 'label'] : ['id', 'kind', 'x', 'y', 'width', 'height', 'label']);
    const result: Record<string, unknown> = {};
    if (capability === 'shape.update') result.id = text(data.id, 'id', 100);
    if (capability === 'shape.add' || data.kind !== undefined) { if (data.kind !== 'rectangle' && data.kind !== 'circle') failure(400, 'INVALID_REQUEST', 'Shape must be rectangle or circle.'); result.kind = data.kind; }
    for (const field of ['x', 'y', 'width', 'height']) if (capability === 'shape.add' || data[field] !== undefined) result[field] = numeric(data[field], field, field === 'width' || field === 'height' ? 0.01 : -10_000, 10_000);
    if (data.label !== undefined) { if (typeof data.label !== 'string' || data.label.length > 200 || /[\u0000-\u001f]/u.test(data.label)) failure(400, 'INVALID_REQUEST', 'Invalid label.'); result.label = data.label; }
    else if (capability === 'shape.add') result.label = '';
    if (capability === 'shape.update' && Object.keys(result).length === 1) failure(400, 'INVALID_REQUEST', 'Shape update requires a changed field.');
    return result;
  }
  async invoke(id: string, input: unknown): Promise<BridgeOperation> {
    const seat = this.seat(id, true), data = fields(input, ['requestId', 'capability', 'parameters', 'controlToken', 'expectedDocumentRevision']);
    const requestId = text(data.requestId, 'requestId', 100), capability = text(data.capability, 'capability', 100);
    const selected = image(seat.view.softwareId);
    if (!selected.capabilities.some(row => row.id === capability)) failure(400, 'CAPABILITY_NOT_SUPPORTED', 'Capability is not available for the selected Mock image.');
    const parameters = this.parameters(capability, data.parameters, selected);
    const expectedDocumentRevision = data.expectedDocumentRevision === undefined ? undefined : integer(data.expectedDocumentRevision, 'expectedDocumentRevision', 0, Number.MAX_SAFE_INTEGER);
    const request = { requestId, capability, parameters, ...(expectedDocumentRevision === undefined ? {} : { expectedDocumentRevision }) }, hash = fingerprint(request);
    const previous = seat.operations.find(row => row.view.requestId === requestId);
    if (previous) { if (previous.fingerprint !== hash) failure(409, 'REQUEST_ID_CONFLICT', 'Operation request ID was already used for different data.'); return copy(previous.view); }
    const lease = this.control(seat, data.controlToken);
    if (expectedDocumentRevision !== undefined && expectedDocumentRevision !== seat.view.document.revision) failure(409, 'DOCUMENT_REVISION_CONFLICT', 'Document revision has changed.');
    if (seat.operations.length >= 2000) failure(429, 'OPERATION_LIMIT', 'Mock operation history limit reached.');
    const stamp = now(), operation: StoredOperation = { view: { id: `op-${randomUUID()}`, seatId: id, requestId, capability, state: 'queued', progress: 0, createdAt: stamp, updatedAt: stamp }, fingerprint: hash, request, fence: lease.revision };
    seat.operations.push(operation); this.touch(seat); this.record(seat, 'operation.queued', operation.view.id, lease); await this.persist(); this.emit(id, 'operation', operation.view);
    this.schedule(() => this.startOperation(seat, operation), 5); return copy(operation.view);
  }
  private async startOperation(seat: StoredSeat, operation: StoredOperation): Promise<void> {
    if (operation.view.state !== 'queued' || seat.view.state !== 'ready') return;
    operation.view.state = 'running'; operation.view.progress = 0.15; operation.view.updatedAt = now(); this.record(seat, 'operation.running', operation.view.id, seat.view.control ?? undefined);
    await this.persist(); this.emit(seat.view.id, 'operation', operation.view);
    const delay = seat.delayMs ?? this.options.operationDelayMs;
    this.schedule(async () => { if (operation.view.state !== 'running') return; operation.view.progress = 0.65; operation.view.updatedAt = now(); await this.persist(); this.emit(seat.view.id, 'operation', operation.view); }, Math.max(1, Math.floor(delay / 2)));
    this.schedule(() => this.finishOperation(seat, operation), Math.max(2, delay));
  }
  private async finishOperation(seat: StoredSeat, operation: StoredOperation): Promise<void> {
    if (operation.view.state !== 'running') return;
    this.expire(seat); if (operation.view.state !== 'running') { await this.persist(); this.emit(seat.view.id, 'seat', seat.view); return; }
    try {
      if (seat.view.state !== 'ready' || !seat.view.control || seat.view.control.revision !== operation.fence) failure(409, 'CONTROL_CHANGED', 'Operation lost its control lease.');
      if (operation.request.expectedDocumentRevision !== undefined && operation.request.expectedDocumentRevision !== seat.view.document.revision) failure(409, 'DOCUMENT_REVISION_CONFLICT', 'Document changed while the operation was running.');
      if (seat.view.fault === 'unknown') { operation.view.state = 'unknown'; operation.view.error = { code: 'OPERATION_RESULT_UNKNOWN', message: 'Injected unknown Mock operation result; inspect before retrying.', retryable: false }; }
      else if (seat.view.fault === 'timeout') failure(504, 'OPERATION_TIMEOUT', 'Injected Mock operation timeout.', true);
      else if (seat.view.fault === 'resource-exhausted') failure(503, 'RESOURCE_EXHAUSTED', 'Injected Mock resource exhaustion.', true);
      else if (seat.view.fault === 'operation-failed') failure(500, 'OPERATION_FAILED', 'Injected Mock operation failure.', true);
      else { operation.view.result = this.execute(seat, operation.request); operation.view.state = 'succeeded'; operation.view.progress = 1; }
    } catch (error) { operation.view.state = 'failed'; operation.view.error = error instanceof ApiError ? error.detail : { code: 'OPERATION_FAILED', message: 'Mock operation failed.', retryable: false }; }
    operation.view.updatedAt = now(); this.touch(seat); this.record(seat, `operation.${operation.view.state}`, operation.view.id, seat.view.control ?? undefined); await this.persist(); this.emit(seat.view.id, 'operation', operation.view); this.emit(seat.view.id, 'seat', seat.view);
  }
  private execute(seat: StoredSeat, request: Omit<BridgeRequest, 'controlToken'>): Record<string, unknown> {
    const document = seat.view.document, parameters = request.parameters;
    if (request.capability === 'document.inspect') return { document: copy(document), documentRevision: document.revision };
    if (request.capability === 'document.export') {
      if (seat.artifacts.length >= 50) failure(429, 'ARTIFACT_LIMIT', 'Mock artifact limit reached.');
      const content = parameters.format === 'svg' ? svg(document, image(seat.view.softwareId).name) : JSON.stringify({ mock: true, document }, null, 2);
      if (Buffer.byteLength(content) > maximumContent) failure(413, 'ARTIFACT_TOO_LARGE', 'Artifact exceeds 256 KiB.');
      const artifact: ArtifactContent = { id: `a-${randomUUID()}`, name: String(parameters.name), mediaType: parameters.format === 'svg' ? 'image/svg+xml' : 'application/json', bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex'), createdAt: now(), documentRevision: document.revision, content };
      seat.artifacts.push(artifact); const { content: _content, ...metadata } = artifact; seat.view.artifacts.push(metadata);
      return { artifactId: artifact.id, documentRevision: document.revision };
    }
    let shapeId: string | undefined;
    if (request.capability === 'document.rename') document.name = String(parameters.name);
    else if (request.capability === 'analysis.configure') document.analysis = { ...parameters } as unknown as MockAnalysis;
    else if (request.capability === 'analysis.run') {
      if (!document.analysis) failure(409, 'ANALYSIS_NOT_CONFIGURED', 'Configure the Mock analysis before running it.');
      const analysis = document.analysis;
      // Deliberately synthetic arithmetic for exercising Bridge workflows.
      // These values are not a finite-element solve or engineering evidence.
      const factor = analysis.type === 'modal' ? 0.5 : 1;
      analysis.result = { mock: true, executedAt: now(), maxDisplacementMm: Number((analysis.loadN / analysis.elasticModulusMPa * 10 * factor).toFixed(6)), maxStressMPa: Number((analysis.loadN / 100 * factor).toFixed(6)) };
    }
    else if (request.capability === 'shape.add') {
      if (document.shapes.length >= 200) failure(429, 'SHAPE_LIMIT', 'Mock document shape limit reached.');
      const shape = { ...parameters, id: `shape-${randomUUID()}` } as unknown as MockShape; document.shapes.push(shape); shapeId = shape.id;
    } else {
      const shape = document.shapes.find(row => row.id === parameters.id); if (!shape) failure(404, 'SHAPE_NOT_FOUND', 'Shape does not exist.');
      shapeId = shape.id;
      if (request.capability === 'shape.delete') document.shapes = document.shapes.filter(row => row.id !== shape.id);
      else { const { id: _id, ...changes } = parameters; Object.assign(shape, changes); }
    }
    document.revision++; document.modifiedAt = now(); return { ...(shapeId ? { shapeId } : {}), ...(request.capability.startsWith('analysis.') ? { mock: true, analysis: copy(document.analysis) } : {}), documentRevision: document.revision, document: copy(document) };
  }
  operations(id: string): BridgeOperationIndex {
    const seat = this.seat(id);
    return { operations: seat.operations.slice(-100).reverse().map(row => {
      const operation = copy(row.view);
      // The Seat already supplies the current document. History is a bounded
      // summary; a caller can fetch one operation to inspect its exact result.
      if (operation.result) { const { document: _document, ...summary } = operation.result; operation.result = summary; }
      return operation;
    }), unknownOperationIds: seat.operations.filter(row => row.view.state === 'unknown').map(row => row.view.id).sort(), unknownOperationIdsComplete: true };
  }
  operationRequest(id: string, requestId: string): { operation: BridgeOperation | null } {
    const requested = text(requestId, 'requestId', 100);
    const operation = this.seat(id).operations.find(row => row.view.requestId === requested);
    return { operation: operation ? copy(operation.view) : null };
  }
  operation(id: string, operationId: string): BridgeOperation { const operation = this.seat(id).operations.find(row => row.view.id === operationId); if (!operation) failure(404, 'OPERATION_NOT_FOUND', 'Operation does not exist.'); return copy(operation.view); }
  async cancel(id: string, operationId: string): Promise<BridgeOperation> {
    const seat = this.seat(id, true), operation = seat.operations.find(row => row.view.id === operationId); if (!operation) failure(404, 'OPERATION_NOT_FOUND', 'Operation does not exist.');
    if (!terminal.has(operation.view.state)) { operation.view.state = 'canceled'; operation.view.updatedAt = now(); this.touch(seat); this.record(seat, 'operation.canceled', operationId, seat.view.control ?? undefined); await this.persist(); this.emit(id, 'operation', operation.view); }
    return copy(operation.view);
  }
  artifact(id: string, artifactId: string): ArtifactContent { const seat = this.seat(id, true), artifact = seat.artifacts.find(row => row.id === artifactId); if (!artifact) failure(404, 'ARTIFACT_NOT_FOUND', 'Artifact does not exist.'); return copy(artifact); }
  async recorder(id: string, input: unknown): Promise<SeatView> {
    const seat = this.seat(id, true), data = fields(input, ['enabled']); if (typeof data.enabled !== 'boolean') failure(400, 'INVALID_REQUEST', 'Recorder enabled must be boolean.');
    seat.view.recorderEnabled = data.enabled; this.touch(seat); this.record(seat, 'recorder.enabled'); await this.persist(); this.emit(id, 'seat', seat.view); return copy(seat.view);
  }
  records(id: string) { return { records: copy(this.seat(id).records) }; }
  async fault(id: string, input: unknown): Promise<SeatView> {
    const seat = this.seat(id), data = fields(input, ['mode', 'delayMs']); if (seat.view.state === 'released') failure(409, 'SEAT_RELEASED', 'Released Seat cannot be modified.');
    if (!faults.has(data.mode as MockFault)) failure(400, 'INVALID_REQUEST', 'Unknown Mock fault mode.');
    seat.view.fault = data.mode as MockFault; if (data.delayMs !== undefined) seat.delayMs = integer(data.delayMs, 'delayMs', 0, 60_000); else delete seat.delayMs;
    this.touch(seat); await this.persist(); this.emit(id, 'seat', seat.view); return copy(seat.view);
  }
  async close(): Promise<void> {
    this.closing = true; for (const timer of this.timers) clearTimeout(timer); this.timers.clear();
    for (const streams of this.streams.values()) for (const response of streams) response.end(); this.streams.clear(); this.tickets.clear();
    await this.queue.catch(() => {});
    if (!this.unavailable) {
      for (const seat of this.store.seats) { seat.view.control = null; seat.fence++; for (const operation of seat.operations) if (!terminal.has(operation.view.state)) { operation.view.state = 'unknown'; operation.view.updatedAt = now(); operation.view.error = { code: 'OPERATION_RESULT_UNKNOWN', message: 'Platform stopped during this operation; inspect before retrying.', retryable: false }; } }
      await this.persist();
    }
  }
}

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) { request.resume(); failure(415, 'INVALID_CONTENT_TYPE', 'application/json is required.'); }
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > 128 * 1024) { request.resume(); failure(413, 'REQUEST_TOO_LARGE', 'Request exceeds 128 KiB.'); }
  const body = await new Promise<Buffer>((resolveBody, rejectBody) => {
    const chunks: Buffer[] = []; let bytes = 0;
    const cleanup = () => { request.off('data', onData); request.off('end', onEnd); request.off('error', onError); request.off('aborted', onAborted); };
    const onError = () => { cleanup(); rejectBody(new ApiError(400, 'INVALID_REQUEST', 'Request body could not be read.')); };
    const onAborted = () => { cleanup(); rejectBody(new ApiError(400, 'INVALID_REQUEST', 'Request body was aborted.')); };
    const onEnd = () => { cleanup(); resolveBody(Buffer.concat(chunks)); };
    const onData = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 128 * 1024) { cleanup(); request.resume(); rejectBody(new ApiError(413, 'REQUEST_TOO_LARGE', 'Request exceeds 128 KiB.')); }
      else chunks.push(chunk);
    };
    request.on('data', onData); request.once('end', onEnd); request.once('error', onError); request.once('aborted', onAborted);
  });
  try { return JSON.parse(body.toString('utf8')); } catch { failure(400, 'INVALID_JSON', 'Request contains invalid JSON.'); }
}
function responseJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(JSON.stringify(value));
}
/** Independent authenticated Mock platform. No host shell, user paths, or real industrial software. */
export function createMockSeatServer(options: MockSeatOptions): MockSeatServer {
  const runtime = new Runtime(options);
  const server = createServer((request, response) => {
    void (async () => {
      if (!runtime.authorized(request)) failure(401, 'UNAUTHORIZED', 'Bearer service authentication required.');
      const url = new URL(request.url ?? '/', 'http://mock-seat.local'), method = request.method ?? 'GET';
      if (url.pathname === '/v1/images' && method === 'GET') return responseJson(response, 200, await runtime.run(() => runtime.listImages()));
      if (url.pathname === '/v1/software' && method === 'GET') return responseJson(response, 200, await runtime.run(() => runtime.listSoftware()));
      if (url.pathname === '/v1/seats' && method === 'POST') { const body = await jsonBody(request); return responseJson(response, 201, await runtime.run(() => runtime.createSeat(body))); }
      const match = /^\/v1\/seats\/([^/]+)(?:\/(.*))?$/u.exec(url.pathname);
      if (!match) failure(404, 'ROUTE_NOT_FOUND', 'Platform route does not exist.');
      let id: string;
      try { id = decodeURIComponent(match[1]); } catch { failure(400, 'INVALID_REQUEST', 'Invalid Seat ID.'); }
      const suffix = match[2] ?? '';
      const body = ['POST', 'DELETE'].includes(method) && suffix.length > 0 ? await jsonBody(request) : undefined;
      const result = await runtime.run(async () => {
        if (!suffix && method === 'GET') return runtime.getSeat(id);
        if (!suffix && method === 'DELETE') {
          const purge = url.searchParams.get('purge');
          if (purge !== null && purge !== 'true' && purge !== 'false') failure(400, 'INVALID_REQUEST', 'Invalid purge flag.');
          return purge === 'true' ? runtime.purgeSeat(id) : runtime.releaseSeat(id);
        }
        if (suffix === 'connection' && method === 'GET') return runtime.connection(id);
        if (suffix === 'events' && method === 'GET') { runtime.stream(id, url.searchParams.get('credential'), response); return undefined; }
        if (suffix === 'control' && method === 'POST') return runtime.acquire(id, body);
        if (suffix === 'control' && method === 'DELETE') return runtime.relinquish(id, body);
        if (suffix === 'operations' && method === 'POST') return runtime.invoke(id, body);
        if (suffix === 'operations' && method === 'GET') return runtime.operations(id);
        const requested = /^operations\/request\/([^/]+)$/u.exec(suffix);
        if (requested && method === 'GET') {
          let requestId: string;
          try { requestId = decodeURIComponent(requested[1]); } catch { failure(400, 'INVALID_REQUEST', 'Invalid operation request ID.'); }
          return runtime.operationRequest(id, requestId);
        }
        const operation = /^operations\/([^/]+)(\/cancel)?$/u.exec(suffix);
        if (operation && !operation[2] && method === 'GET') return runtime.operation(id, operation[1]);
        if (operation?.[2] && method === 'POST') { fields(body, []); return runtime.cancel(id, operation[1]); }
        const artifact = /^artifacts\/([^/]+)$/u.exec(suffix); if (artifact && method === 'GET') return runtime.artifact(id, artifact[1]);
        if (suffix === 'recorder' && method === 'POST') return runtime.recorder(id, body);
        if (suffix === 'records' && method === 'GET') return runtime.records(id);
        if (suffix === 'fault' && method === 'POST') return runtime.fault(id, body);
        failure(404, 'ROUTE_NOT_FOUND', 'Platform route does not exist.');
      });
      if (!response.headersSent) responseJson(response, method === 'POST' && suffix === 'operations' ? 202 : 200, result);
    })().catch(error => {
      if (response.headersSent) { response.end(); return; }
      const detail = error instanceof ApiError ? error.detail : { code: 'PLATFORM_ERROR', message: 'Mock platform request failed.', retryable: false };
      responseJson(response, error instanceof ApiError ? error.status : 500, { error: detail });
    });
  }) as MockSeatServer;
  server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  server.ready = runtime.ready;
  const originalClose = server.close.bind(server); let closing: Promise<void> | undefined;
  server.close = ((callback?: (error?: Error) => void) => {
    closing ??= runtime.close();
    originalClose(error => { void closing!.then(() => callback?.(error), failure => callback?.(failure instanceof Error ? failure : new Error('Mock cleanup failed.'))); });
    return server;
  }) as typeof server.close;
  return server;
}
