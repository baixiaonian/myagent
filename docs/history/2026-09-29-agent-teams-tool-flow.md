# 2026-09-29：展开多 Agent 的工具调用与启动机制

## 目的与交付

上版关系图没有充分区分“模型工具请求”和“后端普通方法”。增加一张三部分图：spawn_agent 请求经 ToolService / TeamService 后提交成员与任务，由维护器自动启动；send_message 保存后在接收方安全边界注入；主 Agent 和成员的工具可见性/读取范围对照。输出 SVG、114 元素 Excalidraw、图源及自审 PNG，保留上版总体关系图。

## 核对与验证

对照 teamToolDescriptors、TeamService.allowed/execute/spawn/send/boundary/maintain、ToolService.available/execute 及 Server 的 RunCommandPort.startMember 装配。图中参数是固定示意，不含实际会话或凭证。主/成员使用同一工具注册体系，成员排除创建、停止成员和长期记忆修改；消息发送是工具，接收是运行时行为。

生成成功，PNG 视觉检查无重叠或截字；`node --check diagrams/gen-agent-teams-tool-flow.mjs` 与 `pnpm check:docs` 通过。仅修改图表和知识文档，没有修改产品代码、运行数据或配置，不重复业务和付费模型测试。

已检查根及 docs AGENTS，没有新增开发规则，无需空改。保留其他未提交改动，未提交推送部署。

入口：[展开图](../../diagrams/agent-teams-tool-flow.svg)、[图源映射](../../diagrams/README.md)、[团队架构](../architecture/teams.md)。
