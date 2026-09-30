import { useCallback, useEffect, useId, useMemo, useState } from "react";
import type { ImportPreview, InputField, InputSchema, InputValues, ParsedTestCase, ProjectTarget } from "../../shared/types";
import { api, type ApiResult } from "../api";
import { Badge, Modal, Panel, fmtTime, groupLabel, useAction, useConfirm, useToast } from "../components/ui";

type CaseRow = ApiResult<"listTestCases">[number];
type ProjectRow = ApiResult<"listProjects">[number];
type DeleteImpact = ApiResult<"testCaseDeleteImpact">;

const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const NEW_PROJECT = "__new__";
const ALL = "__all__";
const FILTER_KEY = "testcases.filter";

function readFilter(): { project: string; group: string } {
  try {
    const v = JSON.parse(localStorage.getItem(FILTER_KEY) ?? "{}") as { project?: unknown; group?: unknown };
    return { project: typeof v.project === "string" ? v.project : ALL, group: typeof v.group === "string" ? v.group : ALL };
  } catch {
    return { project: ALL, group: ALL };
  }
}

const sameName = (a: string, b: string) => a.trim().toLocaleLowerCase("vi") === b.trim().toLocaleLowerCase("vi");
const newNameOf = (t: ProjectTarget | null) => (t && "new_name" in t ? t.new_name : null);
const validTarget = (t: ProjectTarget | null): t is ProjectTarget => !!t && ("project_id" in t ? !!t.project_id : !!t.new_name.trim());
/** Existing project a target points to (a new name equal to an existing project reuses it). */
const targetProject = (t: ProjectTarget | null, projects: ProjectRow[]) =>
  !t ? undefined : "project_id" in t ? projects.find((p) => p.project_id === t.project_id) : projects.find((p) => sameName(p.name, t.new_name));

function localIssues(d: Draft, needProject: boolean): string[] {
  const issues: string[] = [];
  if (needProject && !validTarget(d.project)) issues.push("Chọn dự án");
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
  group: string;
  project: ProjectTarget | null;
}

function ProjectPicker({ projects, value, onChange, autoFocus }: { projects: ProjectRow[]; value: ProjectTarget | null; onChange: (v: ProjectTarget) => void; autoFocus?: boolean }) {
  const newName = newNameOf(value);
  const selectValue = newName !== null || projects.length === 0 ? NEW_PROJECT : value && "project_id" in value ? value.project_id : "";
  const reused = newName !== null ? targetProject(value, projects) : undefined;
  return (
    <div className="col">
      <select value={selectValue} onChange={(e) => onChange(e.target.value === NEW_PROJECT ? { new_name: "" } : { project_id: e.target.value })} aria-label="Dự án">
        {selectValue === "" && (
          <option value="" disabled>
            — Chọn dự án —
          </option>
        )}
        {projects.map((p) => (
          <option key={p.project_id} value={p.project_id}>
            {p.name} ({p.case_count})
          </option>
        ))}
        <option value={NEW_PROJECT}>+ Dự án mới…</option>
      </select>
      {selectValue === NEW_PROJECT && (
        <input type="text" placeholder="Tên dự án mới" aria-label="Tên dự án mới" value={newName ?? ""} autoFocus={autoFocus} onChange={(e) => onChange({ new_name: e.target.value })} />
      )}
      {reused && <span className="muted small">Đã có dự án “{reused.name}” — test case sẽ vào dự án này.</span>}
    </div>
  );
}

function ImportSetupModal({ projects, initial, onClose, onPicked }: { projects: ProjectRow[]; initial: ProjectTarget | null; onClose: () => void; onPicked: (p: ImportPreview, t: ProjectTarget) => void }) {
  const [target, setTarget] = useState<ProjectTarget | null>(initial);
  const { run, busy } = useAction();
  return (
    <Modal
      title="Import test case"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Huỷ
          </button>
          <button
            className="btn primary"
            disabled={busy || !validTarget(target)}
            onClick={async () => {
              const p = await run(() => api.pickAndPreviewImport());
              if (p && validTarget(target)) onPicked(p, target);
            }}
          >
            Chọn file…
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="field">
          <span>Dự án</span>
          <ProjectPicker projects={projects} value={target} onChange={setTarget} autoFocus />
        </div>
        <div className="muted small">
          File .xlsx: mỗi sheet có cột test_id ở dòng 1 là một nhóm test case, tên sheet là tên nhóm; sheet khác (ví dụ "Hướng dẫn") được bỏ qua.
          <br />
          File .csv / .yaml: cả file là một nhóm, đặt theo tên file.
        </div>
      </div>
    </Modal>
  );
}

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

