/** 项目和配置文件适配端口：应用层通过这里访问本机，避免依赖 Node 或文件系统。 */
import type {
  DirectoryListing,
  DirectorySelection,
  McpConfigTarget,
  Workspace,
} from "@myagent/contracts";
export interface ProjectDirectoryPort {
  prepare(
    path: string | undefined,
    allocation: string,
    kind: "project" | "default" | "diagnostic",
  ): Promise<Workspace>;
  pick(): Promise<DirectorySelection>;
  browse(path?: string): Promise<DirectoryListing>;
}
export interface McpConfigFilePort {
  read(
    target: McpConfigTarget,
  ): Promise<{ path: string; text: string; revision: string }>;
  write(
    target: McpConfigTarget,
    text: string,
    expectedRevision: string,
  ): Promise<string>;
}
