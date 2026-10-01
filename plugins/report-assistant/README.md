# 报告助手示例插件

此目录不是自动启用的内置插件。在 Web「插件」中选择本目录，预览 Skill、本地 sales MCP、PreToolUse 路径检查后确认安装。

`plugin.json` 声明包与 MyAgent Hook；`mcp.json` 声明无依赖、无网络的离线样例服务；`hooks/myagent.json` 为现有 Hook 协议。严格 JSON 不加注释，字段用途在本说明与插件协议记录。

可以测试：“请分析样例销售数据，写一份中文报告，保存到项目并读取核验。”模型可以自主加载技能和搜索工具，写入必须放在 reports/；报告数据仅为演示。Hook 只匹配 write_file，不是所有写文件方式的安全边界，执行仍依赖原权限与沙箱。
