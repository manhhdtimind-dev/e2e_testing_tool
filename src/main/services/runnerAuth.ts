import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext } from "playwright";
import type { RunnerResult } from "../../shared/types";
import type { AppContext } from "../context";
import { AppError, now } from "../util";
import { getEnvironment, requireAuthCheck } from "./environments";
import { secretKeys } from "./secrets";
import { runJob } from "../runner/runnerHost";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright") as typeof import("playwright");

interface Session {
  envId: string;
  browser: Browser;
  context: BrowserContext;
}

const sessions = new Map<string, Session>();

/**
 * Opens a dedicated browser (fresh context, not the Training Chrome profile) so the user can log in
 * for the runner. Cookies are never copied from the Training profile.
 */
export async function beginRunnerLogin(ctx: AppContext, envId: string): Promise<{ session_id: string }> {
  const env = getEnvironment(ctx, envId);
  const settings = ctx.settings();
  for (const [id, s] of sessions) if (s.envId === envId) await cancelRunnerLogin(ctx, id);
  const browser = await chromium.launch({ channel: settings.runner_browser === "chromium" ? undefined : settings.runner_browser, headless: false });
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();
  await page.goto(env.base_url).catch(() => undefined);
  const sessionId = `auth_${Date.now()}`;
  sessions.set(sessionId, { envId, browser, context });
  browser.on("disconnected", () => {
    if (sessions.delete(sessionId)) ctx.emit("auth:session", { session_id: sessionId, env_id: envId, state: "closed" });
  });
  ctx.repo.audit("runner_auth.begin", "environment", envId);
  return { session_id: sessionId };
}

export async function finishRunnerLogin(ctx: AppContext, sessionId: string) {
  const s = sessions.get(sessionId);
  if (!s) throw new AppError("Phiên đăng nhập đã đóng. Hãy mở lại.");
  const state = await s.context.storageState();
  const key = secretKeys.runnerAuth(s.envId);
  ctx.secrets.set(key, JSON.stringify(state));
  ctx.repo.environments.update([s.envId], { runner_auth_ref: key, runner_auth_updated_at: now() });
  ctx.repo.audit("runner_auth.save", "environment", s.envId, { cookies: state.cookies.length, origins: state.origins.length });
  sessions.delete(sessionId);
  await s.browser.close().catch(() => undefined);
  ctx.emit("auth:session", { session_id: sessionId, env_id: s.envId, state: "saved" });
}

export async function cancelRunnerLogin(ctx: AppContext, sessionId: string) {
  const s = sessions.get(sessionId);
  if (!s) return;
  sessions.delete(sessionId);
  await s.browser.close().catch(() => undefined);
  ctx.emit("auth:session", { session_id: sessionId, env_id: s.envId, state: "cancelled" });
}

export function clearRunnerAuth(ctx: AppContext, envId: string) {
  ctx.secrets.delete(secretKeys.runnerAuth(envId));
  ctx.repo.environments.update([envId], { runner_auth_ref: null, runner_auth_updated_at: null });
  ctx.repo.audit("runner_auth.clear", "environment", envId);
}

/** Runs only the environment's auth_check with the runner auth state, in the isolated runner process. */
export async function checkRunnerAuth(ctx: AppContext, envId: string): Promise<RunnerResult> {
  const env = getEnvironment(ctx, envId);
  requireAuthCheck(env);
  const settings = ctx.settings();
  const dir = mkdtempSync(join(tmpdir(), "e2e-authcheck-"));
  try {
    const state = env.runner_auth_ref ? ctx.secrets.get(env.runner_auth_ref) : null;
    const result = await runJob(
      {
        kind: "authcheck",
        runDir: dir,
        compiledPath: null,
        input: {},
        secretValues: [],
        baseUrl: env.base_url,
        allowedDomains: env.allowed_domains,
        authCheck: env.auth_check,
        browser: settings.runner_browser,
        headless: true,
        timeoutMs: 60_000,
        actionTimeoutMs: 10_000,
        navigationTimeoutMs: 30_000,
        traceOnSuccess: false,
      },
      state,
      { fsRestricted: settings.runner_fs_restricted },
    );
    ctx.repo.audit("runner_auth.check", "environment", envId, { ok: result.ok, error_code: result.error_code });
    return { ...result, screenshot: null, trace: null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
