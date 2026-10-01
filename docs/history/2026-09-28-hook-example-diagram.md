# Hook 报告路径检查示例图

## 目的与范围

用一张图片解释上轮配置示例：`write_file` 写报告前触发 `PreToolUse`，不符合 `reports/` 路径约定时拒绝并反馈模型，模型可调整后重新调用。图中包括配置确认、Run 快照与 JSON 标准流通信。

本轮仅新增图表、生成器和知识入口，没有安装 Hook、执行示例脚本、修改用户配置或产品行为，没有提交推送。

## 交付与模块关系

- `diagrams/hooks-report-example.png`：2960 × 2300 图片。
- 同名 SVG、Draw.io：矢量预览及 66 个可编辑图形元素。
- `diagrams/gen-hooks-report-example.py`：Pillow 测量文字，统一坐标生成三个格式；绘图依赖不进入产品运行链路。
- `diagrams/README.md`：记录 HookService、ToolService、Worker、公开协议和路由的源码对应。

核对现有 Hook 架构、协议、公开 DTO、参数投影及路由。模块边界、数据库和事件版本均不变。根 AGENTS 与 docs/AGENTS 已检查，本次未产生新开发规则，不空改规范。

## 验证

- 生成器执行成功，全部文字通过真实字体测宽；SVG 和 Draw.io 经过 XML 解析。
- Draw.io 技能检查：66 个用户元素，零错误、零警告。
- 查看 PNG，核对两次调用、拒绝反馈方向、文字可读性和无重叠。
- 执行 `pnpm check:docs` 核验文档入口。本轮无产品代码改动，不重复模型、端到端或 Docker 验收。

## 边界与接续

此图不是实测轨迹，不承诺模型被拒后必定自行修正。Hook 不改写参数，`continue` 不等于执行授权；本例仅检查 `write_file`，资源安全仍由已有权限与 OS 沙箱执行。

后续修改以生成器为源，重建图片、矢量图和编辑图后自审。关键事件、配置权限、故障与恢复见 [Hook 协议](../protocols/hooks-v9.md)；真实实现验收仍以 [Hook v1 迭代](2026-09-28-hooks.md) 为准。
