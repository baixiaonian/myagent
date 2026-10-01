/**
 * MCP 沙箱 stdio Transport：复用官方 SDK 的分帧器，在原生沙箱中启动服务进程。
 * stderr 只保留有界诊断且不输出日志；关闭传输必须终止进程组，不只关闭管道。
 */
import { type ChildProcess, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import {
  ReadBuffer,
  serializeMessage,
} from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { AppError } from "@myagent/contracts";
import { terminateProcessGroup } from "../execution/process-groups.js";

function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
export class SandboxStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;
  private child: ChildProcess | null = null;
  private exited: Promise<void> = Promise.resolve();
  private readonly buffer = new ReadBuffer({ maxBufferSize: 25 * 1024 * 1024 });
  confirmed = false;
  private didExit = false;
  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly cwd: string,
    private readonly environment: Record<string, string>,
    private readonly executionMode?: import("@myagent/contracts").ExecutionMode,
  ) {}
  async start(): Promise<void> {
    if (this.child) throw new AppError("mcp_started", "MCP stdio 已经启动。");
    // stdio 使用 Worker 固定模式，工具 args 无权选择此分支。
    const wrapped =
      this.executionMode === "full_access"
        ? { argv: [this.command, ...this.args], env: {} }
        : await SandboxManager.wrapWithSandboxArgv(
            [this.command, ...this.args].map(quote).join(" "),
            "/bin/sh",
            undefined,
            undefined,
            this.cwd,
            { commandText: "mcp_stdio" },
          );
    const child = spawn(wrapped.argv[0] ?? "", wrapped.argv.slice(1), {
      cwd: this.cwd,
      env: { ...this.environment, ...wrapped.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    this.child = child;
    this.exited = new Promise<void>((resolve) =>
      child.once("close", () => {
        this.didExit = true;
        this.onclose?.();
        resolve();
      }),
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      try {
        this.buffer.append(chunk);
        let message = this.buffer.readMessage();
        while (message) {
          this.onmessage?.(message);
          message = this.buffer.readMessage();
        }
      } catch {
        this.onerror?.(new Error("MCP stdio 返回无效或过大的协议消息"));
        void this.close();
      }
    });
    child.stderr?.resume();
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", () => {
        this.onerror?.(new Error("MCP stdio 启动失败"));
        reject(new AppError("mcp_start", "无法启动 MCP 程序。"));
      });
    });
  }
  async send(message: JSONRPCMessage): Promise<void> {
    const input = this.child?.stdin;
    if (!input || input.destroyed)
      throw new AppError("mcp_disconnected", "MCP stdio 已断开。");
    await new Promise<void>((resolve, reject) =>
      input.write(serializeMessage(message), (error) =>
        error
          ? reject(new AppError("mcp_disconnected", "MCP stdio 写入失败。"))
          : resolve(),
      ),
    );
  }
  async close(): Promise<void> {
    const pid = this.child?.pid;
    if (!pid) return;
    this.child?.stdin?.end();
    const groupStopped = await terminateProcessGroup(pid);
    await Promise.race([this.exited, delay(2000)]);
    this.confirmed = groupStopped && this.didExit;
    if (!this.confirmed)
      throw new AppError("mcp_cleanup_unknown", "无法确认 MCP 进程已终止。");
  }
}
