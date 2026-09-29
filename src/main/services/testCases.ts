import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import ExcelJS from "exceljs";
import Papa from "papaparse";
import type { ImportPreview, InputSchema, InputValues, ParsedTestCase, TestCase } from "../../shared/types";
import { checkTestCaseDraft, parseRows, parseYamlCases } from "../../core/parser";
import type { AppContext } from "../context";
import { AppError, now } from "../util";

export async function previewImport(filePath: string): Promise<ImportPreview> {
  const ext = extname(filePath).toLowerCase();
  const name = basename(filePath);
  if (ext === ".csv") {
    const text = (await readFile(filePath, "utf8")).replace(/^\uFEFF/, "");
    const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: "greedy" });
    const preview = parseRows(name, parsed.meta.fields ?? [], parsed.data);
    for (const err of parsed.errors) {
      preview.issues.push({ row: (err.row ?? 0) + 2, column: "*", message: `CSV: ${err.message}` });
    }
    return preview;
  }
  if (ext === ".xlsx") {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);
    const ws = wb.worksheets[0];
    if (!ws) return { file_name: name, cases: [], issues: [{ row: 1, column: "*", message: "File xlsx không có sheet nào" }] };
    const headers: string[] = [];
    ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
      headers[col - 1] = String(cell.text ?? "").trim();
    });
    const rows: Record<string, unknown>[] = [];
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const rec: Record<string, unknown> = {};
      headers.forEach((h, i) => {
        if (h) rec[h] = row.getCell(i + 1).text;
      });
      rows.push(rec);
    }
    return parseRows(name, headers.filter(Boolean), rows);
  }
  if (ext === ".yaml" || ext === ".yml") {
    return parseYamlCases(name, await readFile(filePath, "utf8"));
  }
  throw new AppError("Chỉ hỗ trợ file .xlsx, .csv hoặc .yaml");
}

export interface TestCaseInput {
  test_id: string;
  title: string;
  steps: string[];
  input_schema: InputSchema;
  sample_input: InputValues;
  expected_result: string;
  raw_import?: Record<string, unknown> | null;
}

export function saveTestCase(ctx: AppContext, input: TestCaseInput, action = "testcase.update"): TestCase {
  const issues = checkTestCaseDraft(input);
  if (issues.length > 0) throw new AppError(issues.join("\n"));
  const schemaNames = new Set(input.input_schema.fields.map((f) => f.name));
  const sample: InputValues = {};
  for (const [k, v] of Object.entries(input.sample_input)) {
    const field = input.input_schema.fields.find((f) => f.name === k);
    if (schemaNames.has(k) && !field?.secret) sample[k] = v;
  }
  const existing = ctx.repo.testCases.get(input.test_id);
  const ts = now();
  const record: TestCase = {
    test_id: input.test_id.trim(),
    title: input.title.trim(),
    steps: input.steps.map((s) => s.trim()).filter(Boolean),
    input_schema: input.input_schema,
    sample_input: sample,
    expected_result: input.expected_result.trim(),
    raw_import: input.raw_import !== undefined ? input.raw_import : (existing?.raw_import ?? null),
    confirmed_at: ts,
    created_at: existing?.created_at ?? ts,
    updated_at: ts,
  };
  if (existing) ctx.repo.testCases.update([record.test_id], record);
  else ctx.repo.testCases.insert(record);
  ctx.repo.audit(action, "test_case", record.test_id, { title: record.title, fields: [...schemaNames] });
  return record;
}

export function confirmImport(ctx: AppContext, fileName: string, cases: ParsedTestCase[]): TestCase[] {
  const errors: string[] = [];
  for (const c of cases) {
    const issues = checkTestCaseDraft({ ...c, sample_input: c.input });
    if (issues.length) errors.push(`${c.test_id || `dòng ${c.row}`}: ${issues.join("; ")}`);
  }
  const ids = cases.map((c) => c.test_id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) errors.push(`test_id "${dup}" bị trùng trong file`);
  if (errors.length) throw new AppError(errors.join("\n"));
  const saved = ctx.repo.db.tx(() =>
    cases.map((c) =>
      saveTestCase(
        ctx,
        {
          test_id: c.test_id,
          title: c.title,
          steps: c.steps,
          input_schema: c.input_schema,
          sample_input: c.input,
          expected_result: c.expected_result,
          raw_import: c.raw,
        },
        "testcase.import",
      ),
    ),
  );
  ctx.repo.audit("import.confirm", "file", fileName, { count: saved.length, test_ids: ids });
  return saved;
}

export function deleteTestCase(ctx: AppContext, testId: string) {
  if (ctx.repo.scripts.where("test_id = ?", testId).length > 0) {
    throw new AppError("Test case đã có script/lịch sử Training, không thể xoá");
  }
  ctx.repo.testCases.delete(testId);
  ctx.repo.audit("testcase.delete", "test_case", testId);
}
