/**
 * Trace 右侧单页详情：业务证据、实际模型材料、属性、事件与因果关联连续排列。
 * 使用公开的安全 Step/调用投影，不读取厂商续接；调试正文由 ModelCallDetails 独立获取。
 */
import type {
  ChatClient,
  SpanEvidence,
  SpanRecord,
  TraceEventRecord,
} from "@myagent/sdk";
import { useEffect, useState } from "react";
import {
  AttributeTable,
  CopyValue,
  DetailSection,
  DisplayValue,
} from "./DetailSections.js";
import { ModelCallDetails } from "./ModelCallDetails.js";
import { isViewGroup } from "./trace-presentation.js";
import { duration, spanLabel, statusText, traceHref } from "./trace-view.js";

const eventNames: Record<string, string> = {
  "context.prepared": "上下文组装完成",
  "context.sources": "本次选入的全部来源",
  "context.added": "新增到上下文",
  "context.changed": "内容或版本发生变化",
  "context.removed": "本次移出的来源",
  "context.failed": "上下文准备失败",
  "context.blocked": "容量不足暂停",
  "memory.snapshot": "读取长期记忆快照",
};
function SourceEntries({ value }: { value: string | number | boolean }) {
  try {
    const items = JSON.parse(String(value)) as {
      id: string;
      kind: string;
      label: string;
      characters: number;
    }[];
    if (!Array.isArray(items)) return <DisplayValue value={value} />;
    return (
      <div className="trace-source-list">
        {items.map((item) => (
          <div key={item.id}>
            <strong>{item.label}</strong>
            <small>
              {item.kind} · {item.characters?.toLocaleString()} 字符
            </small>
            <code>{item.id}</code>
          </div>
        ))}
      </div>
    );
  } catch {
    return <DisplayValue value={value} />;
  }
}
export function TraceInspector({
  client,
  traceId,
  selected,
  spans,
  events,
  origin,
  select,
  moreEvents,
  loadingMore,
  loadEvents,
}: {
  client: ChatClient;
  traceId: string;
  selected: SpanRecord;
  spans: SpanRecord[];
  events: TraceEventRecord[];
  origin: number;
  select: (id: string | null) => void;
  moreEvents: boolean;
  loadingMore: boolean;
  loadEvents: () => void;
}) {
  const [evidence, setEvidence] = useState<SpanEvidence>({}),
    [error, setError] = useState("");
  const viewGroup = isViewGroup(selected);
  useEffect(() => {
    let disposed = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    setEvidence({});
    setError("");
    if (
      viewGroup ||
      (!selected.scope.stepId &&
        !selected.scope.invocationId &&
        !selected.name.startsWith("team.message."))
    )
      return;
    const update = async () => {
      try {
        const value = await client.spanEvidence(traceId, selected.id);
        if (disposed) return;
        setEvidence(value);
        if (selected.outcome === "running")
          timer = setTimeout(() => void update(), 1000);
      } catch (cause) {
        if (!disposed)
          setError(cause instanceof Error ? cause.message : "业务详情读取失败");
      }
    };
    void update();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [
    client,
    traceId,
    selected.id,
    selected.outcome,
    selected.scope.stepId,
    selected.scope.invocationId,
    selected.name,
    viewGroup,
  ]);
  const ids = new Set([selected.id]);
  // 只按真实关系与明确身份归集，未加载页保持未知，不用相邻时间猜测。
  for (let n = 0; n < spans.length; n++) {
    let changed = false;
    for (const span of spans) {
      if (
        (span.parentId && ids.has(span.parentId)) ||
        (selected.name === "agent.step" &&
          selected.scope.stepId &&
          span.scope.stepId === selected.scope.stepId) ||
        (selected.scope.invocationId &&
          span.scope.invocationId === selected.scope.invocationId)
      ) {
        if (!ids.has(span.id)) {
          ids.add(span.id);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  const ownEvents = events
    .filter((event) => ids.has(event.spanId))
    .toSorted((a, b) => a.at.localeCompare(b.at));
  const diagnostic = spans.filter(
    (span) =>
      span.id !== selected.id &&
      ids.has(span.id) &&
      /^(tool\.(validate|permission|dispatch|lock_wait|slot_wait)|model.queue)$/.test(
        span.name,
      ),
  );
  const calls = selected.scope.callId
    ? [selected]
    : selected.name === "context.prepare"
      ? spans.filter(
          (span) =>
            span.name === "gen_ai.request" &&
            selected.scope.stepId !== undefined &&
            span.traceId === selected.traceId &&
            span.scope.stepId === selected.scope.stepId &&
            span.scope.purpose !== "summary" &&
            span.scope.callId,
        )
      : [];
  const resultData = evidence.invocation?.result?.data;
  const savedTarget =
    resultData && typeof resultData === "object" && !Array.isArray(resultData)
      ? resultData.agentId
      : undefined;
  const links = spans.filter(
    (span) =>
      span.name === "agent.run" &&
      span.id !== selected.id &&
      [
        selected.attributes["myagent.target.agent"],
        savedTarget,
        selected.attributes.from,
        selected.attributes.to,
      ].includes(span.scope.agentId ?? "main"),
  );
  const basic = {
    状态: statusText(selected.outcome),
    开始时间: selected.startedAt,
    结束时间: selected.endedAt ?? "尚无结束记录",
    耗时: duration(selected.durationMs),
    相对起点: `+${duration(Date.parse(selected.startedAt) - origin)}`,
    节点类型: selected.name,
  };
  return (
    <div className="trace-inspector-body" key={selected.id}>
      <div className="trace-node-meta">
        <span className="trace-badge">{statusText(selected.outcome)}</span>
        <span>{selected.startedAt}</span>
        <span>{duration(selected.durationMs)}</span>
      </div>
      {error && (
        <p className="trace-notice" role="alert">
          {error}
        </p>
      )}
      {links.length > 0 && (
        <DetailSection title="关联成员">
          {links.map((span) => (
            <a
              key={span.id}
              className="trace-causal-link"
              href={traceHref(traceId, span.id)}
              onClick={(event) => {
                event.preventDefault();
                select(span.id);
              }}
            >
              查看 {spanLabel(span)} 的执行分支
            </a>
          ))}
        </DetailSection>
      )}
      {evidence.step && selected.name === "agent.step" && (
        <DetailSection title="本轮模型输出与工具" value={evidence.step}>
          <pre className="trace-business-text">
            {evidence.step.content || "本步骤没有正文输出"}
          </pre>
          <AttributeTable
            values={{
              工具: evidence.step.tools.map((tool) => ({
                name: tool.name,
                status: tool.status,
                callId: tool.id,
              })),
              结束原因: evidence.step.finishReason,
              用量: evidence.step.usage,
            }}
          />
        </DetailSection>
      )}
      {evidence.invocation && (
        <>
          <DetailSection title="工具输入" value={evidence.invocation.arguments}>
            <DisplayValue value={evidence.invocation.arguments} />
          </DetailSection>
          <DetailSection title="工具结果" value={evidence.invocation.result}>
            <DisplayValue
              value={evidence.invocation.result ?? "尚无已保存回执"}
            />
          </DetailSection>
          <DetailSection
            title="执行约束"
            value={evidence.invocation.command ?? evidence.invocation.resources}
          >
            <AttributeTable
              values={{
                状态: evidence.invocation.status,
                资源: evidence.invocation.resources,
                命令判断: evidence.invocation.command ?? "不适用",
                模式: evidence.invocation.executionMode ?? "standard",
              }}
            />
          </DetailSection>
        </>
      )}
      {evidence.messages?.map((message) => (
        <DetailSection key={message.id} title="通信内容" value={message}>
          <AttributeTable
            values={{
              类型: message.kind,
              发送方: message.from,
              接收方: message.to,
              已入队: message.createdAt,
              纳入步骤: message.includedStep,
              接收Run: message.includedRunId,
              回复身份: message.repliedBy,
            }}
          />
          <pre className="trace-business-text">{message.content}</pre>
        </DetailSection>
      ))}
      {selected.name === "context.prepare" && (
        <p className="trace-notice">
          来源变化见下方事件；新增记录不等于全部重写。实际发送的正文以本步骤模型输入为准。旧记录未采集来源差异时不补造。
        </p>
      )}
      {selected.name !== "context.prepare" &&
        calls.map((call) => (
          <ModelCallDetails
            key={call.scope.callId}
            client={client}
            callId={call.scope.callId!}
          />
        ))}
      {selected.name === "context.prepare" &&
        ownEvents.some((e) =>
          ["context.added", "context.changed", "context.removed"].includes(
            e.name,
          ),
        ) && (
          <DetailSection
            title="本次上下文变化"
            value={ownEvents.filter((e) =>
              ["context.added", "context.changed", "context.removed"].includes(
                e.name,
              ),
            )}
          >
            {ownEvents
              .filter((e) =>
                [
                  "context.added",
                  "context.changed",
                  "context.removed",
                ].includes(e.name),
              )
              .map((event) => (
                <div key={event.id}>
                  <h4>
                    {eventNames[event.name]} · {event.attributes.count}
                  </h4>
                  <SourceEntries value={event.attributes.entries ?? "[]"} />
                </div>
              ))}
          </DetailSection>
        )}
      <DetailSection title="节点属性" value={selected.attributes}>
        <AttributeTable values={selected.attributes} />
      </DetailSection>
      <DetailSection title="事件" value={ownEvents}>
        {ownEvents.length === 0 && (
          <p className="trace-section-empty">暂无已加载事件。</p>
        )}
        {ownEvents.map((event) => (
          <article key={event.id} className="trace-detail-event">
            <div className="trace-event-title">
              <time>{event.at}</time>
              <strong>{eventNames[event.name] ?? event.name}</strong>
              <CopyValue
                label="复制事件"
                value={JSON.stringify(event, null, 2)}
              />
            </div>
            {event.attributes.entries !== undefined ? (
              <>
                <AttributeTable
                  values={{
                    count: event.attributes.count,
                    omitted: event.attributes.omitted,
                  }}
                />
                {selected.name === "context.prepare" &&
                [
                  "context.added",
                  "context.changed",
                  "context.removed",
                ].includes(event.name) ? (
                  <p className="trace-section-empty">
                    来源明细见上方“本次上下文变化”
                  </p>
                ) : (
                  <SourceEntries value={event.attributes.entries} />
                )}
              </>
            ) : (
              <AttributeTable values={event.attributes} />
            )}
          </article>
        ))}
        {moreEvents && (
          <button type="button" disabled={loadingMore} onClick={loadEvents}>
            加载更多事件
          </button>
        )}
      </DetailSection>
      <DetailSection title="节点概况" value={basic}>
        <AttributeTable values={basic} />
      </DetailSection>
      {selected.name === "context.prepare" &&
        calls.map((call) => (
          <ModelCallDetails
            key={call.scope.callId}
            client={client}
            callId={call.scope.callId!}
          />
        ))}
      <DetailSection title="关联身份" value={selected.scope}>
        <AttributeTable values={{ ...selected.scope }} />
      </DetailSection>
      <DetailSection title="因果关联" value={selected.links}>
        {selected.links.length ? (
          selected.links.map((link) => (
            <a
              className="trace-causal-link"
              key={`${link.traceId}:${link.spanId}`}
              href={traceHref(link.traceId, link.spanId)}
            >
              Trace {link.traceId} / Span {link.spanId}
            </a>
          ))
        ) : (
          <p className="trace-section-empty">无因果 Link</p>
        )}
        {selected.parentId && (
          <a
            className="trace-causal-link"
            href={traceHref(traceId, selected.parentId)}
            onClick={(event) => {
              event.preventDefault();
              select(selected.parentId);
            }}
          >
            查看所属节点
          </a>
        )}
      </DetailSection>
      {diagnostic.length > 0 && (
        <DetailSection title="内部诊断记录" value={diagnostic}>
          {diagnostic.map((span) => (
            <details key={span.id} className="trace-diagnostic">
              <summary>
                {spanLabel(span)} · {statusText(span.outcome)} ·{" "}
                {duration(span.durationMs)}
              </summary>
              <AttributeTable values={span.attributes} />
            </details>
          ))}
        </DetailSection>
      )}
    </div>
  );
}
