import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SAMPLE_ROWS, writeSampleCsv, writeSampleXlsx } from "../src/main/services/sampleTemplate";
import { previewImport } from "../src/main/services/testCases";

const dir = mkdtempSync(join(tmpdir(), "e2e-sample-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("sample test case template", () => {
  it.each(["xlsx", "csv"])("imports the %s sample without issues", async (ext) => {
    const file = join(dir, `sample.${ext}`);
    await (ext === "xlsx" ? writeSampleXlsx(file) : writeSampleCsv(file));
    const preview = await previewImport(file);
    expect(preview.issues).toEqual([]);
    expect(preview.cases.map((c) => c.test_id)).toEqual(SAMPLE_ROWS.map((r) => r.test_id));
    expect(preview.cases[0].steps).toHaveLength(5);
    expect(preview.cases[0].input).toEqual({ campaign_name: "Summer Sale", objective: "Sales" });
    expect(preview.cases[1].input).toEqual({ campaign_name: "Summer Sale" });
  });
});
