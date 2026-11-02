/** Versioned platform contract. Software is simulated; transport and lifecycle are real.
 * GET /v1/images (available installed images); GET /v1/software compatibility alias;
 * POST /v1/seats {requestId,imageId,taskId,projectId} (softwareId remains a compatibility alias);
 * GET/DELETE /v1/seats/:id; DELETE /v1/seats/:id?purge=true permanently erases identity/history;
 * GET /v1/seats/:id/connection;
 * POST /v1/seats/:id/control {actor,ownerId,ttlMs?,takeover?};
 * DELETE /v1/seats/:id/control {token}; POST /v1/seats/:id/operations;
 * GET /v1/seats/:id/operations/:operationId; POST .../:operationId/cancel;
 * GET /v1/seats/:id/operations includes a bounded display window and complete unknown IDs;
 * GET /v1/seats/:id/operations/request/:requestId returns an exact full-history receipt or null;
 * GET /v1/seats/:id/artifacts/:artifactId; GET /v1/seats/:id/events (SSE);
 * POST /v1/seats/:id/recorder {enabled}; GET /v1/seats/:id/records;
 * POST /v1/seats/:id/fault {mode,delayMs?} (Mock-only).
 * All API calls use Bearer service authentication; task identity is immutable.
 */
export const SEAT_API_VERSION = '1' as const;
export type SeatState = 'provisioning' | 'ready' | 'failed' | 'released';
export type ControlActor = 'human' | 'agent';
export type OperationState = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'unknown';
export type MockFault = 'none' | 'provision-failed' | 'resource-exhausted' | 'operation-failed' | 'timeout' | 'unknown';
export interface SoftwareCapability { id: string; title: string; mutates: boolean; description: string }
export interface SoftwareDescriptor { id: string; name: string; version: string; mock: boolean; imageRef: string; category: 'mechanical' | 'simulation' | 'drafting' | 'electronics' | 'rendering'; workbench: 'drawing' | 'simulation'; description: string; aliases?: string[]; capabilities: SoftwareCapability[]; backend?: SeatBackend; vm?: VmEnvironmentInfo }
export interface ControlLease { actor: ControlActor; ownerId: string; revision: number; token: string; expiresAt: string }
export interface MockShape { id: string; kind: 'rectangle' | 'circle'; x: number; y: number; width: number; height: number; label: string }
export interface MockAnalysis { type: 'static' | 'modal'; loadN: number; elasticModulusMPa: number; meshSizeMm: number; result?: { mock: true; executedAt: string; maxDisplacementMm: number; maxStressMPa: number } }
export interface MockDocument { name: string; revision: number; units: 'mm'; shapes: MockShape[]; modifiedAt: string; kind?: 'drawing' | 'simulation'; analysis?: MockAnalysis }
export interface SeatArtifact { id: string; name: string; mediaType: string; bytes: number; sha256: string; createdAt: string; documentRevision: number }
export interface ArtifactContent extends SeatArtifact { content: string }
export interface SeatView { id: string; apiVersion: '1'; softwareId: string; taskId: string; projectId: string; state: SeatState; revision: number; createdAt: string; updatedAt: string; mock: true; document: MockDocument; control: ControlLease | null; artifacts: SeatArtifact[]; recorderEnabled: boolean; fault: MockFault; error?: PlatformError }
export interface PlatformError { code: string; message: string; retryable: boolean }
export interface PlatformConnection { seatId: string; protocol: 'sse'; display: 'mock-scene'; eventsPath: string; expiresAt: string; credential: string; capabilities: string[] }
export interface BridgeRequest { requestId: string; capability: string; parameters: Record<string, unknown>; controlToken?: string; expectedDocumentRevision?: number }
export interface BridgeOperation { id: string; seatId: string; requestId: string; capability: string; state: OperationState; progress: number; createdAt: string; updatedAt: string; result?: Record<string, unknown>; error?: PlatformError }
/** History is a UI window; the separately complete unknown ID index governs safety. */
export interface BridgeOperationIndex { operations: BridgeOperation[]; unknownOperationIds: string[]; unknownOperationIdsComplete: true }
export interface SeatRecord { sequence: number; timestamp: string; event: string; actor?: ControlActor; ownerId?: string; operationId?: string; documentRevision: number; detail?: string }
/** Browser-facing view never exposes platform bearer, connection credentials or lease tokens. */
export type StudioSeatView = Omit<SeatView, 'control'> & { control: Omit<ControlLease, 'token'> | null; software: SoftwareDescriptor; operations: BridgeOperation[]; unacknowledgedUnknownIds: string[]; unknownOperationIndexComplete: boolean; canEdit: boolean; connection: { protocol: 'sse'; display: 'mock-scene'; eventsPath: string } };

/** vm_manager v1 (api.md): one software environment is one preinstalled Windows VM, operated by a human over noVNC.
 * GET /v1/environments; GET/POST /v1/vms; GET /v1/vms/:id; POST /v1/vms/:id/start|stop; DELETE /v1/vms/:id;
 * POST /v1/vms/:id/recordings; GET /v1/recordings?vm_id=; POST /v1/recordings/:id/stop. No authentication,
 * control lease, Bridge or artifacts; POST /v1/vms is not idempotent and stop/delete block up to ~2 minutes. */
export type SeatBackend = 'mock' | 'vm-manager';
/** The deployment's software backend (STUDIO_SEAT_BACKEND). 'none': no software at all, neither Mock nor VMs; task and project
 * files live in Studio's data volume and the Agent works with the Linux sandbox and the web only. */
