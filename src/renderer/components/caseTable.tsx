import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ApiResult } from "../api";
import { Badge, fmtTime, groupLabel } from "./ui";

type CaseRow = ApiResult<"listTestCases">[number];
type LastRunInfo = CaseRow["last_run"];

/** Script state of a test case: newest APPROVED version, a draft script, or not trained yet. */
export function ScriptStatus({ c }: { c: CaseRow }) {
  if (c.latest_approved) return <Badge status="APPROVED" title={`${c.approved_count} version APPROVED, mới nhất v${c.latest_approved}`} />;
  if (c.script_id) return <Badge status="DRAFT" title={c.version_count ? "Không còn version APPROVED" : "Chưa có version"} />;
  return <span className="muted small">Chưa train</span>;
}

/** Result of the newest test run: execution status, error code and the user's review. */
export function LastRun({ run, withTime }: { run: LastRunInfo; withTime?: boolean }) {
  if (!run) return <span className="muted small">Chưa chạy</span>;
  return (
    <span className="badges" title={`v${run.version_no} · ${fmtTime(run.created_at)}`}>
      <Badge status={run.execution_status} />
      {run.error_code && <span className="badge fail">{run.error_code}</span>}
      {run.execution_status === "COMPLETED" && <Badge status={run.review_result} />}
      {withTime && <span className="small muted">{fmtTime(run.created_at)}</span>}
    </span>
  );
}

/** Sort keys shared by the test case tables. */
export const CASE_COLUMNS: Record<string, (c: CaseRow) => string | number | null> = {
  test_id: (c) => c.test_id,
  title: (c) => c.title,
  project: (c) => c.project_name,
  group: (c) => c.group_name,
  steps: (c) => c.steps.length,
  script: (c) => (c.latest_approved ? 2 : c.script_id ? 1 : 0),
  version: (c) => c.latest_approved,
  last_run: (c) => c.last_run?.created_at ?? null,
  confirmed: (c) => c.confirmed_at,
};

export const ALL = "__all__";

interface FilterableCase {
  test_id: string;
  title: string;
  project_id: string | null;
  group_name: string;
}

export interface ProjectOption {
  project_id: string;
  name: string;
  case_count: number;
}

function readFilter(key: string): { project: string; group: string } {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "{}") as { project?: unknown; group?: unknown };
    return { project: typeof v.project === "string" ? v.project : ALL, group: typeof v.group === "string" ? v.group : ALL };
  } catch {
    return { project: ALL, group: ALL };
  }
}

/**
 * Project / group / text filter of a test case table, remembered per page in localStorage.
 * A remembered project or group that no longer exists falls back to "all" once the data is `loaded`.
 */
export function useCaseFilter<T extends FilterableCase>(cases: T[], projects: ProjectOption[], storageKey: string, loaded: boolean) {
  const [project, setProject] = useState<string>(() => readFilter(storageKey).project);
  const [group, setGroup] = useState<string>(() => readFilter(storageKey).group);
  const [query, setQuery] = useState("");
  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify({ project, group }));
  }, [storageKey, project, group]);

  const projectCases = useMemo(() => (project === ALL ? cases : cases.filter((c) => c.project_id === project)), [cases, project]);
  const groups = useMemo(() => [...new Set(projectCases.map((c) => c.group_name))], [projectCases]);
  useEffect(() => {
    if (!loaded) return;
    if (project !== ALL && !projects.some((p) => p.project_id === project)) setProject(ALL);
    else if (group !== ALL && !groups.includes(group)) setGroup(ALL);
  }, [loaded, projects, project, group, groups]);

  const q = query.trim().toLowerCase();
  const shown = projectCases.filter((c) => (group === ALL || c.group_name === group) && (!q || `${c.test_id} ${c.title}`.toLowerCase().includes(q)));
  return {
    project,
    setProject: (p: string) => {
      setProject(p);
      setGroup(ALL);
    },
    group,
    setGroup,
    query,
    setQuery,
    projectCases,
    groups,
    shown,
    total: cases.length,
    projects,
  };
}

export type CaseFilter = ReturnType<typeof useCaseFilter>;

/** Projects that have cases, for pages that do not load the project list. */
export function projectsOf(cases: { project_id: string | null; project_name: string }[]): ProjectOption[] {
  const map = new Map<string, ProjectOption>();
  for (const c of cases) {
    if (!c.project_id) continue;
    const p = map.get(c.project_id) ?? { project_id: c.project_id, name: c.project_name, case_count: 0 };
    p.case_count++;
    map.set(c.project_id, p);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "vi"));
}

export function CaseFilterBar({ filter, children }: { filter: CaseFilter; children?: ReactNode }) {
  return (
    <div className="table-tools">
      <select aria-label="Lọc theo dự án" value={filter.project} onChange={(e) => filter.setProject(e.target.value)}>
        <option value={ALL}>Tất cả dự án ({filter.total})</option>
        {filter.projects.map((p) => (
          <option key={p.project_id} value={p.project_id}>
            {p.name} ({p.case_count})
          </option>
        ))}
      </select>
      <select aria-label="Lọc theo nhóm" value={filter.group} onChange={(e) => filter.setGroup(e.target.value)}>
        <option value={ALL}>Tất cả nhóm ({filter.projectCases.length})</option>
        {filter.groups.map((g) => (
          <option key={g} value={g}>
            {groupLabel(g)} ({filter.projectCases.filter((c) => c.group_name === g).length})
          </option>
        ))}
      </select>
      <input type="search" className="grow" placeholder="Lọc theo test_id hoặc title" value={filter.query} onChange={(e) => filter.setQuery(e.target.value)} />
      {children}
    </div>
  );
}

type SortValue = string | number | null | undefined;
export interface SortState {
  key: string;
  desc: boolean;
}

/** Sorts rows by the chosen column; empty values always go last. */
export function useSort<T>(rows: T[], columns: Record<string, (r: T) => SortValue>, initial: SortState | null = null) {
  const [sort, setSort] = useState<SortState | null>(initial);
  const sorted = useMemo(() => {
    const get = sort ? columns[sort.key] : undefined;
    if (!sort || !get) return rows;
    return [...rows].sort((a, b) => {
      const x = get(a);
      const y = get(b);
      if (x == null || x === "") return y == null || y === "" ? 0 : 1;
      if (y == null || y === "") return -1;
      const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "vi", { numeric: true });
      return sort.desc ? -c : c;
    });
  }, [rows, columns, sort]);
  const toggle = (key: string) => setSort((s) => (s?.key === key ? { key, desc: !s.desc } : { key, desc: false }));
  return { sorted, sort, toggle };
}

export function SortTh({ label, k, sort, onSort, className }: { label: string; k: string; sort: SortState | null; onSort: (k: string) => void; className?: string }) {
  const active = sort?.key === k;
  return (
    <th className={`sortable ${className ?? ""}`} aria-sort={active ? (sort.desc ? "descending" : "ascending") : "none"}>
      <button type="button" onClick={() => onSort(k)}>
        {label}
        <span className="sort-mark" aria-hidden="true">
          {active ? (sort.desc ? "▼" : "▲") : "↕"}
        </span>
      </button>
    </th>
  );
}
