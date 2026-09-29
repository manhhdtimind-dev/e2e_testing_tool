import type { CandidateRevision, ScriptVersion, TrialRun } from "../shared/types";

export interface ApproveCheck {
  ok: boolean;
  reason?: string;
  trial?: TrialRun;
}

export function checkApprove(candidate: CandidateRevision, trials: TrialRun[], environmentId: string): ApproveCheck {
  if (candidate.status !== "DRAFT") return { ok: false, reason: `Candidate đang ở trạng thái ${candidate.status}` };
  if (!candidate.reviewed_at) return { ok: false, reason: "Cần mở xem candidate trước khi Approve" };
  const passed = trials
    .filter(
      (t) =>
        t.candidate_id === candidate.candidate_id &&
        t.source_hash === candidate.source_hash &&
        t.environment_id === environmentId &&
        t.status === "PASSED",
    )
    .sort((a, b) => (b.finished_at ?? "").localeCompare(a.finished_at ?? ""));
  if (passed.length === 0) {
    return { ok: false, reason: "Chưa có trial PASSED cho đúng candidate, source hash và environment này" };
  }
  return { ok: true, trial: passed[0] };
}

export function isVersionSelectable(v: ScriptVersion): boolean {
  return v.status === "APPROVED";
}

export function nextVersionNo(versions: ScriptVersion[]): number {
  return versions.reduce((m, v) => Math.max(m, v.version_no), 0) + 1;
}
