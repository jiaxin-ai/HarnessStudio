import { useEffect, useId, useRef, useState } from 'react';
import type { RecordingStep, VmRecording } from '../../studio/src/seat-types.ts';
import { api } from './api.ts';

const recordingStates = { recording: '采集中', stopped: '已停止', failed: '失败' };
const actors = { agent: 'Agent', human: '人工' };
const PAGE = 200;
const fileUrl = (taskId: string, recordingId: string, path: string) => `/api/studio/software/recording-file?${new URLSearchParams({ taskId, recordingId, path })}`;
const zipUrl = (taskId: string, recordingId: string) => `/api/studio/software/recording-zip?${new URLSearchParams({ taskId, recordingId })}`;
const clock = (value: string) => new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
const duration = (seconds: number) => `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒`;
const size = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(0.1, bytes / 1024 ** 2).toFixed(1)} MB`;

/** What a finished recording contains: steps by actor, length, checkpoints and size. */
export function RecordingSummary({ recording }: { recording: VmRecording }) {
  const episode = recording.episode;
  if (recording.status === 'recording') return <span className="recording-summary">采集中，停止后可回放</span>;
  if (episode === undefined) return null;
  if (!episode) return <span className="recording-summary">还没有采集结果</span>;
  if (!episode.trajectory) return <span className="recording-summary">轨迹尚未生成{episode.screenshots ? `，已有 ${episode.screenshots} 张截图` : ''}</span>;
  return <span className="recording-summary">{episode.steps} 步（Agent {episode.agentSteps} / 人工 {episode.humanSteps}）{episode.durationSeconds !== null ? ` · ${duration(episode.durationSeconds)}` : ''}{episode.milestones.length ? ` · 检查点 ${episode.milestones.length}` : ''} · {size(episode.bytes)}</span>;
}

/** Replay and download of one recording. */
export function RecordingActions({ taskId, recording, onOpen }: { taskId: string; recording: VmRecording; onOpen(): void }) {
  if (recording.status === 'recording' || !recording.episode?.trajectory) return null;
  return <span className="recording-actions">
    <button type="button" className="software-text-button" onClick={onOpen}>回放</button>
    <a className="software-text-button" href={zipUrl(taskId, recording.id)} download={`trajectory-${recording.id}.zip`} title="整个采集目录，解压后打开 trajectory.html 也能离线回放">下载 ZIP</a>
  </span>;
}

/** Recording replay: the screen video beside the trajectory steps, each labelled as the Agent's or the human's. */
export function RecordingViewer({ taskId, recording, onClose }: { taskId: string; recording: VmRecording; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null), video = useRef<HTMLVideoElement>(null), titleId = useId();
  const [steps, setSteps] = useState<RecordingStep[]>([]), [total, setTotal] = useState(0), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [filter, setFilter] = useState<'all' | 'agent' | 'human'>('all'), [selected, setSelected] = useState<RecordingStep>();
  const load = async (offset: number) => {
    setLoading(true); setError('');
    try {
      const page = await api<{ total: number; steps: RecordingStep[] }>(`software/recording?${new URLSearchParams({ taskId, recordingId: recording.id, offset: String(offset), limit: String(PAGE) })}`, undefined, { timeoutMs: 60000 });
      setTotal(page.total); setSteps(previous => offset ? [...previous, ...page.steps] : page.steps);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '读取轨迹失败'); } finally { setLoading(false); }
  };
  useEffect(() => {
    const previous = document.activeElement; dialog.current?.showModal(); void load(0);
    return () => { dialog.current?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, [taskId, recording.id]);
  const choose = (step: RecordingStep) => {
    setSelected(step);
    if (video.current && step.videoTime !== null) { video.current.currentTime = step.videoTime; void video.current.play().catch(() => undefined); }
  };
  const shown = steps.filter(step => filter === 'all' || step.actor === filter), episode = recording.episode;
  return <dialog ref={dialog} className="recording-viewer" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header>
      <h2 id={titleId}>轨迹回放<small>{recording.id} · {recordingStates[recording.status]} · {new Date(recording.startedAt).toLocaleString('zh-CN', { hour12: false })}</small></h2>
      {episode && <RecordingSummary recording={recording} />}
      <a className="software-text-button" href={zipUrl(taskId, recording.id)} download={`trajectory-${recording.id}.zip`}>下载 ZIP</a>
      <button type="button" onClick={onClose}>关闭</button>
    </header>
    <div className="recording-viewer-body">
      <section className="recording-media" aria-label="屏幕录像">
        {episode?.video ? <video ref={video} controls preload="metadata" src={fileUrl(taskId, recording.id, 'recording.mp4')} /> : <p className="software-readonly">这次采集没有录像。</p>}
        {selected?.screenshot && <figure><img src={fileUrl(taskId, recording.id, selected.screenshot)} alt={`第 ${selected.id} 步截图`} loading="lazy" /><figcaption>第 {selected.id} 步 · {selected.action}</figcaption></figure>}
        {episode?.milestones.length ? <p className="recording-milestones">检查点：{episode.milestones.join('、')}</p> : null}
      </section>
      <section className="recording-steps" aria-label="轨迹步骤">
        <div className="recording-filter" role="radiogroup" aria-label="按操作者筛选">
          {(['all', 'agent', 'human'] as const).map(value => <label key={value}><input type="radio" name={`${titleId}-filter`} checked={filter === value} onChange={() => setFilter(value)} />{value === 'all' ? '全部' : actors[value]}</label>)}
          <small>{steps.length < total ? `已载入 ${steps.length} / ${total} 步` : `共 ${total} 步`}</small>
        </div>
        {error && <p className="software-warning" role="status">{error}</p>}
        <ol>{shown.map(step => <li key={step.id} className={`${step.actor ? `is-${step.actor}` : ''}${selected?.id === step.id ? ' is-selected' : ''}`}>
          <button type="button" onClick={() => choose(step)} title={step.videoTime !== null ? '在录像中跳到这一步' : undefined}>
            <span className="recording-step-head"><code>#{step.id}</code><time dateTime={step.time}>{clock(step.time)}</time>{step.actor && <span className={`recording-actor is-${step.actor}`}>{actors[step.actor]}</span>}{step.milestone !== null && <span className="recording-milestone">检查点 {step.milestone}</span>}</span>
            <span className="recording-step-action">{step.action}</span>
            {step.window && <small>{step.window}</small>}
            {step.operation && <small>{step.operation.tool}{step.operation.summary ? `：${step.operation.summary}` : ''}</small>}
            {step.files.length > 0 && <small>文件：{step.files.join('、')}</small>}
          </button>
        </li>)}</ol>
        {loading ? <p role="status">正在读取轨迹…</p> : steps.length < total && <button type="button" onClick={() => void load(steps.length)}>继续载入</button>}
        {!loading && !error && !total && <p className="software-readonly">这次采集没有记录到操作步骤。</p>}
      </section>
    </div>
  </dialog>;
}

/** Every recording of a task, for its completion record; empty when the software backend has no recordings. */
export function TaskRecordings({ taskId }: { taskId: string }) {
  const [recordings, setRecordings] = useState<VmRecording[]>(), [open, setOpen] = useState<VmRecording>();
  useEffect(() => {
    let valid = true; setRecordings(undefined);
    void api<{ recordings: VmRecording[] }>(`software/recordings?${new URLSearchParams({ taskId })}`, undefined, { timeoutMs: 60000 }).then(value => { if (valid) setRecordings(value.recordings); }, () => { if (valid) setRecordings([]); });
    return () => { valid = false; };
  }, [taskId]);
  if (!recordings?.length) return null;
  return <div className="completion-recordings" aria-label="轨迹采集"><small>轨迹采集 · {recordings.length} 条</small>
    <ol>{recordings.map(row => <li key={row.id}><span><code>{row.id}</code> · {row.vmId} · {new Date(row.startedAt).toLocaleString('zh-CN', { hour12: false })} · {recordingStates[row.status]}</span><RecordingSummary recording={row} />{row.error && <small>{row.error}</small>}<RecordingActions taskId={taskId} recording={row} onOpen={() => setOpen(row)} /></li>)}</ol>
    {open && <RecordingViewer taskId={taskId} recording={open} onClose={() => setOpen(undefined)} />}
  </div>;
}