function ImportModal({
  preview,
  target,
  projects,
  existing,
  onClose,
  onBack,
  onDone,
}: {
  preview: ImportPreview;
  target: ProjectTarget;
  projects: ProjectRow[];
  existing: CaseRow[];
  onClose: () => void;
  onBack: () => void;
  onDone: (projectId: string) => void;
}) {
  const [cases, setCases] = useState<ParsedTestCase[]>(preview.cases);
  const [editing, setEditing] = useState<number | null>(null);
  const { run, busy } = useAction();
  const project = targetProject(target, projects);
  const projectName = project?.name ?? newNameOf(target)?.trim() ?? "";
  const draftOf = (c: ParsedTestCase): Draft => ({
    test_id: c.test_id,
    title: c.title,
    steps: c.steps.join("\n"),
    schema: c.input_schema,
    sample: c.input,
    expected_result: c.expected_result,
    group: c.group,
    project: null,
  });
  const ownerOf = (testId: string) => existing.find((e) => e.test_id === testId.trim());
  const perCase = cases.map((c) => {
    const issues = localIssues(draftOf(c), false);
    const owner = ownerOf(c.test_id);
    if (owner && owner.project_id !== project?.project_id) issues.push(`test_id đã thuộc dự án "${owner.project_name}"`);
    return issues;
  });
  const blocking = perCase.some((i) => i.length > 0);
  const fileIssues = preview.issues.filter((i) => i.row === 1 && i.column !== "*" && cases.length === 0);
  const groups = [...new Set(cases.map((c) => c.group))];
  const overwrite = project ? cases.filter((c) => ownerOf(c.test_id)?.project_id === project.project_id).length : 0;

  return (
    <Modal
      title={`Xem bản parse — ${preview.file_name}`}
      onClose={onClose}
      footer={
        <>
          <span className="muted small" style={{ marginRight: "auto" }}>
            {cases.length} test case · {groups.length} nhóm{overwrite ? ` · ghi đè ${overwrite}` : ""} · {blocking ? "còn lỗi cần sửa trước khi lưu" : "sẵn sàng lưu"}
          </span>
          <button className="btn" onClick={onBack}>
            Đổi dự án / file
          </button>
          <button
            className="btn primary"
            disabled={busy || blocking || cases.length === 0}
            onClick={async () => {
              const r = await run(() => api.confirmImport(preview.file_name, target, cases), `Đã lưu ${cases.length} test case vào dự án ${projectName}`);
              if (r) onDone(r.project.project_id);
            }}
          >
            Xác nhận và lưu
          </button>
        </>
      }
    >
      <div className="row" style={{ marginBottom: 12 }}>
        <span>
          Dự án: <strong>{projectName}</strong> {!project && <span className="badge">MỚI</span>}
        </span>
        <span className="muted">·</span>
        <span className="muted small">Nhóm: {groups.map((g) => `${groupLabel(g)} (${cases.filter((c) => c.group === g).length})`).join(", ") || "—"}</span>
      </div>
      {preview.issues.length > 0 && (
        <div className="warn-box" style={{ marginBottom: 12 }}>
          <strong>Parser báo {preview.issues.length} vấn đề:</strong>
          {"\n"}
          {preview.issues.map((i) => `• ${i.sheet ? `Sheet "${i.sheet}", dòng` : "Dòng"} ${i.row}, cột ${i.column}: ${i.message}`).join("\n")}
        </div>
      )}
      {fileIssues.length > 0 && <div className="error-box">File không đúng template (cần các cột test_id, title, steps, input, expected_result).</div>}
      {!!preview.skipped_sheets?.length && <div className="muted small" style={{ marginBottom: 8 }}>Bỏ qua sheet không có test case: {preview.skipped_sheets.map((s) => `"${s}"`).join(", ")}</div>}
      <table className="t">
        <thead>
          <tr>
            <th>Dòng</th>
            <th>Nhóm</th>
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
              <td>{groupLabel(c.group)}</td>
              <td className="mono">{c.test_id}</td>
              <td>{c.title}</td>
              <td>{c.steps.length}</td>
              <td className="mono small">{Object.keys(c.input).join(", ") || "—"}</td>
              <td>
                {perCase[i].length ? (
                  <span className="badge fail" title={perCase[i].join("\n")}>
                    {perCase[i].length} LỖI
                  </span>
                ) : project && ownerOf(c.test_id) ? (
                  <span className="badge warn" title="test_id đã có trong dự án này; lưu sẽ cập nhật test case">
                    GHI ĐÈ
                  </span>
                ) : (
                  <span className="badge pass">HỢP LỆ</span>
                )}
              </td>
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
              groups={groups}
              onChange={(d) =>
                setCases(
                  cases.map((c, idx) =>
                    idx === editing
                      ? { ...c, test_id: d.test_id, title: d.title, steps: d.steps.split("\n").map((s) => s.trim()).filter(Boolean), input_schema: d.schema, input: d.sample, expected_result: d.expected_result, group: d.group }
                      : c,
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

function DeleteModal({ testId, title, impact, onClose, onDeleted }: { testId: string; title: string; impact: DeleteImpact; onClose: () => void; onDeleted: () => void }) {
  const [typed, setTyped] = useState("");
  const { run, busy } = useAction();
  const items = [
    impact.versions && `${impact.versions} version${impact.approved_versions ? ` (${impact.approved_versions} đang APPROVED)` : ""}`,
    impact.test_runs && `${impact.test_runs} lượt Testing (lịch sử ở History)`,
    impact.trials && `${impact.trials} lượt Trial`,
    impact.candidates && `${impact.candidates} candidate`,
    impact.attempts && `${impact.attempts} lượt Training`,
  ].filter(Boolean) as string[];
  const mustType = impact.versions > 0 || impact.test_runs > 0;
  return (
    <Modal
      title={`Xoá test case ${testId}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Huỷ
          </button>
          <button
            className="btn bad"
            disabled={busy || (mustType && typed.trim() !== testId)}
            onClick={async () => {
              const r = await run(() => api.deleteTestCase(testId), `Đã xoá test case ${testId}`);
              if (r) onDeleted();
            }}
          >
            Xoá vĩnh viễn
          </button>
        </>
      }
    >
      <div className="stack">
        <div>
          <strong>{testId}</strong> — {title}
        </div>
        {items.length ? (
          <div className="error-box">
            Xoá vĩnh viễn cùng với:
            {"\n"}
            {items.map((i) => `• ${i}`).join("\n")}
            {"\n"}• script, ảnh/trace/log của các lượt chạy và workspace Training
            {"\n\n"}Không thể hoàn tác. Nhật ký audit vẫn được giữ.
          </div>
        ) : (
          <div className="muted">Test case chưa có Training hay lịch sử chạy nào.</div>
        )}
        {mustType && (
          <label className="field">
            <span>Nhập "{testId}" để xác nhận</span>
            <input type="text" className="mono" value={typed} autoFocus onChange={(e) => setTyped(e.target.value)} />
          </label>
        )}
      </div>
    </Modal>
  );
}

function CaseEditor({
  draft,
  onChange,
  lockId,
  groups,
  projects,
}: {
  draft: Draft;
  onChange: (d: Draft) => void;
  lockId: boolean;
  /** Suggestions for the group field. */
  groups: string[];
  /** When given, the project can be chosen. */
  projects?: ProjectRow[];
}) {
  const groupListId = useId();
  return (
    <div className="stack">
      <div className="form-grid">
        {projects && (
          <div className="field">
            <span>Dự án</span>
            <ProjectPicker projects={projects} value={draft.project} onChange={(project) => onChange({ ...draft, project })} />
          </div>
        )}
        <label className="field">
          <span>Nhóm</span>
          <input type="text" list={groupListId} placeholder={groupLabel("")} value={draft.group} onChange={(e) => onChange({ ...draft, group: e.target.value })} />
          <datalist id={groupListId}>
            {groups.filter(Boolean).map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </label>
      </div>
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
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [importStep, setImportStep] = useState<{ step: "setup"; target: ProjectTarget | null } | { step: "preview"; preview: ImportPreview; target: ProjectTarget } | null>(null);
  const [deleting, setDeleting] = useState<{ testId: string; title: string; impact: DeleteImpact } | null>(null);
  const [filter, setFilter] = useState("");
  const [projectFilter, setProjectFilter] = useState<string>(() => readFilter().project);
  const [groupFilter, setGroupFilter] = useState<string>(() => readFilter().group);
  const { run, busy } = useAction();
  const toast = useToast();
  const ask = useConfirm();

  const load = useCallback(async () => {
    const [c, p] = await Promise.all([api.listTestCases(), api.listProjects()]);
    setCases(c);
    setProjects(p);
    setLoaded(true);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    localStorage.setItem(FILTER_KEY, JSON.stringify({ project: projectFilter, group: groupFilter }));
  }, [projectFilter, groupFilter]);

  const projectCases = useMemo(() => (projectFilter === ALL ? cases : cases.filter((c) => c.project_id === projectFilter)), [cases, projectFilter]);
  const groupsInProject = useMemo(() => [...new Set(projectCases.map((c) => c.group_name))], [projectCases]);
  useEffect(() => {
    if (!loaded) return;
    if (projectFilter !== ALL && !projects.some((p) => p.project_id === projectFilter)) setProjectFilter(ALL);
    else if (groupFilter !== ALL && !groupsInProject.includes(groupFilter)) setGroupFilter(ALL);
  }, [loaded, projects, projectFilter, groupFilter, groupsInProject]);

  const current = useMemo(() => cases.find((c) => c.test_id === selected) ?? null, [cases, selected]);
  useEffect(() => {
    if (current && !isNew) {
      setDraft({
        test_id: current.test_id,
        title: current.title,
        steps: current.steps.join("\n"),
        schema: current.input_schema,
        sample: current.sample_input,
        expected_result: current.expected_result,
        group: current.group_name,
        project: current.project_id ? { project_id: current.project_id } : null,
      });
    }
  }, [current, isNew]);

  const issues = draft ? localIssues(draft, true) : [];
  const q = filter.trim().toLowerCase();
  const shown = projectCases.filter((c) => (groupFilter === ALL || c.group_name === groupFilter) && (!q || `${c.test_id} ${c.title}`.toLowerCase().includes(q)));
  const draftProjectId = draft ? targetProject(draft.project, projects)?.project_id : undefined;
  const draftGroups = [...new Set(cases.filter((c) => c.project_id === draftProjectId).map((c) => c.group_name))];
  const filteredProject = projects.find((p) => p.project_id === projectFilter);
  const defaultTarget = (): ProjectTarget | null => (filteredProject ? { project_id: filteredProject.project_id } : projects.length ? null : { new_name: "" });
  /** Makes sure a saved/imported case is visible under the current filters. */
  const reveal = (projectId: string | null, group: string) => {
    if (projectFilter !== ALL && projectFilter !== projectId) {
      setProjectFilter(projectId ?? ALL);
      setGroupFilter(ALL);
    } else if (groupFilter !== ALL && groupFilter !== group) setGroupFilter(ALL);
  };

  return (
    <div>
      <div className="page-head">
        <h1>Test Cases</h1>
        <p>Test case theo dự án và nhóm (mỗi sheet Excel là một nhóm).</p>
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
              setDraft({
                test_id: "",
                title: "",
                steps: "",
                schema: { fields: [] },
                sample: {},
                expected_result: "",
                group: groupFilter === ALL ? "" : groupFilter,
                project: defaultTarget(),
              });
            }}
          >
            Tạo test case
          </button>
          <button className="btn primary" disabled={busy} onClick={() => setImportStep({ step: "setup", target: defaultTarget() })}>
            Import .xlsx / .csv
          </button>
        </div>
      </div>
      <div className="split">
        <Panel title={`Danh sách (${shown.length}/${cases.length})`} bodyClass="">
          <div className="case-filters">
            <select
              aria-label="Lọc theo dự án"
              value={projectFilter}
              onChange={(e) => {
                setProjectFilter(e.target.value);
                setGroupFilter(ALL);
              }}
            >
              <option value={ALL}>Tất cả dự án ({cases.length})</option>
              {projects.map((p) => (
                <option key={p.project_id} value={p.project_id}>
                  {p.name} ({p.case_count})
                </option>
              ))}
            </select>
            <select aria-label="Lọc theo nhóm" value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)}>
              <option value={ALL}>Tất cả nhóm ({projectCases.length})</option>
              {groupsInProject.map((g) => (
                <option key={g} value={g}>
                  {groupLabel(g)} ({projectCases.filter((c) => c.group_name === g).length})
                </option>
              ))}
            </select>
            <input type="text" placeholder="Lọc theo test_id hoặc title" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          {shown.length === 0 ? (
            cases.length === 0 ? (
              <div className="empty">
                Chưa có test case. Import file theo template gồm cột test_id, title, steps, input, expected_result.
                <div style={{ marginTop: 10 }}>
                  <button className="btn sm" disabled={busy} onClick={() => run(() => api.openSampleTemplate())}>
                    Mở file mẫu
                  </button>
                </div>
              </div>
            ) : (
              <div className="empty">
                Không có test case khớp bộ lọc.
                {filteredProject && filteredProject.case_count === 0 && (
                  <div style={{ marginTop: 10 }}>
                    <button
                      className="btn sm"
                      disabled={busy}
                      onClick={async () => {
                        if (!(await ask(`Xoá dự án trống "${filteredProject.name}"?`, { okText: "Xoá", danger: true }))) return;
                        const ok = await run(() => api.deleteProject(filteredProject.project_id), "Đã xoá dự án");
                        if (ok) {
                          setProjectFilter(ALL);
                          void load();
                        }
                      }}
                    >
                      Xoá dự án trống
                    </button>
                  </div>
                )}
              </div>
            )
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
                  <span className="muted small clip">
                    {projectFilter === ALL ? `${c.project_name || "—"} · ` : ""}
                    {groupLabel(c.group_name)}
                  </span>
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
            <CaseEditor draft={draft} onChange={setDraft} lockId={!isNew} projects={projects} groups={draftGroups} />
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
                  disabled={busy}
                  onClick={async () => {
                    const impact = await run(() => api.testCaseDeleteImpact(current.test_id));
                    if (impact) setDeleting({ testId: current.test_id, title: current.title, impact });
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
                        project: draft.project ?? undefined,
                        group_name: draft.group,
                      }),
                    "Đã lưu test case",
                  );
                  if (saved) {
                    setIsNew(false);
                    setSelected(saved.test_id);
                    await load();
                    reveal(saved.project_id, saved.group_name);
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
      {deleting && (
        <DeleteModal
          {...deleting}
          onClose={() => setDeleting(null)}
          onDeleted={async () => {
            setDeleting(null);
            setSelected(null);
            setDraft(null);
            await load();
          }}
        />
      )}
      {importStep?.step === "setup" && (
        <ImportSetupModal
          projects={projects}
          initial={importStep.target}
          onClose={() => setImportStep(null)}
          onPicked={(preview, target) => setImportStep({ step: "preview", preview, target })}
        />
      )}
      {importStep?.step === "preview" && (
        <ImportModal
          preview={importStep.preview}
          target={importStep.target}
          projects={projects}
          existing={cases}
          onClose={() => setImportStep(null)}
          onBack={() => setImportStep({ step: "setup", target: importStep.target })}
          onDone={async (projectId) => {
            setImportStep(null);
            await load();
            setProjectFilter(projectId);
            setGroupFilter(ALL);
          }}
        />
      )}
    </div>
  );
}
