import { useCallback, useEffect, useId, useMemo, useState } from "react";
import type { ImportPreview, InputField, InputSchema, InputValues, ParsedTestCase, ProjectTarget } from "../../shared/types";
import { api, type ApiResult } from "../api";
import { ALL, CASE_COLUMNS, CaseFilterBar, LastRun, ScriptStatus, SortTh, useCaseFilter, useSort } from "../components/caseTable";
import { Modal, Panel, fmtTime, formatBytes, groupLabel, useAction, useConfirm, useFixtures, useToast } from "../components/ui";

type CaseRow = ApiResult<"listTestCases">[number];
type ProjectRow = ApiResult<"listProjects">[number];
type DeleteImpact = ApiResult<"testCaseDeleteImpact">;

const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const NEW_PROJECT = "__new__";

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

/** Files of a project that `file` inputs choose from. */
function FixturesBox({ project }: { project: ProjectRow }) {
  const fixtures = useFixtures(project.project_id);
  const ask = useConfirm();
  return (
    <details className="fixtures-box">
      <summary>
        File mẫu của dự án ({fixtures.list.length})
      </summary>
      <div className="muted small" style={{ margin: "6px 0" }}>
        Dùng cho biến kiểu <span className="mono">file</span> (bước tải file lên). Runner, Training và Ghi thao tác lấy file từ đây theo tên.
      </div>
      {fixtures.list.length > 0 && (
        <ul className="fixture-list">
          {fixtures.list.map((f) => (
            <li key={f.name}>
              <span className="mono clip" title={f.name}>
                {f.name}
              </span>
              <span className="muted small">{formatBytes(f.size)}</span>
              <button
                className="btn sm"
                onClick={async () => {
                  if (await ask(`Xoá file mẫu "${f.name}" khỏi dự án "${project.name}"? Test case đang dùng file này sẽ báo thiếu file khi chạy.`, { okText: "Xoá", danger: true })) {
                    await fixtures.remove(f.name);
                  }
                }}
              >
                Xoá
              </button>
            </li>
          ))}
        </ul>
      )}
      <button className="btn sm" onClick={() => void fixtures.add()}>
        Thêm file…
      </button>
    </details>
  );
}

function SampleFileSelect({ projectId, value, onChange }: { projectId: string; value: string; onChange: (v: string) => void }) {
  const fixtures = useFixtures(projectId);
  return (
    <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
      <select aria-label="File mẫu" style={{ flex: 1, minWidth: 0 }} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">— chọn file mẫu —</option>
        {fixtures.list.map((f) => (
          <option key={f.name} value={f.name}>
            {f.name}
          </option>
        ))}
        {value && !fixtures.list.some((f) => f.name === value) && <option value={value}>{value} (chưa có trong dự án)</option>}
      </select>
      <button
        type="button"
        className="btn sm"
        onClick={async () => {
          const name = await fixtures.add();
          if (name) onChange(name);
        }}
      >
        Thêm…
      </button>
    </div>
  );
}

