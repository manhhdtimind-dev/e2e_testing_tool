import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { AgentProvider, BrowserProfile, CandidateRevision, InputValues, PreflightResult, RecordingState, TrainingAttempt, TrainingEvent, TrialRun } from "../../shared/types";
import { api, useAppEvent, type ApiResult } from "../api";
import { ArtifactImage, Badge, CaseOptions, CodeView, DiffView, EvidenceShots, InputForm, Modal, Panel, StepsTable, fmtTime, useAction, useConfirm, useToast } from "../components/ui";

export interface TrainingIntent {
  test_id: string;
  environment_id?: string;
  context_ref?: { type: "trial" | "test_run"; id: string };
  context_label?: string;
  nonce?: number;
}

type ScriptState = ApiResult<"getScriptState">;
type CaseRow = ApiResult<"listTestCases">[number];
type EnvRow = ApiResult<"listEnvironments">[number];
type Integration = ApiResult<"getIntegrationStatus">;

const AGENT_LABEL: Record<AgentProvider, string> = { codex: "Codex", cursor: "Cursor" };
const KIND_LABEL: Record<TrainingAttempt["kind"], string> = { initial: "Lượt đầu", revise: "Prompt sửa", from_test_run: "Từ Testing", switch_agent: "Đổi agent", retrain: "Training lại" };
const RECORDING_ACTIVE = new Set<RecordingState["status"]>(["STARTING", "RECORDING", "SAVING"]);

type StageState = "idle" | "done" | "active" | "blocked" | "attn";

function Rail({ stages }: { stages: { name: string; state: StageState; text: string }[] }) {
  return (
    <div className="rail" aria-label="Tiến trình Training">
      {stages.map((s, i) => (
        <div key={s.name} className={`stage ${s.state}`}>
          <span className="num">{s.state === "done" ? "✓" : i + 1}</span>
          <div className="name">{s.name}</div>
          <div className="state" title={s.text}>
            {s.text}
          </div>
        </div>
      ))}
    </div>
  );
}

function EventRow({ e }: { e: TrainingEvent }) {
  const time = new Date(e.ts).toLocaleTimeString("vi-VN", { hour12: false });
  if (e.kind === "tool_call") return null;
  const cls = e.kind === "tool_result" ? "tool" : e.kind;
  const label = e.kind === "tool_result" ? "tool" : e.kind === "message" ? "agent" : e.kind === "thinking" ? "nghĩ" : e.kind === "file_change" ? "file" : e.kind === "command" ? "lệnh" : e.kind === "error" ? "lỗi" : "hệ thống";
  return (
    <div className={`ev ${cls}`}>
      <div className="k" title={time}>
        {label}
      </div>
      <div className="v">
        {e.kind === "tool_result" ? (
          <details>
            <summary>
              <span className="mono">{e.tool}</span> {e.ok === false && <Badge status="FAILED" />} <span className="muted small">{summarizeArgs(e.args)}</span>
            </summary>
            <pre>{typeof e.result === "string" ? e.result : JSON.stringify(e.result, null, 2)}</pre>
          </details>
        ) : e.kind === "command" ? (
          <details>
            <summary className="mono">{e.text}</summary>
            <pre>{String(e.result ?? "")}</pre>
          </details>
        ) : (
          <span className="pre">{e.kind === "thinking" ? (e.text ?? "").slice(0, 400) : e.text}</span>
        )}
      </div>
    </div>
  );
}

function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  const v = a.url ?? a.element ?? a.text ?? a.values ?? a.key ?? a.filename;
  return v ? String(Array.isArray(v) ? v.join(", ") : v).slice(0, 80) : "";
}

