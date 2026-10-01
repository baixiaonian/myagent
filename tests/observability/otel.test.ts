/** OTLP 实际导出验收：本地接收 protobuf，通过协议字段解码核验父子身份、事件与正文隔离。 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { OtelTraceExporter } from "../../packages/adapters/src/index.js";
import type { SpanRecord } from "../../packages/contracts/src/index.js";

/** 仅解码本测试所需 protobuf wire 类型，不依赖导出 SDK 自己的对象序列化结果。 */
function fields(data: Buffer): Map<number, Buffer[]> {
  let offset = 0;
  const result = new Map<number, Buffer[]>();
  const uint = () => {
    let value = 0,
      shift = 0;
    while (offset < data.length) {
      const b = data[offset++]!;
      value += (b & 127) * 2 ** shift;
      if (!(b & 128)) return value;
      shift += 7;
    }
    throw Error("bad varint");
  };
  while (offset < data.length) {
    const key = uint(),
      wire = key & 7,
      index = key >>> 3;
    let value: Buffer;
    if (wire === 2) {
      const length = uint();
      value = data.subarray(offset, offset + length);
      offset += length;
    } else if (wire === 1) {
      value = data.subarray(offset, offset + 8);
      offset += 8;
    } else if (wire === 5) {
      value = data.subarray(offset, offset + 4);
      offset += 4;
    } else if (wire === 0) {
      const start = offset;
      uint();
      value = data.subarray(start, offset);
    } else throw Error("bad wire");
    const old = result.get(index) ?? [];
    old.push(value);
    result.set(index, old);
  }
  return result;
}
it("exports real OTLP protobuf spans/events/links with original identities", async () => {
  const packets: Buffer[] = [];
  let contentType = "";
  const server = createServer(async (req, res) => {
    contentType = String(req.headers["content-type"]);
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part));
    packets.push(Buffer.concat(parts));
    res.writeHead(200, { "content-type": "application/x-protobuf" }).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const exporter = new OtelTraceExporter(
    `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/traces`,
    { Authorization: "exporter-credential" },
  );
  const span: SpanRecord = {
    id: "a".repeat(16),
    traceId: "b".repeat(32),
    parentId: "c".repeat(16),
    name: "gen_ai.request",
    scope: { runId: "r", callId: "call" },
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: 2,
    outcome: "succeeded",
    attributes: { "gen_ai.usage.input_tokens": 20 },
    links: [{ spanId: "d".repeat(16), traceId: "e".repeat(32) }],
  };
  try {
    exporter.span(span, [
      {
        id: "evt",
        traceId: span.traceId,
        spanId: span.id,
        at: span.startedAt,
        name: "context.compacted",
        attributes: { version: 2 },
      },
    ]);
    await exporter.close();
    expect(contentType).toContain("application/x-protobuf");
    expect(packets.length).toBeGreaterThan(0);
    const resource = fields(packets[0]!).get(1)![0]!,
      scope = fields(resource).get(2)![0]!,
      encoded = fields(scope).get(2)![0]!,
      record = fields(encoded);
    expect(record.get(1)![0]!.toString("hex")).toBe(span.traceId);
    expect(record.get(2)![0]!.toString("hex")).toBe(span.id);
    expect(record.get(4)![0]!.toString("hex")).toBe(span.parentId);
    expect(record.get(5)![0]!.toString()).toBe("gen_ai.request");
    expect(record.get(11)).toHaveLength(1);
    expect(record.get(13)).toHaveLength(1);
    expect(packets[0]!.toString()).toContain("context.compacted");
    expect(packets[0]!.toString()).not.toContain("exporter-credential");
    expect(exporter.status()).toEqual({ failedBatches: 0, exportedSpans: 1 });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
