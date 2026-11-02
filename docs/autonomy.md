# 自主运行（Autonomy）

用户给出一个目标，总 Agent 自己规划任务图谱、为任务派出子 Agent、跟进进度、确认任务组，最后报告目标完成；只有缺信息、要人动手、反复失败、预算用完、服务重启或提前宣布完成时才停下来等人。用户说明见工作区顶层的 `自主模式使用说明.md`，设计约定（工具、事件、接口、默认值）见工作区的 `autonomy/设计.md`，以它的第 12 节为准。

## 组成

```
运行面板（每 2 秒 GET run） ──/api/studio/autonomy/*──> studio-autonomy 插件（autonomy.ts）
                                                          │ 运行、子 Agent、事项、事件 → autonomy.sqlite
                                                          ├─ 总 Agent：新建的项目对话（任务分支时是根任务上的任务对话）
                                                          │    + DSH goal；goal-round-driver 在它空闲时续轮，
                                                          │    它在 studio_autonomy_wait 里等子 Agent
                                                          └─ 子 Agent：任务对话，一个任务同时最多一个
```

| 部分 | 代码 |
| --- | --- |
| 运行存储、控制、工具、事件、预算、接口 | `plugins/studio/src/autonomy.ts`、`autonomy-store.ts`、`autonomy-types.ts`（前后端共用） |
| 对话角色、新建对话、工具屏蔽、虚拟机计数 | `index.ts`（`Binding.role/runId`、`startAutonomyChat`、`sendAutonomyMessage`）、`vm-seat.ts`（`withRunVmQuota`） |
| Agent 确认完成 | `domain.ts` 的 `agentCompletionPreview` / `agentCompleteTask` |
| 范围校验 | `planning.ts`、`todo.ts` |
| Prompt | `prompts/autonomy-orchestrator-system-prompt.md`（order 115）、`autonomy-worker-system-prompt.md`（116） |
| 组合配置 | `config/studio.patch.yml`：`dsh-goal`（`defaultMaxGoalRounds: 200`）、`dsh-tool-goal`、`dsh-goal-round-driver`、`studio-autonomy`，以及自主运行对话专用的 preset `studio-autonomy`：工具结果上限 2000（`spill-policy`），压缩引擎 `autonomy-compaction`，加 `dsh-repeat-tool-reminder`（等待和状态轮询不提醒）。见下文「上下文控制」 |
| 压缩引擎 | `plugins/studio/src/autonomy-compaction.ts`（`BasicCompactionEngine` 的子类） |
| 取消原因的文字 | `plugins/studio/src/abort.ts` |
| 界面 | `plugins/ui/src/autonomy.tsx`、`autonomy-model.ts`、`autonomy-settings.tsx`（模型配置页）、`completion-record.tsx`，以及侧栏、图谱、对话标签和消息卡片上的标记 |

不需要新的镜像、容器、端口或 secrets；部署 Studio 镜像即可。

## 数据

都在 Studio 数据目录（线上是数据卷 `/var/lib/harnessstudio` 的 `studio/`）：

| 文件 | 内容 |
| --- | --- |
| `autonomy.sqlite` | 表 `runs`、`workers`、`attention`、`events`，每行一个 JSON。不改 `domain.sqlite` 的表结构 |
| `autonomy-settings.json` | 全局默认值，带 revision（初始 0），旧页面保存会被拒 |
| `chats.json` | 运行创建的对话多了 `role`（orchestrator / worker）和 `runId`；运行结束后保留，作为历史标记 |
| `snapshots/` | Agent 确认的完成快照：`humanConfirmation.actor: 'agent'`、`agent: {runId, chatId, provider, model}`，每个目标带 `evidence` |

活动日志：人从运行面板的操作记为 `autonomy/<路由>`（处理事项为 `autonomy/attention/resolve:<action>`）；运行自己的步骤记为 `actor: 'agent'` 的 `autonomy/start-worker`、`report`、`attention`、`pause`、`resume`、`stop`、`complete`、`end`、`blocked`、`stop-worker`；Agent 确认完成记为 `task/agent-complete`。项目导出（`/api/studio/project/export`）的时间线里都有；导出还给每个运行写一份 `autonomy/<runId>/run.json`（设置、用量分项、**全部**事件含 `summary` 和 `page`、全部事项及处理方式、子 Agent），活动日志里没有的运行事件（服务重启后的暂停、问题被回答后事项关闭、子 Agent 一轮结束、预算预警等）从它补进时间线，类型是 `autonomy.<事件类型>`。导出前会等已结束运行的对话停下来（最多 60 秒）。格式见工作区 `cli/设计.md` 第 10 节「③ 轨迹导出」。

