import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Db } from "../src/main/db/database";
import { Repo } from "../src/main/db/repo";
import type { SecretStore } from "../src/main/services/secrets";
import { getSettings, updateSettings } from "../src/main/services/settings";
import type { CodexReasoningEffort } from "../src/shared/types";

let dir: string;
let db: Db;
let repo: Repo;
const secrets = { has: () => false } as unknown as SecretStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "e2e-set-"));
  db = new Db(join(dir, "e2e.sqlite"));
  repo = new Repo(db);
});
afterEach(() => {
  db.raw.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("codex reasoning effort", () => {
  it("defaults to medium instead of the user's personal Codex config", () => {
    expect(getSettings(repo, secrets).codex_reasoning_effort).toBe("medium");
  });

  it("keeps allowed values, including empty for the personal config, and rejects others", () => {
    expect(updateSettings(repo, secrets, { codex_reasoning_effort: "low" }).codex_reasoning_effort).toBe("low");
    expect(updateSettings(repo, secrets, { codex_reasoning_effort: "" }).codex_reasoning_effort).toBe("");
    expect(updateSettings(repo, secrets, { codex_reasoning_effort: "ultra" as CodexReasoningEffort }).codex_reasoning_effort).toBe("medium");
  });
});
