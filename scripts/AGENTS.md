# 工程与报告工具

继承 [根 AGENTS.md](../AGENTS.md)，本文件补充当前目录规则。

check-architecture.mjs / check-docs.mjs 是当前工程检查工具，改动需要相应回归验证。既有 Python build_report / build_diagram / report_details 是历史设计生成器；与应用构建分离，不让普通 pnpm verify 依赖研究快照。

每轮同步 [当前状态](../docs/STATUS.md)、相关知识页和 [迭代记录](../docs/history/README.md)。
