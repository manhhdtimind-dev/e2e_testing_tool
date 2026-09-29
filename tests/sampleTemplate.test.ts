import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { GUIDE_SHEET, SAMPLE_ROWS, writeSampleCsv, writeSampleXlsx } from "../src/main/services/sampleTemplate";
import { previewImport } from "../src/main/services/testCases";
import { stepDirectives } from "../src/core/stepDirectives";

const dir = mkdtempSync(join(tmpdir(), "e2e-sample-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("sample test case template", () => {
  it.each(["xlsx", "csv"])("imports the %s sample without issues", async (ext) => {
    const file = join(dir, `sample.${ext}`);
    await (ext === "xlsx" ? writeSampleXlsx(file) : writeSampleCsv(file));
    const preview = await previewImport(file);
    expect(preview.issues).toEqual([]);
    expect(preview.cases.map((c) => c.test_id)).toEqual(SAMPLE_ROWS.map((r) => r.test_id));
    expect(preview.cases[0].steps).toHaveLength(6);
    expect(stepDirectives(preview.cases[0].steps)).toEqual({ screenshot: [6], close: [] });
    expect(stepDirectives(preview.cases[1].steps)).toEqual({ screenshot: [3], close: [4] });
    expect(preview.cases[0].input).toEqual({ campaign_name: "Summer Sale", objective: "Sales" });
    expect(preview.cases[1].input).toEqual({ campaign_name: "Summer Sale" });
  });

  it("uses one sheet per group in the xlsx sample and skips the guide sheet", async () => {
    const file = join(dir, "groups.xlsx");
    await writeSampleXlsx(file);
    const preview = await previewImport(file);
    expect(preview.cases.map((c) => c.group)).toEqual(SAMPLE_ROWS.map((r) => r.group));
    expect(preview.skipped_sheets).toEqual([GUIDE_SHEET]);
  });

  it("puts the whole csv sample in one group named after the file", async () => {
    const file = join(dir, "Campaign.csv");
    await writeSampleCsv(file);
    const preview = await previewImport(file);
    expect(new Set(preview.cases.map((c) => c.group))).toEqual(new Set(["Campaign"]));
  });
});
