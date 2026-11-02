<!-- HARNESSSTUDIO_PROMPT_METADATA
{
  "id": "project-live-context-system-prompt",
  "title": "项目实时图谱上下文模板",
  "loadStage": "Studio 服务启动时读取并校验占位符；项目会话每次组装模型请求前，以当前项目图谱第一页替换占位符。",
  "modelScopes": [
    "仅项目规划会话，system prompt 的 studio:project-context 段，顺序 105。"
  ],
  "contextRecords": [
    "替换后的正文会进入 Session system/message、模型请求审计、Provider HTTP 请求和对话调试 JSON。",
    "本注释由 prompt loader 在启动时剥离，不进入模型上下文或上述记录。"
  ],
  "reloadPolicy": "编辑后须重启 Studio；缺失、重复或额外占位符会使启动失败。"
}
-->

Current owned project and live planning graph (first page; use studio_graph_context offset/limit to retrieve further relevant nodes):
{{LIVE_PROJECT_CONTEXT_JSON}}
