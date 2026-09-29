import { useCallback, useEffect, useMemo, useState } from "react";
import type { ImportPreview, InputField, InputSchema, InputValues, ParsedTestCase } from "../../shared/types";
import { api, type ApiResult } from "../api";
import { Badge, Modal, Panel, fmtTime, useAction, useToast } from "../components/ui";

type CaseRow = ApiResult<"listTestCases">[number];

const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

function localIssues(d: Draft): string[] {
  const issues: string[] = [];
  if (!d.test_id.trim()) issues.push("Thiếu test_id");
  if (!d.title.trim()) issues.push("Thiếu title");
  if (!d.steps.trim()) issues.push("Thiếu steps");
  if (!d.expected_result.trim()) issues.push("Thiếu expected_result");
  const names = new Set(d.schema.fields.map((f) => f.name));
  for (const m of d.steps.matchAll(VAR_RE)) if (!names.has(m[1])) issues.push(`Biến {{${m[1]}}} không có trong input_schema`);
  for (const f of d.schema.fields) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(f.name)) issues.push(`Tên biến không hợp lệ: "${f.name}"`);
  return [...new Set(issues)];
}

interface Draft {
  test_id: string;
  title: string;
  steps: string;
  schema: InputSchema;
  sample: InputValues;
  expected_result: string;
}

const emptyDraft = (): Draft => ({ test_id: "", title: "", steps: "", schema: { fields: [] }, sample: {}, expected_result: "" });

