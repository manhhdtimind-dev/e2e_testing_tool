import { describe, expect, it } from "vitest";
import { stepDirectives } from "../src/core/stepDirectives";
import { validateScript } from "../src/core/scriptValidator";
import { directivesBlock, initialPrompt } from "../src/main/training/prompt";
import type { Environment, TestCase } from "../src/shared/types";

const STEPS = [
  "Mở trang Campaign (/campaigns)",
  "Click nút \"Save\"",
  "Chụp màn hình",
  "Mở trang Báo cáo",
  "Chụp ảnh màn hình toàn trang",
  "Đóng trình duyệt",
];

const tc = (steps: string[]): TestCase => ({
  test_id: "T1",
  project_id: null,
  group_name: "",
  title: "t",
  steps,
  input_schema: { fields: [] },
  sample_input: {},
  expected_result: "ok",
  raw_import: null,
  confirmed_at: null,
  created_at: "",
  updated_at: "",
});
const env = { environment_id: "e", name: "e", base_url: "http://x", allowed_domains: ["x"] } as Environment;

const script = (body: string) => `import { expect, type Page } from "@playwright/test";
export async function run(page: Page, input: {}) {
  await page.goto("/campaigns");
${body}
}
`;
const warningCodes = (body: string, steps: string[]) =>
  validateScript(script(body), { schema: { fields: [] }, sampleInput: {}, steps })
    .issues.filter((i) => i.severity === "warning")
    .map((i) => i.code);

describe("step directives", () => {
  it("finds screenshot and close-browser steps, with or without diacritics", () => {
    expect(stepDirectives(STEPS)).toEqual({ screenshot: [3, 5], close: [6] });
    expect(stepDirectives(["chup man hinh", "Take a screenshot", "Close the browser", "Tắt browser", "Đóng tab"])).toEqual({ screenshot: [1, 2], close: [3, 4, 5] });
  });

  it("does not treat closing a dialog as closing the browser", () => {
    expect(stepDirectives(["Đóng popup thông báo", "Click nút Đóng", "Mở trang Đóng gói", "Upload ảnh chụp CMND"])).toEqual({ screenshot: [], close: [] });
    expect(stepDirectives(["Chụp lại màn hình", "Chụp kết quả", "Chụp"]).screenshot).toEqual([1, 2, 3]);
  });

  it("tells the agent exactly where to take screenshots and close the page", () => {
    const block = directivesBlock(tc(STEPS));
    expect(block).toContain('step 3 ("Chụp màn hình"): call `await page.screenshot()`');
    expect(block).toContain('step 5 ("Chụp ảnh màn hình toàn trang")');
    expect(block).toContain('step 6 ("Đóng trình duyệt"): call `await page.close()`');
    expect(block).toContain("do NOT close the browser");
    expect(initialPrompt(tc(STEPS), env, {}, 50, "")).toContain(block);
  });

  it("falls back to one final screenshot and no close when the steps say nothing", () => {
    const block = directivesBlock(tc(["Mở trang Campaign"]));
    expect(block).toContain("take one `await page.screenshot()` after the last step");
    expect(block).toContain("do not call page.close()");
  });

  it("warns when the script does not match the screenshot/close steps", () => {
    const ok = "  await page.screenshot();\n  await page.screenshot({ fullPage: true });\n  await page.close();";
    expect(warningCodes(ok, STEPS)).toEqual([]);
    expect(warningCodes("  await page.screenshot();\n  await page.close();", STEPS)).toContain("SCREENSHOT_STEPS");
    expect(warningCodes("  await page.screenshot();\n  await page.screenshot();", STEPS)).toContain("CLOSE_STEP");
    expect(warningCodes("  await page.screenshot();\n  await page.close();", ["Mở trang"])).toContain("CLOSE_STEP");
    expect(warningCodes("", ["Mở trang"])).toContain("NO_SCREENSHOT");
    expect(warningCodes("  await page.screenshot();\n  await page.screenshot();\n  await page.context().close();", STEPS)).toContain("CLOSE_BROWSER");
  });
});
