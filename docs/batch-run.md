# 批量命令 `harnessstudio run`

`harnessstudio run tasks.yaml` 读取一份任务清单，给每个任务在 Studio 里建一个项目，按自主模式跑完（总 Agent 规划、派子 Agent、自己判定完成），自动处理需要人的情况，把每个任务的完整轨迹导出到本地，最后打印汇总表。它不打分，结果由人在网页上查看，做得不好的点「继续修改」。设计约定见工作区的 `cli/设计.md` 第 7 节和第 10 节；自主模式本身见 `docs/autonomy.md`。用户说明由安装包统一提供。

## 组成

```
bin/harnessstudio run …（入口，bash）
  └─ docker run harnessstudio/cli:<版本> run …   （cli 镜像：只有 Node 和 cli/ 的依赖）
       └─ cli/bin/harnessstudio.ts ──HTTP──> Studio /api/studio/*
```

| 部分 | 代码 |
| --- | --- |
| 参数与入口 | `cli/bin/harnessstudio.ts`、`cli/src/args.ts`、`cli/src/main.ts` |
| 清单解析与校验 | `cli/src/manifest.ts`（读 YAML，唯一依赖 `yaml` 的模块）、`cli/src/spec.ts`（清单的类型和预算字段表） |
| Studio 接口、模型名解析 | `cli/src/studio.ts` |
| 每个任务的流程 | `cli/src/task.ts` |
| 整批、状态文件、续跑 | `cli/src/batch.ts` |
| 输出文件夹、汇总 | `cli/src/output.ts`；进度显示 `cli/src/progress.ts`；文字 `cli/src/text.ts`；读导出包 `cli/src/zip.ts` |
| 镜像 | `Dockerfile` 的 `cli` 目标；`.dockerignore` 放行 `cli/` 的源码和锁文件 |
| 示例 | `examples/tasks.yaml`、`examples/inputs/` |

- 客户端是独立的 Node 程序（ESM，TypeScript 只用可擦除语法，由 Node 24 直接运行，不需要编译），只通过 HTTP 调 Studio，不 import Studio 插件源码；接口类型在 `cli/src/types.ts` 里按 `autonomy-types.ts` 等手写。
- 依赖用 `cli/package.json` 和 `cli/package-lock.json`，与仓库根目录的依赖分开，改它们不会让 Studio 镜像的缓存失效。开发和测试前先 `npm ci --prefix cli`。

## 运行

正常由入口 `bin/harnessstudio run` 调用（见 `cli/设计.md` 7.1）：入口确认 Studio 可用、准备 `cli` 镜像，然后

```bash
docker run --rm --init [-it 仅在终端里] --network host --user "$(id -u):$(id -g)" \
  -v "$PWD:$PWD" -w "$PWD" [-v 清单所在目录:同路径:ro] -e HARNESSSTUDIO_URL=<地址> \
  harnessstudio/cli:<版本> run <原样传入的参数>
```

- 当前目录和清单所在目录以相同的绝对路径挂进容器，清单里的相对路径、输出目录不用转换；清单引用这两个目录以外的文件时报错并说明放到哪里。
- `--user` 让输出文件属于调用者；`--init` 让 Ctrl+C 和 `docker stop` 的信号送到客户端，客户端收尾后再退出。
- 开发时可以直接运行：`node cli/bin/harnessstudio.ts run tasks.yaml --url http://127.0.0.1:<端口>`。

| 环境变量 | 作用 |
| --- | --- |
| `HARNESSSTUDIO_URL` | 要连的 Studio（入口传入）；`--url` 优先 |
| `HARNESSSTUDIO_PUBLIC_URL` | 可选：写进 `result.json` 和汇总表的网页链接用这个地址（例如入口连 `127.0.0.1`，而别人要用局域网地址打开）；不设就和 `HARNESSSTUDIO_URL` 相同 |
| `TZ` | 可选：项目名和默认输出文件夹里的时间按它算；容器里不设时是 UTC（入口可传 `-e TZ` 或挂载 `/etc/localtime`） |

参数：`--url`、`--parallel N`（1–20，优先于清单）、`--out DIR`、`--resume DIR`、`--no-video`、`--help`。`--resume` 时清单可以省略（用上次记录的路径），也不能再用别的 `--out`。

