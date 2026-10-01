/** 原始调试文件库：有界队列异步写入，原始字节不改写；失败只影响采集完整性。 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { AppError, type CaptureRecord } from "@myagent/contracts";
import type { CaptureFilesPort, CaptureSink } from "@myagent/observability";
export class LocalCaptureFiles implements CaptureFilesPort {
  private readonly root: string;
  private reserved = 0;
  private readonly pending = new Map<string, Promise<void>>();
  private readonly deleted = new Set<string>();
  private readonly finishers = new Map<
    string,
    (reason?: string) => Promise<void>
  >();
  private closed = false;
  private unavailable = false;
  constructor(
    dataDir: string,
    readonly fileLimit = 20 * 1024 * 1024,
    readonly totalLimit = 1024 ** 3,
    readonly queueLimit = 20 * 1024 * 1024,
  ) {
    for (const limit of [fileLimit, totalLimit, queueLimit])
      if (!Number.isSafeInteger(limit) || limit < 1)
        throw new AppError("invalid_limits", "采集容量必须为正整数。");
    this.root = join(dataDir, "observability", "captures");
    try {
      mkdirSync(this.root, { recursive: true, mode: 0o700 });
      for (const name of readdirSync(this.root))
        if (/^[a-f0-9]{32}\.(raw|part)$/.test(name))
          this.reserved += statSync(join(this.root, name)).size;
    } catch {
      this.unavailable = true;
    }
  }
  private path(id: string, ext: string): string {
    if (!/^[a-f0-9]{32}$/.test(id))
      throw new AppError("invalid_capture", "无效的原始材料标识。");
    return join(this.root, `${id}.${ext}`);
  }
  begin(
    record: CaptureRecord,
    update: (record: CaptureRecord) => void,
  ): CaptureSink {
    if (this.unavailable)
      throw new AppError("capture_unavailable", "原始材料目录不可写。", 503);
    if (this.closed) throw new AppError("capture_closed", "采集库已关闭。");
    const hash = createHash("sha256");
    let lastUpdate = performance.now();
    let queue: Uint8Array[] = [],
      queued = 0,
      accepted = 0,
      saved = 0;
    let ending = false,
      reason: string | undefined,
      wake: (() => void) | undefined;
    const safeUpdate = (force = false) => {
      if (!force && performance.now() - lastUpdate < 250) return;
      lastUpdate = performance.now();
      if (!this.deleted.has(record.id)) {
        try {
          update({ ...record, bytes: saved });
        } catch {
          /* 采集索引故障不传入模型流。 */
        }
      }
    };
    const task = (async () => {
      let file: Awaited<ReturnType<typeof open>> | undefined;
      try {
        file = await open(this.path(record.id, "part"), "wx", 0o600);
        while (!ending || queue.length) {
          const next = queue.shift();
          if (!next) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            continue;
          }
          queued -= next.byteLength;
          // 文件写入允许短写；仅实际落盘字节参与完整性哈希。
          let offset = 0;
          while (offset < next.byteLength) {
            const result = await file.write(
              next,
              offset,
              next.byteLength - offset,
            );
            if (!result.bytesWritten) throw Error("short write");
            hash.update(next.subarray(offset, offset + result.bytesWritten));
            offset += result.bytesWritten;
            saved += result.bytesWritten;
          }
          safeUpdate();
        }
        await file.sync();
        await file.close();
        file = undefined;
        await rename(this.path(record.id, "part"), this.path(record.id, "raw"));
      } catch {
        reason = "storage_error";
        await file?.close().catch(() => {});
        await rename(
          this.path(record.id, "part"),
          this.path(record.id, "raw"),
        ).catch(() => {});
      } finally {
        ending = true;
        queue = [];
        this.reserved -= accepted - saved;
        record.status = reason ? "partial" : "complete";
        record.reason = reason ?? null;
        record.sha256 = hash.digest("hex");
        safeUpdate(true);
      }
    })();
    this.pending.set(record.id, task);
    void task.finally(() => {
      this.pending.delete(record.id);
      this.finishers.delete(record.id);
    });
    const finish = (why?: string) => {
      if (why && !reason) reason = why;
      ending = true;
      wake?.();
      return task;
    };
    this.finishers.set(record.id, finish);
    return {
      write: (bytes) => {
        if (ending || reason || this.deleted.has(record.id)) return;
        let remaining = Math.min(
          this.fileLimit - accepted,
          this.totalLimit - this.reserved,
        );
        if (remaining <= 0) {
          void finish(
            accepted >= this.fileLimit ? "file_limit" : "total_limit",
          );
          return;
        }
        remaining = Math.min(remaining, bytes.byteLength);
        // 超大原始分片不一次复制进队列；保存可容纳的前缀，并明确标记缺损。
        const count = Math.min(remaining, this.queueLimit - queued);
        if (count > 0) {
          queue.push(bytes.slice(0, count));
          queued += count;
          accepted += count;
          this.reserved += count;
          wake?.();
        }
        if (count < bytes.byteLength)
          void finish(
            count < remaining
              ? "queue_limit"
              : accepted >= this.fileLimit
                ? "file_limit"
                : "total_limit",
          );
      },
      finish,
    };
  }
  async read(id: string, offset: number, bytes: number): Promise<Uint8Array> {
    if (this.deleted.has(id))
      throw new AppError("not_found", "原始材料已清理。", 404);
    const path = this.path(id, "raw");
    const file = await open(path, "r").catch(() =>
      open(this.path(id, "part"), "r"),
    );
    try {
      const value = Buffer.alloc(bytes);
      const { bytesRead } = await file.read(value, 0, bytes, offset);
      return value.subarray(0, bytesRead);
    } finally {
      await file.close();
    }
  }
  async remove(id: string): Promise<void> {
    this.deleted.add(id);
    await this.finishers.get(id)?.("deleted");
    await this.pending.get(id);
    for (const ext of ["raw", "part"]) {
      const path = this.path(id, ext);
      try {
        const size = statSync(path).size;
        await rm(path, { force: true });
        this.reserved = Math.max(0, this.reserved - size);
      } catch {
        /* 已不存在的材料可重复清理。 */
      }
    }
  }
  async reconcile(ids: ReadonlySet<string>): Promise<void> {
    for (const name of readdirSync(this.root))
      if (/^[a-f0-9]{32}\.(part|raw)$/.test(name)) {
        const id = name.slice(0, 32);
        if (!ids.has(id)) await this.remove(id);
        else if (name.endsWith(".part"))
          await rename(this.path(id, "part"), this.path(id, "raw"));
      }
  }
  stats() {
    return {
      bytes: this.reserved,
      limit: this.totalLimit,
      fileLimit: this.fileLimit,
    };
  }
  async inspect(id: string) {
    const file = await open(this.path(id, "raw"), "r").catch(() =>
      open(this.path(id, "part"), "r"),
    );
    try {
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of file.createReadStream({ autoClose: false })) {
        hash.update(chunk);
        size += chunk.length;
      }
      return { bytes: size, sha256: hash.digest("hex") };
    } finally {
      await file.close();
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const finish of this.finishers.values()) void finish("shutdown");
    await Promise.allSettled([...this.pending.values()]);
  }
}
