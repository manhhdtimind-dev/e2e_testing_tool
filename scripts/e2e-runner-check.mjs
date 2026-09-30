// End-to-end check of the Trial/Testing runner against the demo site (no AI involved).
// Usage: npm run e2e:runner
import { fork, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
  await page.screenshot();
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
  const compile = (src) => ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;

  async function runJob(name, input, { withAuth = true, fsRestricted = true, keepOpen = false, onChild, source = CANDIDATE, headless = true, slowMoMs = 0 } = {}) {
    const runDir = join(work, name);
    mkdirSync(runDir, { recursive: true });
    const compiledPath = join(runDir, "script.cjs");
    writeFileSync(compiledPath, compile(source));
    let statePath = null;
    if (withAuth) {
      statePath = join(runDir, ".auth-state.json");
      writeFileSync(statePath, storageState);
    }
    const job = {
      runDir,
      compiledPath,
      input,
      secretValues: [],
      baseUrl: BASE,
      allowedDomains: ["localhost"],
      storageStatePath: statePath,
      browser,
      headless,
      timeoutMs: 60000,
      actionTimeoutMs: 5000,
      navigationTimeoutMs: 15000,
      traceOnSuccess: false,
      keepOpen,
      slowMoMs,
    };
    const execArgv = fsRestricted
      ? ["--permission", "--allow-fs-read=*", `--allow-fs-write=${runDir}`, `--allow-fs-write=${tmpdir()}`, "--allow-child-process", "--disable-warning=SecurityWarning"]
      : [];
    return await new Promise((resolveRun) => {
      const child = fork(join(root, "dist/runner/runner.cjs"), [], { execArgv, stdio: ["ignore", "inherit", "inherit", "ipc"] });
      onChild?.(child);
      child.on("message", (m) => m.type === "result" && resolveRun({ ...m.result, runDir }));
      child.send(job);
    });
  }

  const r1 = await runJob("trial", { campaign_name: "Summer Sale 2026", objective: "Sales" });
  check(r1.ok, `Trial PASSED (${r1.error_code ?? ""} ${r1.error_message ?? ""})`);
  check(r1.steps.length >= 5, `step log recorded (${r1.steps.length} steps)`);
  check(r1.screenshots.length === 1 && dirname(r1.screenshots[0]) === r1.runDir && existsSync(r1.screenshots[0]), "screenshot taken by the script is saved in the run dir");
  check(r1.steps.at(-1)?.action === "screenshot", "script screenshot recorded as a step");

  const noShot = await runJob("no-screenshot", { campaign_name: "No Shot", objective: "Sales" }, { source: CANDIDATE.replace("  await page.screenshot();\n", "") });
  check(noShot.ok && noShot.screenshots.length === 0 && !readdirSync(noShot.runDir).some((f) => f.endsWith(".png")), "runner takes no screenshot of its own");

  const ownPath = await runJob("own-path", { campaign_name: "Own Path", objective: "Sales" }, { source: CANDIDATE.replace("await page.screenshot();", 'await page.screenshot({ path: "../outside.png", fullPage: true });') });
  check(ownPath.ok && ownPath.screenshots.length === 1 && dirname(ownPath.screenshots[0]) === ownPath.runDir && !existsSync(join(work, "outside.png")), "a path given by the script is redirected into the run dir");

  const tallSource = CANDIDATE.replace(
    "  await page.screenshot();\n",
    '  await page.evaluate(() => { document.body.style.minHeight = "3000px"; });\n  await page.screenshot({ clip: { x: 0, y: 0, width: 200, height: 100 } });\n',
  );
  const tall = await runJob("full-page", { campaign_name: "Full Page", objective: "Sales" }, { source: tallSource });
  const pngHeight = tall.screenshots[0] && existsSync(tall.screenshots[0]) ? readFileSync(tall.screenshots[0]).readUInt32BE(20) : 0;
  check(tall.ok && pngHeight >= 3000, `page screenshot covers the whole page top to bottom (height ${pngHeight}px, viewport 820px)`);

  let held;
  const rk = await runJob("keep-open", { campaign_name: "Keep Open", objective: "Sales" }, { keepOpen: true, onChild: (c) => (held = c) });
  const exited = new Promise((r) => held.once("exit", () => r(true)));
  const stillAlive = await Promise.race([exited.then(() => false), new Promise((r) => setTimeout(() => r(true), 2000))]);
  check(rk.ok && stillAlive, "keepOpen: result reported while the browser stays open");
  held.disconnect();
  check(await Promise.race([exited, new Promise((r) => setTimeout(() => r(false), 10000))]), "keepOpen: runner closes the browser and exits when the app disconnects");

  let closer;
  const closeSource = CANDIDATE.replace("  await page.screenshot();\n", "  await page.screenshot();\n  await page.close();\n");
  const rc = await runJob("script-closes", { campaign_name: "Closed By Script", objective: "Sales" }, { keepOpen: true, source: closeSource, onChild: (c) => (closer = c) });
  const closerExited = await Promise.race([new Promise((r) => (closer.exitCode !== null ? r(true) : closer.once("exit", () => r(true)))), new Promise((r) => setTimeout(() => r(false), 5000))]);
  check(rc.ok && rc.steps.at(-1)?.action === "close" && rc.screenshots.length === 1 && closerExited, "script page.close(): run passes, close is the last step and the runner exits without waiting");

  const slow = await runJob("slow-mo", { campaign_name: "Slow Motion", objective: "Sales" }, { headless: false, slowMoMs: 400 });
  const fastRun = await runJob("fast-headed", { campaign_name: "Full Speed", objective: "Sales" }, { headless: false, slowMoMs: 0 });
  check(slow.ok && fastRun.ok && slow.duration_ms - fastRun.duration_ms >= 4 * 400, `headed slowMo paces actions (${fastRun.duration_ms} ms → ${slow.duration_ms} ms with 400 ms)`);

  const r2 = await runJob("test-input-2", { campaign_name: "Black Friday", objective: "Traffic" });
  check(r2.ok, "Testing with second input COMPLETED");
  const html = await (await fetch(`${BASE}/campaigns`, { headers: { cookie: JSON.parse(storageState).cookies.map((c) => `${c.name}=${c.value}`).join("; ") } })).text();
  check(html.includes("Summer Sale 2026") && html.includes("Black Friday"), "both campaigns created with different inputs");

  // File input: the app passes the absolute path of a project fixture (stored outside the run dir).
  const fixtureDir = join(work, "fixtures", "prj_check");
  mkdirSync(fixtureDir, { recursive: true });
  const fixture = join(fixtureDir, "banner-check.png");
  writeFileSync(fixture, Buffer.alloc(1234, 7));
  const UPLOAD = `import { expect, type Page } from "@playwright/test";

export async function run(page: Page, input: { banner: string }) {
  // Step 1: Mở trang Upload asset
  await page.goto("/assets/upload");
  // Step 2: Chọn file banner
  await page.getByLabel("Banner file").setInputFiles(input.banner);
  // Step 3: Click Upload
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(page.getByRole("heading", { name: "Assets" })).toBeVisible();
  await expect(page.getByRole("cell", { name: input.banner.split(/[\\\\/]/).pop()! })).toBeVisible();
  await page.screenshot();
}
`;
  const up = await runJob("upload", { banner: fixture }, { source: UPLOAD });
  check(up.ok, `upload via setInputFiles(input.banner) PASSED (${up.error_code ?? ""} ${(up.error_message ?? "").split("\n")[0]})`);
  check(up.steps.some((s) => s.action === "setInputFiles"), "setInputFiles recorded in the step log");
  const assetsHtml = await (await fetch(`${BASE}/assets`, { headers: { cookie: JSON.parse(storageState).cookies.map((c) => `${c.name}=${c.value}`).join("; ") } })).text();
  check(assetsHtml.includes("banner-check.png") && assetsHtml.includes("1234 bytes"), "demo site received the fixture file with its full content");
  const upMissing = await runJob("upload-missing", { banner: join(fixtureDir, "missing.png") }, { source: UPLOAD });
  check(!upMissing.ok, `missing upload file fails the run (${upMissing.error_code})`);

  const r3 = await runJob("no-auth", { campaign_name: "X", objective: "Sales" }, { withAuth: false });
  check(!r3.ok && r3.error_code === "AUTH_REQUIRED" && r3.steps.length === 0, `missing runner auth -> AUTH_REQUIRED before first action (${r3.error_code})`);

  await fetch(`${BASE}/__admin/break?on=1`, { method: "POST" });
  const r4 = await runJob("broken", { campaign_name: "Y", objective: "Sales" });
  check(!r4.ok && r4.error_code === "LOCATOR", `renamed button -> LOCATOR error (${r4.error_code}: ${(r4.error_message ?? "").split("\n")[0]})`);
  check(!!r4.trace, "trace saved on failure");
  check(r4.screenshots.length === 0, "no screenshot when the script fails before capturing");
  const steps = JSON.parse(readFileSync(join(r4.runDir, "steps.json"), "utf8"));
  check(steps.some((s) => !s.ok), "failing step marked in step log");
} finally {
  demo.kill();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll runner checks passed");
process.exit(failures ? 1 : 0);
