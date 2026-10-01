/**
 * 用户选中模型节点后自动呈现输入与输出首屏。每份材料独立分页，迟到响应不能覆盖新节点。
 * 一键复制按游标读取已保存原文；采集缺损与页面部分加载分别标注，不改写原始文件。
 */
import type { CaptureRecord, ChatClient } from "@myagent/sdk";
import { useEffect, useRef, useState } from "react";
import { CopyValue } from "./DetailSections.js";

export function CaptureDetails({
  client,
  callId,
  capture,
  onCleared,
}: {
  client: ChatClient;
  callId: string;
  capture: CaptureRecord;
  onCleared: () => void;
}) {
  const [text, setText] = useState(""),
    [next, setNext] = useState<number | null>(null),
    [error, setError] = useState("");
  const [loading, setLoading] = useState(false),
    [formatted, setFormatted] = useState(true);
  const version = useRef(0),
    loaded = useRef(false);
  const title = capture.direction === "input" ? "原始输入" : "原始输出";
  useEffect(() => {
    const generation = ++version.current;
    loaded.current = false;
    setText("");
    setError("");
    setNext(null);
    if (capture.status === "purged") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      setLoading(true);
      try {
        const page = await client.capturePage(callId, capture.id);
        if (version.current !== generation) return;
        setText(page.text);
        setNext(page.nextOffset);
        loaded.current = true;
        if (capture.status === "capturing")
          timer = setTimeout(() => void read(), 1000);
      } catch (cause) {
        if (version.current === generation)
          setError(cause instanceof Error ? cause.message : "读取失败");
      } finally {
        if (version.current === generation) setLoading(false);
      }
    };
    void read();
    return () => {
      version.current++;
      clearTimeout(timer);
    };
  }, [client, callId, capture.id, capture.status]);
  const completeText = async () => {
    const generation = version.current;
    let offset = 0,
      content = "";
    // 不把未加载页面冒充完整原文。读取受到采集上限和游标进度双重约束。
    for (;;) {
      const page = await client.capturePage(callId, capture.id, offset);
      if (version.current !== generation) throw Error("节点已切换");
      content += page.text;
      if (page.nextOffset === null) return content;
      if (page.nextOffset <= offset || page.nextOffset > 64 * 1024 * 1024)
        throw Error("请下载大型原始文件");
      offset = page.nextOffset;
    }
  };
  let shown = text;
  if (formatted && loaded.current && next === null) {
    try {
      shown = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      /* SSE 和非法 JSON 保持逐字可读，不伪造解析结果。 */
    }
  }
  return (
    <section
      className="trace-detail-section obs-capture trace-body-capture"
      aria-label={title}
    >
      <header>
        <h3>{title}</h3>
        {capture.status !== "purged" && (
          <CopyValue
            label={
              capture.status === "complete"
                ? `复制完整${title}`
                : `复制已保存${title}`
            }
            value={completeText}
          />
        )}
      </header>
      <div className="trace-capture-meta">
        <span>
          {
            {
              complete: "采集完整",
              partial: "采集不完整",
              capturing: "采集中",
              purged: "已清理",
            }[capture.status]
          }{" "}
          · {capture.bytes.toLocaleString()} 字节
          {capture.reason ? ` · ${capture.reason}` : ""}
        </span>
        {capture.status !== "purged" && (
          <a href={client.captureDownload(callId, capture.id)}>下载原始文件</a>
        )}
      </div>
      {error && (
        <p className="trace-notice error" role="alert">
          {error}
        </p>
      )}
      {capture.status !== "purged" && (
        <>
          <pre className="obs-raw">
            {shown || (loading ? "正在读取…" : "尚无正文")}
          </pre>
          <div className="trace-capture-meta">
            <span>
              {next === null
                ? "已加载当前保存内容"
                : "页面仅加载部分内容；复制与下载读取已保存原文"}
            </span>
            <label>
              <input
                type="checkbox"
                checked={formatted}
                onChange={(event) => setFormatted(event.target.checked)}
              />
              格式化 JSON
            </label>
          </div>
          <div className="trace-actions">
            {next !== null && (
              <button
                type="button"
                disabled={loading}
                onClick={async () => {
                  const generation = version.current;
                  setLoading(true);
                  try {
                    const page = await client.capturePage(
                      callId,
                      capture.id,
                      next,
                    );
                    if (version.current !== generation) return;
                    if (page.nextOffset !== null && page.nextOffset <= next)
                      throw Error("分页未前进");
                    setText((old) => old + page.text);
                    setNext(page.nextOffset);
                  } catch (cause) {
                    if (version.current === generation) setError(String(cause));
                  } finally {
                    if (version.current === generation) setLoading(false);
                  }
                }}
              >
                加载更多原文
              </button>
            )}
            {capture.status !== "capturing" && (
              <button
                type="button"
                disabled={loading}
                onClick={async () => {
                  if (
                    !window.confirm(
                      "清理这份原始调试材料？聊天历史和用量记录会保留。",
                    )
                  )
                    return;
                  const generation = version.current;
                  setLoading(true);
                  try {
                    const settings = await client.observationSettings();
                    await client.clearCapture(
                      callId,
                      capture.id,
                      settings.revision,
                    );
                    if (version.current === generation) {
                      setText("");
                      onCleared();
                    }
                  } catch (cause) {
                    if (version.current === generation) setError(String(cause));
                  } finally {
                    if (version.current === generation) setLoading(false);
                  }
                }}
              >
                清理材料
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
