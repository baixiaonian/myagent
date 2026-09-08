# 工作区包

继承 [根 AGENTS.md](../AGENTS.md)，本文件补充当前目录规则。

公共入口为 src/index.ts。包间只用 @myagent/<name>，禁止深路径和跨包相对导入；内部子目录保持包内私有。依赖以 config/modules.json 为边界，新增边前更新设计依据。空模块不应伪装成已可调用的实现。

每轮同步 [当前状态](../docs/STATUS.md)、相关知识页和 [迭代记录](../docs/history/README.md)。
