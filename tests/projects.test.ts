import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Db } from "../src/main/db/database";
import { Repo } from "../src/main/db/repo";
import type { AppContext } from "../src/main/context";
import { confirmImport, deleteProject, listProjects, saveTestCase } from "../src/main/services/testCases";
import type { ParsedTestCase } from "../src/shared/types";

let dir: string;
let db: Db;
let ctx: AppContext;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "e2e-prj-"));
  db = new Db(join(dir, "e2e.sqlite"));
  ctx = { repo: new Repo(db) } as AppContext;
});
afterEach(() => {
  db.raw.close();
  rmSync(dir, { recursive: true, force: true });
});

const parsed = (test_id: string, group: string): ParsedTestCase => ({
  row: 2,
  group,
  test_id,
  title: `Case ${test_id}`,
  steps: ["Mở trang"],
  input: {},
  input_schema: { fields: [] },
  expected_result: "ok",
  raw: {},
});

describe("projects and groups", () => {
  it("creates a new project on import and stores each case's group", () => {
    const { project, cases } = confirmImport(ctx, "a.xlsx", { new_name: "  Shop   Admin " }, [parsed("A1", "Đăng nhập"), parsed("A2", "Campaign")]);
    expect(project.name).toBe("Shop Admin");
    expect(cases.map((c) => [c.test_id, c.project_id, c.group_name])).toEqual([
      ["A1", project.project_id, "Đăng nhập"],
      ["A2", project.project_id, "Campaign"],
    ]);
    expect(listProjects(ctx)).toEqual([expect.objectContaining({ name: "Shop Admin", case_count: 2 })]);
  });

  it("reuses an existing project when the new name matches it (case-insensitive)", () => {
    const first = confirmImport(ctx, "a.xlsx", { new_name: "Đơn hàng" }, [parsed("A1", "G")]).project;
    const second = confirmImport(ctx, "b.xlsx", { new_name: "ĐƠN HÀNG" }, [parsed("A1", "G2"), parsed("A3", "G2")]).project;
    expect(second.project_id).toBe(first.project_id);
    expect(ctx.repo.testCases.get("A1")?.group_name).toBe("G2");
    expect(listProjects(ctx)).toHaveLength(1);
  });

  it("rejects a test_id that belongs to another project and creates nothing", () => {
    confirmImport(ctx, "a.xlsx", { new_name: "P1" }, [parsed("A1", "G")]);
    expect(() => confirmImport(ctx, "b.xlsx", { new_name: "P2" }, [parsed("B1", "G"), parsed("A1", "G")])).toThrow(/đã thuộc dự án "P1"/);
    expect(listProjects(ctx).map((p) => p.name)).toEqual(["P1"]);
    expect(ctx.repo.testCases.get("B1")).toBeUndefined();
  });

  it("requires a project for a new test case and keeps project/group on partial updates", () => {
    const base = { test_id: "M1", title: "t", steps: ["a"], input_schema: { fields: [] }, sample_input: {}, expected_result: "ok" };
    expect(() => saveTestCase(ctx, base)).toThrow(/Chọn dự án/);
    const created = saveTestCase(ctx, { ...base, project: { new_name: "P" }, group_name: " Nhóm  A " });
    expect(created.group_name).toBe("Nhóm A");
    const updated = saveTestCase(ctx, { ...base, title: "t2" });
    expect([updated.project_id, updated.group_name]).toEqual([created.project_id, "Nhóm A"]);
  });

  it("deletes only empty projects", () => {
    const { project } = confirmImport(ctx, "a.xlsx", { new_name: "P" }, [parsed("A1", "G")]);
    expect(() => deleteProject(ctx, project.project_id)).toThrow(/còn test case/);
    ctx.repo.testCases.delete("A1");
    deleteProject(ctx, project.project_id);
    expect(listProjects(ctx)).toEqual([]);
  });
});
