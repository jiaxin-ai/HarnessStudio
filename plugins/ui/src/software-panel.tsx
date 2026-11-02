import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { TaskView } from '@harnessstudio/studio/domain-types';
import type { StudioSeatView, StudioVmSeatView, SoftwareDescriptor, BridgeOperation, MockShape, MockAnalysis, SeatRecord } from '../../studio/src/seat-types.ts';
import { api } from './api.ts';
import { randomId } from './random-id.ts';
import { VmArea, vmStateLabel } from './vm-panel.tsx';

const seatStates = { provisioning: '正在准备', ready: '已连接', failed: '连接失败', released: '已释放' };
const stateLabel = (row: StudioSeatView | StudioVmSeatView) => 'backend' in row ? vmStateLabel(row) : seatStates[row.state];
const operationStates = { queued: '排队中', running: '执行中', succeeded: '已完成', failed: '失败', canceled: '已取消', unknown: '结果未明' };
const operationNames: Record<string, string> = { 'shape.add': '添加图形', 'shape.update': '修改图形', 'shape.delete': '删除图形', 'document.rename': '修改文档名称', 'document.export': '导出产物', 'document.inspect': '检查文档', 'analysis.configure': '配置分析', 'analysis.run': '运行模拟分析' };
const categoryNames = { mechanical: '机械设计', simulation: '工程仿真', drafting: '二维制图', electronics: '电子设计', rendering: '建模渲染' };
const isRunning = (operation: BridgeOperation) => operation.state === 'queued' || operation.state === 'running';
const formatBytes = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

