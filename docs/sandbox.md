# Agent Linux 沙箱

Agent 用 `studio_sandbox_run` 在一个只属于本对话的 Linux 容器里执行 bash 命令：解析文档、转换文件、Python 计算、下载文件、运行标为 `runs-in: sandbox` 的技能脚本。需要 Windows 或工程软件的工作仍在虚拟机里做。用户说明见工作区顶层的 `沙箱使用说明.md`。

在 vm-manager 部署里可用（沙箱挂载的是 vm_manager 的任务空间），要叠加 `deploy/compose.sandbox.yml`；在无软件模式（`STUDIO_SEAT_BACKEND=none`）里也可用，挂载的是 Studio 数据卷里的任务空间，sandbox-manager 的配置见下面「无软件模式」和 `docs/no-software.md`。Mock 部署没有任务空间，沙箱不可用。

## 组成

```
Studio ──HTTP+token──> sandbox-manager ──Docker socket──> hs-sbx-<对话ID>（每个对话一个，gVisor runsc）
                                                              │ 只在内部网络 harnessstudio-sandbox 上
                                                              └──HTTP(S) 代理──> sandbox-egress（squid）──> 公网
```

| 部分 | 代码 | 镜像（Dockerfile target） |
| --- | --- | --- |
| Studio 插件：工具、权限、设置接口 | `plugins/studio/src/sandbox.ts`，提示词 `prompts/sandbox-system-prompt.md` | studio |
| sandbox-manager：建、停、删沙箱容器，执行命令 | `apps/sandbox-manager/src/` | `sandbox-manager` |
| 沙箱镜像：Debian + Python 常用库 + 常用命令行工具，命令执行器 `run.py` | `deploy/sandbox/run.py` | `sandbox` |
| 出口代理 | `deploy/sandbox/squid.conf` | `sandbox-egress` |
| 设置页「Linux 沙箱」 | `plugins/ui/src/sandbox-settings.tsx`（挂在模型配置页） | studio |

Studio 自己不能启动容器（Docker socket 等于宿主机 root），所以由 sandbox-manager 持有 socket。它只在 Studio 的 compose 网络上，没有宿主机端口，每个请求都要带 `sandbox-token`。

## 沙箱能看到什么

Studio 按对话的权限算出挂载，sandbox-manager 再按固定规则校验（只能是这个对话所属项目的目录，不能是软链接，`/tasks`、`/inputs` 必须只读）：

| 沙箱路径 | 来源 | 读写 |
| --- | --- | --- |
| `/workspace` | 本任务 D 盘 `<projects>/<projectId>/tasks/<taskId>`（只有任务对话有） | 任务可写时读写，完成、冻结、归档后只读 |
| `/shared` | 项目 F 盘 `<projects>/<projectId>/shared` | 读写 |
| `/inputs/<taskId>` | 已完成的上游任务的 D 盘 | 只读 |
| `/tasks` | 本项目所有任务的 D 盘 | 只读 |
| `/skills` | Studio 数据卷里的全局技能库 `studio/skills`（volume subpath） | 只读 |
| `/plugins` | Studio 数据卷里的插件 `studio/plugins`，插件技能在 `/plugins/<插件>/skills/<技能>` | 只读 |
| `/tmp` | tmpfs | 沙箱停止即清空 |

- 任务完成、清空、删除时，Studio 先通过 producer quiescence 删除这些任务的沙箱；删除项目时还删除项目对话的沙箱。挂载（包括只读标志）变化后，下一条命令会重建沙箱。
- 每条命令在沙箱里是一个新的 bash 进程组；命令结束、超时或取消时整组结束，后台进程不会留下。stdout、stderr 各最多保留 1 MiB（开头部分加最后 64 KiB）。
- 每条命令记一条活动日志 `agent.sandbox_exec`，项目导出的时间线里能看到。

## 网络

