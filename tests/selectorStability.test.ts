import { describe, expect, it } from "vitest";
import { buildRecordedScript, type RecordingEvent, type StableFix } from "../src/core/recording";
import { cssFragility, dataLikeReason, fragileReason, isGeneratedId, replaceLocator, specToCode } from "../src/core/selectorStability";
import { validateScript } from "../src/core/scriptValidator";
import { selectorHints } from "../src/main/recording/stableLocator";
import type { InputSchema } from "../src/shared/types";

const BASE = "http://127.0.0.1:4600";
const schema: InputSchema = { fields: [{ name: "owner", type: "string", required: true, secret: false }] };

describe("fragile selectors", () => {
  it("recognises ids generated per page load", () => {
    for (const id of ["el-id-4190-146", ":r1:", "mui-12", "radix-:R1:", "headlessui-menu-button-3", "react-select-2-input", "ember123", "input-10234"]) {
      expect(isGeneratedId(id), id).toBe(true);
    }
    for (const id of ["campaign-name", "login", "obj"]) expect(isGeneratedId(id), id).toBe(false);
  });

  it("explains what makes a recorder selector fragile", () => {
    expect(fragileReason("#el-id-4190-146")).toContain('id tự sinh "#el-id-4190-146"');
    expect(fragileReason("#\\:r1\\:")).toContain("id tự sinh");
    expect(fragileReason(".flex.min-w-0 > .el-form-item > .el-form-item__content > .flex.w-full")).toMatch(/class bố cục.*chuỗi CSS/);
    expect(fragileReason("div >> internal:has-text=/^Select account$/ >> nth=1")).toContain("nth");
    expect(fragileReason(".css-1x2y3z")).toContain("mã băm");
    expect(fragileReason('internal:role=button[name="Save"i]')).toBeNull();
    expect(fragileReason("#campaign-name")).toBeNull();
    expect(cssFragility(".el-form-item")).toBeNull();
    expect(cssFragility('input[type="file"]')).toBeNull();
  });

  it("flags state classes that only exist while the element is focused, hovered or open", () => {
    expect(cssFragility(".el-input__wrapper.is-focus")).toContain('class trạng thái ".is-focus"');
    expect(cssFragility(".tab.active")).toContain("class trạng thái");
    expect(cssFragility(".el-select__wrapper")).toBeNull();
  });
});

