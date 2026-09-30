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
const { _electron, chromium } = require("playwright");
const PORT = 4598;
const RECORDING_CDP_PORT = 9339;
const BASE = `http://localhost:${PORT}`;
const out = join(root, ".e2e-data", "smoke");
const dataDir = join(out, "data");
const shots = join(out, "shots");
rmSync(out, { recursive: true, force: true });
mkdirSync(shots, { recursive: true });

const OTHER_CANDIDATE = `import type { Page } from "@playwright/test";

export async function run(page: Page, input: Record<string, string>): Promise<void> {
  await page.goto("/campaigns?seed=TC_CAMP_002");
}
`;

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
  // Step 5: Chụp màn hình form
  await page.screenshot();
  // Step 6: Click Save
  await page.getByRole("button", { name: "Save" }).click({ timeout: 3000 });
  await expect(page.getByRole("heading", { name: "Campaign List" })).toBeVisible();
  // Step 7: Chụp màn hình danh sách campaign
  await page.screenshot();
}
`;

const CSV = `test_id,title,steps,input,expected_result
TC_CAMP_001,Tạo campaign mới,"1. Mở trang Campaign
2. Click Create Campaign
3. Nhập Campaign Name = {{campaign_name}}
4. Chọn Objective = {{objective}}
5. Chụp màn hình form
6. Click Save
7. Chụp màn hình danh sách campaign","campaign_name: Summer Sale
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

