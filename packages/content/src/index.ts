/**
 * 内容模块的只读记忆端口：应用在 Run 开始时取得有来源、预算受限的片段。
 * Server 注入应用层 MemoryService；空实现供独立内核测试使用。向量索引不在本轮范围。
 */
export interface MemorySnippet {
  sourceId: string;
  version: string;
  scope: string;
  text: string;
}
export interface MemoryProvider {
  /** 删除/禁用时撤销快照片段；普通更新不替换正在运行的快照。 */
  validate?(
    sessionId: string,
    pieces: readonly MemorySnippet[],
  ): Promise<readonly MemorySnippet[]>;
  read(
    input: {
      sessionId: string;
      workspaceId: string | null;
      query: string;
      budget: number;
    },
    signal: AbortSignal,
  ): Promise<readonly MemorySnippet[]>;
}
export const emptyMemoryProvider: MemoryProvider = { read: async () => [] };
export * from "./memory.js";