## 清单字段

`defaults` 里的字段对所有任务生效；任务里写了同名字段（模型、`budget` 的单项）就以任务为准。未知字段、类型或范围不对、文件找不到、模型不存在，**全部一次列出**（带行号和任务名），有任何问题就一个任务都不启动，退出码 1。

| 字段 | 位置 | 含义 | 没写时 |
| --- | --- | --- | --- |
| `orchestratorModel` | defaults / 任务 | 总 Agent 的模型名；同名模型在多个 provider 时写 `provider/模型名` | Studio 的默认对话模型（`/api/studio/models` 的 `defaults`）；都没有就报错 |
| `workerModel` | defaults / 任务 | 子 Agent 的默认模型 | 与总 Agent 相同 |
| `workerModels` | defaults / 任务 | 总 Agent 可以给个别任务换用的模型列表 | Studio 的默认值（空） |
| `budget.tokens` | defaults / 任务 | 折算 token 预算（`tokenBudget`，自主模式 12.7），10,000 起 | Studio 的全局默认值 |
| `budget.hours` | 同上 | 运行时长（`maxHours`），0.1–720 | 同上 |
| `budget.vms` | 同上 | 同时占用的虚拟机（`maxVms`），0–20；没接 vm_manager 时不起作用，会提示一句 | 同上 |
| `budget.workers` | 同上 | 同时工作的子 Agent（`maxWorkers`），1–20 | 同上 |
| `budget.rounds` | 同上 | 总 Agent 的轮数上限（`maxRounds`），1–100,000 | 同上 |
| `budget.cacheReadWeight` | 同上 | 缓存读取的折算系数，0–1 | 同上 |
| `parallel` | defaults | 同时跑几个任务，1–20；`--parallel` 优先 | 1 |
| `projectPrefix` | defaults | 项目名前缀，项目名为 `<前缀> <MM-DD HH:mm> · <任务名>` | `批量` |
| `name` | 任务 | 任务名，清单内唯一，也用作输出子文件夹名 | 必填 |
| `goal` | 任务 | 运行目标；加上文件说明后不超过 8000 字 | 必填 |
| `files` | 任务 | 文件路径列表（相对清单所在目录），上传到项目公共空间根目录（有虚拟机时就是 F: 盘）；同一任务里文件名不能重复；单个不超过 1 GB；只接受文件，不接受文件夹 | 不上传 |

- 模型名对照的是网页上能选的模型：「模型配置」里各 provider 的模型，加上 smoke 测试适配器（Studio 加载了它们时：`m1-smoke`、`vision-smoke`）。provider 没填 API Key 也算问题。
- 有 `files` 时，运行目标末尾会加一句“已放到项目公共空间（虚拟机里的 F: 盘）根目录的文件：…”（无软件模式下没有括号里那半句），否则 Agent 不知道有这些文件。
- 项目公共空间在 vm-manager 后端（vm_manager 的 projects 目录）和无软件模式（Studio 数据卷的 `studio/files/`）都有；只有开发用的 Mock 后端没有，这时上传失败，这个任务记为“失败”，接着跑别的。

## 每个任务怎么跑

1. `POST /api/studio/projects` 建项目，`POST /api/studio/project/shared/upload?projectId=&path=` 逐个上传文件（流式，请求体就是文件内容）。
2. `POST /api/studio/autonomy/start`：`{projectId, objective, settings}`，整个项目范围（不传 `rootTaskId`）；`settings` 只含清单写了的项。
3. 每 3 秒 `GET /api/studio/autonomy/run?id=`，按下表处理：

| 情况 | 处理 | 结果 |
| --- | --- | --- |
| `completed` | — | 完成 |
| `question` 事项 | 自动回答（见下） | 回答后继续 |
| `blocked`、`stuck`、`budget`、`restart`、`incomplete` 事项；运行状态 `blocked` | `POST /api/studio/autonomy/stop`（revision 过期就重读再停，最多 4 次） | 需要人，原因是事项的说明文字；说明开头没有写明是什么情况时，前面加上类别（例如“子 Agent 报告需要人处理：”） |
| `stopped`（不是本命令停的） | — | 需要人：“有人在网页上停止了这个运行” |
| `failed` | — | 失败，原因是最近一条 `failed` 事件 |
| `paused`（`pauseReason: user`，有人在网页上暂停） | 等它继续或被停止，这期间仍占着一个并行名额 | 进度显示“已被人暂停，在等待” |
| 连不上 Studio | 继续重试，超过 5 分钟算失败 | 失败（运行可能还在 Studio 里继续） |

