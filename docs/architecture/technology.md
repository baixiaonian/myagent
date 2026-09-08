# 技术选型与落地状态

## 已安装的工程依赖

- Node.js 24 LTS 为推荐 / CI 环境；pnpm 11.7.0 固定在 packageManager。
- TypeScript 6.0.3、ESM、strict、NodeNext、项目引用。暂选成熟 6.x 编译器 API 供工程导入检查使用；升级主版本需验证检查器。
- React 19.2.8 + Vite 8.2.2：只承载 Web 工程占位页。
- Biome 2.5.12：新工程的格式与静态检查。
- Vitest 5.0.0：工程检查器回归验证。tsx 4.23.13：Node 入口的开发监听。
- 直接依赖固定精确版本，完整解析以 pnpm-lock.yaml 为准。

## 目标选型，尚未接入

Fastify、JSON Schema / Ajv、SQLite WAL + better-sqlite3 + Drizzle、FTS5、模型官方 SDK、MCP TypeScript SDK、Playwright、受限容器、Pino / OpenTelemetry，以及规模需要时的 PostgreSQL / pgvector。

在对应功能进入迭代时才安装和验证。保留 HTML 中的理由与替换条件，不一次性引入所有包。

## 官方资料

[pnpm workspace](https://pnpm.io/workspaces) 定义工作区和 workspace 协议；[TypeScript 配置](https://www.typescriptlang.org/tsconfig/) 用于工程编译；[Vite 指南](https://vite.dev/guide/) 用于 Web 开发与构建。

版本根据初始化时 npm 官方包元数据选择，并由锁文件固定。官方文档的默认版本可能继续变化，升级时以安装版本为准。
