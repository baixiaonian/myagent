/**
 * HTTP 请求的 JSON Schema：限制字段、长度与版本号，在进入用例前拒绝无效输入。
 * 这些是运行时校验规则，需与 contracts DTO 和协议文档同步；业务并发检查仍由仓储执行。
 */
const text = (maxLength: number, minLength = 1) => ({
  type: "string",
  minLength,
  maxLength,
});
const revision = { type: "integer", minimum: 0 };
// 禁止额外字段以暴露客户端协议错误；仅密钥写入字段可选，读取 API 从不复用此 Schema。
export const settingsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["baseUrl", "model", "systemPrompt", "expectedRevision"],
  properties: {
    apiProtocol: { type: "string", enum: ["responses", "chat_completions"] },
    baseUrl: text(2000),
    model: text(200),
    systemPrompt: text(4000, 0),
    expectedRevision: revision,
    apiKey: text(4096),
    clearKey: { type: "boolean" },
  },
};
export const runSchema = {
  type: "object",
  additionalProperties: false,
  required: ["requestId", "expectedRevision", "content"],
  properties: {
    requestId: text(100),
    expectedRevision: revision,
    content: text(8000),
  },
};
// 重新生成从会话历史取最后问题，所以请求不接受 content，以免悄悄修改原问题。
export const regenerateSchema = {
  type: "object",
  additionalProperties: false,
  required: ["requestId", "expectedRevision"],
  properties: { requestId: text(100), expectedRevision: revision },
};
export const renameSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "expectedRevision"],
  properties: { title: text(100), expectedRevision: revision },
};
