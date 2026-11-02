# `harnessstudio` 部署命令（运维）

`bin/harnessstudio` 把 Studio 从当前源码部署成 Docker 容器，替代以前由 4 个 compose 文件和环境变量拼成的长命令。设计约定见工作区的 `cli/设计.md`（第 3–5 节、7.1 节和第 10 节）；批量命令 `run` 的客户端见 `docs/batch-run.md`。

```bash
harnessstudio            # 没部署就部署，代码有更新先问；最后打印网址
harnessstudio stop       # 停止 Studio、沙箱管理器、出口代理和本实例的沙箱；虚拟机不受影响
harnessstudio run 清单.yaml [--url 地址] ...   # 批量跑任务
harnessstudio --help
```

主机只需要 bash 4+、coreutils、find 和 Docker（Engine + compose v2 + buildx 插件）。版本摘要、密钥、HTTP 检查都用 bash 和 coreutils 完成，不需要 Node、Python、jq、curl（检查 HTTPS 的 vm_manager 地址时有 curl 就用）。脚本通过软链接也能找到仓库根目录：`ln -s "$PWD/bin/harnessstudio" ~/.local/bin/harnessstudio`。

## 文件

| 位置 | 内容 | 进 git |
| --- | --- | --- |
| `bin/harnessstudio` | 命令本身 | 是 |
| `deploy/harnessstudio/*.yml` | 命令使用的 compose 文件，只从环境变量读配置，没有写死任何机器的值 | 是 |
| `.studio/deploy/harnessstudio.env` | 配置（`HARNESSSTUDIO_CONFIG` 可以指向别的文件） | 否 |
| `.studio/deploy/secrets/` | `mock-seat-token`、`sandbox-token`、`provider.env`（目录 700，文件 600） | 否 |
| `.studio/deploy/history.log` | 每次部署一行：时间、实例、从哪个版本到哪个版本、回滚标签、配置文件 | 否 |

旧的 `deploy/compose.yml`、`compose.lan.yml`、`compose.vm-manager.yml`、`compose.sandbox.yml` 保留，给手写命令和 M5/M6 验收脚本用；命令不读它们。这几个文件里没有任何一台机器的地址或路径：访问地址、vm_manager 地址和它的 projects 目录都要用环境变量提供，少了会报中文错误（见「备用：手写 compose 命令」）。

## 配置

KEY=VALUE，一行一项，`#` 开头是注释，值可以加引号。**不认识的配置项会报错**，拼写错误不会被悄悄忽略。改完再运行一次 `harnessstudio` 生效（会先问是否重建）。

| 字段 | 含义 | 默认 |
| --- | --- | --- |
| `HS_INSTANCE` | compose 项目名，决定容器名（`<实例>-studio-1`）和数据卷名（`<实例>_studio-data`） | `harnessstudio` |
| `HS_PORT` | 发布端口 | `3080` |
| `HS_BIND` | 绑定地址：`0.0.0.0` 局域网可访问，`127.0.0.1` 只本机 | `0.0.0.0` |
| `HS_PUBLIC_HOST` | 别人访问用的主机名或 IP；生成 `STUDIO_PUBLIC_URL=http://<它>:<端口>/` 和 `STUDIO_TRUSTED_HOSTS=<它>:<端口>`，网页只接受用这个地址访问 | 本机局域网 IP（`ip route get` 的源地址）；`HS_BIND=127.0.0.1` 时是 `127.0.0.1` |
| `HS_VMM_URL` | vm_manager 地址，例如 `http://192.168.1.20:8000`；空 = 无软件模式。不能用 `127.0.0.1`/`localhost`（那是 Studio 容器自己） | 空 |
| `HS_VMM_PROJECTS_ROOT` | vm_manager 数据目录下的 projects 文件夹，必须存在；填了 `HS_VMM_URL` 时必填 | 无（各台机器不同；第一次运行时问，接管时从运行中的容器读） |
| `HS_SANDBOX` | `auto`（检测到 runsc 就开）、`on`（没有 runsc 就报错）、`off` | `auto` |
| `HS_SANDBOX_NETWORK` | 沙箱内部网络名 | `<实例>-sandbox` |
| `HS_SANDBOX_SUBNET` / `HS_SANDBOX_IP_RANGE` / `HS_SANDBOX_PROXY_IP` | 沙箱网段；后两项默认由网段推出（`.128/25`、`.2`） | `172.29.250.0/24`；非默认实例第一次运行时自动挑一个没被占用的 `172.29.N.0/24` |
| `HS_SMOKE` | `1` = 加载确定性测试模型（只给测试实例，不写进用户文档） | 空 |

