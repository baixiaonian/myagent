# 技术选型与落地

直接依赖固定版本，以 package.json / pnpm-lock.yaml 为准。

| 技术 | 当前用途 |
| --- | --- |
| Node.js 24 LTS / pnpm 11.7.0 | 推荐运行环境与 workspace |
| TypeScript 6.0.3 / ESM strict | 模块边界与项目引用 |
| React 19.2.8 / Vite 8.2.2 | Web 聊天、设置、开发代理与构建 |
| Fastify 5.12.3 / @fastify/static 10.1.3 | 本机 API、JSON Schema 校验、生产 Web 托管 |
| better-sqlite3 13.0.3 / Drizzle 0.45.2 | SQLite WAL、同步事务与类型化查询 |
| OpenAI TypeScript SDK 7.10.0 | 自定义基础地址的 Chat Completions 流式适配器；关闭重试 |
| proper-lockfile 4.1.2 | 单数据目录进程互斥 |
| react-markdown / remark-gfm / rehype-highlight | 安全 Markdown、表格与代码高亮；不执行 HTML |
| Lucide React | 一致的功能图标 |
| Biome 2.5.12 / Vitest 5.0.0 / Playwright 1.63.0 | 静态检查、内核与 HTTP 集成、浏览器验收 |

FTS5、MCP、容器执行沙箱、OpenTelemetry、PostgreSQL / pgvector 尚未接入。Docker 仅用于部署本地产品，不是工具执行沙箱。

依据：[OpenAI Chat Completions SDK](https://developers.openai.com/api/reference/typescript/resources/chat/subresources/completions/methods/create)、[Fastify](https://fastify.dev/docs/latest/)、[Drizzle SQLite](https://orm.drizzle.team/docs/get-started-sqlite)、[React Markdown 安全边界](https://github.com/remarkjs/react-markdown#security)。本轮取舍见 [ADR-0003](../adr/0003-local-web-chat.md)。
