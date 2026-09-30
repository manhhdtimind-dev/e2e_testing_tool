import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AgentProvider, TrainingEvent } from "../../shared/types";
import { validateScript } from "../../core/scriptValidator";
import type { AppContext } from "../context";
import { paths } from "../paths";
import { AppError, now } from "../util";
import { getEnvironment, getProfile } from "../services/environments";
import { secretKeys } from "../services/secrets";
import { runPreflight } from "./preflight";
import { playwrightMcpServer } from "./mcpConfig";
import { codexAdapter } from "./adapters/codex";
import { cursorAdapter } from "./adapters/cursor";
import { CANDIDATE_FILE, parseVerdict } from "./prompt";

export interface IntegrationCheckResult {
  agent: AgentProvider;
  ok: boolean;
  at: string;
  profile: string;
  environment: string;
  checks: { name: string; ok: boolean; detail: string }[];
}

/**
 * Mandatory integration spike (requirement §11): SDK → Playwright MCP extension → selected profile →
 * preflight → tool actions → candidate file. An adapter is only reported as working after this passes.
 */
export async function runIntegrationCheck(ctx: AppContext, agent: AgentProvider, profileId: string, environmentId: string): Promise<IntegrationCheckResult> {
  const profile = getProfile(ctx, profileId);
  const env = getEnvironment(ctx, environmentId);
  const settings = ctx.settings();
  const token = ctx.secrets.get(secretKeys.profileToken(profile.browser_profile_id));
  const checks: IntegrationCheckResult["checks"] = [];
  const result: IntegrationCheckResult = { agent, ok: false, at: now(), profile: profile.display_name, environment: env.name, checks };

  const pre = await runPreflight(profile, env, token);
  checks.push({ name: "Preflight profile + đăng nhập", ok: pre.status === "CONNECTED", detail: `${pre.status}: ${pre.message}` });
  if (pre.status !== "CONNECTED") return save(ctx, result);

  const apiKey = ctx.secrets.get(agent === "codex" ? secretKeys.openaiKey : secretKeys.cursorKey);
  if (agent === "cursor" && !apiKey) throw new AppError("Chưa cấu hình Cursor API key");
  const workspace = join(paths().workspaces, `_integration_${agent}`);
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
  const events: TrainingEvent[] = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("TIMEOUT"), 8 * 60_000);
  try {
    const turn = await (agent === "codex" ? codexAdapter : cursorAdapter).runTurn({
      providerThreadId: null,
      prompt: `Integration check. Use the Playwright MCP tools of server "playwright":
1. browser_navigate to ${env.base_url}
2. browser_snapshot
Then create the file ${CANDIDATE_FILE} in the current directory with exactly:
export async function run(page: any, input: any): Promise<void> {
  await page.goto("/");
}
Finish with ONE line of JSON: {"status":"done","reason":"<page title you saw>","steps_done":[1,2]}`,
      cwd: workspace,
      mcp: playwrightMcpServer({ profile, env, extensionToken: token, outputDir: join(workspace, "mcp-output") }),
      model: agent === "codex" ? settings.codex_model : settings.cursor_model,
      reasoningEffort: settings.codex_reasoning_effort,
      apiKey,
      title: "E2E integration check",
      signal: controller.signal,
      onEvent: (e) => events.push(e),
    });
    checks.push({ name: `${agent === "codex" ? "Codex" : "Cursor"} SDK tạo thread`, ok: !!turn.providerThreadId, detail: turn.providerThreadId || turn.error || "" });
    const browserCalls = events.filter((e) => e.kind === "tool_result" && e.tool?.startsWith("browser_"));
    const okCalls = browserCalls.filter((e) => e.ok);
    checks.push({
      name: "Agent gọi được Playwright MCP",
      ok: okCalls.some((e) => e.tool === "browser_navigate") && okCalls.some((e) => e.tool === "browser_snapshot"),
      detail: browserCalls.map((e) => `${e.tool}:${e.ok ? "ok" : "lỗi"}`).join(", ") || "không có tool call nào tới Playwright MCP",
    });
    const file = join(workspace, CANDIDATE_FILE);
    const source = existsSync(file) ? readFileSync(file, "utf8") : null;
    const validation = source ? validateScript(source, { schema: { fields: [] }, sampleInput: {} }) : null;
    checks.push({ name: "Agent ghi candidate file", ok: !!validation?.ok, detail: source ? (validation!.ok ? "hợp lệ" : validation!.issues.map((i) => i.message).join("; ")) : "không có file" });
    const verdict = parseVerdict(turn.finalText);
    checks.push({ name: "Kết thúc lượt", ok: turn.status === "completed" && verdict.status === "done", detail: turn.error ?? verdict.reason ?? turn.status });
  } catch (e) {
    checks.push({ name: "Chạy agent", ok: false, detail: controller.signal.aborted ? "Quá thời gian 8 phút" : (e as Error).message });
  } finally {
    clearTimeout(timer);
  }
  result.ok = checks.every((c) => c.ok);
  return save(ctx, result);
}

function save(ctx: AppContext, result: IntegrationCheckResult): IntegrationCheckResult {
  ctx.repo.setSetting(`integration:${result.agent}`, result);
  ctx.repo.audit("integration.check", "agent", result.agent, { ok: result.ok, profile: result.profile, environment: result.environment });
  return result;
}

export function getIntegrationStatus(ctx: AppContext): Record<AgentProvider, IntegrationCheckResult | null> {
  return {
    codex: ctx.repo.getSetting<IntegrationCheckResult>("integration:codex") ?? null,
    cursor: ctx.repo.getSetting<IntegrationCheckResult>("integration:cursor") ?? null,
  };
}
