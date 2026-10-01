/**
 * 模型节点同页详情：请求属性、用量和输入/输出纵向展示。选中节点即读取已采材料，无额外 Tab。
 * 切换节点作废旧请求，原文仍只通过独立本机材料接口取得，不持久到浏览器或聊天事件。
 */
import type { CaptureRecord, ChatClient, ModelCallRecord } from "@myagent/sdk";
import { useEffect, useState } from "react";
import { CaptureDetails } from "./CaptureDetails.js";
import { AttributeTable, DetailSection } from "./DetailSections.js";
import { duration, statusText } from "./trace-view.js";

export function ModelCallDetails({
  client,
  callId,
}: {
  client: ChatClient;
  callId: string;
}) {
  const [call, setCall] = useState<ModelCallRecord | null>(null),
    [captures, setCaptures] = useState<CaptureRecord[]>([]);
  const [error, setError] = useState(""),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let disposed = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    setCall(null);
    setCaptures([]);
    setError("");
    const update = async () => {
      try {
        const data = await client.modelCall(callId);
        if (disposed) return;
        setCall(data.call);
        setCaptures(data.captures);
        if (
          !data.call.endedAt ||
          data.captures.some((c) => c.status === "capturing")
        )
          timer = setTimeout(() => void update(), 1000);
      } catch (cause) {
        if (!disposed)
          setError(cause instanceof Error ? cause.message : "读取失败");
      }
    };
    void refresh;
    void update();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [client, callId, refresh]);
  if (!call)
    return (
      <p className="trace-section-empty" role={error ? "alert" : "status"}>
        {error || "正在读取模型请求…"}
      </p>
    );
  const fields = {
    模型: call.model,
    返回模型: call.responseModel,
    协议: call.protocol,
    用途: call.scope.purpose,
    请求状态: `${statusText(call.status)} · ${call.sent ? "已发送" : "未发送"}`,
    首分片: duration(call.firstChunkMs),
    首正文: duration(call.firstTextMs),
    输入输出用量: call.usage ?? "用量未知",
    费用估算:
      call.cost === null
        ? `未计价：${call.unpricedReason ?? "缺少依据"}`
        : `${call.currency} ${call.cost}`,
    计价依据: call.price ?? "未知",
    服务商请求身份: call.responseId,
  };
  return (
    <section className="model-call-detail" aria-label="模型请求详情">
      <div className="trace-detail-heading">
        <strong>{call.model}</strong>
        <span className="trace-badge">{call.protocol}</span>
        <span>{statusText(call.status)}</span>
      </div>
      {!call.debug && (
        <p className="trace-notice">
          本次请求未开启调试采集，无法展示实际请求/响应原文，也不能事后补录。
        </p>
      )}
      {call.debug && captures.length === 0 && (
        <p className="trace-notice">
          尚无已保存的原始材料，不使用历史重建代替原文。
        </p>
      )}
      {[...captures]
        .sort((a, b) => a.direction.localeCompare(b.direction))
        .map((capture) => (
          <CaptureDetails
            key={capture.id}
            client={client}
            callId={callId}
            capture={capture}
            onCleared={() => setRefresh((v) => v + 1)}
          />
        ))}
      <DetailSection title="模型请求与用量" value={fields}>
        <AttributeTable values={fields} />
      </DetailSection>
    </section>
  );
}
