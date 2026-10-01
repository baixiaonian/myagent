/** 长期记忆 HTTP 边界：严格 DTO 校验，所有文件编辑和整理任务经 MemoryService；不暴露内部任务输入或凭证。 */
import type { MemoryService } from "@myagent/application";
import type {
  MemoryQuery,
  MemorySettings,
  MemoryUpdate,
  SessionMemorySettings,
} from "@myagent/contracts";
import type { FastifyInstance } from "fastify";
export function registerMemoryRoutes(
  server: FastifyInstance,
  memory: MemoryService,
): void {
  const string = { type: "string", minLength: 1, maxLength: 200 };
  const revision = { type: "integer", minimum: 0 };
  const object = (
    properties: Record<string, unknown>,
    required: string[] = [],
  ) => ({ type: "object", additionalProperties: false, properties, required });
  const params = object({ id: string }, ["id"]);
  const readQuery = object({
    cursor: { type: "string", maxLength: 2000 },
    sourceId: { type: "string", maxLength: 1000 },
  });
  server.get("/api/v1/memories", async () => memory.overview());
  server.post("/api/v1/memories/sync", async () => {
    await memory.refresh();
    return memory.overview();
  });
  server.put<{
    Body: Omit<MemorySettings, "revision" | "enabledAt"> & {
      expectedRevision: number;
    };
  }>(
    "/api/v1/memories/settings",
    {
      schema: {
        body: object(
          {
            expectedRevision: revision,
            enabled: { type: "boolean" },
            useMemories: { type: "boolean" },
            generateMemories: { type: "boolean" },
            idleMinutes: { type: "integer", minimum: 0, maximum: 10080 },
            dailyRequests: { type: "integer", minimum: 1, maximum: 10000 },
            taskRequests: { type: "integer", minimum: 2, maximum: 1000 },
            requestTimeoutMs: {
              type: "integer",
              minimum: 100,
              maximum: 600000,
            },
          },
          [
            "expectedRevision",
            "enabled",
            "useMemories",
            "generateMemories",
            "idleMinutes",
            "dailyRequests",
            "taskRequests",
            "requestTimeoutMs",
          ],
        ),
      },
    },
    async (request) => memory.saveSettings(request.body),
  );
  server.get<{ Querystring: MemoryQuery }>(
    "/api/v1/memories/entries",
    {
      schema: {
        querystring: object({
          query: { type: "string", maxLength: 500 },
          project: { type: "string", maxLength: 4000 },
          kind: { enum: ["preference", "project", "experience", "decision"] },
          cursor: { type: "string", maxLength: 2000 },
          limit: { type: "integer", minimum: 1, maximum: 20 },
        }),
      },
    },
    async (request) => memory.search(request.query),
  );
  server.get<{
    Params: { id: string };
    Querystring: { cursor?: string; sourceId?: string };
  }>(
    "/api/v1/memories/entries/:id",
    { schema: { params, querystring: readQuery } },
    async (request) =>
      memory.readEntry(
        request.params.id,
        request.query.cursor,
        request.query.sourceId,
      ),
  );
  server.post<{ Body: MemoryUpdate }>(
    "/api/v1/memories/entries",
    {
      schema: {
        body: object(
          {
            requestId: string,
            action: { enum: ["add", "edit", "forget"] },
            id: string,
            expectedRevision: revision,
            title: { type: "string", maxLength: 200 },
            text: { type: "string", maxLength: 12000 },
            kind: { enum: ["preference", "project", "experience", "decision"] },
            project: { type: ["string", "null"], maxLength: 4000 },
          },
          ["requestId", "action"],
        ),
      },
    },
    async (request) => ({ entry: await memory.update(request.body) }),
  );
  server.post<{
    Body: { id: string; expectedRevision: string; requestId: string };
  }>(
    "/api/v1/memories/undo",
    {
      schema: {
        body: object(
          { id: string, expectedRevision: string, requestId: string },
          ["id", "expectedRevision", "requestId"],
        ),
      },
    },
    async (request) => {
      await memory.undo(
        request.body.id,
        request.body.expectedRevision,
        request.body.requestId,
      );
      return { ok: true };
    },
  );
  server.post<{ Body: { sessionId: string; requestId: string } }>(
    "/api/v1/memories/jobs",
    {
      schema: {
        body: object({ sessionId: string, requestId: string }, [
          "sessionId",
          "requestId",
        ]),
      },
    },
    async (request) => {
      const job = await memory.jobs.create(
        request.body.sessionId,
        request.body.requestId,
      );
      memory.jobs.kick();
      return memory.jobView(job);
    },
  );
  server.post<{ Params: { id: string } }>(
    "/api/v1/memories/jobs/:id/cancel",
    { schema: { params } },
    async (request) => {
      memory.jobs.cancel(request.params.id);
      return { ok: true };
    },
  );
  server.post<{ Params: { id: string } }>(
    "/api/v1/memories/jobs/:id/retry",
    { schema: { params } },
    async (request) => memory.jobView(memory.jobs.retry(request.params.id)),
  );
  server.get<{ Params: { id: string } }>(
    "/api/v1/sessions/:id/memory",
    { schema: { params } },
    async (request) => memory.sessionSettings(request.params.id),
  );
  server.put<{
    Params: { id: string };
    Body: Omit<SessionMemorySettings, "id" | "revision"> & {
      expectedRevision: number;
    };
  }>(
    "/api/v1/sessions/:id/memory",
    {
      schema: {
        params,
        body: object(
          {
            expectedRevision: revision,
            useMemories: { type: "boolean" },
            contributeMemories: { type: "boolean" },
          },
          ["expectedRevision", "useMemories", "contributeMemories"],
        ),
      },
    },
    async (request) => memory.saveSession(request.params.id, request.body),
  );
}