- 沙箱只在内部网络 `harnessstudio-sandbox` 上，唯一出口是 sandbox-egress 的 3128 端口。代理只放行 80/443，拒绝私有、回环、链路本地等地址（`squid.conf` 的 `private_dst`），所以局域网、宿主机、vm_manager 和 Studio 都访问不到。
- 这个网络的网桥不分配宿主机地址（`com.docker.network.bridge.inhibit_ipv4`）。只设 `internal: true` 不够：容器还能通过网关地址访问宿主机上监听 0.0.0.0 的服务，例如没有鉴权的 vm_manager `:8000`。
- 同一网络上的沙箱之间可以互相连接（代理也要靠这个），这是已知限制；单用户部署下影响有限。
- sandbox-manager 只列出、回收、统计、删除**自己沙箱网络上的**沙箱容器（所有实例的沙箱都带同一个标签 `harnessstudio.sandbox=1`，靠网络区分）。同一台机器上的多个 Studio 实例（例如测试实例）要各用自己的网络名和网段，这样在一个实例里关掉沙箱开关或闲置回收，不会影响另一个实例的沙箱。

## 资源和回收

- 用户在设置页（模型配置 → Linux 沙箱）设置开关、每个沙箱的 CPU 和内存、最多同时运行几个、闲置多久回收，保存在数据卷的 `studio/sandbox-settings.json`（带 revision，旧页面的保存会被拒），保存后立即生效，不用重启。没有用 DSH 的 settings 服务：它第一次保存时会把整个插件条目（包括 endpoint 等普通配置）复制进用户 profile，之后 `config/studio.patch.yml` 里对这个条目的修改都会被这份副本盖住。
- 关掉开关：工具和提示词立即撤下，所有沙箱被删除。D/F 盘文件不受影响。
- 用户能选的最大值由 sandbox-manager 的环境变量决定（下表），超出会被拒绝。CPU、内存变化会让沙箱在下一条命令时重建。
- 闲置超过设定分钟数的沙箱被停止（gVisor 下装过的包随之丢失）；停止 24 小时后删除容器。sandbox-manager 每分钟检查一次。

| 变量（compose 里加 `STUDIO_` 前缀） | 默认 | 说明 |
| --- | --- | --- |
| `SANDBOX_MAX_CPUS` | 4 | 每个沙箱 CPU 上限的最大可选值 |
| `SANDBOX_MAX_MEMORY_GB` | 8 | 每个沙箱内存上限的最大可选值（含 `/tmp`） |
| `SANDBOX_MAX_RUNNING` | 8 | 同时运行沙箱数的最大可选值 |
| `SANDBOX_RUNTIME` | `runsc` | 容器运行时；没有安装时设置页会显示，沙箱无法启动 |
| `SANDBOX_STUDIO_VOLUME` | `harnessstudio_studio-data` | Studio 数据卷名；不存在时沙箱没有 `/skills`、`/plugins`（插件设置值在卷外的 `plugin-config.json`，不会挂进来） |
| `SANDBOX_NETWORK` / `SUBNET` / `IP_RANGE` / `PROXY_IP` | `harnessstudio-sandbox` / `172.29.250.0/24` / `.128/25` / `.2` | 内部网络 |

其余：每个沙箱最多 512 个进程，`/tmp` 1 GB，一条命令默认 300 秒、最长 1800 秒。

## 无软件模式

没有 vm_manager 时，任务文件在 Studio 数据卷的 `studio/files/<projectId>/tasks/<taskId>`，项目公共空间在 `studio/files/<projectId>/shared`，目录结构和 vm_manager 的 projects 目录相同，挂载规则（上表）不变，只是表里的 `<projects>` 换成这个目录，也没有 D 盘、F 盘的说法。提示词换成 `prompts/sandbox-no-software-system-prompt.md`，工具说明里不提虚拟机。

sandbox-manager 用数据卷的子路径挂载这些目录，不需要宿主机路径。它的配置：

| 变量 | 值 | 说明 |
| --- | --- | --- |
| `SANDBOX_FILES_VOLUME` | `<compose 项目名>_studio-data` | 设了就按数据卷子路径挂载任务空间（不设就是 vm-manager 模式的宿主机目录挂载） |
| `SANDBOX_FILES_VOLUME_ROOT` | `/var/lib/harnessstudio`（默认） | 这个卷在 sandbox-manager 里挂载的位置，要和 Studio 里一样 |
| `SANDBOX_PROJECTS_ROOT` | `/var/lib/harnessstudio/studio/files` | 用来校验挂载的目录 |

