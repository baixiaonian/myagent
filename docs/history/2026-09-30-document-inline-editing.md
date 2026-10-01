# 2026-09-30：文档读写合一、选区浮层与自动保存

## 目的与范围

按用户补充的 Codex 截图修正文档工作区：取消编辑/阅读/源码切换，Markdown 直接读写并即时渲染；选区旁出现两个操作按钮；引用以输入框上方的片段芯片呈现；编辑自动保存。

## 实现与边界

- Markdown 保留格式工具栏、撤销/重做和 Markdown 输入规则；不支持的元数据、HTML、脚注等在画布内以原文片段保留。打开、阅读或选中不写回文件；编辑仍可能规范化 Markdown 排版。
- 选区浮层提供「添加到对话 / 编辑」，编辑表单在原位展开，重复选择相同范围可继续操作；滚动、外部点击、切页和 Escape 关闭。
- 文本片段按会话草稿单独保存，用「N 个已选文本片段」芯片展开查看和逐项删除；发送时才组合路径、项目、版本、原文与问题，沿用现有 content 协议及长度边界。未授权真实模型调用，本轮只用独立替身服务验证传输。
- 650ms 防抖自动保存、IME 保护、单文件串行 CAS；保存期间输入跟随新版本继续写入，切项目或收起面板仍完成队列。关闭标签刷新最后输入，失败保留标签。读取期间新输入不会被迟到响应覆盖。
- 保存失败停止自动重试，用户可重试；版本冲突保留双版本，显式选用磁盘或自己的内容。草稿仅在当前页面内存，刷新前有未保存提示，不承诺浏览器崩溃恢复。
- HTML 延续隔离静态页面与原文偏移修改；跨节点选段可以加入对话，局部替换限定可确定原文范围的单节点选段。

## 模块、协议和规则

变更仅在 Web 文档组件、对话片段状态及浏览器测试；新增 useDocumentSave、SelectionPopover、SelectedFragments、markdown-preservation，删除 SourceEditor 和未使用的 CodeMirror 依赖。内部依赖边、服务端文件协议、SQLite v13 与 SSE 均不变。

同步 STATUS、文档协议、ADR-0021、模块图说明和 Web README/AGENTS。已检查根及 Web、测试目录约定；根规则没有变化，不空改根 AGENTS.md。

## 验证

- `pnpm verify` 通过：工程测试 388 项通过、16 项原生/条件测试跳过，格式、架构、文档、类型、构建与发布包边界检查通过；报告 `.cache/document-v2-verify-final.log`。保留既有 lint 警告及大块构建提示，不作为已消除项。
- 完整 Playwright 产品验收 47 项通过，其中 9 项文档测试覆盖重复选区、就地替换、片段移除和发送、失败重试、串行保存、关闭标签、切项目、IME、即时标题渲染、版本冲突处理、迟到刷新与手机布局。报告 `.cache/document-v2-e2e-final.log`。
- 可视证据：`.cache/acceptance/document-v2-selection.png`、`document-v2-chip.png`、`document-mobile.png`、`document-conflict.png`；实际浏览器图见 `.cache/document-review/inline-editing-live.png`。
- 最终构建后重启本地 3000，健康检查和当前静态资源 200；启动前无 activeRun 或运行中的保留进程。10 个会话 ID、设置摘要哈希及真实 article.md 哈希前后一致；记录 `.cache/document-v2-production-before.json` / `document-v2-production-after.json`。没有运行真实模型请求。

## 接续入口

界面入口为右侧文档面板，保存队列位于 `apps/web/src/features/documents/use-document-save.ts`；协议见 [documents-v1](../protocols/documents-v1.md)，交互回归见 `tests/e2e/documents.spec.ts`。不支持任意 HTML 页面的完整富文本重排；图片外链、脚本执行和公网发布均未新增。
