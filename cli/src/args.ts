/** Errors the person can fix: printed as they are, exit code 1, no stack trace. */
export class CommandError extends Error { override name = 'CommandError'; }

export interface RunOptions { manifest?: string; url?: string; parallel?: number; out?: string; resume?: string; noVideo: boolean }

export const USAGE = `用法：harnessstudio run tasks.yaml [选项]

  --url 地址       连接这台 Studio（默认用本机配置的实例）
  --parallel 数量  同时跑几个任务（优先于清单里的 parallel）
  --out 文件夹     结果放在这里（默认 ./harnessstudio-runs/<时间>/）
  --resume 文件夹  接着上次的结果继续，只跑没跑完的任务
  --no-video       导出轨迹时不带录屏
  --help           显示这段说明

退出码：0 全部完成；2 有任务需要人或失败；1 命令出错；130 被中断。`;

const VALUE_OPTIONS = ['--url', '--parallel', '--out', '--resume'];
export function parseArgs(argv: readonly string[]): RunOptions | { help: true } {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h') return { help: true };
  if (command !== 'run') throw new CommandError(`不认识的命令：${command}\n\n${USAGE}`);
  const options: RunOptions = { noVideo: false };
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]!;
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--no-video') { options.noVideo = true; continue; }
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('='), name = equals < 0 ? arg : arg.slice(0, equals);
      if (!VALUE_OPTIONS.includes(name)) throw new CommandError(`不认识的选项：${name}\n\n${USAGE}`);
      const value = equals < 0 ? rest[++index] : arg.slice(equals + 1);
      if (!value) throw new CommandError(`${name} 后面要写一个值`);
      if (name === '--url') options.url = value;
      else if (name === '--out') options.out = value;
      else if (name === '--resume') options.resume = value;
      else {
        const parallel = Number(value);
        if (!Number.isInteger(parallel) || parallel < 1 || parallel > 20) throw new CommandError('--parallel 要写 1 到 20 之间的整数');
        options.parallel = parallel;
      }
      continue;
    }
    if (options.manifest !== undefined) throw new CommandError(`只能指定一份任务清单，多写了：${arg}`);
    options.manifest = arg;
  }
  if (options.manifest === undefined && options.resume === undefined) throw new CommandError(`请指定任务清单。\n\n${USAGE}`);
  return options;
}
