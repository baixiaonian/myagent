/** 人工文档操作端口：由应用层协调锁，适配器在读取和落盘前复核项目、路径及文件版本。 */
import type {
  DocumentDirectory,
  DocumentSave,
  ProjectDocument,
  Workspace,
} from "@myagent/contracts";
export interface DocumentFilePort {
  list(
    workspace: Workspace,
    path: string,
    offset: number,
  ): Promise<DocumentDirectory>;
  read(workspace: Workspace, path: string): Promise<ProjectDocument>;
  save(workspace: Workspace, input: DocumentSave): Promise<ProjectDocument>;
}