function SchemaEditor({ draft, setDraft, projectId }: { draft: Draft; setDraft: (d: Draft) => void; projectId?: string }) {
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
                  <option value="file">file (tải lên)</option>
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
                ) : f.type === "file" && projectId ? (
                  <SampleFileSelect projectId={projectId} value={draft.sample[f.name] ?? ""} onChange={(v) => update(i, {}, v)} />
                ) : (
                  <input
                    type="text"
                    placeholder={f.type === "file" ? "tên file mẫu, ví dụ banner.png" : undefined}
                    value={draft.sample[f.name] ?? ""}
                    onChange={(e) => update(i, {}, e.target.value)}
                  />
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
  projectId,
}: {
  draft: Draft;
  onChange: (d: Draft) => void;
  lockId: boolean;
  /** Suggestions for the group field. */
  groups: string[];
  /** When given, the project can be chosen. */
  projects?: ProjectRow[];
  /** Existing project of the draft: sample values of file fields are picked from its fixtures. */
  projectId?: string;
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
        <SchemaEditor draft={draft} setDraft={onChange} projectId={projectId} />
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
  /** The draft as last opened or saved: closing with other content asks before dropping the edits. */
  const [baseline, setBaseline] = useState("");
  const [isNew, setIsNew] = useState(false);
  const [importStep, setImportStep] = useState<{ step: "setup"; target: ProjectTarget | null } | { step: "preview"; preview: ImportPreview; target: ProjectTarget } | null>(null);
  const [deleting, setDeleting] = useState<{ testId: string; title: string; impact: DeleteImpact } | null>(null);
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

  const filter = useCaseFilter(cases, projects, "testcases.filter", loaded);
  const { sorted, sort, toggle } = useSort(filter.shown, CASE_COLUMNS);
  const current = useMemo(() => cases.find((c) => c.test_id === selected) ?? null, [cases, selected]);

  const openDraft = (d: Draft, testId: string | null) => {
    setIsNew(testId === null);
    setSelected(testId);
    setDraft(d);
    setBaseline(JSON.stringify(d));
  };
  const openCase = (c: CaseRow) =>
    openDraft(
      {
        test_id: c.test_id,
        title: c.title,
        steps: c.steps.join("\n"),
        schema: c.input_schema,
        sample: c.sample_input,
        expected_result: c.expected_result,
        group: c.group_name,
        project: c.project_id ? { project_id: c.project_id } : null,
      },
      c.test_id,
    );
  const closeDraft = async () => {
    if (draft && JSON.stringify(draft) !== baseline && !(await ask("Đóng mà không lưu các thay đổi của test case này?", { okText: "Bỏ thay đổi", cancelText: "Tiếp tục sửa", danger: true }))) return;
    setDraft(null);
    setSelected(null);
    setIsNew(false);
  };

  const issues = draft ? localIssues(draft, true) : [];
  const draftProjectId = draft ? targetProject(draft.project, projects)?.project_id : undefined;
  const draftGroups = [...new Set(cases.filter((c) => c.project_id === draftProjectId).map((c) => c.group_name))];
  const filteredProject = projects.find((p) => p.project_id === filter.project);
  const defaultTarget = (): ProjectTarget | null => (filteredProject ? { project_id: filteredProject.project_id } : projects.length ? null : { new_name: "" });
  /** Makes sure a saved/imported case is visible under the current filters. */
  const reveal = (projectId: string | null, group: string) => {
    if (filter.project !== ALL && filter.project !== projectId) filter.setProject(projectId ?? ALL);
    else if (filter.group !== ALL && filter.group !== group) filter.setGroup(ALL);
  };
  const openSample = async () => {
    const f = await run(() => api.openSampleTemplate());
    if (f) toast("Đã mở file mẫu bằng Excel. Điền xong bấm Ctrl+S để lưu, rồi bấm Import để chọn file đó.", "ok");
  };

  return (
    <div>
      <div className="page-head">
        <h1>Test Cases</h1>
        <p>Test case theo dự án và nhóm (mỗi sheet Excel là một nhóm).</p>
        <div className="actions">
          <button className="btn ghost" disabled={busy} onClick={openSample} title="Tạo một file Excel mẫu mới và mở bằng Excel">
            Mở file mẫu
          </button>
          <button
            className="btn"
            onClick={() =>
              openDraft(
                { test_id: "", title: "", steps: "", schema: { fields: [] }, sample: {}, expected_result: "", group: filter.group === ALL ? "" : filter.group, project: defaultTarget() },
                null,
              )
            }
          >
            Tạo test case
          </button>
          <button className="btn primary" disabled={busy} onClick={() => setImportStep({ step: "setup", target: defaultTarget() })}>
            Import .xlsx / .csv
          </button>
        </div>
      </div>
      <Panel title={`Test case (${filter.shown.length}/${cases.length})`} bodyClass="">
        <CaseFilterBar filter={filter} />
        {filter.shown.length === 0 ? (
            cases.length === 0 ? (
              <div className="empty">
                Chưa có test case. Import file theo template gồm cột test_id, title, steps, input, expected_result.
                <div style={{ marginTop: 10 }}>
                  <button className="btn sm" disabled={busy} onClick={openSample}>
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
                          filter.setProject(ALL);
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
          <div className="table-wrap">
            <table className="t case-table">
              <thead>
                <tr>
                  <SortTh label="test_id" k="test_id" sort={sort} onSort={toggle} />
                  <SortTh label="Title" k="title" sort={sort} onSort={toggle} className="wide" />
                  {filter.project === ALL && <SortTh label="Dự án" k="project" sort={sort} onSort={toggle} />}
                  <SortTh label="Nhóm" k="group" sort={sort} onSort={toggle} />
                  <SortTh label="Bước" k="steps" sort={sort} onSort={toggle} className="num" />
                  <th>Biến input</th>
                  <SortTh label="Script" k="script" sort={sort} onSort={toggle} />
                  <SortTh label="Test gần nhất" k="last_run" sort={sort} onSort={toggle} />
                  <SortTh label="Xác nhận" k="confirmed" sort={sort} onSort={toggle} />
                  <th aria-label="Thao tác" />
                </tr>
              </thead>
              <tbody>
                {sorted.map((c) => (
                  <tr key={c.test_id} className={`click ${c.test_id === selected ? "sel" : ""}`} onClick={() => openCase(c)}>
                    <td className="mono nowrap">{c.test_id}</td>
                    <td className="clip-cell" title={c.title}>
                      {c.title}
                    </td>
                    {filter.project === ALL && <td className="nowrap">{c.project_name || "—"}</td>}
                    <td className="nowrap">{groupLabel(c.group_name)}</td>
                    <td className="num">{c.steps.length}</td>
                    <td className="mono small clip-cell" title={c.input_schema.fields.map((f) => f.name).join(", ")}>
                      {c.input_schema.fields.map((f) => f.name).join(", ") || "—"}
                    </td>
                    <td className="nowrap">
                      <ScriptStatus c={c} />
                    </td>
                    <td className="nowrap">
                      <LastRun run={c.last_run} />
                    </td>
                    <td className="small muted nowrap">{fmtTime(c.confirmed_at)}</td>
                    <td className="row-actions" onClick={(e) => e.stopPropagation()}>
                      <button className="btn sm" onClick={() => onTrain(c.test_id)}>
                        Training
                      </button>
                      <button className="btn sm" disabled={c.approved_count === 0} title={c.approved_count ? undefined : "Chưa có version APPROVED"} onClick={() => onTest(c.test_id)}>
                        Testing
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {filteredProject && <FixturesBox key={filteredProject.project_id} project={filteredProject} />}
      </Panel>
      {draft && (
        <Modal
          drawer
          title={isNew ? "Test case mới" : draft.test_id}
          onClose={() => void closeDraft()}
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
          footer={
            <>
              {!isNew && current && (
                <button
                  className="btn"
                  style={{ marginRight: "auto" }}
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
                    setBaseline(JSON.stringify(draft));
                    await load();
                    reveal(saved.project_id, saved.group_name);
                  }
                }}
              >
                Lưu test case
              </button>
            </>
          }
        >
          <CaseEditor draft={draft} onChange={setDraft} lockId={!isNew} projects={projects} groups={draftGroups} projectId={draftProjectId} />
          {issues.length > 0 && <div className="error-box" style={{ marginTop: 12 }}>{issues.join("\n")}</div>}
          {!isNew && current?.raw_import && (
            <details style={{ marginTop: 12 }}>
              <summary className="muted small">Dữ liệu import gốc</summary>
              <pre className="mono pre small">{JSON.stringify(current.raw_import, null, 2)}</pre>
            </details>
          )}
        </Modal>
      )}
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
            filter.setProject(projectId);
          }}
        />
      )}
    </div>
  );
}