## 设置与默认值

设置页「模型配置 → 自主模式默认值」改全局默认值；启动对话框预填它们，每次运行复制一份，运行中可在运行面板「修改目标、模型和预算」里改（立即生效，总 Agent 收到 `human-edit` 事件）。

| 设置 | 默认 | 允许范围 | 用完 / 达到时 |
| --- | --- | --- | --- |
| `maxWorkers` 同时工作的子 Agent | 3 | 1–20 | 拒绝再派出 |
| `maxVms` 同时占用的虚拟机 | 2 | 0–20 | 拒绝新的虚拟机启动（不暂停）；只算本次运行的对话开的、排队到运行中的虚拟机 |
| `maxHours` 运行时长 | 8 | 0.1–720 | 暂停（`budget-time`）；暂停期间不计时 |
| `tokenBudget` 折算 token 预算 | 20,000,000 | 10,000 起 | 暂停（`budget-tokens`）；80% 时发 `budget-warning` |
| `cacheReadWeight` 缓存读取的折算系数 | 0.1 | 0–1 | 界面上以百分比填写，放在「高级」里 |
| `maxRounds` 总 Agent 的 goal Round | 200 | 1–100,000 | 暂停（`budget-rounds`）；「让它继续做」新建的 goal 继续累计 |
| `maxNudges` 给同一子 Agent 发消息 | 10 | 1–1000 | `stuck` 事项 |
| `stuckFailures` 子 Agent 连续失败的工具调用 | 5 | 1–1000 | `stuck` 事项 |
| `stuckIdleRounds` 子 Agent 连续无进展的回合 | 3 | 1–1000 | `stuck` 事项 |

- 模型：总 Agent 和子 Agent 默认模型启动时必选；总 Agent 的模型启动后不能改。`workerModels` 是总 Agent 可以给个别任务换用的模型（例如操作虚拟机要能看图的模型）。
- **折算 token** = 未缓存输入 + 缓存写入 + 输出 + 缓存读取 × `cacheReadWeight`，按运行内全部对话合计（取整）；对话加入运行之前用的不算，人在别的对话里用的不算。缓存读取是每次调用重读的旧上下文，价格低得多，全额计入会让预算很快用完（第一次试运行：子 Agent 6 分钟 195 万 token，其中 177 万是缓存读取）。每个对话存原始分项，改系数立即重算。`RunDetail.usage.tokenBreakdown` 是原始分项合计，运行面板的用量条下面显示它。
- 估预算：一次调用的折算量约为「新增内容 + 已有上下文 × 系数」。例如上下文平均 8 万、每次新增约 2000、系数 10% 时，每次调用约 1 万折算 token，一个子 Agent 做 40 步约 40 万；默认的 2000 万大约够 50 个这样的任务（总 Agent 另算）。
- 后端每 5 秒检查一次时长、预算和人对图谱的修改（插件配置 `tickSeconds`）。

## 上下文控制

只对自主运行的对话（`studio-autonomy` preset）生效，普通对话不变。

- **单个工具结果**：原样进入上下文的上限约 2000 估算 token（约 8000 字，DSH 按 4 个字符一个 token 估算；中文实际约 5000–8000 token）。超出部分只保留头尾，完整内容存在对话的临时文件里，结果末尾写有路径，模型用 `studio_read_temp_file`、`studio_search_temp_file` 分段读取。普通对话仍是 8000（约 3.2 万字）。`spill-policy` 因此挂在两个 preset 里各一份，而不是全局一份：同一个 Agent 上挂两份会把结果裁两次。
- **压缩**：引擎原来在上下文用到模型窗口的 80% 时压缩，线上模型的窗口是 100 万，相当于不压缩。`autonomy-compaction` 在引擎自己的阈值高于 12 万时改为约 12 万压缩，保留最近 4 万；窗口小的模型（引擎阈值本来就在 12 万以下）用原来的规则，不会每步都压缩。参数是插件配置 `pressureTokens`、`pressureRetainTokens`。
- **压缩的代价**：压缩会用同一个模型写一份摘要，输入是要压缩的那段上下文（约 8 万 token，大部分能命中缓存），输出几千 token，计入运行的用量。之后的每次调用都从约 6 万重新开始积累，比不压缩便宜得多。
- **提示词**：子 Agent 的提示词有「节省上下文」一节（够用即可、按段读临时文件、不重复抓取、大文件在沙箱里提取、把有用内容记进笔记）；总 Agent 派检索类任务时写明“够用即可”的范围。
- **总 Agent 的缓存**：总 Agent 的系统提示词在运行中不变，任务列表、状态和可确认的任务都从 `studio_autonomy_status` 获取（任务行的 `canConfirmNow`）。原因是系统段每变一次，DSH 就在历史里追加一条新的整段系统消息，之后的内容按未命中计费。

