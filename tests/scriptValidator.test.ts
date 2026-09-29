import { describe, expect, it } from "vitest";
import { validateScript } from "../src/core/scriptValidator";
import type { InputSchema } from "../src/shared/types";

const schema: InputSchema = {
  fields: [
    { name: "campaign_name", type: "string", required: true, secret: false },
    { name: "objective", type: "string", required: true, secret: false },
  ],
};
const sampleInput = { campaign_name: "Summer Sale 2026", objective: "Sales" };

const GOOD = `import { expect, type Page } from "@playwright/test";

export async function run(page: Page, input: { campaign_name: string; objective: string }) {
  await page.goto("/campaigns");
  await page.getByRole("button", { name: "Create Campaign" }).click();
  await page.getByLabel("Campaign Name").fill(input.campaign_name);
  await page.getByLabel("Objective").selectOption(input.objective);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: "Campaign List" })).toBeVisible();
}
`;

const codes = (src: string, secretValues?: string[]) =>
  validateScript(src, { schema, sampleInput, secretValues }).issues.filter((i) => i.severity === "error").map((i) => i.code);

describe("validateScript", () => {
  it("accepts a well-formed candidate", () => {
    const r = validateScript(GOOD, { schema, sampleInput });
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.used_fields.sort()).toEqual(["campaign_name", "objective"]);
  });

  it("requires exported async run(page, input)", () => {
    expect(codes("export function run(page, input) {}")).toContain("RUN_NOT_ASYNC");
    expect(codes("async function run(page, input) {}")).toContain("NO_RUN");
    expect(codes("export async function run(page) {}")).toContain("RUN_SIGNATURE");
    expect(codes("export const run = async (page, input) => { await page.fill('#a', input.objective) }")).toEqual([]);
  });

  it("flags hardcoded training input", () => {
    const src = GOOD.replace("input.campaign_name", '"Summer Sale 2026"');
    expect(codes(src)).toContain("HARDCODED_INPUT");
    expect(codes(GOOD.replace("input.objective", "`Sales`"))).toContain("HARDCODED_INPUT");
  });

  it("flags unknown input fields and dynamic access", () => {
    expect(codes(GOOD.replace("input.objective", "input.goal"))).toContain("UNKNOWN_FIELD");
    expect(codes(GOOD.replace("input.objective", "input[key]"))).toContain("DYNAMIC_INPUT");
  });

  it("supports destructured input", () => {
    const src = `export async function run(page, { campaign_name }) { await page.fill('#a', campaign_name) }`;
    expect(validateScript(src, { schema, sampleInput }).used_fields).toEqual(["campaign_name"]);
    const src2 = `export async function run(page, input) { const { objective, nope } = input; await page.fill('#a', objective + nope) }`;
    expect(codes(src2)).toContain("UNKNOWN_FIELD");
  });

  it("flags coordinates, forbidden APIs and imports", () => {
    expect(codes(GOOD.replace('await page.goto("/campaigns");', "await page.mouse.click(10, 20);"))).toContain("COORDINATES");
    expect(codes(GOOD.replace('.click();', ".click({ position: { x: 1, y: 2 } });"))).toContain("COORDINATES");
    expect(codes(`import fs from "fs";\n${GOOD}`)).toContain("FORBIDDEN_IMPORT");
    expect(codes(GOOD.replace('await page.goto("/campaigns");', "eval('1'); process.exit(0);"))).toContain("FORBIDDEN_API");
    expect(codes(GOOD.replace('await page.goto("/campaigns");', 'await page.goto("/campaigns");\n  await page.pause();'))).toContain("PAUSE");
  });

  it("flags secrets", () => {
    expect(codes(GOOD.replace('"/campaigns"', '"/campaigns?k=S3cr3tValue"'), ["S3cr3tValue"])).toContain("HARDCODED_SECRET");
    expect(codes(GOOD.replace('await page.goto("/campaigns");', 'const password = "hunter2";'))).toContain("HARDCODED_SECRET");
  });

  it("reports syntax errors", () => {
    expect(codes("export async function run(page, input) { await page.click( }")).toContain("SYNTAX");
  });
});
