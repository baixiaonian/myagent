# MyAgent

从零构建可维护、可扩展的通用工作 Agent。采用 TypeScript 模块化单体、稳定运行内核与可替换适配器。

**当前：工程骨架。** Web 有可启动的占位页，其余应用有占位入口；尚无模型调用、工具执行、会话存储或任务运行功能。

## 开始

使用 Node.js 24 LTS 和 pnpm 11.7.0：

```sh
pnpm install --frozen-lockfile
pnpm dev
pnpm verify
```

`pnpm dev` 启动本地 Web 开发服务器。`pnpm dev:server`、`pnpm dev:cli`、`pnpm dev:worker` 仅进入对应开发监听入口并输出骨架提示，不提供业务服务。

## 项目入口

- [AI 开发约定](AGENTS.md)
- [文档地图](docs/README.md) / [当前状态](docs/STATUS.md)
- [产品目标](docs/product/goals.md) / [架构概览](docs/architecture/overview.md)
- [模块关系与目录](docs/architecture/modules.md)
- [迭代记录](docs/history/README.md)
- [原始 HTML 架构报告](agent-architecture.html)
- [在线设计报告](https://knowbit.cn/p/BssJzfkhTv9QnYXmpe0qEh)

源码在 `apps/` 和 `packages/`；`plugins/`、`skills/`、`workflows/` 预留扩展位置。基础设施、存储和模型 SDK 在相关功能开始实现时再接入。
