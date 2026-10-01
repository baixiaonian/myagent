# 2026-09-29：在协作图中明确三种消息类型

用户确认保留 request / inform / result。通信展开图新增三张对照卡，展示来源、用途、示例、空闲时是否启动新 Run，以及系统回执的接收方。额外区分空闲成员与 waiting_agents，避免把“不启动新 Run”误解成“不能让等待中的 Run 继续”。

当前图共 136 个可编辑元素；SVG、Excalidraw、自审 PNG 与图源一致更新。协议补充同样的三类语义，未改变当前通信实现、配置或用户数据。result 仍由后端真实生命周期生成，send_message 仅接受 request / inform。

验证：核对 TeamService.send/finish/boundary 和消息类型契约，生成成功，PNG 布局自审通过；`node --check diagrams/gen-agent-teams-tool-flow.mjs`、`pnpm check:docs` 通过。仅图表/说明更新，不重复业务或付费模型验收。根及文档 AGENTS 已检查，没有新增开发规则；保留其他未提交改动，未提交推送部署。

入口：[实现图](../../diagrams/agent-teams-tool-flow.svg)、[图源映射](../../diagrams/README.md)、[协议](../protocols/teams-v11.md)。
