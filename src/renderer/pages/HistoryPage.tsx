import { useCallback, useEffect, useState } from "react";
import type { AgentProvider, AuditEntry } from "../../shared/types";
import { api, type ApiResult } from "../api";
import { Badge, CodeView, EvidenceShots, Panel, StepsTable, fmtTime, useAction } from "../components/ui";

type HistoryRow = ApiResult<"queryHistory">[number];
type TrialRow = ApiResult<"listTrialHistory">[number];
type AttemptRow = ApiResult<"listAttemptHistory">[number];
type EnvRow = ApiResult<"listEnvironments">[number];

type Tab = "runs" | "trials" | "attempts" | "audit";

export function HistoryPage({ onOpenTraining }: { onOpenTraining: (testId: string) => void }) {
  const [tab, setTab] = useState<Tab>("runs");
  const [envs, setEnvs] = useState<EnvRow[]>([]);
  const [filter, setFilter] = useState({ test_id: "", agent: "" as AgentProvider | "", version_no: "", environment_id: "", status: "", from: "", to: "" });
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [trials, setTrials] = useState<TrialRow[]>([]);
  const [attempts, setAttempts] = useState<AttemptRow[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [selected, setSelected] = useState<HistoryRow | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const { run, busy } = useAction();

  useEffect(() => {
    api.listEnvironments().then(setEnvs);
  }, []);

  const load = useCallback(async () => {
    if (tab === "runs") {
      setRows(
        await api.queryHistory({
          test_id: filter.test_id || undefined,
          agent: filter.agent,
          version_no: filter.version_no ? Number(filter.version_no) : null,
          environment_id: filter.environment_id || undefined,
          status: filter.status || undefined,
          from: filter.from || undefined,
          to: filter.to || undefined,
        }),
      );
    } else if (tab === "trials") setTrials(await api.listTrialHistory(filter.test_id || undefined));
    else if (tab === "attempts") setAttempts(await api.listAttemptHistory(filter.test_id || undefined));
    else setAudit(await api.listAudit(500));
  }, [tab, filter]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setSource(null);
    if (!selected) return;
    api.getScriptState(selected.test_id).then((s) => setSource(s.versions.find((v) => v.version_no === selected.version_no)?.source ?? null));
  }, [selected]);

  const envName = (id: string) => envs.find((e) => e.environment_id === id)?.name ?? id;

  return (
    <div>
      <div className="page-head">
        <h1>History</h1>
        <p>Tra cứu test run, trial, lượt Training và audit log.</p>
      </div>
      <div className="tabs" role="tablist">
        {(
          [
            ["runs", "Test runs"],
            ["trials", "Trials"],
            ["attempts", "Lượt Training"],
            ["audit", "Audit log"],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {tab !== "audit" && (
        <div className="panel" style={{ padding: 12, marginBottom: 14 }}>
          <div className="row" style={{ alignItems: "flex-end" }}>
            <label className="field">
              <span>Test ID</span>
              <input type="text" value={filter.test_id} onChange={(e) => setFilter({ ...filter, test_id: e.target.value })} />
            </label>
            {tab === "runs" && (
              <>
                <label className="field">
                  <span>Agent</span>
                  <select value={filter.agent} onChange={(e) => setFilter({ ...filter, agent: e.target.value as AgentProvider | "" })}>
                    <option value="">Tất cả</option>
                    <option value="cursor">Cursor</option>
                    <option value="codex">Codex</option>
                  </select>
                </label>
                <label className="field">
                  <span>Version</span>
                  <input type="number" min={1} style={{ width: 80 }} value={filter.version_no} onChange={(e) => setFilter({ ...filter, version_no: e.target.value })} />
                </label>
                <label className="field">
                  <span>Environment</span>
                  <select value={filter.environment_id} onChange={(e) => setFilter({ ...filter, environment_id: e.target.value })}>
                    <option value="">Tất cả</option>
                    {envs.map((e) => (
                      <option key={e.environment_id} value={e.environment_id}>
                        {e.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Trạng thái</span>
                  <select value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })}>
                    <option value="">Tất cả</option>
                    {["COMPLETED", "ERROR", "PENDING", "PASS", "FAIL", "LOCATOR", "ACTION", "TIMEOUT", "AUTH_REQUIRED"].map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Từ ngày</span>
                  <input type="date" value={filter.from} onChange={(e) => setFilter({ ...filter, from: e.target.value })} />
                </label>
                <label className="field">
                  <span>Đến ngày</span>
                  <input type="date" value={filter.to} onChange={(e) => setFilter({ ...filter, to: e.target.value })} />
                </label>
              </>
            )}
            <button className="btn" onClick={() => void load()}>
              Làm mới
            </button>
          </div>
        </div>
      )}

      {tab === "runs" && (
        <div className="split" style={{ gridTemplateColumns: "minmax(0, 1.3fr) minmax(0, 1fr)" }}>
          <Panel title={`Test runs (${rows.length})`} bodyClass="scroll tall">
            <table className="t">
              <thead>
                <tr>
                  <th>Thời gian</th>
                  <th>Test ID</th>
                  <th>Version</th>
                  <th>Agent</th>
                  <th>Env</th>
                  <th>Thực thi</th>
                  <th>Đánh giá</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.run_id} className={`click ${selected?.run_id === r.run_id ? "sel" : ""}`} onClick={() => setSelected(r)}>
                    <td className="small">{fmtTime(r.created_at)}</td>
                    <td className="mono">{r.test_id}</td>
                    <td>v{r.version_no}</td>
                    <td>{r.agent ?? "—"}</td>
                    <td className="small">{envName(r.environment_id)}</td>
                    <td>
                      <Badge status={r.execution_status} /> {r.error_code && <span className="badge fail">{r.error_code}</span>}
                    </td>
                    <td>
                      <Badge status={r.review_result} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && <div className="empty">Không có test run phù hợp bộ lọc.</div>}
          </Panel>
          {selected ? (
            <div className="stack">
              <Panel
                title={selected.run_id}
                actions={
                  <div className="row">
                    <button className="btn sm" disabled={busy} onClick={() => run(() => api.exportVersion(selected.script_id, selected.version_no, selected.test_id))}>
                      Tải script
                    </button>
                    <button className="btn sm" disabled={busy} onClick={() => run(() => api.exportEvidence(selected.run_id))}>
                      Tải evidence
                    </button>
                  </div>
                }
              >
                <dl className="kv">
                  <dt>Test case</dt>
                  <dd>
                    <span className="mono">{selected.test_id}</span>{" "}
                    <button className="btn sm ghost" onClick={() => onOpenTraining(selected.test_id)}>
                      Mở Training
                    </button>
                  </dd>
                  <dt>Version / Agent</dt>
                  <dd>
                    v{selected.version_no} · {selected.agent ?? "—"}
                  </dd>
                  <dt>Environment</dt>
                  <dd>{envName(selected.environment_id)}</dd>
                  <dt>Input</dt>
                  <dd className="mono">{JSON.stringify(selected.input_snapshot)}</dd>
                  <dt>Thực thi</dt>
                  <dd>
                    <Badge status={selected.execution_status} /> {selected.error_code}
                  </dd>
                  <dt>Đánh giá</dt>
                  <dd>
                    <Badge status={selected.review_result} /> {selected.review_note}
                  </dd>
                  <dt>Thời gian</dt>
                  <dd>
                    {fmtTime(selected.started_at)} → {fmtTime(selected.finished_at)}
                  </dd>
                </dl>
                {selected.error_message && <div className="error-box" style={{ marginTop: 10 }}>{selected.error_message}</div>}
              </Panel>
              <Panel title="Evidence">
                <div className="col" style={{ gap: 12 }}>
                  <EvidenceShots evidence={selected.evidence_refs} what="test run" />
                  <StepsTable refPath={selected.evidence_refs.steps} />
                </div>
              </Panel>
              {source && (
                <Panel title={`Script v${selected.version_no}`}>
                  <CodeView source={source} />
                </Panel>
              )}
            </div>
          ) : (
            <div className="panel empty">Chọn một run để xem chi tiết.</div>
          )}
        </div>
      )}

      {tab === "trials" && (
        <Panel title={`Trials (${trials.length})`} bodyClass="scroll tall">
          <table className="t">
            <thead>
              <tr>
                <th>Thời gian</th>
                <th>Test ID</th>
                <th>Revision</th>
                <th>Hash</th>
                <th>Env</th>
                <th>Trạng thái</th>
                <th>Lỗi</th>
              </tr>
            </thead>
            <tbody>
              {trials.map((t) => (
                <tr key={t.trial_id}>
                  <td className="small">{fmtTime(t.created_at)}</td>
                  <td className="mono">{t.test_id}</td>
                  <td>#{t.revision_no}</td>
                  <td className="mono">{t.source_hash.slice(0, 10)}</td>
                  <td className="small">{envName(t.environment_id)}</td>
                  <td>
                    <Badge status={t.status} />
                  </td>
                  <td className="small">{t.error_code ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      {tab === "attempts" && (
        <Panel title={`Lượt Training (${attempts.length})`} bodyClass="scroll tall">
          <table className="t">
            <thead>
              <tr>
                <th>Thời gian</th>
                <th>Test ID</th>
                <th>Agent</th>
                <th>Loại</th>
                <th>Prompt</th>
                <th>Trạng thái</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {attempts.map((a) => (
                <tr key={a.attempt_id} className="click" onClick={() => onOpenTraining(a.test_id)}>
                  <td className="small">{fmtTime(a.created_at)}</td>
                  <td className="mono">{a.test_id}</td>
                  <td>{a.agent}</td>
                  <td className="small">{a.kind}</td>
                  <td className="small">{a.prompt.slice(0, 100)}</td>
                  <td>
                    <Badge status={a.status} />
                  </td>
                  <td>{a.action_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      {tab === "audit" && (
        <Panel title="Audit log (500 bản ghi gần nhất)" bodyClass="scroll tall">
          <table className="t">
            <thead>
              <tr>
                <th>Thời gian</th>
                <th>Hành động</th>
                <th>Đối tượng</th>
                <th>Chi tiết</th>
              </tr>
            </thead>
            <tbody>
              {audit.map((a) => (
                <tr key={a.id}>
                  <td className="small">{fmtTime(a.at)}</td>
                  <td className="mono">{a.action}</td>
                  <td className="small">
                    {a.entity} <span className="mono muted">{a.entity_id}</span>
                  </td>
                  <td className="mono small pre">{JSON.stringify(a.details)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </div>
  );
}
