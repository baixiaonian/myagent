# 2026-09-28：轻量团队实现图

## 目的与交付

用一张图解释当前主 Agent 创建成员、成员直接通信、独立循环状态和统一交付。输出 SVG、132 元素的可编辑 Excalidraw、生成脚本及布局自审 PNG。图源不读取用户运行数据或凭证。

蓝色表示 spawn_agent 的登记/提交/启动，紫色表示 send_message 的保存/安全边界/回复，橙色表示 waiting_agents 与最终交付；底部压缩呈现现有权限、共享预算及恢复。成员角色是示例，未引入强制分工、额外模型或新循环。

## 验证与范围

阅读并核对 TeamService、ChatService、工具定义、RunCommandPort 与运行边界；生成成功，无渲染缺件，使用 PNG 完成三轮布局核对与箭头/文字调整。`node --check diagrams/gen-agent-teams.mjs` 和 `pnpm check:docs` 通过。仅图表与知识入口更新，无产品源码、运行配置或数据库变更，因此没有重复模型或业务测试。

根 AGENTS、文档规则已检查，本轮没有新增开发规则，无需空改 AGENTS。保留其他未提交改动，没有提交、推送或部署。

入口：[实现图](../../diagrams/agent-teams.svg)、[源码映射](../../diagrams/README.md)、[架构](../architecture/teams.md)。
