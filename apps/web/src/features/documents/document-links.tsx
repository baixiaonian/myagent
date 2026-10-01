/** 对话中的项目文档引用：仅识别完整文件路径，不把普通代码或远程 URL 当成本机文档。 */
import { createContext, useContext } from "react";
export const DocumentNavigation = createContext<
  ((path: string) => void) | null
>(null);
export function documentPath(value: string): string | null {
  let path = value.trim();
  if (/^file:\/\//i.test(path)) {
    try {
      path = decodeURIComponent(new URL(path).pathname);
    } catch {
      return null;
    }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return null;
  path = path.replace(/(?:#L?\d+(?:[-:]L?\d+)?|:\d+(?::\d+)?)$/, "");
  return /\.(?:md|markdown|html|htm)$/i.test(path) && !/[\n\r<>]/.test(path)
    ? path
    : null;
}
export function DocumentLink({
  value,
  children,
}: {
  value: string;
  children: React.ReactNode;
}) {
  const open = useContext(DocumentNavigation);
  const path = documentPath(value);
  return open && path ? (
    <button
      type="button"
      className="document-link"
      title={`打开文档 ${path}`}
      onClick={() => open(path)}
    >
      {children}
    </button>
  ) : (
    <>{children}</>
  );
}
