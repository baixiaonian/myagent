/**
 * 独立受控执行入口：只接收父进程 IPC，把文件和命令放入原生沙箱并返回执行回执。
 * 本进程不运行模型、不持有模型凭证、不直接修改聊天数据库。
 */
import { runExecutionWorker } from "@myagent/adapters";

if (!process.send) throw new Error("Worker 必须由 MyAgent Server 装配启动。");
runExecutionWorker();
