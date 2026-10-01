# 权限与隔离机制图

日期：2026-09-22。

## 目的与范围

重画工具权限讲解图，用浅色三栏区分资源/命令判断、用户审批、隔离执行。保留默认规则与自定义参数前缀示例、拒绝优先、命令仅本次批准、派发前复核和沙箱失败拒绝执行等关键边界。

交付 [PNG](../../diagrams/tool-permissions.png)、[SVG](../../diagrams/tool-permissions.svg)、[Draw.io](../../diagrams/tool-permissions.drawio) 与 [生成器](../../scripts/build_tool_permissions.py)。生成器使用同一布局分别生成三种格式，只覆盖上述产物；需要 Pillow 和中文字体，支持 `--font` 指定字体。

本次没有应用代码、模块职责、依赖或协议变化，没有新增 ADR。已有未提交改动保留，未提交、推送或部署。

## 验证

- 生成器成功执行；PNG 为 2880 × 2220，文字由字体实测检查，无超出指定宽度。
- SVG 和 Draw.io XML 可解析；ai-drawio 校验通过，85 个用户元素，无错误或警告。
- `pnpm check:docs` 与 `git diff --check` 通过。
- 已打开 PNG 检查布局、连线和中文显示。PNG 与 SVG 来自共享几何布局，不是 Draw.io 桌面导出；本机没有 Draw.io 桌面渲染器。
- 本轮为图表及文档变更，不重复运行模型、原生执行或浏览器产品验收。

## 接续入口

[工具执行架构](../architecture/tool-execution.md) 已嵌入预览并提供源文件；[当前状态](../STATUS.md) 同步入口。根目录、scripts、docs 的 AGENTS.md 已检查，本轮没有开发规则变化。
