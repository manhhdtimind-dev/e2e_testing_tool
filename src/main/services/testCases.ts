import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import ExcelJS from "exceljs";
import Papa from "papaparse";
import type { ImportPreview, InputSchema, InputValues, ParsedTestCase, Project, ProjectTarget, TestCase } from "../../shared/types";
import { checkTestCaseDraft, parseRows, parseSheets, parseYamlCases, type SheetData } from "../../core/parser";
import type { AppContext } from "../context";
import { AppError, newId, now } from "../util";

const sameName = (a: string, b: string) => a.trim().toLocaleLowerCase("vi") === b.trim().toLocaleLowerCase("vi");

export function listProjects(ctx: AppContext) {
  const counts = new Map(
    ctx.repo.db.all<{ project_id: string | null; n: number }>("SELECT project_id, COUNT(*) AS n FROM test_cases GROUP BY project_id").map((r) => [r.project_id, r.n]),
  );
  return ctx.repo.projects.where("1=1 ORDER BY name").map((p) => ({ ...p, case_count: counts.get(p.project_id) ?? 0 }));
}

/** Resolves an existing project, or creates one; a new name equal to an existing project reuses it. */
export function resolveProject(ctx: AppContext, target: ProjectTarget): Project {
  if ("project_id" in target) {
    const p = ctx.repo.projects.get(target.project_id);
    if (!p) throw new AppError("Dự án không tồn tại");
    return p;
  }
  const name = target.new_name.trim().replace(/\s+/g, " ");
  if (!name) throw new AppError("Nhập tên dự án");
  if (name.length > 80) throw new AppError("Tên dự án tối đa 80 ký tự");
  const existing = ctx.repo.projects.where("1=1").find((p) => sameName(p.name, name));
  if (existing) return existing;
  const project: Project = { project_id: newId("prj"), name, created_at: now() };
  ctx.repo.projects.insert(project);
  ctx.repo.audit("project.create", "project", project.project_id, { name });
  return project;
}

export function deleteProject(ctx: AppContext, projectId: string) {
  if (ctx.repo.testCases.where("project_id = ?", projectId).length > 0) throw new AppError("Dự án còn test case, không thể xoá");
  ctx.repo.projects.delete(projectId);
  ctx.repo.audit("project.delete", "project", projectId);
}

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
    if (wb.worksheets.length === 0) return { file_name: name, cases: [], issues: [{ row: 1, column: "*", message: "File xlsx không có sheet nào" }] };
    const sheets: SheetData[] = wb.worksheets.map((ws) => {
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
      return { name: ws.name, headers: headers.filter(Boolean), rows };
    });
    return parseSheets(name, sheets);
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
  /** Required for a new test case; omitted = keep the current project. */
  project?: ProjectTarget;
  /** Omitted = keep the current group. */
  group_name?: string;
}

export function saveTestCase(ctx: AppContext, input: TestCaseInput, action = "testcase.update"): TestCase {
  const issues = checkTestCaseDraft(input);
  if (issues.length > 0) throw new AppError(issues.join("\n"));
  const group = input.group_name?.trim().replace(/\s+/g, " ");
  if (group && group.length > 80) throw new AppError("Tên nhóm tối đa 80 ký tự");
  const schemaNames = new Set(input.input_schema.fields.map((f) => f.name));
  const sample: InputValues = {};
  for (const [k, v] of Object.entries(input.sample_input)) {
    const field = input.input_schema.fields.find((f) => f.name === k);
    if (schemaNames.has(k) && !field?.secret) sample[k] = v;
  }
  const existing = ctx.repo.testCases.get(input.test_id);
  if (!existing && !input.project) throw new AppError("Chọn dự án cho test case");
  const projectId = input.project ? resolveProject(ctx, input.project).project_id : existing!.project_id;
  const ts = now();
  const record: TestCase = {
    test_id: input.test_id.trim(),
    project_id: projectId,
    group_name: group ?? existing?.group_name ?? "",
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
  ctx.repo.audit(action, "test_case", record.test_id, { title: record.title, project_id: record.project_id, group: record.group_name, fields: [...schemaNames] });
  return record;
}

export function confirmImport(ctx: AppContext, fileName: string, target: ProjectTarget, cases: ParsedTestCase[]): { project: Project; cases: TestCase[] } {
  const errors: string[] = [];
  for (const c of cases) {
    const issues = checkTestCaseDraft({ ...c, sample_input: c.input });
    if (issues.length) errors.push(`${c.test_id || `dòng ${c.row}`}: ${issues.join("; ")}`);
  }
  const ids = cases.map((c) => c.test_id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) errors.push(`test_id "${dup}" bị trùng trong file`);
  const targetId = "project_id" in target ? target.project_id : ctx.repo.projects.where("1=1").find((p) => sameName(p.name, target.new_name))?.project_id;
  for (const id of ids) {
    const owner = ctx.repo.testCases.get(id)?.project_id;
    if (owner && owner !== targetId) {
      errors.push(`test_id "${id}" đã thuộc dự án "${ctx.repo.projects.get(owner)?.name ?? owner}" (test_id phải duy nhất trên mọi dự án)`);
    }
  }
  if (errors.length) throw new AppError(errors.join("\n"));
  const result = ctx.repo.db.tx(() => {
    const project = resolveProject(ctx, target);
    const saved = cases.map((c) =>
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
          project: { project_id: project.project_id },
          group_name: c.group,
        },
        "testcase.import",
      ),
    );
    return { project, cases: saved };
  });
  ctx.repo.audit("import.confirm", "file", fileName, {
    count: result.cases.length,
    project_id: result.project.project_id,
    groups: [...new Set(cases.map((c) => c.group))],
    test_ids: ids,
  });
  return result;
}

export function deleteTestCase(ctx: AppContext, testId: string) {
  if (ctx.repo.scripts.where("test_id = ?", testId).length > 0) {
    throw new AppError("Test case đã có script/lịch sử Training, không thể xoá");
  }
  ctx.repo.testCases.delete(testId);
  ctx.repo.audit("testcase.delete", "test_case", testId);
}
