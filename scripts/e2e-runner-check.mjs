// End-to-end check of the Trial/Testing runner against the demo site (no AI involved).
// Usage: npm run e2e:runner
import { fork, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");
const { chromium } = require("playwright");
const PORT = 4599;
const BASE = `http://localhost:${PORT}`;
const browser = process.env.E2E_BROWSER ?? "chrome";

const CANDIDATE = `import { expect, type Page } from "@playwright/test";

export async function run(page: Page, input: { campaign_name: string; objective: string }) {
  // Step 1: Mở trang Campaign
  await page.goto("/campaigns");
  // Step 2: Click Create Campaign
  await page.getByRole("button", { name: "Create Campaign" }).click();
  // Step 3: Nhập Campaign Name
  await page.getByLabel("Campaign Name").fill(input.campaign_name);
  // Step 4: Chọn Objective
  await page.getByLabel("Objective").selectOption(input.objective);
  // Step 5: Click Save
  await page.getByRole("button", { name: "Save" }).click({ timeout: 3000 });
  await expect(page.getByRole("heading", { name: "Campaign List" })).toBeVisible();
}
`;

const demo = spawn(process.execPath, [join(root, "demo-site/server.mjs")], { env: { ...process.env, DEMO_PORT: String(PORT) }, stdio: "pipe" });
await new Promise((r) => demo.stdout.once("data", r));

let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

try {
  // Separate runner auth state created by a dedicated login session.
  const b = await chromium.launch({ channel: browser === "chromium" ? undefined : browser });
  const ctx = await b.newContext();
  const p = await ctx.newPage();
  await p.goto(`${BASE}/login`);
  await p.getByLabel("Username").fill("demo");
  await p.getByLabel("Password").fill("demo123");
  await p.getByRole("button", { name: "Sign in" }).click();
  await p.waitForURL("**/campaigns");
  const storageState = JSON.stringify(await ctx.storageState());
  await b.close();

  const work = mkdtempSync(join(tmpdir(), "e2e-runner-check-"));
  const compiled = ts.transpileModule(CANDIDATE, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;

  async function runJob(name, input, { withAuth = true, fsRestricted = true } = {}) {
    const runDir = join(work, name);
    mkdirSync(runDir, { recursive: true });
    const compiledPath = join(runDir, "script.cjs");
    writeFileSync(compiledPath, compiled);
    let statePath = null;
    if (withAuth) {
      statePath = join(runDir, ".auth-state.json");
      writeFileSync(statePath, storageState);
    }
    const job = {
      kind: "script",
      runDir,
      compiledPath,
      input,
      secretValues: [],
      baseUrl: BASE,
      allowedDomains: ["localhost"],
      authCheck: { check_url: "/campaigns", rules: [{ type: "url_not_contains", value: "/login" }, { type: "text_present", value: "Xin chào" }] },
      storageStatePath: statePath,
      browser,
      headless: true,
      timeoutMs: 60000,
      actionTimeoutMs: 5000,
      navigationTimeoutMs: 15000,
      traceOnSuccess: false,
    };
    const execArgv = fsRestricted
      ? ["--permission", "--allow-fs-read=*", `--allow-fs-write=${runDir}`, `--allow-fs-write=${tmpdir()}`, "--allow-child-process", "--disable-warning=SecurityWarning"]
      : [];
    return await new Promise((resolveRun) => {
      const child = fork(join(root, "dist/runner/runner.cjs"), [], { execArgv, stdio: ["ignore", "inherit", "inherit", "ipc"] });
      child.on("message", (m) => m.type === "result" && resolveRun({ ...m.result, runDir }));
      child.send(job);
    });
  }

  const r1 = await runJob("trial", { campaign_name: "Summer Sale 2026", objective: "Sales" });
  check(r1.ok, `Trial PASSED (${r1.error_code ?? ""} ${r1.error_message ?? ""})`);
  check(r1.steps.length >= 5, `step log recorded (${r1.steps.length} steps)`);
  check(!!r1.screenshot, "final screenshot saved");

  const r2 = await runJob("test-input-2", { campaign_name: "Black Friday", objective: "Traffic" });
  check(r2.ok, "Testing with second input COMPLETED");
  const html = await (await fetch(`${BASE}/campaigns`, { headers: { cookie: JSON.parse(storageState).cookies.map((c) => `${c.name}=${c.value}`).join("; ") } })).text();
  check(html.includes("Summer Sale 2026") && html.includes("Black Friday"), "both campaigns created with different inputs");

  const r3 = await runJob("no-auth", { campaign_name: "X", objective: "Sales" }, { withAuth: false });
  check(!r3.ok && r3.error_code === "AUTH_REQUIRED" && r3.steps.length === 0, `missing runner auth -> AUTH_REQUIRED before first action (${r3.error_code})`);

  await fetch(`${BASE}/__admin/break?on=1`, { method: "POST" });
  const r4 = await runJob("broken", { campaign_name: "Y", objective: "Sales" });
  check(!r4.ok && r4.error_code === "LOCATOR", `renamed button -> LOCATOR error (${r4.error_code}: ${(r4.error_message ?? "").split("\n")[0]})`);
  check(!!r4.trace, "trace saved on failure");
  const steps = JSON.parse(readFileSync(join(r4.runDir, "steps.json"), "utf8"));
  check(steps.some((s) => !s.ok), "failing step marked in step log");
} finally {
  demo.kill();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll runner checks passed");
process.exit(failures ? 1 : 0);
