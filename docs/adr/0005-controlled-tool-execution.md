# ADR 0005：受控工具执行与准确结果反馈

状态：已采用。日期：2026-09-15。延续 [ADR 0004](0004-autonomous-agent-loop.md) 的单一自主循环。

模型自主决定调用哪些工具、是否计划和何时结束。框架只管理执行环境，不增加固定规划流程。ToolExecutor 批次端口背后由应用服务组合注册、Policy、审批、资源锁、执行适配和持久化；Worker 与 MCP 不创建另一个 Agent Loop。

采用用户确认的每会话工作区、工作区内自主、跨界审批和原生 macOS/Linux 沙箱。没有隔离依赖时明确不可用，不降级到普通子进程。Docker 保留产品打包用途，本轮没有 Docker 执行后端，也不通过提升容器权限来掩盖原生沙箱探测失败。

调用、逻辑执行与真实尝试分离；先保存意图再派发。取消/超时不等价于副作用撤销。未知结果隔离资源，重启核对后人工继续；副作用问题以明确确认的新候选 Run 重跑。完整结果和模型视图分开，模型始终得到配对、有界、带来源的结果。

串行并行调度属于执行器：共享读取可并行、写入受路径锁保护、Shell 与未知 MCP 有排他边界。计划仍是普通可选工具，不驱动调度。MCP annotations 不作为授权证据。

研究借鉴：Codex 的工具路由/审批/执行职责分离，Pi 的完整输出与截断模型视图，DeepSeek Harness 的有界调度和排他屏障。参考快照分别为 `5ecb3afd1bf405149e2159bfda50093b0c1b5fab`、`e687434a60174db1a9c961d973881a7a851a0597`、`d347e703908d0406b7a7ef80e3a0e594d86b2215`，位于只读 research/upstream；没有引入它们的 Agent 框架。

依赖：`@anthropic-ai/sandbox-runtime` 0.0.76（Apache-2.0）、`@modelcontextprotocol/sdk` 1.30.0（MIT），只声明于 adapters。许可证和 Node/平台要求已按安装包核验。平台测试分别报告，macOS 通过不能替代 Linux 真实隔离证据。

详细实现及不能承诺的语义见 [工具执行设计](../architecture/tool-execution.md)。