4. 结束后导出轨迹（下一节），读图谱（`GET /api/studio/graph`），写 `result.json`。

**自动回答提问**：问题来自事项的 `chatId` 对应的对话。`GET /api/studio/chat/questions?id=<chatId>` 取 `pending` 里 `canAnswer` 为真的问题，`POST /api/studio/chat/questions/answer` 提交 `{id: chatId, callId, answers}`，每个问题都回答 `{id, selected: [], custom: "没有更多信息，请按合理假设继续，并在结果里写明你的假设。"}`。DSH 的每个问题都允许只写自由文字、不选选项（`questions-validation.ts`），所以有选项的问题也这样回答，不替人选选项。带 `intent`（例如 `plan-review`，要人批准一个计划）的问题不自动回答，按“需要人”停下。问题 2 分钟内一直不能回答（没有 `canAnswer`）也按“需要人”处理。409（问题已结束或回答已排队）时不算错误，下一轮再看。每次自动回答记进 `result.json` 的 `autoAnswers`。

## 输出

```
harnessstudio-runs/20261101-093000/      # --out，默认 ./harnessstudio-runs/<YYYYMMDD-HHmmss>/
  batch-state.json                       # 续跑用；每次状态变化都原子写入
  summary.json  summary.csv              # 整批汇总（CSV 带 BOM，表格软件能直接打开中文）
  齿轮校核简报/
    result.json
    trajectory.zip                       # 项目导出，流式保存
    attempts/1/{result.json,trajectory.zip}   # 续跑重跑过时，上一次的文件
```

- **文件夹名**：任务名去掉 `/ \ : * ? " < > |` 和控制字符（换成 `_`），去掉首尾的空格和点，Windows 设备名（`CON`、`LPT1` 等）前加 `_`，最长约 120 字节；和已有的名字（不区分大小写）或 `summary.json`、`batch-state.json`、`attempts` 重名时加 `-2`、`-3`。原名保留在 `result.json` 的 `name` 里。
- **轨迹**：`GET /api/studio/project/export?projectId=&snapshots=1&video=1&workspace=1`（`--no-video` 时 `video=0`），流式写到 `trajectory.zip.part`，完成后改名。导出前先等这个运行的所有对话结束当前回合（`GET /api/studio/status` 里带这个 `runId` 的对话不是 `idle`/`stored`，最多等 60 秒）：运行刚结束时总 Agent 还在写最后一句回复，这时导出会漏掉它的对话（Studio 的导出自己也会等，客户端这一步让连较早的 Studio 时同样完整）。下载失败时等 5 秒重试一次，仍失败就写进 `trajectory.warnings`，任务结果不变。下载成功后读包里 `<根目录>/project.json` 的 `warnings`（导出自己说明的缺失，例如停止运行时被打断的模型调用），原样追加到 `trajectory.warnings`；这些不会因为再导出一次而消失，所以不重试。读 `project.json` 只读 ZIP 末尾的目录和这一个条目，不把整个文件读进内存，支持 ZIP64。
- **网页链接**：`<Studio 地址>/#project=<projectId>`，与 `plugins/ui/src/client.tsx` 的路由一致。

### `result.json`

| 字段 | 内容 |
| --- | --- |
| `name` | 清单里的任务名 |
| `status` | `completed` / `needs-human` / `failed` / `interrupted` |
| `reason` | 需要人、失败或中断的原因（中文）；完成时为空 |
| `projectId`、`projectUrl`、`runId` | 项目、网页链接、自主运行（建成了才有） |
| `startedAt`、`endedAt`、`elapsedMs` | 本命令开始处理这个任务到写结果的时间 |
| `usage` | `weightedTokens`（折算 token）、`tokenBreakdown`（未缓存输入、缓存读、缓存写、输出的原始合计）、`rounds`（总 Agent 轮数），取自运行结束后的 `RunDetail.usage` |
| `tasks` | 图谱里未归档的任务：`code`、`title`、`state`、`completedBy`（`agent` / `human`） |
| `autoAnswers` | `[{at, chatId, question, answer}]`，每个问题一条 |
| `trajectory` | `{file: "trajectory.zip" 或 null, bytes, warnings}` |
| `previousAttempts` | 续跑重跑时：之前每次的 `projectId`、`projectUrl`、`runId`、`status`、`reason`，以及文件移到的 `folder` |