describe("elements that appeared late while recording", () => {
  const tile = (appearMs?: number, stable?: StableFix): RecordingEvent => ({
    kind: "action",
    t: 1,
    page: 0,
    url: `${BASE}/new`,
    action: { name: "click", selector: 'internal:role=button[name="MedImage-1_4:5.png Vertical 4:5"i]' },
    code: "await page.getByRole('button', { name: 'MedImage-1_4:5.png Vertical 4:5', exact: true }).click();",
    appearMs,
    stable,
  });
  const base = { baseUrl: BASE, schema: { fields: [{ name: "ad_format", type: "string" as const, required: true, secret: false }] }, sample: { ad_format: "Image" }, secrets: {}, steps: [], closeAtEnd: false };

  it("waits longer for an element the page inserted seconds after the previous action", () => {
    const r = buildRecordedScript([tile(9000)], base);
    expect(r.source).toContain(
      "await page.getByRole('button', { name: 'MedImage-1_4:5.png Vertical 4:5', exact: true }).waitFor({ timeout: 30000 });\n  await page.getByRole('button', { name: 'MedImage-1_4:5.png Vertical 4:5', exact: true }).click();",
    );
    expect(buildRecordedScript([tile(60_000)], base).source).toContain("waitFor({ timeout: 120000 })");
    expect(buildRecordedScript([tile(1500)], base).source).not.toContain("waitFor");
    expect(validateScript(r.source, { schema: base.schema, sampleInput: base.sample }).issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("waits on the stable locator when the recorder one was replaced", () => {
    const r = buildRecordedScript([tile(5000, { reason: "nth", locator: "page.getByTestId('tile')" })], base);
    expect(r.source).toContain("await page.getByTestId('tile').waitFor({ timeout: 30000 });\n  await page.getByTestId('tile').click();");
  });

  it("replaces a sample value inside a text only as a whole word", () => {
    expect(buildRecordedScript([tile()], base).source).toContain("name: 'MedImage-1_4:5.png Vertical 4:5'");
    const word = { ...tile(), code: "await page.getByText('Format: Image (beta)').click();" };
    expect(buildRecordedScript([word], base).source).toContain("page.getByText(`Format: ${input.ad_format} (beta)`).click();");
  });
});

describe("locators that pick a specific piece of data", () => {
  it("recognises file names, dates/times and long numbers but not UI labels", () => {
    expect(dataLikeReason("15839TBN-ProKitchenTowel-MedImage-1_4:5.png Vertical 4:5")).toBe("tên file");
    expect(dataLikeReason("Website image - 2026-10-01 15:")).toBe("ngày giờ");
    expect(dataLikeReason("Đơn 31/12/2025")).toBe("ngày giờ");
    expect(dataLikeReason("Order 1234567")).toBe("mã số");
    for (const label of ["Save", "Vertical 4:5", "1.91:1", "Step 12", "+ Add Creative", "Ad Group 1"]) expect(dataLikeReason(label), label).toBeNull();
  });

  it("flags them in recorded scripts and in validation, not when the text comes from input", () => {
    const base = { baseUrl: BASE, schema, sample: { owner: "Bob" }, secrets: {}, steps: [], closeAtEnd: false };
    const click = (code: string): RecordingEvent => ({ kind: "action", t: 1, page: 0, url: `${BASE}/new`, action: { name: "click", selector: "x" }, code });
    const r = buildRecordedScript([click("await page.getByRole('button', { name: 'banner-2026-10-01.png' }).click();")], base);
    expect(r.source).toContain(`// Cần xem: chọn theo tên file "banner-2026-10-01.png" (dữ liệu cụ thể; đổi/xoá thì bước này lỗi)\n  await page.getByRole('button', { name: 'banner-2026-10-01.png' }).click();`);
    expect(r.notes.join("\n")).toContain("thêm biến input");
    const v = validateScript(r.source, { schema, sampleInput: { owner: "Bob" } });
    expect(v.issues.filter((i) => i.code === "DATA_LOCATOR").map((i) => i.severity)).toEqual(["warning"]);

    const fromInput = buildRecordedScript([click("await page.getByRole('button', { name: 'Bob' }).click();")], base);
    expect(fromInput.source).not.toContain("Cần xem");
  });
});

describe("app navigation after a click", () => {
  const nav = (t: number, url: string): RecordingEvent => ({ kind: "action", t, page: 0, url, action: { name: "navigate", url }, code: `await page.goto('${url}');` });
  const click = (t: number): RecordingEvent => ({
    kind: "action",
    t,
    page: 0,
    url: `${BASE}/demand-gen/new`,
    action: { name: "click", selector: 'internal:role=button[name="Next"i]' },
    code: "await page.getByRole('button', { name: 'Next' }).click();",
  });
  const base = { baseUrl: BASE, schema, sample: { owner: "Bob" }, secrets: {}, steps: [], closeAtEnd: false };

  it("waits for the new URL instead of navigating, with generated ids generalized", () => {
    const r = buildRecordedScript([nav(0, `${BASE}/demand-gen/new`), click(1000), nav(1500, `${BASE}/demand-gen/123456/review`)], base);
    expect(r.source).toContain('await page.goto("/demand-gen/new");');
    expect(r.source).toContain("await page.waitForURL(/\\/demand-gen\\/[^/]+\\/review(?:[?#]|$)/);");
    expect(r.source).not.toContain("123456");
  });

  it("keeps a navigation typed long after the last click", () => {
    const r = buildRecordedScript([nav(0, `${BASE}/demand-gen/new`), click(1000), nav(30_000, `${BASE}/reports`)], base);
    expect(r.source).toContain('await page.goto("/reports");');
  });
});

describe("stable locator code", () => {
  it("writes locator specs as Playwright code", () => {
    expect(specToCode({ kind: "testid", value: "owner" })).toBe("page.getByTestId('owner')");
    expect(specToCode({ kind: "attr", tag: "input", attr: "name", value: "owner" })).toBe(`page.locator('input[name="owner"]')`);
    expect(specToCode({ kind: "role", role: "combobox", name: "Owner" })).toBe("page.getByRole('combobox', { name: 'Owner', exact: true })");
    expect(specToCode({ kind: "within", container: ".el-form-item", label: "Owner's team", inner: { kind: "role", role: "combobox" } })).toBe(
      "page.locator('.el-form-item').filter({ has: page.getByText('Owner\\'s team', { exact: true }) }).getByRole('combobox')",
    );
  });

  it("replaces only the locator of a recorded statement", () => {
    expect(replaceLocator("  await page.locator('#el-id-4190-146').fill('Bob');", "page.getByTestId('owner')")).toBe("  await page.getByTestId('owner').fill('Bob');");
    expect(replaceLocator("await page.goto('/x');", "page.getByTestId('owner')")).toBeNull();
  });
});

describe("recorder selector hints", () => {
  it("extracts quoted texts and ids used to pair a recorded click with its DOM event", () => {
    expect(selectorHints('internal:text="Select"i >> nth=0')).toEqual(["select"]);
    expect(selectorHints('internal:role=option[name="Bob  Smith"i]')).toEqual(["bob smith"]);
    expect(selectorHints("#el-id-9173-227 > .el-select-dropdown")).toEqual(["el-id-9173-227"]);
    expect(selectorHints('internal:attr=[placeholder="Say \\"hi\\""i]')).toEqual(['say "hi"']);
  });
});

describe("dropdown panel clicks", () => {
  const act = (t: number, selector: string, code: string, stable?: StableFix): RecordingEvent => ({ kind: "action", t, page: 0, url: `${BASE}/new`, action: { name: "click", selector }, code, stable });
  const opener = act(1, "#el-id-9173-100", "await page.locator('#el-id-9173-100').click();", { reason: "id tự sinh", locator: "page.getByTestId('owner')" });
  const panel = act(2, "#el-id-9173-227 > .el-select-dropdown", "await page.locator('#el-id-9173-227 > .el-select-dropdown').click();");
  const option = act(3, 'internal:role=option[name="Bob"i]', "await page.getByRole('option', { name: 'Bob' }).click();");
  const base = { baseUrl: BASE, schema, sample: { owner: "Alice" }, secrets: {}, steps: ["Chọn owner"], closeAtEnd: false };

  it("drops a click on the dropdown panel right before picking an option", () => {
    const r = buildRecordedScript([opener, panel, option], base);
    expect(r.source).not.toContain("el-select-dropdown");
    expect(r.source).toContain("await page.getByTestId('owner').click();\n  await page.getByRole('option', { name: 'Bob' }).click();");
    expect(r.notes).toEqual([]);
  });

  it("keeps a panel click that is not followed by an option", () => {
    const r = buildRecordedScript([opener, panel], base);
    expect(r.source).toContain(".el-select-dropdown");
  });
});

describe("recording with fragile selectors", () => {
  const base = { baseUrl: BASE, schema, sample: { owner: "Bob" }, secrets: {}, steps: ["Chọn owner"], closeAtEnd: false };
  const stableLocator = "page.locator('.el-form-item').filter({ has: page.getByText('Owner', { exact: true }) }).getByRole('combobox')";
  const events: RecordingEvent[] = [
    { kind: "action", t: 1, page: 0, url: `${BASE}/new`, action: { name: "navigate", url: `${BASE}/new` }, code: `await page.goto('${BASE}/new');` },
    {
      kind: "action",
      t: 2,
      page: 0,
      url: `${BASE}/new`,
      action: { name: "click", selector: "#el-id-4190-146" },
      code: "await page.locator('#el-id-4190-146').click();",
      stable: { reason: 'id tự sinh "#el-id-4190-146"', locator: stableLocator },
    },
    {
      kind: "action",
      t: 3,
      page: 0,
      url: `${BASE}/new`,
      action: { name: "click", selector: "#el-id-4190-200" },
      code: "await page.locator('#el-id-4190-200').click();",
      stable: { reason: 'id tự sinh "#el-id-4190-200"', locator: null },
    },
  ];

  it("uses each action's own stable locator even when the recorder selector text repeats", () => {
    const click = (t: number, label: string): RecordingEvent => ({
      kind: "action",
      t,
      page: 0,
      url: `${BASE}/new`,
      action: { name: "click", selector: 'internal:text="Select"i >> nth=0' },
      code: "await page.getByText('Select').first().click();",
      stable: { reason: "chọn theo vị trí (nth)", locator: `page.locator('.form-item__content').filter({ has: page.getByText('${label}', { exact: true }) }).locator('.dselect')` },
    });
    const r = buildRecordedScript([click(1, "Region"), click(2, "Channel")], base);
    expect(r.source).toContain("getByText('Region', { exact: true }) }).locator('.dselect').click();");
    expect(r.source).toContain("getByText('Channel', { exact: true }) }).locator('.dselect').click();");
    expect(r.source).not.toContain(".first()");
  });

  it("uses the stable locator found while recording and flags the rest", () => {
    const r = buildRecordedScript(events, base);
    expect(r.source).toContain(`await ${stableLocator}.click();`);
    expect(r.source).not.toContain("#el-id-4190-146");
    expect(r.source).toContain('// Cần sửa: selector dễ đổi (id tự sinh "#el-id-4190-200")\n  await page.locator(\'#el-id-4190-200\').click();');
    expect(r.notes.join("\n")).toContain("không tìm được selector ổn định");

    const v = validateScript(r.source, { schema, sampleInput: { owner: "Bob" } });
    const fragile = v.issues.filter((i) => i.code === "FRAGILE_SELECTOR");
    expect(fragile).toHaveLength(1);
    expect(fragile[0].severity).toBe("warning");
    expect(fragile[0].message).toContain("el-id-4190-200");
  });
});
