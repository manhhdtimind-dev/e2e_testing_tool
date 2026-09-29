// UI smoke test of the packaged Electron app against the demo site (no AI involved).
// A candidate is seeded directly into SQLite in place of a Training turn; everything after that
// (Trial → Chấp nhận → Testing → review → broken locator → Send to Training) goes through the UI.
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
  await page.screenshot();
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
  const setup = win.locator(".modal", { hasText: "Import test case" });
  await setup.waitFor();
  const pickFile = setup.getByRole("button", { name: "Chọn file…" });
  check(await pickFile.isDisabled(), "Import: phải nhập/chọn dự án trước khi chọn file");
  await setup.getByLabel("Tên dự án mới").fill("Demo shop");
  await pickFile.click();
  await win.getByText("Parser báo").waitFor();
  check(await win.getByText("missing_var").first().isVisible(), "Import: parser báo biến/ô thiếu");
  check(await win.getByRole("button", { name: "Xác nhận và lưu" }).isDisabled(), "Import: chặn lưu khi còn lỗi");
  check(await win.locator(".modal").getByText("Demo shop").first().isVisible(), "Import: bản parse hiện dự án đã chọn");
  await shot("01-import-preview");
  await win.locator("tr", { hasText: "TC_BAD_002" }).getByRole("button", { name: "Bỏ" }).click();
  await win.getByRole("button", { name: "Xác nhận và lưu" }).click();
  await win.locator(".list li", { hasText: "TC_CAMP_001" }).waitFor();
  check(true, "Import: lưu test case sau khi bỏ dòng lỗi");
  const projectFilter = win.getByLabel("Lọc theo dự án");
  const groupFilter = win.getByLabel("Lọc theo nhóm");
  const selectedText = (loc) => loc.evaluate((el) => el.options[el.selectedIndex].text);
  check((await selectedText(projectFilter)).startsWith("Demo shop"), "Import: danh sách chuyển sang lọc dự án vừa import");
  check((await win.locator(".list li", { hasText: "TC_CAMP_001" }).innerText()).includes("cases"), "CSV: nhóm = tên file (cases)");

  // Excel: every sheet with test_id is a group named after the sheet; test_id owned by another project is blocked.
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
  }, opened[0]);
  await win.getByRole("button", { name: "Import .xlsx / .csv" }).click();
  await setup.waitFor();
  await setup.getByLabel("Dự án", { exact: true }).selectOption("__new__");
  await setup.getByLabel("Tên dự án mới").fill("Dự án B");
  await pickFile.click();
  const parseModal = win.locator(".modal", { hasText: "Xem bản parse" });
  await parseModal.waitFor();
  check(
    (await parseModal.innerText()).includes("Tạo campaign (1)") && (await parseModal.innerText()).includes("Tìm kiếm campaign (1)"),
    "Excel: mỗi sheet là một nhóm (Tạo campaign, Tìm kiếm campaign)",
  );
  check(await parseModal.getByText('Bỏ qua sheet không có test case: "Hướng dẫn"').isVisible(), "Excel: bỏ qua sheet Hướng dẫn");
  const conflictRow = parseModal.locator("tr", { hasText: "TC_CAMP_001" });
  check((await conflictRow.locator(".badge.fail").getAttribute("title"))?.includes('đã thuộc dự án "Demo shop"'), "Excel: chặn test_id đã thuộc dự án khác");
  check(await parseModal.getByRole("button", { name: "Xác nhận và lưu" }).isDisabled(), "Excel: không lưu được khi còn test_id trùng dự án khác");
  await shot("01b-import-xlsx-groups");
  await conflictRow.getByRole("button", { name: "Bỏ" }).click();
  await parseModal.getByRole("button", { name: "Xác nhận và lưu" }).click();
  await win.locator(".list li", { hasText: "TC_CAMP_002" }).waitFor();
  check((await selectedText(projectFilter)).startsWith("Dự án B") && (await win.locator(".list li").count()) === 1, "Excel: lưu vào Dự án B, danh sách lọc theo dự án đó");

  // Filters: project + group.
  await projectFilter.selectOption({ label: "Tất cả dự án (2)" });
  check((await win.locator(".list li").count()) === 2, "Lọc: tất cả dự án hiện 2 test case");
  const groupOptions = await groupFilter.evaluate((el) => [...el.options].map((o) => o.text));
  check(groupOptions.some((t) => t.startsWith("Tìm kiếm campaign")) && groupOptions.some((t) => t.startsWith("cases")), `Lọc: danh sách nhóm theo dự án (${groupOptions.join(" | ")})`);
  await groupFilter.selectOption({ label: "Tìm kiếm campaign (1)" });
  const onlyGroup = await win.locator(".list li").allInnerTexts();
  check(onlyGroup.length === 1 && onlyGroup[0].includes("TC_CAMP_002"), "Lọc: theo nhóm chỉ còn TC_CAMP_002");
  await projectFilter.selectOption({ label: "Demo shop (1)" });
  const onlyProject = await win.locator(".list li").allInnerTexts();
  check(onlyProject.length === 1 && onlyProject[0].includes("TC_CAMP_001") && (await selectedText(groupFilter)).startsWith("Tất cả nhóm"), "Lọc: đổi dự án thì bỏ lọc nhóm, chỉ còn TC_CAMP_001");
  await win.locator(".list li", { hasText: "TC_CAMP_001" }).click();
  check((await win.locator(".panel .field", { hasText: "Nhóm" }).locator("input").inputValue()) === "cases", "Chi tiết test case hiện nhóm");
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
  const detected = await bridge("detectProfiles");
  if (detected.length) {
    const d = detected[0];
    await bridge("saveProfile", { display_name: "Smoke profile", profile_dir_name: d.profile_dir_name, browser: d.browser, extension_token: "" });
    await nav("Testing");
    await nav("Environment");
    await win.locator("table.t tr", { hasText: "Smoke profile" }).getByRole("button", { name: "Sửa" }).click();
    const picked = await win.locator(".field", { hasText: "Chọn từ profile trên máy" }).locator("select").evaluate((el) => el.options[el.selectedIndex].text);
    check(picked.includes(`(${d.profile_dir_name})`), `Sửa profile hiện đúng "Chọn từ profile trên máy" (${picked})`);
    await win.getByRole("button", { name: "Huỷ sửa" }).click();
  }
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
  check(
    (await win.getByRole("button", { name: "Chấp nhận" }).isEnabled()) && (await win.getByRole("button", { name: "Từ chối" }).isEnabled()),
    "Chấp nhận / Từ chối bấm được khi chưa chạy Trial",
  );
  check((await win.locator(".panel", { hasText: /^Trial/ }).count()) === 0, "Trên trang không còn khung Trial riêng");
  await win.getByRole("button", { name: "Chạy Trial…" }).click();
  const trialModal = win.getByRole("dialog");
  await trialModal.getByRole("button", { name: "Run Trial" }).click();
  await trialModal.getByText("Trial PASSED: script chạy hết action").waitFor({ timeout: 90_000 });
  check(true, "Trial PASSED qua modal");
  await trialModal.locator(".steps, table.t").first().waitFor();
  await trialModal.locator("img.shot").first().waitFor();
  check((await trialModal.locator("img.shot").count()) === 1, "Trial hiện đúng 1 ảnh do script chụp");
  await shot("04-training-trial-passed");
  const layout = await win.locator(".modal").evaluate((m) => {
    const body = m.querySelector(".body");
    return { bottom: m.getBoundingClientRect().bottom, vh: window.innerHeight, overflow: getComputedStyle(body).overflowY, scrollable: body.scrollHeight > body.clientHeight };
  });
  check(layout.bottom <= layout.vh && layout.overflow === "auto" && layout.scrollable, `Modal Trial nằm trong cửa sổ và cuộn được (${JSON.stringify(layout)})`);
  win.once("dialog", (d) => d.accept());
  await trialModal.getByRole("button", { name: "Xoá kết quả cũ" }).click();
  await trialModal.getByText("Trial PASSED: script chạy hết action").waitFor({ state: "detached" });
  check((await bridge("getScriptState", "TC_CAMP_001")).trials.length === 0, "Xoá kết quả Trial cũ");
  await trialModal.getByRole("button", { name: "Run Trial" }).click();
  await trialModal.getByText("Trial PASSED: script chạy hết action").waitFor({ timeout: 90_000 });
  await trialModal.getByRole("button", { name: "Đóng" }).click();
  await trialModal.waitFor({ state: "detached" });
  check(await win.locator(".badge", { hasText: "PASSED" }).first().isVisible(), "Đóng modal: khung Candidate hiện Trial gần nhất PASSED");
  await win.getByRole("button", { name: "Chấp nhận" }).click();
  await win.getByText("Version v1").first().waitFor();
  const afterAccept = await bridge("getScriptState", "TC_CAMP_001");
  check(!!afterAccept.versions[0]?.trial_id, "Chấp nhận tạo version v1, gắn Trial PASSED");
  const cleared = await bridge("clearTrials", afterAccept.candidates.find((c) => c.revision_no === 1).candidate_id);
  check(cleared.removed === 0 && cleared.kept === 1, "Xoá kết quả cũ giữ lại Trial đã gắn với version");
  await shot("05-training-approved");

  // ---------- testing: completed + review ----------
  await nav("Testing");
  await win.locator(".field", { hasText: "campaign_name" }).locator("input").fill("Summer_Sale_with_a_very_long_unbroken_campaign_name_2026");
  await win.getByRole("button", { name: "Chạy test" }).click();
  await win.locator(".expected").waitFor();
  await win.getByText("ĐÁNH GIÁ CỦA NGƯỜI DÙNG").waitFor({ timeout: 90_000 });
  check(true, "Test run COMPLETED, chờ người dùng đánh giá");
  const runList = await win.locator("ul.list.tall").evaluate((ul) => ({ scroll: ul.scrollWidth, client: ul.clientWidth }));
  check(runList.scroll <= runList.client + 1, `Danh sách Test runs không tràn ngang với input dài (${runList.scroll}/${runList.client})`);
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
  check(await win.getByRole("button", { name: "Training lại từ đầu" }).isVisible(), "Có nút Training lại từ đầu khi đã có lượt Training");
  await shot("08-send-to-training");

  // ---------- manual edit of a candidate ----------
  await win.getByRole("button", { name: "Sửa code" }).click();
  const editor = win.getByRole("textbox", { name: "Sửa code candidate" });
  await editor.fill(CANDIDATE.replace('await page.goto("/campaigns");', 'await page.goto("/campaigns");\n  await page.pause();'));
  await win.getByRole("button", { name: "Lưu thành candidate mới" }).click();
  await win.getByText("Không dùng pause()").first().waitFor();
  check((await bridge("getScriptState", "TC_CAMP_001")).candidates.length === 1, "Sửa tay: code không đạt kiểm tra thì không tạo candidate");
  await editor.fill(CANDIDATE.replace("// Step 1: Mở trang Campaign", "// Step 1: Mở trang Campaign (sửa tay)"));
  await win.getByRole("button", { name: "Lưu thành candidate mới" }).click();
  await win.getByText("Revision #2").first().waitFor();
  const edited = (await bridge("getScriptState", "TC_CAMP_001")).candidates.find((c) => c.revision_no === 2);
  check(
    edited?.status === "DRAFT" && edited.attempt_id === null && edited.source.includes("(sửa tay)") && (await win.locator(".badge", { hasText: "SỬA TAY" }).isVisible()),
    "Sửa tay: lưu thành candidate #2 DRAFT, được chọn và gắn nhãn SỬA TAY",
  );
  check(await win.getByText("Candidate #2 chưa chạy Trial").isVisible(), "Candidate chưa Trial: có gợi ý (không bắt buộc)");
  await shot("08b-manual-edit");
  await win.getByRole("button", { name: "Chạy Trial…" }).click();
  check(
    (await win.getByRole("dialog").getByText("Trial — candidate #2").isVisible()) && (await win.getByRole("dialog").getByRole("button", { name: "Run Trial" }).isEnabled()),
    "Sửa tay: modal Trial mở cho candidate mới, Run Trial được",
  );
  await win.keyboard.press("Escape");
  await win.getByRole("dialog").waitFor({ state: "detached" });
  await win.getByRole("button", { name: "Chấp nhận" }).click();
  await win.getByText("Version v2").first().waitFor();
  const v2 = (await bridge("getScriptState", "TC_CAMP_001")).versions.find((v) => v.version_no === 2);
  check(v2?.status === "APPROVED" && v2.trial_id === null, "Chấp nhận candidate chưa Trial tạo version v2 (không gắn Trial)");

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
