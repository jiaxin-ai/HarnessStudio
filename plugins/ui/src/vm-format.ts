import type { SoftwareDescriptor, StudioVmSeatView } from '../../studio/src/seat-types.ts';

export const vmStates = { provisioning: '正在准备', ready: '运行中', stopping: '正在停止', stopped: '已停止', failed: '失败' };
/** vm_manager error codes of a failed VM, worded by when it failed. */
const failures: Record<string, string> = { HEALTH_CHECK_FAILED: '运行中失败：健康检查失败', CONTAINER_EXITED: '运行中失败：容器退出', STARTUP_TIMEOUT: '启动失败：开机超时', PROVISION_FAILED: '启动失败：创建容器失败', HOST_NOT_READY: '启动失败：宿主机未就绪', QUEUE_TIMEOUT: '排队超时' };
export const vmStateLabel = (seat: Pick<StudioVmSeatView, 'state' | 'error' | 'unreachableSince' | 'queue'>) => seat.state === 'failed' ? failures[seat.error?.code ?? ''] ?? '失败' : seat.state === 'ready' && seat.unreachableSince ? '运行中 · 暂无响应' : seat.state === 'provisioning' && seat.queue ? `排队第 ${seat.queue.position} 位` : vmStates[seat.state];
/** Run limits offered for VMs (vm_manager accepts 1–10080 minutes). */
export const RUN_OPTIONS = [30, 60, 120, 240, 480, 720, 1440, 4320, 10080];
export const DEFAULT_RUN_MINUTES = 120, MAX_RUN_MINUTES = 10080;
export const formatMinutes = (minutes: number) => minutes % 1440 === 0 ? `${minutes / 1440} 天` : minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`;
export const formatShort = (value: string | number) => new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
/** The tab name: one program with its version, several by name. */
export function softwareShortName(software: SoftwareDescriptor | undefined, fallback: string) {
  const items = software?.vm?.software ?? [];
  return items.length === 1 ? `${items[0]!.name} ${items[0]!.version}` : items.length ? items.map(item => item.name).join('+') : software?.name ?? fallback;
}
