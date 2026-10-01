/**
 * 项目用例：新对话直接绑定已有目录或自动目录，创建幂等记录与会话由仓储原子提交。
 * 目录创建属于可恢复的文件系统准备；重试复用分配路径，不把文件创建称为数据库事务。
 */
import {
  AppError,
  type CreateSessionInput,
  type Session,
  type Workspace,
} from "@myagent/contracts";
import type {
  ChatStore,
  ExecutionStore,
  ProjectDirectoryPort,
} from "@myagent/state";

export class ProjectService {
  private readonly pending = new Map<string, Promise<Session>>();
  constructor(
    private readonly chat: ChatStore,
    private readonly store: ExecutionStore,
    readonly directories: ProjectDirectoryPort,
    private readonly id: () => string,
  ) {}
  list(): Workspace[] {
    const paths = new Set<string>();
    return (
      this.store
        .list("workspaces")
        .toReversed()
        .filter((w) => w.kind !== "diagnostic" && w.kind !== "default")
        .sort((a, b) =>
          (b.lastUsedAt ?? b.createdAt).localeCompare(
            a.lastUsedAt ?? a.createdAt,
          ),
        )
        // 最近项目展示路径的最新登记；旧身份仍留给原会话和原授权引用。
        .filter((workspace) => {
          if (paths.has(workspace.path)) return false;
          paths.add(workspace.path);
          return true;
        })
        .slice(0, 20)
    );
  }
  async prepare(path: string): Promise<Workspace> {
    const value = await this.directories.prepare(path, this.id(), "project");
    const existing = this.store
      .list("workspaces")
      .find((w) => w.path === value.path && w.identity === value.identity);
    // 此入口来自用户明确选目录/新建对话。设备重新挂载或目录被替换后，
    // 按新的 workspace ID 登记，不能更新旧记录或继承其 grant、MCP 信任与会话。
    // 执行中的旧会话仍由 WorkspacePort.validate 拒绝发生身份变化的路径。
    const project = {
      ...(existing ?? value),
      lastUsedAt: new Date().toISOString(),
    };
    this.store.put("workspaces", project);
    return project;
  }
  create(input: CreateSessionInput = {}): Promise<Session> {
    const requestId = input.requestId ?? this.id();
    const fingerprint = JSON.stringify({ path: input.path ?? null });
    const existing = this.chat.findSessionCreation?.(requestId, fingerprint);
    if (existing) return Promise.resolve(existing);
    const pending = this.pending.get(requestId);
    if (pending)
      return pending.then(
        () =>
          this.chat.findSessionCreation?.(requestId, fingerprint) as Session,
      );
    const operation = (async () => {
      // allocation 使用服务端 ID；请求 ID 绝不能直接拼接为文件路径。
      const sessionId = this.id();
      const workspace = input.path
        ? await this.prepare(input.path)
        : await this.directories.prepare(undefined, requestId, "default");
      return this.chat.createSession({
        id: sessionId,
        workspace,
        requestId,
        fingerprint,
      });
    })().finally(() => this.pending.delete(requestId));
    this.pending.set(requestId, operation);
    return operation;
  }
  async ensure(sessionId: string): Promise<Workspace> {
    const snapshot = this.chat.snapshot(sessionId);
    if (snapshot.session.workspaceId) {
      const workspace = this.store.get(
        "workspaces",
        snapshot.session.workspaceId,
      );
      if (!workspace)
        throw new AppError("workspace_missing", "会话的项目记录不存在。", 409);
      return workspace;
    }
    const workspace = await this.directories.prepare(
      undefined,
      sessionId,
      "default",
    );
    this.store.transaction(() => {
      const current = this.chat.snapshot(sessionId);
      if (current.session.workspaceId) return;
      this.store.put("workspaces", workspace);
      this.store.bindWorkspace(
        sessionId,
        workspace.id,
        current.session.revision,
      );
    });
    return this.store.get(
      "workspaces",
      this.chat.snapshot(sessionId).session.workspaceId as string,
    ) as Workspace;
  }
  async diagnostic(): Promise<Workspace> {
    const candidate = await this.directories.prepare(
      undefined,
      "mcp-check",
      "diagnostic",
    );
    const old = this.store
      .list("workspaces")
      .find(
        (w) =>
          w.kind === "diagnostic" &&
          w.path === candidate.path &&
          w.identity === candidate.identity,
      );
    if (old) return old;
    this.store.put("workspaces", candidate);
    return candidate;
  }
}
