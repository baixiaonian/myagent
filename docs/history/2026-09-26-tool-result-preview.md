# 工具大结果保留原文头尾

日期：2026-09-26；需求负责人：白鑫磊。

## 目的与范围

将普通工具的仅头部预览和命令的仅尾部预览调整为首尾保留，在中间说明截断及补读引用；上下文缩减不能对旧预览再次截取。保留已有工作区改动，本轮不提交、推送或部署。

## 实现与协议

- kernel/tools/preview 提供共用纯函数，头尾平分正文额度，按最终序列化长度计入 JSON 转义/标记/引用，保护 Unicode 代理对。固定执行状态、错误、进程退出码在正文外保存，仍计入总预算。
- ToolService 和 FileResultStore 共用首尾投影；ResultStorePort.preview 只接受受会话约束的结果 ID。重新投影遵守同一 MCP 附件边界，不把图片/音频/blob 发给文字模型。
- ContextService 从原文件重建 8000 或更小预览；没有文件引用的旧消息使用本次准备开始前的原文。停止后拒绝迟到提交；预算连固定事实和引用都放不下时进入 waiting_context，已执行动作不重放。
- Worker 命令快照从采集文件读取首尾，内部预览上限 6000，状态/退出码独立返回；新增 outputTruncated，不混淆 outputComplete。read_process 按游标原样分页。
- 原始结果保存与 read_tool_result 分页不变；没有数据库迁移、SSE 版本变化或新依赖边。唯一 Agent Loop 不新增工具分支。

## 验证

- `pnpm verify`：206 项通过，7 项原生测试在默认工程任务中跳过，已在独立原生命令中执行；格式、类型、依赖边界、文档、构建及客户端凭证边界检查通过。日志 `.cache/tool-preview-verify.log`。
- 新增结果预览专项 10 项通过：头尾/转义/emoji/严格预算、原文补读、跨会话拒绝、旧头部预览重建、MCP 附件隐藏、取消迟到结果、极小预算保留执行成功事实，以及两种协议真实 loopback HTTP 请求。日志 `.cache/tool-preview-focused.log`。
- `pnpm test:execution:native`：macOS 原生与本地 MCP 11 项通过；新增长命令输出及非零退出码回归，并分页还原全部采集日志。日志 `.cache/tool-preview-native.log`。
- `pnpm test:e2e`：18 条浏览器产品流程通过，包括聊天、上下文、MCP 大结果分页和审批。日志 `.cache/tool-preview-e2e.log`。
- 以上 HTTP 测试使用本地协议替身，本轮没有调用真实付费模型，也未新增 Docker 验收。保留已有两条前端 lint 提示和构建体积提示，均不阻塞检查；未修改无关 UI。

## 边界与接续

结果采集仍受单条 20 MiB、单 Run 100 MiB 限制；首尾预览不能保证覆盖所有中间关键信息，补读仍需模型发起。结果内全文搜索未实现。极小工具字符预算需要改服务端配置后创建新 Run；增大模型窗口不会覆盖运行中的独立工具预算。

根 AGENTS 及 application/adapters 约束已更新；kernel、apps/server、tests 的局部约束已检查，沿用现有边界无需空改。维护与协议同步至 tools、execution-v3、context-v6；实现入口为 kernel/tools/preview.ts、adapters/execution/results.ts 和 application/context-service.ts。
