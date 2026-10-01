/**
 * 已保存结果分页查看器：SDK 依据会话和引用鉴权，浏览器不读取本机任意文件。
 * 内容以纯文本渲染，不执行工具结果里的 HTML、终端转义或脚本。
 */
import type { ChatClient } from "@myagent/sdk";
import { useState } from "react";
import { Modal } from "../../components/Modal.js";
export function ResultViewer({
  client,
  sessionId,
  resultId,
}: {
  client: ChatClient;
  sessionId: string;
  resultId: string;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [capture, setCapture] = useState<{
    complete: boolean;
    bytes: number;
    omitted: number | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function load(first = false) {
    setBusy(true);
    if (first) {
      setText("");
      setCapture(null);
    }
    setError("");
    try {
      const page = await client.result(
        sessionId,
        resultId,
        first ? undefined : (cursor ?? undefined),
      );
      setText((old) => (first ? page.text : old + page.text));
      setCursor(page.cursor);
      setCapture({
        complete: page.captureComplete,
        bytes: page.totalBytes,
        omitted: page.omittedBytes ?? null,
      });
    } catch (error) {
      setError(error instanceof Error ? error.message : "结果加载失败。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        type="button"
        className="copy-button"
        onClick={() => {
          setOpen(true);
          void load(true);
        }}
      >
        查看保存的结果
      </button>
      {open && (
        <Modal title="工具执行结果" onClose={() => setOpen(false)} wide>
          {capture && (
            <p className="field-hint">
              已保存 {capture.bytes.toLocaleString()} 字节。
              {capture.complete
                ? "来源标记为完整采集；分页只影响当前展示。"
                : `来源未完整采集；省略量${capture.omitted === null ? "未知" : `${capture.omitted} 字节`}，不能将保存内容视为完整原始输出。`}
            </p>
          )}
          <pre className="full-result">{text}</pre>
          {error && <p role="alert">{error}</p>}
          {cursor && (
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => void load()}
            >
              加载下一页
            </button>
          )}
          {busy && <p>正在读取…</p>}
        </Modal>
      )}
    </>
  );
}