## 暂停、继续、停止、重启

| 操作或情况 | 结果 |
| --- | --- |
| 暂停（面板，或人在**总 Agent 的对话**里点停止） | `paused`（`user`）：goal 暂停，总 Agent 和所有活动子 Agent 的当前回合被打断（待处理消息保留），不再派出。虚拟机保持运行 |
| 人在**子 Agent 的对话**里点停止 | 只结束它这一轮；它仍占着任务和名额 |
| 继续 | 只恢复总 Agent 的 goal 并重新续轮，给它发 `resumed` 事件；被打断的子 Agent 由总 Agent 决定是否发消息让它继续。有未处理的 `incomplete` 事项、预算仍超限、Round 用完时拒绝 |
| 停止 | `stopped`：清除 goal，打断全部回合，关闭全部事项。对话、任务、文件、虚拟机都保留 |
| 服务重启 | 启动时把 `running`、`waiting-human` 的运行改为 `paused`（`restart`），开 `restart` 事项；人点继续后才恢复（DSH 重启后 goal 续轮是 disarmed） |
| 总 Agent 停下（模型出错、回复被截断、它的对话被关闭） | `paused`（`orchestrator-error`），开一个 `chatId` 为总 Agent 的 `stuck` 事项；人点继续 |
| 总 Agent 标记 goal complete | 范围内都完成 → `completed`；还有没完成的 → `waiting-human` 加 `incomplete` 事项（列出任务和总 Agent 最后的说明），人选「接受」（`completed`）或「让它继续做」（新建 goal，Round 继续累计） |
| 总 Agent 标记 goal blocked | `blocked`，打断子 Agent；人处理后可以继续 |

注意 DSH 的规则：总 Agent 只有在 goal 自动开始的 Round 里（或本轮有人直接发的消息时）才能用 `update_goal` 标记完成，运行的第一轮（由系统消息启动）不行；标记 blocked 还要求至少已跑 3 个 Round。

“需要人”事项的处理方式见设计约定 12.2。人在子 Agent 对话里发消息会关闭它的 `blocked`、`stuck` 事项；问题（`question`）只能在对话里回答。

## 权限边界

- 自主运行的工具只在对应角色、未结束运行的对话里提供；**每次执行时**还会再检查角色、所属运行和运行状态，因为工具屏蔽要到对话下次加载才刷新。运行结束后这些对话变回普通对话，工具调用立即被拒绝。
- `studio_agent_complete_task` 是普通对话里“只能由人确认完成”的唯一例外：子 Agent 只能完成自己的任务；总 Agent 只能完成范围内的任务组，以及没有活动子 Agent 的叶任务。每个目标都要有非空依据，人工完成的全部检查（前置、直属子任务、版本、冻结）照常执行。
- 任务分支的运行：只能在分支内修改图谱和清单；不能在项目根层建任务；不能移动、改依赖或删除分支根任务；范围内的任务不能新增对范围外任务的依赖。整个项目的运行不额外限制。
- Agent 没有删除、清空任务或永久删除虚拟机的工具。建图补丁原有的“移除纯草稿叶任务”（归档，可恢复）照旧可用，已开始或已完成的任务不能移除。
- 普通对话看不到、也不能执行任何自主运行工具和 goal 工具。

## 部署与回滚

部署就是重建并启动 Studio 镜像（命令见 `CLAUDE.md` 的「构建与部署」），`autonomy.sqlite` 和 `autonomy-settings.json` 在第一次启动时自动创建。部署前先给线上镜像打回滚标签（例如 `vm-manager-seat-before-autonomy`）。

回滚前**先在运行面板上停止所有未结束的运行**。旧版本能正常读取新数据（已完成的任务和 Agent 完成记录、自主运行的对话都能打开），但它保存 `chats.json` 时会去掉对话的 `role`、`runId`：之后再部署新版本，没停止的运行虽然会变成「已暂停（服务重启）」，它的对话却不再被认作总 Agent 和子 Agent，只能停止后重新启动。

## 验证