export type SoftwareBackend = 'none' | SeatBackend;
export const SOFTWARE_BACKENDS: readonly SoftwareBackend[] = ['none', 'mock', 'vm-manager'];
export interface VmEnvironmentInfo { os: string; software: { name: string; version: string }[]; minSpec: { cpuCores: number; ramGb: number } }
/** queued/creating/starting → provisioning, running → ready, stopping/deleting → stopping. */
export type VmSeatState = 'provisioning' | 'ready' | 'stopping' | 'stopped' | 'failed';
export interface StudioVmSeatView {
  backend: 'vm-manager'; id: string; softwareId: string; taskId: string; projectId: string; state: VmSeatState; vmStatus: string;
  /** Belongs to one task conversation ('chat'), or to none ('human': started before the software area followed
   * conversations); a conversation may own several VMs, also of one environment. */
  owner: 'human' | 'chat'; chatId: string | null; upstreamTaskIds: string[];
  /** Handover switch: 'human' refuses Agent input and execution on this VM; screenshots and UI trees stay readable. */
  controller: 'agent' | 'human';
  software: SoftwareDescriptor; spec: { cpuCores: number; ramGb: number };
  queue: { position: number; reason: string; expiresAt: string } | null; error: { code: string; message: string } | null;
  createdAt: string; startedAt: string | null; expiresAt: string | null; stoppedAt: string | null; stopReason: string | null;
  /** Run limit in minutes (vm_manager lifecycle.timeout_minutes); expiresAt is startedAt plus this. */
  runMinutes: number | null;
  /** Running, but the VM's agent service has not answered since then (Windows restarting); null when it answers. */
  unreachableSince: string | null;
  /** noVNC page and RDP address; ports change on every start, so only the latest view is valid. */
  access: { vncUrl: string | null; rdpAddress: string | null };
  workspace: { workspaceId: string; writable: boolean } | null; currentRecordingId: string | null; canEdit: boolean;
  /** The Agent's latest successful input or command on this VM (list views only). */
  lastAgentStep?: VmAgentStep | null;
  /** Windows evaluation licence as checked at the start of this run; null before the first check. */
  license: VmLicenseView | null;
}
/** checking/rearming: Studio is reading the licence or rearming and rebooting Windows (input is held back meanwhile);
 * ok: licensed for longer than the longest run; due: needs a rearm, but the VM has been running a while, so a user
 * confirms the reboot; exhausted: needs one and has no rearms left (recreate the VM); failed: the check or rearm failed. */
export interface VmLicenseView {
  state: 'checking' | 'rearming' | 'ok' | 'due' | 'exhausted' | 'failed';
  evaluation: boolean | null; licensed: boolean | null; daysLeft: number | null; rearms: number | null; checkedAt: string; error: string | null;
}
export interface VmAgentStep { at: string; tool: string; summary: string }
/** A background command in a VM (studio_vm_run background: true). interrupted: Windows restarted or the VM stopped
 * while it ran; unknown: its outcome cannot be known (now or ever); failed: it never started. */
export type VmJobState = 'starting' | 'running' | 'exited' | 'canceled' | 'timedOut' | 'interrupted' | 'unknown' | 'failed';
export interface VmJobView {
  jobId: string; vmId: string; chatId: string; command: string; state: VmJobState; stateText: string; returncode: number | null;
  createdAt: string; startedAt: string | null; endedAt: string | null; maxMinutes: number; canceledBy: 'agent' | 'human' | null;
  /** Why it ended other than by itself, or why its state is not known right now. */
  note: string | null;
  /** D:\.studio-jobs\<jobId> in the VM; taskPath is the same folder among the task files. */
  outputFolder: string; taskPath: string; outputRemoved: boolean;
  /** The end of its output, when it was just read. */
  stdout?: string; stderr?: string; stdoutBytes?: number; stderrBytes?: number;
}
/** vm_manager host capacity (allocation-based, not live usage) for the launch wizard; memory counts ramGb + overheadRamGb per VM. */
export interface VmResources {
  host: { cpu: { total: number; allocated: number; available: number }; memoryGb: { total: number; allocated: number; available: number }; diskGb: { total: number; used: number; available: number }; running: number; queued: number };
  overheadRamGb: number;
  /** How many VMs of each environment could start right now at its minimum spec. */
  environments: { id: string; launchable: number }[];
  /** Run-limit expiries of VMs holding resources, earliest first, with what each frees. */
  releases: { at: string; cpuCores: number; ramGb: number }[];
  checkedAt: string;
}
/** Completion/resume side effects on VMs and the D: drive, polled by the completion dialog. */
export interface VmTaskProgress { step: 'stopping' | 'freezing' | 'unfreezing' | 'snapshot' | 'failed'; detail: string; updatedAt: string }
export interface VmRecording {
  id: string; vmId: string; status: 'recording' | 'stopped' | 'failed'; startedAt: string; stoppedAt: string | null; resultPath: string; error: string | null;
  /** What the recorder wrote (vm-recordings.ts); null before anything is on the host, undefined without STUDIO_VMM_PROJECTS_ROOT. */
  episode?: RecordingEpisode | null;
}
/** One recording of the VM's trajectory recorder (winvm_traj_recorder) as found in its result directory. */
export interface RecordingEpisode {
  /** trajectory.jsonl exists: the recording was finished (stop, or rebuilt after the VM shut down). */
  trajectory: boolean; steps: number; agentSteps: number; humanSteps: number; durationSeconds: number | null;
  screenshots: number; video: boolean; milestones: string[]; agentOperations: number; bytes: number; taskTitle: string | null;
}
/** One trajectory step; actor is the Agent when the step falls in the window of an Agent operation that changes the VM. */
export interface RecordingStep {
  id: number; time: string; actor: 'agent' | 'human' | null; action: string; window: string | null;
  screenshot: string | null; videoTime: number | null; files: string[]; milestone: string | null;
  operation: { id: string; tool: string; summary: string; kind: string; chatId: string | null } | null;
}
