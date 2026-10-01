# 2026-09-15：受控工具执行系统

## 目的与范围

落实已确认的原生沙箱、会话工作区、自主执行、跨界审批、双传输 MCP、人工恢复与副作用重跑方案。核心问题是把完整模型指令转成受控动作，再把真实结果准确反馈给模型。没有增加强制计划、反思或第二个 Agent Loop，没有提交推送或公共部署。

## 改动

- contracts/state：工作区、权限/审批、invocation/attempt、进程、结果引用、MCP 连接、恢复检查点和最小隔离记录。
- kernel：批次端口、纯 Policy、4/8 有界调度和层级资源锁；持久检查点仍在唯一循环。
- application：审批与幂等、执行意图/回执、未知隔离、重启核对、活动时间预算、手动恢复及副作用重跑确认。
- adapters/worker：原生 SRT 沙箱、文件哈希与原子替换、命令 stdin/输出/终止、完整结果分页；MCP 官方 SDK、HTTP/stdio、OAuth/PKCE/刷新及撤销结果说明。
- server/sdk/web：v3 API/事件、工作区/MCP 配置、审批、核对、命令输出、完整结果分页和重跑确认。
- SQLite 升级到 v3，旧记录保留，不伪造历史调用。文档入口、局部 AGENTS、模块清单和 ADR 0005 已同步；原有未提交的文档修改保持在本地。

## 验证证据

`pnpm verify` 通过：97 项工程/协议/持久化测试，格式、依赖边界、文档、类型和生产构建通过；5 个原生用例默认跳过并另行运行。macOS native + MCP 专项 9 项通过，完整执行专项合计 28 项通过。`pnpm test:e2e` 的 10 条流程通过，包含未知远端结果的人工核对与手动继续。

真实 DeepSeek `deepseek-v4-flash`，使用已有凭证在内存中发起请求，独立临时数据/工作区：

| 协议 | 文件任务模型步骤 | 工具调用 | 含后续追问请求 |
| --- | --- | --- | --- |
| Responses | 6 | 7 | 7 |
| Chat Completions | 4 | 4 | 5 |

自然语言任务只要求查看/修改 notes.txt 并运行验证命令，没有提供工具名或固定轮数。实际工具含目录、读取、精确编辑、命令；文件内容与后续追问通过，原设置不变。报告 `.cache/acceptance/execution-live.json`，临时环境已清理。此次未拿生产 MCP 账号冒充协议兼容验收：MCP 是本地真实 HTTP/stdio/OAuth 服务替身证据。

Docker `linux/arm64` / Node 24.20.0，10 项迁移、生产资源、双协议工具、持久化、卷备份恢复、SIGKILL 后 recoverable 与删除检查通过；独立验收项目和卷已清理，报告 `.cache/acceptance/docker.json`。

Linux 原生冒烟在 Docker Desktop 的 Linux VM 内运行生产适配器，验证文件创建/读取/哈希编辑、越界 OS 拒绝、命令输入输出、真实停止和 Run 清理。仅测试容器设置 seccomp/systempaths=unconfined 以允许 bubblewrap 创建命名空间和 proc 挂载，没有改变产品 Compose 或宿主设置。普通最小权限容器确实拒绝原生执行，没有裸执行降级。证据 `.cache/tool-execution/linux-native.log`。这不等于所有 Linux 宿主或默认 Docker 都可运行原生工具。

## 边界与后续入口

- Windows、PTY、跨 Run 后台任务、托管模型工具、MCP sampling/elicitation/tasks、插件/Skill/Hook、内容和编排仍未实现。
- 命令网络仅具体公网域名。原生进程组清理不能承诺主动脱组恶意守护进程的完全回收；未取得可信状态时保留核对资料。
- 文件哈希+原子替换不是跨所有外部编辑器的强事务，Worker 孤立审计文件没有自动清理任务。
- 9 个 workspace 有业务实现，其余 6 个保持骨架。CI 已增加 macOS/Linux 独立原生任务；本轮没有推送触发远端 CI。

接续阅读：[工具执行架构](../architecture/tool-execution.md)、[协议和迁移](../protocols/execution-v3.md)、[使用说明](../development/tools.md)、[ADR](../adr/0005-controlled-tool-execution.md)。