**环境变量里的 `HS_*` 不会覆盖配置文件**，只在第一次运行时作为问题的默认答案（以及接管时指定要找的实例名 `HS_INSTANCE`）。有配置文件时，环境里和配置不一致的 `HS_*` 会提示“不起作用”。这样一个残留的 export 不会把部署悄悄指到别的实例。

### 第一次运行

没有配置文件、本机也没有同名实例时，在终端里逐项提问（回车用默认值），确认后写入配置：

1. 网页端口 [3080]
2. 让局域网里的其他电脑也能访问吗？[Y/n]（n → `HS_BIND=127.0.0.1`）
3. 别人在浏览器里访问用的地址 [探测到的局域网 IP]
4. vm_manager 的地址。本机局域网 IP 的 `:8000` 能连上时，题目写“回车 = 使用探测到的地址；输入 无（或 none、-）= 不用虚拟机”，默认值是探测到的地址；探测不到时写“没有就直接回车，表示不用虚拟机”，回车就是不用虚拟机。两种情况都认 `无`、`none`、`-`
5. （填了 4 时）vm_manager 的 projects 文件夹 [必填]，没有默认值，必须是已存在的目录
6. Agent 的 Linux 沙箱 auto / on / off [auto]

答案不合格会重问（端口不是数字、地址带了 `http://`、vm_manager 填了 localhost 等）。不在终端里运行（脚本、定时任务）时直接报错，提示先在终端里运行一次。

## 部署流程（`harnessstudio`）

1. 检查 Docker、daemon 权限、compose 插件，缺了给出中文的安装或授权命令（构建前再检查 buildx）。
2. 读配置；没有就接管或第一次提问。
3. 检测 runsc（`docker info` 的 Runtimes），决定沙箱开不开。
4. 检查 vm_manager：`GET <HS_VMM_URL>/v1/environments`，5 秒超时；projects 目录不存在直接报错。
5. 计算源码版本，读运行中 studio 容器的版本标签和配置摘要标签，判断要做什么：
   - 版本、配置都一致，服务都在运行 → 只打印状态和网址，**不构建、不重启**；
   - Studio 在运行但版本或配置不同 → **先问**（见下），不在终端里就不动，只提示；
   - 没有 Studio 容器（第一次部署）→ 直接部署；
   - Studio 容器在、但没在运行（`stop` 之后、崩溃）：版本和它上次运行的相同 → 直接启动（配置改了就按新配置重建）；**版本不同 → 先问**（“上次运行的是 X，现在要部署 Y”，默认“否”）。回答“否”或不在终端里时，不改版本，用 `docker start` 把原来的容器按上次的版本和设置启动起来，并提示怎么部署新版本；
   - 只是沙箱服务停了或有多余的容器 → 直接 `up`（Studio 容器配置没变，compose 不会重建它）。
6. 生成缺少的密钥，构建缺少的镜像。
7. Studio 容器存在且要换镜像时，给正在用的镜像打回滚标签，写 `history.log`。
8. `docker compose up -d --wait --wait-timeout 600 --remove-orphans`，再从宿主机 GET 一次网址确认。
9. 打印网址、虚拟机和沙箱状态、停止命令、回滚命令。

命令运行期间（例如构建要几十分钟）更新源码（`git pull`、解压新的安装包覆盖），不影响正在运行的这一次：bash 是边读边执行脚本的，所以最后一行在同一个复合命令里退出，不会读到改过的文件；新源码下次运行时生效。

同一实例同时只能有一个 `harnessstudio` 在部署（`.studio/deploy/.lock-<实例>`，持有者进程不在了会自动接管）。

### 先问

```
检测到代码有更新：运行中的版本是 3fa2c1e9b0d4，要部署的是 8c01d77e5a12。
重新部署会让正在进行的自主运行暂停（之后在运行面板上点「继续」）。未结束的自主运行：2 个。
同时会移除不再需要的容器（数据卷保留）：harnessstudio-mock-seat-1
是否继续？ [y/N]
```

