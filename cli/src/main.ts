/** `harnessstudio run`: arguments, checks before anything starts, signals, and the exit code (cli/设计.md §7). */
import { resolve } from 'node:path';
import { CommandError, USAGE, parseArgs, type RunOptions } from './args.ts';
import { batchHeader, planSettings, prepareNew, prepareResume, readState, runBatch, type ResumePlan } from './batch.ts';
import { loadManifest } from './manifest.ts';
import { issueText, type Issue } from './spec.ts';
import { Progress, type Output } from './progress.ts';
import { ConnectionError, Studio, StudioError, catalog, normalizeUrl } from './studio.ts';
import type { Timings } from './task.ts';
import { folderStamp } from './text.ts';
import type { BatchState } from './types.ts';

export interface MainEnv {
  argv: readonly string[]; env: NodeJS.ProcessEnv; cwd: string; stdout: Output; stderr: Output;
  /** Interruption (Ctrl+C or a stop request): the first aborts this, a second exits at once. */
  signals: { on(listener: () => void): void };
  exit(code: number): never;
  timings?: Timings;
}

export async function main(io: MainEnv): Promise<number> {
  const say = (text: string) => io.stdout.write(`${text}\n`), complain = (text: string) => io.stderr.write(`${text}\n`);
  let started = false;
  const interrupt = new AbortController();
  io.signals.on(() => {
    if (!started) { complain('\n已取消，没有启动任何任务。'); io.exit(130); }
    if (interrupt.signal.aborted) { complain('\n立即退出。没有导出的轨迹可以稍后在网页上导出。'); io.exit(130); }
    complain('\n正在停止本次启动的运行，并导出已有的轨迹……再按一次 Ctrl+C 立即退出。');
    interrupt.abort();
  });
  try {
    const parsed = parseArgs(io.argv);
    if ('help' in parsed) { say(USAGE); return 0; }
    const options: RunOptions = parsed;
    const url = options.url ?? io.env.HARNESSSTUDIO_URL;
    if (!url) throw new CommandError('不知道要连哪台 Studio：请用 harnessstudio run 运行，或用 --url 指定地址');
    const studio = new Studio(url), publicBase = io.env.HARNESSSTUDIO_PUBLIC_URL ? normalizeUrl(io.env.HARNESSSTUDIO_PUBLIC_URL) : studio.base;
    const resumeDirectory = options.resume === undefined ? undefined : resolve(io.cwd, options.resume);
    if (resumeDirectory && options.out !== undefined && resolve(io.cwd, options.out) !== resumeDirectory) throw new CommandError('--resume 时结果写回原来的文件夹，不能再用 --out 指定别的文件夹');
    const previous: BatchState | undefined = resumeDirectory ? await readState(resumeDirectory) : undefined;
    const manifestPath = resolve(io.cwd, options.manifest ?? previous!.manifest.path);

    const loaded = await loadManifest(manifestPath, io.cwd), issues: Issue[] = [...loaded.issues];
    let models;
    try { models = catalog(await studio.models(), await studio.status()); await studio.get('autonomy/settings'); }
    catch (error) {
      for (const issue of issues) complain(`  ${issueText(issue)}`);
      if (error instanceof StudioError && error.status === 404) throw new CommandError(`${studio.base} 上的 Studio 没有自主模式，版本太旧，批量命令用不了`);
      throw new CommandError(error instanceof StudioError ? `Studio 拒绝了请求：${error.message}` : (error as Error).message);
    }
    // Models are checked for every task that could be read, so one pass lists every problem (§7.2).
    const plan = planSettings(loaded.tasks, models);
    issues.push(...plan.issues);
    if (issues.length || !loaded.manifest) {
      complain(`任务清单 ${manifestPath} 有 ${issues.length} 处问题，一个任务都没有启动：`);
      for (const issue of issues) complain(`  ${issueText(issue)}`);
      return 1;
    }
    const manifest = loaded.manifest, status = await studio.status();
    if (status.softwareBackend === 'none' && manifest.tasks.some(task => task.budget.vms !== undefined)) say('提示：这台 Studio 没有接入软件和虚拟机，清单里的 budget.vms 不起作用。');

    let directory: string, state: BatchState, resumed: ResumePlan | undefined;
    if (resumeDirectory) {
      directory = resumeDirectory;
      resumed = await prepareResume(directory, previous!, manifest, studio);
      state = resumed.state;
      for (const note of resumed.notes) say(`提示：${note}`);
    } else {
      directory = resolve(io.cwd, options.out ?? `harnessstudio-runs/${folderStamp(new Date())}`);
      state = await prepareNew(directory, manifest, studio.base, options.noVideo);
    }
    state.noVideo = options.noVideo;
    const parallel = options.parallel ?? manifest.parallel, todo = state.tasks.filter(record => record.status !== 'completed' && record.status !== 'needs-human' && record.status !== 'failed').length;
    say(`连接 ${studio.base}，${todo ? `开始跑 ${todo} 个任务（同时 ${parallel} 个）` : '没有要跑的任务'}，结果写在 ${directory}`);
    const progress = new Progress(io.stdout, () => batchHeader(state.tasks));
    started = true;
    let outcome;
    try {
      outcome = await runBatch({ studio, publicBase, manifest, settings: plan.settings, directory, state, noVideo: options.noVideo, parallel, interrupt: interrupt.signal, progress, ...status.softwareBackend ? { softwareBackend: status.softwareBackend } : {},
        ...io.timings ? { timings: io.timings } : {}, ...resumed ? { attach: resumed.attach, earlier: resumed.earlier } : {} });
    } finally { progress.close(); }
    say(`\n${outcome.table}\n`);
    say(`结果文件夹：${directory}`);
    if (outcome.interrupted) say(`已中断。接着跑：harnessstudio run ${options.manifest ?? manifestPath} --resume ${directory}`);
    else if (outcome.code === 2) say('有任务需要人或失败：打开上面的网页链接查看，处理后可以在网页上让它继续。');
    return outcome.code;
  } catch (error) {
    if (error instanceof CommandError || error instanceof ConnectionError) { complain(error.message); return 1; }
    if (error instanceof StudioError) { complain(`Studio 拒绝了请求：${error.message}`); return 1; }
    complain(`出错了：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    return 1;
  }
}
