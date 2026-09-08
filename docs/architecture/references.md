# 研究与设计依据

- [HTML 架构报告](../../agent-architecture.html)：2026-09-07 设计基线。
- [在线设计报告](https://knowbit.cn/p/BssJzfkhTv9QnYXmpe0qEh)：已托管的原设计快照，不随本地实现自动更新。
- [源码清单](../../research/source-manifest.json)：20 处文件、行号与提交固定链接。
- [源码审计](../../research/source-audit.json)、[托管记录](../../research/hosting.json)。
- [SVG](../../diagrams/agent-architecture.svg) / [Draw.io](../../diagrams/agent-architecture.drawio)。

参考项目：[Pi](https://github.com/earendil-works/pi)、[Codex](https://github.com/openai/codex)、[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。

借鉴 Pi 的循环与模型边界、Codex 的每步视图与工具执行治理、DeepSeek Harness 的扩展生命周期和恢复语义。完整取舍保留在原设计报告。研究只做静态阅读，没有运行上游测试套件。

`research/upstream/` 是当前机器的独立 Git 快照，忽略提交且不是子模块。普通构建不读取它。重建历史报告时按 source-manifest.json 中的 repo / sha 获取对应快照，再运行 scripts/build_diagram.py 和 scripts/build_report.py。历史研究文件不能代替当前实现状态文档。
