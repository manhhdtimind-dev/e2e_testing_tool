import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { Db, MIGRATIONS } from "../src/main/db/database";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("migrations", () => {
  it("makes versions.trial_id nullable and keeps existing versions and the immutability trigger", () => {
    const dir = mkdtempSync(join(tmpdir(), "e2e-mig-"));
    dirs.push(dir);
    const file = join(dir, "e2e.sqlite");
    const old = new DatabaseSync(file);
    old.exec(MIGRATIONS[0]);
    old.exec(MIGRATIONS[1]);
    old.exec("PRAGMA user_version = 2");
    old.exec(`INSERT INTO test_cases VALUES ('TC1','t','[]','{"fields":[]}','{}','e',NULL,'x','x','x')`);
    old.exec(`INSERT INTO scripts VALUES ('s1','TC1','codex',NULL,'x')`);
    old.exec(`INSERT INTO versions VALUES ('s1',1,'c1','h1','src','trial1','e1','APPROVED','x','me')`);
    old.close();

    const db = new Db(file);
    expect(db.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(MIGRATIONS.length);
    expect(db.get("SELECT trial_id, source FROM versions WHERE version_no = 1")).toEqual({ trial_id: "trial1", source: "src" });
    db.run(`INSERT INTO versions VALUES ('s1',2,'c2','h2','src2',NULL,'e1','APPROVED','x','me')`);
    expect(db.get("SELECT trial_id FROM versions WHERE version_no = 2")).toEqual({ trial_id: null });
    expect(() => db.run("UPDATE versions SET source = 'changed' WHERE version_no = 1")).toThrow(/immutable/);
    db.raw.close();
  });
});
