# Hook 架构

固定时点上的受控脚本扩展，不改变自主 Agent Loop。配置格式、触发语义和恢复见 [Hook v1 协议](../protocols/hooks-v9.md)。

[报告路径检查示例图](../../diagrams/hooks-report-example.png) 展示配置确认、Run 快照以及拒绝后模型自主调整的链路；[图源与实现对应](../../diagrams/README.md)。这是示意流程，不会自动安装或启用示例 Hook。

```text
Web 设置 → SDK → HookService → hooks.json + 精确版本授权
                                 ↓ Run 开始冻结
ChatService ─ RunStart / RunEnd ─ HookService
ToolService ─ Pre / Post ────────┤
                                ↓
                 ExecutionCoordinator（共用锁 / 槽位）
                                ↓
          NativeExecutionGateway（Hook 独立权限配置）
                                ↓
              Worker → 沙箱内 hook.js → argv 脚本
                                ↓
                 结果库 + Hook 记录 + SSE 事务
                                ↓
             ContextService（来源与预算） / Web 展示
```

- `extensions/hooks` 只定义配置、协议校验与文件端口；Kernel 不识别 Hook 名称和事件。
- `application/hooks` 负责配置授权、快照、触发、幂等、故障语义、恢复与注入；ToolService 管理批次串并行，ChatService 管理起止。
- `adapters/hooks/files` 解析受保护路径、固定解释器和资源；共用 `skills/packages` 内容包存储。`execution/gateway` 与 Worker 复用回执、进程取消和隔离设施。
- `state/hooks` 和 SQLite v9 保存派生状态；JSON 与包源文件仍是配置来源。结果未知进入已有资源隔离列表，删除会话也不抹去未核对事实。
- Server 唯一装配，SDK 不持有授权，Web 独立 Hook 页不会建立空会话。

模型只看到有来源的补充资料与拒绝错误；脚本权限来自配置确认，不能自动扩展为模型工具授权。首版不包含后台、MCP、压缩、会话、子 Agent Hook 或参数改写。
