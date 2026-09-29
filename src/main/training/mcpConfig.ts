import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { BrowserProfile, Environment } from "../../shared/types";
import { allowedOriginsArg } from "../../core/domains";

const require = createRequire(import.meta.url);
const SYSTEM_ENV = ["PATH", "Path", "SystemRoot", "SystemDrive", "windir", "TEMP", "TMP", "USERPROFILE", "HOME", "LOCALAPPDATA", "APPDATA", "ProgramFiles", "ProgramFiles(x86)", "PROGRAMDATA", "XDG_CONFIG_HOME"];

export interface StdioServer {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function playwrightMcpCli(): string {
  return join(dirname(require.resolve("@playwright/mcp/package.json")), "cli.js");
}

/**
 * Playwright MCP in extension mode, pinned to the profile chosen in the UI.
 * `--profile-dir-name` is mandatory: without it the extension attaches to the last used profile.
 * Runs with Electron's bundled Node so the app does not depend on a system Node/npx.
 */
export function playwrightMcpServer(opts: {
  profile: BrowserProfile;
  env: Environment;
  extensionToken: string | null;
  outputDir: string;
}): StdioServer {
  const args = [
    playwrightMcpCli(),
    "--extension",
    `--profile-dir-name=${opts.profile.profile_dir_name}`,
    `--allowed-origins=${allowedOriginsArg(opts.env.base_url, opts.env.allowed_domains)}`,
    `--output-dir=${opts.outputDir}`,
    "--codegen=typescript",
  ];
  if (opts.profile.browser === "msedge") args.push("--browser=msedge");
  // SDKs may start the server with only this env; the browser and profile lookup need the OS basics.
  const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: "1" };
  for (const k of SYSTEM_ENV) if (process.env[k]) env[k] = process.env[k]!;
  if (opts.extensionToken) env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = opts.extensionToken;
  return { command: process.execPath, args, env };
}
