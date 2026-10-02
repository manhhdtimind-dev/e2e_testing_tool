import { useCallback, useEffect, useMemo, useState } from "react";
import type { InputValues, TestRun } from "../../shared/types";
import { api, useAppEvent, type ApiResult } from "../api";
import { ALL, CASE_COLUMNS, CaseFilterBar, LastRun, SortTh, projectsOf, useCaseFilter, useSort, type SortState } from "../components/caseTable";
import { Badge, EvidenceShots, InputForm, Modal, Panel, StepsTable, fmtTime, groupLabel, useAction } from "../components/ui";
import type { TrainingIntent } from "./TrainingPage";

type CaseRow = ApiResult<"listTestCases">[number];
type EnvRow = ApiResult<"listEnvironments">[number];
type ScriptState = ApiResult<"getScriptState">;

export interface TestingIntent {
  test_id: string;
  nonce: number;
}

/** An intent opens the run dialog once, not again each time the page is shown. */
let handledIntent = 0;

const RUN_COLUMNS: Record<string, (r: TestRun) => string | number | null> = {
  created: (r) => r.created_at,
  version: (r) => r.version_no,
  status: (r) => r.execution_status,
  review: (r) => r.review_result,
  duration: (r) => duration(r),
};
const NEWEST_FIRST: SortState = { key: "created", desc: true };

function duration(r: TestRun): number | null {
  return r.started_at && r.finished_at ? new Date(r.finished_at).getTime() - new Date(r.started_at).getTime() : null;
}

