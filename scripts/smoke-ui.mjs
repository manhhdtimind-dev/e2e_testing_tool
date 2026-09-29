// UI smoke test of the packaged Electron app against the demo site (no AI involved).
// A candidate is seeded directly into SQLite in place of a Training turn; everything after that
// (Trial → Approve → Testing → review → broken locator → Send to Training) goes through the UI.
// Usage: npm run smoke:ui   (requires `node scripts/build.mjs` first)
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { _electron } = require("playwright");
const PORT = 4598;
const BASE = `http://localhost:${PORT}`;
const out = join(root, ".e2e-data", "smoke");
const dataDir = join(out, "data");
const shots = join(out, "shots");
rmSync(out, { recursive: true, force: true });
mkdirSync(shots, { recursive: true });

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

const CSV = `test_id,title,steps,input,expected_result
TC_CAMP_001,Tạo campaign mới,"1. Mở trang Campaign
2. Click Create Campaign
3. Nhập Campaign Name = {{campaign_name}}
4. Chọn Objective = {{objective}}
5. Click Save","campaign_name: Summer Sale
objective: Sales",Campaign mới xuất hiện trong danh sách với đúng Objective
TC_BAD_002,Dòng thiếu dữ liệu,"Nhập {{missing_var}}",,
`;
const csvPath = join(out, "cases.csv");
writeFileSync(csvPath, CSV, "utf8");

let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

const demo = spawn(process.execPath, [join(root, "demo-site/server.mjs")], { env: { ...process.env, DEMO_PORT: String(PORT), DEMO_AUTOLOGIN: "1" }, stdio: "pipe" });
await new Promise((r) => demo.stdout.once("data", r));