function Confirm({ kind, busy, blocked = false, error, onClose, onConfirm }: { kind: 'takeover' | 'release'; busy: boolean; blocked?: boolean; error?: string; onClose(): void; onConfirm(): void }) {
  const dialog = useRef<HTMLDialogElement>(null), cancel = useRef<HTMLButtonElement>(null), titleId = useId();
  useEffect(() => {
    const previous = document.activeElement; dialog.current?.showModal(); cancel.current?.focus();
    return () => { dialog.current?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  return <dialog ref={dialog} className="software-confirm" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <h2 id={titleId}>{kind === 'takeover' ? '接管软件控制？' : '释放当前席位？'}</h2>
    <p>{kind === 'takeover' ? '当前由 Agent 控制。接管后，你将获得编辑权限，Agent 正在执行的操作可能会被取消。' : '当前软件连接将关闭，运行中的操作将停止。请先保存需要的产物；继续工作时需要重新连接。'}</p>
    {error && <p className="software-warning" role="status">{error}</p>}
    <footer><button ref={cancel} type="button" disabled={busy} onClick={onClose}>取消</button><button type="button" className={kind === 'release' ? 'software-danger' : 'software-primary'} disabled={busy || blocked} onClick={onConfirm}>{busy ? '处理中…' : kind === 'takeover' ? '确认接管' : '确认释放'}</button></footer>
  </dialog>;
}

interface Drag { id: string; pointerId: number; startX: number; startY: number; originX: number; originY: number; x: number; y: number; revision: number }
type AnalysisDraft = Omit<MockAnalysis, 'result'>;
const scopeQuery = (taskId: string, imageId: string) => new URLSearchParams({ taskId, imageId }).toString();

function ImageIcon({ category }: { category: SoftwareDescriptor['category'] }) {
  return <svg viewBox="0 0 32 32" aria-hidden="true">{category === 'mechanical' ? <><path d="m16 4 10 6v12l-10 6-10-6V10zM6 10l10 6 10-6M16 16v12" /><path d="m11 7 10 6v7" /></> : category === 'simulation' ? <><path d="M5 23h22M8 23V10l8-5 8 5v13M8 10l16 13M24 10 8 23M16 5v18" /><circle cx="16" cy="14" r="2" /></> : <><path d="M6 26 16 5l10 21zM10 18h12M6 26h20" /><path d="M4 7h6M7 4v6M23 3h6M26 1v5" /></>}</svg>;
}

/** Installed images are discovered separately from the user's explicit software selection. */
/** chatId is the selected conversation ('' for an unsent new one); vm_manager software follows it, Mock seats are per task. */
export function SoftwarePanel({ task, active, chatId = '', chats = [], onSelectChat, onArtifactsSaved }: { task: TaskView; active: boolean; chatId?: string; chats?: string[]; onSelectChat?(id: string): void; onArtifactsSaved(): void }) {
  const [catalog, setCatalog] = useState<SoftwareDescriptor[]>([]), [seats, setSeats] = useState<(StudioSeatView | StudioVmSeatView)[]>([]), [defaultRunMinutes, setDefaultRunMinutes] = useState<number>();
  const [imageId, setImageId] = useState(''), [loading, setLoading] = useState(true), [starting, setStarting] = useState(''), [error, setError] = useState('');
  const identity = useRef(task.id), generation = useRef(0), alive = useRef(true), fetching = useRef(false), pending = useRef(false);
  const sequence = useRef(0), accepted = useRef(0), startRequests = useRef(new Map<string, string>());
  if (identity.current !== task.id) { identity.current = task.id; generation.current++; }
  const taskId = task.id;
  const mayCreate = task.kind === 'task' && !task.isFolder && task.writable && !task.pending && !task.archived;
  const refresh = useCallback(async (includeCatalog = false) => {
    const stamp = generation.current, request = ++sequence.current;
    const [view, images] = await Promise.all([
      api<{ seats: (StudioSeatView | StudioVmSeatView)[] }>(`software/seats?taskId=${encodeURIComponent(taskId)}`, undefined, { timeoutMs: 30000 }),
      includeCatalog ? api<{ images: SoftwareDescriptor[]; software?: SoftwareDescriptor[]; defaultRunMinutes?: number }>('software/catalog', undefined, { timeoutMs: 30000 }) : undefined,
    ]);
    if (!alive.current || stamp !== generation.current || identity.current !== taskId || request < accepted.current) return;
    accepted.current = request; setSeats(view.seats);
    if (images) { setCatalog(images.images ?? images.software ?? []); setDefaultRunMinutes(images.defaultRunMinutes); }
    setLoading(false);
  }, [taskId]);
  useEffect(() => {
    alive.current = true; setCatalog([]); setSeats([]); setImageId(''); setLoading(true); setStarting(''); setError('');
    fetching.current = false; pending.current = false; startRequests.current.clear();
    return () => { alive.current = false; generation.current++; };
  }, [taskId]);
  const virtual = catalog.length > 0 && catalog.every(row => row.backend === 'vm-manager');
  useEffect(() => {
    // The vm_manager area polls its own VMs; this loop only loads the catalog and Mock seats.
    if (!active || imageId || virtual) return;
    let disposed = false;
    const stamp = generation.current;
    const poll = () => {
      if (disposed || !alive.current || stamp !== generation.current || identity.current !== taskId || document.visibilityState === 'hidden' || fetching.current || pending.current) return;
      fetching.current = true;
      void refresh(catalog.length === 0).then(() => { if (!disposed && stamp === generation.current) setError(''); }).catch(reason => {
        if (!disposed && stamp === generation.current && alive.current) { setError(reason instanceof Error ? reason.message : '无法读取软件目录'); setLoading(false); }
      }).finally(() => { if (stamp === generation.current) fetching.current = false; });
    };
    poll(); const timer = setInterval(poll, 1000); document.addEventListener('visibilitychange', poll);
    return () => { disposed = true; clearInterval(timer); document.removeEventListener('visibilitychange', poll); };
  }, [taskId, active, refresh, catalog.length, imageId, virtual]);
  const manualRefresh = async () => {
    if (fetching.current || pending.current || !active) return;
    const stamp = generation.current; fetching.current = true;
    try { await refresh(true); if (alive.current && stamp === generation.current && identity.current === taskId) setError(''); }
    catch (reason) { if (alive.current && stamp === generation.current && identity.current === taskId) setError(reason instanceof Error ? reason.message : '无法读取软件目录'); }
    finally { if (stamp === generation.current) fetching.current = false; }
  };
  const openImage = async (image: SoftwareDescriptor, launch: boolean) => {
    if (pending.current || !active) return;
    if (!launch) { setImageId(image.id); return; }
    if (!mayCreate) return;
    const stamp = generation.current; pending.current = true; setStarting(image.id); setError('');
    const requestId = startRequests.current.get(image.id) ?? randomId(); startRequests.current.set(image.id, requestId);
    try {
      await api('software/seat', { taskId, imageId: image.id, requestId });
      // Retain an uncertain allocation ID only until its ACK; a later relaunch needs a fresh ID.
      if (startRequests.current.get(image.id) === requestId) startRequests.current.delete(image.id);
      if (alive.current && stamp === generation.current && identity.current === taskId) { await refresh(); if (alive.current && stamp === generation.current && identity.current === taskId) setImageId(image.id); }
    } catch (reason) { if (alive.current && stamp === generation.current) setError(reason instanceof Error ? reason.message : '软件启动失败'); }
    finally { if (alive.current && stamp === generation.current) { pending.current = false; setStarting(''); } }
  };
  if (virtual) return <VmArea task={task} active={active} catalog={catalog} defaultRunMinutes={defaultRunMinutes} chatId={chatId} chats={chats} onSelectChat={onSelectChat} />;
  const image = catalog.find(row => row.id === imageId);
  if (image) return <SoftwareWorkbench key={`${taskId}:${image.id}`} task={task} active={active} image={image} catalog={catalog} seats={seats.filter((row): row is StudioSeatView => !('backend' in row))} onBack={() => setImageId('')} onSelectImage={setImageId} onArtifactsSaved={onArtifactsSaved} />;
  return <section className="software-panel software-directory-panel" aria-label="软件镜像目录">
    <header className="software-header"><div><h3>软件工作台</h3><p>选择当前任务需要的软件镜像，各软件拥有独立的工作席位。</p></div><button type="button" className="software-icon-button" aria-label="刷新软件目录" disabled={loading || !!starting} onClick={() => { void manualRefresh(); }}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M15.8 7A6.2 6.2 0 1 0 16 12M16 3v4h-4" /></svg></button></header>
    <div className="software-message" role="status">{error}</div>
    <div className="software-directory">
      {loading ? <p className="software-catalog-note">正在读取已安装的软件镜像…</p> : catalog.length ? <><p className="software-catalog-note">可用镜像 <span>{catalog.length}</span> · 点击启动或打开进入工作台</p><div className="software-image-list">{catalog.map(entry => {
        const connected = seats.find(row => row.softwareId === entry.id && row.state !== 'released');
        return <article key={entry.id} title={entry.description} className={`software-image-card is-${entry.category}`}><div className="software-image-icon"><ImageIcon category={entry.category} /></div><div className="software-image-details"><header><h4 title={entry.name}>{entry.name}</h4>{entry.backend === 'vm-manager' ? <span className="software-vm-badge">虚拟机</span> : <span className="software-mock-badge">MOCK</span>}</header><small>{entry.vm ? `${entry.version} · ${categoryNames[entry.category]}` : categoryNames[entry.category]}</small></div><div className="software-image-actions"><span className={`software-image-state${connected ? ` is-${connected.state}` : ''}`}>{connected ? stateLabel(connected) : '尚未启动'}</span><button type="button" className="software-primary" aria-label={`${connected ? '打开' : '启动'} ${entry.name}`} disabled={!!starting || !connected && !mayCreate} onClick={() => { void openImage(entry, !connected); }}>{starting === entry.id ? '正在启动…' : connected ? '打开' : '启动'}</button></div></article>;
      })}</div><p className="software-catalog-note">当前均为 Mock 镜像，用于验证软件交互与平台接口。</p>{!mayCreate && <p className="software-readonly">{task.kind === 'group' || task.isFolder ? '任务组可查看或释放已有连接。请在末端子任务中启动软件。' : '当前任务只读，可以打开已有连接查看或释放席位。'}</p>}</> : <p className="software-catalog-note">暂时没有可用的软件镜像，请刷新目录或检查平台连接。</p>}
    </div>
  </section>;
}

/** Each task/image pair has its own lifecycle, drafts, operation history and event stream. */
function SoftwareWorkbench({ task, active, image, catalog, seats, onBack, onSelectImage, onArtifactsSaved }: { task: TaskView; active: boolean; image: SoftwareDescriptor; catalog: SoftwareDescriptor[]; seats: StudioSeatView[]; onBack(): void; onSelectImage(id: string): void; onArtifactsSaved(): void }) {
  const [seat, setSeat] = useState<StudioSeatView | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [records, setRecords] = useState<SeatRecord[]>([]), [confirmation, setConfirmation] = useState<'takeover' | 'release'>();
  const [selected, setSelected] = useState(''), [shapeDraft, setShapeDraft] = useState<MockShape>(), [shapeRevision, setShapeRevision] = useState<number>();
  const [nameDraft, setNameDraft] = useState(''), [nameDirty, setNameDirty] = useState(false), [drag, setDrag] = useState<Drag>();
  const [savedArtifacts, setSavedArtifacts] = useState<Record<string, string>>({});
  const [analysisDraft, setAnalysisDraft] = useState<AnalysisDraft>({ type: 'static', loadN: 1000, elasticModulusMPa: 210000, meshSizeMm: 5 });
  const [analysisRevision, setAnalysisRevision] = useState<number>();
  const generation = useRef(0), alive = useRef(true), activeRef = useRef(active);
  activeRef.current = active;
  const pending = useRef(false), fetching = useRef(false), sequence = useRef(0), accepted = useRef(0), svg = useRef<SVGSVGElement>(null);
  const latestAddedRequest = useRef<string>(), latestRenameRequest = useRef<string>(), skipCanvasClick = useRef(false);
  const recordPanel = useRef<HTMLDetailsElement>(null);
  const imageId = image.id, scopeId = `${task.id}:${imageId}`;
  const identity = useRef(scopeId);
  if (identity.current !== scopeId) { identity.current = scopeId; generation.current++; }
  const taskId = task.id;
  const eventsPath = seat?.state === 'ready' ? (() => { const url = new URL(seat.connection.eventsPath, window.location.href); url.searchParams.set('taskId', taskId); url.searchParams.set('imageId', imageId); return url.pathname + url.search; })() : undefined;
  const valid = (stamp: number) => alive.current && stamp === generation.current && identity.current === scopeId;

  const refresh = useCallback(async () => {
    const stamp = generation.current, request = ++sequence.current;
    const [view, history] = await Promise.all([
      api<{ seat: StudioSeatView | null }>(`software/seat?${scopeQuery(taskId, imageId)}`),
      api<{ records: SeatRecord[] }>(`software/records?${scopeQuery(taskId, imageId)}`),
    ]);
    if (!alive.current || stamp !== generation.current || identity.current !== scopeId || request < accepted.current) return;
    if (view.seat && view.seat.softwareId !== imageId) throw new Error('软件席位与当前镜像不匹配，请刷新目录后重试');
    accepted.current = request;
    setSeat(view.seat); setRecords(history.records);
    setLoading(false);
  }, [taskId, imageId, scopeId]);

  useEffect(() => {
    alive.current = true;
    setSeat(null); setRecords([]); setLoading(true); setBusy(false); setError(''); setConnectionError(''); setNotice(''); setConfirmation(undefined); setSelected(''); setShapeDraft(undefined); setNameDraft(''); setNameDirty(false); setSavedArtifacts({}); setDrag(undefined);
    pending.current = false; fetching.current = false; latestAddedRequest.current = undefined; latestRenameRequest.current = undefined;
    return () => { alive.current = false; generation.current++; };
  }, [scopeId]);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    const stamp = generation.current;
    let stream: EventSource | undefined, eventTimer: ReturnType<typeof setTimeout> | undefined;
    const poll = () => {
      if (disposed || !alive.current || stamp !== generation.current || identity.current !== scopeId || document.visibilityState === 'hidden' || fetching.current || pending.current) return;
      fetching.current = true;
      void refresh().then(() => { if (!disposed && alive.current && stamp === generation.current) setConnectionError(''); }).catch(reason => {
        if (!disposed && alive.current && stamp === generation.current) { setConnectionError(reason instanceof Error ? reason.message : '无法连接软件平台'); setLoading(false); }
      }).finally(() => { if (stamp === generation.current) fetching.current = false; });
    };
    const onRefresh = () => {
      if (disposed || !alive.current || stamp !== generation.current || identity.current !== scopeId || document.visibilityState === 'hidden' || eventTimer) return;
      // Coalesce platform bursts; polling still catches events received during a mutation.
      eventTimer = setTimeout(() => { eventTimer = undefined; poll(); }, 120);
    };
    const syncStream = () => {
      if (disposed || !alive.current || stamp !== generation.current || identity.current !== scopeId || document.visibilityState === 'hidden' || !eventsPath) {
        stream?.close(); stream = undefined;
        if (eventTimer) { clearTimeout(eventTimer); eventTimer = undefined; }
        return;
      }
      if (stream || typeof EventSource === 'undefined') return;
      stream = new EventSource(eventsPath);
      stream.addEventListener('refresh', onRefresh);
      // EventSource reconnects after transient errors; the 1 s poll remains a fallback.
    };
    const onVisibility = () => { syncStream(); poll(); };
    syncStream();
    poll();
    const timer = setInterval(poll, 1000);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disposed = true; clearInterval(timer); if (eventTimer) clearTimeout(eventTimer);
      stream?.removeEventListener('refresh', onRefresh); stream?.close();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [scopeId, active, refresh, eventsPath]);

  const run = async (action: () => Promise<void>, refreshAfter = true) => {
    if (pending.current || !activeRef.current) return;
    const stamp = generation.current; pending.current = true; setBusy(true); setError(''); setNotice('');
    try { await action(); if (valid(stamp) && refreshAfter) await refresh(); }
    catch (reason) { if (valid(stamp)) setError(reason instanceof Error ? reason.message : '软件操作失败'); }
    finally { if (valid(stamp)) { pending.current = false; setBusy(false); } }
  };
  const usable = seat?.state === 'ready';
  const eligible = task.kind === 'task' && !task.isFolder;
  const mayCreate = eligible && task.writable && !task.pending && !task.archived;
  const writable = mayCreate && !!seat?.canEdit;
  const owner = seat?.control && Date.parse(seat.control.expiresAt) > Date.now() ? seat.control.actor : undefined;
  const running = seat?.operations.filter(isRunning) ?? [];
  const recentOperations = [...seat?.operations ?? []].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5);
  const unacknowledgedUnknownIds = seat?.unacknowledgedUnknownIds ?? [];
  const unknownIndexComplete = seat?.unknownOperationIndexComplete === true;
  const uncertain = unacknowledgedUnknownIds.length > 0;
  const humanEditing = usable && writable && owner === 'human';
  const canModify = humanEditing && !busy && !running.length && !uncertain && unknownIndexComplete;
  useEffect(() => { if (!writable) setConfirmation(previous => previous === 'takeover' ? undefined : previous); }, [writable]);
  const supports = (capability: string) => !!seat?.software.capabilities.some(row => row.id === capability);
  const invoke = async (capability: string, parameters: Record<string, unknown>, expectedDocumentRevision = seat?.document.revision) => {
    if (!canModify || !supports(capability)) return;
    const stamp = generation.current, requestId = randomId();
    await run(async () => {
      const result = await api<{ operation: BridgeOperation }>('software/invoke', { taskId, imageId, requestId, capability, parameters, expectedDocumentRevision });
      if (!valid(stamp)) return;
      if (capability === 'shape.add') latestAddedRequest.current = requestId;
      if (capability === 'document.rename') latestRenameRequest.current = requestId;
      setSeat(previous => previous && previous.id === result.operation.seatId ? { ...previous, operations: [...previous.operations.filter(row => row.id !== result.operation.id), result.operation] } : previous);
    });
  };
  const control = async (action: 'acquire' | 'release', takeover = false) => {
    if (!usable || !writable) return;
    const stamp = generation.current;
    await run(async () => {
      const result = await api<{ seat: StudioSeatView }>('software/control', { taskId, imageId, action, ...(takeover ? { takeover: true } : {}) });
      if (valid(stamp)) { setSeat(result.seat); setConfirmation(undefined); }
    });
  };

  useEffect(() => {
    if (!seat) return;
    const added = latestAddedRequest.current && seat.operations.find(row => row.requestId === latestAddedRequest.current);
    if (added && !isRunning(added)) {
      latestAddedRequest.current = undefined;
      if (added.state === 'succeeded') setSelected(seat.document.shapes.at(-1)?.id ?? '');
    }
    const renamed = latestRenameRequest.current && seat.operations.find(row => row.requestId === latestRenameRequest.current);
    if (renamed && !isRunning(renamed)) { latestRenameRequest.current = undefined; if (renamed.state === 'succeeded') setNameDirty(false); }
    if (selected && !seat.document.shapes.some(row => row.id === selected)) setSelected('');
  }, [seat?.document.revision, seat?.operations, selected]);
  useEffect(() => {
    const shape = seat?.document.shapes.find(row => row.id === selected);
    setShapeDraft(shape ? { ...shape } : undefined); setShapeRevision(seat?.document.revision);
  }, [selected, seat?.document.revision]);
  useEffect(() => { if (!nameDirty) setNameDraft(seat?.document.name ?? ''); }, [seat?.document.name, nameDirty]);
  useEffect(() => {
    const analysis = seat?.document.analysis;
    setAnalysisDraft(analysis ? { type: analysis.type, loadN: analysis.loadN, elasticModulusMPa: analysis.elasticModulusMPa, meshSizeMm: analysis.meshSizeMm } : { type: 'static', loadN: 1000, elasticModulusMPa: 210000, meshSizeMm: 5 });
    setAnalysisRevision(seat?.document.revision);
  }, [seat?.document.revision]);
  useEffect(() => { if (!canModify) setDrag(undefined); }, [canModify]);

  const position = (clientX: number, clientY: number) => {
    const element = svg.current, matrix = element?.getScreenCTM();
    if (!element || !matrix) return undefined;
    const point = element.createSVGPoint(); point.x = clientX; point.y = clientY;
    return point.matrixTransform(matrix.inverse());
  };
  const selectedShape = seat?.document.shapes.find(row => row.id === selected);
  const dirtyShape = !!shapeDraft && !!selectedShape && ['x', 'y', 'width', 'height', 'label'].some(key => shapeDraft[key as keyof MockShape] !== selectedShape[key as keyof MockShape]);
  const shapeValid = !!shapeDraft && [shapeDraft.x, shapeDraft.y, shapeDraft.width, shapeDraft.height].every(Number.isFinite) && shapeDraft.width > 0 && shapeDraft.height > 0;
  const isSimulation = image.workbench === 'simulation';
  const analysis = seat?.document.analysis;
  const analysisDirty = !analysis || (['type', 'loadN', 'elasticModulusMPa', 'meshSizeMm'] as const).some(key => analysisDraft[key] !== analysis[key]);
  const analysisValid = Number.isFinite(analysisDraft.loadN) && analysisDraft.loadN >= 0 && analysisDraft.loadN <= 1e9 && Number.isFinite(analysisDraft.elasticModulusMPa) && analysisDraft.elasticModulusMPa >= .001 && analysisDraft.elasticModulusMPa <= 1e9 && Number.isFinite(analysisDraft.meshSizeMm) && analysisDraft.meshSizeMm >= .001 && analysisDraft.meshSizeMm <= 10000;
  const connecting = seat?.state === 'provisioning';
  return <section className="software-panel" aria-label={`${image.name} Mock 工作台`}>
    <nav className="software-switcher" aria-label="软件工作台切换"><button type="button" disabled={busy} onClick={() => { if (!pending.current) onBack(); }}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m9 3-5 5 5 5M4 8h9" /></svg>软件目录</button><select aria-label="切换软件镜像" value={imageId} disabled={busy} onChange={event => { if (!pending.current) onSelectImage(event.target.value); }}>{catalog.map(entry => <option key={entry.id} value={entry.id} disabled={entry.id !== imageId && !mayCreate && !seats.some(row => row.softwareId === entry.id && row.state !== 'released')}>{entry.name}</option>)}</select></nav>
    <header className="software-header"><div><h3>{image.name} 工作台 <span className="software-mock-badge">MOCK</span></h3><p>{isSimulation ? '模拟分析与结果，用于验证仿真软件操作流程。' : '模拟绘图与编辑，用于验证设计软件操作流程。'}</p></div><button type="button" className="software-icon-button" aria-label="刷新软件状态" title="刷新软件状态" disabled={busy || loading} onClick={() => { void run(refresh, false); }}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M15.8 7A6.2 6.2 0 1 0 16 12M16 3v4h-4" /></svg></button></header>
    {confirmation && <Confirm kind={confirmation} busy={busy} blocked={!!task.pending} error={error} onClose={() => setConfirmation(undefined)} onConfirm={() => {
      if (confirmation === 'takeover') void control('acquire', true);
      else {
        if (task.pending) return;
        const stamp = generation.current;
        void run(async () => { await api('software/release', { taskId, imageId, confirm: true }); if (valid(stamp)) { setConfirmation(undefined); setSelected(''); setNotice(`${image.name} 席位已释放。`); } });
      }
    }} />}
    <div className="software-message" role="status">{error || connectionError || notice}</div>
    {loading ? <div className="software-empty"><span className="software-status-dot is-busy" /><p>正在读取 {image.name} 席位…</p></div> : !seat || seat.state === 'released' ? <div className="software-empty"><div className="software-empty-art"><ImageIcon category={image.category} /></div><h3>{eligible ? `准备 ${image.name} 工作台` : '没有软件连接'}</h3><p>{eligible ? image.description : '任务组只能查看或释放已有软件连接。请在末端子任务中启动软件。'}</p>{eligible && <button type="button" className="software-primary" disabled={busy || !mayCreate} onClick={() => {
      if (!mayCreate) return;
      const stamp = generation.current;
      void run(async () => { const result = await api<{ seat: StudioSeatView }>('software/seat', { taskId, imageId, requestId: randomId() }); if (valid(stamp)) setSeat(result.seat); });
    }}>{busy ? '正在启动…' : `启动 ${image.name}`}</button>}{eligible && !task.writable && <small>当前任务只读，恢复编辑后可以启动软件。</small>}</div> : <>
      <div className="software-control-bar"><span className={`software-seat-status is-${seat.state}`}><span className={`software-status-dot${connecting ? ' is-busy' : ''}`} />{seatStates[seat.state]}</span><span className="software-owner">{owner === 'human' ? '你正在控制' : owner === 'agent' ? 'Agent 正在控制' : '控制权空闲'}</span><div>{owner === 'human' ? <button type="button" disabled={busy || !writable || !usable} onClick={() => { void control('release'); }}>交还控制</button> : <button type="button" className="software-primary" disabled={busy || !writable || !usable} onClick={() => { if (owner === 'agent') setConfirmation('takeover'); else void control('acquire'); }}>{owner === 'agent' ? '接管控制' : '获取控制'}</button>}<button type="button" className="software-text-button" disabled={busy || !!task.pending} onClick={() => setConfirmation('release')}>释放席位</button></div></div>
      <div className="software-body">
        {seat.state === 'failed' && <div className="software-warning"><strong>席位准备失败</strong><p>{seat.error?.message || '请检查平台连接后重新创建席位。'}</p></div>}
        {!writable && <p className="software-readonly">{eligible ? '当前任务只读，可以查看文档、已生成产物或释放席位。' : '当前节点为任务组，只能查看或释放已有软件连接。'}</p>}
        {usable && writable && owner !== 'human' && <p className="software-readonly">{owner === 'agent' ? 'Agent 的操作会同步到工作台。接管控制后可以操作。' : isSimulation ? '获取控制后，配置分析参数并运行模拟分析。' : '获取控制后，添加或拖动图形以开始编辑。'}</p>}
        {!unknownIndexComplete && <div className="software-warning" role="status"><p>软件平台未提供完整的未知操作清单，已暂停修改。请更新平台接口后重新连接；现有文档和历史仍可查看。</p></div>}
        {uncertain && <div className="software-warning"><p>有 {unacknowledgedUnknownIds.length} 项操作的结果未明，请检查当前文档和操作记录后再继续。</p><div className="software-warning-actions"><button type="button" onClick={() => { if (recordPanel.current) { recordPanel.current.open = true; recordPanel.current.scrollIntoView({ block: 'start', behavior: 'smooth' }); } }}>查看操作记录</button><button type="button" disabled={busy || !humanEditing || !!running.length || !unknownIndexComplete} onClick={() => {
          if (!seat) return;
          const stamp = generation.current, operationIds = [...unacknowledgedUnknownIds], expectedDocumentRevision = seat.document.revision;
          void run(async () => {
            const result = await api<{ seat: StudioSeatView }>('software/ack-unknown', { taskId, imageId, operationIds, expectedDocumentRevision });
            if (valid(stamp)) { setSeat(result.seat); setNotice('已记录人工核对；结果未明的历史记录保留。'); }
          });
        }}>已核对当前文档，继续操作</button></div></div>}
        <div className="software-document-bar"><div><strong title={seat.document.name}>{seat.document.name}</strong><small>版本 {seat.document.revision} · {isSimulation ? analysis ? analysis.type === 'static' ? '静力分析' : '模态分析' : '尚未配置分析' : `${seat.document.units} · ${seat.document.shapes.length} 个图形`}</small></div><span>{isSimulation ? '模拟分析文档' : '模拟绘图文档'}</span></div>
        {isSimulation ? <section className="software-analysis" aria-label="ANSYS 模拟分析"><header><strong>分析参数</strong><span className="software-mock-badge">MOCK</span></header><form onSubmit={event => { event.preventDefault(); if (analysisValid && analysisDirty) void invoke('analysis.configure', { ...analysisDraft }, analysisRevision); }}><div className="software-analysis-grid"><label>分析类型<select aria-label="分析类型" value={analysisDraft.type} disabled={!canModify || !supports('analysis.configure')} onChange={event => { const type = event.currentTarget.value as AnalysisDraft['type']; setAnalysisDraft(previous => ({ ...previous, type })); }}><option value="static">静力分析</option><option value="modal">模态分析</option></select></label>{(['loadN', 'elasticModulusMPa', 'meshSizeMm'] as const).map(key => <label key={key}>{({ loadN: '载荷', elasticModulusMPa: '弹性模量', meshSizeMm: '网格尺寸' })[key]}<span>{({ loadN: 'N', elasticModulusMPa: 'MPa', meshSizeMm: 'mm' })[key]}</span><input type="number" aria-label={`分析${({ loadN: '载荷', elasticModulusMPa: '弹性模量', meshSizeMm: '网格尺寸' })[key]}`} value={Number.isFinite(analysisDraft[key]) ? analysisDraft[key] : ''} min={key === 'loadN' ? 0 : .001} max={key === 'meshSizeMm' ? 10000 : 1e9} step="any" disabled={!canModify || !supports('analysis.configure')} onChange={event => { const value = event.currentTarget.value === '' ? NaN : Number(event.currentTarget.value); setAnalysisDraft(previous => ({ ...previous, [key]: value })); }} /></label>)}</div><div className="software-analysis-actions"><button type="submit" disabled={!canModify || !analysisValid || !analysisDirty || !supports('analysis.configure')}>保存分析参数</button><button type="button" className="software-primary" disabled={!canModify || !analysis || analysisDirty || !supports('analysis.run')} title={analysisDirty ? '请先保存分析参数' : undefined} onClick={() => { void invoke('analysis.run', {}); }}>运行模拟分析</button></div></form>{!analysis && <p>请确认并保存分析参数，再运行模拟分析。</p>}{analysisDirty && analysis && <p>参数尚未保存，运行前请先保存当前修改。</p>}{analysis?.result ? <div className="software-analysis-result"><header><strong>当前已保存配置的模拟结果</strong><span className="software-mock-badge">MOCK</span></header><dl><div><dt>最大位移</dt><dd>{analysis.result.maxDisplacementMm.toLocaleString('zh-CN', { maximumFractionDigits: 6 })}<small>mm</small></dd></div><div><dt>最大应力</dt><dd>{analysis.result.maxStressMPa.toLocaleString('zh-CN', { maximumFractionDigits: 6 })}<small>MPa</small></dd></div></dl><p>这些数值由 Mock 生成，并非真实有限元求解结果。</p><time dateTime={analysis.result.executedAt}>{new Date(analysis.result.executedAt).toLocaleString('zh-CN')}</time></div> : <div className="software-analysis-result is-empty"><strong>尚无模拟结果</strong><p>运行结束后显示模拟结果，可导出 JSON 保存到工作区。</p></div>}</section> : <>
        <div className="software-tools"><button type="button" disabled={!canModify || !supports('shape.add')} onClick={() => { void invoke('shape.add', { kind: 'rectangle', x: 100, y: 100, width: 150, height: 90, label: `矩形 ${seat.document.shapes.length + 1}` }); }}><svg viewBox="0 0 18 18" aria-hidden="true"><rect x="3" y="4" width="12" height="10" rx="1" /></svg>添加矩形</button><button type="button" disabled={!canModify || !supports('shape.add')} onClick={() => { void invoke('shape.add', { kind: 'circle', x: 290, y: 120, width: 90, height: 90, label: `圆形 ${seat.document.shapes.length + 1}` }); }}><svg viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="5.5" /></svg>添加圆形</button><button type="button" className="software-delete-shape" disabled={!canModify || !selectedShape || !supports('shape.delete')} onClick={() => { if (selectedShape) void invoke('shape.delete', { id: selectedShape.id }); }}>删除选中</button></div>
        <div className={`software-viewport${canModify ? ' is-editable' : ''}`}>
          <svg ref={svg} viewBox="0 0 600 400" role="group" aria-label={`${image.name} 模拟画布，${seat.document.shapes.length} 个图形`} onPointerMove={event => {
            if (!drag || event.pointerId !== drag.pointerId || !canModify) return;
            const point = position(event.clientX, event.clientY); if (!point) return;
            const shape = seat.document.shapes.find(row => row.id === drag.id); if (!shape) return;
            setDrag({ ...drag, x: Math.max(0, Math.min(600 - shape.width, drag.originX + point.x - drag.startX)), y: Math.max(0, Math.min(400 - shape.height, drag.originY + point.y - drag.startY)) });
          }} onPointerUp={event => {
            if (!drag || event.pointerId !== drag.pointerId) return;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
            setDrag(undefined);
            if (canModify && (Math.abs(drag.x - drag.originX) > .5 || Math.abs(drag.y - drag.originY) > .5)) { skipCanvasClick.current = true; void invoke('shape.update', { id: drag.id, x: Math.round(drag.x * 10) / 10, y: Math.round(drag.y * 10) / 10 }, drag.revision); }
          }} onPointerCancel={() => setDrag(undefined)} onClick={event => { if (skipCanvasClick.current) { skipCanvasClick.current = false; return; } if ((event.target as Element).getAttribute('data-background') === 'true') setSelected(''); }}>
            <defs><pattern id={`software-grid-${task.code}`} width="25" height="25" patternUnits="userSpaceOnUse"><path d="M25 0H0V25" fill="none" stroke="#e8edf3" strokeWidth=".7" /></pattern></defs>
            <rect data-background="true" width="600" height="400" fill={`url(#software-grid-${task.code})`} />
            <path d="M20 370h32m-32 0v-32" className="software-origin" /><text x="56" y="374" className="software-axis-label">X</text><text x="16" y="332" className="software-axis-label">Y</text>
            {seat.document.shapes.map(shape => {
              const x = drag?.id === shape.id ? drag.x : shape.x, y = drag?.id === shape.id ? drag.y : shape.y;
              return <g key={shape.id} tabIndex={0} role="button" aria-label={`选择${shape.kind === 'circle' ? '圆形' : '矩形'}：${shape.label || shape.id}`} aria-pressed={selected === shape.id} className={`software-shape${selected === shape.id ? ' is-selected' : ''}`} onPointerDown={event => {
                if (event.button !== 0) return; event.stopPropagation(); setSelected(shape.id);
                if (!canModify || !supports('shape.update')) return;
                const point = position(event.clientX, event.clientY); if (!point) return;
                svg.current?.setPointerCapture(event.pointerId);
                setDrag({ id: shape.id, pointerId: event.pointerId, startX: point.x, startY: point.y, originX: shape.x, originY: shape.y, x: shape.x, y: shape.y, revision: seat.document.revision });
              }} onClick={event => { event.stopPropagation(); setSelected(shape.id); }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelected(shape.id); } }}>
                <title>{shape.label || '未命名图形'} · {shape.width} × {shape.height} mm</title>
                {shape.kind === 'circle' ? <ellipse cx={x + shape.width / 2} cy={y + shape.height / 2} rx={shape.width / 2} ry={shape.height / 2} /> : <rect x={x} y={y} width={shape.width} height={shape.height} rx="2" />}
                <text x={x + shape.width / 2} y={y + shape.height / 2 + 4} textAnchor="middle">{shape.label.slice(0, 22)}</text>
                {selected === shape.id && <rect className="software-selection" x={x - 5} y={y - 5} width={shape.width + 10} height={shape.height + 10} />}
              </g>;
            })}
            {!seat.document.shapes.length && <text x="300" y="202" textAnchor="middle" className="software-canvas-hint">{connecting ? '正在准备模拟工作台…' : '添加一个图形，开始测试工作流程'}</text>}
          </svg>
          <span className="software-canvas-mark">MOCK · 非工程 CAD</span>
        </div>
        <section className="software-inspector" aria-label="图形参数"><header><strong>图形参数</strong><select aria-label="选择图形" value={selected} onChange={event => setSelected(event.target.value)}><option value="">未选择图形</option>{seat.document.shapes.map(shape => <option key={shape.id} value={shape.id}>{shape.label || '未命名图形'}</option>)}</select></header>
          {shapeDraft ? <form onSubmit={event => { event.preventDefault(); if (shapeValid && dirtyShape) void invoke('shape.update', { id: shapeDraft.id, x: shapeDraft.x, y: shapeDraft.y, width: shapeDraft.width, height: shapeDraft.height, label: shapeDraft.label }, shapeRevision); }}><div className="software-parameter-grid">{(['x', 'y', 'width', 'height'] as const).map(key => <label key={key}>{({ x: 'X', y: 'Y', width: '宽度', height: '高度' })[key]} <span>mm</span><input type="number" aria-label={`图形${({ x: 'X坐标', y: 'Y坐标', width: '宽度', height: '高度' })[key]}`} value={Number.isFinite(shapeDraft[key]) ? shapeDraft[key] : ''} step="0.1" disabled={!canModify || !supports('shape.update')} onChange={event => { const value = event.currentTarget.value === '' ? NaN : Number(event.currentTarget.value); setShapeDraft(previous => previous ? { ...previous, [key]: value } : previous); }} /></label>)}</div><div className="software-label-row"><label>名称<input aria-label="图形名称" value={shapeDraft.label} maxLength={80} disabled={!canModify || !supports('shape.update')} onChange={event => { const label = event.currentTarget.value; setShapeDraft(previous => previous ? { ...previous, label } : previous); }} /></label><button type="submit" className="software-primary" disabled={!canModify || !shapeValid || !dirtyShape || !supports('shape.update')}>应用参数</button></div></form> : <p>在画布或列表中选择图形，查看与修改参数。</p>}
        </section>
        </>}
        <form className="software-document-name" onSubmit={event => { event.preventDefault(); if (nameDraft.trim() && nameDraft.trim() !== seat.document.name) void invoke('document.rename', { name: nameDraft.trim() }); }}><label>文档名称<input aria-label="Mock文档名称" value={nameDraft} maxLength={80} disabled={!canModify || !supports('document.rename')} onChange={event => { setNameDraft(event.target.value); setNameDirty(true); }} /></label><button type="submit" disabled={!canModify || !nameDraft.trim() || nameDraft.trim() === seat.document.name || !supports('document.rename')}>保存名称</button></form>
        <section className="software-operations" aria-label="软件操作"><header><strong>操作进度</strong><small>{running.length ? `${running.length} 项进行中` : 'Bridge 调用记录'}</small></header>{recentOperations.length ? <ul>{recentOperations.map(operation => <li key={operation.id}><div><span>{operationNames[operation.capability] || operation.capability}</span><small className={`software-operation-state is-${operation.state}`}>{operationStates[operation.state]}{isRunning(operation) ? ` · ${Math.round(Math.max(0, Math.min(1, operation.progress)) * 100)}%` : ''}</small></div>{isRunning(operation) && <progress aria-label={`${operationNames[operation.capability] || operation.capability}进度`} max={1} value={Math.max(0, Math.min(1, operation.progress))} />}{operation.error && <p>{operation.error.message}</p>}{isRunning(operation) && <button type="button" disabled={busy || !writable} onClick={() => { void run(async () => { await api('software/cancel', { taskId, imageId, operationId: operation.id }); }); }}>取消操作</button>}</li>)}</ul> : <p>软件操作或导出文档后，会在这里显示执行进度。</p>}</section>
        <section className="software-artifacts" aria-label="软件产物"><header><strong>生成的产物</strong><div><button type="button" disabled={!canModify || !supports('document.export')} onClick={() => { void invoke('document.export', { format: 'json' }); }}>导出 JSON</button>{!isSimulation && <button type="button" disabled={!canModify || !supports('document.export')} onClick={() => { void invoke('document.export', { format: 'svg' }); }}>导出 SVG</button>}</div></header>{seat.artifacts.length ? <ul>{seat.artifacts.map(artifact => <li key={artifact.id}><div><strong>{artifact.name}</strong><small>文档 v{artifact.documentRevision} · {formatBytes(artifact.bytes)}</small>{savedArtifacts[artifact.id] && <small className="software-artifact-saved">已保存：{savedArtifacts[artifact.id]}</small>}</div><button type="button" disabled={busy || !writable || !usable || !!savedArtifacts[artifact.id]} onClick={() => {
          const stamp = generation.current;
          void run(async () => { const saved = await api<{ path: string; version: string }>('software/artifact', { taskId, imageId, artifactId: artifact.id }); if (valid(stamp)) { setSavedArtifacts(previous => ({ ...previous, [artifact.id]: saved.path })); setNotice(`已保存到任务文件：${saved.path}`); onArtifactsSaved(); } });
        }}>{savedArtifacts[artifact.id] ? '已保存' : '保存到工作区'}</button></li>)}</ul> : <p>导出当前模拟文档，再将产物保存到任务工作空间。</p>}</section>
        <details ref={recordPanel} className="software-records"><summary><span>操作记录</span><small>{records.length} 条</small></summary><label className="software-recorder"><input type="checkbox" checked={seat.recorderEnabled} disabled={busy || !writable || !usable} onChange={event => {
          const enabled = event.target.checked, stamp = generation.current;
          void run(async () => { const result = await api<{ seat: StudioSeatView }>('software/recorder', { taskId, imageId, enabled }); if (valid(stamp)) setSeat(result.seat); });
        }} />记录后续操作</label>{records.length ? <ol>{records.slice(-20).reverse().map(record => <li key={record.sequence}><time dateTime={record.timestamp}>{new Date(record.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}</time><span>{record.detail || record.event}</span><small>{record.actor === 'agent' ? 'Agent' : record.actor === 'human' ? '你' : '平台'} · v{record.documentRevision}</small></li>)}</ol> : <p>启用记录后，可以查看人和 Agent 的操作过程。</p>}</details>
      </div>
    </>}
  </section>;
}
