import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { mkdir, readFile, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type {} from './index.ts';
import { loadPromptFile } from './prompt-loader.ts';
import type {} from './domain.ts';
import type { WorkspaceLease } from './workspace.ts';
import type { ArtifactContent, BridgeOperation, BridgeOperationIndex, BridgeRequest, ControlActor, ControlLease, SeatView, SoftwareBackend, SoftwareDescriptor, StudioSeatView } from './seat-types.ts';
import { seatOrigin } from './seat-origin.ts';
import { applyVmSeats } from './vm-seat.ts';
import { applyNoSoftware } from './no-software.ts';
import { registerProjectExport } from './project-export.ts';
import { abortError, throwIfAborted } from './abort.ts';

export const name = 'harnessstudio-software-seat';
export const inject = ['studio', 'studioDomain', 'tools', 'connection'];
/** backend selects the software platform; 'mock' keeps the v1 Mock contract below, 'vm-manager' uses vm-seat.ts and 'none'
 * no-software.ts (no software at all). noSoftwarePromptPath defaults to software-none-system-prompt.md beside promptPath, because
 * deployment patches restate this plugin's whole config. */
export interface Config { dataRoot: string; endpoint: string; token: string; promptPath: string; timeoutMs: number; trustedHttpOrigins: string[]; backend: SoftwareBackend; vmEndpoint: string; vmTrustedHttpOrigins: string[]; vmPromptPath: string; vmStopTimeoutMs: number; vmRunMinutes: number; noSoftwarePromptPath: string }
export const Config: z<Config> = z.object({ dataRoot: z.string().required(), endpoint: z.string().default(''), token: z.string().default(''), promptPath: z.string().required(), timeoutMs: z.natural().min(100).default(10000), trustedHttpOrigins: z.array(String).default([]),
  backend: z.union(['none', 'mock', 'vm-manager']).default('mock'), vmEndpoint: z.string().default(''), vmTrustedHttpOrigins: z.array(String).default([]), vmPromptPath: z.string().default(''), vmStopTimeoutMs: z.natural().min(1000).default(200000),
  vmRunMinutes: z.natural().min(1).max(10080).default(120), noSoftwarePromptPath: z.string().default('') });
interface SeatBinding { taskId: string; projectId: string; softwareId: string; createRequestId: string; seatId?: string; retired?: true; imports: Record<string, { path: string; version: string }>;
  unknownAcknowledgement?: { seatId: string; dataGeneration: number; operationIds: string[] } }
interface Actor { actor: ControlActor; ownerId: string; lease?: WorkspaceLease; signal?: AbortSignal }
interface AgentControl { token: string; ownerId: string; revoke(): Promise<unknown>; detach(): void }
const human: Actor = { actor: 'human', ownerId: 'operator' };
const terminal = new Set(['succeeded', 'failed', 'canceled', 'unknown']);
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object'); return value as Record<string, unknown>; }
function text(value: unknown, label: string): string { if (typeof value !== 'string' || !value || value.length > 200) throw new Error(`Invalid ${label}`); return value; }
function imageId(value: unknown): string | undefined { if (value === undefined || value === null) return; const id = text(value, 'imageId'); if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(id)) throw new Error('Invalid imageId'); return id === 'mock-cad' ? 'mock-solidworks' : id; }
function bindingKey(taskId: string, id: string) { return `${taskId}::${id}`; }
function savedKey(binding: SeatBinding) { return bindingKey(binding.taskId, binding.softwareId) + (binding.retired ? `::released::${binding.seatId}` : ''); }
function selectedImage(data: Record<string, unknown>): string | undefined { const id = imageId(data.imageId), legacy = imageId(data.softwareId); if (id && legacy && id !== legacy) throw new Error('imageId和softwareId不一致'); return id ?? legacy; }
function requestId(value: unknown): string { const id = text(value, 'requestId'); if (!/^[a-zA-Z0-9:_-]{1,100}$/.test(id)) throw new Error('Invalid requestId'); return id; }

