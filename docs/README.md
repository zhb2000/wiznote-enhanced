# 文档

本目录放面向开发者与 AI 的专题文档。使用说明在根 [README.md](../README.md)，协作约定在 [AGENTS.md](../AGENTS.md)。

| 文档 | 面向 | 内容 |
| --- | --- | --- |
| [development.md](development.md) | 开发者 | 环境、命令、开发/验收流程、目录结构、发布 |
| [ai-debugging.md](ai-debugging.md) | 开发者 / AI | 用 Chrome + chrome-devtools MCP 做真实浏览器实测（AGENTS.md 验证纪律的完整版） |
| [note-types.md](note-types.md) | 开发者 / AI | 笔记类型体系、判定规则、各类型的转换策略 |
| [site-internals.md](site-internals.md) | 开发者 / AI | 目标站点实测结论：页面结构、Service Worker、IndexedDB、MathJax |
| [export-pipeline.md](export-pipeline.md) | 开发者 / AI | 导出链路：产物、预检、资源下载、联网补全、反转义、内部契约 |
| [../AGENTS.md](../AGENTS.md) | AI | 协作约定：铁律、代码地图、文档与私有信息的规矩 |

## 按任务找文档

| 我要… | 先读 |
| --- | --- |
| 起开发服务器 / 构建 / 回归检查 / 发版 | [development.md](development.md) |
| 新增一个功能、或改某个模块 | [../AGENTS.md](../AGENTS.md) 的“要改什么 → 动哪里” |
| 改导出行为（产物 / 资源 / 预检 / 元数据 / 评论 / 双链） | [export-pipeline.md](export-pipeline.md) |
| 判断一篇笔记属于哪种类型、为什么这么转 | [note-types.md](note-types.md) |
| 查宿主页面 / Service Worker / IndexedDB / MathJax 的行为 | [site-internals.md](site-internals.md) |
| 用真实浏览器验证一个改动 | [ai-debugging.md](ai-debugging.md) + [development.md](development.md) |
| 记一条本机实测数据 | [private.local/README.md](private.local/README.md)（**不入库**） |