- 未结束的自主运行：`GET /api/studio/autonomy/runs`，数 `state` 为 running、paused、waiting-human、blocked 的运行；Studio 不响应时显示 `?`。请求从宿主机发到 `HS_BIND`（`0.0.0.0` 时用 127.0.0.1），Host 头用 `HS_PUBLIC_HOST:HS_PORT`（受信任的地址）。
- 默认是“否”。运行中的容器没有版本标签（以前手工部署的）时显示“未知”，同样先问。
- 配置改了（端口、地址、vm_manager、沙箱开关或网段、smoke）也先问：配置摘要记在 studio 容器的标签 `org.harnessstudio.config` 上。
- `harnessstudio run` 永远不重新部署正在运行的 Studio，只提示一句。

## 版本与镜像

- **源码版本**：对构建输入逐个算 `sha256sum`，得到“摘要␣␣路径”的行，按路径字节序排列（`LC_ALL=C sort`），对整段再算一次 SHA-256，取前 12 位。构建输入是 `Dockerfile`、`package.json`、`package-lock.json`、`tsconfig.json`，以及 `scripts/`、`config/`、`plugins/`、`prompts/`、`deploy/`、`cli/`、`apps/*/src/` 下的文件；排除 `node_modules`、`plugins/*/lib`、`.studio`、`deploy/secrets` 和 `.gitignore` 里的文件类型（`*.log`、`.env*`、证书等）。不需要 git，安装包里同样能算。与 `scripts/release.mjs` 的版本算法相同。文档、测试改了不算更新。
- **镜像**：`harnessstudio/studio:<版本>`、`harnessstudio/sandbox-manager:<版本>`、`harnessstudio/sandbox-egress:<版本>`、`harnessstudio/sandbox:<版本>`、`harnessstudio/cli:<版本>`（`run` 用）。Dockerfile 每个最终阶段末尾有 `ARG HARNESSSTUDIO_VERSION` 和 `LABEL org.harnessstudio.version`，放在最后，不影响上面各层的缓存。
- **不重复构建**：目标镜像已存在就跳过；需要构建时 Dockerfile 的分层缓存照常利用，只改 Studio 代码时只重新执行 `container-build.mjs --studio` 那一层。沙箱三个镜像每个版本都会重新打标签（层全部命中缓存，几秒钟）。
- **沙箱镜像在宿主机网络上构建**（`--network host`，与 `docs/sandbox.md` 一直以来的做法相同），shell 里设了 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`（大小写都认）时作为构建参数传进去，这样能用本机上的代理装 apt 和 pip 包。网络模式是 BuildKit 缓存键的一部分，所以以前的构建缓存照样命中；代理参数不进缓存键（Docker 的预定义参数），有没有代理都用同一份缓存。其他镜像用默认网络、不传代理：改了网络模式，Studio 的缓存会失效，要重新下载整个 DSH 依赖。
- **沙箱会在下一条命令时重建**：沙箱镜像的 ID 随版本变（LABEL 不同），sandbox-manager 发现镜像变了会重建沙箱，沙箱里装过的包随之丢失（D/F 盘文件不受影响）。
- **清理旧版本**：命令不删任何镜像。旧版本和回滚标签共享大部分层；需要腾空间时，对照 `history.log` 保留最近几个，`docker image rm harnessstudio/studio:<旧版本>`，再 `docker builder prune` 清构建缓存。

## 回滚

每次替换镜像的部署都会打回滚标签，并在最后打印确切的一行，例如：

```bash
HARNESSSTUDIO_TAG=rollback-20261102-153000 harnessstudio
```

（用了 `HARNESSSTUDIO_CONFIG` 的实例，打印的命令会带上它。）

- 回滚标签：部署前把正在运行的 studio、sandbox-manager、sandbox-egress 容器的镜像，以及 sandbox-manager 当前使用的沙箱镜像，各打一个 `harnessstudio/<镜像>:rollback-<时间>`。第一次部署（之前没有容器）不打。
- `HARNESSSTUDIO_TAG=<标签>`：部署这个标签的镜像，**不构建**；镜像不存在就报错。标签也可以是某个版本号（`history.log` 里的 `to=`），用来回到更早的版本。这个标签没有沙箱镜像时，沙箱部分用当前源码的版本（必要时构建），并提示。
- 回滚同样先问（“将切换到 rollback-…”），同样会再打一个回滚标签，所以回滚本身也能撤销。
- **回滚是“粘”的**：回滚之后再运行不带变量的 `harnessstudio`，不管 Studio 在运行还是被 `stop` 过，都会先问“要部署当前源码的版本吗”，默认“否”；不在终端里时一律保持回滚后的版本。
- 同一秒里部署两次（例如更新后马上回滚）时，回滚标签加后缀 `-2`、`-3`……；已有的回滚标签永远不会被改指向别的镜像。
- 回滚到自主模式之前的版本前，先在运行面板上停止所有未结束的自主运行（见 `docs/autonomy.md`）。

## 接管已有的部署

条件：没有配置文件，但本机已有 compose 项目 `<HS_INSTANCE>`（默认 `harnessstudio`）的 studio 容器（任何状态）。命令从容器推导配置，展示给用户确认后写入，**不重建、不重启任何容器**：

| 推导出的 | 来源 |
| --- | --- |
| `HS_PORT`、`HS_BIND` | studio 容器 3080/tcp 的端口绑定 |
| `HS_PUBLIC_HOST` | 环境变量 `STUDIO_PUBLIC_URL` 的主机部分 |
| `HS_VMM_URL`、`HS_VMM_PROJECTS_ROOT` | `STUDIO_SEAT_BACKEND=vm-manager` 时的 `STUDIO_VMM_URL`、`STUDIO_VMM_PROJECTS_ROOT` |
| `HS_SANDBOX` | 有 `STUDIO_SANDBOX_URL` 且有 sandbox-manager 容器 → `auto`，否则 `off` |
| `HS_SANDBOX_NETWORK`、`HS_SANDBOX_PROXY_IP` | sandbox-manager 的 `SANDBOX_NETWORK`、`SANDBOX_PROXY` |
| `HS_SANDBOX_SUBNET`、`HS_SANDBOX_IP_RANGE` | `docker network inspect <沙箱网络>` |
| `HS_SMOKE` | `STUDIO_SMOKE=1` |

- **密钥必须是同一份**：compose 的文件密钥是挂在 `/run/secrets/*` 的绑定挂载。挂载来源不在这份源码的 `.studio/deploy/secrets/`（例如从另一个目录接管）时拒绝接管，提示先把原来的密钥文件复制过来，避免换成新密钥。
- 不在终端里时拒绝接管，提示在终端里运行。
- **Mock 模式的实例不能接管**（`STUDIO_SEAT_BACKEND=mock`，只用于开发）：命令只部署 vm-manager 和无软件两种后端，任务文件的位置都和 Mock 不同，接管后原有项目的任务文件会看不到。拒绝接管、不写配置，提示继续用原来的 compose 命令，或用另一个实例名另起一个实例。
- 接管后会接着做版本检查：以前的容器没有版本标签，所以会问是否重新部署（默认“否”）。
- 重新部署会去掉 Mock Seat 容器（`--remove-orphans`，问的时候会列出来）。vm-manager 模式下 Studio 不访问它；入口脚本仍要求 `STUDIO_SEAT_URL` 和 `mock-seat-token`，所以这两项保留，密钥引用与以前一致。`<实例>_mock-data` 数据卷保留。
- 新 compose 文件的服务名、网络名（`<实例>_studio`、`<实例>_sandbox-egress`、`HS_SANDBOX_NETWORK`）、网络定义和数据卷名都与旧文件相同，重新部署沿用原来的网络和数据卷。用旧的四个文件和新文件分别 `docker compose config`，studio、sandbox-manager、sandbox-egress 三个服务除镜像标签和配置标签外完全一致。

我们自己服务器上的线上部署，只由任务 ⑤ 在用户同意后接管。

## 已部署的实例不能换软件后端

每种后端的任务文件放在不同地方，Studio 只看当前后端的位置：

| 后端 | 什么时候 | 任务文件 |
| --- | --- | --- |
| `vm-manager` | 配置里填了 `HS_VMM_URL` | vm_manager 的 projects 目录（`HS_VMM_PROJECTS_ROOT`） |
| `none` | 没填 `HS_VMM_URL` | Studio 数据卷里的 `studio/files` |
| `mock` | 只有手写 compose 命令的开发部署 | Studio 数据卷里的 `studio/workspaces` |

已有数据卷的实例换了后端，原有项目的任务文件在网页上就看不到了（文件还在原处）。所以实例的 studio 容器已经存在（不论是否在运行）、而配置里的后端和容器上次运行的后端（容器环境变量 `STUDIO_SEAT_BACKEND`，没有就是 mock）不同时，命令**拒绝部署**，什么都不改，并说明：上次的后端和任务文件位置、配置里的后端和位置、后果，以及怎么办——把配置改回去（填回或清空 `HS_VMM_URL`，填回时给出原来的地址），或者用另一个配置文件和实例名另起一个实例。不提供自动迁移。`run` 只连接正在运行的 Studio 时不检查（它不部署）。

## compose 文件（`deploy/harnessstudio/`）

| 文件 | 何时叠加 | 作用 |
| --- | --- | --- |
| `studio.yml` | 总是 | studio 服务（镜像 `harnessstudio/studio:${HS_TAG}`、端口、公开地址、配置标签、密钥、数据卷）；默认 `STUDIO_SEAT_BACKEND=none` |
| `vm-manager.yml` | `HS_VMM_URL` 非空 | `STUDIO_SEAT_BACKEND=vm-manager`、vm_manager 地址、projects 目录挂载（`create_host_path: false`）、Studio 以 root 运行 |
| `smoke.yml` | `HS_SMOKE=1` | `STUDIO_SMOKE=1` |
| `sandbox.yml` | 沙箱开启 | sandbox-manager、sandbox-egress、沙箱网络 |
| `sandbox-vm-manager.yml` | 沙箱开启且有 vm_manager | sandbox-manager 只读挂载 projects 目录 |
| `sandbox-none.yml` | 沙箱开启且无 vm_manager | sandbox-manager 只读挂载 Studio 数据卷，任务空间在 `/var/lib/harnessstudio/studio/files`，以数据卷子路径挂进沙箱（`SANDBOX_FILES_VOLUME`，任务 ④ 实现）；不挂载 vm_manager 的任何目录 |

命令调用 compose 时清掉 `COMPOSE_FILE`、`COMPOSE_PROFILES`、`COMPOSE_PROJECT_NAME`，只传 `HS_*` 变量（加上 `HS_TAG`、`HS_SANDBOX_TAG`、`HS_SECRETS_DIR`、`HS_CONFIG_DIGEST`）。排查时可以用命令自己的函数看实际配置：

```bash
bash -c 'source bin/harnessstudio; hs_read_config; hs_resolve_sandbox; HS_TAG=x HS_CONFIG_DIGEST=x; hs_overlays; hs_compose config'
```

## Linux 沙箱

- `auto`：检测到 runsc 就开，没有就不启沙箱服务，打印提示（Agent 照常可用）；`on`：没有 runsc 报错；`off`：不启。关掉后再部署会移除 sandbox-manager 和 sandbox-egress 容器。
- **同一台机器上的每个实例要有自己的沙箱网络名和网段**。sandbox-manager 只列出、回收、统计、删除**自己网络上的**沙箱容器（Docker 的 `network` 过滤，对已停止的容器同样有效）。所以测试实例在设置页关掉沙箱开关，不会删掉线上的沙箱；以前所有实例共用标签 `harnessstudio.sandbox=1`，会互相停掉、删掉对方的沙箱。
- gVisor 的安装见 `docs/sandbox.md`。

## vm_manager

- 配了地址但连不上：照常部署，打印“暂时不能用虚拟机”和启动 vm_manager 的四步（工作区 CLAUDE.md）。启动后刷新网页即可，不用重新部署。
- projects 目录不存在：报错停止（compose 的挂载设了 `create_host_path: false`）。
- 没配：无软件模式（`STUDIO_SEAT_BACKEND=none`），提示“没有接入 vm_manager”，并说明这个实例部署之后不能再改成接虚拟机（换后端会让原有项目的任务文件看不到）；要用虚拟机请另起一个实例，提示里给出命令示例。
- vm_manager 单独部署，命令只检查它，不启动它。

## `harnessstudio stop`

用 `docker stop --time 30` 停止本实例的 studio、sandbox-manager、sandbox-egress 容器，再停止本实例沙箱网络上正在运行的沙箱容器。虚拟机由 vm_manager 管理，不受影响；数据卷、配置、密钥都保留。容器重启策略是 `unless-stopped`，`stop` 之后服务器重启也不会自动启动，再运行 `harnessstudio` 即可。

## `harnessstudio run` 的入口

- 没有 `cli/` 时提示“批量命令尚未安装”。
- 没有 `--url`：先执行部署流程的检查部分（没在运行就部署，第一次要在终端里回答问题）；Studio 在运行时**不重新部署、不改动任何容器**，有更新只提示。
- 有 `--url`：只 `GET <url>/api/studio/projects` 检查连接，连不上就报错退出，不部署。
- 准备 `harnessstudio/cli:<版本>`（没有就 `docker build --target cli`），然后 `exec`：

  ```bash
  docker run --rm --init --network host --user "$(id -u):$(id -g)" -v "$PWD:$PWD" -w "$PWD" \
    [-v <清单所在目录>:<同路径>:ro]   # 清单不在当前目录下时
    [-it]                             # 标准输入和输出都是终端时
    [-v /etc/localtime:/etc/localtime:ro]   # 容器用本机时区（项目名、默认输出文件夹里的时间）
    -e HARNESSSTUDIO_URL=<地址> -e HARNESSSTUDIO_PUBLIC_URL=<公开地址> \
    harnessstudio/cli:<版本> run <原样传入的参数>
  ```

  - 本机 Studio：`HARNESSSTUDIO_URL=http://127.0.0.1:<端口>/`（`HS_BIND` 是具体 IP 时用它），`HARNESSSTUDIO_PUBLIC_URL=http://<HS_PUBLIC_HOST>:<端口>/`，客户端用后者生成网页链接。`--url` 时两者相同。
  - 退出码就是客户端的（0、2、1、130，见 `docs/batch-run.md`）。
  - `exec` 让 docker 成为前台进程：终端里 Ctrl+C 经 TTY 送到客户端；不在终端里时由 docker 的 `--sig-proxy` 转发 SIGINT/SIGTERM；`--init` 让容器里的 1 号进程转发信号。
  - `run --help` 不检查 Studio，直接交给客户端。

## 保险：默认实例在终端外不改动

目标实例是 `harnessstudio`（我们的线上部署和每个默认安装都用这个名字），而标准输入不是终端时，拒绝一切会改动容器的操作（部署、启动、`stop`），`HARNESSSTUDIO_INTERACTIVE` 也不能绕过。只读的操作照常：已在运行时打印状态、`run` 连接正在运行的 Studio。要在脚本里自动部署，请用别的实例名。

## 测试实例

在这台服务器上，**不带测试配置运行 `bin/harnessstudio` 会作用于线上**。测试一律：

```bash
HARNESSSTUDIO_CONFIG=$PWD/.studio/deploy/<名字>-test.env bin/harnessstudio
```

配置里用测试实例名、空闲端口（`ss -ltn`）、`HS_BIND=127.0.0.1`、`HS_SMOKE=1`，以及独立的沙箱网络名和网段（各任务的网段见 `cli/设计.md`）。`HARNESSSTUDIO_INTERACTIVE=1` 让脚本在管道里也提问（从标准输入读答案），测试用。界面检查用 headless Chrome 加 `--host-resolver-rules=MAP studio.test 127.0.0.1 --no-proxy-server` 和 `HS_PUBLIC_HOST=studio.test`。测完：

```bash
docker compose -p <测试实例> down -v      # 或 docker rm -f + docker volume rm
docker network rm <测试沙箱网络>
docker image rm harnessstudio/{studio,sandbox-manager,sandbox-egress,sandbox}:<测试中产生的版本和回滚标签>
rm <测试配置>
```

单元测试 `tests/cli-deploy.test.mjs` 用假 docker（`tests/cli-deploy-fake-docker.mjs`，记录每次调用）验证各分支会执行哪些 docker 命令，用真的 `docker compose config` 验证 compose 文件的选择；`tests/sandbox.test.mjs` 验证 sandbox-manager 只看自己网络上的沙箱。

## 排查

| 现象 | 处理 |
| --- | --- |
| 端口被占用 | `sudo ss -ltnp 'sport = :<端口>'`；或改 `HS_PORT` |
| 启动失败 | `docker logs <实例>-studio-1`；打印的回滚命令可回到部署前的版本 |
| 网页打不开、提示 Host 不受信任 | 必须用 `HS_PUBLIC_HOST:HS_PORT` 访问；换了 IP 就改 `HS_PUBLIC_HOST` 再运行 |
| 沙箱显示运行时没装 | 装 gVisor（`docs/sandbox.md`），再运行 `harnessstudio`（`auto` 会自动开） |
| 两个实例的沙箱网段冲突（`Pool overlaps`） | 改其中一个的 `HS_SANDBOX_NETWORK`、`HS_SANDBOX_SUBNET` |
| “另一个 harnessstudio 正在部署” | 等它结束；进程已经不在时会自动接管锁 |
| 想看部署历史 | `.studio/deploy/history.log` |
| 想知道运行中的版本 | `docker inspect --format '{{index .Config.Labels "org.harnessstudio.version"}}' <实例>-studio-1` |

## 备用：手写 compose 命令

命令出问题、或需要精确复现旧的部署时，可以用 `deploy/` 下旧的 compose 文件手写命令（`harnessstudio` 本身不读它们）。尖括号里是要换成自己的值的地方。这些文件里没有任何一台机器的值，下面三个变量必须由你提供，少了哪个，`docker compose` 会直接报中文错误并说明该填什么：

| 变量 | 含义 |
| --- | --- |
| `STUDIO_PUBLIC_HOST` | 别人在浏览器里访问用的地址（本机的局域网 IP 或主机名），用在 `compose.lan.yml` |
| `STUDIO_VMM_URL` | vm_manager 的地址，例如 `http://<服务器地址>:8000`，不能用 `127.0.0.1`，用在 `compose.vm-manager.yml` |
| `STUDIO_VMM_PROJECTS_ROOT` | vm_manager 数据目录下 projects 文件夹的绝对路径，用在 `compose.vm-manager.yml` 和 `compose.sandbox.yml` |

网页端口默认 3080，要改就再设 `STUDIO_PUBLISHED_PORT`。

```sh
export STUDIO_PUBLIC_HOST=<别人访问用的地址> STUDIO_VMM_URL=http://<服务器地址>:8000 STUDIO_VMM_PROJECTS_ROOT=<vm_manager 数据目录>/projects
docker tag harnessstudio/studio:<正在用的标签> harnessstudio/studio:before-<改动>
docker compose -p <实例名> -f deploy/compose.yml -f deploy/compose.lan.yml -f deploy/compose.vm-manager.yml -f deploy/compose.sandbox.yml build studio
docker compose -p <实例名> -f deploy/compose.yml -f deploy/compose.lan.yml -f deploy/compose.vm-manager.yml -f deploy/compose.sandbox.yml up -d --wait --no-deps studio
```

- 访问地址由 `STUDIO_PUBLIC_HOST` 给出（`compose.lan.yml`）；`compose.vm-manager.yml` 用的镜像标签是 `harnessstudio/studio:vm-manager-seat`，回滚时把回滚标签重新 tag 成它，再执行一次 `up`。
- 改了 `apps/sandbox-manager/` 或 `deploy/sandbox/` 时，还要重建对应镜像（`build sandbox-manager sandbox-egress`；沙箱镜像用 `docker build --target sandbox -t harnessstudio/sandbox:1 .`），再 `up -d --wait sandbox-manager sandbox-egress`。
- 用手写命令部署出来的实例，容器上没有版本标签；之后改用 `harnessstudio` 时，它会当作“版本未知”，先问再重新部署（见「接管已有的部署」）。

## 给用户说明的要点（任务 ⑤ 汇总）

- 装好 Docker 后，在源码目录运行 `./bin/harnessstudio`（或软链接到 PATH），第一次回答 6 个问题，最后会打印网址，把网址发给同事。
- 问题里的 vm_manager 地址：没有虚拟机就直接回车；要填本机局域网 IP，不能填 127.0.0.1。
- 再次运行不会重复安装；代码更新后再运行会先问，正在进行的自主运行会暂停，之后在运行面板上点「继续」。
- 每次更新完都会打印一行回滚命令，出问题照着执行即可。
- `harnessstudio stop` 停止网页服务，虚拟机和数据都不受影响。
- 改配置：编辑 `.studio/deploy/harnessstudio.env` 再运行 `harnessstudio`。
- 没有 gVisor 时沙箱自动关闭，装好后再运行一次就会打开。
