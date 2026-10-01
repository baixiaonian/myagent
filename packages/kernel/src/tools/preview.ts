/**
 * 工具结果的纯文本投影：供执行层、结果文件库和上下文缩减共用。
 * 从原文取头尾，按最终序列化长度分配预算；执行事实不参与正文截断，不读写文件。
 */
import { AppError, type JsonValue } from "@myagent/contracts";

export interface ToolPreview {
  content: string;
  truncated: boolean;
}

/** UTF-16 长度沿用现有字符预算，但边界不能拆开 emoji 等代理对。 */
export function textHead(text: string, length: number): string {
  let end = Math.max(0, Math.min(text.length, length));
  if (end < text.length && /[\uD800-\uDBFF]/u.test(text.charAt(end - 1))) end--;
  return text.slice(0, end);
}
/** 尾部取样同样向内收缩边界，不能以半个低位代理项开头。 */
export function textTail(text: string, length: number): string {
  let start = Math.max(0, text.length - Math.max(0, length));
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(text.charAt(start))) start++;
  return text.slice(start);
}

/**
 * 小结果原样返回；大结果生成合法 JSON 预览，头尾平分剩余正文额度。
 * 截断提示、补读引用、JSON 转义和独立执行事实全部计入 maximum。
 * 固定信息本身放不下时显式失败，不能把退出码或引用切成半截冒充有效结果。
 */
export function createToolPreview(
  text: string,
  maximum: number,
  options: {
    reference?: string;
    facts?: JsonValue;
    forceEnvelope?: boolean;
  } = {},
): ToolPreview {
  if (!Number.isSafeInteger(maximum) || maximum < 1)
    throw new AppError("invalid_input", "工具结果字符上限必须为正整数。", 422);
  const envelope = (preview: string) =>
    JSON.stringify({
      ...(options.facts ? { execution: options.facts } : {}),
      preview,
    });
  const complete = options.forceEnvelope ? envelope(text) : text;
  if (complete.length <= maximum)
    return { content: complete, truncated: false };
  const marker = `\n[中间已截断${options.reference ? `；${options.reference}` : "；可查阅本地执行记录"}]\n`;
  const render = (size: number) =>
    envelope(
      textHead(text, Math.ceil(size / 2)) +
        marker +
        textTail(text, Math.floor(size / 2)),
    );
  if (render(0).length > maximum)
    throw new AppError(
      "context_limit",
      "工具结果预算不足以保留执行状态和补读引用，请增大工具结果字符上限。",
      422,
    );
  // 对最终 JSON 二分测量，避免引号、换行转义后突破上限；不生成半截 JSON。
  let low = 0;
  let high = Math.min(text.length, maximum);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (render(middle).length <= maximum) low = middle;
    else high = middle - 1;
  }
  return { content: render(low), truncated: true };
}

/** MCP 二进制附件只保存在原记录；重新从文件投影也必须遵守同一模型可见边界。 */
export function modelResultValue(
  value: JsonValue,
  resultRef: string,
): JsonValue {
  if (Array.isArray(value))
    return value.map((item) => modelResultValue(item, resultRef));
  if (!value || typeof value !== "object") return value;
  if (value.type === "image" || value.type === "audio")
    return {
      type: value.type,
      mimeType: value.mimeType ?? null,
      note: "二进制内容保存在完整结果，本轮没有发送给模型。",
      resultRef,
    };
  if (
    value.type === "resource" &&
    value.resource &&
    typeof value.resource === "object" &&
    !Array.isArray(value.resource)
  ) {
    const { blob, ...resource } = value.resource;
    return {
      type: "resource",
      resource: modelResultValue(resource, resultRef),
      ...(blob ? { note: "二进制资源保存在完整结果。", resultRef } : {}),
    };
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      modelResultValue(item, resultRef),
    ]),
  );
}

/** 从可信执行回执中提取固定事实；它们独立展示，不随巨大 data 的中间部分消失。 */
export function resultFacts(value: JsonValue): JsonValue | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("outcome" in value) ||
    !("data" in value)
  )
    return undefined;
  const facts: Record<string, JsonValue> = {
    outcome: value.outcome ?? null,
    error: value.error ?? null,
    effectsPossible: value.effectsPossible ?? false,
  };
  const data = value.data;
  if (
    data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    typeof data.processId === "string"
  ) {
    for (const key of [
      "processId",
      "status",
      "exitCode",
      "signal",
      "stopReason",
      "outputComplete",
      "outputTruncated",
      "outputRef",
      "cursor",
    ])
      if (data[key] !== undefined) facts[key] = data[key];
  }
  return facts;
}

/** 同一安全投影同时用于首次反馈及从持久结果重建预览。 */
export function previewSavedResult(
  value: JsonValue,
  maximum: number,
  resultRef: string,
): ToolPreview {
  const visible = modelResultValue(value, resultRef);
  const full = JSON.stringify(visible);
  const facts = resultFacts(visible);
  // 固定事实从正文移出：否则正文尾部额度容易全被 JSON 的退出码等字段占据，真正的末尾日志反而看不见。
  const data =
    facts && visible && typeof visible === "object" && !Array.isArray(visible)
      ? visible.data
      : undefined;
  const process =
    data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    typeof data.processId === "string" &&
    typeof data.output === "string"
      ? data
      : undefined;
  const text =
    full.length > maximum && data !== undefined
      ? process
        ? String(process.output)
        : JSON.stringify(data)
      : full;
  const preview = createToolPreview(text, maximum, {
    reference: `read_tool_result resultId=${resultRef}`,
    facts: facts ?? null,
    forceEnvelope: text !== full,
  });
  return {
    ...preview,
    truncated: preview.truncated || process?.outputTruncated === true,
  };
}