数据卷要**只读**挂进 sandbox-manager（`studio-data:/var/lib/harnessstudio:ro`），不再挂 vm_manager 的 projects 目录。

沙箱里的命令以 root 运行，而这个模式下 Studio 以 UID 1000 运行。为了让 Studio 之后还能修改、清空、删除沙箱写出的文件，sandbox-manager 每条命令结束后把 `/workspace`、`/shared` 里属于 root 的文件改回 `studio/files` 目录的属主（这个目录不会挂进任何沙箱，命令改不了它）。vm-manager 模式不做这一步。

## gVisor

沙箱用 gVisor（`runsc`）隔离：沙箱里的系统调用由 gVisor 的用户态内核处理，不直接落到宿主机内核。安装（Ubuntu，root）：

```sh
curl -fsSL https://gvisor.dev/archive.key | gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" > /etc/apt/sources.list.d/gvisor.list
apt-get update && apt-get install -y runsc
cp /etc/docker/daemon.json /etc/docker/daemon.json.bak-before-gvisor
runsc install                 # 在 daemon.json 里加 runtimes.runsc，保留原有配置
systemctl reload docker       # 只重新加载配置；不要 restart，否则所有容器（包括虚拟机）会重启
docker info --format '{{json .Runtimes}}' | grep -o runsc
```

## 部署

用 `harnessstudio` 命令部署时，沙箱按配置 `HS_SANDBOX` 自动开启，token 和三个镜像都由命令准备（`docs/deploy-cli.md`）。下面是手写 compose 命令时的步骤。

1. 生成 token：`python3 -c "import secrets; print(secrets.token_urlsafe(36))" > .studio/deploy/secrets/sandbox-token && chmod 600 .studio/deploy/secrets/sandbox-token`
2. 构建三个镜像：`docker build --target sandbox -t harnessstudio/sandbox:1 .`，以及 compose 的 `build sandbox-manager sandbox-egress`。本机直连 deb.debian.org 和 PyPI 很慢时，沙箱镜像可以加 `--network host --build-arg HTTP_PROXY=http://127.0.0.1:7897 --build-arg HTTPS_PROXY=http://127.0.0.1:7897` 走宿主机代理；Studio 镜像不要加，否则构建缓存失效、要重新下载整个 DSH 依赖。
3. 给 Studio 叠加这个 overlay 后 `up`（命令见 `CLAUDE.md` 的「构建与部署」），`sandbox-manager`、`sandbox-egress` 一起启动。
4. 在设置页确认状态是「已开启 · 正在运行 0 个沙箱」。

## 验证

不需要真实模型：Studio 带 `STUDIO_SMOKE=1` 时，在对话里发 `[sandbox-run] {"command":"uname -r"}`，smoke 模型会调用一次 `studio_sandbox_run` 并原样返回结果（工具没提供时回答 `not offered`）。注意 `config/smoke.patch.yml` 会换掉 studio-domain 的配置、关掉 vm_manager 存储，在 vm-manager 部署里只插入 `studio-smoke` 插件即可。gVisor 下 `uname -r` 是 `4.19.0-gvisor`；资源上限看 `docker inspect`，沙箱里的 `/sys/fs/cgroup` 是 gVisor 自己模拟的。

回滚：去掉 `-f deploy/compose.sandbox.yml` 重新 `up` studio，再 `docker compose ... rm -sf sandbox-manager sandbox-egress`，用 `docker ps -a --filter label=harnessstudio.sandbox=1` 找出剩下的沙箱并删除。

## 排查

- 设置页的状态行：连不上 sandbox-manager、运行时没装、镜像不存在，都会直接写出来。
- `docker logs <project>-sandbox-manager-1`：每次创建、重建、停止、删除沙箱都有一行。
- `docker ps -a --filter label=harnessstudio.sandbox=1`：所有沙箱；标签里有对话、项目和任务 ID。
- 代理日志：`docker logs <project>-sandbox-egress-1`，被拒绝的请求是 `TCP_DENIED/403`。
