import { describe, expect, it } from "vitest";
import { buildRecordedScript, type RecordingEvent } from "../src/core/recording";
import { cssFragility, fragileReason, isGeneratedId, replaceLocator, specToCode } from "../src/core/selectorStability";
import { validateScript } from "../src/core/scriptValidator";
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

describe("dropdown panel clicks", () => {
  const act = (t: number, selector: string, code: string): RecordingEvent => ({ kind: "action", t, page: 0, url: `${BASE}/new`, action: { name: "click", selector }, code });
  const opener = act(1, "#el-id-9173-100", "await page.locator('#el-id-9173-100').click();");
  const panel = act(2, "#el-id-9173-227 > .el-select-dropdown", "await page.locator('#el-id-9173-227 > .el-select-dropdown').click();");
  const option = act(3, 'internal:role=option[name="Bob"i]', "await page.getByRole('option', { name: 'Bob' }).click();");
  const stable = { "#el-id-9173-100": { reason: "id tự sinh", locator: "page.getByTestId('owner')" } };
  const base = { baseUrl: BASE, schema, sample: { owner: "Alice" }, secrets: {}, steps: ["Chọn owner"], closeAtEnd: false, stable };

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
  const events: RecordingEvent[] = [
    { kind: "action", t: 1, page: 0, url: `${BASE}/new`, action: { name: "navigate", url: `${BASE}/new` }, code: `await page.goto('${BASE}/new');` },
    { kind: "action", t: 2, page: 0, url: `${BASE}/new`, action: { name: "click", selector: "#el-id-4190-146" }, code: "await page.locator('#el-id-4190-146').click();" },
    { kind: "action", t: 3, page: 0, url: `${BASE}/new`, action: { name: "click", selector: "#el-id-4190-200" }, code: "await page.locator('#el-id-4190-200').click();" },
  ];
  const base = { baseUrl: BASE, schema, sample: { owner: "Bob" }, secrets: {}, steps: ["Chọn owner"], closeAtEnd: false };
  const stableLocator = "page.locator('.el-form-item').filter({ has: page.getByText('Owner', { exact: true }) }).getByRole('combobox')";

  it("uses the stable locator found while recording and flags the rest", () => {
    const r = buildRecordedScript(events, {
      ...base,
      stable: {
        "#el-id-4190-146": { reason: 'id tự sinh "#el-id-4190-146"', locator: stableLocator },
        "#el-id-4190-200": { reason: 'id tự sinh "#el-id-4190-200"', locator: null },
      },
    });
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
