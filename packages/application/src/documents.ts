/** 人工文档用例：Web 显式保存不创建模型任务；与工具共用项目锁和未知结果隔离。 */
import {
  AppError,
  type DocumentSave,
  type ExecutionConcern,
} from "@myagent/contracts";
import { containsPath } from "@myagent/kernel";
import type { DocumentFilePort, ExecutionStore } from "@myagent/state";
import type { ExecutionCoordinator } from "./execution-coordinator.js";
export class DocumentService {
  constructor(
    private readonly store: ExecutionStore,
    private readonly files: DocumentFilePort,
    private readonly coordinator: ExecutionCoordinator,
    private readonly concerns: () => ExecutionConcern[],
  ) {}
  private async use<T>(
    id: string,
    write: boolean,
    operation: (
      workspace: import("@myagent/contracts").Workspace,
    ) => Promise<T>,
  ): Promise<T> {
    const workspace = this.store.get("workspaces", id);
    if (!workspace || workspace.kind === "diagnostic")
      throw new AppError(
        "workspace_missing",
        "项目不存在，请重新选择项目。",
        404,
      );
    const release = await this.coordinator.acquire(
      `document:${id}`,
      [{ key: `path:${workspace.path}`, mode: write ? "write" : "read" }],
      new AbortController().signal,
    );
    try {
      // 锁内再次核对隔离，不能用人工保存绕过仍未知的工具副作用；读取保留用于核查。
      if (
        write &&
        this.concerns().some((c) =>
          c.resources.some(
            (r) =>
              r.kind === "path" &&
              (containsPath(workspace.path, r.target) ||
                containsPath(r.target, workspace.path)),
          ),
        )
      )
        throw new AppError(
          "document_quarantined",
          "项目仍有待核对的执行结果，请先完成核对再保存。",
          409,
        );
      return await operation(workspace);
    } finally {
      release();
    }
  }
  list(id: string, path = ".", offset = 0) {
    return this.use(id, false, (w) => this.files.list(w, path, offset));
  }
  read(id: string, path: string) {
    return this.use(id, false, (w) => this.files.read(w, path));
  }
  save(id: string, input: DocumentSave) {
    return this.use(id, true, (w) => this.files.save(w, input));
  }
}
