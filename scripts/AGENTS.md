# 工程与报告工具

继承 [根 AGENTS.md](../AGENTS.md)，本文件补充当前目录规则。

check-architecture.mjs / check-docs.mjs 是当前工程检查工具，改动需要相应回归验证。既有 Python build_report / build_diagram / report_details 是历史设计生成器；与应用构建分离，不让普通 pnpm verify 依赖研究快照。

脚本必须有中文文件职责和关键步骤注释，特别说明读写范围、生成产物、费用、进程 / 文件清理边界。为生成器补注释时不改字符串内的报告内容；纯注释维护不自动重建历史报告。详见 [中文注释规范](../docs/development/comments.md)。

每轮同步 [当前状态](../docs/STATUS.md)、相关知识页和 [迭代记录](../docs/history/README.md)。

真实模型与 Docker 验收由 test-live.mjs、test-agent-live.mjs / test-docker.mjs 提供。真实模型命令必须有本轮用户授权，不能被 verify 隐式触发；Docker 故障注入只作用于脚本创建的唯一 project 和测试卷。test-live 读取配置走脱敏 API；双协议 test-agent-live 可以只读原数据库配置，并经既有 FileCredentialStore 在内存取得凭证，注入独立临时实例，不能迁移原库、修改原配置或持久化真实密钥。所有脚本均不得将密钥放进启动参数、stdout 或报告。

test-execution-live 仅经既有凭证服务在内存读取已授权模型，独立临时工作区验收自然语言文件/命令任务，禁止写入原配置或打印凭证。

test-projects-live 在授权后用已有配置验证默认/指定目录任务；只读原配置，清理独立测试目录。Docker 数据卷和工作区卷分别跟踪与清理。

上下文管理遵循 [根约束](../AGENTS.md)：只在完整工具批次后准备上下文；摘要是有来源的派生资料，不改历史、不赋予权限。根规则在 Run 开始冻结，私有续接不进入摘要/公开历史。整理失败不自动重试，明确恢复不重放工具；长期记忆由 MemoryService 提供有界概览、检索与两阶段后台整理；启用/删除/人工保护遵循 memory-v7 协议。

Skill v1 遵循 [技能协议](../docs/protocols/skills-v8.md)：完整主说明按 Run 独立注入且不被工具预览/摘要截断；激活和成功回执同事务；脚本仍经命令与沙箱。来源/启停下轮生效，当前只读包恢复不重放。数据库当前 v10；技能编辑器未实现；本地/公开 Git 插件生命周期已接通；Hook v1 已接通。

## Hook v1 约束

固定四事件在应用层接入，Kernel Loop 不增加 Hook 分支。配置确认绑定包与资源，默认项目只读，Worker 缓存身份包含完整权限；不继承模型工具授权。批次命中 Hook 时按模型顺序串行，未知副作用复用隔离核对，不重放。RunEnd 使用 cleaning 待提交结果；停止/删除/关闭不新启结束脚本。数据库 v10、Hook SSE v5；配置文件与包快照必须先落盘再引用，脚本日志不自动成为上下文。

## 插件 v1 约束

插件通过既有 Skill/MCP/Hook 提供者接入，不能新增执行循环或主进程模块加载。包内容先完整发布再事务登记；确认绑定哈希、作用域及配置。三类组件共用 Run 冻结版本，MCP 连接/目录/缓存也校验版本与项目。更新禁用卸载只影响新 Run；资源/凭证撤销仍立即约束派发。保留旧引用及未知结果后再回收，不修改手工配置，不删除源目录。SQLite v10；协议与维护见 docs/protocols/plugins-v10.md、docs/development/plugins.md（相对仓库根）。