`summary.json` 是 `{startedAt, endedAt, studioUrl, manifest, interrupted, counts, tasks}`，`tasks` 每行有任务名、文件夹、结果、原因、用时、折算 token、链接；上次已经跑完、这次跳过的带 `earlier: true`（汇总表里显示“完成（上次）”）。

### 进度

- 终端里：一行总数（完成、需要人、失败、运行中、排队），每个运行中的任务一行（状态、用时、折算 token、子 Agent 数），每秒重画；任务结束时在上方留一行结果（导出包里的说明只写条数，内容在 `result.json`；轨迹没导出时写明原因）。行宽按终端宽度截断，不会折行。
- 不是终端（管道、日志、`docker run` 不带 `-t`）：每个任务的状态变化时输出一行 `[时:分:秒] 任务名：状态`，用时和 token 的变化不输出。
- Agent 写的文字（事项说明、问题）显示前去掉控制字符，不会移动光标或改颜色。

## 并行、中断、续跑、退出码

- **并行**：`parallel` 个任务同时跑，排队的按清单顺序开始。用虚拟机的任务受主机资源限制，同时最多约 2 个。
- **Ctrl+C**（或 SIGTERM）：第一次停止本次启动的所有运行（`POST stop`），尽量导出已有的轨迹，写好结果（这些任务记为 `interrupted`，还没开始的保持 `pending`），退出码 130，并提示续跑命令。再按一次立即退出（状态文件已经是最新的，没导出的轨迹可以稍后在网页上导出）。校验阶段按 Ctrl+C 直接退出，什么都没启动。正在因“需要人”停止的任务仍记为需要人。
- **续跑** `--resume DIR`：读 `DIR/batch-state.json` 和清单（清单内容的 SHA-256 变了会提示），按任务名对应：
  - `completed`、`needs-human`、`failed` 跳过，结果保留；
  - `interrupted` 和 `pending` 在**新项目**里重跑，旧项目保留，旧的 `result.json`、`trajectory.zip` 移到 `<任务>/attempts/<n>/`，新结果的 `previousAttempts` 写明；
  - 仍是 `running` 的（上次的客户端被直接杀掉、断电）：它的运行在 Studio 里还在跑或已完成，就接着跟踪它（不重跑，用时从上次开始算）；运行已停止、失败或找不到，就按中断的重跑；
  - 清单里新加的任务照常跑；清单里删掉的任务：跑完的保留在汇总里，没跑完的不再运行；
  - 这次连的 Studio 和上次不同会提示（上次的项目在原来那台上）。
- **退出码**：0 全部完成；2 有任务需要人或失败（续跑时也算上次跳过的）；1 命令本身出错（清单有问题、连不上、输出文件夹不能用）；130 被中断。

## 测试

```bash
npm ci --prefix cli                      # cli/ 自己的依赖
node --test tests/cli-*.test.mjs         # 单元测试（npm test 也会跑）；没装 cli/ 依赖时，用到 YAML 的测试显示为跳过
node scripts/verify-cli-run.mjs          # 集成验收，约 2 分钟；有 Docker 时会用这份源码构建 harnessstudio/cli:verify-cli-run 并测容器方式
CLI_RUN_IMAGE=harnessstudio/cli:<标签> node scripts/verify-cli-run.mjs     # 改用一个已经构建好的 cli 镜像
```

