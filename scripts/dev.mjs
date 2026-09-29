import { createServer } from "vite";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildNode } from "./build.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

await buildNode();
const server = await createServer({ configFile: resolve(root, "vite.config.mts") });
await server.listen();
const url = server.resolvedUrls?.local?.[0] ?? "http://localhost:5183/";

const electronPath = require("electron");
const child = spawn(electronPath, ["."], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, E2E_RENDERER_URL: url },
});
child.on("exit", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