function SchemaEditor({ draft, setDraft }: { draft: Draft; setDraft: (d: Draft) => void }) {
  const update = (i: number, patch: Partial<InputField>, value?: string) => {
    const fields = draft.schema.fields.map((f, idx) => (idx === i ? { ...f, ...patch } : f));
    const sample = { ...draft.sample };
    const old = draft.schema.fields[i];
    if (patch.name !== undefined && patch.name !== old.name) {
      sample[patch.name] = sample[old.name] ?? "";
      delete sample[old.name];
    }
    if (value !== undefined) sample[fields[i].name] = value;
    setDraft({ ...draft, schema: { fields }, sample });
  };
  const add = () => setDraft({ ...draft, schema: { fields: [...draft.schema.fields, { name: `field_${draft.schema.fields.length + 1}`, type: "string", required: true, secret: false }] } });
  const remove = (i: number) => {
    const f = draft.schema.fields[i];
    const sample = { ...draft.sample };
    delete sample[f.name];
    setDraft({ ...draft, schema: { fields: draft.schema.fields.filter((_, idx) => idx !== i) }, sample });
  };
  const missing = [...new Set([...draft.steps.matchAll(VAR_RE)].map((m) => m[1]))].filter((v) => !draft.schema.fields.some((f) => f.name === v));
  return (
    <div className="col">
      <table className="t">
        <thead>
          <tr>
            <th>Biến</th>
            <th>Kiểu</th>
            <th>Bắt buộc</th>
            <th>Secret</th>
            <th>Giá trị mẫu (training)</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {draft.schema.fields.map((f, i) => (
            <tr key={i}>
              <td>
                <input type="text" value={f.name} onChange={(e) => update(i, { name: e.target.value })} className="mono" />
              </td>
              <td>
                <select value={f.type} onChange={(e) => update(i, { type: e.target.value as InputField["type"] })}>
                  <option value="string">string</option>
                  <option value="number">number</option>
                  <option value="boolean">boolean</option>
                </select>
              </td>
              <td>
                <input type="checkbox" checked={f.required} onChange={(e) => update(i, { required: e.target.checked })} aria-label="Bắt buộc" />
              </td>
              <td>
                <input type="checkbox" checked={f.secret} onChange={(e) => update(i, { secret: e.target.checked })} aria-label="Secret" />
              </td>
              <td>
                {f.secret ? (
                  <span className="muted small">Lưu trong secret của environment</span>
                ) : (
                  <input type="text" value={draft.sample[f.name] ?? ""} onChange={(e) => update(i, {}, e.target.value)} />
                )}
              </td>
              <td>
                <button className="btn sm" onClick={() => remove(i)}>
                  Xoá
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row">
        <button className="btn sm" onClick={add}>
          Thêm biến
        </button>
        {missing.map((v) => (
          <button
            key={v}
            className="btn sm"
            onClick={() => setDraft({ ...draft, schema: { fields: [...draft.schema.fields, { name: v, type: "string", required: true, secret: false }] } })}
          >
            Thêm {`{{${v}}}`} từ steps
          </button>
        ))}
      </div>
    </div>
  );
}

function ImportModal({ preview, onClose, onDone }: { preview: ImportPreview; onClose: () => void; onDone: () => void }) {
  const [cases, setCases] = useState<ParsedTestCase[]>(preview.cases);
  const [editing, setEditing] = useState<number | null>(null);
  const { run, busy } = useAction();
  const draftOf = (c: ParsedTestCase): Draft => ({ test_id: c.test_id, title: c.title, steps: c.steps.join("\n"), schema: c.input_schema, sample: c.input, expected_result: c.expected_result });
  const perCase = cases.map((c) => localIssues(draftOf(c)));
  const blocking = perCase.some((i) => i.length > 0);
  const fileIssues = preview.issues.filter((i) => i.row === 1 && i.column !== "*" && cases.length === 0);

  return (
    <Modal
      title={`Xem bản parse — ${preview.file_name}`}
      onClose={onClose}
      footer={
        <>
          <span className="muted small" style={{ marginRight: "auto" }}>
            {cases.length} test case · {blocking ? "còn lỗi cần sửa trước khi lưu" : "sẵn sàng lưu"}
          </span>
          <button className="btn" onClick={onClose}>
            Huỷ
          </button>
          <button
            className="btn primary"
            disabled={busy || blocking || cases.length === 0}
            onClick={async () => {
              const r = await run(() => api.confirmImport(preview.file_name, cases), `Đã lưu ${cases.length} test case`);
              if (r) onDone();
            }}
          >
            Xác nhận và lưu
          </button>
        </>
      }
    >
      {preview.issues.length > 0 && (
        <div className="warn-box" style={{ marginBottom: 12 }}>
          <strong>Parser báo {preview.issues.length} vấn đề:</strong>
          {"\n"}
          {preview.issues.map((i) => `• Dòng ${i.row}, cột ${i.column}: ${i.message}`).join("\n")}
        </div>
      )}
      {fileIssues.length > 0 && <div className="error-box">File không đúng template (cần các cột test_id, title, steps, input, expected_result).</div>}
      <table className="t">
        <thead>
          <tr>
            <th>Dòng</th>
            <th>test_id</th>
            <th>Title</th>
            <th>Steps</th>
            <th>Input</th>
            <th>Trạng thái</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {cases.map((c, i) => (
            <tr key={i}>
              <td>{c.row}</td>
              <td className="mono">{c.test_id}</td>
              <td>{c.title}</td>
              <td>{c.steps.length}</td>
              <td className="mono small">{Object.keys(c.input).join(", ") || "—"}</td>
              <td>{perCase[i].length ? <span className="badge fail" title={perCase[i].join("\n")}>{perCase[i].length} LỖI</span> : <span className="badge pass">HỢP LỆ</span>}</td>
              <td className="row">
                <button className="btn sm" onClick={() => setEditing(i)}>
                  Sửa
                </button>
                <button className="btn sm" onClick={() => setCases(cases.filter((_, idx) => idx !== i))}>
                  Bỏ
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing !== null && cases[editing] && (
        <div className="panel" style={{ marginTop: 14 }}>
          <header>
            <h2>Sửa dòng {cases[editing].row}</h2>
          </header>
          <div className="body">
            <CaseEditor
              draft={draftOf(cases[editing])}
              lockId={false}
              onChange={(d) =>
                setCases(
                  cases.map((c, idx) =>
                    idx === editing ? { ...c, test_id: d.test_id, title: d.title, steps: d.steps.split("\n").map((s) => s.trim()).filter(Boolean), input_schema: d.schema, input: d.sample, expected_result: d.expected_result } : c,
                  ),
                )
              }
            />
            {perCase[editing].length > 0 && <div className="error-box" style={{ marginTop: 10 }}>{perCase[editing].join("\n")}</div>}
          </div>
        </div>
      )}
    </Modal>
  );
}

function CaseEditor({ draft, onChange, lockId }: { draft: Draft; onChange: (d: Draft) => void; lockId: boolean }) {
  return (
    <div className="stack">
      <div className="form-grid">
        <label className="field">
          <span>test_id</span>
          <input type="text" className="mono" value={draft.test_id} disabled={lockId} onChange={(e) => onChange({ ...draft, test_id: e.target.value })} />
        </label>
        <label className="field" style={{ gridColumn: "span 2" }}>
          <span>Title</span>
          <input type="text" value={draft.title} onChange={(e) => onChange({ ...draft, title: e.target.value })} />
        </label>
      </div>
      <label className="field">
        <span>Steps (mỗi dòng một bước, dùng {"{{bien}}"} cho dữ liệu)</span>
        <textarea rows={7} value={draft.steps} onChange={(e) => onChange({ ...draft, steps: e.target.value })} />
      </label>
      <div className="field">
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-2)" }}>Input schema</span>
        <SchemaEditor draft={draft} setDraft={onChange} />
      </div>
      <label className="field">
        <span>Expected result (người dùng tự đánh giá khi Testing)</span>
        <textarea rows={2} value={draft.expected_result} onChange={(e) => onChange({ ...draft, expected_result: e.target.value })} />
      </label>
    </div>
  );
}

export function TestCasesPage({ onTrain, onTest }: { onTrain: (testId: string) => void; onTest: (testId: string) => void }) {
  const [cases, setCases] = useState<CaseRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [filter, setFilter] = useState("");
  const { run, busy } = useAction();
  const toast = useToast();

  const load = useCallback(async () => setCases(await api.listTestCases()), []);
  useEffect(() => {
    void load();
  }, [load]);

  const current = useMemo(() => cases.find((c) => c.test_id === selected) ?? null, [cases, selected]);
  useEffect(() => {
    if (current && !isNew) {
      setDraft({ test_id: current.test_id, title: current.title, steps: current.steps.join("\n"), schema: current.input_schema, sample: current.sample_input, expected_result: current.expected_result });
    }
  }, [current, isNew]);

  const issues = draft ? localIssues(draft) : [];
  const shown = cases.filter((c) => !filter || `${c.test_id} ${c.title}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div>
      <div className="page-head">
        <h1>Test Cases</h1>
        <p>Import manual test case, kiểm tra bản parse và input schema.</p>
        <div className="actions">
          <button className="btn ghost" disabled={busy} onClick={() => run(() => api.openSampleTemplate())} title="Mở file .xlsx mẫu bằng ứng dụng mặc định (Excel)">
            Mở file mẫu
          </button>
          <button
            className="btn ghost"
            disabled={busy}
            onClick={async () => {
              const f = await run(() => api.saveSampleTemplate());
              if (f) toast(`Đã lưu file mẫu: ${f}`, "ok");
            }}
          >
            Lưu file mẫu…
          </button>
          <button
            className="btn"
            onClick={() => {
              setIsNew(true);
              setSelected(null);
              setDraft(emptyDraft());
            }}
          >
            Tạo test case
          </button>
          <button
            className="btn primary"
            disabled={busy}
            onClick={async () => {
              const p = await run(() => api.pickAndPreviewImport());
              if (p) setPreview(p);
            }}
          >
            Import .xlsx / .csv
          </button>
        </div>
      </div>
      <div className="split">
        <Panel title={`Danh sách (${cases.length})`} bodyClass="">
          <div style={{ padding: 10, borderBottom: "1px solid var(--rule-2)" }}>
            <input type="text" placeholder="Lọc theo test_id hoặc title" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: "100%" }} />
          </div>
          {shown.length === 0 ? (
            <div className="empty">
              Chưa có test case. Import file theo template gồm cột test_id, title, steps, input, expected_result.
              <div style={{ marginTop: 10 }}>
                <button className="btn sm" disabled={busy} onClick={() => run(() => api.openSampleTemplate())}>
                  Mở file mẫu
                </button>
              </div>
            </div>
          ) : (
            <ul className="list scroll tall">
              {shown.map((c) => (
                <li
                  key={c.test_id}
                  className={c.test_id === selected ? "sel" : ""}
                  onClick={() => {
                    setIsNew(false);
                    setSelected(c.test_id);
                  }}
                >
                  <div className="line">
                    <span className="mono">{c.test_id}</span>
                    <span style={{ marginLeft: "auto" }}>{c.approved_count > 0 ? <Badge status="APPROVED" title={`${c.approved_count} version APPROVED`} /> : c.script_id ? <Badge status="DRAFT" /> : null}</span>
                  </div>
                  <span className="title">{c.title}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        {draft ? (
          <Panel
            title={isNew ? "Test case mới" : draft.test_id}
            actions={
              !isNew && current ? (
                <div className="row">
                  <span className="muted small">Xác nhận {fmtTime(current.confirmed_at)}</span>
                  <button className="btn sm" onClick={() => onTrain(current.test_id)}>
                    Mở Training
                  </button>
                  <button className="btn sm" disabled={current.approved_count === 0} onClick={() => onTest(current.test_id)}>
                    Mở Testing
                  </button>
                </div>
              ) : undefined
            }
          >
            <CaseEditor draft={draft} onChange={setDraft} lockId={!isNew} />
            {issues.length > 0 && <div className="error-box" style={{ marginTop: 12 }}>{issues.join("\n")}</div>}
            {!isNew && current?.raw_import && (
              <details style={{ marginTop: 12 }}>
                <summary className="muted small">Dữ liệu import gốc</summary>
                <pre className="mono pre small">{JSON.stringify(current.raw_import, null, 2)}</pre>
              </details>
            )}
            <div className="row end" style={{ marginTop: 14 }}>
              {!isNew && current && (
                <button
                  className="btn"
                  disabled={busy || !!current.script_id}
                  title={current.script_id ? "Đã có lịch sử Training" : ""}
                  onClick={async () => {
                    if (!confirm(`Xoá test case ${current.test_id}?`)) return;
                    await run(() => api.deleteTestCase(current.test_id), "Đã xoá test case");
                    setSelected(null);
                    setDraft(null);
                    void load();
                  }}
                >
                  Xoá
                </button>
              )}
              <button
                className="btn primary"
                disabled={busy || issues.length > 0}
                onClick={async () => {
                  const saved = await run(
                    () =>
                      api.saveTestCase({
                        test_id: draft.test_id,
                        title: draft.title,
                        steps: draft.steps.split("\n").map((s) => s.trim()).filter(Boolean),
                        input_schema: draft.schema,
                        sample_input: draft.sample,
                        expected_result: draft.expected_result,
                      }),
                    "Đã lưu test case",
                  );
                  if (saved) {
                    setIsNew(false);
                    setSelected(saved.test_id);
                    void load();
                  }
                }}
              >
                Lưu test case
              </button>
            </div>
          </Panel>
        ) : (
          <div className="panel empty">Chọn một test case để xem hoặc sửa.</div>
        )}
      </div>
      {preview && (
        <ImportModal
          preview={preview}
          onClose={() => setPreview(null)}
          onDone={() => {
            setPreview(null);
            void load();
          }}
        />
      )}
    </div>
  );
}
