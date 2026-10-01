# orchestration

轻量团队协调原语，当前提供 FIFO 模型并发队列和等待环检测。持久任务/收件箱与运行调用由 application/TeamService 协调，不在此包内复制状态。

- 入口：`src/index.ts`；内部只依赖 `@myagent/contracts`。
- 通过 contracts 中立 RunCommandPort 协作，禁止反向依赖 application 或创建第二个循环。
- Workflow、网络 A2A、递归团队与后台任务仍未实现。
- 见 [团队架构](../../docs/architecture/teams.md)、[模块关系](../../docs/architecture/modules.md)、[当前状态](../../docs/STATUS.md)。
