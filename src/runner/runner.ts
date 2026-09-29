import Module from "node:module";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { RunnerJob, RunnerMessage } from "../shared/runnerJob";
import type { RunnerResult, StepLog } from "../shared/types";
import { evaluateAuthRules, describeRule, resolveCheckUrl } from "../core/authCheck";
import { AUTH_REQUIRED_MARKER, DOMAIN_BLOCKED_MARKER, RUN_TIMEOUT_MARKER, classifyError } from "../core/errorClassifier";
import { isUrlAllowed } from "../core/domains";
import { instrument, redact, type Recorder } from "./instrument";

const ALLOWED_MODULES: Record<string, string> = {
  "@playwright/test": require.resolve("playwright/test"),
  "playwright/test": require.resolve("playwright/test"),
  playwright: require.resolve("playwright"),
};

function send(msg: RunnerMessage) {
  process.send?.(msg);
}

/** Generated scripts may only load Playwright; every other module request is rejected. */
function lockModules(compiledPath: string) {
  const M = Module as unknown as { _resolveFilename: (req: string, parent: { filename?: string } | undefined, ...rest: unknown[]) => string };
  const original = M._resolveFilename;
  M._resolveFilename = function (request, parent, ...rest) {
    if (parent?.filename === compiledPath) {
      const mapped = ALLOWED_MODULES[request];
      if (!mapped) throw new Error(`Script không được phép tải module "${request}"`);
      return mapped;
    }
    return original.call(this, request, parent, ...rest);
  };
}

async function collectFacts(page: Page, job: RunnerJob) {
  const url = page.url();
  let text = "";
  try {
    text = await page.locator("body").innerText({ timeout: 5000 });
  } catch {
    text = "";
  }
  const cssPresent: Record<string, boolean> = {};
  for (const rule of job.authCheck.rules.filter((r) => r.type === "css_present")) {
    cssPresent[rule.value] = await page
      .locator(rule.value)
      .first()
      .isVisible()
      .catch(() => false);
  }
  return { url, text, cssPresent };
}

async function verifyAuth(page: Page, job: RunnerJob): Promise<string | null> {
  const checkUrl = resolveCheckUrl(job.baseUrl, job.authCheck);
  await page.goto(checkUrl, { waitUntil: "domcontentloaded", timeout: job.navigationTimeoutMs });
  await page.waitForLoadState("load", { timeout: 10_000 }).catch(() => undefined);
  if (job.authCheck.rules.some((r) => r.type !== "url_contains" && r.type !== "url_not_contains")) {
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
  }
  const failed = evaluateAuthRules(job.authCheck.rules, await collectFacts(page, job));
  return failed.length ? failed.map(describeRule).join("; ") : null;
}

