/**
 * 本地凭证适配器：按不透明引用独立保存密钥，提供读取、更换与删除。
 * 目录 0700、文件 0600；临时文件同步后原子替换。文件未加密，不能把权限控制称为加密。
 */
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { AppError } from "@myagent/contracts";
import type { CredentialStore } from "@myagent/state";
/** 不加密的本机凭证文件：单独保存、原子替换、目录 0700 / 文件 0600。 */
export class FileCredentialStore implements CredentialStore {
  private readonly path: string;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.path = join(directory, "credentials.json");
    if (existsSync(this.path)) {
      // 拒绝现有凭证路径指向符号链接，避免无意读写到数据目录之外的文件。
      if (lstatSync(this.path).isSymbolicLink())
        throw new AppError(
          "credential_storage",
          "凭证文件不能是符号链接。",
          500,
        );
      chmodSync(this.path, 0o600);
    }
  }
  // 缺少文件表示尚未存密钥；文件损坏必须报错，不能当作空配置覆盖掉原内容。
  private load(): Record<string, string> {
    if (!existsSync(this.path)) return {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        Object.values(parsed).some((value) => typeof value !== "string")
      )
        throw new Error("Invalid credential file");
      return parsed as Record<string, string>;
    } catch {
      throw new AppError(
        "credential_storage",
        "无法读取本地凭证文件，请检查数据目录。",
        500,
      );
    }
  }
  private save(data: Record<string, string>): void {
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      // 随机同目录临时文件以独占方式创建，确保权限从首次写入就受限，且可在同文件系统内替换。
      const fd = openSync(temp, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify(data));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      // 写完并 fsync 临时文件后才替换正式路径，读者只会看到完整旧版或新版 JSON。
      renameSync(temp, this.path);
    } catch {
      throw new AppError(
        "credential_storage",
        "无法保存本地凭证，请检查目录权限或磁盘空间。",
        500,
      );
    } finally {
      rmSync(temp, { force: true });
    }
  }
  read(ref: string): string | null {
    return this.load()[ref] ?? null;
  }
  write(ref: string, secret: string): void {
    this.save({ ...this.load(), [ref]: secret });
  }
  remove(ref: string): void {
    const data = this.load();
    delete data[ref];
    this.save(data);
  }
}
