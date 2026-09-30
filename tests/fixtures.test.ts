import { existsSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Db } from "../src/main/db/database";
import { Repo } from "../src/main/db/repo";
import type { AppContext } from "../src/main/context";
import { initPaths } from "../src/main/paths";
import { addFixtures, copyFixturesTo, deleteFixture, listFixtures, MAX_FIXTURE_BYTES, resolveFileFields, toFixtureName } from "../src/main/services/fixtures";
import { confirmImport } from "../src/main/services/testCases";
import { parseRows } from "../src/core/parser";
import { fieldTsType, isSafeFixtureName, validateInput } from "../src/core/inputValidation";
import { validateScript } from "../src/core/scriptValidator";
import { buildRecordedScript, type RecordingEvent } from "../src/core/recording";
import { fileInputsBlock, rulesBlock } from "../src/main/training/prompt";
import type { InputSchema, TestCase } from "../src/shared/types";

const schema: InputSchema = {
  fields: [
    { name: "title", type: "string", required: true, secret: false },
    { name: "banner", type: "file", required: true, secret: false },
  ],
};

describe("file input type", () => {
  it("accepts only bare, Windows-safe file names", () => {
    for (const ok of ["banner.png", "Ảnh bìa 1.jpg", "a", ".env.sample"]) expect(isSafeFixtureName(ok), ok).toBe(true);
    for (const bad of ["", "../x.png", "a/b.png", "C:\\x.png", "x.png.", " x.png", "con", "NUL.txt", "..", "a*b", "a\u0001b"]) expect(isSafeFixtureName(bad), bad).toBe(false);
  });

  it("validates file values and maps the TS type to string", () => {
    expect(validateInput(schema, { title: "t", banner: "banner.png" })).toEqual([]);
    expect(validateInput(schema, { title: "t", banner: "C:\\Users\\me\\banner.png" })).toEqual([expect.stringContaining('"banner" phải là tên một file mẫu')]);
    expect(fieldTsType("file")).toBe("string");
    expect(fieldTsType("number")).toBe("number");
  });

  it("sanitizes imported file names", () => {
    expect(toFixtureName("C:\\tmp\\banner.png")).toBe("banner.png");
    expect(toFixtureName("a*b?.png")).toBe("a_b_.png");
    expect(toFixtureName("con.txt")).toBe("file_con.txt");
    const long = toFixtureName(`${"x".repeat(300)}.png`);
    expect(long.length).toBe(200);
    expect(long.endsWith(".png")).toBe(true);
  });
});

describe("import infers file fields", () => {
  const typesOf = (steps: string, input: string) => {
    const p = parseRows("x.csv", ["test_id", "title", "steps", "input", "expected_result"], [{ test_id: "T1", title: "t", steps, input, expected_result: "ok" }]);
    return Object.fromEntries(p.cases[0].input_schema.fields.map((f) => [f.name, f.type]));
  };

  it("marks variables of upload steps and bare file names as file", () => {
    expect(
      typesOf(
        '1. Mở trang Upload videos (/youtube-uploads/upload)\n2. Tải file "Drop or Select files to upload" = {{video_file}}\n3. Nhập "Product URL" = {{product_url}}',
        'video_file: mug-noel-de-famille.mp4\nproduct_url: "https://cadeauplus.com/products/mug-noel-de-famille"',
      ),
    ).toEqual({ video_file: "file", product_url: "string" });
    expect(typesOf('Upload "CV" = {{cv}}\nNhập "Tên" = {{name}}', "cv: ho-so\nname: An")).toEqual({ cv: "file", name: "string" });
    expect(typesOf('Nhập "Ảnh" = {{img}}', "img: banner.png")).toEqual({ img: "file" });
  });

  it("keeps strings for downloads, paths and URLs", () => {
    expect(typesOf('Tải file xuống "Báo cáo" = {{report}}', "report: bao-cao")).toEqual({ report: "string" });
    expect(typesOf('Tải file "Ảnh" = {{img}}', "img: C:\\Users\\me\\a.png")).toEqual({ img: "string" });
    expect(typesOf('Nhập "Link" = {{url}}', 'url: "https://cdn.x/a.png"')).toEqual({ url: "string" });
  });
});

