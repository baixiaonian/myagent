/** 项目目录树：按展开节点惰性读取与分页，不扫描整个工作区，不跟随符号链接。 */
import type { ChatClient, DocumentDirectory } from "@myagent/sdk";
import {
  ChevronRight,
  File,
  FileText,
  Folder,
  FolderOpen,
  LoaderCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
export function FileTree({
  client,
  workspaceId,
  active,
  onOpen,
  refresh,
}: {
  client: ChatClient;
  workspaceId: string;
  active: string | undefined;
  onOpen: (path: string) => void;
  refresh: number;
}) {
  return (
    <TreeDirectory
      key={`${workspaceId}:${refresh}`}
      client={client}
      workspaceId={workspaceId}
      path="."
      name="项目文件"
      active={active}
      onOpen={onOpen}
      root
    />
  );
}
function TreeDirectory({
  client,
  workspaceId,
  path,
  name,
  active,
  onOpen,
  root = false,
}: {
  client: ChatClient;
  workspaceId: string;
  path: string;
  name: string;
  active: string | undefined;
  onOpen: (path: string) => void;
  root?: boolean;
}) {
  const [open, setOpen] = useState(
    root || Boolean(active?.startsWith(`${path}/`)),
  );
  const [listing, setListing] = useState<DocumentDirectory | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (active?.startsWith(`${path}/`)) setOpen(true);
  }, [active, path]);
  useEffect(() => {
    if (!open || listing) return;
    let alive = true;
    setLoading(true);
    client
      .documentFiles(workspaceId, path)
      .then(
        (v) => {
          if (alive) {
            setListing(v);
            setError("");
          }
        },
        (e) => {
          if (alive) setError(e.message);
        },
      )
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, listing, client, workspaceId, path]);
  async function more() {
    if (listing?.nextOffset == null) return;
    setLoading(true);
    try {
      const next = await client.documentFiles(
        workspaceId,
        path,
        listing.nextOffset,
      );
      setListing({ ...next, entries: [...listing.entries, ...next.entries] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "目录加载失败");
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className="tree-directory">
      {!root && (
        <button
          type="button"
          className="tree-row"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronRight size={12} className={open ? "tree-chevron-open" : ""} />
          {open ? <FolderOpen size={14} /> : <Folder size={14} />}
          <span>{name}</span>
        </button>
      )}
      {open && (
        <div className={root ? "tree-root" : "tree-children"}>
          {listing?.entries.map((entry) =>
            entry.kind === "directory" ? (
              <TreeDirectory
                key={entry.path}
                {...{ client, workspaceId, active, onOpen }}
                path={entry.path}
                name={entry.name}
              />
            ) : (
              <button
                type="button"
                key={entry.path}
                className={`tree-row tree-file ${active === entry.path ? "active" : ""}`}
                disabled={entry.kind !== "document"}
                title={
                  entry.kind === "document"
                    ? entry.path
                    : entry.kind === "symlink"
                      ? "不跟随符号链接"
                      : "当前支持 Markdown / HTML"
                }
                onClick={() => onOpen(entry.path)}
              >
                {entry.kind === "document" ? (
                  <FileText size={14} />
                ) : (
                  <File size={14} />
                )}
                <span>{entry.name}</span>
              </button>
            ),
          )}
          {loading && (
            <span className="tree-loading">
              <LoaderCircle size={13} className="spin" /> 加载中
            </span>
          )}
          {error && (
            <p role="alert" className="document-error">
              {error}
            </p>
          )}
          {listing?.entries.length === 0 && (
            <span className="tree-loading">空目录</span>
          )}
          {listing?.nextOffset != null && (
            <button
              type="button"
              disabled={loading}
              onClick={() => void more()}
            >
              加载更多文件
            </button>
          )}
        </div>
      )}
    </div>
  );
}