export function TrainingPage({ intent, onTest }: { intent: TrainingIntent | null; onTest: (testId: string) => void }) {
  const [cases, setCases] = useState<CaseRow[]>([]);
  const [envs, setEnvs] = useState<EnvRow[]>([]);
  const [profiles, setProfiles] = useState<BrowserProfile[]>([]);
  const [integration, setIntegration] = useState<Integration | null>(null);
  const [testId, setTestId] = useState(intent?.test_id ?? "");
  const [envId, setEnvId] = useState(intent?.environment_id ?? "");
  const [agent, setAgent] = useState<AgentProvider>("codex");
  const [profileId, setProfileId] = useState("");
  const [contextRef, setContextRef] = useState<TrainingIntent["context_ref"] | null>(intent?.context_ref ?? null);
  const [contextLabel, setContextLabel] = useState(intent?.context_label ?? "");
  const [state, setState] = useState<ScriptState | null>(null);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [candidateId, setCandidateId] = useState<string | null>(null);
  const [trialId, setTrialId] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [sample, setSample] = useState<InputValues>({});
  const [trialInput, setTrialInput] = useState<InputValues>({});
  const [prompt, setPrompt] = useState("");
  const [pre, setPre] = useState<PreflightResult | null>(null);
  const [liveEvents, setLiveEvents] = useState<Record<string, TrainingEvent[]>>({});
  const [storedEvents, setStoredEvents] = useState<TrainingEvent[]>([]);
  const [trialSteps, setTrialSteps] = useState<Record<string, number>>({});
  const { run, busy } = useAction();
  const toast = useToast();
  const ask = useConfirm();
  const eventsBox = useRef<HTMLDivElement>(null);
  const [trialOpen, setTrialOpen] = useState(false);
  const [recOpen, setRecOpen] = useState(false);
  const [recInput, setRecInput] = useState<InputValues>({});
  const [rec, setRec] = useState<RecordingState | null>(null);

  const tc = cases.find((c) => c.test_id === testId) ?? null;
  const env = envs.find((e) => e.environment_id === envId) ?? null;

  useEffect(() => {
    void Promise.all([api.listTestCases(), api.listEnvironments(), api.listProfiles(), api.getIntegrationStatus()]).then(([c, e, p, i]) => {
      setCases(c);
      setEnvs(e);
      setProfiles(p);
      setIntegration(i);
      setEnvId((v) => v || e[0]?.environment_id || "");
      setProfileId((v) => v || p[0]?.browser_profile_id || "");
      setTestId((v) => v || c[0]?.test_id || "");
    });
    void api.getRecordingState().then(setRec);
  }, []);

  useEffect(() => {
    if (!intent) return;
    setTestId(intent.test_id);
    if (intent.environment_id) setEnvId(intent.environment_id);
    setContextRef(intent.context_ref ?? null);
    setContextLabel(intent.context_label ?? "");
  }, [intent]);

  const testIdRef = useRef(testId);
  testIdRef.current = testId;
  const reload = useCallback(async () => {
    if (!testId) return setState(null);
    const next = await api.getScriptState(testId);
    if (testIdRef.current === testId) setState(next);
  }, [testId]);

  useEffect(() => {
    setState(null);
    setAttemptId(null);
    setCandidateId(null);
    setTrialId(null);
    void reload();
  }, [reload]);

  useEffect(() => {
    if (tc) setSample(tc.sample_input);
  }, [tc]);

  useEffect(() => {
    if (state?.script) setAgent(state.script.active_agent);
  }, [state?.script?.script_id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!state) return;
    if (!candidateId && state.candidates[0]) setCandidateId(state.candidates[0].candidate_id);
    if (!attemptId && state.attempts[0]) setAttemptId(state.attempts[0].attempt_id);
  }, [state, candidateId, attemptId]);

  useAppEvent<TrainingAttempt>("training:attempt", (a) => {
    if (state?.script && state.script.script_id !== a.script_id) return;
    // Only the update that attaches a new candidate lacks finished_at; the final one must not override a manual selection.
    if (a.candidate_id && !a.finished_at) {
      setCandidateId(a.candidate_id);
      setAttemptId(a.attempt_id);
    }
    void reload();
  });
  const offerSampleUpdate = async (r: RecordingState) => {
    const lines = r.sample_changes.map((c) => `• ${c.field}: ${c.from ? `"${c.from}"` : "(trống)"} → ${c.to ? `"${c.to}"` : "(trống)"}`);
    const ok = await ask(`Input lúc ghi khác input mẫu của ${r.test_id}:\n${lines.join("\n")}\n\nThay input mẫu của test case bằng giá trị vừa dùng khi ghi?`, {
      okText: "Cập nhật input mẫu",
      cancelText: "Giữ nguyên",
    });
    if (!ok) return;
    const values = Object.fromEntries(r.sample_changes.map((c) => [c.field, c.to]));
    if (await run(() => api.updateSampleInput(r.test_id, values), "Đã cập nhật input mẫu của test case")) setCases(await api.listTestCases());
  };

  useAppEvent<RecordingState>("recording:state", (r) => {
    setRec(r);
    if (r.test_id !== testId) return;
    if (r.status === "SAVED" && r.candidate_id) {
      setCandidateId(r.candidate_id);
      toast(
        `Đã tạo candidate #${r.revision_no} từ ${r.action_count} thao tác ghi.${r.notes.length ? ` Có ${r.notes.length} ghi chú cần xem lại ở đầu script.` : ""}`,
        "ok",
      );
      void reload();
      if (r.sample_changes.length) void offerSampleUpdate(r);
    } else if (r.status === "FAILED" && r.error) {
      toast(`Ghi thao tác không thành công: ${r.error}`, "err");
    }
  });
  useAppEvent<{ attempt_id: string; event: TrainingEvent }>("training:event", ({ attempt_id, event }) => {
    setLiveEvents((m) => ({ ...m, [attempt_id]: [...(m[attempt_id] ?? []), event].slice(-400) }));
  });
  useAppEvent<TrialRun & { step_count?: number }>("trial:update", (t) => {
    if (t.step_count !== undefined) setTrialSteps((m) => ({ ...m, [t.trial_id]: t.step_count! }));
    else void reload();
  });

  const attempt = state?.attempts.find((a) => a.attempt_id === attemptId) ?? null;
  const candidate = state?.candidates.find((c) => c.candidate_id === candidateId) ?? null;
  const previous = candidate ? state?.candidates.find((c) => c.revision_no === candidate.revision_no - 1) : undefined;
  const candidateTrials = useMemo(() => (state?.trials ?? []).filter((t) => t.candidate_id === candidateId), [state, candidateId]);
  const trial = candidateTrials.find((t) => t.trial_id === trialId) ?? candidateTrials[0] ?? null;
  const runningAttempt = state?.attempts.find((a) => a.status === "RUNNING" || a.status === "QUEUED") ?? null;
  const activeThread = state?.threads.find((t) => t.id === state.script?.training_thread_id) ?? null;
  const agentSwitch = !!state?.script && !!activeThread && activeThread.provider !== agent;
  const recActive = !!rec && RECORDING_ACTIVE.has(rec.status);
  const recHere = recActive && rec?.test_id === testId;

  useEffect(() => {
    setStoredEvents([]);
    if (!attempt?.artifacts.events || attempt.status === "RUNNING") return;
    api
      .readArtifact(attempt.artifacts.events)
      .then((t) => setStoredEvents(t.split("\n").filter(Boolean).map((l) => JSON.parse(l))))
      .catch(() => setStoredEvents([]));
  }, [attempt?.attempt_id, attempt?.status, attempt?.artifacts.events]);

  const events = attempt ? (attempt.status === "RUNNING" || attempt.status === "QUEUED" || !storedEvents.length ? (liveEvents[attempt.attempt_id] ?? storedEvents) : storedEvents) : [];
  useEffect(() => {
    const box = eventsBox.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [events.length]);

  useEffect(() => {
    if (candidate && !candidate.reviewed_at) void api.markCandidateReviewed(candidate.candidate_id).then(reload);
    if (candidate) {
      const src = state?.attempts.find((a) => a.attempt_id === candidate.attempt_id);
      setTrialInput(src?.sample_input ?? tc?.sample_input ?? {});
    }
  }, [candidate?.candidate_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const stages = useMemo(() => {
    const last = state?.attempts[0];
    const preStatus = runningAttempt?.preflight_status ?? pre?.status ?? last?.preflight_status ?? null;
    const s1: StageState = preStatus === "CONNECTED" ? "done" : preStatus === "AUTH_REQUIRED" ? "attn" : preStatus === "PROFILE_UNAVAILABLE" ? "blocked" : runningAttempt ? "active" : "idle";
    const s2: StageState = !last ? "idle" : last.status === "RUNNING" || last.status === "QUEUED" ? "active" : last.status === "COMPLETED" ? "done" : last.status === "AUTH_REQUIRED" ? "attn" : "blocked";
    const t = candidateTrials[0];
    const s4: StageState = !t ? "idle" : t.status === "PASSED" ? "done" : t.status === "RUNNING" || t.status === "QUEUED" ? "active" : t.status === "AUTH_REQUIRED" ? "attn" : "blocked";
    const approvedVersion = candidate ? state?.versions.find((v) => v.candidate_id === candidate.candidate_id) : undefined;
    return [
      { name: "Preflight", state: s1, text: preStatus ?? "Chưa kiểm tra" },
      { name: "Agent", state: s2, text: last ? `${AGENT_LABEL[last.agent]} · ${last.status}` : "Chưa chạy" },
      { name: "Candidate", state: (candidate ? "done" : "idle") as StageState, text: candidate ? `Revision #${candidate.revision_no} · ${candidate.status}` : "Chưa có" },
      { name: "Trial", state: s4, text: t ? `${t.status}${t.error_code ? ` · ${t.error_code}` : ""}` : "Chưa chạy" },
      {
        name: "Chấp nhận",
        state: (approvedVersion ? "done" : candidate ? "active" : "idle") as StageState,
        text: approvedVersion ? `Version v${approvedVersion.version_no}${approvedVersion.status === "APPROVED" ? "" : ` · ${approvedVersion.status}`}` : candidate ? "Chờ quyết định" : "Chưa có candidate",
      },
    ];
  }, [state, runningAttempt, pre, candidate, candidateTrials]);

  const integrationNote = integration && !integration[agent]?.ok ? `Adapter ${AGENT_LABEL[agent]} chưa qua kiểm tra tích hợp trên máy này (Cài đặt → Kiểm tra tích hợp).` : null;

  const start = async (fresh = false) => {
    if (!tc || !env || !profileId) return;
    const a = await run(
      () =>
        api.startTraining({
          test_id: tc.test_id,
          environment_id: env.environment_id,
          agent,
          browser_profile_id: profileId,
          sample_input: sample,
          prompt,
          context_ref: fresh ? null : (contextRef ?? null),
          fresh,
        }),
      fresh ? "Đã bắt đầu Training lại từ đầu" : "Đã bắt đầu lượt Training",
    );
    if (a) {
      setAttemptId(a.attempt_id);
      setPrompt("");
      setContextRef(null);
      setContextLabel("");
      setPre(null);
      void reload();
    }
  };

  return (
    <div>
      <div className="page-head">
        <h1>Training</h1>
        <p>AI thao tác trên website bằng Chrome profile đã đăng nhập và tạo Playwright script.</p>
      </div>

      <div className="panel" style={{ padding: 12, marginBottom: 12 }}>
        <div className="row">
          <label className="field">
            <span>Test case</span>
            <select value={testId} onChange={(e) => setTestId(e.target.value)} style={{ minWidth: 240 }}>
              <CaseOptions cases={cases} label={(c) => `${c.test_id} — ${c.title}`} />
            </select>
          </label>
          <label className="field">
            <span>Environment</span>
            <select value={envId} onChange={(e) => setEnvId(e.target.value)}>
              {envs.map((e) => (
                <option key={e.environment_id} value={e.environment_id}>
                  {e.name}
                </option>
              ))}
            </select>
          </label>
          <div className="field">
            <span>Agent</span>
            <div className="segmented" role="group" aria-label="Chọn agent">
              {(["codex", "cursor"] as AgentProvider[]).map((a) => (
                <button key={a} className={agent === a ? "on" : ""} onClick={() => setAgent(a)}>
                  {AGENT_LABEL[a]}
                </button>
              ))}
            </div>
          </div>
          <label className="field">
            <span>Chrome profile</span>
            <select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
              {profiles.length === 0 && <option value="">Chưa đăng ký profile</option>}
              {profiles.map((p) => (
                <option key={p.browser_profile_id} value={p.browser_profile_id}>
                  {p.display_name} ({p.profile_dir_name})
                </option>
              ))}
            </select>
          </label>
          <button
            className="btn"
            style={{ alignSelf: "flex-end" }}
            disabled={busy || !profileId || !envId}
            onClick={async () => {
              setPre(null);
              const r = await run(() => api.preflight(profileId, envId));
              if (r) setPre(r);
            }}
          >
            Kiểm tra preflight
          </button>
        </div>
        {pre && <div className={pre.status === "CONNECTED" ? "info-box" : "error-box"} style={{ marginTop: 10 }}>{pre.message}</div>}
        {agentSwitch && (
          <div className="warn-box" style={{ marginTop: 10 }}>
            Script đang dùng {AGENT_LABEL[activeThread!.provider]}. Gửi prompt với {AGENT_LABEL[agent]} sẽ tạo provider thread mới từ test case, candidate, prompt và trial đã lưu. Candidate/version cũ giữ nguyên.
          </div>
        )}
        {integrationNote && <div className="warn-box" style={{ marginTop: 10 }}>{integrationNote}</div>}
      </div>

      <Rail stages={stages} />

      {rec && recActive && (
        <div className="rec-banner" role="status">
          <span className="rec-dot" aria-hidden />
          <div className="col" style={{ gap: 2 }}>
            <strong>
              {rec.status === "STARTING" ? "Đang mở trình duyệt để ghi…" : rec.status === "SAVING" ? "Đang tạo candidate từ thao tác đã ghi…" : `Đang ghi thao tác cho ${rec.test_id}`}
            </strong>
            <span className="small">
              Bước {rec.step}/{rec.step_count} · {rec.action_count} thao tác · {rec.shot_count} ảnh. Thao tác trên cửa sổ Chrome vừa mở; dùng thanh nổi ở góc dưới trang để chuyển bước, đánh
              dấu chụp màn hình và kết thúc.
            </span>
          </div>
          <span style={{ flex: 1 }} />
          {rec.status === "RECORDING" && (
            <>
              <button className="btn" disabled={busy} onClick={() => run(() => api.cancelRecording(rec.session_id), "Đã huỷ phiên ghi, không tạo candidate")}>
                Huỷ ghi
              </button>
              <button className="btn primary" disabled={busy} onClick={() => run(() => api.finishRecording(rec.session_id))}>
                Kết thúc ghi
              </button>
            </>
          )}
        </div>
      )}

      {!tc ? (
        <div className="panel empty">Chưa có test case. Hãy import ở màn Test Cases.</div>
      ) : (
        <div className="grid-3">
          {/* ---------- left: attempts & versions ---------- */}
          <div className="stack">
            <Panel title="Lịch sử prompt" bodyClass="">
              {!state?.attempts.length ? (
                <div className="empty">Chưa có lượt Training.</div>
              ) : (
                <ul className="list scroll">
                  {state.attempts.map((a) => (
                    <li key={a.attempt_id} className={a.attempt_id === attemptId ? "sel" : ""} onClick={() => setAttemptId(a.attempt_id)}>
                      <div className="line">
                        <Badge status={a.status} />
                        <span className="small muted">
                          {AGENT_LABEL[a.agent]} · {KIND_LABEL[a.kind]}
                        </span>
                      </div>
                      <span className="small">{a.prompt ? a.prompt.slice(0, 120) : <em className="muted">(không có prompt thêm)</em>}</span>
                      <span className="small muted">{fmtTime(a.created_at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
            <Panel title="Version đã duyệt" bodyClass="">
              {!state?.versions.length ? (
                <div className="empty">Chưa có version.</div>
              ) : (
                <ul className="list">
                  {state.versions.map((v) => (
                    <li key={v.version_no} onClick={() => setCandidateId(v.candidate_id)}>
                      <div className="line">
                        <strong>v{v.version_no}</strong>
                        <Badge status={v.status} />
                        <span className="small muted" style={{ marginLeft: "auto" }}>
                          {fmtTime(v.approved_at)}
                        </span>
                      </div>
                      <span className="mono muted">{v.source_hash.slice(0, 12)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {state?.versions.some((v) => v.status === "APPROVED") && (
                <div style={{ padding: 10 }}>
                  <button className="btn sm" onClick={() => onTest(tc.test_id)}>
                    Mở Testing
                  </button>
                </div>
              )}
            </Panel>
          </div>

          {/* ---------- center: candidate, trial, composer ---------- */}
          <div className="stack">
            <Panel
              title="Candidate"
              actions={
                <div className="row">
                  {state?.candidates.map((c) => (
                    <button key={c.candidate_id} className={`btn sm ${c.candidate_id === candidateId ? "primary" : ""}`} onClick={() => setCandidateId(c.candidate_id)} title={c.status}>
                      #{c.revision_no}
                    </button>
                  ))}
                </div>
              }
            >
              {!candidate ? (
                <div className="empty">Chưa có candidate. Bấm Agent Training Auto để AI tạo script, hoặc Ghi thao tác để tự làm mẫu trên trình duyệt.</div>
              ) : (
                <CandidateView
                  key={candidate.candidate_id}
                  candidate={candidate}
                  previous={previous}
                  showDiff={showDiff}
                  setShowDiff={setShowDiff}
                  hasPassedTrial={candidateTrials.some((t) => t.status === "PASSED" && t.source_hash === candidate.source_hash && t.environment_id === envId)}
                  busy={busy}
                  editLocked={!!runningAttempt || recHere}
                  latestTrial={candidateTrials[0]}
                  onOpenTrial={() => setTrialOpen(true)}
                  onSaveEdit={async (source) => {
                    const c = await run(() => api.saveManualCandidate(candidate.candidate_id, source, envId), "Đã lưu code sửa tay thành candidate mới");
                    if (!c) return false;
                    setCandidateId(c.candidate_id);
                    void reload();
                    return true;
                  }}
                  onReject={async () => {
                    if (!(await ask(`Từ chối candidate #${candidate.revision_no}?`, { okText: "Từ chối", danger: true }))) return;
                    await run(() => api.rejectCandidate(candidate.candidate_id), "Đã từ chối candidate");
                    void reload();
                  }}
                  onApprove={async () => {
                    const v = await run(() => api.approveCandidate(candidate.candidate_id, envId), "Đã chấp nhận, tạo version mới");
                    if (v) void reload();
                  }}
                  onExport={() => run(() => api.exportCandidate(candidate.candidate_id, `${tc.test_id}_rev${candidate.revision_no}`))}
                />
              )}
            </Panel>

            {candidate && trialOpen && (
              <Modal title={`Trial — candidate #${candidate.revision_no}`} onClose={() => setTrialOpen(false)}>
                <p className="hint" style={{ marginTop: 0 }}>
                  Chạy không dùng AI, trên browser context mới với runner auth của environment "{env?.name ?? "—"}".
                </p>
                <InputForm schema={tc.input_schema} projectId={tc.project_id} values={trialInput} onChange={setTrialInput} secretFieldsFromEnv={env?.secret_fields} mode="run" />
                <div className="row" style={{ marginTop: 10 }}>
                  {env && !env.runner_auth_ready && <span className="badge warn">Environment chưa có runner auth</span>}
                  <span style={{ flex: 1 }} />
                  <button
                    className="btn primary"
                    disabled={busy || !env || candidate.status === "REJECTED"}
                    onClick={async () => {
                      const t = await run(() => api.startTrial(candidate.candidate_id, envId, trialInput), "Đã bắt đầu trial");
                      if (t) {
                        setTrialId(t.trial_id);
                        void reload();
                      }
                    }}
                  >
                    Run Trial
                  </button>
                </div>
                {candidateTrials.length > 0 && (
                  <>
                    <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
                      {candidateTrials.map((t) => (
                        <button key={t.trial_id} className={`btn sm ${trial?.trial_id === t.trial_id ? "primary" : ""}`} onClick={() => setTrialId(t.trial_id)}>
                          {new Date(t.created_at).toLocaleTimeString("vi-VN", { hour12: false })} · {t.status}
                        </button>
                      ))}
                      <span style={{ flex: 1 }} />
                      <button
                        className="btn sm ghost"
                        disabled={busy || candidateTrials.every((t) => t.status === "QUEUED" || t.status === "RUNNING")}
                        onClick={async () => {
                          if (!(await ask(`Xoá kết quả các lượt Trial đã chạy của candidate #${candidate.revision_no} (kèm screenshot, trace)?`, { okText: "Xoá", danger: true }))) return;
                          const r = await run(() => api.clearTrials(candidate.candidate_id));
                          if (!r) return;
                          toast(r.kept ? `Đã xoá ${r.removed} lượt Trial; giữ ${r.kept} lượt đang chạy hoặc gắn với version.` : `Đã xoá ${r.removed} lượt Trial.`, "ok");
                          setTrialId(null);
                          void reload();
                        }}
                      >
                        Xoá kết quả cũ
                      </button>
                    </div>
                    {trial && <TrialDetail trial={trial} liveSteps={trialSteps[trial.trial_id]} envName={envs.find((e) => e.environment_id === trial.environment_id)?.name} />}
                  </>
                )}
              </Modal>
            )}

            {recOpen && (
              <Modal title={`Ghi thao tác — ${tc.test_id}`} onClose={() => setRecOpen(false)}>
                <p className="hint" style={{ marginTop: 0 }}>
                  App mở Chrome với runner auth của environment "{env?.name ?? "—"}" và ghi lại thao tác của bạn thành Playwright script (không dùng AI). Khi thao tác, hãy gõ đúng
                  các giá trị input dưới đây để app thay chúng bằng <span className="mono">input.*</span> trong script.
                </p>
                <ul className="hint-list small">
                  <li>Thanh nổi ở góc dưới trang hiện bước đang làm. Bấm › khi chuyển sang bước tiếp theo để script có chú thích theo từng bước.</li>
                  <li>Bấm 📷 Chụp màn hình đúng lúc cần ảnh kết quả; nút sáng lên ở các bước "Chụp màn hình…" và tự chuyển sang bước sau.</li>
                  <li>Bấm ■ Kết thúc (hoặc đóng cửa sổ Chrome) khi xong. App tạo candidate mới để bạn xem, chạy Trial hoặc gửi prompt cho AI chỉnh tiếp.</li>
                  <li>Mật khẩu/mã bí mật bạn gõ không được lưu vào script; app thay bằng biến secret của test case.</li>
                </ul>
                <InputForm schema={tc.input_schema} projectId={tc.project_id} values={recInput} onChange={setRecInput} secretFieldsFromEnv={env?.secret_fields} mode="run" />
                <div className="row" style={{ marginTop: 10 }}>
                  {env && !env.runner_auth_ready && <span className="badge warn">Environment chưa có runner auth — đăng nhập cho runner ở màn Environment trước</span>}
                  <span style={{ flex: 1 }} />
                  <button
                    className="btn primary"
                    disabled={busy || !env?.runner_auth_ready || recActive}
                    onClick={async () => {
                      const r = await run(
                        () => api.startRecording({ test_id: tc.test_id, environment_id: envId, sample_input: recInput, agent }),
                        "Đã mở trình duyệt để ghi thao tác",
                      );
                      if (r) {
                        setRec(r);
                        setRecOpen(false);
                      }
                    }}
                  >
                    Bắt đầu ghi
                  </button>
                </div>
              </Modal>
            )}

            <Panel title={state?.candidates.length ? "Prompt sửa / training lại" : "Bắt đầu Training"}>
              {contextRef && (
                <div className="info-box" style={{ marginBottom: 10 }}>
                  Ngữ cảnh gửi kèm: {contextLabel || `${contextRef.type} ${contextRef.id}`}{" "}
                  <button className="btn sm ghost" onClick={() => setContextRef(null)}>
                    Bỏ
                  </button>
                </div>
              )}
              <details open={!state?.candidates.length}>
                <summary className="small" style={{ cursor: "pointer", marginBottom: 8 }}>
                  Input mẫu cho lượt này
                </summary>
                <InputForm schema={tc.input_schema} projectId={tc.project_id} values={sample} onChange={setSample} mode="training" />
              </details>
              <textarea
                rows={4}
                style={{ width: "100%", marginTop: 10 }}
                placeholder={state?.candidates.length ? "Mô tả điều cần sửa, ví dụ: Step 4 phải chọn Objective trong dropdown thay vì gõ chữ" : "Ghi chú thêm cho AI (tuỳ chọn)"}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
              <div className="row" style={{ marginTop: 10 }}>
                <span className="muted small">
                  Agent {AGENT_LABEL[agent]} · Profile {profiles.find((p) => p.browser_profile_id === profileId)?.display_name ?? "—"}
                </span>
                <span style={{ flex: 1 }} />
                {runningAttempt && (
                  <button className="btn bad" onClick={() => run(() => api.cancelTraining(runningAttempt.attempt_id), "Đã yêu cầu huỷ")}>
                    Huỷ lượt đang chạy
                  </button>
                )}
                <button
                  className="btn"
                  disabled={busy || !!runningAttempt || recActive || !envId}
                  title="Tự thao tác trên trình duyệt; app ghi lại thành script (không dùng AI)"
                  onClick={() => {
                    setRecInput(tc.sample_input);
                    setRecOpen(true);
                  }}
                >
                  Ghi thao tác…
                </button>
                {!!state?.attempts.length && (
                  <button
                    className="btn"
                    disabled={busy || !!runningAttempt || recHere || !profileId || !envId}
                    onClick={() => start(true)}
                    title="Tạo phiên AI mới, viết lại script từ test case; không dùng candidate cũ. Prompt (nếu có) được gửi kèm."
                  >
                    Training lại từ đầu
                  </button>
                )}
                <button className="btn primary" disabled={busy || !!runningAttempt || recHere || !profileId || !envId} onClick={() => start()}>
                  {state?.candidates.length ? "Gửi prompt" : "Agent Training Auto"}
                </button>
              </div>
            </Panel>
          </div>

          {/* ---------- right: activity ---------- */}
          <div className="stack">
            <Panel title="Hoạt động của agent" actions={attempt && <Badge status={attempt.status} />} bodyClass="">
              {!attempt ? (
                <div className="empty">Chọn một lượt Training.</div>
              ) : (
                <>
                  <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--rule-2)" }} className="small">
                    <div>
                      {AGENT_LABEL[attempt.agent]} · {KIND_LABEL[attempt.kind]} · {attempt.action_count} browser action
                    </div>
                    <div className="muted">
                      Profile {profiles.find((p) => p.browser_profile_id === attempt.browser_profile_id)?.display_name ?? attempt.browser_profile_id} · Preflight {attempt.preflight_status ?? "—"}
                    </div>
                    {attempt.error && <div className={attempt.status === "AUTH_REQUIRED" ? "warn-box" : "error-box"} style={{ marginTop: 8 }}>{attempt.error}</div>}
                  </div>
                  <div className="events" ref={eventsBox}>
                    {events.length === 0 ? <div className="empty">Chưa có sự kiện.</div> : events.map((e, i) => <EventRow key={i} e={e} />)}
                  </div>
                </>
              )}
            </Panel>
            {attempt && (
              <Panel title="Kết quả cuối (screenshot)">
                <ArtifactImage refPath={attempt.artifacts.final_screenshot} alt="Screenshot cuối của lượt Training" />
              </Panel>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function CandidateView({
  candidate,
  previous,
  showDiff,
  setShowDiff,
  hasPassedTrial,
  busy,
  editLocked,
  latestTrial,
  onOpenTrial,
  onSaveEdit,
  onApprove,
  onReject,
  onExport,
}: {
  candidate: CandidateRevision & { warnings?: string[] };
  previous?: CandidateRevision;
  showDiff: boolean;
  setShowDiff: (v: boolean) => void;
  hasPassedTrial: boolean;
  busy: boolean;
  editLocked: boolean;
  latestTrial?: TrialRun;
  onOpenTrial: () => void;
  onSaveEdit: (source: string) => Promise<boolean>;
  onApprove: () => void;
  onReject: () => void;
  onExport: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const editing = draft !== null;
  const changed = editing && draft.replace(/\r\n/g, "\n") !== candidate.source;

  const onEditorKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Tab" || e.shiftKey) return;
    e.preventDefault();
    const el = e.currentTarget;
    const { selectionStart: s, selectionEnd: end } = el;
    setDraft(el.value.slice(0, s) + "  " + el.value.slice(end));
    requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
  };

  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="row">
        <Badge status={candidate.status} />
        {candidate.origin === "manual" && <span className="badge">SỬA TAY</span>}
        {candidate.origin === "recorded" && <span className="badge info">GHI THAO TÁC</span>}
        <span className="small muted">
          Revision #{candidate.revision_no} · {fmtTime(candidate.created_at)} · hash <span className="mono">{candidate.source_hash.slice(0, 12)}</span>
        </span>
        <span style={{ flex: 1 }} />
        {!editing && (
          <>
            <label className="small row" style={{ gap: 4 }}>
              <input type="checkbox" checked={showDiff} disabled={!previous} onChange={(e) => setShowDiff(e.target.checked)} /> So với #{previous?.revision_no ?? "—"}
            </label>
            <button className="btn sm" disabled={editLocked} title={editLocked ? "Đang có lượt Training chạy" : undefined} onClick={() => setDraft(candidate.source)}>
              Sửa code
            </button>
            <button className="btn sm" onClick={onExport}>
              Tải script
            </button>
          </>
        )}
      </div>
      {editing ? (
        <textarea
          className="code-editor"
          aria-label="Sửa code candidate"
          spellCheck={false}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onEditorKey}
          autoFocus
        />
      ) : (
        <div className="candidate-code">{showDiff && previous ? <DiffView before={previous.source} after={candidate.source} /> : <CodeView source={candidate.source} />}</div>
      )}
      {!editing && !!candidate.warnings?.length && (
        <div className="warn-box small">
          <strong>Cảnh báo kiểm tra script:</strong>
          {"\n"}
          {candidate.warnings.map((w) => `• ${w}`).join("\n")}
        </div>
      )}
      {editing ? (
        <div className="row">
          <span className="small muted">Lưu sẽ tạo candidate mới từ code này.</span>
          <span style={{ flex: 1 }} />
          <button className="btn" disabled={busy} onClick={() => setDraft(null)}>
            Huỷ
          </button>
          <button
            className="btn primary"
            disabled={busy || editLocked || !changed}
            onClick={async () => {
              if (await onSaveEdit(draft)) setDraft(null);
            }}
          >
            Lưu thành candidate mới
          </button>
        </div>
      ) : (
        <div className="row">
          {latestTrial ? (
            <span className="small muted row" style={{ gap: 6 }}>
              Trial gần nhất <Badge status={latestTrial.status} />
              {!hasPassedTrial && candidate.status !== "APPROVED" && "· chưa PASSED trên environment này (không bắt buộc)"}
            </span>
          ) : (
            candidate.status !== "APPROVED" && <span className="small muted">Candidate #{candidate.revision_no} chưa chạy Trial (không bắt buộc).</span>
          )}
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onOpenTrial}>
            Chạy Trial…
          </button>
          <button className="btn" disabled={busy || candidate.status !== "DRAFT"} onClick={onReject}>
            Từ chối
          </button>
          <button className="btn good" disabled={busy || candidate.status === "APPROVED"} onClick={onApprove}>
            Chấp nhận
          </button>
        </div>
      )}
    </div>
  );
}

function TrialDetail({ trial, liveSteps, envName }: { trial: TrialRun; liveSteps?: number; envName?: string }) {
  return (
    <div className="col" style={{ gap: 10, marginTop: 12 }}>
      <div className="row">
        <Badge status={trial.status} />
        {trial.error_code && <span className="badge fail">{trial.error_code}</span>}
        <span className="small muted">
          {envName ?? trial.environment_id} · input {JSON.stringify(trial.input_snapshot)}
          {trial.status === "RUNNING" && liveSteps ? ` · ${liveSteps} step` : ""}
        </span>
      </div>
      {trial.status === "PASSED" && <div className="info-box">Trial PASSED: script chạy hết action không lỗi. Đây chưa phải xác nhận kết quả nghiệp vụ.</div>}
      {trial.error_message && <div className="error-box">{trial.error_message}</div>}
      {trial.status !== "QUEUED" && trial.status !== "RUNNING" && <EvidenceShots evidence={trial.evidence_refs} what="trial" />}
      {trial.evidence_refs.steps && <StepsTable refPath={trial.evidence_refs.steps} />}
      {trial.evidence_refs.trace && (
        <button className="btn sm" style={{ alignSelf: "flex-start" }} onClick={() => api.revealArtifact(trial.evidence_refs.trace!)}>
          Mở thư mục trace (xem bằng npx playwright show-trace)
        </button>
      )}
    </div>
  );
}
