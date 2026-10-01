/** 可观测性 HTTP 边界：原始材料独立读取且禁止缓存，不向聊天 SSE 暴露正文。 */
import type { ObservabilityService } from "@myagent/application";
import {
  AppError,
  type ModelPrice,
  type ObservationQuery,
} from "@myagent/contracts";
import type { FastifyInstance } from "fastify";

const text = { type: "string", minLength: 1, maxLength: 300 };
const revision = { type: "integer", minimum: 0 };
const body = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});
const params = body({ id: text, callId: text, captureId: text }, []);
function number(value: string | undefined): number {
  const n = value === undefined ? 0 : Number(value);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new AppError("invalid_query", "分页位置无效。");
  return n;
}
export function registerObservationRoutes(
  server: FastifyInstance,
  service: ObservabilityService,
) {
  const root = "/api/v1/observability";
  server.get<{ Params: { id: string; spanId: string } }>(
    `${root}/traces/:id/spans/:spanId/evidence`,
    {
      schema: { params: body({ id: text, spanId: text }, ["id", "spanId"]) },
    },
    async (r, reply) => {
      reply.header("Cache-Control", "no-store");
      return service.evidence(r.params.id, r.params.spanId);
    },
  );
  server.get(`${root}/settings`, async () => service.settings());
  server.put<{
    Body: {
      requestId: string;
      expectedRevision: number;
      debug: boolean;
      retentionDays: number;
    };
  }>(
    `${root}/settings`,
    {
      schema: {
        body: body(
          {
            requestId: text,
            expectedRevision: revision,
            debug: { type: "boolean" },
            retentionDays: { type: "integer", minimum: 1, maximum: 3650 },
          },
          ["requestId", "expectedRevision", "debug", "retentionDays"],
        ),
      },
    },
    async (r) => service.configure(r.body),
  );
  const querySchema = body(
    {
      sessionId: text,
      runId: text,
      rootRunId: text,
      model: text,
      status: text,
      purpose: text,
      from: text,
      to: text,
      offset: { type: "string", pattern: "^[0-9]+$" },
      limit: { type: "string", pattern: "^[0-9]+$" },
    },
    [],
  );
  const query = (value: Record<string, string>): ObservationQuery => ({
    ...value,
    offset: number(value.offset),
    limit: value.limit ? Math.min(200, number(value.limit)) : 50,
  });
  server.get<{ Querystring: Record<string, string> }>(
    `${root}/traces`,
    { schema: { querystring: querySchema } },
    async (r) => service.traces(query(r.query)),
  );
  server.get<{ Querystring: Record<string, string> }>(
    `${root}/usage`,
    { schema: { querystring: querySchema } },
    async (r) => service.usage(query(r.query)),
  );
  server.get<{ Querystring: Record<string, string> }>(
    `${root}/calls`,
    { schema: { querystring: querySchema } },
    async (r) => {
      const q = query(r.query),
        all = service.calls(q).reverse(),
        offset = q.offset ?? 0,
        limit = q.limit ?? 50;
      return {
        items: all.slice(offset, offset + limit),
        nextOffset: all.length > offset + limit ? offset + limit : null,
      };
    },
  );
  server.get<{
    Params: { id: string };
    Querystring: { spanOffset?: string; eventOffset?: string };
  }>(
    `${root}/traces/:id`,
    {
      schema: {
        params,
        querystring: body(
          {
            spanOffset: { type: "string", pattern: "^[0-9]+$" },
            eventOffset: { type: "string", pattern: "^[0-9]+$" },
          },
          [],
        ),
      },
    },
    async (r) =>
      service.trace(
        r.params.id,
        number(r.query.spanOffset),
        number(r.query.eventOffset),
      ),
  );
  server.get<{ Params: { id: string } }>(
    `${root}/calls/:id`,
    { schema: { params } },
    async (r) => service.call(r.params.id),
  );
  server.get<{ Params: { id: string } }>(
    `${root}/runs/:id`,
    { schema: { params } },
    async (r) => service.runSummary(r.params.id),
  );
  server.get(`${root}/prices`, async () => service.prices());
  const rate = { type: "string", pattern: "^[0-9]{1,12}(\\.[0-9]{1,9})?$" },
    nullableRate = { anyOf: [rate, { type: "null" }] };
  server.put<{
    Body: { requestId: string; expectedRevision: number; price: ModelPrice };
  }>(
    `${root}/prices`,
    {
      schema: {
        body: body(
          {
            requestId: text,
            expectedRevision: revision,
            price: body(
              {
                connection: text,
                model: text,
                currency: { enum: ["USD", "CNY"] },
                input: rate,
                output: rate,
                cacheRead: nullableRate,
                cacheWrite: nullableRate,
              },
              [
                "connection",
                "model",
                "currency",
                "input",
                "output",
                "cacheRead",
                "cacheWrite",
              ],
            ),
          },
          ["requestId", "expectedRevision", "price"],
        ),
      },
    },
    async (r) => service.savePrice(r.body),
  );
  server.get<{
    Params: { callId: string; captureId: string };
    Querystring: { offset?: string; download?: string };
  }>(
    `${root}/calls/:callId/captures/:captureId`,
    {
      schema: {
        params,
        querystring: body(
          {
            offset: { type: "string", pattern: "^[0-9]+$" },
            download: { enum: ["1"] },
          },
          [],
        ),
      },
    },
    async (r, reply) => {
      reply
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff");
      if (r.query.download === "1") {
        reply
          .type("application/octet-stream")
          .header(
            "Content-Disposition",
            `attachment; filename="${r.params.captureId}.raw"`,
          );
        return Buffer.from(
          await service.raw(r.params.callId, r.params.captureId),
        );
      }
      return service.capturePage(
        r.params.callId,
        r.params.captureId,
        number(r.query.offset),
      );
    },
  );
  server.delete<{
    Params: { callId: string; captureId: string };
    Body: { requestId: string; expectedRevision: number };
  }>(
    `${root}/calls/:callId/captures/:captureId`,
    {
      schema: {
        params,
        body: body({ requestId: text, expectedRevision: revision }, [
          "requestId",
          "expectedRevision",
        ]),
      },
    },
    async (r) =>
      service.clearCapture(r.params.callId, r.params.captureId, r.body),
  );
}
