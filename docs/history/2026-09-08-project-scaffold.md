# 2026-09-08：工程骨架初始化

## 目的与范围

按现有设计初始化可迭代工程，不实现 Agent 各模块的具体功能。用户要求同时建立 AI 开发约定和持续更新的项目知识。

## 本轮变化

- 4 个应用、11 个库包、职责子目录及扩展 / 配置 / 迁移 / 评测预留位置。
- pnpm、精确版本依赖、TypeScript 项目引用、Biome、Vitest 与 CI 骨架。
- 可启动的 Web 占位页和 Node 占位入口；业务包公开入口为空模块。
- 包依赖检查、文档链接 / 结构检查与检查器回归用例。
- 根与局部 AGENTS.md；产品、架构、模块、协议规划、ADR、开发流程、状态与历史。
- 初始化本地 Git，忽略研究上游、依赖、编译缓存和运行数据；保留原设计交付物。

## 架构细化

[ADR-0002](../adr/0002-workspace-and-tooling.md) 记录工作区颗粒度、入口文件、编译策略及最小依赖。RunCommandPort 预留在 contracts/commands，由应用层实现、组合根注入；当前协议仍未定义。

## 验证

本地环境：macOS，Node.js v25.2.1，pnpm 11.7.0；推荐 / CI 目标为 Node 24 LTS，本轮未在该版本或远程 CI 上执行。

- `pnpm install --frozen-lockfile`：通过，锁文件可复用。
- `pnpm verify`：通过；Biome 检查 59 个文件，架构与文档检查通过，工作区及工具测试代码的类型检查通过。
- `pnpm test`（包含于 verify）：2 个测试文件、8 个工程测试通过，覆盖合法依赖、深路径 / 跨包导入、纯内核边界、循环和知识链接。
- `pnpm build`（包含于 verify）：全部 TypeScript 项目编译，Vite Web 构建完成。
- Web 开发服务器在 loopback 启动；首页和 main.tsx 均 HTTP 200，返回骨架文案。
- server / cli / worker 的编译入口均启动并输出骨架提示后正常退出。
- Git 忽略规则确认覆盖 research/upstream、node_modules、dist 和 .cache；原架构 HTML 的 SHA-256 与已托管记录一致。
- 验证用的 Web 开发服务器已停止；需要开发时使用 pnpm dev 重新启动。

首次检查发现 Biome 遍历研究上游配置，已用显式排除目录修正；随后完成整套验证。没有修改上游快照。上述检查证明工程骨架可用，不代表业务功能、沙箱或生产部署已完成。

## 知识同步与接续

根 / 局部 AGENTS.md 与 docs 同步新建。下轮先读 [STATUS](../STATUS.md) 和 [路线](../roadmap.md)，在明确功能任务中开展第一个纵向闭环。

已知限制：没有模型、HTTP API、工具、持久化或沙箱实现；没有自动提交、关联远程或重新发布线上报告。CI 文件就绪不表示已执行远程 CI。
