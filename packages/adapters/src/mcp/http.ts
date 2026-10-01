/**
 * MCP 与 OAuth 专用 HTTP 传输：固定 DNS 解析结果，拒绝元数据将客户端带到未配置的内网地址。
 * 只转发本次 SDK 提供的认证头，不跟随重定向；tools/call 的鉴权失败不触发隐式重发。
 */
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { AppError } from "@myagent/contracts";

function privateAddress(address: string): boolean {
  return (
    address === "::1" ||
    address === "::" ||
    address.startsWith("fe80:") ||
    address.startsWith("fc") ||
    address.startsWith("fd") ||
    address.startsWith("::ffff:") ||
    /^(?:0|10|127|169\.254|192\.168)\./.test(address) ||
    /^172\.(?:1[6-9]|2\d|3[01])\./.test(address)
  );
}
export function mcpFetch(endpoint: string): FetchLike {
  const origin = new URL(endpoint).origin;
  return async (input, init = {}) => {
    const url = new URL(input);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new AppError("mcp_url", "MCP 请求地址无效。");
    if (url.protocol === "http:" && url.origin !== origin)
      throw new AppError("mcp_auth_url", "授权发现只能跳转到 HTTPS 地址。");
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await lookup(hostname, { all: true });
    const address = addresses.find(
      (item) => url.origin === origin || !privateAddress(item.address),
    );
    if (!address)
      throw new AppError(
        "mcp_address_denied",
        "MCP 授权元数据指向未配置的本机或内网地址。",
      );
    const headers = new Headers(init.headers);
    if (
      url.origin !== origin &&
      headers.get("authorization")?.startsWith("Bearer ")
    )
      headers.delete("authorization");
    let body: string | undefined;
    if (typeof init.body === "string") body = init.body;
    else if (init.body instanceof URLSearchParams) body = init.body.toString();
    else if (init.body !== undefined && init.body !== null)
      throw new AppError("mcp_request", "不支持该 MCP 请求正文格式。");
    let toolCall = false;
    try {
      toolCall = Boolean(
        body &&
          (JSON.parse(body) as { method?: string }).method === "tools/call",
      );
    } catch {
      /* OAuth 表单不是 JSON。 */
    }
    return await new Promise<Response>((resolve, reject) => {
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        url,
        {
          method: init.method ?? "GET",
          headers: Object.fromEntries(headers),
          lookup: (_host, options, callback) =>
            options.all
              ? callback(null, [address])
              : callback(null, address.address, address.family),
          ...(init.signal ? { signal: init.signal } : {}),
        },
        (response) => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(response.headers))
            if (value !== undefined)
              responseHeaders.set(
                key,
                Array.isArray(value) ? value.join(", ") : value,
              );
          const status = response.statusCode ?? 502;
          if (toolCall && status === 401) {
            response.destroy();
            reject(
              new AppError(
                "mcp_auth",
                "MCP 授权失效，请重新连接；本次工具没有自动重发。",
                401,
              ),
            );
            return;
          }
          // 重定向由用户更新连接地址；不把 Token 自动转发到另外一个主机。
          if (status >= 300 && status < 400) {
            response.destroy();
            reject(
              new AppError(
                "mcp_redirect",
                "MCP 地址发生重定向，请使用目标地址重新配置。",
              ),
            );
            return;
          }
          if (status === 204 || status === 205 || status === 304) {
            response.resume();
            resolve(new Response(null, { status, headers: responseHeaders }));
            return;
          }
          let bytes = 0;
          const readable = Readable.toWeb(
            response,
          ) as ReadableStream<Uint8Array>;
          const limited = readable.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                bytes += chunk.byteLength;
                if (bytes > 25 * 1024 * 1024)
                  throw new AppError(
                    "mcp_result_limit",
                    "MCP 响应超过捕获额度。",
                  );
                controller.enqueue(chunk);
              },
            }),
          );
          resolve(new Response(limited, { status, headers: responseHeaders }));
        },
      );
      request.on("error", () =>
        reject(new AppError("mcp_connection", "MCP 连接失败或中断。", 502)),
      );
      request.setTimeout(120000, () => request.destroy(new Error("timeout")));
      if (body !== undefined) request.write(body);
      request.end();
    });
  };
}
