import { describe, expect, it } from "vitest";
import { buildRecordedScript, cleanRecording, sanitizeRecordedAction, type RecordingBuildOptions, type RecordingEvent } from "../src/core/recording";
import { validateScript } from "../src/core/scriptValidator";
import type { InputSchema } from "../src/shared/types";

const BASE = "http://127.0.0.1:4600";
const schema: InputSchema = {
  fields: [
    { name: "campaign_name", type: "string", required: true, secret: false },
    { name: "objective", type: "string", required: true, secret: false },
  ],
};
const steps = [
  "Mở trang Campaign",
  "Click Create Campaign",
  "Nhập Campaign Name = {{campaign_name}}",
  "Chọn Objective = {{objective}}",
  "Chụp màn hình form",
  "Click Save",
  "Chụp màn hình danh sách campaign",
];
const opts = (over: Partial<RecordingBuildOptions> = {}): RecordingBuildOptions => ({
  baseUrl: BASE,
  schema,
  sample: { campaign_name: "Summer Sale", objective: "Sales" },
  secrets: {},
  steps,
  closeAtEnd: false,
  ...over,
});

let t = 0;
const act = (name: string, code: string, extra: Partial<Extract<RecordingEvent, { kind: "action" }>["action"]> = {}, url = `${BASE}/campaigns`, page = 0): RecordingEvent => ({
  kind: "action",
  t: (t += 200),
  page,
  url,
  action: { name, ...extra },
  code: `  ${code}`,
});
const step = (n: number): RecordingEvent => ({ kind: "step", t: (t += 1), step: n });
const shot = (url = `${BASE}/campaigns`): RecordingEvent => ({ kind: "shot", t: (t += 1), url });

const campaignFlow = (): RecordingEvent[] => [
  step(1),
  act("openPage", "const page = await context.newPage();", { url: "about:blank" }, "about:blank"),
  act("navigate", `await page.goto('${BASE}/');`, { url: `${BASE}/` }, `${BASE}/`),
  step(2),
  act("click", "await page.getByRole('button', { name: 'Create Campaign' }).click();", { selector: 'internal:role=button[name="Create Campaign"i]' }),
  step(3),
  act("click", "await page.getByRole('textbox', { name: 'Campaign Name' }).click();", { selector: 'internal:role=textbox[name="Campaign Name"i]' }, `${BASE}/campaigns/new`),
  act("fill", "await page.getByRole('textbox', { name: 'Campaign Name' }).fill('Summer Sale');", { selector: 'internal:role=textbox[name="Campaign Name"i]', text: "Summer Sale" }, `${BASE}/campaigns/new`),
  step(4),
  act("select", "await page.getByLabel('Objective').selectOption('Sales');", { selector: 'internal:label="Objective"i', options: ["Sales"] }, `${BASE}/campaigns/new`),
  step(5),
  shot(`${BASE}/campaigns/new`),
  step(6),
  act("click", "await page.getByRole('button', { name: 'Save' }).click();", { selector: 'internal:role=button[name="Save"i]' }, `${BASE}/campaigns/new`),
  step(7),
  shot(`${BASE}/campaigns`),
];

