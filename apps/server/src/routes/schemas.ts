const text = (maxLength: number, minLength = 1) => ({
  type: "string",
  minLength,
  maxLength,
});
const revision = { type: "integer", minimum: 0 };
export const settingsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["baseUrl", "model", "systemPrompt", "expectedRevision"],
  properties: {
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
