# 无软件模式（`STUDIO_SEAT_BACKEND=none`）

没有 vm_manager 的机器上，Studio 以“没有软件”的方式运行：网页上没有软件区，Agent 看不到任何软件或虚拟机工具，只用文件工具、Linux 沙箱（装了 gVisor 时）、联网和技能完成任务。不用模拟软件（Mock）冒充。部署命令 `harnessstudio` 在没有 vm_manager 时设置这个模式（`cli/设计.md` 第 4、5 节）。

`STUDIO_SEAT_BACKEND` 的三个取值：

| 值 | 用途 | 软件 |
| --- | --- | --- |
| `mock`（默认） | 开发和测试 | Mock 软件平台（mock-seat） |
| `vm-manager` | 线上 | vm_manager 的 Windows 虚拟机 |
| `none` | 没有 vm_manager 的部署 | 无 |

## 前端怎么判断

`GET /api/studio/status` 带 `softwareBackend: 'none' | 'mock' | 'vm-manager'`。前端本来就每秒轮询这个接口，`plugins/ui/src/software-backend.ts` 把它放进 React context（`useSoftwareBackend()`、`useNoSoftware()`）。字段缺失时（旧版本服务）按原来的方式显示。

## 后端

- **插件**：`studio-domain` 和 `studio-software-seat` 都从 `STUDIO_SEAT_BACKEND` 读后端（`config/studio.patch.yml`，smoke 的补丁也一样）；两者不一致时 Studio 拒绝启动。`seat.ts` 在 `none` 时交给 `no-software.ts`。
- **工具**：不注册 `studio_software_*`、`studio_vm_*`（也就没有后台运行、录屏、授权续期）。对话的工具限制只列已注册的工具，不受影响。
- **提示词**：软件提示词的位置（order 113）换成 `prompts/software-none-system-prompt.md`，说明这个部署没有接入工业软件；沙箱和自主运行用 `*-no-software-system-prompt.md` 这几份变体，不提虚拟机、D 盘、F 盘；技能说明和工具说明里的虚拟机内容也换掉。单元测试会检查变体只改了提到虚拟机的行，基础提示词改了别的行而变体没跟上时测试失败。
- **软件接口**：`/api/studio/software/*` 的每一个接口都返回 404 `{ error: '当前部署没有接入软件（无软件模式），软件和虚拟机功能不可用', code: 'SOFTWARE_NOT_CONFIGURED', softwareBackend: 'none' }`。
- **配置**：不需要 mock-seat 服务，不读 `STUDIO_SEAT_URL`、`STUDIO_SEAT_TOKEN(_FILE)`；容器入口和 `scripts/start.mjs` 在 `none` 时都不要求、也不启动 Mock 平台。
- **自主模式**：运行的“同时开的虚拟机”固定为 0（启动和修改时传来的值被忽略），总 Agent 的第一条消息、`studio_autonomy_status` 的预算、`studio_autonomy_stop_worker` 的说明里都没有虚拟机。设置页保存的默认值不受影响。
- **项目导出**：照常，没有 `vm/` 部分，也没有虚拟机相关的警告；导出到磁盘时写在 `studio/exports/<projectId>/`。

## 文件放在哪

和 vm_manager 的 projects 目录同样的结构，但在 Studio 数据卷里，由 Studio 自己管理：

```
studio/files/<projectId>/tasks/<taskId>/   任务文件
studio/files/<projectId>/shared/           项目公共空间（项目技能在 shared/skills）
```

- 对话的私有临时文件（`.chat-tmp`）仍在 `studio/workspaces/<taskId>/`，不和任务文件放在一起，也不会挂进沙箱。
- 清空任务时删除它的文件，删除任务时删除它的目录，删除项目时删除整个项目目录（vm-manager 模式下 vm_manager 的任务空间会保留，这里没有别的地方保留它们）。
- 网页上的“项目文件”有项目公共空间，可以上传、新建、编辑，批量命令上传的文件也放在这里。

## 沙箱

挂载规则和 vm-manager 模式相同，只是来源是上面的目录。sandbox-manager 用 Studio 数据卷的子路径挂载，需要 `SANDBOX_FILES_VOLUME`、`SANDBOX_FILES_VOLUME_ROOT`、`SANDBOX_PROJECTS_ROOT` 和只读挂载的数据卷，不挂 vm_manager 的 projects 目录；命令结束后把沙箱以 root 写出的文件交还给 Studio 的用户。详见 `docs/sandbox.md`「无软件模式」。

## 界面上不出现的内容

工作台的「软件」标签和软件区（文件区占满整个区域）、虚拟机启动入口、录屏查看和完成记录里的录屏区块、自主模式启动对话框、运行面板和设置页里的“同时开的虚拟机”和虚拟机用量条、“子 Agent 模型不支持图片”的虚拟机提醒、导出对话框的“包含屏幕录像”，以及各处的“虚拟机”“D 盘”“F 盘”字样（改称“任务文件”“项目公共空间”）。技能页不再提供“在虚拟机里运行”的选项；已经标成在虚拟机运行的技能显示“这个部署没有接入软件，这个技能不能运行”。

## 切换后端时

三种模式的任务文件不在同一个地方，切换后端不会搬动文件：Mock 的在 `studio/workspaces/`，无软件模式的在 `studio/files/`，vm-manager 的在 vm_manager 的 projects 目录。一个数据卷用哪个后端，部署后就不要再改；要接入 vm_manager，先把 `studio/files/` 里的文件搬到 vm_manager 的任务空间（参考 `scripts/migrate-vm-storage.mjs` 的做法）。

## 验收

- 单元测试：`tests/no-software.test.mjs`。
- 集成验收：`scripts/verify-no-software.mjs`（`npm run test:no-software`），在测试镜像里运行，用 smoke 模型检查模型拿到的工具和系统提示词、软件接口、文件位置、完成、导出和一次自主运行。
