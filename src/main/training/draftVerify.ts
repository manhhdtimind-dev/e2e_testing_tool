export interface VerifyRun<R> {
  ok: boolean;
  authRequired: boolean;
  /** One line for the activity log, e.g. "FAILED (LOCATOR): …". */
  summary: string;
  data: R;
}

export interface DraftVerifyDeps<R> {
  maxFixRounds: number;
  run: (source: string, round: number) => Promise<VerifyRun<R>>;
  /** Asks the agent to fix the failed run; resolves to the new valid source, or null when it could not produce one. */
  fix: (failed: VerifyRun<R>, round: number) => Promise<string | null>;
  aborted: () => boolean;
  status: (text: string) => void;
}

export interface DraftVerifyResult<R> {
  /** The last source that was actually run — the candidate must be exactly this so its trial matches. */
  source: string;
  last: VerifyRun<R>;
  rounds: number;
}

/** Runs the draft with the app's runner; on failure lets the agent fix it, up to maxFixRounds more runs. */
export async function verifyDraft<R>(draft: string, deps: DraftVerifyDeps<R>): Promise<DraftVerifyResult<R>> {
  let current = draft;
  for (let round = 1; ; round++) {
    deps.status(`Kiểm chứng bản nháp lần ${round}: runner chạy ẩn với input mẫu…`);
    const run = await deps.run(current, round);
    deps.status(`Kiểm chứng lần ${round}: ${run.ok ? "PASSED" : run.summary}`);
    const done = { source: current, last: run, rounds: round };
    if (run.ok || deps.aborted()) return done;
    if (run.authRequired) {
      deps.status("Runner cần đăng nhập lại (runner auth hết hạn); dừng kiểm chứng.");
      return done;
    }
    if (round > deps.maxFixRounds) return done;
    deps.status(`Gửi lỗi kiểm chứng cho agent sửa (lần ${round}/${deps.maxFixRounds})…`);
    const next = await deps.fix(run, round);
    if (deps.aborted()) return done;
    if (!next || next === current) {
      deps.status(next ? "Agent không thay đổi script; dừng kiểm chứng." : "Không có bản sửa hợp lệ; giữ bản đã chạy kiểm chứng gần nhất.");
      return done;
    }
    current = next;
  }
}