/** The only component which knows the external platform credential and Seat IDs. */
export class StudioSeats {
  private readonly bindings = new Map<string, SeatBinding>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly agentControls = new Map<string, AgentControl>();
  private persistence: Promise<unknown> = Promise.resolve();
  private endpoint = '';
  private closing = false;
  constructor(private readonly ctx: Context, private readonly config: Config) {
    this.endpoint = seatOrigin(config.endpoint, config.trustedHttpOrigins);
  }
  async initialize() {
    await mkdir(this.config.dataRoot, { recursive: true, mode: 0o700 });
    try {
      const values: unknown = JSON.parse(await readFile(join(this.config.dataRoot, 'seats.json'), 'utf8'));
      if (!Array.isArray(values)) throw new Error('Invalid Seat bindings');
      for (const raw of values) {
        const row = object(raw);
        const binding: SeatBinding = { taskId: text(row.taskId, 'task'), projectId: text(row.projectId, 'project'), softwareId: imageId(text(row.softwareId, 'software'))!, createRequestId: requestId(row.createRequestId), imports: object(row.imports ?? {}) as SeatBinding['imports'], ...(row.retired === true ? { retired: true } : {}), ...(row.seatId ? { seatId: text(row.seatId, 'seat') } : {}) };
        if (row.unknownAcknowledgement !== undefined) {
          const ack = object(row.unknownAcknowledgement);
          if (typeof ack.dataGeneration !== 'number' || !Number.isSafeInteger(ack.dataGeneration) || ack.dataGeneration < 0 || !Array.isArray(ack.operationIds) || ack.operationIds.length > 10000 || ack.operationIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9:_-]{1,200}$/.test(id)) || new Set(ack.operationIds).size !== ack.operationIds.length) throw new Error('Invalid unknown-operation acknowledgement');
          binding.unknownAcknowledgement = { seatId: text(ack.seatId, 'acknowledged seat'), dataGeneration: ack.dataGeneration, operationIds: ack.operationIds as string[] };
        }
        if (binding.retired && !binding.seatId) throw new Error('Invalid retired Seat reference');
        const key = savedKey(binding); if (this.bindings.has(key)) throw new Error('Duplicate task image binding'); this.bindings.set(key, binding);
      }
    } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    // Reconciliation uses the remote control fence, never a stale local token.
    // Offline platforms do not prevent project/chat startup; every new control claim contacts the platform.
    for (const binding of this.bindings.values()) {
      try {
        let task; try { task = this.ctx.studioDomain.task(binding.taskId); } catch { /* deleted during a crash */ }
        if (!task) await this.erase(binding, true);
        else if (binding.seatId) await this.stopProducer(binding);
      } catch { /* fail closed: this process has no control token; new claims must contact platform */ }
    }
    await this.save();
  }
  private save(): Promise<void> {
    const operation = this.persistence.catch(() => undefined).then(async () => {
      const path = join(this.config.dataRoot, 'seats.json'), temporary = `${path}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify([...this.bindings.values()]) + '\n'); await file.sync(); } finally { await file.close(); }
        await rename(temporary, path);
        const directory = await open(this.config.dataRoot, 'r'); try { await directory.sync(); } finally { await directory.close(); }
      } finally { await rm(temporary, { force: true }); }
    });
    this.persistence = operation; return operation;
  }
  private serial<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(taskId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation); this.queues.set(taskId, next);
    void next.finally(() => { if (this.queues.get(taskId) === next) this.queues.delete(taskId); }).catch(() => {}); return next;
  }
  private async call<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
    if (!this.endpoint || !this.config.token) throw new Error('软件平台未配置，请设置 STUDIO_SEAT_URL 和 STUDIO_SEAT_TOKEN');
    const cancellation = signal ? AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]) : AbortSignal.timeout(this.config.timeoutMs);
    let response: Response;
    try { response = await fetch(this.endpoint + path, { method, headers: { authorization: `Bearer ${this.config.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: cancellation, redirect: 'error' }); }
    catch { throwIfAborted(signal); throw new Error('软件平台暂时不可达或请求超时；请重试原请求，勿重复创建操作'); }
    const reader = response.body?.getReader(); const parts: Uint8Array[] = []; let bytes = 0;
    if (reader) try { while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > 2 * 1024 * 1024) throw new Error('软件平台响应超过限制'); parts.push(part.value); } } finally { await reader.cancel().catch(() => {}); }
    const value = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (!response.ok) { const error = value?.error; throw new Error(`软件平台 ${typeof error?.code === 'string' ? error.code : response.status}: ${typeof error?.message === 'string' ? error.message : '请求失败'}`); }
    return value as T;
  }
  async catalog() { const { images } = await this.call<{ images: SoftwareDescriptor[] }>('/v1/images'); return { images, software: images }; }
  private taskBindings(taskId: string, includeRetired = false): SeatBinding[] {
    const task = this.ctx.studioDomain.task(taskId), values = [...this.bindings.values()].filter(binding => binding.taskId === taskId && (includeRetired || !binding.retired));
    if (values.some(binding => binding.projectId !== task.projectId)) throw new Error('Seat owner changed');
    return values;
  }
  private bound(taskId: string, selected?: string): SeatBinding | undefined {
    const values = this.taskBindings(taskId), id = imageId(selected);
    if (id) return values.find(binding => binding.softwareId === id);
    if (values.length > 1) throw new Error('当前任务已启动多个软件，请指定imageId选择镜像');
    return values[0];
  }
  private path(binding: SeatBinding) { if (!binding.seatId) throw new Error('Seat正在创建，请重新连接'); return `/v1/seats/${encodeURIComponent(binding.seatId)}`; }
  private async remote(binding: SeatBinding): Promise<SeatView> {
    const seat = await this.call<SeatView>(this.path(binding));
    if (seat.apiVersion !== '1' || seat.id !== binding.seatId || seat.taskId !== binding.taskId || seat.projectId !== binding.projectId || imageId(seat.softwareId) !== binding.softwareId) throw new Error('软件平台返回的Seat所属任务不匹配');
    return seat;
  }
  private guard(taskId: string, actor: Actor) {
    throwIfAborted(actor.signal);
    if (this.closing) throw new Error('软件连接正在停止');
    this.ctx.studioDomain.assertWorking(taskId);
    if (actor.lease && (actor.lease.taskId !== taskId || this.ctx.studio.files.readLease(taskId).generation !== actor.lease.generation)) throw new Error('任务软件写权限已撤销');
  }
  private work<T>(taskId: string, actor: Actor, operation: () => Promise<T>): Promise<T> {
    throwIfAborted(actor.signal);
    return this.ctx.studioDomain.work(taskId, () => this.serial(taskId, async () => { this.guard(taskId, actor); return operation(); }), actor.signal);
  }
  private async view(binding: SeatBinding, supplied?: SeatView): Promise<StudioSeatView> {
    const seat = supplied ?? await this.remote(binding);
    const [catalog, operations] = await Promise.all([this.catalog(), this.call<BridgeOperationIndex>(this.path(binding) + '/operations')]);
    const software = catalog.software.find(item => item.id === binding.softwareId); if (!software) throw new Error('软件能力目录不存在');
    const { control, ...safe } = seat;
    return { ...safe, control: control ? { actor: control.actor, ownerId: control.ownerId, revision: control.revision, expiresAt: control.expiresAt } : null,
      software, operations: operations.operations, unacknowledgedUnknownIds: this.unacknowledgedUnknown(binding, operations), unknownOperationIndexComplete: this.completeUnknownIndex(operations), canEdit: this.ctx.studioDomain.view(binding.taskId).writable,
      connection: { protocol: 'sse', display: 'mock-scene', eventsPath: `/api/studio/software/events?taskId=${encodeURIComponent(binding.taskId)}&imageId=${encodeURIComponent(binding.softwareId)}` } };
  }
  private completeUnknownIndex(index: BridgeOperationIndex): boolean {
    const ids = index.unknownOperationIds;
    return index.unknownOperationIdsComplete === true && Array.isArray(ids) && ids.length <= 10000
      && ids.every(id => typeof id === 'string' && /^[a-zA-Z0-9:_-]{1,200}$/.test(id)) && new Set(ids).size === ids.length
      && Array.isArray(index.operations) && index.operations.every(operation => operation.state !== 'unknown' || ids.includes(operation.id));
  }
  private unacknowledgedUnknown(binding: SeatBinding, index: BridgeOperationIndex): string[] {
    if (!Array.isArray(index.operations) || index.operations.some(operation => operation.seatId !== binding.seatId)) throw new Error('操作所属Seat不匹配');
    const ack = binding.unknownAcknowledgement;
    const acknowledged = new Set(ack && ack.seatId === binding.seatId && ack.dataGeneration === (this.ctx.studioDomain.task(binding.taskId).dataGeneration ?? 0) ? ack.operationIds : []);
    // An old platform's recent unknowns are useful to display, but an incomplete
    // index is never accepted as permission to issue a new mutation or ACK.
    const ids = this.completeUnknownIndex(index) ? index.unknownOperationIds : index.operations.filter(operation => operation.state === 'unknown').map(operation => operation.id);
    return ids.filter(id => !acknowledged.has(id)).sort();
  }
  /** Human-only acknowledgement records review; it never rewrites unknown history. */
  acknowledgeUnknown(taskId: string, input: unknown, selected?: string) {
    const data = object(input);
    if (Object.keys(data).some(key => !['operationIds', 'expectedDocumentRevision'].includes(key))) throw new Error('未知操作确认参数无效');
    if (typeof data.expectedDocumentRevision !== 'number' || !Number.isSafeInteger(data.expectedDocumentRevision) || data.expectedDocumentRevision < 0) throw new Error('请提供当前文档版本');
    const supplied = data.operationIds;
    if (!Array.isArray(supplied) || !supplied.length || supplied.length > 10000 || supplied.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9:_-]{1,200}$/.test(id)) || new Set(supplied).size !== supplied.length) throw new Error('请提供完整且不重复的未知操作列表');
    return this.work(taskId, human, async () => {
      const binding = this.bound(taskId, selected); if (!binding?.seatId) throw new Error('请先选择镜像并启动软件席位');
      const seat = await this.remote(binding); this.controlFor(seat, human);
      if (seat.document.revision !== data.expectedDocumentRevision) throw new Error('文档已变化，请重新检查未知操作并确认');
      const index = await this.call<BridgeOperationIndex>(this.path(binding) + '/operations');
      if (!this.completeUnknownIndex(index)) throw new Error('OPERATION_HISTORY_INCOMPLETE: 平台未提供完整未知操作集合，不能确认；请更新兼容平台');
      const unknown = this.unacknowledgedUnknown(binding, index);
      if (JSON.stringify([...supplied].sort()) !== JSON.stringify(unknown)) throw new Error('未确认的未知操作已变化，请重新检查完整列表');
      const latest = await this.remote(binding); this.controlFor(latest, human);
      if (latest.document.revision !== data.expectedDocumentRevision) throw new Error('文档已变化，请重新检查未知操作并确认');
      const previous = binding.unknownAcknowledgement;
      const retained = previous?.seatId === binding.seatId && previous.dataGeneration === (this.ctx.studioDomain.task(taskId).dataGeneration ?? 0) ? previous.operationIds : [];
      binding.unknownAcknowledgement = { seatId: binding.seatId, dataGeneration: this.ctx.studioDomain.task(taskId).dataGeneration ?? 0, operationIds: [...new Set([...retained, ...unknown])].sort() };
      try { await this.save(); } catch (error) { binding.unknownAcknowledgement = previous; throw error; }
      return { seat: await this.view(binding, latest) };
    });
  }
  async list(taskId: string): Promise<{ seats: StudioSeatView[] }> {
    const values = await Promise.all(this.taskBindings(taskId).filter(binding => binding.seatId).map(async binding => {
      const seat = await this.remote(binding); return seat.state === 'released' ? null : this.view(binding, seat);
    }));
    return { seats: values.filter((seat): seat is StudioSeatView => seat !== null) };
  }
  async get(taskId: string, selected?: string): Promise<{ seat: StudioSeatView | null; seats: StudioSeatView[] }> {
    if (selected) {
      const binding = this.bound(taskId, selected); if (!binding?.seatId) return { seat: null, seats: [] };
      const seat = await this.remote(binding); if (seat.state === 'released') return { seat: null, seats: [] };
      const view = await this.view(binding, seat); return { seat: view, seats: [view] };
    }
    const { seats } = await this.list(taskId); return { seat: seats.length === 1 ? seats[0]! : null, seats };
  }
  private async ensure(taskId: string, selected: string, id: string): Promise<SeatBinding> {
    const catalog = await this.catalog(), softwareId = imageId(selected);
    if (!softwareId || !catalog.images.some(item => item.id === softwareId)) throw new Error('兼容镜像目录中没有该应用，请先选择有效镜像');
    const key = bindingKey(taskId, softwareId);
    let binding = this.bound(taskId, softwareId);
    if (binding?.seatId && (await this.remote(binding)).state === 'released') { this.retire(binding); binding = undefined; }
    if (!binding) {
      const task = this.ctx.studioDomain.task(taskId);
      binding = { taskId, projectId: task.projectId, softwareId, createRequestId: id, imports: {} }; this.bindings.set(key, binding);
      // Persist allocation before sending. Each task/image pair has its own idempotent request.
      await this.save();
    }
    if (!binding.seatId) {
      const seat = await this.call<SeatView>('/v1/seats', 'POST', { requestId: binding.createRequestId, imageId: softwareId, taskId, projectId: binding.projectId }, undefined);
      if (seat.taskId !== taskId || seat.projectId !== binding.projectId || imageId(seat.softwareId) !== softwareId) throw new Error('Seat创建所属任务或镜像不匹配');
      if (seat.state === 'released') { this.bindings.delete(key); await this.save(); throw new Error('此启动请求对应的席位已释放，请使用新的requestId重新启动'); }
      binding.seatId = seat.id; await this.save();
    }
    return binding;
  }
  create(taskId: string, selected: string, id: string, actor: Actor = human) { return this.work(taskId, actor, async () => { const binding = await this.ensure(taskId, selected, id); throwIfAborted(actor.signal); return { seat: await this.view(binding) }; }); }
  private controlFor(seat: SeatView, actor: Actor): ControlLease {
    const control = seat.control;
    if (!control || Date.parse(control.expiresAt) <= Date.now() || control.actor !== actor.actor || control.ownerId !== actor.ownerId) throw new Error('请先获取软件控制权；人工和Agent不能同时操作');
    return control;
  }
  private forgetControl(seatId: string) { this.agentControls.get(seatId)?.detach(); this.agentControls.delete(seatId); }
  private rememberControl(binding: SeatBinding, control: ControlLease, actor: Actor): AgentControl | undefined {
    this.forgetControl(binding.seatId!);
    if (actor.actor !== 'agent' || !actor.signal) return;
    const signal = actor.signal, path = this.path(binding) + '/control';
    let stopping: Promise<unknown> | undefined;
    const tracked: AgentControl = {
      token: control.token, ownerId: actor.ownerId,
      revoke: () => stopping ??= this.call(path, 'DELETE', { token: control.token }).catch(() => {}).finally(() => {
        tracked.detach(); if (this.agentControls.get(binding.seatId!) === tracked) this.agentControls.delete(binding.seatId!);
      }),
      detach: () => { signal.removeEventListener('abort', onAbort); clearTimeout(expiry); },
    };
    const onAbort = () => { void tracked.revoke(); };
    const expiry = setTimeout(() => { if (this.agentControls.get(binding.seatId!) === tracked) this.forgetControl(binding.seatId!); }, Math.max(0, Date.parse(control.expiresAt) - Date.now())); expiry.unref();
    this.agentControls.set(binding.seatId!, tracked); signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort(); return tracked;
  }
  control(taskId: string, action: string, actor: Actor, takeover = false, selected?: string) {
    if (!['acquire', 'release'].includes(action)) throw new Error('Invalid control action');
    if (takeover && actor.actor !== 'human') throw new Error('Agent不能抢占人工控制权');
    return this.work(taskId, actor, async () => {
      const binding = this.bound(taskId, selected);
      if (!binding?.seatId) throw new Error('请先从兼容镜像目录选择并启动软件');
      let acquired: ControlLease | undefined;
      try {
        if (action === 'acquire') { acquired = await this.call<ControlLease>(this.path(binding) + '/control', 'POST', { actor: actor.actor, ownerId: actor.ownerId, takeover, ttlMs: 300000 }); this.rememberControl(binding, acquired, actor); }
        else { const control = this.controlFor(await this.remote(binding), actor); await this.call(this.path(binding) + '/control', 'DELETE', { token: control.token }); this.forgetControl(binding.seatId!); }
        throwIfAborted(actor.signal);
        const result = { seat: await this.view(binding) }; throwIfAborted(actor.signal); return result;
      } finally {
        // A canceled claim must not leave an Agent holding the software after its tool has stopped.
        if (acquired && actor.signal?.aborted) await this.call(this.path(binding) + '/control', 'DELETE', { token: acquired.token }).catch(() => {});
      }
    });
  }
  invoke(taskId: string, actor: Actor, input: Omit<BridgeRequest, 'controlToken'>, signal?: AbortSignal, selected?: string) {
    signal ??= actor.signal;
    return this.work(taskId, actor, async () => {
      throwIfAborted(signal); const binding = this.bound(taskId, selected); if (!binding?.seatId) throw new Error('请先选择镜像并启动软件席位');
      const seat = await this.remote(binding), control = this.controlFor(seat, actor);
      const [catalog, history] = await Promise.all([this.catalog(), this.call<BridgeOperationIndex>(this.path(binding) + '/operations')]);
      const capability = catalog.software.find(item => item.id === binding.softwareId)?.capabilities.find(item => item.id === input.capability);
      if (!capability) throw new Error('CAPABILITY_NOT_SUPPORTED: 当前软件未提供该 Bridge 能力');
      const unknown = this.unacknowledgedUnknown(binding, history);
      // A same-ID POST is the platform's fingerprint-checked receipt lookup,
      // not a new command. It cannot be turned into a different mutation.
      if (capability.mutates && (!this.completeUnknownIndex(history) || unknown.length)) {
        // Exact request lookup uses full platform history, independently of its
        // bounded display window. Only a real old receipt can bypass this fence.
        const receipt = await this.call<{ operation: BridgeOperation | null }>(this.path(binding) + `/operations/request/${encodeURIComponent(input.requestId)}`);
        if (!receipt || !Object.hasOwn(receipt, 'operation') || receipt.operation !== null && (typeof receipt.operation.id !== 'string' || !/^[a-zA-Z0-9:_-]{1,200}$/.test(receipt.operation.id) || !['queued', 'running', 'succeeded', 'failed', 'canceled', 'unknown'].includes(receipt.operation.state) || receipt.operation.seatId !== binding.seatId || receipt.operation.requestId !== input.requestId)) throw new Error('OPERATION_HISTORY_INCOMPLETE: 平台返回的请求回执不可信，不能修改');
        if (receipt.operation === null) {
          if (!this.completeUnknownIndex(history)) throw new Error('OPERATION_HISTORY_INCOMPLETE: 平台未提供完整未知操作集合，不能修改；请更新兼容平台');
          throw new Error('存在尚未人工确认的未知操作；请先检查当前文档并确认，不能使用新requestId重复修改');
        }
      }
      this.guard(taskId, actor); throwIfAborted(signal);
      if (actor.actor === 'agent') this.rememberControl(binding, control, actor);
      // Revoke the captured fence even if cancellation loses the operation ACK. A later request
      // carrying this token cannot mutate, and a newer human/Agent lease is never revoked.
      let revocation: Promise<unknown> | undefined;
      const revoke = () => { revocation ??= this.call(this.path(binding) + '/control', 'DELETE', { token: control.token }).catch(() => {}); };
      signal?.addEventListener('abort', revoke, { once: true });
      try {
        throwIfAborted(signal);
        const operation = await this.call<BridgeOperation>(this.path(binding) + '/operations', 'POST', { ...input, controlToken: control.token }, signal);
        throwIfAborted(signal); return { operation, imageId: binding.softwareId };
      } finally {
        if (signal?.aborted) { revoke(); await revocation; }
        signal?.removeEventListener('abort', revoke);
      }
    });
  }
  async operation(taskId: string, operationId: string, selected?: string): Promise<{ operation: BridgeOperation }> {
    const binding = this.bound(taskId, selected); if (!binding?.seatId) throw new Error('请先从兼容镜像目录选择并启动软件');
    const operation = await this.call<BridgeOperation>(this.path(binding) + `/operations/${encodeURIComponent(operationId)}`);
    if (operation.seatId !== binding.seatId) throw new Error('操作所属Seat不匹配'); return { operation };
  }
  cancel(taskId: string, operationId: string, actor: Actor, selected?: string) {
    return this.work(taskId, actor, async () => {
      const binding = this.bound(taskId, selected); if (!binding?.seatId) throw new Error('请先从兼容镜像目录选择并启动软件');
      const control = this.controlFor(await this.remote(binding), actor);
      return { operation: await this.call<BridgeOperation>(this.path(binding) + `/operations/${encodeURIComponent(operationId)}/cancel`, 'POST', {}) };
    });
  }
  async wait(taskId: string, operation: BridgeOperation, signal: AbortSignal, actor: Actor, selected: string) {
    const binding = this.bound(taskId, selected); if (!binding?.seatId) throw new Error('软件席位不存在');
    const captured = this.agentControls.get(binding.seatId);
    const deadline = Date.now() + 10000;
    try {
      while (!terminal.has(operation.state) && Date.now() < deadline) { await delay(100, undefined, { signal }); operation = (await this.operation(taskId, operation.id, selected)).operation; }
      return { operation };
    } catch (error) {
      // A disconnected/canceled model must not leave its software mutation running.
      if (binding?.seatId && signal.aborted) {
        // Keep the invocation's old fence; the same conversation may already own a newer grant.
        if (captured?.ownerId === actor.ownerId) await captured.revoke();
        await this.call(this.path(binding) + `/operations/${encodeURIComponent(operation.id)}/cancel`, 'POST', {}).catch(() => {});
      }
      throw error;
    }
  }
  artifact(taskId: string, artifactId: string, actor: Actor, selected?: string) {
    return this.work(taskId, actor, async () => {
      const binding = this.bound(taskId, selected); if (!binding?.seatId) throw new Error('请先从兼容镜像目录选择并启动软件');
      const artifact = await this.call<ArtifactContent>(this.path(binding) + `/artifacts/${encodeURIComponent(artifactId)}`);
      if (artifact.id !== artifactId || typeof artifact.content !== 'string' || Buffer.byteLength(artifact.content) > 262144 || createHash('sha256').update(artifact.content).digest('hex') !== artifact.sha256) throw new Error('软件产物大小或校验和不正确');
      this.guard(taskId, actor);
      const extension = artifact.mediaType === 'image/svg+xml' ? 'svg' : artifact.mediaType === 'application/json' ? 'json' : undefined;
      if (!extension) throw new Error('不支持的软件产物格式');
      const name = artifact.name.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}_-]/gu, '-').slice(0, 60) || 'document';
      const path = binding.imports[artifactId]?.path ?? `software/${binding.softwareId}/${name}-${artifact.id.replace(/[^a-zA-Z0-9]/g, '').slice(-16)}.${extension}`;
      const lease = this.ctx.studio.files.lease(taskId);
      // Exclusive creation; a retry may acknowledge an identical file, never overwrite an edited one.
      let saved;
      try { saved = await this.ctx.studio.files.write(lease, path, artifact.content, { createOnly: true }); }
      catch (error) { const existing = await this.ctx.studio.files.read(lease, path).catch(() => null); if (!existing || existing.version !== artifact.sha256) throw error; saved = existing; }
      binding.imports[artifactId] = { path, version: saved.version }; await this.save(); return { path, version: saved.version };
    });
  }
  async records(taskId: string, selected?: string) { const binding = this.bound(taskId, selected); if (!binding?.seatId) return { records: [] }; return this.call(this.path(binding) + '/records'); }
  recorder(taskId: string, enabled: boolean, selected?: string) { return this.work(taskId, human, async () => { const binding = this.bound(taskId, selected); if (!binding?.seatId) throw new Error('请先从兼容镜像目录选择并启动软件'); await this.call(this.path(binding) + '/recorder', 'POST', { enabled }); return { seat: await this.view(binding) }; }); }
  private async stopProducer(binding: SeatBinding) {
    if (!binding.seatId) return;
    const seat = await this.remote(binding); if (seat.state === 'released') return; if (seat.control) await this.call(this.path(binding) + '/control', 'DELETE', { token: seat.control.token });
    this.forgetControl(binding.seatId!);
    const { operations } = await this.call<{ operations: BridgeOperation[] }>(this.path(binding) + '/operations');
    // Control revocation is a write fence. Operation cancellation must also be acknowledged.
    for (const operation of operations) if (!terminal.has(operation.state)) await this.call(this.path(binding) + `/operations/${encodeURIComponent(operation.id)}/cancel`, 'POST', {});
  }
  private retire(binding: SeatBinding) {
    this.forgetControl(binding.seatId!); this.bindings.delete(savedKey(binding));
    // A normal release leaves a minimal platform identity for idempotency. Retain
    // only its reference so permanent task deletion also purges released Seats.
    const retired: SeatBinding = { ...binding, retired: true, imports: {} };
    this.bindings.set(savedKey(retired), retired);
  }
  private async erase(binding: SeatBinding, permanent = false) {
    if (!binding.seatId) {
      const seat = await this.call<SeatView>('/v1/seats', 'POST', { requestId: binding.createRequestId, imageId: binding.softwareId, taskId: binding.taskId, projectId: binding.projectId });
      binding.seatId = seat.id; await this.save();
    }
    await this.call(this.path(binding) + (permanent ? '?purge=true' : ''), 'DELETE');
    if (permanent) { this.forgetControl(binding.seatId!); this.bindings.delete(savedKey(binding)); } else this.retire(binding);
    await this.save();
  }
  async release(taskId: string, confirm: boolean, selected?: string) {
    if (confirm !== true) throw new Error('请先确认释放软件席位'); this.bound(taskId, selected);
    await this.serial(taskId, async () => { const binding = this.bound(taskId, selected); if (binding) await this.erase(binding); }); return { released: true };
  }
  async quiesce(taskIds: string[]) {
    for (const taskId of taskIds) await this.serial(taskId, async () => {
      const task = this.ctx.studioDomain.task(taskId);
      const permanent = ['delete', 'clear'].includes(task.pendingAction ?? '') && task.pendingOwnerId === taskId;
      const bindings = this.taskBindings(taskId, permanent);
      const results = await Promise.allSettled(bindings.map(binding => permanent ? this.erase(binding, true) : this.stopProducer(binding)));
      const failed = results.find(result => result.status === 'rejected'); if (failed?.status === 'rejected') throw failed.reason;
    });
  }
  async events(taskId: string, signal: AbortSignal, selected?: string): Promise<Response> {
    const binding = this.bound(taskId, selected); if (!binding?.seatId) throw new Error('没有连接的软件席位');
    // Obtain a fresh connection at the platform boundary. Never send its credential to a browser.
    await this.call(this.path(binding) + '/connection');
    const abort = new AbortController(); const combined = AbortSignal.any([signal, abort.signal]);
    const response = await fetch(this.endpoint + this.path(binding) + '/events', { headers: { authorization: `Bearer ${this.config.token}` }, signal: combined, redirect: 'error' });
    if (!response.ok || !response.body) throw new Error('软件画面连接失败'); const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) { try { while (true) { const part = await reader.read(); if (part.done) break; controller.enqueue(new TextEncoder().encode('event: refresh\ndata: {}\n\n')); } controller.close(); } catch (error) { if (!combined.aborted) controller.error(error); } finally { await reader.cancel().catch(() => {}); } },
      async cancel() { abort.abort(); await reader.cancel().catch(() => {}); },
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
  }
  async dispose() {
    this.closing = true;
    await Promise.allSettled([...this.queues.values()]);
    await Promise.allSettled([...this.bindings.values()].map(binding => this.stopProducer(binding)));
    for (const seatId of this.agentControls.keys()) this.forgetControl(seatId);
    await this.persistence.catch(() => {});
  }
  agent(agent: Agent | undefined, signal?: AbortSignal): { taskId: string; actor: Actor } { const lease = this.ctx.studio.taskLease(agent); return { taskId: lease.taskId, actor: { actor: 'agent', ownerId: agent!.id, lease, signal } }; }
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort = () => {};
  const canceled = new Promise<never>((_resolve, reject) => { onAbort = () => reject(abortError(signal)); signal.addEventListener('abort', onAbort, { once: true }); if (signal.aborted) onAbort(); });
  try { return await Promise.race([operation, canceled]); } finally { signal.removeEventListener('abort', onAbort); }
}
export async function apply(ctx: Context, config: Config) {
  // Both plugins read STUDIO_SEAT_BACKEND; a patch that changes only one of them must not run, e.g., VM tools on Studio's own files.
  const storage = ctx.studioDomain.softwareBackend;
  if (storage && storage !== config.backend) throw new Error(`软件后端配置不一致：studio-software-seat 是 ${config.backend}，studio-domain 是 ${storage}；两者都应取自 STUDIO_SEAT_BACKEND`);
  if (config.backend === 'none') return applyNoSoftware(ctx, { noSoftwarePromptPath: config.noSoftwarePromptPath || join(dirname(config.promptPath), 'software-none-system-prompt.md') });
  if (config.backend === 'vm-manager') return applyVmSeats(ctx, config);
  const seats = new StudioSeats(ctx, config); await seats.initialize();
  registerProjectExport(ctx);
  ctx.effect(() => ctx.studio.registerQuiescence('software-seat', ids => seats.quiesce(ids)), 'studio-seat: external write fence');
  const { prompt: instructions } = await loadPromptFile(config.promptPath);
  ctx.effect(() => () => seats.dispose(), 'studio-seat: lifecycle');
  const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] };
  const imageParameter = { type: 'string' as const, description: 'An installed image ID from studio_software_catalog. Required when this task has multiple running images.' };
  const tools = [
    defineTool({ name: 'studio_software_catalog', description: 'List installed compatible images, their immutable image references, software categories and Bridge capabilities. Choose the image fitting this task; do not assume CAD. All current software is Mock, never a real engineering solver. Creating images is unsupported.', parameters: {}, output, async execute(_args, exec) { throwIfAborted(exec.signal); ctx.studio.graphPlanningScope(exec.agent); return JSON.stringify(await seats.catalog()); } }),
    defineTool({ name: 'studio_software_launch', description: 'Launch or reopen the explicitly selected installed image for this task conversation. Each task may keep independent Seats for multiple images. Never creates images, controls software or completes the task. If provisioning, query status until ready before claiming control.', parameters: { imageId: { ...imageParameter, required: true }, requestId: { type: 'string', required: true } }, output, async execute(args, exec) { const { taskId, actor } = seats.agent(exec.agent, exec.signal); return JSON.stringify(await abortable(seats.create(taskId, imageId(args.imageId)!, requestId(args.requestId), actor), exec.signal)); } }),
    defineTool({ name: 'studio_software_status', description: 'Read Seats, documents, capabilities, control owners, operations and artifacts for this task only. With imageId selects that image; without it lists all task Seats and returns seat only when exactly one exists. Cannot select another task/project or external Seat.', parameters: { imageId: imageParameter }, output, async execute(args, exec) { throwIfAborted(exec.signal); return JSON.stringify(await seats.get(seats.agent(exec.agent, exec.signal).taskId, imageId(args.imageId))); } }),
    defineTool({ name: 'studio_software_control', description: 'Acquire or release exclusive Agent control for the selected image already launched in this task. Never launches a default image. Requires ready state. Refuses human/another chat ownership and cannot force takeover. Each image has independent control.', parameters: { action: { type: 'string', required: true, enum: ['acquire', 'release'] }, imageId: imageParameter }, output, async execute(args, exec) { const { taskId, actor } = seats.agent(exec.agent, exec.signal); return JSON.stringify(await abortable(seats.control(taskId, args.action, actor, false, imageId(args.imageId)), exec.signal)); } }),
    defineTool({ name: 'studio_software_invoke', description: 'Execute one capability advertised by the selected image with exclusive Agent control and the latest document revision. parameters is a strict JSON object matching that image capability. Returns operation state/result, possibly pending after 10 seconds. Timeout/unknown must be reconciled, never blindly repeated with a new requestId. Exports are immutable artifacts, not task submission.', parameters: { imageId: imageParameter, requestId: { type: 'string', required: true }, capability: { type: 'string', required: true }, parameters: { type: 'string', required: true, description: 'JSON object matching the selected image capability.' }, expectedDocumentRevision: { type: 'integer', required: true } }, output, async execute(args, exec) { const { taskId, actor } = seats.agent(exec.agent, exec.signal); if (args.parameters.length > 16384) throw new Error('Bridge参数过大'); const result = await abortable(seats.invoke(taskId, actor, { requestId: requestId(args.requestId), capability: text(args.capability, 'capability'), parameters: object(JSON.parse(args.parameters)), expectedDocumentRevision: args.expectedDocumentRevision }, exec.signal, imageId(args.imageId)), exec.signal); return JSON.stringify(await seats.wait(taskId, result.operation, exec.signal, actor, result.imageId)); } }),
    defineTool({ name: 'studio_software_operation', description: 'Read one operation in the selected task image, including progress, failure, cancellation or unknown result. Cannot inspect operations of another image/task.', parameters: { imageId: imageParameter, operationId: { type: 'string', required: true } }, output, async execute(args, exec) { throwIfAborted(exec.signal); return JSON.stringify(await seats.operation(seats.agent(exec.agent, exec.signal).taskId, text(args.operationId, 'operationId'), imageId(args.imageId))); } }),
    defineTool({ name: 'studio_software_cancel', description: 'Cancel a Bridge operation in the selected task image while this conversation owns its Agent control. Cancellation is acknowledged and fences changes.', parameters: { imageId: imageParameter, operationId: { type: 'string', required: true } }, output, async execute(args, exec) { const { taskId, actor } = seats.agent(exec.agent, exec.signal); return JSON.stringify(await abortable(seats.cancel(taskId, text(args.operationId, 'operationId'), actor, imageId(args.imageId)), exec.signal)); } }),
    defineTool({ name: 'studio_software_save_artifact', description: 'Verify and copy one immutable export from the selected image into software/<imageId>/ in this task workspace without overwriting existing files. Does not submit files, tick checklist items or complete/accept the task.', parameters: { imageId: imageParameter, artifactId: { type: 'string', required: true } }, output, async execute(args, exec) { const { taskId, actor } = seats.agent(exec.agent, exec.signal); throwIfAborted(exec.signal); return JSON.stringify(await abortable(seats.artifact(taskId, text(args.artifactId, 'artifactId'), actor, imageId(args.imageId)), exec.signal)); } }),
  ];
  for (const tool of tools) ctx.tools.register({ ...tool, parameters: { ...tool.parameters, additionalProperties: false } });
  ctx.effect(() => ctx.studio.registerInstructions('software-seat-text', 113, instructions), 'studio-seat: prompt file');
  for (const [path, methods, action] of [
    ['catalog', ['GET'], async () => seats.catalog()],
    ['seats', ['GET'], async (request: Request) => seats.list(text(new URL(request.url).searchParams.get('taskId'), 'taskId'))],
    ['seat', ['GET', 'POST'], async (request: Request) => { if (request.method === 'GET') { const query = new URL(request.url).searchParams; return seats.get(text(query.get('taskId'), 'taskId'), imageId(query.get('imageId'))); } const data = object(await request.json()), selected = selectedImage(data); if (!selected) throw new Error('请选择要启动的镜像imageId'); return seats.create(text(data.taskId, 'taskId'), selected, requestId(data.requestId)); }],
    ['control', ['POST'], async (request: Request) => { const data = object(await request.json()); if (data.takeover !== undefined && typeof data.takeover !== 'boolean') throw new Error('Invalid takeover'); return seats.control(text(data.taskId, 'taskId'), text(data.action, 'action'), human, data.takeover === true, selectedImage(data)); }],
    ['invoke', ['POST'], async (request: Request) => { const data = object(await request.json()); if (!Number.isSafeInteger(data.expectedDocumentRevision) || (data.expectedDocumentRevision as number) < 0) throw new Error('请提供当前文档版本'); return seats.invoke(text(data.taskId, 'taskId'), human, { requestId: requestId(data.requestId), capability: text(data.capability, 'capability'), parameters: object(data.parameters), expectedDocumentRevision: data.expectedDocumentRevision as number }, request.signal, selectedImage(data)); }],
    ['ack-unknown', ['POST'], async (request: Request) => { const data = object(await request.json()); if (Object.keys(data).some(key => !['taskId', 'imageId', 'operationIds', 'expectedDocumentRevision'].includes(key))) throw new Error('未知操作确认参数无效'); return seats.acknowledgeUnknown(text(data.taskId, 'taskId'), { operationIds: data.operationIds, expectedDocumentRevision: data.expectedDocumentRevision }, imageId(data.imageId)); }],
    ['operation', ['GET'], async (request: Request) => { const query = new URL(request.url).searchParams; return seats.operation(text(query.get('taskId'), 'taskId'), text(query.get('operationId'), 'operationId'), imageId(query.get('imageId'))); }],
    ['cancel', ['POST'], async (request: Request) => { const data = object(await request.json()); return seats.cancel(text(data.taskId, 'taskId'), text(data.operationId, 'operationId'), human, selectedImage(data)); }],
    ['artifact', ['POST'], async (request: Request) => { const data = object(await request.json()); return seats.artifact(text(data.taskId, 'taskId'), text(data.artifactId, 'artifactId'), human, selectedImage(data)); }],
    ['release', ['POST'], async (request: Request) => { const data = object(await request.json()); return seats.release(text(data.taskId, 'taskId'), data.confirm === true, selectedImage(data)); }],
    ['records', ['GET'], async (request: Request) => { const query = new URL(request.url).searchParams; return seats.records(text(query.get('taskId'), 'taskId'), imageId(query.get('imageId'))); }],
    ['recorder', ['POST'], async (request: Request) => { const data = object(await request.json()); if (typeof data.enabled !== 'boolean') throw new Error('Invalid recorder flag'); return seats.recorder(text(data.taskId, 'taskId'), data.enabled, selectedImage(data)); }],
  ] as const) ctx.connection.fetch.register({ path: '/api/studio/software/' + path, methods: [...methods], requestBody: 'buffered', async fetch(request) { try { return Response.json(await ctx.studioDomain.webAction(request, async () => action(request))); } catch (error) { return Response.json({ error: error instanceof Error ? error.message : '软件接口错误' }, { status: 400 }); } } });
  ctx.connection.fetch.register({ path: '/api/studio/software/events', methods: ['GET'], requestBody: 'buffered', async fetch(request) { try { const query = new URL(request.url).searchParams; return await seats.events(text(query.get('taskId'), 'taskId'), request.signal, imageId(query.get('imageId'))); } catch (error) { return Response.json({ error: error instanceof Error ? error.message : '软件连接错误' }, { status: 400 }); } } });
}
