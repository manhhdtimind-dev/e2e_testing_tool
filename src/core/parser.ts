import YAML from "yaml";
import type {
  ImportIssue,
  ImportPreview,
  InputField,
  InputSchema,
  InputValues,
  ParsedTestCase,
} from "../shared/types";

export const REQUIRED_COLUMNS = ["test_id", "title", "steps", "input", "expected_result"] as const;

const VARIABLE_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function extractVariables(steps: string[]): string[] {
  const found = new Set<string>();
  for (const step of steps) {
    for (const m of step.matchAll(VARIABLE_RE)) found.add(m[1]);
  }
  return [...found];
}

export function parseSteps(cell: string): string[] {
  return cell
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter((line) => line.length > 0);
}

/**
 * Accepts YAML/JSON mappings or `key=value` / `key: value` lines.
 */
export function parseInputCell(cell: string): { values: InputValues; error?: string } {
  const text = cell.trim();
  if (!text) return { values: {} };
  let parsed: unknown;
  try {
    parsed = YAML.parse(text);
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined || parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    const values: InputValues = {};
    for (const line of text.split(/\r?\n|;/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const m = trimmed.match(/^([^=:]+?)\s*[=:]\s*(.*)$/);
      if (!m) return { values: {}, error: `Không đọc được dòng input "${trimmed}" (cần dạng key=value)` };
      values[m[1].trim()] = m[2].trim();
    }
    return { values };
  }
  const values: InputValues = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (v !== null && typeof v === "object") {
      return { values: {}, error: `Giá trị của "${k}" phải là giá trị đơn (chuỗi/số/boolean)` };
    }
    values[k] = v === null || v === undefined ? "" : String(v);
  }
  return { values };
}

export function inferType(value: string): InputField["type"] {
  if (/^(true|false)$/i.test(value)) return "boolean";
  if (value !== "" && !Number.isNaN(Number(value)) && /^-?\d+(\.\d+)?$/.test(value)) return "number";
  return "string";
}

export function buildSchema(input: InputValues, previous?: InputSchema): InputSchema {
  const prev = new Map((previous?.fields ?? []).map((f) => [f.name, f]));
  return {
    fields: Object.keys(input).map((name) => {
      const old = prev.get(name);
      return old ?? { name, type: "string", required: true, secret: false };
    }),
  };
}

export interface DraftCheckInput {
  test_id: string;
  title: string;
  steps: string[];
  input_schema: InputSchema;
  sample_input: InputValues;
  expected_result: string;
}

export function checkTestCaseDraft(tc: DraftCheckInput): string[] {
  const issues: string[] = [];
  if (!tc.test_id.trim()) issues.push("Thiếu test_id");
  if (!tc.title.trim()) issues.push("Thiếu title");
  if (tc.steps.length === 0) issues.push("Thiếu steps");
  if (!tc.expected_result.trim()) issues.push("Thiếu expected_result");
  const names = new Set<string>();
  for (const f of tc.input_schema.fields) {
    if (!FIELD_NAME_RE.test(f.name)) issues.push(`Tên biến không hợp lệ: "${f.name}"`);
    if (names.has(f.name)) issues.push(`Biến bị trùng: "${f.name}"`);
    names.add(f.name);
  }
  for (const v of extractVariables(tc.steps)) {
    if (!names.has(v)) issues.push(`Biến {{${v}}} trong steps không có trong input_schema`);
  }
  return issues;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && value !== null && "text" in value) {
    return String((value as { text: unknown }).text ?? "");
  }
  if (typeof value === "object" && value !== null && "richText" in value) {
    return ((value as { richText: { text: string }[] }).richText ?? []).map((r) => r.text).join("");
  }
  return String(value);
}

/**
 * `rows` are header-keyed records; `rowOffset` is the spreadsheet row number of rows[0]
 * (2 when the header is on row 1).
 */
export function parseRows(fileName: string, headers: string[], rows: Record<string, unknown>[], rowOffset = 2): ImportPreview {
  const issues: ImportIssue[] = [];
  const normalizedHeaders = headers.map((h) => h.trim().toLowerCase());
  for (const col of REQUIRED_COLUMNS) {
    if (!normalizedHeaders.includes(col)) {
      issues.push({ row: 1, column: col, message: `Thiếu cột "${col}" trong header` });
    }
  }
  if (issues.length > 0) return { file_name: fileName, cases: [], issues };

  const cases: ParsedTestCase[] = [];
  const seen = new Map<string, number>();
  rows.forEach((rawRow, idx) => {
    const rowNo = idx + rowOffset;
    const row: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawRow)) row[k.trim().toLowerCase()] = cellText(v).trim();
    if (REQUIRED_COLUMNS.every((c) => !row[c])) return;

    for (const col of REQUIRED_COLUMNS) {
      if (col === "input") continue;
      if (!row[col]) issues.push({ row: rowNo, column: col, message: `Ô ${col} bị trống` });
    }
    const testId = row.test_id ?? "";
    if (testId) {
      if (seen.has(testId)) {
        issues.push({ row: rowNo, column: "test_id", message: `test_id "${testId}" trùng với dòng ${seen.get(testId)}` });
      } else {
        seen.set(testId, rowNo);
      }
    }
    const steps = parseSteps(row.steps ?? "");
    const { values, error } = parseInputCell(row.input ?? "");
    if (error) issues.push({ row: rowNo, column: "input", message: error });
    for (const key of Object.keys(values)) {
      if (!FIELD_NAME_RE.test(key)) issues.push({ row: rowNo, column: "input", message: `Tên biến không hợp lệ: "${key}"` });
    }
    for (const v of extractVariables(steps)) {
      if (!(v in values)) {
        issues.push({ row: rowNo, column: "steps", message: `Biến {{${v}}} không có trong input` });
      }
    }
    cases.push({
      row: rowNo,
      test_id: testId,
      title: row.title ?? "",
      steps,
      input: values,
      input_schema: buildSchema(values),
      expected_result: row.expected_result ?? "",
      raw: rawRow,
    });
  });
  if (cases.length === 0 && issues.length === 0) {
    issues.push({ row: rowOffset, column: "*", message: "File không có dòng test case nào" });
  }
  return { file_name: fileName, cases, issues };
}

/** Parses the YAML template format shown in the requirement (single or list of cases). */
export function parseYamlCases(fileName: string, text: string): ImportPreview {
  let doc: unknown;
  try {
    doc = YAML.parse(text);
  } catch (e) {
    return { file_name: fileName, cases: [], issues: [{ row: 1, column: "*", message: `YAML lỗi: ${(e as Error).message}` }] };
  }
  const list = Array.isArray(doc) ? doc : [doc];
  const rows = list.map((item) => {
    const o = (item ?? {}) as Record<string, unknown>;
    return {
      test_id: o.test_id,
      title: o.title,
      steps: Array.isArray(o.steps) ? o.steps.join("\n") : o.steps,
      input: o.input && typeof o.input === "object" ? YAML.stringify(o.input) : o.input,
      expected_result: o.expected_result,
    } as Record<string, unknown>;
  });
  return parseRows(fileName, [...REQUIRED_COLUMNS], rows, 1);
}
