import { rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import type {
  CandidateRevision,
  Environment,
  Evidence,
  InputValues,
  RunnerResult,
  ReviewResult,
  ScriptVersion,
  TestCase,
  TestRun,
  TrialRun,
} from "../../shared/types";
import { coerceInput, maskInput, secretFieldNames, validateInput } from "../../core/inputValidation";
import { transpileScript } from "../../core/scriptValidator";
import { checkApprove, isVersionSelectable, nextVersionNo } from "../../core/rules";
import { marksVersionBroken } from "../../core/errorClassifier";
import type { AppContext } from "../context";
import { artifactDir, paths, toArtifactRef } from "../paths";
import { AppError, newId, now, sha256 } from "../util";
import { environmentSecrets, getEnvironment } from "./environments";
import { secretKeys } from "./secrets";
import { runJob, setRunnerConcurrency } from "../runner/runnerHost";

function testCaseForScript(ctx: AppContext, scriptId: string): TestCase {
  const script = ctx.repo.scripts.get(scriptId);
  if (!script) throw new AppError("Không tìm thấy script");
  const tc = ctx.repo.testCases.get(script.test_id);
  if (!tc) throw new AppError("Không tìm thấy test case của script");
  return tc;
}

/** Secret fields are filled from the environment's secret store, never from user-visible input. */
function resolveInput(ctx: AppContext, tc: TestCase, env: Environment, input: InputValues) {
  const envSecrets = environmentSecrets(ctx, env.environment_id);
  const secretNames = secretFieldNames(tc.input_schema, env.secret_fields);
  const full: InputValues = {};
  for (const f of tc.input_schema.fields) {
    if (f.secret || env.secret_fields.includes(f.name)) {
      if (envSecrets[f.name] !== undefined) full[f.name] = envSecrets[f.name];
    } else if (input[f.name] !== undefined) {
      full[f.name] = input[f.name];
    }
  }
  const issues = validateInput(tc.input_schema, full);
  const missingSecrets = tc.input_schema.fields.filter((f) => (f.secret || env.secret_fields.includes(f.name)) && full[f.name] === undefined && f.required);
  if (missingSecrets.length) {
    issues.push(...missingSecrets.map((f) => `Secret "${f.name}" chưa được cấu hình trong environment "${env.name}"`));
  }
  return {
    issues: [...new Set(issues)],
    runtime: coerceInput(tc.input_schema, full),
    snapshot: maskInput(full, secretNames),
    secretValues: [...secretNames].map((n) => full[n]).filter((v): v is string => !!v),
  };
}

async function execute(
  ctx: AppContext,
  dir: string,
  source: string,
  env: Environment,
  runtime: Record<string, string | number | boolean>,
  secretValues: string[],
  onStep: (count: number) => void,
  opts: { fast?: boolean } = {},
): Promise<{ result: RunnerResult; evidence: Evidence }> {
  const settings = ctx.settings();
  setRunnerConcurrency(settings.max_concurrent_runs);
  const headless = opts.fast || settings.runner_headless;
  writeFileSync(join(dir, "source.ts"), source);
  const compiledPath = join(dir, "script.cjs");
  writeFileSync(compiledPath, transpileScript(source));
  const storageState = env.runner_auth_ref ? ctx.secrets.get(env.runner_auth_ref) : null;
  let steps = 0;
  const result = await runJob(
    {
      runDir: dir,
      compiledPath,
      input: runtime,
      secretValues: [...secretValues, ...Object.values(environmentSecrets(ctx, env.environment_id))],
      baseUrl: env.base_url,
      allowedDomains: env.allowed_domains,
      browser: settings.runner_browser,
      headless,
      timeoutMs: settings.run_timeout_sec * 1000,
      actionTimeoutMs: 15_000,
      navigationTimeoutMs: 30_000,
      traceOnSuccess: false,
      keepOpen: !headless && settings.runner_keep_open,
      slowMoMs: headless ? 0 : settings.runner_slow_mo_ms,
    },
    storageState,
    { fsRestricted: settings.runner_fs_restricted, onStep: () => onStep(++steps) },
  );
  writeFileSync(join(dir, "result.json"), JSON.stringify({ ...result, steps: undefined }, null, 2));
  const evidence: Evidence = {
    steps: toArtifactRef(join(dir, "steps.json")),
    log: toArtifactRef(join(dir, "result.json")),
    ...(result.screenshots.length
      ? { screenshot: toArtifactRef(result.screenshots.at(-1)!), screenshots: result.screenshots.map((p) => toArtifactRef(p)) }
      : {}),
    ...(result.trace ? { trace: toArtifactRef(result.trace) } : {}),
  };
  return { result, evidence };
}

// ---------------- Trial ----------------

export function markCandidateReviewed(ctx: AppContext, candidateId: string): CandidateRevision {
  const c = ctx.repo.candidates.get(candidateId);
  if (!c) throw new AppError("Không tìm thấy candidate");
  if (!c.reviewed_at) {
    ctx.repo.candidates.update([candidateId], { reviewed_at: now() });
    ctx.repo.audit("candidate.review", "candidate", candidateId, { revision_no: c.revision_no });
  }
  return ctx.repo.candidates.get(candidateId)!;
}

export function startTrial(ctx: AppContext, candidateId: string, environmentId: string, input: InputValues): TrialRun {
  const candidate = ctx.repo.candidates.get(candidateId);
  if (!candidate) throw new AppError("Không tìm thấy candidate");
  if (sha256(candidate.source) !== candidate.source_hash) throw new AppError("Source của candidate không khớp source_hash");
  const tc = testCaseForScript(ctx, candidate.script_id);
  const env = getEnvironment(ctx, environmentId);
  const resolved = resolveInput(ctx, tc, env, input);
  if (resolved.issues.length) throw new AppError(`Input không hợp lệ:\n${resolved.issues.join("\n")}`);

  const trial: TrialRun = {
    trial_id: newId("trial"),
    candidate_id: candidate.candidate_id,
    source_hash: candidate.source_hash,
    environment_id: env.environment_id,
    input_snapshot: resolved.snapshot,
    status: "QUEUED",
    error_code: null,
    error_message: null,
    evidence_refs: {},
    created_at: now(),
    started_at: null,
    finished_at: null,
  };
  ctx.repo.trials.insert(trial);
  ctx.repo.audit("trial.start", "trial", trial.trial_id, { candidate_id: candidateId, source_hash: candidate.source_hash, environment_id: env.environment_id });
  ctx.emit("trial:update", trial);

  void (async () => {
    const update = (patch: Partial<TrialRun>) => {
      Object.assign(trial, patch);
      ctx.repo.trials.update([trial.trial_id], patch);
      ctx.emit("trial:update", { ...trial });
    };
    update({ status: "RUNNING", started_at: now() });
    try {
      const { result, evidence } = await execute(ctx, artifactDir("trials", trial.trial_id), candidate.source, env, resolved.runtime, resolved.secretValues, (n) =>
        ctx.emit("trial:update", { ...trial, step_count: n }),
      );
      update({
        status: result.ok ? "PASSED" : result.error_code === "AUTH_REQUIRED" ? "AUTH_REQUIRED" : "FAILED",
        error_code: result.error_code,
        error_message: result.error_message,
        evidence_refs: evidence,
        finished_at: now(),
      });
    } catch (e) {
      update({ status: "FAILED", error_code: "EXCEPTION", error_message: (e as Error).message, finished_at: now() });
    }
    ctx.repo.audit("trial.finish", "trial", trial.trial_id, { status: trial.status, error_code: trial.error_code });
  })();
  return trial;
}

/** Deletes finished trials of a candidate and their artifacts; trials still running or referenced by a version are kept. */
export function clearTrials(ctx: AppContext, candidateId: string): { removed: number; kept: number } {
  const trials = ctx.repo.trials.where("candidate_id = ?", candidateId);
  const linked = new Set(
    ctx.repo.db
      .all<{ trial_id: string }>("SELECT trial_id FROM versions WHERE candidate_id = ? AND trial_id IS NOT NULL", candidateId)
      .map((r) => r.trial_id),
  );
  const removable = trials.filter((t) => t.status !== "QUEUED" && t.status !== "RUNNING" && !linked.has(t.trial_id));
  ctx.repo.db.tx(() => {
    for (const t of removable) ctx.repo.trials.delete(t.trial_id);
  });
  for (const t of removable) rmSync(join(paths().artifacts, "trials", t.trial_id), { recursive: true, force: true });
  const result = { removed: removable.length, kept: trials.length - removable.length };
  ctx.repo.audit("trial.clear", "candidate", candidateId, { ...result, trial_ids: removable.map((t) => t.trial_id) });
  return result;
}

// ---------------- Approve ----------------

export function approveCandidate(ctx: AppContext, candidateId: string, environmentId: string): ScriptVersion {
  const candidate = ctx.repo.candidates.get(candidateId);
  if (!candidate) throw new AppError("Không tìm thấy candidate");
  const trials = ctx.repo.trials.where("candidate_id = ?", candidateId);
  const check = checkApprove(candidate, trials, environmentId);
  if (!check.ok) throw new AppError(check.reason!);
  if (sha256(candidate.source) !== candidate.source_hash) throw new AppError("Source của candidate không khớp source_hash");
  getEnvironment(ctx, environmentId);
  const version = ctx.repo.db.tx(() => {
    const versions = ctx.repo.versions.where("script_id = ?", candidate.script_id);
    const v: ScriptVersion = {
      script_id: candidate.script_id,
      version_no: nextVersionNo(versions),
      candidate_id: candidate.candidate_id,
      source_hash: candidate.source_hash,
      source: candidate.source,
      trial_id: check.trial?.trial_id ?? null,
      environment_id: environmentId,
      status: "APPROVED",
      approved_at: now(),
      approved_by: userInfo().username,
    };
    ctx.repo.versions.insert(v);
    ctx.repo.candidates.update([candidate.candidate_id], { status: "APPROVED" });
    return v;
  });
  ctx.repo.audit("candidate.approve", "script_version", `${version.script_id}:v${version.version_no}`, {
    candidate_id: candidateId,
    previous_status: candidate.status,
    source_hash: version.source_hash,
    trial_id: version.trial_id,
    environment_id: environmentId,
    approved_by: version.approved_by,
  });
  return version;
}

export function rejectCandidate(ctx: AppContext, candidateId: string) {
  const c = ctx.repo.candidates.get(candidateId);
  if (!c) throw new AppError("Không tìm thấy candidate");
  if (c.status !== "DRAFT") throw new AppError(`Candidate đang ở trạng thái ${c.status}`);
  ctx.repo.candidates.update([candidateId], { status: "REJECTED" });
  ctx.repo.audit("candidate.reject", "candidate", candidateId, { revision_no: c.revision_no });
}

export function retireVersion(ctx: AppContext, scriptId: string, versionNo: number) {
  const v = ctx.repo.versions.get(scriptId, versionNo);
  if (!v) throw new AppError("Không tìm thấy version");
  ctx.repo.versions.update([scriptId, versionNo], { status: "RETIRED" });
  ctx.repo.audit("version.retire", "script_version", `${scriptId}:v${versionNo}`, { previous: v.status });
}

// ---------------- Testing ----------------

export function startTestRun(ctx: AppContext, testId: string, versionNo: number, environmentId: string, input: InputValues): TestRun {
  const tc = ctx.repo.testCases.get(testId);
  if (!tc) throw new AppError("Không tìm thấy test case");
  const script = ctx.repo.scripts.where("test_id = ?", testId)[0];
  if (!script) throw new AppError("Test case chưa có script");
  const version = ctx.repo.versions.get(script.script_id, versionNo);
  if (!version) throw new AppError(`Không tìm thấy version v${versionNo}`);
  if (!isVersionSelectable(version)) throw new AppError(`Version v${versionNo} đang ở trạng thái ${version.status}, không được chọn cho run mới`);
  if (sha256(version.source) !== version.source_hash) throw new AppError("Source của version không khớp source_hash");
  const env = getEnvironment(ctx, environmentId);
  const resolved = resolveInput(ctx, tc, env, input);
  if (resolved.issues.length) throw new AppError(`Input không hợp lệ:\n${resolved.issues.join("\n")}`);

  const run: TestRun = {
    run_id: newId("run"),
    test_id: testId,
    script_id: script.script_id,
    version_no: versionNo,
    environment_id: env.environment_id,
    input_snapshot: resolved.snapshot,
    execution_status: "QUEUED",
    error_code: null,
    error_message: null,
    review_result: null,
    review_note: null,
    reviewed_at: null,
    evidence_refs: {},
    created_at: now(),
    started_at: null,
    finished_at: null,
  };
  ctx.repo.testRuns.insert(run);
  ctx.repo.audit("testrun.start", "test_run", run.run_id, { test_id: testId, version_no: versionNo, environment_id: env.environment_id, input: resolved.snapshot });
  ctx.emit("run:update", run);

  void (async () => {
    const update = (patch: Partial<TestRun>) => {
      Object.assign(run, patch);
      ctx.repo.testRuns.update([run.run_id], patch);
      ctx.emit("run:update", { ...run });
    };
    update({ execution_status: "RUNNING", started_at: now() });
    try {
      const { result, evidence } = await execute(ctx, artifactDir("runs", run.run_id), version.source, env, resolved.runtime, resolved.secretValues, (n) =>
        ctx.emit("run:update", { ...run, step_count: n }),
      );
      if (result.ok) {
        update({ execution_status: "COMPLETED", review_result: "PENDING", evidence_refs: evidence, finished_at: now() });
      } else {
        update({ execution_status: "ERROR", error_code: result.error_code, error_message: result.error_message, evidence_refs: evidence, finished_at: now() });
        if (marksVersionBroken(result.error_code)) {
          const current = ctx.repo.versions.get(script.script_id, versionNo);
          if (current?.status === "APPROVED") {
            ctx.repo.versions.update([script.script_id, versionNo], { status: "SUSPECTED_BROKEN" });
            ctx.repo.audit("version.suspected_broken", "script_version", `${script.script_id}:v${versionNo}`, { run_id: run.run_id, error_code: result.error_code });
          }
        }
      }
    } catch (e) {
      update({ execution_status: "ERROR", error_code: "EXCEPTION", error_message: (e as Error).message, finished_at: now() });
    }
    ctx.repo.audit("testrun.finish", "test_run", run.run_id, { execution_status: run.execution_status, error_code: run.error_code });
  })();
  return run;
}

export function reviewTestRun(ctx: AppContext, runId: string, result: Exclude<ReviewResult, "PENDING">, note: string): TestRun {
  const run = ctx.repo.testRuns.get(runId);
  if (!run) throw new AppError("Không tìm thấy test run");
  if (run.execution_status !== "COMPLETED") throw new AppError("Chỉ đánh giá PASS/FAIL cho run đã COMPLETED");
  if (result !== "PASS" && result !== "FAIL") throw new AppError("Kết quả phải là PASS hoặc FAIL");
  const patch = { review_result: result, review_note: note.trim() || null, reviewed_at: now() };
  ctx.repo.testRuns.update([runId], patch);
  ctx.repo.audit("testrun.review", "test_run", runId, { review_result: result, note: patch.review_note });
  const updated = ctx.repo.testRuns.get(runId)!;
  ctx.emit("run:update", updated);
  return updated;
}

// ---------------- Training draft verification ----------------

export interface VerificationInput {
  runtime: Record<string, string | number | boolean>;
  snapshot: InputValues;
  secretValues: string[];
}

/** Input for the app's own run of a Training draft; null + reason when the environment cannot run it. */
export function verificationInput(ctx: AppContext, tc: TestCase, env: Environment, sample: InputValues): { input: VerificationInput | null; reason: string } {
  if (!runnerAuthStatus(ctx, env)) return { input: null, reason: `environment "${env.name}" chưa có runner auth` };
  const resolved = resolveInput(ctx, tc, env, sample);
  if (resolved.issues.length) return { input: null, reason: resolved.issues.join("; ") };
  return { input: { runtime: resolved.runtime, snapshot: resolved.snapshot, secretValues: resolved.secretValues }, reason: "" };
}

/** Headless, full-speed run of a draft; artifacts go to `dir` (inside the Training attempt). */
export function runVerification(ctx: AppContext, dir: string, source: string, env: Environment, input: VerificationInput) {
  return execute(ctx, dir, source, env, input.runtime, input.secretValues, () => undefined, { fast: true });
}

/** Records the final verification run as a trial of the candidate built from exactly that source. */
export function recordVerificationTrial(
  ctx: AppContext,
  candidate: CandidateRevision,
  env: Environment,
  input: VerificationInput,
  run: { result: RunnerResult; evidence: Evidence; started_at: string; finished_at: string },
): TrialRun {
  const trial: TrialRun = {
    trial_id: newId("trial"),
    candidate_id: candidate.candidate_id,
    source_hash: candidate.source_hash,
    environment_id: env.environment_id,
    input_snapshot: input.snapshot,
    status: run.result.ok ? "PASSED" : run.result.error_code === "AUTH_REQUIRED" ? "AUTH_REQUIRED" : "FAILED",
    error_code: run.result.error_code,
    error_message: run.result.error_message,
    evidence_refs: run.evidence,
    created_at: run.started_at,
    started_at: run.started_at,
    finished_at: run.finished_at,
  };
  ctx.repo.trials.insert(trial);
  ctx.repo.audit("trial.training_verify", "trial", trial.trial_id, { candidate_id: candidate.candidate_id, source_hash: candidate.source_hash, status: trial.status });
  ctx.emit("trial:update", trial);
  return trial;
}

export function runnerAuthStatus(ctx: AppContext, env: Environment): boolean {
  return !!env.runner_auth_ref && ctx.secrets.has(env.runner_auth_ref) && env.runner_auth_ref === secretKeys.runnerAuth(env.environment_id);
}
