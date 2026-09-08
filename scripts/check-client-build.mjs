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