- 单元测试：`tests/cli-manifest.test.mjs`（清单校验、默认值与覆盖、模型名、文件夹名、汇总、参数），`tests/cli-task.test.mjs`（用 `tests/cli-fixtures.mjs` 的假 Studio 跑状态机：完成、自动回答、各类事项、受阻、失败、网页上暂停或停止、revision 过期、导出失败与导出包里的说明、上传、中断、断线、接着跟踪、ZIP 与 ZIP64），`tests/cli-batch.test.mjs`（并行、中断、续跑、退出码、进度显示、整个命令，以及客户端的类型检查）。
- 集成验收 `scripts/verify-cli-run.mjs` 用 `scripts/verify-app.mjs` 的 `startApp` 起一个带 smoke 模型的临时 Studio，目标里写 `[autonomy-smoke] {...}` 造出正常完成、总 Agent 和子 Agent 提问后被自动回答再完成、受阻、预算用完、提前宣布完成的任务，验证结果状态、`result.json`、汇总、轨迹里有每个对话和这次运行的 `autonomy/<runId>/run.json`、`--parallel 2` 真的同时跑两个、SIGINT 收尾和退出码 130、第二次 SIGINT 立即退出、`--resume` 只跑剩下的、清单有错时一个都不启动；另起一个 vm-manager 模式的 Studio（假 vm_manager、临时 projects 目录，用 `STUDIO_CONFIG_PATCH` 给 smoke 配置补上共享盘）验证上传到 F:；再起一个无软件模式的 Studio，验证上传到项目公共空间、运行目标里不提虚拟机、`budget.vms` 的提示和 `maxVms` 为 0。`CLI_RUN_CASES=bad,batch,…` 只跑部分。
- 在主机上跑时，`startApp` 起的 Studio 用的是 `node_modules/@harnessstudio/*` 指向的插件的 `lib/`：按 `wt-*` 副本的准备步骤链接到副本自己时，就是副本里 `npm run build` 编出来的，rebase 或改了插件之后先 build。也可以在这个分支的测试镜像里跑，把 `cli/`（含装好的依赖）挂进去（镜像里没有 Docker，容器用例会跳过）：

  ```bash
  docker build --target studio -t harnessstudio/studio:<名称>-test .
  docker run --rm --user node --tmpfs /opt/harnessstudio/.studio:uid=1000,gid=1000,exec -v "$PWD/cli:/opt/harnessstudio/cli:ro" \
    --entrypoint node harnessstudio/studio:<名称>-test scripts/verify-cli-run.mjs
  ```

- 集成验收设了 `STUDIO_SMOKE_WIRE=1`：smoke 模型的调用经过本机 HTTP，对话审计记下完整的请求和返回，完成的运行导出时没有 `warnings`。不访问外网，不调用真实模型。
- **不要拿正在正式使用的 Studio 试批量**：那会在它上面建项目、调用真实模型。试跑请用单独的测试实例。

## 排查

- 每个任务的 `result.json` 的 `reason` 和 `trajectory.warnings`；整批看 `summary.json`。网页链接直接打开项目，运行面板里有事项和事件。
- “连不上 Studio”：地址不对、Studio 没启动，或主机名不在 Studio 的 `trustedHosts` 里（Studio 只接受本机、部署时登记的局域网 IP 和 `STUDIO_TRUSTED_HOSTS` 里的主机名；不信任的 Host 会被拒绝）。
- “Studio「模型配置」里没有模型 …”：模型名以「模型配置」页为准；错误里列出了能用的名字。
- 上传失败“当前部署没有项目公共空间（F 盘）”：这台 Studio 用的是开发用的 Mock 后端，没有公共空间；去掉 `files`，或换成无软件模式、vm-manager 后端的部署。
- `trajectory.warnings` 里的其他句子来自导出包的 `project.json`：说明哪些内容没导出或不完整（例如停止运行时被打断的模型调用）。“需要人”和“中断”的任务有这类句子是正常的；导出时还在运行的对话，稍后在网页上重新导出即可。
- 进度一直是“已被人暂停，在等待”：有人在运行面板点了暂停，这个任务占着名额等着；点继续或停止后批量才会往下走。
- 客户端被杀后 `batch-state.json` 里还有 `running`：用 `--resume` 接着跑，还活着的运行会被接着跟踪。

## 已知限制

- 自动回答只处理 2 分钟内能回答的问题；Studio 重启过的运行会暂停并开 `restart` 事项，按需要人处理，不会自动继续。
- 开发用的 Mock 后端没有项目公共空间，`files` 用不了。
- 容器里默认是 UTC 时间，除非入口传入时区。
- 一个任务一个项目、整个项目范围；不支持只跑某个任务分支。
