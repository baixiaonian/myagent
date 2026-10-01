# 2026-09-30：右侧文档工作区与选段编辑

## 目的与范围

依据用户提供的 Codex 截图，将回答中的 `.md` / `.html` 交付路径接入右侧文档工作区：并排阅读、项目树、多文档标签、富文本工具栏、保存和选段对话。不改动现有模型循环或自动触发付费请求。

## 已实现

- 回答中的本地链接与内联文件路径可点击，文档/团队共用右侧空间；拖动或键盘调整宽度、展开、手机覆盖布局。
- 目录惰性展开、分页与刷新；多标签、每项目草稿，收起与切换不丢输入。编辑器按需载入。
- Markdown 富文本工具栏及源码/阅读切换；标题、列表、任务、表格、引用、链接、代码、撤销/重做；保留扩展语法的源码回退。
- HTML 静态页面预览、源码高亮编辑和原文偏移选段替换；选段加粗/斜体保留原布局及 head / script 源文。预览不执行原文脚本。
- 选段直接编辑、追加至对话草稿或填写 Agent 修改要求。引用包含路径、版本、原文与未保存标记；发送仍由用户决定。
- 读取限制、路径身份/符号链接检查、共享执行锁、未知结果隔离、原子保存和冲突比较。

## 模块与规则

新增 contracts/documents、state/documents、application/documents、adapters/execution/documents、server/routes/documents 和 Web features/documents，SDK 增加三个方法，无内部依赖边变化。SQLite v13、SSE 不变。依赖固定版本、MIT，详见[协议](../protocols/documents-v1.md)。

已检查根、apps/web、apps/server、packages/application、packages/state、packages/adapters、tests、docs 的 AGENTS.md；补充 Web 文档操作约束。其余开发规则未变化。

## 验证

- `pnpm verify`：388 项通过、16 项平台/真实服务项目跳过；格式、模块边界、文档、TypeScript、构建和客户端产物检查均通过。证据：`.cache/document-verify-final.log`。
- 完整 Chromium 产品回归：42 项通过，含 4 条新增文档流程；覆盖富文本连续选择/格式/替换、真实磁盘保存、外部文件刷新、标签草稿、选段对话、双版本冲突、HTML 源文保留/脚本与网络阻断、扩展 Markdown 保留和手机布局。证据：`.cache/document-e2e-final.log`、`.cache/acceptance/document-*.png`。
- 实际浏览器手动操作临时项目：正文选择、加粗、替换和保存通过；真实 `article.md` 在原会话中只读打开，右栏目录/工具栏正常、未标记未保存、控制台无错误。截图：`.cache/document-review/desktop.png`、`.cache/document-review/real-article.png`。
- 本地 3000 已加载最终构建，health 与首页静态资源 200；重启前无活动 Run/保留进程，前后 10 个会话 ID 和设置哈希一致，未使用原配置发起模型请求。证据：`.cache/document-review/production-before.json` / `production-after.json`。
- 本轮修复了目录 query 参数类型不匹配、富文本首次聚焦补空段落、连续格式操作时临时空选区使操作条消失、nonce 序列化及预览解析阶段潜在资源预加载。最终回归覆盖实际问题，未以延长等待掩盖它们。
- 仍有既有及新样式选择器的非阻断 lint 警告和大 chunk 提示；重编辑器已单独按需加载，不阻塞聊天首屏。

## 已知边界与接续

HTML 为静态预览，外部资源、脚本和嵌入页面不运行；跨 HTML 文本节点的选区通过对话或源码修改。富文本编辑可规范化 Markdown 排版，扩展语法优先保留原文。草稿是页面内存，刷新/关闭前提示保存；没有磁盘级历史恢复。文件最大 1 MiB，目录不跟随链接。外部进程不遵守内部锁，不能宣称无宿主竞态。

接续入口：[文档协议](../protocols/documents-v1.md)、[ADR](../adr/0021-document-workbench.md)、`tests/e2e/documents.spec.ts`。
