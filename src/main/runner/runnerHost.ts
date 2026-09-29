import { fork } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunnerJob, RunnerMessage } from "../../shared/runnerJob";
import type { RunnerResult, StepLog } from "../../shared/types";

const runnerEntry = join(dirname(fileURLToPath(import.meta.url)), "..", "runner", "runner.cjs");

export interface RunOptions {
  fsRestricted: boolean;
  onStep?: (s: StepLog) => void;
}

class Semaphore {
  private active = 0;
  private waiters: (() => void)[] = [];
  constructor(public limit: number) {}
  async acquire() {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
  }
  release() {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }
}

const semaphore = new Semaphore(2);

export function setRunnerConcurrency(limit: number) {
  semaphore.limit = limit;
}

function failure(message: string): RunnerResult {
  return { ok: false, error_code: "EXCEPTION", error_message: message, steps: [], screenshots: [], trace: null, duration_ms: 0, final_url: null };
}

/**
 * Executes a job in an isolated child process (Electron-as-Node). The storage state is written
 * decrypted into the run dir only for the duration of the run.
 */
export async function runJob(job: Omit<RunnerJob, "storageStatePath">, storageState: string | null, opts: RunOptions): Promise<RunnerResult> {
  await semaphore.acquire();
  const statePath = storageState ? join(job.runDir, ".auth-state.json") : null;
  try {
    if (statePath && storageState) writeFileSync(statePath, storageState, { mode: 0o600 });
    const fullJob: RunnerJob = { ...job, storageStatePath: statePath };
    return await spawnRunner(fullJob, opts);
  } finally {
    if (statePath && existsSync(statePath)) rmSync(statePath, { force: true });
    semaphore.release();
  }
}

function spawnRunner(job: RunnerJob, opts: RunOptions): Promise<RunnerResult> {
  return new Promise((resolve) => {
    const execArgv = opts.fsRestricted
      ? [
          "--permission",
          "--allow-fs-read=*",
          `--allow-fs-write=${job.runDir}`,
          `--allow-fs-write=${tmpdir()}`,
          "--allow-child-process",
          "--disable-warning=SecurityWarning",
        ]
      : [];
    const child = fork(runnerEntry, [], {
      execPath: process.execPath,
      execArgv,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let settled = false;
    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr = (stderr + d.toString()).slice(-6000);
    });
    child.stdout?.on("data", () => undefined);
    const killTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        resolve({ ...failure(`Runner vượt quá thời gian cho phép (${Math.round(job.timeoutMs / 1000)}s) và đã bị dừng`), error_code: "TIMEOUT" });
      }
    }, job.timeoutMs + 60_000);
    child.on("message", (msg: RunnerMessage) => {
      if (msg.type === "step") opts.onStep?.(msg.step);
      if (msg.type === "result" && !settled) {
        settled = true;
        clearTimeout(killTimer);
        resolve(msg.result);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(killTimer);
      if (!settled) {
        settled = true;
        resolve(failure(`Runner thoát bất thường (code ${code}). ${stderr.trim()}`));
      }
    });
    child.send(job);
  });
}
