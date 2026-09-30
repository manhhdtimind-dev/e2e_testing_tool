import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppContext } from "../src/main/context";
import { initPaths } from "../src/main/paths";
import { DEFAULT_SETTINGS } from "../src/main/services/settings";
import type { Environment } from "../src/shared/types";

const runJob = vi.fn();
vi.mock("../src/main/runner/runnerHost", () => ({ runJob: (...a: unknown[]) => runJob(...a), setRunnerConcurrency: () => undefined }));
vi.mock("../src/main/services/environments", () => ({ environmentSecrets: () => ({}), getEnvironment: () => undefined }));

const { runVerification } = await import("../src/main/services/execution");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "e2e-verify-"));
  initPaths(join(dir, "data"));
  runJob.mockReset();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("draft verification run", () => {
  it("creates its own run folder inside the attempt", async () => {
    runJob.mockResolvedValue({ ok: true, error_code: null, error_message: null, screenshots: [], trace: null, steps: [] });
    const ctx = { settings: () => DEFAULT_SETTINGS, secrets: { get: () => null } } as unknown as AppContext;
    const env = { environment_id: "env_1", base_url: "https://example.test", allowed_domains: ["example.test"], runner_auth_ref: null } as unknown as Environment;
    const runDir = join(dir, "data", "artifacts", "attempts", "att_1", "verify-1");

    const { result } = await runVerification(ctx, runDir, "export async function run() {}", env, { runtime: {}, snapshot: {}, secretValues: [] });

    expect(result.ok).toBe(true);
    expect(existsSync(join(runDir, "source.ts"))).toBe(true);
    expect(existsSync(join(runDir, "result.json"))).toBe(true);
    expect(runJob.mock.calls[0][0]).toMatchObject({ runDir, headless: true, slowMoMs: 0 });
  });
});