const app = await _electron.launch({ executablePath: require("electron"), args: [root], env: { ...process.env, E2E_DATA_DIR: dataDir } });
const errors = [];
try {
  const win = await app.firstWindow();
  win.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  win.on("pageerror", (e) => errors.push(String(e)));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
  const shot = (name) => win.screenshot({ path: join(shots, `${name}.png`) });
  const nav = (label) => win.locator(".topnav button", { hasText: label }).click();
  const bridge = (method, ...args) =>
    win.evaluate(async ([m, a]) => {
      const r = await window.bridge.call(m, a);
      if (!r.ok) throw new Error(r.error);
      return r.data;
    }, [method, args]);

  // ---------- sample template ----------
  await app.evaluate(({ shell }) => {
    globalThis.__opened = [];
    shell.openPath = async (p) => (globalThis.__opened.push(p), "");
  });
  await win.getByRole("button", { name: "Mở file mẫu" }).first().click();
  await win.waitForTimeout(1500);
  const opened = await app.evaluate(() => globalThis.__opened);
  check(opened.length === 1 && opened[0].endsWith("test-cases-mau.xlsx") && existsSync(opened[0]), `Mở file mẫu tạo ${opened[0] ?? "(không có)"}`);

  // ---------- import ----------
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
  }, csvPath);
  await win.getByRole("button", { name: "Import .xlsx / .csv" }).click();
  await win.getByText("Parser báo").waitFor();
  check(await win.getByText("missing_var").first().isVisible(), "Import: parser báo biến/ô thiếu");
  check(await win.getByRole("button", { name: "Xác nhận và lưu" }).isDisabled(), "Import: chặn lưu khi còn lỗi");
  await shot("01-import-preview");
  await win.locator("tr", { hasText: "TC_BAD_002" }).getByRole("button").nth(1).click();
  await win.getByRole("button", { name: "Xác nhận và lưu" }).click();
  await win.locator(".list li", { hasText: "TC_CAMP_001" }).waitFor();
  check(true, "Import: lưu test case sau khi bỏ dòng lỗi");
  await shot("02-test-cases");

  // ---------- environment + runner auth ----------
  const envInput = {
    name: "Demo local",
    base_url: `${BASE}/__admin/autologin`,
    allowed_domains: [],
    secret_fields: [],
  };
  const env = await bridge("saveEnvironment", envInput);
  const { session_id } = await bridge("beginRunnerLogin", env.environment_id);
  await new Promise((r) => setTimeout(r, 2500));
  await bridge("finishRunnerLogin", session_id);
  await bridge("saveEnvironment", { ...envInput, environment_id: env.environment_id, base_url: BASE });
  await nav("Environment");
  await win.getByText("Demo local").first().waitFor();
  check((await win.getByText("Kiểm tra đăng nhập").count()) === 0, "Environment không còn phần auth_check");
  await shot("03-environment");

  // ---------- seed a candidate as a Training turn would ----------
  const db = new DatabaseSync(join(dataDir, "e2e.sqlite"));
  const ts = new Date().toISOString();
  const scriptId = `scr_${randomUUID().slice(0, 8)}`;
  const attemptId = `att_${randomUUID().slice(0, 8)}`;
  db.prepare("INSERT INTO scripts (script_id, test_id, active_agent, training_thread_id, created_at) VALUES (?, ?, 'codex', NULL, ?)").run(scriptId, "TC_CAMP_001", ts);
  db.prepare(
    "INSERT INTO training_attempts (attempt_id, script_id, thread_id, agent, browser_profile_id, environment_id, kind, prompt, context_ref, sample_input, status, preflight_status, candidate_id, action_count, artifacts, created_at, started_at, finished_at) VALUES (?, ?, NULL, 'codex', 'seed', ?, 'initial', '', NULL, ?, 'COMPLETED', 'CONNECTED', ?, 6, '{}', ?, ?, ?)",
  ).run(attemptId, scriptId, env.environment_id, JSON.stringify({ campaign_name: "Summer Sale", objective: "Sales" }), `cand_${attemptId}`, ts, ts, ts);
  db.prepare("INSERT INTO candidates (candidate_id, script_id, revision_no, source, source_hash, attempt_id, status, created_at) VALUES (?, ?, 1, ?, ?, ?, 'DRAFT', ?)").run(
    `cand_${attemptId}`,
    scriptId,
    CANDIDATE,
    createHash("sha256").update(CANDIDATE, "utf8").digest("hex"),
    attemptId,
    ts,
  );
  db.close();

  // ---------- training page: trial + approve ----------
  await nav("Training");
  await win.getByText("Revision #1").first().waitFor();
  check(await win.getByRole("button", { name: "Approve" }).isDisabled(), "Approve bị khoá khi chưa có trial PASSED");
  await win.getByRole("button", { name: "Run Trial" }).click();
  await win.getByText("Trial PASSED: script chạy hết action").waitFor({ timeout: 90_000 });
  check(true, "Trial PASSED qua UI");
  await win.locator(".steps, table.t").first().waitFor();
  await shot("04-training-trial-passed");
  await win.getByRole("button", { name: "Approve" }).click();
  await win.getByText("Version v1").first().waitFor();
  check(true, "Approve tạo version v1");
  await shot("05-training-approved");

  // ---------- testing: completed + review ----------
  await nav("Testing");
  await win.getByRole("button", { name: "Chạy test" }).click();
  await win.locator(".expected").waitFor();
  await win.getByText("ĐÁNH GIÁ CỦA NGƯỜI DÙNG").waitFor({ timeout: 90_000 });
  check(true, "Test run COMPLETED, chờ người dùng đánh giá");
  await shot("06-testing-completed");
  await win.getByRole("button", { name: "PASS", exact: true }).click();
  await win.locator(".panel .badge.pass", { hasText: /^PASS$/ }).first().waitFor();
  check(true, "Đánh giá PASS được lưu");

  // ---------- broken locator ----------
  await fetch(`${BASE}/__admin/break?on=1`, { method: "POST" });
  await win.getByRole("button", { name: "Chạy test" }).click();
  await win.getByText("đã được đánh dấu SUSPECTED_BROKEN").waitFor({ timeout: 90_000 });
  check(await win.locator(".badge.fail", { hasText: "LOCATOR" }).first().isVisible(), "Locator hỏng → ERROR LOCATOR");
  const state = await bridge("getScriptState", "TC_CAMP_001");
  check(state.versions[0]?.status === "SUSPECTED_BROKEN", "Version v1 chuyển SUSPECTED_BROKEN");
  check(await win.getByRole("button", { name: "Chạy test" }).isDisabled(), "Không chạy được version không còn APPROVED");
  await shot("07-testing-locator-error");
  await win.getByRole("button", { name: "Send to Training" }).click();
  await win.getByText("Ngữ cảnh gửi kèm").waitFor();
  check(true, "Send to Training mở Training với ngữ cảnh test run");
  await shot("08-send-to-training");

  // ---------- history + settings ----------
  await nav("History");
  await win.locator("table.t tbody tr").first().waitFor();
  check((await win.locator("table.t tbody tr").count()) === 2, "History hiển thị 2 test run");
  await win.locator("table.t tbody tr").first().click();
  await shot("09-history");
  await win.getByRole("tab", { name: "Audit log" }).click();
  await win.getByText("candidate.approve").first().waitFor();
  await shot("10-audit");
  await nav("Cài đặt");
  await win.getByText("Kiểm tra tích hợp agent").waitFor();
  await shot("11-settings");
} catch (e) {
  failures++;
  console.error("FAIL ", e);
  const w = await app.firstWindow().catch(() => null);
  await w?.screenshot({ path: join(shots, "zz-failure.png") }).catch(() => undefined);
} finally {
  check(errors.length === 0, `Không có lỗi console/renderer${errors.length ? `: ${errors.join(" | ")}` : ""}`);
  await app.close().catch(() => undefined);
  demo.kill();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll UI smoke checks passed");
console.log(`Screenshots: ${shots}`);
process.exit(failures ? 1 : 0);
