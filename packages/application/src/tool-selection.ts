/**
 * MCP 按需工具选择：由 ToolService 调用，复用同一会话中已发现且仍有效的定义引用。
 * SQLite 只保存版本和预算元数据；当前注册表是定义来源，缓存不代表连接成功或执行授权。
 */
import {
  AppError,
  type ToolDescriptor,
  type Workspace,
} from "@myagent/contracts";
import type { ToolRegistryPort } from "@myagent/kernel";
import type { ExecutionStore, LoadedMcpTool } from "@myagent/state";

export class McpToolSelection {
  constructor(
    private readonly store: ExecutionStore,
    private readonly registry: ToolRegistryPort,
    private readonly pluginAllowed?: (
      connectionId: string,
      workspaceId: string,
      runId?: string,
    ) => boolean,
  ) {}

  /** 两种提供方式共用可见性边界；项目覆盖和信任由连接投影决定。 */
  eligible(
    tool: ToolDescriptor,
    workspace: Workspace | null,
    runId?: string,
  ): boolean {
    if (tool.source.kind !== "mcp" || !workspace) return false;
    const connection = this.store.get("connections", tool.source.connectionId);
    return Boolean(
      (this.pluginAllowed?.(tool.source.connectionId, workspace.id, runId) ??
        true) &&
        connection?.workspaceIds.includes(workspace.id) &&
        connection.enabled !== false &&
        !connection.blocked &&
        (!tool.source.workspaceId || tool.source.workspaceId === workspace.id),
    );
  }

  /** 只接受当前已发现的按需定义；不会把旧名称自动升级到新的 Schema。 */
  binding(tool: ToolDescriptor): LoadedMcpTool {
    if (tool.source.kind !== "mcp")
      throw new AppError("invalid_tool", "仅 MCP 工具参与按需选择。");
    const connection = this.store.get("connections", tool.source.connectionId);
    if (!connection) throw new AppError("mcp_changed", "MCP 配置已失效。");
    return {
      name: tool.name,
      version: tool.version,
      connectionId: connection.id,
      connectionRevision: connection.revision,
      definitionChars: JSON.stringify(tool).length,
    };
  }

  /**
   * 配置/权限/Schema 变化使引用失效。临时断连时可保留有界引用，但 available 不会提供离线定义；
   * 同版本重连后，只有重新发现且版本一致的工具才会恢复可见。此处不主动连接或执行工具。
   */
  valid(
    tools: LoadedMcpTool[],
    workspace: Workspace | null,
    runId?: string,
  ): LoadedMcpTool[] {
    if (!workspace) return [];
    const catalog = new Map(
      this.registry.descriptors().map((tool) => [tool.name, tool]),
    );
    return tools.filter((tool) => {
      const connection = this.store.get("connections", tool.connectionId);
      if (
        !(
          this.pluginAllowed?.(tool.connectionId, workspace.id, runId) ?? true
        ) ||
        !connection?.workspaceIds.includes(workspace.id) ||
        connection.enabled === false ||
        connection.blocked ||
        connection.toolExposure === "direct" ||
        connection.revision !== tool.connectionRevision
      )
        return false;
      const current = catalog.get(tool.name);
      return (
        !current ||
        (this.eligible(current, workspace, runId) &&
          current.version === tool.version)
      );
    });
  }

  /** 按最近选择顺序淘汰；断连引用仍计入原大小，缓存不能因离线而无限增长。 */
  trim(tools: LoadedMcpTool[]): { tools: LoadedMcpTool[]; evicted: string[] } {
    const kept = [...tools];
    const evicted: string[] = [];
    let size = kept.reduce((sum, tool) => sum + tool.definitionChars, 0);
    while (kept.length && size > 16000) {
      const oldest = kept.shift();
      if (!oldest) break;
      size -= oldest.definitionChars;
      evicted.push(oldest.name);
    }
    return { tools: kept, evicted };
  }

  /** 在 Run 创建事务内继承；未带版本的旧检查点不升级成可信缓存。 */
  inherit(
    sessionId: string,
    workspace: Workspace | null,
    runId?: string,
  ): LoadedMcpTool[] {
    const previous = this.store.get("sessionTools", sessionId);
    if (
      !workspace ||
      previous?.workspaceId !== workspace.id ||
      previous.workspaceIdentity !== workspace.identity
    )
      return [];
    return this.trim(this.valid(previous.tools, workspace, runId)).tools;
  }

  /**
   * Run 副本和会话选择同事务提交。先写检查点触发活动 Run 校验，阻止取消后的迟到搜索
   * 或已删除会话复活缓存；发现事实与任务最终成功与否无关，也不继承任何审批结果。
   */
  save(
    runId: string,
    workspace: Workspace | null,
    tools: LoadedMcpTool[],
  ): void {
    this.store.transaction(() => {
      const checkpoint = this.store.get("checkpoints", runId);
      if (!checkpoint)
        throw new AppError("checkpoint_missing", "缺少运行检查点。");
      const updatedAt = new Date().toISOString();
      this.store.put("checkpoints", {
        ...checkpoint,
        loadedTools: tools.map((tool) => tool.name),
        loadedToolBindings: tools,
        updatedAt,
      });
      if (workspace)
        this.store.put("sessionTools", {
          id: checkpoint.sessionId,
          sessionId: checkpoint.sessionId,
          workspaceId: workspace.id,
          workspaceIdentity: workspace.identity,
          tools,
          updatedAt,
        });
    });
  }
}