function RunDialog({ tc, envs, envId, onEnv, onClose, onStarted }: { tc: CaseRow; envs: EnvRow[]; envId: string; onEnv: (id: string) => void; onClose: () => void; onStarted: (run: TestRun) => void }) {
  const [state, setState] = useState<ScriptState | null>(null);
  const [versionNo, setVersionNo] = useState<number | null>(tc.latest_approved);
  const [input, setInput] = useState<InputValues>(tc.sample_input);
  const { run, busy } = useAction();
  const env = envs.find((e) => e.environment_id === envId) ?? null;
  useEffect(() => {
    void api.getScriptState(tc.test_id).then(setState);
  }, [tc.test_id]);
  return (
    <Modal
      title={`Chạy test — ${tc.test_id}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Huỷ
          </button>
          <button
            className="btn primary"
            disabled={busy || !versionNo || !envId}
            onClick={async () => {
              const r = await run(() => api.startTestRun(tc.test_id, versionNo!, envId, input), "Đã bắt đầu test run");
              if (r) onStarted(r);
            }}
          >
            Chạy test
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="muted">{tc.title}</div>
        <div className="row" style={{ alignItems: "flex-end" }}>
          <label className="field">
            <span>Approved version</span>
            <select value={versionNo ?? ""} onChange={(e) => setVersionNo(Number(e.target.value) || null)}>
              {!versionNo && <option value="">Không có version APPROVED</option>}
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
            <select value={envId} onChange={(e) => onEnv(e.target.value)}>
              {envs.map((e) => (
                <option key={e.environment_id} value={e.environment_id}>
                  {e.name}
                </option>
              ))}
            </select>
          </label>
          {env && !env.runner_auth_ready && <span className="badge warn">Chưa có runner auth</span>}
        </div>
        <InputForm schema={tc.input_schema} projectId={tc.project_id} values={input} onChange={setInput} secretFieldsFromEnv={env?.secret_fields} mode="run" />
      </div>
    </Modal>
  );
}

function RunDrawer({
  run: r,
  tc,
  envs,
  liveSteps,
  onClose,
  onChanged,
  onSendToTraining,
}: {
  run: TestRun;
  tc: CaseRow;
  envs: EnvRow[];
  liveSteps?: number;
  onClose: () => void;
  onChanged: () => void;
  onSendToTraining: (i: TrainingIntent) => void;
}) {
  const [note, setNote] = useState(r.review_note ?? "");
  const { run, busy } = useAction();
  useEffect(() => setNote(r.review_note ?? ""), [r.run_id]); // eslint-disable-line react-hooks/exhaustive-deps
  const review = (result: "PASS" | "FAIL") => run(() => api.reviewTestRun(r.run_id, result, note), `Đã đánh giá ${result}`).then(onChanged);
  return (
    <Modal
      drawer
      title={`${tc.test_id} · Run ${r.run_id}`}
      onClose={onClose}
      actions={
        <button className="btn sm" disabled={busy || r.execution_status === "RUNNING"} onClick={() => run(() => api.exportEvidence(r.run_id))}>
          Tải evidence (.zip)
        </button>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        <div className="row">
          <Badge status={r.execution_status} />
          {r.error_code && <span className="badge fail">{r.error_code}</span>}
          <span className="small muted">
            v{r.version_no} · {envs.find((e) => e.environment_id === r.environment_id)?.name} · {fmtTime(r.started_at)}
            {r.execution_status === "RUNNING" && liveSteps ? ` · ${liveSteps} step` : ""}
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
          <dd className="mono">{JSON.stringify(r.input_snapshot)}</dd>
          <dt>Thời gian</dt>
          <dd>
            {fmtTime(r.started_at)} → {fmtTime(r.finished_at)}
          </dd>
        </dl>
        {r.error_message && <div className="error-box">{r.error_message}</div>}
        {r.execution_status === "ERROR" && (
          <div className="row">
            <span className="small muted">
              {r.error_code === "LOCATOR" || r.error_code === "ACTION"
                ? `Version v${r.version_no} đã được đánh dấu SUSPECTED_BROKEN.`
                : r.error_code === "AUTH_REQUIRED"
                  ? "Runner chưa đăng nhập — cập nhật runner auth ở màn Environment. Script không bị đánh dấu hỏng."
                  : ""}
            </span>
            <span style={{ flex: 1 }} />
            <button
              className="btn primary"
              onClick={() =>
                onSendToTraining({
                  test_id: r.test_id,
                  environment_id: r.environment_id,
                  context_ref: { type: "test_run", id: r.run_id },
                  context_label: `Test run ${r.run_id} lỗi ${r.error_code ?? ""} (v${r.version_no})`,
                })
              }
            >
              Send to Training
            </button>
          </div>
        )}
        {r.execution_status === "COMPLETED" && (
          <div className="panel" style={{ padding: 12 }}>
            <div className="row">
              <strong style={{ fontFamily: "var(--display)", letterSpacing: "0.04em" }}>ĐÁNH GIÁ CỦA NGƯỜI DÙNG</strong>
              <Badge status={r.review_result} />
              {r.reviewed_at && <span className="small muted">{fmtTime(r.reviewed_at)}</span>}
            </div>
            <textarea rows={2} style={{ width: "100%", marginTop: 8 }} placeholder="Ghi chú (tuỳ chọn)" value={note} onChange={(e) => setNote(e.target.value)} />
            <div className="row end" style={{ marginTop: 8 }}>
              <button className="btn bad" disabled={busy} onClick={() => review("FAIL")}>
                FAIL
              </button>
              <button className="btn good" disabled={busy} onClick={() => review("PASS")}>
                PASS
              </button>
            </div>
          </div>
        )}
        <Panel title="Evidence">
          <div className="col" style={{ gap: 12 }}>
            {r.finished_at ? <EvidenceShots evidence={r.evidence_refs} what="test run" /> : <span className="muted small">Đang chạy…</span>}
            <StepsTable refPath={r.evidence_refs.steps} />
            {r.evidence_refs.trace && (
              <button className="btn sm" style={{ alignSelf: "flex-start" }} onClick={() => api.revealArtifact(r.evidence_refs.trace!)}>
                Mở thư mục trace
              </button>
            )}
          </div>
        </Panel>
      </div>
    </Modal>
  );
}

export function TestingPage({ intent, onSendToTraining }: { intent: TestingIntent | null; onSendToTraining: (i: TrainingIntent) => void }) {
  const [cases, setCases] = useState<CaseRow[]>([]);
  const [envs, setEnvs] = useState<EnvRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [testId, setTestId] = useState(intent?.test_id ?? "");
  const [envId, setEnvId] = useState("");
  const [runs, setRuns] = useState<TestRun[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [runFor, setRunFor] = useState<string | null>(null);
  const [liveSteps, setLiveSteps] = useState<Record<string, number>>({});

  const loadCases = useCallback(async () => {
    const [c, e] = await Promise.all([api.listTestCases(), api.listEnvironments()]);
    setCases(c);
    setEnvs(e);
    setEnvId((v) => v || e[0]?.environment_id || "");
    setTestId((v) => v || c.find((x) => x.approved_count > 0)?.test_id || "");
    setLoaded(true);
  }, []);
  useEffect(() => {
    void loadCases();
  }, [loadCases]);

  const loadRuns = useCallback(async () => {
    setRuns(testId ? await api.listTestRuns(testId) : []);
  }, [testId]);
  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    if (!intent || intent.nonce === handledIntent || !loaded) return;
    handledIntent = intent.nonce;
    setTestId(intent.test_id);
    if (cases.find((c) => c.test_id === intent.test_id)?.latest_approved) setRunFor(intent.test_id);
  }, [intent, loaded, cases]);

  useAppEvent<TestRun & { step_count?: number }>("run:update", (r) => {
    if (r.step_count !== undefined) return setLiveSteps((m) => ({ ...m, [r.run_id]: r.step_count! }));
    void loadCases();
    if (r.test_id === testId) void loadRuns();
  });

  const projects = useMemo(() => projectsOf(cases), [cases]);
  const filter = useCaseFilter(cases, projects, "testing.filter", loaded);
  const caseSort = useSort(filter.shown, CASE_COLUMNS);
  const runSort = useSort(runs, RUN_COLUMNS, NEWEST_FIRST);
  const tc = cases.find((c) => c.test_id === testId) ?? null;
  const runCase = cases.find((c) => c.test_id === runFor) ?? null;
  const openRun = runs.find((r) => r.run_id === runId) ?? null;

  return (
    <div>
      <div className="page-head">
        <h1>Testing</h1>
        <p>Chạy script đã duyệt với input của run. Không gọi AI, không tự sửa script.</p>
      </div>
      <Panel title={`Test case (${filter.shown.length}/${cases.length})`} bodyClass="">
        <CaseFilterBar filter={filter} />
        {filter.shown.length === 0 ? (
          <div className="empty">{cases.length ? "Không có test case khớp bộ lọc." : "Chưa có test case."}</div>
        ) : (
          <div className="table-wrap">
            <table className="t case-table">
              <thead>
                <tr>
                  <SortTh label="test_id" k="test_id" sort={caseSort.sort} onSort={caseSort.toggle} />
                  <SortTh label="Title" k="title" sort={caseSort.sort} onSort={caseSort.toggle} className="wide" />
                  {filter.project === ALL && <SortTh label="Dự án" k="project" sort={caseSort.sort} onSort={caseSort.toggle} />}
                  <SortTh label="Nhóm" k="group" sort={caseSort.sort} onSort={caseSort.toggle} />
                  <SortTh label="Version" k="version" sort={caseSort.sort} onSort={caseSort.toggle} />
                  <SortTh label="Lần chạy gần nhất" k="last_run" sort={caseSort.sort} onSort={caseSort.toggle} />
                  <th aria-label="Thao tác" />
                </tr>
              </thead>
              <tbody>
                {caseSort.sorted.map((c) => (
                  <tr key={c.test_id} className={`click ${c.test_id === testId ? "sel" : ""}`} onClick={() => setTestId(c.test_id)}>
                    <td className="mono nowrap">{c.test_id}</td>
                    <td className="clip-cell" title={c.title}>
                      {c.title}
                    </td>
                    {filter.project === ALL && <td className="nowrap">{c.project_name || "—"}</td>}
                    <td className="nowrap">{groupLabel(c.group_name)}</td>
                    <td className="nowrap">{c.latest_approved ? <span className="badge pass">v{c.latest_approved}</span> : <span className="muted small">Chưa có version APPROVED</span>}</td>
                    <td className="nowrap">
                      <LastRun run={c.last_run} withTime />
                    </td>
                    <td className="row-actions" onClick={(e) => e.stopPropagation()}>
                      <button className="btn sm primary" disabled={!c.latest_approved} title={c.latest_approved ? undefined : "Chưa có version APPROVED"} onClick={() => setRunFor(c.test_id)}>
                        Chạy…
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title={tc ? `Lần chạy — ${tc.test_id} (${runs.length})` : "Lần chạy"} bodyClass="">
        {!tc ? (
          <div className="empty">Chọn một test case ở bảng trên để xem các lần chạy.</div>
        ) : runs.length === 0 ? (
          <div className="empty">Chưa có lần chạy nào.</div>
        ) : (
          <div className="table-wrap">
            <table className="t run-table">
              <thead>
                <tr>
                  <SortTh label="Thời gian" k="created" sort={runSort.sort} onSort={runSort.toggle} />
                  <SortTh label="Version" k="version" sort={runSort.sort} onSort={runSort.toggle} />
                  <th>Environment</th>
                  <SortTh label="Kết quả chạy" k="status" sort={runSort.sort} onSort={runSort.toggle} />
                  <SortTh label="Đánh giá" k="review" sort={runSort.sort} onSort={runSort.toggle} />
                  <th className="wide">Input</th>
                  <SortTh label="Thời lượng" k="duration" sort={runSort.sort} onSort={runSort.toggle} className="num" />
                </tr>
              </thead>
              <tbody>
                {runSort.sorted.map((r) => {
                  const ms = duration(r);
                  return (
                    <tr key={r.run_id} className={`click ${r.run_id === runId ? "sel" : ""}`} onClick={() => setRunId(r.run_id)}>
                      <td className="nowrap">{fmtTime(r.created_at)}</td>
                      <td>v{r.version_no}</td>
                      <td className="nowrap">{envs.find((e) => e.environment_id === r.environment_id)?.name ?? "—"}</td>
                      <td className="nowrap">
                        <span className="badges">
                          <Badge status={r.execution_status} />
                          {r.error_code && <span className="badge fail">{r.error_code}</span>}
                          {r.execution_status === "RUNNING" && liveSteps[r.run_id] ? <span className="small muted">{liveSteps[r.run_id]} step</span> : null}
                        </span>
                      </td>
                      <td>{r.execution_status === "COMPLETED" ? <Badge status={r.review_result} /> : <span className="muted small">—</span>}</td>
                      <td className="mono small clip-cell" title={JSON.stringify(r.input_snapshot, null, 2)}>
                        {JSON.stringify(r.input_snapshot)}
                      </td>
                      <td className="num small muted">{ms === null ? "—" : `${(ms / 1000).toFixed(1)} s`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {runCase && (
        <RunDialog
          tc={runCase}
          envs={envs}
          envId={envId}
          onEnv={setEnvId}
          onClose={() => setRunFor(null)}
          onStarted={(r) => {
            setRunFor(null);
            setTestId(r.test_id);
            setRuns((list) => [r, ...list.filter((x) => x.run_id !== r.run_id)]);
            setRunId(r.run_id);
            void loadCases();
          }}
        />
      )}
      {openRun && tc && (
        <RunDrawer
          run={openRun}
          tc={tc}
          envs={envs}
          liveSteps={liveSteps[openRun.run_id]}
          onClose={() => setRunId(null)}
          onChanged={() => {
            void loadRuns();
            void loadCases();
          }}
          onSendToTraining={onSendToTraining}
        />
      )}
    </div>
  );
}
