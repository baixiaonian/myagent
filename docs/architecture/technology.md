# 技术选型与落地

直接依赖固定版本，以 package.json / pnpm-lock.yaml 为准。

| 技术 | 当前用途 |
| --- | --- |
| Node.js 24 LTS / pnpm 11.7.0 | 推荐运行环境与 workspace |
| TypeScript 6.0.3 / ESM strict | 模块边界与项目引用 |
| React 19.2.8 / Vite 8.2.2 | Web 聊天、设置、开发代理与构建 |
| Fastify 5.12.3 / @fastify/static 10.1.3 | 本机 API、JSON Schema 校验、生产 Web 托管 |
| better-sqlite3 13.0.3 / Drizzle 0.45.2 | SQLite WAL、同步事务与类型化查询 |
| OpenAI TypeScript SDK 7.10.0 | 自定义基础地址的 Responses / Chat Completions 流式适配器；关闭重试 |
| proper-lockfile 4.1.2 | 单数据目录进程互斥 |
| react-markdown / remark-gfm / rehype-highlight | 安全 Markdown、表格与代码高亮；不执行 HTML |
| Lucide React | 一致的功能图标 |
| Biome 2.5.12 / Vitest 5.0.0 / Playwright 1.63.0 | 静态检查、内核与 HTTP 集成、浏览器验收 |

FTS5、容器执行沙箱、PostgreSQL / pgvector 尚未接入。Docker 仅用于部署本地产品，不是工具执行沙箱。

依据：[OpenAI Responses 迁移](https://developers.openai.com/api/docs/guides/migrate-to-responses)、[OpenAI Chat Completions SDK](https://developers.openai.com/api/reference/typescript/resources/chat/subresources/completions/methods/create)、[Fastify](https://fastify.dev/docs/latest/)、[Drizzle SQLite](https://orm.drizzle.team/docs/get-started-sqlite)、[React Markdown 安全边界](https://github.com/remarkjs/react-markdown#security)。聊天基线见 [ADR-0003](../adr/0003-local-web-chat.md)，自主循环与双协议取舍见 [ADR-0004](../adr/0004-autonomous-agent-loop.md)。

Ajv 8.20.0 仅由 adapters 使用，用于与工具声明共用 JSON Schema 的最终参数校验；MIT，无安装脚本。新增决策见 [ADR-0004](../adr/0004-autonomous-agent-loop.md)。

原生隔离使用 `@anthropic-ai/sandbox-runtime` 0.0.76（Apache-2.0），MCP 使用 `@modelcontextprotocol/sdk` 1.30.0（MIT）；两者只由 adapters 引入。SQLite 执行记录升级到 v3。能力、平台条件与安全边界见 [ADR-0005](../adr/0005-controlled-tool-execution.md)。

项目与 MCP 管理阶段继续使用既有 Node/SQLite/MCP SDK，并引入数据库 v4。macOS 目录窗口使用系统 AppleScript，Linux 桌面使用可用的 Zenity；无桌面显式回退目录浏览。该阶段没有新增 npm 依赖。

命令权限新增 web-tree-sitter 0.25.10 与 tree-sitter-bash 0.25.1，均为 MIT，只在 adapters 使用发布包中的 WASM。前者无安装脚本，后者 node-gyp-build 被 allowBuilds:false 禁用，生产不依赖原生 Tree-sitter 绑定。命令阶段数据库 v5，决策见 [ADR-0009](../adr/0009-command-permissions.md)。

上下文管理沿用 SQLite 与当前双协议模型，无新增运行时依赖。token 使用协议请求 UTF-8 字节估算并预留余量；不引入向量库或外部 Agent 框架。见 [上下文架构](context-management.md)。

长期记忆沿用 Node 文件系统、Markdown 和 SQLite v7；用中文子串/多关键词及标题二元组检索，不引入向量库、模型框架或新依赖。正文/文件日志/可重建索引边界见 [ADR 0011](../adr/0011-long-term-memory.md)。

Skill 的 YAML 元信息由 adapters 中 yaml 2.8.2 解析（ISC，无安装脚本），关闭别名扩展和非标准类型；不引入 Agent 框架。

插件沿用本地包、SQLite 和既有三类能力，不引入运行时框架或 npm 依赖；公开 Git 获取使用系统 Git 读取对象，Docker 运行镜像补 Git 与 CA，禁用仓库执行/宿主配置。当前数据库 v11，具体兼容边界见 [插件协议](../protocols/plugins-v10.md)。

轻量团队不新增外部框架或 npm 依赖；使用 SQLite v11 事务和现有异步模型端口，FIFO 队列约束全部模型请求，执行继续复用 Worker/沙箱。见 [团队 ADR](../adr/0015-lightweight-agent-teams.md)。

OpenTelemetry API 1.9.1 / sdk-trace-base 2.11.0 / exporter-trace-otlp-proto 0.222.0 仅由 adapters 引入，Apache-2.0、Node >=20.6、无额外安装脚本；Node 24 已验证。显式 Span/事件，关闭自动 HTTP/正文 instrumentation；OTLP 默认关闭。[ADR-0016](../adr/0016-local-observability-and-raw-capture.md)。
