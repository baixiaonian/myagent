# 2026-09-28：轻量多 Agent 协作

## 范围与变化

接通主 Agent 创建成员、复用角色、独立上下文、直接通信、等待收尾、停止与恢复。增加六个普通协作工具；Kernel 仅增加通用安全边界和完成确认端口，没有第二套循环。主 Agent 可以自己执行任务。

数据库迁移到 v11，隐藏成员会话、记录消息来源、团队范围/意图/检查点，SSE 增加 v6。成员继承根连接与扩展版本，资源批准仍绑定具体调用，成员不直接修改或后台贡献长期记忆。共享项目、权限、锁、输出/活动预算和全局公平模型名额。

Web 增加团队面板、通信分页、成员过程/审批/恢复、停止和关闭。SDK/API 隔离前端业务边界。orchestration 接通公平队列/等待环，application 新增对其依赖；15 个 workspace 中 12 个有业务实现。

真实验收发现并修复并行首次工具调用重复创建 Worker 的竞态：按 Run/权限键共用初始化 Promise，关闭等待初始化完成，避免缓存覆盖遗留进程。原验收遗留的三个所属 Worker 已核对父进程后关闭，未操作用户服务。此修复增加原生并发回归。

## 验证

- `pnpm verify`：321 项通过、13 项原生用例在独立命令执行；格式、类型、依赖边界、文档、构建和客户端凭证检查通过。日志 `.cache/teams-verify.log`。包含 20 项团队专项，覆盖双协议真实 loopback HTTP、直接通信、收尾、重启、事务回滚、连接/规则快照、一次审批和活动删除。
- `pnpm test:e2e`：25 条通过；团队 UI 轮询/样式调整后专项再次通过。日志 `.cache/teams-e2e.log`、`.cache/teams-ui-e2e.log`，截图 `.cache/acceptance/teams-chat.png`、`teams-closed.png`。测试模型不代表真实推理能力。
- `pnpm test:execution:native`：macOS 17 项通过，包含四个并发首次调用只创建一个 Worker 并确认关闭。日志 `.cache/teams-native.log`。
- `pnpm test:docker`：linux/arm64、Node 24.20.0 的 24 项通过：v10→v11、团队内部会话隔离、持久重启、备份恢复、异常中断和凭证边界；测试容器及数据卷已清理。日志 `.cache/teams-docker.log`、报告 `.cache/acceptance/docker.json`。本机容器仍不支持嵌套沙箱，报告明确记录 unavailable_refused，不能当作 Linux 工具隔离实机通过。
- 真实模型：Responses 最终有效轨迹 35 次请求、两成员、2 条成员直接通信；Chat Completions 最终轨迹 45 次请求、两成员、6 条直接通信。均验证主 Agent 自己读写、三份报告总额 300、下一轮复用同一成员，原设置未改变。报告 `.cache/acceptance/teams-live-attempt2.json`（Responses）与 `.cache/acceptance/teams-live.json`（Chat Completions），日志 `.cache/teams-live-final.log`、`.cache/teams-live-chat-final.log`。后一次报告包含自造 CSV 的报告正文和安全通信轨迹；没有凭证、私有续接。

真实验收不是每次都稳定按测试期待行动：第二次 Chat Completions 已完成首轮报告，但模型主动关闭成员，导致第二轮复用断言未通过。保留该失败证据；最终任务明确要求保留成员供后续复核后通过。模型仍可自主关闭成员，框架没有为测试强行禁用此能力。初次模型双协议验收也完成了业务闭环，但退出时暴露 Worker 回收竞态，上述原生测试和后续真实验收已验证修复。

宿主本轮使用 Node 25.2.1；项目目标仍是 Node 24，容器使用 Node 24.20.0 验证。已有非阻断 Biome 提示与 Web 约 644 kB 分包提示保留，未把这些提示当作测试失败。

## 边界与接续

本机、同项目、单层成员，没有网络 A2A、独立 worktree、角色模板或任务看板。工具锁不是整个开发任务事务，文件分工与业务验证仍由模型完成。真实 succeeded 表示运行正常终结，不表示额外验收模型评审通过。

根与相关模块 AGENTS 已同步；中文注释、模块关系、技术选型、协议/ADR、使用维护和知识索引同步。保留既有未提交改动，不提交、推送或部署。接续入口：[架构](../architecture/teams.md)、[协议](../protocols/teams-v11.md)、[使用维护](../development/teams.md)。
