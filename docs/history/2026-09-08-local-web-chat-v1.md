# 2026-09-08：本地 Web Chat v1

## 目的与范围

依据用户确认的计划，在已有框架内实现单用户本地文字聊天产品，交付 Web、本地后端、测试、Docker 和维护文档；不部署公共服务。

## 实现变化

contracts 定义 Session / Message / Run / Settings、命令事件和错误；SDK 封装 HTTP / SSE 与投影去重。application 管理运行和设置快照；kernel 提供零工具单调用运行、取消 / 超时和完整轮次上下文裁剪。state 保持仓储契约；adapters 实现 SQLite WAL / Drizzle、独立凭证文件和官方 OpenAI Chat Completions 流式接口。server 装配 JSON API、SSE、恢复、目录锁和生产静态资源。

Web 提供浅色工作台、移动抽屉、会话管理、流式聊天、停止、重试、重新生成、Markdown、复制、配置引导和连接测试。重新生成候选与旧答案分开，成功事务中替换。浏览器断开不取消执行。SDK fetch 使用正确调用接收方式；不确定的提交失败保留幂等标识及草稿。

新增 pnpm dev 多进程统一管理、build / start、test:e2e 和客户端构建边界检查；自定义 PORT / MYAGENT_WEB_PORT 与开发代理一致。提供 Node 24 Docker 多阶段镜像、loopback Compose、数据卷和健康检查。数据库版本 1，事件 schemaVersion 1。

## 验证结果

- `pnpm install --frozen-lockfile`、SQLite 原生驱动安装成功；本机 Node 25.2.1 / pnpm 11.7.0。
- `pnpm verify`：31 项测试通过，类型 / Biome / 架构 / 文档检查通过，生产构建和客户端产物边界检查通过。
- `pnpm test:e2e`：5 组 Chromium 流程通过，覆盖会话全流程、多轮、失败保护、IME 合成事件、刷新 / 草稿 / 取消、移动端、丢失响应幂等重试、阅读不追尾。
- 官方 SDK 对本地测试兼容服务执行真实 HTTP 流，验证分片、错误、取消、无 usage。此证据不代表任何远端真实模型已联通。
- 内置 Browser 实际检查首次设置与桌面工作台；生产服务与健康接口正常，开发编译 / 后端 / Vite 一次启动成功。使用 14300 / 15173 验证开发端口覆盖和 API 代理，退出后整组进程停止。
- `docker compose config --quiet` 通过；Docker daemon 不可用，容器构建 / 运行未验收。远程 CI 未运行。
- 未提供有效模型配置，真实多轮模型联通尚未验收。
- 原始架构 HTML SHA-256 保持 `b0a28cd51d849114e85dae14f684d636e923fd87a8f6b3b1ded13d8822b13da2`，未发布任何公共服务。

## 知识同步

更新根、apps、kernel、state、adapters AGENTS；新增 web / server / application / tests 局部约定。已检查 packages、scripts、docs 的现有约定，规则继续有效。更新 STATUS、产品目标、有效架构、模块关系、技术选型、协议、维护 / 测试、路线及 README；新增 ADR-0003。未涉及的模块继续标记骨架。

## 限制与接续

本机单用户、凭证文件未加密、草稿只在当前页面内存、历史事件与答案旧版暂不压缩。Web 构建目前单 JS 包约 539 kB（gzip 169 kB），后续可按实际首屏性能拆分 Markdown。Docker engine 可用后补充镜像和卷恢复验收；用户在设置中提供有效配置后补真实两轮问答证据。完整 Agent 工具 / 内容 / 编排 / CLI / Worker 等继续预留。

入口：[当前状态](../STATUS.md)、[ADR-0003](../adr/0003-local-web-chat.md)、[API](../protocols/chat-v1.md)、[维护说明](../development/setup.md)。
