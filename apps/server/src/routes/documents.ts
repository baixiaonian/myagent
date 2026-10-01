/** 人工文档 API：继承本机 Host/Origin 防护，严格校验路径、大小和版本；不静态托管项目 HTML。 */
import type { DocumentService } from "@myagent/application";
import type { DocumentSave } from "@myagent/contracts";
import type { FastifyInstance } from "fastify";
export function registerDocumentRoutes(
  server: FastifyInstance,
  documents: DocumentService,
) {
  const path = { type: "string", minLength: 1, maxLength: 4096 };
  server.get<{
    Params: { id: string };
    Querystring: { path?: string; offset?: string };
  }>(
    "/api/v1/projects/:id/files",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            path,
            offset: { type: "string", pattern: "^[0-9]{1,7}$" },
          },
        },
      },
    },
    (r) =>
      documents.list(r.params.id, r.query.path, Number(r.query.offset ?? 0)),
  );
  server.get<{ Params: { id: string }; Querystring: { path: string } }>(
    "/api/v1/projects/:id/document",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["path"],
          properties: { path },
        },
      },
    },
    (r) => documents.read(r.params.id, r.query.path),
  );
  server.put<{ Params: { id: string }; Body: DocumentSave }>(
    "/api/v1/projects/:id/document",
    {
      bodyLimit: 7 * 1024 * 1024,
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["path", "content", "expectedRevision"],
          properties: {
            path,
            content: { type: "string", maxLength: 1048576 },
            expectedRevision: { type: "string", pattern: "^[a-f0-9]{64}$" },
          },
        },
      },
    },
    (r) => documents.save(r.params.id, r.body),
  );
}
