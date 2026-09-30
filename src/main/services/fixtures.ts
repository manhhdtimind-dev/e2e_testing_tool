import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { InputValues, ProjectFixture, TestCase } from "../../shared/types";
import { isSafeFixtureName } from "../../core/inputValidation";
import type { AppContext } from "../context";
import { paths } from "../paths";
import { AppError } from "../util";

export const MAX_FIXTURE_BYTES = 50 * 1024 * 1024;

function projectDir(projectId: string): string {
  if (!/^[\w-]+$/.test(projectId)) throw new AppError("Mã dự án không hợp lệ");
  return join(paths().fixtures, projectId);
}

function requireProject(ctx: AppContext, projectId: string): string {
  if (!ctx.repo.projects.get(projectId)) throw new AppError("Dự án không tồn tại");
  return projectDir(projectId);
}

/** Turns an arbitrary file name into a safe fixture name (keeps the extension). */
export function toFixtureName(fileName: string): string {
  let name = basename(fileName)
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
    .trim()
    .replace(/\.+$/, "");
  if (name.length > 200) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
    name = name.slice(0, 200 - ext.length) + ext;
  }
  if (!isSafeFixtureName(name)) name = `file_${name.replace(/^\.+/, "")}`.slice(0, 200);
  return isSafeFixtureName(name) ? name : "file";
}

export function listFixtures(ctx: AppContext, projectId: string): ProjectFixture[] {
  const dir = requireProject(ctx, projectId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && isSafeFixtureName(d.name))
    .map((d) => {
      const st = statSync(join(dir, d.name));
      return { name: d.name, size: st.size, modified_at: st.mtime.toISOString() };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "vi", { numeric: true }));
}

/** Copies files into the project's fixtures folder; a file with the same name is replaced. */
export function addFixtures(ctx: AppContext, projectId: string, sources: string[]) {
  const dir = requireProject(ctx, projectId);
  mkdirSync(dir, { recursive: true });
  const added: string[] = [];
  const skipped: { file: string; reason: string }[] = [];
  for (const src of sources) {
    const file = basename(src);
    let st;
    try {
      st = statSync(src);
    } catch {
      skipped.push({ file, reason: "không đọc được file" });
      continue;
    }
    if (!st.isFile()) {
      skipped.push({ file, reason: "không phải file" });
      continue;
    }
    if (st.size > MAX_FIXTURE_BYTES) {
      skipped.push({ file, reason: `lớn hơn ${MAX_FIXTURE_BYTES / 1024 / 1024} MB` });
      continue;
    }
    const name = toFixtureName(file);
    copyFileSync(src, join(dir, name));
    added.push(name);
  }
  if (added.length) ctx.repo.audit("fixture.add", "project", projectId, { files: added });
  return { added, skipped, fixtures: listFixtures(ctx, projectId) };
}

export function deleteFixture(ctx: AppContext, projectId: string, name: string): ProjectFixture[] {
  const dir = requireProject(ctx, projectId);
  if (!isSafeFixtureName(name)) throw new AppError("Tên file không hợp lệ");
  rmSync(join(dir, name), { force: true });
  ctx.repo.audit("fixture.delete", "project", projectId, { file: name });
  return listFixtures(ctx, projectId);
}

export function removeProjectFixtures(projectId: string): void {
  rmSync(projectDir(projectId), { recursive: true, force: true });
}

/** Absolute path of a project fixture, or null when it does not exist. */
export function fixturePath(projectId: string | null, name: string): string | null {
  if (!projectId || !isSafeFixtureName(name)) return null;
  const p = join(projectDir(projectId), name);
  try {
    return statSync(p).isFile() ? p : null;
  } catch {
    return null;
  }
}

/**
 * Maps the file fields of an input to absolute fixture paths.
 * Returns the paths and one issue per missing file.
 */
export function resolveFileFields(tc: TestCase, values: InputValues): { paths: Record<string, string>; issues: string[] } {
  const out: Record<string, string> = {};
  const issues: string[] = [];
  for (const f of tc.input_schema.fields) {
    const name = values[f.name];
    if (f.type !== "file" || name === undefined || name === "") continue;
    if (!tc.project_id) {
      issues.push(`"${f.name}" là biến file nhưng test case chưa thuộc dự án nào (file mẫu được lưu theo dự án)`);
      continue;
    }
    const p = fixturePath(tc.project_id, name);
    if (p) out[f.name] = p;
    else issues.push(`File mẫu "${name}" của biến "${f.name}" không có trong dự án; thêm file ở trang Test Cases → File mẫu`);
  }
  return { paths: out, issues };
}

/** Copies the given fixtures into `dir` (emptied first); returns field → absolute path of the copy. */
export function copyFixturesTo(tc: TestCase, values: InputValues, dir: string): { paths: Record<string, string>; issues: string[] } {
  rmSync(dir, { recursive: true, force: true });
  const resolved = resolveFileFields(tc, values);
  const out: Record<string, string> = {};
  if (Object.keys(resolved.paths).length) mkdirSync(dir, { recursive: true });
  for (const [field, src] of Object.entries(resolved.paths)) {
    const dest = join(dir, basename(src));
    if (!existsSync(dest)) copyFileSync(src, dest);
    out[field] = dest;
  }
  return { paths: out, issues: resolved.issues };
}
