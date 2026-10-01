/**
 * 完整工具结果文件库：数据目录之外只暴露随机引用，模型/Web 通过分页端口读取。
 * 完整捕获额度与模型文本预算分离；写入失败不返回成功引用，删除仅清理本会话记录指向的文件。
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  AppError,
  EXECUTION_LIMITS,
  type JsonValue,
  type ResultPage,
  type ResultRef,
} from "@myagent/contracts";
import {
  createToolPreview,
  type ExecutionContext,
  previewSavedResult,
  type ResultStorePort,
} from "@myagent/kernel";
import type { ExecutionStore } from "@myagent/state";

export class FileResultStore implements ResultStorePort {
  /** 小型控制结果正文可来自同库事务；回调仍必须执行会话归属校验。 */
  inlineResult?: (id: string, sessionId: string) => JsonValue | null;
  readonly root: string;
  private readonly reservations = new Map<string, number>();
  constructor(
    dataDir: string,
    private readonly store: ExecutionStore,
  ) {
    this.root = join(dataDir, "results");
  }
  private path(id: string): string {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id))
      throw new AppError("invalid_result", "结果引用无效。");
    return join(this.root, `${id}.txt`);
  }
  async save(context: ExecutionContext, value: JsonValue, complete = true) {
    const text = JSON.stringify(value);
    return this.saveText(context, text, "application/json", complete);
  }
  private async saveText(
    context: ExecutionContext,
    text: string,
    mimeType: string,
    complete: boolean,
  ) {
    const bytes = Buffer.byteLength(text);
    const total = this.store
      .list("results", { runId: context.runId })
      .reduce((sum, item) => sum + item.bytes, 0);
    if (
      bytes > EXECUTION_LIMITS.resultBytes ||
      total + bytes + (this.reservations.get(context.runId) ?? 0) >
        EXECUTION_LIMITS.runResultBytes
    )
      throw new AppError("result_limit", "完整工具结果超过存储额度。", 422);
    this.reservations.set(
      context.runId,
      (this.reservations.get(context.runId) ?? 0) + bytes,
    );
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const id = randomUUID();
      const path = this.path(id);
      const handle = await open(`${path}.tmp`, "wx", 0o600);
      try {
        try {
          await handle.writeFile(text);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(`${path}.tmp`, path);
        const directory = await open(this.root, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } catch (error) {
        await rm(`${path}.tmp`, { force: true });
        await rm(path, { force: true });
        throw error;
      }
      const reference: ResultRef = {
        id,
        sessionId: context.sessionId,
        runId: context.runId,
        invocationId: context.invocationId,
        bytes,
        sha256: createHash("sha256").update(text).digest("hex"),
        mimeType,
        captureComplete: complete,
        omittedBytes: complete ? 0 : null,
        captureReason: complete ? "complete" : "capture_incomplete",
        createdAt: new Date().toISOString(),
      };
      try {
        this.store.put("results", reference);
      } catch (error) {
        await rm(path, { force: true });
        throw error;
      }
      // 持久化正文不改写；预览与应用层共用首尾策略及安全附件投影。
      let preview: { content: string; truncated: boolean };
      try {
        preview =
          mimeType === "application/json"
            ? previewSavedResult(
                JSON.parse(text) as JsonValue,
                EXECUTION_LIMITS.resultCharacters,
                id,
              )
            : createToolPreview(text, EXECUTION_LIMITS.resultCharacters, {
                reference: `read_tool_result resultId=${id}`,
              });
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== "context_limit")
          throw error;
        // 预览容量不足不是持久化失败：保留可靠原文，下一次上下文准备显式暂停。
        preview = { content: "", truncated: true };
      }
      return {
        reference,
        preview: preview.content,
        truncated: preview.truncated,
      };
    } finally {
      this.reservations.set(
        context.runId,
        (this.reservations.get(context.runId) ?? 0) - bytes,
      );
    }
  }
  async preview(resultId: string, sessionId: string, maximum: number) {
    const inline = this.inlineResult?.(resultId, sessionId);
    if (inline !== null && inline !== undefined)
      return createToolPreview(JSON.stringify(inline), maximum, {
        reference: `read_tool_result resultId=${resultId}`,
      });
    const record = this.store.get("results", resultId);
    if (!record || record.sessionId !== sessionId)
      throw new AppError("not_found", "结果不存在或不属于当前会话。", 404);
    const text = await readFile(this.path(resultId), "utf8").catch(() => {
      throw new AppError("result_missing", "结果文件已丢失。", 404);
    });
    // 只读已经保存的有界原文；不能把之前的短预览再当成完整结果，也不能公开 MCP 二进制。
    return record.mimeType === "application/json"
      ? previewSavedResult(JSON.parse(text) as JsonValue, maximum, resultId)
      : createToolPreview(text, maximum, {
          reference: `read_tool_result resultId=${resultId}`,
        });
  }
  async read(
    resultId: string,
    sessionId: string,
    cursor?: string,
    limit = 8000,
  ): Promise<ResultPage> {
    const inline = this.inlineResult?.(resultId, sessionId);
    if (inline !== null && inline !== undefined) {
      const text = JSON.stringify(inline),
        offset = Number(cursor ?? 0);
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > text.length ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 8000
      )
        throw new AppError("invalid_cursor", "结果游标无效。");
      const end = Math.min(text.length, offset + limit);
      return {
        resultId,
        text: text.slice(offset, end),
        cursor: end < text.length ? String(end) : null,
        totalBytes: Buffer.byteLength(text),
        captureComplete: true,
      };
    }
    const record = this.store.get("results", resultId);
    if (!record || record.sessionId !== sessionId)
      throw new AppError("not_found", "结果不存在或不属于当前会话。", 404);
    const offset = cursor === undefined ? 0 : Number(cursor);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 8000
    )
      throw new AppError("invalid_cursor", "结果分页参数无效。");
    // 单文件额度已受限；字符游标不会切断 UTF-8 字节序列，并避免把文件路径作为客户端输入。
    const data = await readFile(this.path(resultId), "utf8").catch(() => {
      throw new AppError("result_missing", "结果文件已丢失。", 404);
    });
    if (offset > data.length)
      throw new AppError("invalid_cursor", "结果游标超出范围。");
    let end = Math.min(offset + limit, data.length);
    const last = data.charCodeAt(end - 1);
    if (end < data.length && last >= 0xd800 && last <= 0xdbff)
      end = end === offset + 1 ? end + 1 : end - 1;
    return {
      resultId,
      text: data.slice(offset, end),
      cursor: end < data.length ? String(end) : null,
      totalBytes: record.bytes,
      captureComplete: record.captureComplete,
      omittedBytes: record.omittedBytes ?? (record.captureComplete ? 0 : null),
      captureReason:
        record.captureReason ??
        (record.captureComplete ? "complete" : "capture_incomplete"),
    };
  }
  /** Worker 输出在受保护目录写完后导入；调用者只能传自身创建的输出文件。 */
  async importOutput(
    context: ExecutionContext,
    path: string,
    complete: boolean,
  ): Promise<ResultRef> {
    const info = await stat(path);
    if (info.size > EXECUTION_LIMITS.resultBytes)
      throw new AppError("result_limit", "进程输出超过捕获额度。", 422);
    const value = await readFile(path, "utf8");
    return (await this.saveText(context, value, "text/plain", complete))
      .reference;
  }
  async deleteSession(sessionId: string): Promise<void> {
    for (const record of this.store.list("results", { sessionId }))
      await rm(this.path(record.id), { force: true });
  }
}
