import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skipRenderer = process.argv.includes("--no-renderer");

export async function buildNode() {
  const common = {
    bundle: true,
    platform: "node",
    target: "node24",
    sourcemap: true,
    packages: "external",
    logLevel: "info",
  };
  await esbuild({
    ...common,
    entryPoints: [resolve(root, "src/main/main.ts")],
    outfile: resolve(root, "dist/main/main.mjs"),
    format: "esm",
    external: ["electron"],
    banner: {
      js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
  });
  await esbuild({
    ...common,
    entryPoints: [resolve(root, "src/preload/preload.ts")],
    outfile: resolve(root, "dist/preload/preload.cjs"),
    format: "cjs",
    external: ["electron"],
  });
  await esbuild({
    ...common,
    entryPoints: [resolve(root, "src/runner/runner.ts")],
    outfile: resolve(root, "dist/runner/runner.cjs"),
    format: "cjs",
  });
}

export async function buildRenderer() {
  await viteBuild({ configFile: resolve(root, "vite.config.mts") });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  rmSync(resolve(root, "dist/main"), { recursive: true, force: true });
  await buildNode();
  if (!skipRenderer) await buildRenderer();
}
