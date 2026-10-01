# 2026-09-29：按 Agent / Step 整理 Trace 与单页节点详情

## 目的与范围

将内部函数清单改为任务推进视图：任务 → 主/成员 Agent → Step → 上下文、模型和工具批次。节点详情参考用户截图，所有分区连续阅读，模型输入输出自动展开首屏并可复制原文。

## 实现

- Kernel 仅增加内部 step.preparing 生命周期和 ContextInput 的中立关联。观测 Step 在准备前开始；业务 Step / 决策数不因摘要或准备失败而伪增。
- ContextService 清单保存来源元数据，比较上次版本记录新增、修改和移出；准备、摘要和模型请求通过显式身份关联。旧来源清单不回填，私有续接不进入事件。
- Trace 展示投影保留原 Span，增加 Agent / 工具批次分组；主成员并行执行、spawn/send 的关联入口、同任务恢复段在同页归组。正常检查隐藏，异常和明显等待仍展示，全部记录可在内部诊断中查看。
- 新增只读 evidence API，按 Trace + Span 校验，从已有 Step/工具/消息事实读取详情，不返回续接；不新增数据库版本或聊天 SSE。
- 右侧连续显示业务数据、模型材料、属性、事件、身份、Link。复制材料补读全部已保存页面，采集缺损不会被“复制完整”掩盖；切换节点拒绝迟到覆盖。
- 现有未提交代码保留，未提交/推送/部署；没有为了观测发起新的真实模型请求。

## 验证

- 专项回归：观测/上下文/Loop/团队 127 项通过；增加来源差异、事件归属及 evidence 边界后，观测/上下文集成定向 33 项通过。
- 浏览器定向 8 项通过：成员跳转、Step 聚合、同页事件、原文完整复制、恢复段、分页、窄屏、刷新及迟到响应。
- `pnpm verify`：384 项通过、16 项按配置跳过，格式/依赖边界/文档/类型/生产构建/客户端边界通过；完整 `pnpm test:e2e`：35 项通过。
- `pnpm test:execution:native`：22 项通过，验证本机真实 OS 隔离及进程，不是模型能力验收。最终展示调整后又完成 8 项定向浏览器回归和 6 项展示模型测试。
- 桌面及 390×844 窄屏、用户截图与实现同屏对照，证据 `.cache/acceptance/trace-{model-sections,context-sections,inspector-mobile,step-live}.png`，详见根目录 `design-qa.md`。
- 使用本机已保存任务只读核对页面；8 个会话、模型配置保持，已发送模型请求仍为 494。本轮没有新增真实模型请求，也未修改调试开关。
- 验证日志：`/tmp/myagent-trace-verify-final.log`、`/tmp/myagent-trace-all-e2e.log`、`/tmp/myagent-trace-native.log`；定向补测 `/tmp/myagent-trace-e2e-last.log`、`/tmp/myagent-trace-projection-final.log`。临时日志和截图不进入源码交付。

## 边界与接续

旧上下文没有 Step 身份时不能按时间猜测归属，多个此类记录收进默认折叠的“旧上下文准备（未关联 Step）”组；旧请求没有开启调试时不能补录原文。分组的近似区间跨度不是实际活动时间，也不累加并行节点费用。来源事件每类最多 200 项并标明 omitted，完整来源仍保存在上下文清单。

已检查并更新根、Web、Application、Kernel、State AGENTS；依赖边界未变化。入口：`TracePage`、`trace-presentation`、`TraceInspector`、`context-observation` 和观测协议。