不调用真实模型，在测试镜像里跑（直接在副本里跑会加载主副本的插件）：

```sh
docker build --target studio -t harnessstudio/studio:<名称>-test .
docker run --rm --user node --tmpfs /opt/harnessstudio/.studio:uid=1000,gid=1000,exec --entrypoint node \
  harnessstudio/studio:<名称>-test scripts/verify-autonomy.mjs          # 约 75 秒；AUTONOMY_CASES=project,branch 只跑部分
```

`scripts/verify-autonomy.mjs`（`npm run test:autonomy`）通过 HTTP 接口驱动 smoke 模型完成整套场景：整个项目和任务分支、并行与依赖、Agent 完成记录与依据、范围外操作被拒、提问、受阻、卡住、token 预算、`maxWorkers`、暂停继续停止、提前宣布完成（继续与接受）、运行中修改、重启、人工继续修改后的待复核、活动日志与导出时间线，以及用内置假 vm_manager 测 `maxVms`。`scripts/verify-autonomy-backend.mjs` 测 goal 接入和 Round 预算；单元测试在 `tests/autonomy*.test.mjs`、`tests/agent-completion.test.mjs`。

smoke 模型的写法（`plugins/smoke/src/autonomy-probe.ts`）：运行目标里写 `[autonomy-smoke] {...}`，总 Agent 按脚本建图（`creates` 是图谱补丁的新增列表）、派出子 Agent、等待、确认任务组、在 goal Round 里标记完成；子 Agent 的指令是 `[autonomy-worker] {...}`，依次写文件、报告进展、预览、带依据完成。脚本可以插入提问、受阻报告、失败调用、`end-turn`（结束本轮等新消息）、`usage`（每次调用回报的 token）、`delayMs`、`completeEarly`。人在任意对话里发 `[autonomy-probe] {"calls":[...]}`，smoke 会列出这个对话拿到的自主运行工具并逐个试调用。

## 排查

- 运行面板：状态、事项、子 Agent 和最近 50 条事件（新的在前）。事件文字是给人看的；`studio_autonomy_wait` 给总 Agent 的原文含工具名和指示，在总 Agent 对话的工具结果里能看到。
- 只读接口：`GET /api/studio/autonomy/runs`（不带 `projectId` 返回所有项目的运行，带 `openAttention`）、`GET /api/studio/autonomy/run?id=`、`GET /api/studio/status`（对话的 `role`、`runId`、`status`）、`GET /api/studio/chat?id=`。不要 `docker exec` 进线上数据卷改 `autonomy.sqlite`。
- 运行停在 `orchestrator-error`：打开总 Agent 对话看最后一轮的错误（模型调用失败、回复被截断），处理后点继续。
- 子 Agent 一直“等待指令”：它的回合被暂停或重启打断了，总 Agent 恢复后会发消息让它继续；没有的话可以在它的对话里直接发一句。
- 启动虚拟机报“自主运行同时占用的虚拟机已达上限”：先停掉本次运行里不用的虚拟机，或调高 `maxVms`。
- 后端警告在 `docker logs <project>-studio-1` 里，以 `studio-autonomy:`、`autonomy-compaction:` 开头；压缩时有 `compaction (step pressure)` 一行。
- **用量去哪了**：`GET /api/studio/chat?id=<对话 ID>` 的 `metrics.usage` 是这个对话的原始分项（`uncachedInputTokens`、`cacheReadTokens`、`cacheWriteTokens`、`outputTokens`），`metrics.context.tokens` 是当前上下文大小。按 `GET /api/studio/autonomy/run?id=` 的 `workers` 逐个查子 Agent，加上 `orchestratorChatId`，就能看出哪个对话花得多、上下文有多大。总 Agent 的系统提示词变化次数可以在对话调试导出（`GET /api/studio/chat/backup?id=`）里数 `system/message` 事件。

## 已知限制

- 一个项目同时只有一个未结束的运行；单用户，没有多用户和审核工序。
- 总 Agent 用默认的 `timeoutSeconds`（300 秒）等待时几乎不耗 token；smoke 脚本为了快用 5 秒，等人时会持续轮询。
- 子 Agent 和人、沙箱同时改同一任务 D 盘的同一个文件时没有冲突协调（一个任务只有一个子 Agent）。
- 运行结束后，它的对话仍使用 `studio-autonomy` preset（带重复调用提醒）。
- 压缩按估算 token 判断，中文内容的实际 token 可能比估算多，上下文峰值会略高于 12 万。
