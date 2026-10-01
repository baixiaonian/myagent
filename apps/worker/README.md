# worker

状态：受控工具执行 v1。Server 通过 IPC 创建独立监督器，原生沙箱执行文件和命令。

- `src/main.ts`：Worker 启动，仅接受父进程 IPC。
- `src/action.ts`：沙箱内文件动作，从 stdin 读取已校验请求并输出结构化回执。
- 允许依赖 contracts / adapters；不能启动另一个 Agent Loop。
- 使用条件与保证见 [工具执行系统](../../docs/architecture/tool-execution.md)。
