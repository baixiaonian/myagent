/**
 * 浏览器产物边界检查：扫描 Web 构建输出中的服务端标识和测试凭证。
 * 这是有限模式的回归检查，不替代完整的秘密扫描；执行前必须先构建 Web。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const directory = new URL("../apps/web/dist/", import.meta.url);
const forbidden = [
  "sk-fixture-only-never-a-real-key",
  "sk-e2e-fake-only",
  "credentials.json",
  "better-sqlite3",
  "OpenAIChatModel",
];
// 递归检查可交付文本产物；发现禁止标识立即失败，不打印包含潜在凭证的原始内容。
function inspect(path) {
  for (const file of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, file.name);
    if (file.isDirectory()) inspect(child);
    else if (/\.(js|html|css|map)$/.test(file.name)) {
      const content = readFileSync(child, "utf8");
      if (forbidden.some((pattern) => content.includes(pattern)))
        throw new Error(
          `Unexpected server code or fixture credential in ${file.name}`,
        );
    }
  }
}
inspect(decodeURIComponent(directory.pathname));
console.info("Web build contains no server adapter or fixture credentials.");
