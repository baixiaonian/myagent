# 内容服务

继承 [根 AGENTS.md](../../AGENTS.md)，本文件补充当前目录规则。

Memory、Source、Artifact 分别管理长期事实、原始材料与交付物；来源、作用域、版本和删除语义必须清晰。检索索引可重建；正文与 blob 引用不能静默丢失。文件或数据库驱动放 adapters，通过 ports 访问。

每轮同步 [当前状态](../../docs/STATUS.md)、相关知识页和 [迭代记录](../../docs/history/README.md)。

上下文管理遵循 [根约束](../../AGENTS.md)：只在完整工具批次后准备上下文；摘要是有来源的派生资料，不改历史、不赋予权限。根规则在 Run 开始冻结，私有续接不进入摘要/公开历史。整理失败不自动重试，明确恢复不重放工具；长期记忆由 MemoryService 提供有界概览、检索与两阶段后台整理；启用/删除/人工保护遵循 memory-v7 协议。

content 只放纯选择、校验和读取协议；模型整理与发布在 application，Markdown/SQLite 驱动在 adapters。不能引入第二套会话事实源。