const app = await _electron.launch({ executablePath: require("electron"), args: [root], env: { ...process.env, E2E_DATA_DIR: dataDir, E2E_RECORDING_CDP_PORT: String(RECORDING_CDP_PORT) } });
const errors = [];
try {
  const win = await app.firstWindow();
  win.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  win.on("pageerror", (e) => errors.push(String(e)));
  win.on("dialog", (d) => {
    errors.push(`Hộp thoại gốc của trình duyệt (làm mất focus cửa sổ Electron): ${d.message()}`);
    void d.dismiss();
  });
  const confirmBox = win.locator(".modal.small[role=dialog]");
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
  const otherScriptId = `scr_${randomUUID().slice(0, 8)}`;
  db.prepare("INSERT INTO scripts (script_id, test_id, active_agent, training_thread_id, created_at) VALUES (?, ?, 'codex', NULL, ?)").run(otherScriptId, "TC_CAMP_002", ts);
  db.prepare("INSERT INTO candidates (candidate_id, script_id, revision_no, source, source_hash, attempt_id, status, origin, created_at) VALUES (?, ?, 1, ?, ?, NULL, 'DRAFT', 'manual', ?)").run(
    `cand_${otherScriptId}`,
    otherScriptId,
    OTHER_CANDIDATE,
    createHash("sha256").update(OTHER_CANDIDATE, "utf8").digest("hex"),
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
  const trialModal = win.getByRole("dialog").filter({ hasText: "Trial — candidate" });
  await trialModal.getByRole("button", { name: "Run Trial" }).click();
  await trialModal.getByText("Trial PASSED: script chạy hết action").waitFor({ timeout: 90_000 });
  check(true, "Trial PASSED qua modal");
  await trialModal.locator(".steps, table.t").first().waitFor();
  const slides = trialModal.locator(".slides");
  await slides.locator("img.shot").waitFor();
  check(
    (await slides.locator("img.shot").count()) === 1 && (await slides.locator(".slide-thumbs button").count()) === 2 && (await slides.locator(".slide-count").innerText()) === "1/2",
    "Trial hiện 2 ảnh dạng slide: một ảnh lớn, 2 ảnh nhỏ, bộ đếm 1/2",
  );
  check(await slides.getByRole("button", { name: "Ảnh trước" }).isDisabled(), "Slide: nút Ảnh trước bị khoá ở ảnh đầu");
  const firstSrc = await slides.locator("img.shot").getAttribute("src");
  await slides.getByRole("button", { name: "Ảnh sau" }).click();
  check(
    (await slides.locator(".slide-count").innerText()) === "2/2" && (await slides.locator("img.shot").getAttribute("src")) !== firstSrc,
    "Slide: bấm Ảnh sau chuyển sang ảnh 2/2",
  );
  await shot("04-training-trial-passed");
  await slides.locator("img.shot").click();
  const zoomed = win.locator(".overlay img.full");
  await zoomed.waitFor();
  const zoomStyle = await zoomed.evaluate((img) => ({ overflow: getComputedStyle(img.parentElement).overflowY, maxHeight: getComputedStyle(img).maxHeight }));
  check(zoomStyle.overflow === "auto" && zoomStyle.maxHeight === "none", `Ảnh phóng to vừa chiều rộng, ảnh cả trang cuộn dọc được (${JSON.stringify(zoomStyle)})`);
  await win.keyboard.press("ArrowLeft");
  check((await win.locator(".slide-count.big").innerText()) === "1/2", "Slide phóng to: phím ← về ảnh 1/2");
  await shot("04b-trial-slide-zoom");
  await win.keyboard.press("Escape");
  await zoomed.waitFor({ state: "detached" });
  check(await trialModal.isVisible(), "Esc đóng ảnh phóng to, modal Trial vẫn mở");
  const layout = await win.locator(".modal").evaluate((m) => {
    const body = m.querySelector(".body");
    return { bottom: m.getBoundingClientRect().bottom, vh: window.innerHeight, overflow: getComputedStyle(body).overflowY, scrollable: body.scrollHeight > body.clientHeight };
  });
  check(layout.bottom <= layout.vh && layout.overflow === "auto" && layout.scrollable, `Modal Trial nằm trong cửa sổ và cuộn được (${JSON.stringify(layout)})`);
  await trialModal.getByRole("button", { name: "Xoá kết quả cũ" }).click();
  await confirmBox.waitFor();
  await win.keyboard.press("Escape");
  await confirmBox.waitFor({ state: "detached" });
  check(
    (await trialModal.isVisible()) && (await trialModal.getByText("Trial PASSED: script chạy hết action").isVisible()),
    "Hộp xác nhận trong app: Esc chỉ huỷ xác nhận, modal Trial vẫn mở, chưa xoá gì",
  );
  await trialModal.getByRole("button", { name: "Xoá kết quả cũ" }).click();
  await confirmBox.getByRole("button", { name: "Xoá", exact: true }).click();
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
  const runSlides = win.locator(".panel", { hasText: "Evidence" }).locator(".slides");
  await runSlides.locator("img.shot").waitFor();
  check((await runSlides.locator(".slide-count").innerText()) === "1/2" && (await runSlides.locator(".slide-thumbs button").count()) === 2, "Testing: evidence hiện dạng slide 1/2");
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

  // ---------- record the steps (Playwright recorder, no AI) ----------
  await fetch(`${BASE}/__admin/break?on=0`, { method: "POST" });
  await win.getByRole("button", { name: "Ghi thao tác…" }).click();
  const recModal = win.locator(".modal", { hasText: "Ghi thao tác — TC_CAMP_001" });
  await recModal.waitFor();
  await recModal.locator(".field", { hasText: "campaign_name" }).locator("input").fill("Rec Campaign 01");
  await recModal.locator(".field", { hasText: "objective" }).locator("input").fill("Traffic");
  await recModal.getByRole("button", { name: "Bắt đầu ghi" }).click();
  const banner = win.locator(".rec-banner");
  await banner.getByText("Đang ghi thao tác cho TC_CAMP_001").waitFor({ timeout: 30_000 });
  check((await banner.innerText()).includes("Bước 1/7"), "Ghi thao tác: mở Chrome, trang Training hiện đang ghi ở bước 1/7");
  check(await win.getByRole("button", { name: "Gửi prompt" }).isDisabled(), "Ghi thao tác: không gửi prompt Training được trong lúc ghi");
  const recBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${RECORDING_CDP_PORT}`);
  try {
    const rp = recBrowser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith(BASE));
    await rp.locator("e2e-rec-bar").waitFor({ state: "attached" });
    const bar = async (button) => {
      await rp.waitForFunction(() => document.querySelector("e2e-rec-bar")?.__e2eRects);
      const r = await rp.evaluate((b) => document.querySelector("e2e-rec-bar").__e2eRects()[b], button);
      await rp.mouse.click(r.x, r.y);
      if (button !== "stop") await rp.waitForTimeout(250);
    };
    await bar("next");
    await rp.getByRole("button", { name: "Create Campaign" }).click();
    await rp.waitForURL(/\/campaigns\/new$/);
    await bar("next");
    await rp.getByLabel("Campaign Name").click();
    await rp.getByLabel("Campaign Name").fill("Rec Campaign 01");
    await bar("next");
    await rp.getByLabel("Objective").selectOption("Traffic");
    await rp.locator(".form-item", { hasText: "Owner" }).getByRole("combobox").click();
    await rp.getByRole("option", { name: "Bob" }).click();
    for (const choice of ["EU", "Search", "Gold"]) {
      const widget = rp.locator(".dselect__wrapper", { has: rp.locator(".dselect__placeholder", { hasText: /^Select$/ }) }).first();
      await widget.hover();
      await widget.locator(".dselect__selection").click();
      await rp.getByRole("option", { name: choice }).click();
    }
    await bar("next");
    await bar("shot");
    check((await banner.innerText()).includes("Bước 6/7"), "Thanh nổi: 📷 ở bước Chụp màn hình tự chuyển sang bước sau");
    await rp.getByRole("button", { name: "Save" }).click();
    await rp.waitForURL(/\/campaigns$/);
    await bar("next");
    await bar("shot");
    await shot("13a-recording-banner");
    await rp.screenshot({ path: join(shots, "13a-recording-toolbar.png") });
    const pwTools = await rp.evaluate(() => ({
      glass: document.querySelectorAll("x-pw-glass").length,
      top: document.elementFromPoint(innerWidth / 2, 12)?.tagName,
    }));
    check(pwTools.glass > 0 && pwTools.top !== "X-PW-GLASS", `Thanh công cụ riêng của Playwright recorder bị ẩn, không bấm được (${JSON.stringify(pwTools)})`);
    await bar("stop");
  } finally {
    await recBrowser.close().catch(() => undefined);
  }
  await win.locator(".badge", { hasText: "GHI THAO TÁC" }).waitFor({ timeout: 30_000 });
  await confirmBox.getByText("Input lúc ghi khác input mẫu của TC_CAMP_001").waitFor({ timeout: 10_000 });
  const sampleAsk = await confirmBox.innerText();
  check(
    sampleAsk.includes('campaign_name: "Summer Sale" → "Rec Campaign 01"') && sampleAsk.includes('objective: "Sales" → "Traffic"'),
    `Ghi thao tác xong: hỏi thay input mẫu bằng giá trị vừa dùng khi ghi:\n${sampleAsk}`,
  );
  await shot("13c-recording-sample-update");
  await confirmBox.getByRole("button", { name: "Cập nhật input mẫu" }).click();
  await confirmBox.waitFor({ state: "detached" });
  await win.getByText("Đã cập nhật input mẫu của test case").waitFor();
  const updatedCase = (await bridge("listTestCases")).find((c) => c.test_id === "TC_CAMP_001");
  check(
    updatedCase.sample_input.campaign_name === "Rec Campaign 01" && updatedCase.sample_input.objective === "Traffic",
    `Bấm Cập nhật input mẫu: test case lưu giá trị vừa ghi (${JSON.stringify(updatedCase.sample_input)})`,
  );
  const recSession = await bridge("getRecordingState");
  check(recSession.status === "SAVED" && recSession.action_count === 14 && recSession.shot_count === 2, `Ghi thao tác: đếm 14 thao tác trên trang, 2 ảnh, không tính click thanh nổi (${recSession.action_count}/${recSession.shot_count})`);
  const recorded = (await bridge("getScriptState", "TC_CAMP_001")).candidates[0];
  check(recorded.origin === "recorded" && recorded.revision_no === 3 && recorded.attempt_id === null, "Ghi thao tác: tạo candidate #3 có nhãn GHI THAO TÁC");
  check(
    recorded.source.includes(".fill(input.campaign_name)") &&
      recorded.source.includes(".selectOption(input.objective)") &&
      !recorded.source.includes("Rec Campaign") &&
      !recorded.source.includes("Traffic") &&
      (recorded.source.match(/await page\.screenshot\(\{ fullPage: true \}\);/g) ?? []).length === 2 &&
      recorded.source.includes("// Step 5: Chụp màn hình form") &&
      recorded.source.includes("await page.waitForURL(/\\/campaigns(?:[?#]|$)/);\n  await page.screenshot({ fullPage: true });\n}") &&
      !recorded.source.includes("e2e-rec-bar"),
    `Ghi thao tác: script dùng input.*, có 2 lệnh chụp và chú thích theo bước:\n${recorded.source}`,
  );
  check(!recorded.warnings.some((w) => w.startsWith("LỖI")), `Ghi thao tác: script đạt kiểm tra (${recorded.warnings.join(" | ") || "không cảnh báo"})`);
  check(
    !recorded.source.includes("el-id-") &&
      recorded.source.includes(".locator('.form-item').filter({ has: page.getByText('Owner', { exact: true }) }).getByRole('combobox').click();") &&
      !recorded.warnings.some((w) => w.includes("dễ hỏng")),
    `Ghi thao tác: ô chọn có id tự sinh (#el-id-…) được thay bằng locator theo label "Owner":\n${recorded.source}`,
  );
  const widgetClick = (label) => `.locator('.form-item__content').filter({ has: page.getByText('${label}', { exact: true }) }).locator('.dselect').click();`;
  check(
    recorded.source.includes(widgetClick("Region")) && recorded.source.includes(widgetClick("Channel")) && !recorded.source.includes("nth=") && !recorded.source.includes(".first()"),
    `Ghi thao tác: placeholder "Select" theo vị trí được thay bằng locator riêng của từng ô (Region, Channel), click vào gốc widget:\n${recorded.source}`,
  );
  check(!(await win.locator(".rec-banner").count()), "Ghi thao tác: kết thúc thì ẩn thanh trạng thái đang ghi");
  await shot("13b-recorded-candidate");
  await win.getByRole("button", { name: "Chạy Trial…" }).click();
  const recTrial = win.getByRole("dialog");
  await recTrial.locator(".field", { hasText: "campaign_name" }).locator("input").fill("Rec Trial 02");
  await recTrial.getByRole("button", { name: "Run Trial" }).click();
  await recTrial.getByText("Trial PASSED: script chạy hết action").waitFor({ timeout: 90_000 });
  await recTrial.locator(".slides img.shot").waitFor();
  check((await recTrial.locator(".slide-count").innerText()) === "1/2", "Trial candidate ghi thao tác PASSED với input khác, có 2 ảnh");
  await win.keyboard.press("Escape");
  await recTrial.waitFor({ state: "detached" });

  const caseSelect = win.locator("label.field").filter({ has: win.getByText("Test case", { exact: true }) }).locator("select");
  const recordedBadge = win.locator(".badge", { hasText: "GHI THAO TÁC" });
  const code = (text) => win.getByRole("region", { name: "Mã nguồn" }).filter({ hasText: text });
  await caseSelect.selectOption("TC_CAMP_002");
  await code("seed=TC_CAMP_002").waitFor({ timeout: 10_000 }).catch(() => undefined);
  check((await code("seed=TC_CAMP_002").count()) === 1, "Đổi test case: khung Candidate nạp script đã lưu của test case đó");
  await caseSelect.selectOption("TC_CAMP_001");
  await recordedBadge.waitFor({ timeout: 10_000 }).catch(() => undefined);
  check(
    (await recordedBadge.count()) === 1 && (await code("fill(input.campaign_name)").count()) === 1,
    "Chọn lại test case: khung Candidate nạp lại candidate mới nhất từ DB",
  );

  await win.getByRole("button", { name: "Từ chối" }).click();
  await confirmBox.getByText("Từ chối candidate #3?").waitFor();
  await shot("14-confirm-reject");
  await confirmBox.getByRole("button", { name: "Từ chối" }).click();
  await confirmBox.waitFor({ state: "detached" });
  await win.locator(".panel", { hasText: "Revision #3" }).locator(".badge", { hasText: "REJECTED" }).waitFor();
  await win.locator(".list li", { hasText: "v2" }).click();
  await win.getByText("Revision #2").first().waitFor({ timeout: 5000 });
  await win.getByRole("button", { name: "#3", exact: true }).click({ timeout: 5000 });
  check(
    (await win.locator(".badge", { hasText: "GHI THAO TÁC" }).isVisible()) && (await win.evaluate(() => document.hasFocus())),
    "Từ chối qua hộp xác nhận trong app → mở version cũ → vẫn bấm được, cửa sổ giữ focus",
  );

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
  check(
    (await bridge("getSettings")).training_project_refs === true &&
      (await win.locator("label.field", { hasText: "Dùng script đã duyệt cùng dự án làm tham chiếu" }).locator("input[type=checkbox]").isChecked()),
    "Cài đặt: tham chiếu script đã duyệt cùng dự án bật mặc định",
  );
  await shot("11-settings");

  // ---------- delete an approved test case with its history ----------
  await nav("Test Cases");
  await win.getByLabel("Lọc theo dự án").selectOption({ label: "Tất cả dự án (2)" });
  await win.locator(".list li", { hasText: "TC_CAMP_001" }).click();
  await win.locator(".panel .row.end").getByRole("button", { name: "Xoá", exact: true }).click();
  const del = win.locator(".modal", { hasText: "Xoá test case TC_CAMP_001" });
  await del.waitFor();
  const delText = await del.innerText();
  check(delText.includes("2 version (1 đang APPROVED)") && delText.includes("2 lượt Testing"), "Xoá: modal liệt kê version APPROVED và lịch sử Testing sẽ bị xoá");
  const delBtn = del.getByRole("button", { name: "Xoá vĩnh viễn" });
  check(await delBtn.isDisabled(), "Xoá: phải nhập test_id trước khi xoá");
  await shot("12-delete-approved");
  await del.getByRole("textbox").fill("TC_CAMP_001");
  await delBtn.click();
  await del.waitFor({ state: "detached" });
  const remaining = await win.locator(".list li").allInnerTexts();
  check(remaining.length === 1 && remaining[0].includes("TC_CAMP_002"), "Xoá: test case đã approved biến mất khỏi danh sách");
  await nav("History");
  await win.waitForTimeout(500);
  check((await win.locator("table.t tbody tr").count()) === 0, "Xoá: lịch sử Testing của test case cũng bị xoá");

  // ---------- upload: project fixtures + file input, recorded and replayed ----------
  const fixtureSrc = join(out, "banner-smoke.png");
  writeFileSync(fixtureSrc, Buffer.alloc(2048, 3));
  await nav("Test Cases");
  await win.getByLabel("Lọc theo dự án").selectOption({ label: "Dự án B (1)" });
  const fxBox = win.locator(".fixtures-box");
  await fxBox.locator("summary").click();
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
  }, fixtureSrc);
  await fxBox.getByRole("button", { name: "Thêm file…" }).click();
  await fxBox.locator("li", { hasText: "banner-smoke.png" }).waitFor();
  check((await fxBox.locator("summary").innerText()).includes("(1)") && (await fxBox.locator("li").innerText()).includes("2.0 KB"), "File mẫu: thêm file vào dự án qua hộp chọn file");
  const projectB = (await bridge("listProjects")).find((p) => p.name === "Dự án B");
  await bridge("saveTestCase", {
    test_id: "TC_UPLOAD_001",
    title: "Tải banner lên",
    steps: ["Mở trang Assets", "Click Upload asset", "Chọn file {{banner}}", "Click Upload", "Chụp màn hình danh sách assets"],
    input_schema: { fields: [{ name: "banner", type: "file", required: true, secret: false }] },
    sample_input: { banner: "banner-smoke.png" },
    expected_result: "File xuất hiện trong danh sách Assets",
    project: { project_id: projectB.project_id },
    group_name: "Upload",
  });
  await nav("Training");
  await nav("Test Cases");
  await win.locator(".list li", { hasText: "TC_UPLOAD_001" }).click();
  const fieldRow = win.locator("table.t tr", { has: win.locator("input.mono") }).first();
  check(
    (await fieldRow.locator("select").first().inputValue()) === "file" && (await win.getByLabel("File mẫu", { exact: true }).inputValue()) === "banner-smoke.png",
    "Schema: biến kiểu file, giá trị mẫu chọn từ file mẫu của dự án",
  );
  await shot("15-upload-fixtures");

  await nav("Training");
  await caseSelect.selectOption("TC_UPLOAD_001");
  await win.getByRole("button", { name: "Ghi thao tác…" }).click();
  const upRec = win.locator(".modal", { hasText: "Ghi thao tác — TC_UPLOAD_001" });
  await upRec.waitFor();
  check((await upRec.getByLabel("File cho banner").inputValue()) === "banner-smoke.png", "Ghi thao tác: biến file hiện danh sách file mẫu, chọn sẵn input mẫu");
  await upRec.getByRole("button", { name: "Bắt đầu ghi" }).click();
  await win.locator(".rec-banner").getByText("Đang ghi thao tác cho TC_UPLOAD_001").waitFor({ timeout: 30_000 });
  const upBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${RECORDING_CDP_PORT}`);
  try {
    const rp = upBrowser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith(BASE));
    await rp.locator("e2e-rec-bar").waitFor({ state: "attached" });
    const bar = async (button) => {
      await rp.waitForFunction(() => document.querySelector("e2e-rec-bar")?.__e2eRects);
      const r = await rp.evaluate((b) => document.querySelector("e2e-rec-bar").__e2eRects()[b], button);
      await rp.mouse.click(r.x, r.y);
      if (button !== "stop") await rp.waitForTimeout(250);
    };
    await rp.getByRole("link", { name: "Assets" }).click();
    await rp.waitForURL(/\/assets$/);
    await bar("next");
    await rp.getByRole("button", { name: "Upload asset" }).click();
    await rp.waitForURL(/\/assets\/upload$/);
    await bar("next");
    await rp.getByLabel("Banner file").setInputFiles(fixtureSrc);
    await bar("next");
    await rp.getByRole("button", { name: "Upload" }).click();
    await rp.waitForURL(/\/assets$/);
    await bar("next");
    await bar("shot");
    await bar("stop");
  } finally {
    await upBrowser.close().catch(() => undefined);
  }
  await win.locator(".badge", { hasText: "GHI THAO TÁC" }).waitFor({ timeout: 30_000 });
  const upCandidate = (await bridge("getScriptState", "TC_UPLOAD_001")).candidates[0];
  check(
    upCandidate?.source.includes(".setInputFiles(input.banner)") && !upCandidate.source.includes("banner-smoke") && !upCandidate.source.includes("Cần sửa"),
    `Ghi thao tác: bước tải file thành setInputFiles(input.banner):\n${upCandidate?.source}`,
  );
  check(!upCandidate.warnings.some((w) => w.startsWith("LỖI")), `Ghi thao tác upload: script đạt kiểm tra (${upCandidate.warnings.join(" | ") || "không cảnh báo"})`);
  await fetch(`${BASE}/__admin/reset`, { method: "POST" });
  await win.getByRole("button", { name: "Chạy Trial…" }).click();
  const upTrial = win.getByRole("dialog").filter({ hasText: "Trial — candidate" });
  check((await upTrial.getByLabel("File cho banner").inputValue()) === "banner-smoke.png", "Trial: chọn file mẫu cho biến file");
  await upTrial.getByRole("button", { name: "Run Trial" }).click();
  await upTrial.getByText("Trial PASSED: script chạy hết action").waitFor({ timeout: 90_000 });
  const login = await fetch(`${BASE}/__admin/autologin`, { redirect: "manual" });
  const assetsHtml = await (await fetch(`${BASE}/assets`, { headers: { cookie: login.headers.get("set-cookie").split(";")[0] } })).text();
  check(assetsHtml.includes("banner-smoke.png") && assetsHtml.includes("2048 bytes"), "Trial upload PASSED: site nhận đúng file mẫu của dự án (2048 bytes)");
  const upTrialRow = (await bridge("getScriptState", "TC_UPLOAD_001")).trials[0];
  const upSnapshot = JSON.stringify(upTrialRow?.input_snapshot ?? "");
  check(upSnapshot.includes("banner-smoke.png") && !upSnapshot.includes("fixtures"), `Trial lưu input là tên file, không lưu đường dẫn (${upSnapshot})`);
  await shot("15b-upload-trial");
  await win.keyboard.press("Escape");
  await upTrial.waitFor({ state: "detached" });

  await nav("Test Cases");
  await win.getByLabel("Lọc theo dự án").selectOption({ label: "Dự án B (2)" });
  await fxBox.locator("summary").click();
  await fxBox.locator("li", { hasText: "banner-smoke.png" }).getByRole("button", { name: "Xoá" }).click();
  await confirmBox.getByRole("button", { name: "Xoá", exact: true }).click();
  await fxBox.locator("li").waitFor({ state: "detached" });
  await nav("Training");
  await caseSelect.selectOption("TC_UPLOAD_001");
  await win.getByRole("button", { name: "Chạy Trial…" }).click();
  const missingText = await upTrial.getByLabel("File cho banner").evaluate((el) => el.options[el.selectedIndex].text);
  await upTrial.getByRole("button", { name: "Run Trial" }).click();
  await win.getByText('File mẫu "banner-smoke.png" của biến "banner" không có trong dự án', { exact: false }).first().waitFor({ timeout: 10_000 });
  check(missingText.includes("chưa có trong dự án"), `Xoá file mẫu: Trial báo thiếu file trước khi chạy (${missingText})`);
  await win.keyboard.press("Escape");
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
