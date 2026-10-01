/** 文档编辑器选区：文本范围用于精确替换，屏幕坐标仅用于就地操作条，不作为文件写入授权。 */
export interface DocumentSelection {
  text: string;
  from: number;
  to: number;
  rect?: { left: number; top: number; bottom: number };
}
