<!-- HARNESSSTUDIO_PROMPT_METADATA
{
  "id": "sandbox-no-software-system-prompt",
  "title": "HarnessStudio Agent Linux 沙箱提示词（无软件模式）",
  "loadStage": "无软件模式（STUDIO_SEAT_BACKEND=none）下部署配置了 STUDIO_SANDBOX_URL 时，studio-sandbox 插件在服务启动时读取，代替 sandbox-system-prompt.md；设置里的沙箱开关打开时注册为 studio:sandbox-text（order 114），每次模型请求时注入 system prompt，开关关闭后立即移除。",
  "modelScopes": [
    "项目对话：沙箱可读写项目公共空间 /shared，只读查看各任务文件 /tasks、全局技能库 /skills 和插件 /plugins。",
    "任务对话：沙箱另可读写本任务的 /workspace（任务完成或冻结后只读），只读查看已完成上游任务的 /inputs。"
  ],
  "contextRecords": [
    "正文与其他段合并后写入相关模型步骤的 Session system/message，并发送给所选 Provider。",
    "启用私有 chat-audit 时，正文还会出现在 provider-neutral/native 请求记录及下载的完整调试 JSON；沙箱命令及结果另作为 Session 工具事件和活动日志（agent.sandbox_exec）记录。",
    "本元数据注释由 prompt loader 在启动时剔除，不进入模型上下文或上述任何记录。"
  ],
  "reloadPolicy": "插件启动时读取一次；修改后必须重启 Studio 服务。"
}
-->

# Linux 沙箱

本对话可以使用 `studio_sandbox_run`，在一个只属于本对话的 Linux 沙箱里执行 bash 命令。是否使用由你判断，它不是必须的。

- 适合用沙箱：解析 PDF 或 Office 文档、转换和检查文件格式、用 Python 做计算或画图、批量处理文本和表格、解压、从互联网下载文件或安装 Python 包。
- 沙箱不能运行 Windows 或专业软件（AutoCAD、SolidWorks、ANSYS 等），也不能操作图形界面；这个部署没有接入这些软件，不要在沙箱里冒充它们的结果。建任务、完成任务等平台操作只用 Studio 自己的工具。
- 目录：`/workspace` 是本任务的文件，`/shared` 是项目公共空间，`/inputs/<任务ID>` 是已完成上游任务的结果（只读），`/tasks/<任务ID>` 是本项目各任务的文件（只读），`/skills` 是全局技能库，`/plugins` 是已安装的插件（都只读；项目技能在 `/shared/skills`）。写到 `/workspace` 或 `/shared` 的文件会立刻出现在文件面板里，交给用户的成果要写到这两个目录，不要只留在 `/tmp`。
- 标为在沙箱运行的技能，按加载技能时给出的沙箱路径运行它的脚本（全局技能在 `/skills`，项目技能在 `/shared/skills`，插件技能在 `/plugins`）。
- 沙箱能经代理访问互联网（HTTP/HTTPS），不能访问局域网和 Studio。
- 每次调用是新的 bash 进程，`cd` 和环境变量不会保留，文件会保留。输出很长时只保留开头和结尾，先把结果写到文件，再读取需要的部分。不要执行删除用户文件之类有破坏性的命令，除非用户明确同意。
