import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { BrowserProfile, Environment, PreflightResult } from "../../shared/types";
import { describeRule, evaluateAuthRules, resolveCheckUrl } from "../../core/authCheck";
import { playwrightMcpServer } from "./mcpConfig";

const CONNECT_TIMEOUT_MS = 90_000;

function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] })?.content ?? [];
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label}: quá ${Math.round(ms / 1000)}s`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export function pageUrlFromResult(text: string): string | null {
  const m = text.match(/Page URL:\s*(\S+)/i);
  return m ? m[1] : null;
}

/**
 * Opens the environment in the selected Chrome profile through Playwright MCP (extension mode)
 * and evaluates the environment's auth_check rules. The AI agent is only started when CONNECTED.
 */
export async function runPreflight(profile: BrowserProfile, env: Environment, extensionToken: string | null): Promise<PreflightResult> {
  const outDir = mkdtempSync(join(tmpdir(), "e2e-preflight-"));
  const server = playwrightMcpServer({ profile, env, extensionToken, outputDir: outDir });
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: { ...(process.env as Record<string, string>), ...server.env },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (d) => {
    stderr = (stderr + d.toString()).slice(-4000);
  });
  const client = new Client({ name: "e2e-ai-trainer-preflight", version: "1.0.0" });
  const checkUrl = resolveCheckUrl(env.base_url, env.auth_check);
  try {
    try {
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, "Kết nối Playwright MCP");
      const nav = await withTimeout(
        client.callTool({ name: "browser_navigate", arguments: { url: checkUrl } }),
        CONNECT_TIMEOUT_MS,
        "Mở trang bằng profile đã chọn",
      );
      if ((nav as { isError?: boolean }).isError) throw new Error(textOf(nav));
    } catch (e) {
      return {
        status: "PROFILE_UNAVAILABLE",
        message: `Không kết nối được profile "${profile.display_name}" (${profile.profile_dir_name}). Kiểm tra Chrome đang mở, Playwright Extension đã cài trong profile và đã cho phép kết nối. Chi tiết: ${(e as Error).message}${stderr ? `\n${stderr.trim().split("\n").slice(-5).join("\n")}` : ""}`,
      };
    }
    const snap = await client.callTool({ name: "browser_snapshot", arguments: {} });
    const snapText = textOf(snap);
    const url = pageUrlFromResult(snapText) ?? checkUrl;
    const cssPresent: Record<string, boolean> = {};
    for (const rule of env.auth_check.rules.filter((r) => r.type === "css_present")) {
      const res = await client.callTool({
        name: "browser_evaluate",
        arguments: { function: `() => !!document.querySelector(${JSON.stringify(rule.value)})` },
      });
      cssPresent[rule.value] = /\btrue\b/.test(textOf(res));
    }
    const failed = evaluateAuthRules(env.auth_check.rules, { url, text: snapText, cssPresent });
    if (failed.length > 0) {
      return {
        status: "AUTH_REQUIRED",
        message: `Profile chưa đăng nhập hoặc phiên đã hết hạn. Không đạt: ${failed.map(describeRule).join("; ")}`,
        url,
        failed_rules: failed,
      };
    }
    return { status: "CONNECTED", message: `Đã kết nối và xác nhận đăng nhập tại ${url}`, url };
  } finally {
    await client.close().catch(() => undefined);
    rmSync(outDir, { recursive: true, force: true });
  }
}