describe("project fixtures", () => {
  let dir: string;
  let db: Db;
  let ctx: AppContext;
  let tc: TestCase;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "e2e-fx-"));
    initPaths(join(dir, "data"));
    db = new Db(join(dir, "e2e.sqlite"));
    ctx = { repo: new Repo(db) } as AppContext;
    const res = confirmImport(ctx, "a.xlsx", { new_name: "P" }, [
      { row: 2, group: "G", test_id: "U1", title: "Upload", steps: ["Tải {{banner}}"], input: { title: "t", banner: "banner.png" }, input_schema: schema, expected_result: "ok", raw: {} },
    ]);
    tc = res.cases[0];
  });
  afterEach(() => {
    db.raw.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("adds, lists, resolves, copies and deletes fixtures", () => {
    const src = join(dir, "banner.png");
    writeFileSync(src, "PNGDATA");
    const res = addFixtures(ctx, tc.project_id!, [src, join(dir, "missing.png"), dir]);
    expect(res.added).toEqual(["banner.png"]);
    expect(res.skipped.map((s) => s.file)).toEqual(["missing.png", dir.split(/[\\/]/).pop()]);
    expect(listFixtures(ctx, tc.project_id!)).toEqual([expect.objectContaining({ name: "banner.png", size: 7 })]);

    const resolved = resolveFileFields(tc, { title: "t", banner: "banner.png" });
    expect(resolved.issues).toEqual([]);
    expect(readFileSync(resolved.paths.banner, "utf8")).toBe("PNGDATA");
    expect(resolveFileFields(tc, { banner: "other.png" }).issues).toEqual([expect.stringContaining('File mẫu "other.png"')]);
    expect(resolveFileFields({ ...tc, project_id: null }, { banner: "banner.png" }).issues).toEqual([expect.stringContaining("chưa thuộc dự án")]);

    const out = join(dir, "mcp", "fixtures");
    const copied = copyFixturesTo(tc, { banner: "banner.png" }, out);
    expect(copied.paths.banner).toBe(join(out, "banner.png"));
    expect(readFileSync(copied.paths.banner, "utf8")).toBe("PNGDATA");

    expect(deleteFixture(ctx, tc.project_id!, "banner.png")).toEqual([]);
    expect(() => deleteFixture(ctx, tc.project_id!, "../e2e.sqlite")).toThrow(/không hợp lệ/);
    expect(existsSync(join(dir, "e2e.sqlite"))).toBe(true);
    expect(ctx.repo.listAudit().filter((a) => a.action.startsWith("fixture.")).map((a) => a.action)).toEqual(expect.arrayContaining(["fixture.add", "fixture.delete"]));
  });

  it("rejects files over the size limit", () => {
    const empty = join(dir, "empty.bin");
    writeFileSync(empty, "");
    const huge = join(dir, "huge.bin");
    writeFileSync(huge, "");
    truncateSync(huge, MAX_FIXTURE_BYTES + 1);
    const res = addFixtures(ctx, tc.project_id!, [huge, empty]);
    expect(res.added).toEqual(["empty.bin"]);
    expect(res.skipped).toEqual([expect.objectContaining({ file: "huge.bin" })]);
  });
});

describe("scripts with file inputs", () => {
  it("rejects literal upload paths and accepts input.<file field>", () => {
    const base = (body: string) => `import type { Page } from "@playwright/test";\nexport async function run(page: Page, input: { title: string; banner: string }) {\n  await page.fill("#t", input.title);\n${body}\n}\n`;
    const opts = { schema, sampleInput: { title: "hello", banner: "banner.png" } };
    const bad = validateScript(base('  await page.getByLabel("Banner").setInputFiles("C:/data/fixtures/x.png");'), opts);
    expect(bad.issues.map((i) => i.code)).toContain("HARDCODED_FILE");
    const chooser = validateScript(base("  const c = await page.waitForEvent(\"filechooser\");\n  await c.setFiles(['a.png']);"), opts);
    expect(chooser.issues.map((i) => i.code)).toContain("HARDCODED_FILE");
    const good = validateScript(base("  await page.getByLabel(\"Banner\").setInputFiles(input.banner);"), opts);
    expect(good.issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("maps a recorded upload to input.<file field> by the chosen file name", () => {
    const shot = (files: string[], code: string): RecordingEvent => ({
      kind: "action",
      t: 1,
      page: 0,
      url: "http://x.test/assets/upload",
      action: { name: "setInputFiles", selector: 'internal:label="Banner file"i', files },
      code,
    });
    const build = (events: RecordingEvent[], sample = { title: "t", banner: "banner.png" }) =>
      buildRecordedScript(events, { baseUrl: "http://x.test", schema, sample, secrets: {}, steps: [], closeAtEnd: false });

    const ok = build([shot(["banner.png"], "await page.getByLabel('Banner file').setInputFiles('banner.png');")]);
    expect(ok.source).toContain("await page.getByLabel('Banner file').setInputFiles(input.banner);");
    expect(ok.source).toContain("banner: string");
    expect(ok.notes).toEqual([]);

    const fakePath: RecordingEvent = {
      kind: "action",
      t: 1,
      page: 0,
      url: "http://x.test/assets/upload",
      action: { name: "fill", selector: 'internal:role=button[name="Banner file"i]', text: "C:\\fakepath\\banner.png" },
      code: "await page.getByRole('button', { name: 'Banner file' }).fill('C:\\\\fakepath\\\\banner.png');",
    };
    const api = build([fakePath]);
    expect(api.source).toContain("await page.getByRole('button', { name: 'Banner file' }).setInputFiles(input.banner);");
    expect(api.source).not.toContain("fakepath");
    expect(api.notes).toEqual([]);

    const other = build([shot(["other.png"], "await page.getByLabel('Banner file').setInputFiles('other.png');")]);
    expect(other.source).toContain("setInputFiles(input.banner)");
    expect(other.notes.join("\n")).toContain("khác input mẫu");

    const many = build([shot(["a.png", "b.png"], "await page.getByLabel('Banner file').setInputFiles(['a.png', 'b.png']);")]);
    expect(many.source).toContain("// Cần sửa: tải file lên");
    expect(many.source).not.toContain("a.png'");

    const noField = buildRecordedScript([shot(["banner.png"], "await page.getByLabel('Banner file').setInputFiles('banner.png');")], {
      baseUrl: "http://x.test",
      schema: { fields: [schema.fields[0]] },
      sample: { title: "t" },
      secrets: {},
      steps: [],
      closeAtEnd: false,
    });
    expect(noField.notes.join("\n")).toContain("chưa có biến kiểu file");
  });

  it("tells the agent how to upload the sample files", () => {
    const block = fileInputsBlock([{ field: "banner", name: "banner.png", path: "C:\\data\\attempts\\a1\\mcp-output\\fixtures\\banner.png" }]);
    expect(block).toContain("browser_file_upload");
    expect(block).toContain("setInputFiles(input.<field>)");
    expect(block).toContain("mcp-output\\fixtures\\banner.png");
    expect(fileInputsBlock([])).toBe("");
    const tc = { input_schema: schema, steps: ["a"] } as unknown as TestCase;
    expect(rulesBlock(tc, 10)).toContain("type Input = { title: string; banner: string };");
  });
});
