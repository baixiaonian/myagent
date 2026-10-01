/** 文档工作区公开协议：正文仅来自已登记项目，revision 是文件字节的 SHA-256，不是聊天版本。 */
export interface ProjectDocument {
  path: string;
  format: "markdown" | "html";
  content: string;
  revision: string;
  bytes: number;
}
export interface DocumentDirectory {
  path: string;
  entries: {
    name: string;
    path: string;
    kind: "directory" | "document" | "file" | "symlink";
  }[];
  nextOffset: number | null;
}
export interface DocumentSave {
  path: string;
  content: string;
  expectedRevision: string;
}
export const DOCUMENT_MAX_BYTES = 1024 * 1024;
