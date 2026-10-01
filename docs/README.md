# 项目知识地图

- [创作评测在线报告](https://myagent-dsh-creative-evaluation.witbaixinlei.chatgpt.site)：8题描述、评分标准、双端消耗对比与16份作品；[发布与验证记录](history/2026-10-01-creative-evaluation-online-report.md)。

- [创作评测 v1：8题任务包](../evals/creative-v1/README.md)：5份Markdown与3份HTML任务、冻结输入、逐题评分和离线核验工具；MyAgent与dsh已各交付8份，见[完整交付与补测条件](history/2026-10-01-creative-comparison-completion.md)，首次失败记录保留。

- [长任务运行原则](adr/0018-long-running-tasks.md)：取消累计字符配额与任务总时限，保留上下文管理与单次调用超时。

- [执行权限：标准权限与完全访问](protocols/execution-mode-v13.md)：输入区选择，按任务冻结，成员继承。

- [可观测性 v1](architecture/observability.md) · [v12 协议](protocols/observability-v12.md) · [使用维护](development/observability.md)

- [轻量团队 v1](architecture/teams.md) · [工具与启动展开图](../diagrams/agent-teams-tool-flow.svg) · [整体关系](../diagrams/agent-teams.svg) · [v11 协议](protocols/teams-v11.md) · [使用维护](development/teams.md)

- [多 Agent 七种协作原理图](../diagrams/multi-agent-patterns/index.html)：上游机制研究与对比，不是已实现能力；[资产与图源](../diagrams/README.md)。

- [插件 v1](architecture/plugins.md) · [原理图](../diagrams/plugins.png) · [v10 协议](protocols/plugins-v10.md) · [使用维护](development/plugins.md)

- [Hook v1](architecture/hooks.md) · [v9 协议](protocols/hooks-v9.md) · [使用维护](development/hooks.md)

- [Skill v1](architecture/skills.md) · [原理图](../diagrams/skills.svg) · [v8 协议](protocols/skills-v8.md) · [使用维护](development/skills.md)

- [长期记忆](architecture/memory.md) · [原理图](../diagrams/long-term-memory.svg) · [v7 协议](protocols/memory-v7.md) · [使用维护](development/memory.md)

新上下文按下列顺序阅读，通常无需先遍历研究源码。

1. [当前状态](STATUS.md)：现在能做什么、哪些还没实现、下一步从哪里开始。
2. [产品目标](product/goals.md)：为谁解决什么问题，完整产品如何验收。
3. [项目与 MCP](architecture/projects-mcp.md)、[工具执行系统](architecture/tool-execution.md)、[自主 Agent Loop](architecture/agent-loop.md)、[架构概览](architecture/overview.md)：主要执行链、状态归属与不变量；[聊天实现链路图](architecture/chat-flow.md) 对照原设计和源码。
4. [模块关系](architecture/modules.md)：目录、依赖、扩展边界。
5. [迭代历史](history/README.md)：最近改动、验证结果、遗留事项。
6. 开发时读取 [环境与命令](development/setup.md)、[迭代工作流](development/workflow.md)、[中文注释规范](development/comments.md)、[提交规范](development/commits.md)、[验证策略](development/testing.md)。

其他入口：[架构决策](adr/README.md)、[协议目录](protocols/README.md)、[技术选型](architecture/technology.md)、[研究依据](architecture/references.md)、[待开发路线](roadmap.md)。

## 知识如何分工

- AGENTS.md：开发行为、约束、定位入口；局部文件补充本模块规则。
- STATUS.md：当前工程事实，随迭代覆盖更新。
- architecture/、product/、protocols/：有效设计，随实现修订。
- adr/：重大决策的原因和替代方案，旧决策由新 ADR 标注取代。
- history/：按日期追加的变化与证据，不修改历史来伪装当前能力。
- 原始 HTML 和源码清单：设计研究快照，不等于已实现产品。

具体同步规则见 [根 AGENTS.md](../AGENTS.md) 和 [文档维护约定](AGENTS.md)。

新增执行治理入口：[命令权限与迁移](protocols/commands-v5.md)、[命令设置使用](development/commands.md)。

上下文入口：[原理图](../diagrams/context-management.svg)、[架构](architecture/context-management.md)、[v6 协议](protocols/context-v6.md)、[使用维护](development/context.md)。

请求缓存入口：[稳定前缀与追加状态](adr/0019-cache-stable-context.md)、[命中率查看与离线复验](development/observability.md)、[修复证据](history/2026-09-29-cache-prefix.md)。
