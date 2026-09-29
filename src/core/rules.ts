import type { CandidateRevision, ScriptVersion, TrialRun } from "../shared/types";

export interface ApproveCheck {
  ok: boolean;
  reason?: string;
  trial?: TrialRun;
}

/** The user decides; a matching PASSED trial is only attached to the version when one exists. */
export function checkApprove(candidate: CandidateRevision, trials: TrialRun[], environmentId: string): ApproveCheck {
  if (candidate.status === "APPROVED") return { ok: false, reason: "Candidate này đã được chấp nhận" };
  const passed = trials
    .filter(
      (t) =>
        t.candidate_id === candidate.candidate_id &&
        t.source_hash === candidate.source_hash &&
        t.environment_id === environmentId &&
        t.status === "PASSED",
    )
    .sort((a, b) => (b.finished_at ?? "").localeCompare(a.finished_at ?? ""));
  return { ok: true, trial: passed[0] };
}

export function isVersionSelectable(v: ScriptVersion): boolean {
  return v.status === "APPROVED";
}

export function nextVersionNo(versions: ScriptVersion[]): number {
  return versions.reduce((m, v) => Math.max(m, v.version_no), 0) + 1;
}