async function execute(job: RunnerJob): Promise<RunnerResult> {
  const t0 = Date.now();
  const steps: StepLog[] = [];
  const rec: Recorder = { steps, secrets: job.secretValues, onStep: (step) => send({ type: "step", step }) };
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let blockedUrl: string | null = null;
  let tracing = false;
  const result: RunnerResult = { ok: false, error_code: null, error_message: null, steps, screenshot: null, trace: null, duration_ms: 0, final_url: null };

  const finish = async (ok: boolean) => {
    result.ok = ok;
    if (page) {
      result.final_url = page.url();
      try {
        const shot = join(job.runDir, "final.png");
        await page.screenshot({ path: shot, timeout: 10_000 });
        result.screenshot = shot;
      } catch {
        // page may already be closed
      }
    }
    if (context && tracing) {
      try {
        if (!ok || job.traceOnSuccess) {
          const tracePath = join(job.runDir, "trace.zip");
          await context.tracing.stop({ path: tracePath });
          result.trace = tracePath;
        } else {
          await context.tracing.stop();
        }
      } catch {
        // tracing failures must not hide the run result
      }
    }
    await browser?.close().catch(() => undefined);
    result.duration_ms = Date.now() - t0;
    writeFileSync(join(job.runDir, "steps.json"), JSON.stringify(steps, null, 2));
    return result;
  };

  const fail = async (code: RunnerResult["error_code"], message: string) => {
    result.error_code = code;
    result.error_message = redact(message, job.secretValues).slice(0, 8000);
    return finish(false);
  };

  if (!job.storageStatePath) {
    return fail("AUTH_REQUIRED", "Environment chưa có runner auth state. Hãy tạo phiên đăng nhập cho runner trước.");
  }

  try {
    browser = await chromium.launch({
      channel: job.browser === "chromium" ? undefined : job.browser,
      headless: job.headless,
    });
    context = await browser.newContext({
      baseURL: job.baseUrl,
      storageState: job.storageStatePath,
      viewport: { width: 1366, height: 820 },
    });
    await context.tracing.start({ screenshots: true, snapshots: true });
    tracing = true;
    await context.route("**/*", (route) => {
      const req = route.request();
      if (req.resourceType() === "document" && !isUrlAllowed(req.url(), job.allowedDomains)) {
        blockedUrl = req.url();
        return route.abort("blockedbyclient");
      }
      return route.continue();
    });
    page = await context.newPage();
    page.setDefaultTimeout(job.actionTimeoutMs);
    page.setDefaultNavigationTimeout(job.navigationTimeoutMs);

    const authFailure = await verifyAuth(page, job);
    if (authFailure) return fail("AUTH_REQUIRED", `${AUTH_REQUIRED_MARKER}: runner chưa đăng nhập (${authFailure})`);
    if (job.kind === "authcheck") return finish(true);
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (blockedUrl) return fail("DOMAIN_BLOCKED", `${DOMAIN_BLOCKED_MARKER}: ${blockedUrl}`);
    return fail(/Executable doesn't exist|browserType\.launch/i.test(msg) ? "EXCEPTION" : classifyError(e as Error), msg);
  }

  let runFn: (page: Page, input: unknown) => Promise<unknown>;
  try {
    lockModules(job.compiledPath!);
    const mod = require(job.compiledPath!);
    runFn = mod.run;
    if (typeof runFn !== "function") throw new Error("Script không export hàm run(page, input)");
  } catch (e) {
    return fail("SCRIPT_INVALID", (e as Error).message);
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    const wrapped = instrument(page, "page", rec);
    await Promise.race([
      runFn(wrapped, Object.freeze({ ...job.input })),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${RUN_TIMEOUT_MARKER}: script chạy quá ${Math.round(job.timeoutMs / 1000)}s`)), job.timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    return finish(true);
  } catch (e) {
    clearTimeout(timer);
    const err = e as Error;
    if (blockedUrl) return fail("DOMAIN_BLOCKED", `${DOMAIN_BLOCKED_MARKER}: điều hướng tới domain không được phép ${blockedUrl}\n${err.message}`);
    let code = classifyError(err);
    if (code !== "AUTH_REQUIRED" && page) {
      const urlRules = job.authCheck.rules.filter((r) => r.type === "url_contains" || r.type === "url_not_contains");
      if (urlRules.length && evaluateAuthRules(urlRules, { url: page.url(), text: "", cssPresent: {} }).length > 0) {
        code = "AUTH_REQUIRED";
      }
    }
    return fail(code, `${err.name ?? "Error"}: ${err.message}`);
  }
}

process.on("message", async (job: RunnerJob) => {
  let result: RunnerResult;
  try {
    result = await execute(job);
  } catch (e) {
    result = {
      ok: false,
      error_code: "EXCEPTION",
      error_message: String((e as Error).stack ?? e),
      steps: [],
      screenshot: null,
      trace: null,
      duration_ms: 0,
      final_url: null,
    };
  }
  send({ type: "result", result });
  setTimeout(() => process.exit(0), 200);
});
