import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import AdmZip from "adm-zip";
import type { AgentProvider, TestRun, TrainingAttempt, TrialRun } from "../../shared/types";
import type { AppContext } from "../context";
import { fromArtifactRef, paths } from "../paths";
import { AppError } from "../util";

export interface HistoryFilter {
  test_id?: string;
  agent?: AgentProvider | "";
  version_no?: number | null;
  environment_id?: string;
  status?: string;
  from?: string;
  to?: string;
}

export interface HistoryRow extends TestRun {
  agent: AgentProvider | null;
}

/** Agent that produced the candidate behind an approved version. */
function agentForVersion(ctx: AppContext, scriptId: string, versionNo: number): AgentProvider | null {
  const v = ctx.repo.versions.get(scriptId, versionNo);
  if (!v) return null;
  const cand = ctx.repo.candidates.get(v.candidate_id);
  const attempt = cand?.attempt_id ? ctx.repo.attempts.get(cand.attempt_id) : undefined;
  if (attempt) return attempt.agent;
  const thread = cand?.provider_thread_id ? ctx.repo.threads.get(cand.provider_thread_id) : undefined;
  return thread?.provider ?? null;
}

export function queryTestRuns(ctx: AppContext, f: HistoryFilter): HistoryRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (f.test_id) {
    clauses.push("test_id LIKE ?");
    params.push(`%${f.test_id}%`);
  }
  if (f.version_no) {
    clauses.push("version_no = ?");
    params.push(f.version_no);
  }
  if (f.environment_id) {
    clauses.push("environment_id = ?");
    params.push(f.environment_id);
  }
  if (f.status) {
    clauses.push("(execution_status = ? OR review_result = ? OR error_code = ?)");
    params.push(f.status, f.status, f.status);
  }
  if (f.from) {
    clauses.push("created_at >= ?");
    params.push(f.from);
  }
  if (f.to) {
    clauses.push("created_at <= ?");
    params.push(`${f.to}T23:59:59.999Z`);
  }
  const rows = ctx.repo.testRuns.where(`${clauses.length ? clauses.join(" AND ") : "1=1"} ORDER BY created_at DESC LIMIT 1000`, ...params);
  const withAgent = rows.map((r) => ({ ...r, agent: agentForVersion(ctx, r.script_id, r.version_no) }));
  return f.agent ? withAgent.filter((r) => r.agent === f.agent) : withAgent;
}

export function listTrialsForHistory(ctx: AppContext, testId?: string): (TrialRun & { test_id: string; revision_no: number })[] {
  const rows = ctx.repo.db.all<Record<string, unknown>>(
    `SELECT t.trial_id, s.test_id, c.revision_no FROM trials t JOIN candidates c ON c.candidate_id = t.candidate_id JOIN scripts s ON s.script_id = c.script_id
     ${testId ? "WHERE s.test_id LIKE ?" : ""} ORDER BY t.created_at DESC LIMIT 500`,
    ...(testId ? [`%${testId}%`] : []),
  );
  return rows.map((r) => ({ ...ctx.repo.trials.get(r.trial_id as string)!, test_id: r.test_id as string, revision_no: r.revision_no as number }));
}

export function listAttemptsForHistory(ctx: AppContext, testId?: string): (TrainingAttempt & { test_id: string })[] {
  const rows = ctx.repo.db.all<Record<string, unknown>>(
    `SELECT a.attempt_id, s.test_id FROM training_attempts a JOIN scripts s ON s.script_id = a.script_id
     ${testId ? "WHERE s.test_id LIKE ?" : ""} ORDER BY a.created_at DESC LIMIT 500`,
    ...(testId ? [`%${testId}%`] : []),
  );
  return rows.map((r) => ({ ...ctx.repo.attempts.get(r.attempt_id as string)!, test_id: r.test_id as string }));
}

export function exportVersionSource(ctx: AppContext, scriptId: string, versionNo: number, dest: string) {
  const v = ctx.repo.versions.get(scriptId, versionNo);
  if (!v) throw new AppError("Không tìm thấy version");
  writeFileSync(dest, v.source);
  ctx.repo.audit("export.script", "script_version", `${scriptId}:v${versionNo}`, { dest });
}

export function exportCandidateSource(ctx: AppContext, candidateId: string, dest: string) {
  const c = ctx.repo.candidates.get(candidateId);
  if (!c) throw new AppError("Không tìm thấy candidate");
  writeFileSync(dest, c.source);
  ctx.repo.audit("export.candidate", "candidate", candidateId, { dest });
}

/** Zip with run metadata (test case, input, environment, version/source, agent) and all artifacts. */
export function exportRunEvidence(ctx: AppContext, runId: string, dest: string) {
  const run = ctx.repo.testRuns.get(runId);
  if (!run) throw new AppError("Không tìm thấy test run");
  const tc = ctx.repo.testCases.get(run.test_id);
  const env = ctx.repo.environments.get(run.environment_id);
  const version = ctx.repo.versions.get(run.script_id, run.version_no);
  const zip = new AdmZip();
  zip.addFile(
    "run.json",
    Buffer.from(
      JSON.stringify(
        {
          run,
          agent: agentForVersion(ctx, run.script_id, run.version_no),
          test_case: tc,
          environment: env ? { environment_id: env.environment_id, name: env.name, base_url: env.base_url, allowed_domains: env.allowed_domains } : null,
          version: version ? { ...version, source: undefined } : null,
        },
        null,
        2,
      ),
    ),
  );
  if (version) zip.addFile(`script_v${version.version_no}.ts`, Buffer.from(version.source));
  const dir = join(paths().artifacts, "runs", runId);
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".")) continue;
      zip.addLocalFile(join(dir, name), "artifacts");
    }
  }
  zip.writeZip(dest);
  ctx.repo.audit("export.evidence", "test_run", runId, { dest });
}

export function readArtifactText(ref: string, max = 2_000_000): string {
  const abs = fromArtifactRef(ref);
  if (!existsSync(abs)) throw new AppError("Artifact không còn (có thể đã hết hạn lưu trữ)");
  const text = readFileSync(abs, "utf8");
  return text.length > max ? text.slice(0, max) : text;
}

/** Deletes artifact folders older than the retention period; DB records are kept for traceability. */
export function cleanupArtifacts(ctx: AppContext) {
  const days = ctx.settings().artifact_retention_days;
  const cutoff = Date.now() - days * 86_400_000;
  let removed = 0;
  for (const kind of ["attempts", "trials", "runs"]) {
    const base = join(paths().artifacts, kind);
    if (!existsSync(base)) continue;
    for (const id of readdirSync(base)) {
      const p = join(base, id);
      if (statSync(p).mtimeMs < cutoff) {
        rmSync(p, { recursive: true, force: true });
        removed++;
      }
    }
  }
  if (removed) ctx.repo.audit("artifacts.cleanup", "artifacts", null, { removed, retention_days: days });
}
