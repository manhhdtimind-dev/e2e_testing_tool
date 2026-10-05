import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Db } from "../src/main/db/database";
import { Repo } from "../src/main/db/repo";
import type { AppContext } from "../src/main/context";
import { SecretStore } from "../src/main/services/secrets";
import { environmentSecretFields, environmentSecrets, environmentSecretStatus, saveEnvironment, setEnvironmentSecret } from "../src/main/services/environments";
import { confirmImport } from "../src/main/services/testCases";
import type { ParsedTestCase } from "../src/shared/types";

let dir: string;
let db: Db;
let ctx: AppContext;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "e2e-envsec-"));
  db = new Db(join(dir, "e2e.sqlite"));
  const repo = new Repo(db);
  const secrets = new SecretStore(db, { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => "" });
  ctx = { repo, secrets } as unknown as AppContext;
});
afterEach(() => {
  db.raw.close();
  rmSync(dir, { recursive: true, force: true });
});

const caseWith = (test_id: string, fields: { name: string; secret?: boolean }[]): ParsedTestCase => ({
  row: 2,
  group: "G",
  test_id,
  title: test_id,
  steps: ["Mở trang"],
  input: {},
  input_schema: { fields: fields.map((f) => ({ name: f.name, type: "string", required: true, secret: !!f.secret })) },
  expected_result: "ok",
  raw: {},
});

describe("environment secret fields", () => {
  it("come from variables marked Secret in test cases, with no list to fill in on the environment", () => {
    const env = saveEnvironment(ctx, { name: "Staging", base_url: "https://staging.example.com", allowed_domains: [] });
    expect(environmentSecretFields(ctx, env)).toEqual([]);

    confirmImport(ctx, "a.xlsx", { new_name: "P" }, [caseWith("A1", [{ name: "warehouse_api_key", secret: true }, { name: "title" }])]);
    expect(environmentSecretFields(ctx, env)).toEqual(["warehouse_api_key"]);

    setEnvironmentSecret(ctx, env.environment_id, "warehouse_api_key", "k-123");
    expect(environmentSecretStatus(ctx, env.environment_id)).toEqual({ warehouse_api_key: true });
    expect(environmentSecrets(ctx, env.environment_id)).toEqual({ warehouse_api_key: "k-123" });
    expect(() => setEnvironmentSecret(ctx, env.environment_id, "title", "x")).toThrow(/không phải biến secret/);
  });

  it("keeps names saved on older environments when the form no longer sends them", () => {
    const env = saveEnvironment(ctx, { name: "Old", base_url: "https://old.example.com", allowed_domains: [], secret_fields: ["password"] });
    const updated = saveEnvironment(ctx, { environment_id: env.environment_id, name: "Old 2", base_url: env.base_url, allowed_domains: [] });
    expect(updated.secret_fields).toEqual(["password"]);
    expect(environmentSecretFields(ctx, updated)).toEqual(["password"]);
  });
});