describe("recorded script", () => {
  it("replaces test data with input fields, keeps locators, adds steps and screenshots", () => {
    const r = buildRecordedScript(campaignFlow(), opts());
    expect(r.notes).toEqual([]);
    expect(r.actionCount).toBe(5);
    expect(r.source).toContain('await page.goto("/");');
    expect(r.source).toContain("await page.getByRole('textbox', { name: 'Campaign Name' }).fill(input.campaign_name);");
    expect(r.source).toContain("await page.getByLabel('Objective').selectOption(input.objective);");
    expect(r.source).not.toContain("Summer Sale");
    expect(r.source).not.toContain(".click();\n  await page.getByRole('textbox', { name: 'Campaign Name' }).fill");
    expect(r.source.match(/await page\.screenshot\(\);/g)).toHaveLength(2);
    expect(r.source).toContain("await page.waitForURL(/\\/campaigns(?:[?#]|$)/);\n  await page.screenshot();\n}");
    expect(r.source).toContain("// Step 5: Chụp màn hình form\n  await page.screenshot();");
    const v = validateScript(r.source, { schema, sampleInput: { campaign_name: "Summer Sale", objective: "Sales" }, steps });
    expect(v.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(v.issues.map((i) => i.code)).not.toContain("SCREENSHOT_STEPS");
  });

  it("replaces sample values inside locators and builds template strings for partial matches", () => {
    const r = buildRecordedScript(
      [
        act("navigate", `await page.goto('${BASE}/campaigns');`, { url: `${BASE}/campaigns` }),
        act("click", "await page.getByRole('cell', { name: 'Summer Sale' }).click();", { selector: 'internal:role=cell[name="Summer Sale"i]' }),
        act("click", "await page.getByText('Đã tạo Summer Sale thành công').click();", { selector: 'internal:text="Đã tạo Summer Sale thành công"i' }),
        act("click", "await page.getByRole('button', { name: 'Sales' }).click();", { selector: 'internal:role=button[name="Sales"i]' }),
      ],
      opts(),
    );
    expect(r.source).toContain("page.getByRole('cell', { name: input.campaign_name }).click();");
    expect(r.source).toContain("page.getByText(`Đã tạo ${input.campaign_name} thành công`).click();");
    expect(r.source).toContain("page.getByRole('button', { name: input.objective }).click();");
  });

  it("never keeps a typed secret: maps it to the secret field or blanks it with a note", () => {
    const secretSchema: InputSchema = { fields: [...schema.fields, { name: "password", type: "string", required: true, secret: true }] };
    const typed = [
      act("navigate", `await page.goto('${BASE}/login');`, { url: `${BASE}/login` }),
      act("fill", "await page.getByRole('textbox', { name: 'Password' }).fill('demo123');", { selector: 'internal:role=textbox[name="Password"i]', text: "demo123" }),
    ];
    const mapped = buildRecordedScript(typed, opts({ schema: secretSchema, secrets: { password: "demo123" } }));
    expect(mapped.source).toContain(".fill(input.password);");
    expect(mapped.source).not.toContain("demo123");
    expect(mapped.notes).toEqual([]);

    const guessed = buildRecordedScript(typed, opts({ schema: secretSchema, secrets: {} }));
    expect(guessed.source).toContain(".fill(input.password);");
    expect(guessed.source).not.toContain("demo123");
    expect(guessed.notes.join("\n")).toContain("environment chưa lưu giá trị");

    const noField = buildRecordedScript(typed, opts());
    expect(noField.source).toContain('.fill("");');
    expect(noField.source).not.toContain("demo123");
    expect(noField.notes.join("\n")).toContain("chưa có biến secret");
    expect(JSON.stringify(noField.log)).not.toContain("demo123");
  });

  it("flags values that do not match the sample input and uses String() for non-string fields", () => {
    const qtySchema: InputSchema = { fields: [...schema.fields, { name: "qty", type: "number", required: true, secret: false }] };
    const r = buildRecordedScript(
      [
        act("navigate", `await page.goto('${BASE}/campaigns/new');`, { url: `${BASE}/campaigns/new` }),
        act("fill", "await page.getByLabel('Budget').fill('500');", { selector: 'internal:label="Budget"i', text: "500" }),
        act("fill", "await page.getByLabel('Qty').fill('3');", { selector: 'internal:label="Qty"i', text: "3" }),
      ],
      opts({ schema: qtySchema, sample: { campaign_name: "Summer Sale", objective: "Sales", qty: "3" } }),
    );
    expect(r.source).toContain(".fill(String(input.qty));");
    expect(r.source).toContain(".fill('500');");
    expect(r.notes.join("\n")).toContain('Ô "Budget": giá trị nhập không khớp input mẫu');
  });

  it("drops clicks on the toolbar, the synthetic submit click after Enter and repeated navigations", () => {
    const events = [
      act("navigate", `await page.goto('${BASE}/login');`, { url: `${BASE}/login` }),
      act("click", "await page.locator('e2e-rec-bar').click();", { selector: "e2e-rec-bar" }),
      act("navigate", `await page.goto('${BASE}/login');`, { url: `${BASE}/login` }),
      act("press", "await page.getByRole('textbox', { name: 'Search' }).press('Enter');", { selector: 'internal:role=textbox[name="Search"i]', key: "Enter" }),
      act("click", "await page.getByRole('button', { name: 'Search' }).click();", { selector: 'internal:role=button[name="Search"i]' }),
    ];
    const cleaned = cleanRecording(events).filter((e) => e.kind === "action");
    expect(cleaned.map((e) => (e.kind === "action" ? e.action.name : ""))).toEqual(["navigate", "press"]);
  });

  it("skips other tabs and file uploads with notes, starts with the base URL when no navigation was recorded", () => {
    const r = buildRecordedScript(
      [
        act("click", "await page.getByRole('link', { name: 'Help' }).click();", { selector: 'internal:role=link[name="Help"i]' }),
        act("click", "await page1.getByRole('button', { name: 'OK' }).click();", { selector: 'internal:role=button[name="OK"i]' }, `${BASE}/help`, 1),
        act("setInputFiles", "await page.getByLabel('Logo').setInputFiles('C:\\\\Users\\\\me\\\\logo.png');", { selector: 'internal:label="Logo"i', files: ["C:\\Users\\me\\logo.png"] }),
      ],
      opts(),
    );
    expect(r.source).toMatch(/run\(page: Page, input: Input\): Promise<void> \{\n {2}await page\.goto\("\/"\);\n {2}await page\.getByRole\('link'/);
    expect(r.source).not.toContain("page1");
    expect(r.source).not.toContain("setInputFiles");
    expect(r.source).not.toContain("Users");
    expect(r.notes.join("\n")).toContain("tab/cửa sổ khác");
    expect(r.notes.join("\n")).toContain('chưa có biến kiểu file cho file "logo.png"');
  });

  it("appends page.close() under the close step when the user reached it", () => {
    const closeSteps = ["Mở trang Campaign", "Chụp màn hình", "Đóng trình duyệt"];
    const r = buildRecordedScript(
      [step(1), act("navigate", `await page.goto('${BASE}/campaigns');`, { url: `${BASE}/campaigns` }), step(2), shot(), step(3)],
      opts({ steps: closeSteps, closeAtEnd: true }),
    );
    expect(r.source).toContain("// Step 3: Đóng trình duyệt\n  await page.close();\n}");
    expect(validateScript(r.source, { schema, sampleInput: {}, steps: closeSteps }).issues.map((i) => i.code)).not.toContain("CLOSE_STEP");
  });

  it("keeps only known fields of a raw recorder action (drops the aria snapshot)", () => {
    const a = sanitizeRecordedAction({ name: "fill", selector: "x", text: "demo123", ariaSnapshot: '- textbox "Password": demo123', ref: "e8" });
    expect(a).toEqual({ name: "fill", selector: "x", text: "demo123" });
  });
});
