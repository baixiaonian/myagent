# 项目知识地图

新上下文按下列顺序阅读，通常无需先遍历研究源码。

1. [当前状态](STATUS.md)：现在能做什么、哪些还没实现、下一步从哪里开始。
2. [产品目标](product/goals.md)：为谁解决什么问题，完整产品如何验收。
3. [架构概览](architecture/overview.md)：主要执行链、状态归属与不变量；[聊天实现链路图](architecture/chat-flow.md) 对照原设计和源码。
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
