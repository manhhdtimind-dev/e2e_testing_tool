import { describe, expect, it } from "vitest";
import { buildRecordedScript, type RecordingEvent, type StableFix } from "../src/core/recording";
import { cssFragility, fragileReason, isGeneratedId, replaceLocator, specToCode } from "../src/core/selectorStability";
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
