import { describe, expect, it } from "vitest";
import { checkTestCaseDraft, extractVariables, parseInputCell, parseRows, parseSheets, parseSteps, parseYamlCases } from "../src/core/parser";

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

  it("uses each sheet with a test_id column as a group and skips other sheets", () => {
    const row = (id: string) => ({ test_id: id, title: "t", steps: "Mở trang", input: "", expected_result: "ok" });
    const preview = parseSheets("book.xlsx", [
      { name: "Đăng nhập", headers: HEADERS, rows: [row("A1"), row("A2")] },
      { name: "Hướng dẫn", headers: ["Mục", "Cách ghi"], rows: [{ Mục: "test_id", "Cách ghi": "..." }] },
      { name: "Trống", headers: HEADERS, rows: [] },
      { name: " Campaign ", headers: HEADERS, rows: [row("B1")] },
    ]);
    expect(preview.issues).toEqual([]);
    expect(preview.cases.map((c) => [c.group, c.sheet, c.test_id, c.row])).toEqual([
      ["Đăng nhập", "Đăng nhập", "A1", 2],
      ["Đăng nhập", "Đăng nhập", "A2", 3],
      ["Campaign", " Campaign ", "B1", 2],
    ]);
    expect(preview.skipped_sheets).toEqual(["Hướng dẫn", "Trống"]);
  });

  it("reports issues per sheet and test_id duplicated across sheets", () => {
    const preview = parseSheets("book.xlsx", [
      { name: "S1", headers: HEADERS, rows: [{ test_id: "X", title: "t", steps: "a", input: "", expected_result: "ok" }] },
      { name: "S2", headers: HEADERS, rows: [{ test_id: "X", title: "", steps: "a", input: "", expected_result: "ok" }] },
      { name: "S3", headers: ["test_id", "title"], rows: [] },
    ]);
    expect(preview.issues).toContainEqual({ sheet: "S2", row: 2, column: "title", message: "Ô title bị trống" });
    expect(preview.issues).toContainEqual({ sheet: "S2", row: 2, column: "test_id", message: 'test_id "X" trùng với sheet "S1" dòng 2' });
    expect(preview.issues.filter((i) => i.sheet === "S3").map((i) => i.column)).toEqual(["steps", "input", "expected_result"]);
  });

  it("reports a workbook without test case sheets", () => {
    const preview = parseSheets("book.xlsx", [{ name: "Notes", headers: ["a"], rows: [] }]);
    expect(preview.cases).toEqual([]);
    expect(preview.issues).toHaveLength(1);
  });

  it("groups CSV/YAML cases by file name", () => {
    const preview = parseRows("C:\\x\\Đăng nhập.csv", HEADERS, [{ test_id: "A", title: "t", steps: "a", input: "", expected_result: "ok" }]);
    expect(preview.cases[0].group).toBe("Đăng nhập");
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
