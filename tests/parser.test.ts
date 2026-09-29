import { describe, expect, it } from "vitest";
import { checkTestCaseDraft, extractVariables, parseInputCell, parseRows, parseSteps, parseYamlCases } from "../src/core/parser";

const HEADERS = ["test_id", "title", "steps", "input", "expected_result"];

describe("parser", () => {
  it("parses the requirement template row and builds schema", () => {
    const preview = parseRows("cases.csv", HEADERS, [
      {
        test_id: "TC_CREATE_CAMPAIGN_001",
        title: "Tạo campaign",
        steps: "1. Mở trang Campaign\n2. Click Create Campaign\n3. Nhập Campaign Name = {{campaign_name}}\n4. Chọn Objective = {{objective}}\n5. Click Save",
        input: "campaign_name: Summer Sale 2026\nobjective: Sales",
        expected_result: "Campaign xuất hiện trong Campaign List.",
      },
    ]);
    expect(preview.issues).toEqual([]);
    expect(preview.cases).toHaveLength(1);
    const tc = preview.cases[0];
    expect(tc.steps).toHaveLength(5);
    expect(tc.steps[2]).toBe("Nhập Campaign Name = {{campaign_name}}");
    expect(tc.input).toEqual({ campaign_name: "Summer Sale 2026", objective: "Sales" });
    expect(tc.input_schema.fields.map((f) => f.name)).toEqual(["campaign_name", "objective"]);
  });

  it("reports missing cells and unknown variables with row/column", () => {
    const preview = parseRows("cases.csv", HEADERS, [
      { test_id: "A", title: "", steps: "Nhập {{name}}", input: "other=1", expected_result: "ok" },
      { test_id: "A", title: "t", steps: "x", input: "", expected_result: "ok" },
    ]);
    expect(preview.issues).toContainEqual({ row: 2, column: "title", message: "Ô title bị trống" });
    expect(preview.issues).toContainEqual({ row: 2, column: "steps", message: "Biến {{name}} không có trong input" });
    expect(preview.issues.some((i) => i.row === 3 && i.column === "test_id")).toBe(true);
  });

  it("reports missing header columns", () => {
    const preview = parseRows("x.csv", ["test_id", "title"], []);
    expect(preview.issues.map((i) => i.column)).toEqual(["steps", "input", "expected_result"]);
  });

  it("parses input as JSON, YAML and key=value", () => {
    expect(parseInputCell('{"a": "1", "b": 2}').values).toEqual({ a: "1", b: "2" });
    expect(parseInputCell("a=1\nb = hello world").values).toEqual({ a: "1", b: "hello world" });
    expect(parseInputCell("a: x").values).toEqual({ a: "x" });
    expect(parseInputCell("a: [1,2]").error).toBeTruthy();
  });

  it("extracts variables and strips step numbering", () => {
    expect(parseSteps("- a\n* b\n3) c\n\n")).toEqual(["a", "b", "c"]);
    expect(extractVariables(["{{ a }} and {{b}}", "{{a}}"])).toEqual(["a", "b"]);
  });

  it("parses YAML template", () => {
    const preview = parseYamlCases(
      "c.yaml",
      `test_id: T1\ntitle: X\nsteps:\n  - Nhập {{n}}\ninput:\n  n: v\nexpected_result: ok\n`,
    );
    expect(preview.issues).toEqual([]);
    expect(preview.cases[0].input).toEqual({ n: "v" });
  });

  it("checks edited drafts", () => {
    const issues = checkTestCaseDraft({
      test_id: "T",
      title: "t",
      steps: ["{{x}}"],
      input_schema: { fields: [{ name: "1bad", type: "string", required: true, secret: false }] },
      sample_input: {},
      expected_result: "e",
    });
    expect(issues).toContain('Tên biến không hợp lệ: "1bad"');
    expect(issues).toContain("Biến {{x}} trong steps không có trong input_schema");
  });
});
