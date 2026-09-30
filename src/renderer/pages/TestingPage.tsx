import { useCallback, useEffect, useState } from "react";
import type { InputValues, TestRun } from "../../shared/types";
import { api, useAppEvent, type ApiResult } from "../api";
import { Badge, CaseOptions, EvidenceShots, InputForm, Panel, StepsTable, fmtTime, useAction } from "../components/ui";
import type { TrainingIntent } from "./TrainingPage";

type CaseRow = ApiResult<"listTestCases">[number];
type EnvRow = ApiResult<"listEnvironments">[number];
type ScriptState = ApiResult<"getScriptState">;

export function TestingPage({ intent, onSendToTraining }: { intent: { test_id: string } | null; onSendToTraining: (i: TrainingIntent) => void }) {
  const [cases, setCases] = useState<CaseRow[]>([]);
  const [envs, setEnvs] = useState<EnvRow[]>([]);
  const [testId, setTestId] = useState(intent?.test_id ?? "");
  const [envId, setEnvId] = useState("");
  const [state, setState] = useState<ScriptState | null>(null);
  const [versionNo, setVersionNo] = useState<number | null>(null);
  const [input, setInput] = useState<InputValues>({});
  const [runs, setRuns] = useState<TestRun[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [liveSteps, setLiveSteps] = useState<Record<string, number>>({});
  const { run, busy } = useAction();

  useEffect(() => {
    void Promise.all([api.listTestCases(), api.listEnvironments()]).then(([c, e]) => {
      setCases(c);
      setEnvs(e);
      setEnvId((v) => v || e[0]?.environment_id || "");
      setTestId((v) => v || c.find((x) => x.approved_count > 0)?.test_id || c[0]?.test_id || "");
    });
  }, []);
  useEffect(() => {
    if (intent) setTestId(intent.test_id);
  }, [intent]);

  const tc = cases.find((c) => c.test_id === testId) ?? null;
  const env = envs.find((e) => e.environment_id === envId) ?? null;

  const reload = useCallback(async () => {
    if (!testId) return;
    const [s, r] = await Promise.all([api.getScriptState(testId), api.listTestRuns(testId)]);
    setState(s);
    setRuns(r);
    setVersionNo((v) => (v && s.versions.some((x) => x.version_no === v && x.status === "APPROVED") ? v : (s.versions.find((x) => x.status === "APPROVED")?.version_no ?? null)));
  }, [testId]);
  useEffect(() => {
    setRunId(null);
    void reload();
  }, [reload]);
  useEffect(() => {
    if (tc) setInput(tc.sample_input);
  }, [tc]);

  useAppEvent<TestRun & { step_count?: number }>("run:update", (r) => {
    if (r.step_count !== undefined) setLiveSteps((m) => ({ ...m, [r.run_id]: r.step_count! }));
    else if (r.test_id === testId) void reload();
  });

  const selectedRun = runs.find((r) => r.run_id === runId) ?? runs[0] ?? null;
  useEffect(() => setNote(selectedRun?.review_note ?? ""), [selectedRun?.run_id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <div className="page-head">
        <h1>Testing</h1>
        <p>Chạy script đã duyệt với input của run. Không gọi AI, không tự sửa script.</p>
      </div>
      <div className="panel" style={{ padding: 12, marginBottom: 14 }}>
        <div className="row" style={{ alignItems: "flex-end" }}>
          <label className="field">
            <span>Test case</span>
            <select value={testId} onChange={(e) => setTestId(e.target.value)} style={{ minWidth: 240 }}>
              <CaseOptions cases={cases} label={(c) => `${c.test_id} — ${c.title} ${c.approved_count ? "" : "(chưa có version)"}`} />
            </select>
          </label>
          <label className="field">
            <span>Approved version</span>
            <select value={versionNo ?? ""} onChange={(e) => setVersionNo(Number(e.target.value) || null)}>
              {!versionNo && <option value="">{state?.versions.length ? "Không có version APPROVED" : "Chưa có version"}</option>}
              {state?.versions.map((v) => (
                <option key={v.version_no} value={v.version_no} disabled={v.status !== "APPROVED"}>
                  v{v.version_no} · {v.status}
                  {v.status !== "APPROVED" ? " (không chọn được)" : ""}
                </option>
              ))}
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
          {env && !env.runner_auth_ready && <span className="badge warn">Chưa có runner auth</span>}
        </div>
        {tc && (
          <div style={{ marginTop: 12 }}>
            <InputForm schema={tc.input_schema} projectId={tc.project_id} values={input} onChange={setInput} secretFieldsFromEnv={env?.secret_fields} mode="run" />
          </div>
        )}
        <div className="row end" style={{ marginTop: 12 }}>
          <button
            className="btn primary"
            disabled={busy || !tc || !versionNo || !envId}
            onClick={async () => {
              const r = await run(() => api.startTestRun(testId, versionNo!, envId, input), "Đã bắt đầu test run");
              if (r) {
                setRunId(r.run_id);
                void reload();
              }
            }}
          >
            Chạy test
          </button>
        </div>
      </div>

      <div className="split">
        <Panel title={`Test runs (${runs.length})`} bodyClass="">
          {runs.length === 0 ? (
            <div className="empty">Chưa có test run.</div>
          ) : (
            <ul className="list scroll tall">
              {runs.map((r) => (
                <li key={r.run_id} className={r.run_id === selectedRun?.run_id ? "sel" : ""} onClick={() => setRunId(r.run_id)}>
                  <div className="line">
                    <Badge status={r.execution_status} />
                    {r.review_result && <Badge status={r.review_result} />}
                    {r.error_code && <span className="badge fail">{r.error_code}</span>}
                    <span className="small muted" style={{ marginLeft: "auto" }}>
                      v{r.version_no}
                    </span>
                  </div>
                  <span className="small mono muted clip" title={JSON.stringify(r.input_snapshot, null, 2)}>
                    {JSON.stringify(r.input_snapshot)}
                  </span>
                  <span className="small muted">{fmtTime(r.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        {selectedRun && tc ? (
          <div className="stack">
            <Panel
              title={`Run ${selectedRun.run_id}`}
              actions={
                <button className="btn sm" disabled={busy || selectedRun.execution_status === "RUNNING"} onClick={() => run(() => api.exportEvidence(selectedRun.run_id))}>
                  Tải evidence (.zip)
                </button>
              }
            >
              <div className="col" style={{ gap: 12 }}>
                <div className="row">
                  <Badge status={selectedRun.execution_status} />
                  {selectedRun.error_code && <span className="badge fail">{selectedRun.error_code}</span>}
                  <span className="small muted">
                    v{selectedRun.version_no} · {envs.find((e) => e.environment_id === selectedRun.environment_id)?.name} · {fmtTime(selectedRun.started_at)}
                    {selectedRun.execution_status === "RUNNING" && liveSteps[selectedRun.run_id] ? ` · ${liveSteps[selectedRun.run_id]} step` : ""}
                  </span>
                </div>
                <div>
                  <div className="small muted" style={{ marginBottom: 4 }}>
                    Expected result
                  </div>
                  <div className="expected">{tc.expected_result}</div>
                </div>
                <dl className="kv">
                  <dt>Input</dt>
                  <dd className="mono">{JSON.stringify(selectedRun.input_snapshot)}</dd>
                  <dt>Thời gian</dt>
                  <dd>
                    {fmtTime(selectedRun.started_at)} → {fmtTime(selectedRun.finished_at)}
                  </dd>
                </dl>
                {selectedRun.error_message && <div className="error-box">{selectedRun.error_message}</div>}
                {selectedRun.execution_status === "ERROR" && (
                  <div className="row">
                    <span className="small muted">
                      {selectedRun.error_code === "LOCATOR" || selectedRun.error_code === "ACTION"
                        ? `Version v${selectedRun.version_no} đã được đánh dấu SUSPECTED_BROKEN.`
                        : selectedRun.error_code === "AUTH_REQUIRED"
                          ? "Runner chưa đăng nhập — cập nhật runner auth ở màn Environment. Script không bị đánh dấu hỏng."
                          : ""}
                    </span>
                    <span style={{ flex: 1 }} />
                    <button
                      className="btn primary"
                      onClick={() =>
                        onSendToTraining({
                          test_id: selectedRun.test_id,
                          environment_id: selectedRun.environment_id,
                          context_ref: { type: "test_run", id: selectedRun.run_id },
                          context_label: `Test run ${selectedRun.run_id} lỗi ${selectedRun.error_code ?? ""} (v${selectedRun.version_no})`,
                        })
                      }
                    >
                      Send to Training
                    </button>
                  </div>
                )}
                {selectedRun.execution_status === "COMPLETED" && (
                  <div className="panel" style={{ padding: 12 }}>
                    <div className="row">
                      <strong style={{ fontFamily: "var(--display)", letterSpacing: "0.04em" }}>ĐÁNH GIÁ CỦA NGƯỜI DÙNG</strong>
                      <Badge status={selectedRun.review_result} />
                      {selectedRun.reviewed_at && <span className="small muted">{fmtTime(selectedRun.reviewed_at)}</span>}
                    </div>
                    <textarea rows={2} style={{ width: "100%", marginTop: 8 }} placeholder="Ghi chú (tuỳ chọn)" value={note} onChange={(e) => setNote(e.target.value)} />
                    <div className="row end" style={{ marginTop: 8 }}>
                      <button className="btn bad" disabled={busy} onClick={() => run(() => api.reviewTestRun(selectedRun.run_id, "FAIL", note), "Đã đánh giá FAIL").then(reload)}>
                        FAIL
                      </button>
                      <button className="btn good" disabled={busy} onClick={() => run(() => api.reviewTestRun(selectedRun.run_id, "PASS", note), "Đã đánh giá PASS").then(reload)}>
                        PASS
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </Panel>
            <Panel title="Evidence">
              <div className="col" style={{ gap: 12 }}>
                {selectedRun.finished_at && <EvidenceShots evidence={selectedRun.evidence_refs} what="test run" />}
                <StepsTable refPath={selectedRun.evidence_refs.steps} />
                {selectedRun.evidence_refs.trace && (
                  <button className="btn sm" style={{ alignSelf: "flex-start" }} onClick={() => api.revealArtifact(selectedRun.evidence_refs.trace!)}>
                    Mở thư mục trace
                  </button>
                )}
              </div>
            </Panel>
          </div>
        ) : (
          <div className="panel empty">Chọn một test run để xem evidence.</div>
        )}
      </div>
    </div>
  );
}
