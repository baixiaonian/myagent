/** 文档自动保存：防抖、IME 保护及串行 CAS；失败后保留草稿并停止自动重试，关闭标签可等待最后一次提交。 */
import { ApiError, type ChatClient, type ProjectDocument } from "@myagent/sdk";
import { useCallback, useEffect, useRef, useState } from "react";

export function useDocumentSave(
  client: ChatClient,
  workspaceId: string,
  file: ProjectDocument,
  draft: string,
  onSaved: (file: ProjectDocument) => void,
  composing: boolean,
) {
  const latest = useRef({ draft, onSaved, composing });
  latest.current = { draft, onSaved, composing };
  const base = useRef(file);
  const pending = useRef<Promise<boolean> | null>(null);
  const blocked = useRef(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState<ProjectDocument | null>(null);
  useEffect(() => {
    if (!pending.current) base.current = file;
  }, [file]);
  const flush = useCallback(async (): Promise<boolean> => {
    if (pending.current) return pending.current;
    if (blocked.current || latest.current.composing) return false;
    if (latest.current.draft === base.current.content) return true;
    setSaving(true);
    const operation = (async () => {
      try {
        // 一个文档只允许一个在途写入；期间继续输入时，下一次提交使用刚确认的版本。
        while (
          latest.current.draft !== base.current.content &&
          !latest.current.composing
        ) {
          const sent = latest.current.draft;
          const saved = await client.saveDocument(workspaceId, {
            path: base.current.path,
            content: sent,
            expectedRevision: base.current.revision,
          });
          base.current = saved;
          latest.current.onSaved(saved);
        }
        setError("");
        return !latest.current.composing;
      } catch (reason) {
        blocked.current = true;
        setError(
          reason instanceof Error
            ? reason.message
            : "自动保存失败，修改仍保留在页面中。",
        );
        if (reason instanceof ApiError && reason.code === "file_conflict")
          try {
            setConflict(await client.document(workspaceId, base.current.path));
          } catch {
            /* 不能把补读失败当作磁盘版本未变化。 */
          }
        return false;
      } finally {
        pending.current = null;
        setSaving(false);
      }
    })();
    pending.current = operation;
    return operation;
  }, [client, workspaceId]);
  useEffect(() => {
    if (composing || blocked.current || draft === file.content) return;
    const timer = setTimeout(() => void flush(), 650);
    return () => clearTimeout(timer);
  }, [draft, file.content, composing, flush]);
  const retry = () => {
    blocked.current = false;
    setError("");
    void flush();
  };
  const adopt = (next: ProjectDocument) => {
    base.current = next;
    blocked.current = false;
    setError("");
    setConflict(null);
  };
  return { saving, error, conflict, flush, retry, adopt };
}
