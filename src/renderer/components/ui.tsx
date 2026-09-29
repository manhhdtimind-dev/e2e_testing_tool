import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { diffLines } from "diff";
import type { Evidence, InputSchema, InputValues, StepLog } from "../../shared/types";
import { api, artifactUrl } from "../api";

// ---------- toast ----------
type Toast = { id: number; text: string; kind: "ok" | "err" | "info" };
const ToastCtx = createContext<(text: string, kind?: Toast["kind"]) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: Toast["kind"] = "info") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "err" ? 9000 : 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

/** Runs an async action, surfacing failures as a toast. Returns undefined on failure. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async <T,>(fn: () => Promise<T>, okText?: string): Promise<T | undefined> => {
      setBusy(true);
      try {
        const out = await fn();
        if (okText) toast(okText, "ok");
        return out;
      } catch (e) {
        toast((e as Error).message, "err");
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );
  return { run, busy };
}

// ---------- status badge ----------
const STATUS_CLASS: Record<string, string> = {
  PASSED: "pass", COMPLETED: "pass", PASS: "pass", APPROVED: "pass", CONNECTED: "pass", ACTIVE: "pass",
  FAILED: "fail", ERROR: "fail", FAIL: "fail", REJECTED: "fail", SUSPECTED_BROKEN: "fail", PROFILE_UNAVAILABLE: "fail", BROKEN: "fail",
  AUTH_REQUIRED: "warn", PENDING: "warn",
  RUNNING: "run", QUEUED: "run",
  DRAFT: "info",
};

const STATUS_LABEL: Record<string, string> = {
  SUSPECTED_BROKEN: "SUSPECTED BROKEN",
  AUTH_REQUIRED: "AUTH REQUIRED",
  PROFILE_UNAVAILABLE: "PROFILE UNAVAILABLE",
};

export function Badge({ status, title }: { status: string | null | undefined; title?: string }) {
  if (!status) return null;
  return (
    <span className={`badge ${STATUS_CLASS[status] ?? ""}`} title={title}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

// ---------- layout ----------
export function Panel({ title, actions, children, bodyClass = "body" }: { title: ReactNode; actions?: ReactNode; children: ReactNode; bodyClass?: string }) {
  return (
    <section className="panel">
      <header>
        <h2>{title}</h2>
        <span className="spacer" />
        {actions}
      </header>
      <div className={bodyClass}>{children}</div>
    </section>
  );
}

export function Modal({ title, onClose, children, footer }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true">
        <header>
          <h2>{title}</h2>
          <button className="btn ghost" onClick={onClose} aria-label="Đóng">
            Đóng
          </button>
        </header>
        <div className="body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

// ---------- input form from schema ----------
export function InputForm({
  schema,
  values,
  onChange,
  secretFieldsFromEnv = [],
  mode,
}: {
  schema: InputSchema;
  values: InputValues;
  onChange: (v: InputValues) => void;
  secretFieldsFromEnv?: string[];
  mode: "training" | "run";
}) {
  if (schema.fields.length === 0) return <div className="muted small">Test case không có biến input.</div>;
  return (
    <div className="form-grid">
      {schema.fields.map((f) => {
        const secret = f.secret || secretFieldsFromEnv.includes(f.name);
        return (
          <label className="field" key={f.name}>
            <span>
              {f.name}
              {f.required ? " *" : ""} <span className="muted">({f.type})</span>
            </span>
            {secret ? (
              <input type="text" disabled value={mode === "training" ? "Secret — không gửi cho AI" : "Lấy từ secret của environment"} />
            ) : f.type === "boolean" ? (
              <select value={values[f.name] ?? ""} onChange={(e) => onChange({ ...values, [f.name]: e.target.value })}>
                <option value="">—</option>
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : (
              <input
                type={f.type === "number" ? "number" : "text"}
                value={values[f.name] ?? ""}
                onChange={(e) => onChange({ ...values, [f.name]: e.target.value })}
              />
            )}
          </label>
        );
      })}
    </div>
  );
}

// ---------- code & diff ----------
export function CodeView({ source, highlight }: { source: string; highlight?: number[] }) {
  const lines = source.replace(/\n$/, "").split("\n");
  const hl = new Set(highlight ?? []);
  return (
    <div className="code" role="region" aria-label="Mã nguồn">
      {lines.map((l, i) => (
        <div key={i} className={`ln ${hl.has(i + 1) ? "hl" : ""}`}>
          <span className="n">{i + 1}</span>
          <span className="c">{l || " "}</span>
        </div>
      ))}
    </div>
  );
}

export function DiffView({ before, after }: { before: string; after: string }) {
  const parts = useMemo(() => diffLines(before, after), [before, after]);
  let n = 0;
  return (
    <div className="code" role="region" aria-label="So sánh mã nguồn">
      {parts.flatMap((p, pi) =>
        p.value
          .replace(/\n$/, "")
          .split("\n")
          .map((l, i) => {
            if (!p.removed) n++;
            return (
              <div key={`${pi}-${i}`} className={`ln ${p.added ? "add" : p.removed ? "del" : ""}`}>
                <span className="n">{p.removed ? "" : n}</span>
                <span className="c">{l || " "}</span>
              </div>
            );
          }),
      )}
    </div>
  );
}

// ---------- artifacts ----------
export function ArtifactImage({ refPath, alt }: { refPath?: string | null; alt: string }) {
  const [zoom, setZoom] = useState(false);
  const [missing, setMissing] = useState(false);
  if (!refPath) return <div className="muted small">Không có screenshot.</div>;
  if (missing) return <div className="muted small">Screenshot không còn (có thể đã hết hạn lưu trữ).</div>;
  const src = artifactUrl(refPath);
  return (
    <>
      <img className="shot" src={src} alt={alt} onClick={() => setZoom(true)} onError={() => setMissing(true)} />
      {zoom && (
        <div className="overlay" onClick={() => setZoom(false)}>
          <img className="full" src={src} alt={alt} />
        </div>
      )}
    </>
  );
}

/** Screenshots the script took itself; the runner does not capture anything on its own. */
export function EvidenceShots({ evidence, what }: { evidence: Evidence; what: string }) {
  const shots = evidence.screenshots ?? (evidence.screenshot ? [evidence.screenshot] : []);
  if (!shots.length) {
    return (
      <div className="muted small">
        Script không chụp màn hình. Thêm <span className="mono">await page.screenshot()</span> vào script ở chỗ cần lưu kết quả.
      </div>
    );
  }
  return (
    <div className="col" style={{ gap: 8 }}>
      {shots.map((ref, i) => (
        <figure key={ref} style={{ margin: 0 }}>
          {shots.length > 1 && (
            <figcaption className="small muted" style={{ marginBottom: 4 }}>
              Ảnh {i + 1}/{shots.length} do script chụp
            </figcaption>
          )}
          <ArtifactImage refPath={ref} alt={`Screenshot ${i + 1} của ${what}`} />
        </figure>
      ))}
    </div>
  );
}

export function StepsTable({ refPath, live }: { refPath?: string | null; live?: StepLog[] }) {
  const [steps, setSteps] = useState<StepLog[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setSteps(null);
    setErr(null);
    if (!refPath) return;
    api
      .readArtifact(refPath)
      .then((t) => setSteps(JSON.parse(t)))
      .catch((e) => setErr((e as Error).message));
  }, [refPath]);
  const rows = steps ?? live ?? [];
  if (err) return <div className="muted small">{err}</div>;
  if (!rows.length) return <div className="muted small">Chưa có step nào được ghi.</div>;
  return (
    <div className="scroll">
      <table className="t">
        <thead>
          <tr>
            <th>#</th>
            <th>Action</th>
            <th>Đối tượng</th>
            <th>ms</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.index}>
              <td>{s.index}</td>
              <td>
                <Badge status={s.ok ? "PASSED" : "FAILED"} /> <span className="mono">{s.action}</span>
              </td>
              <td className="mono pre">
                {s.target}
                {s.args.length ? `(${s.args.join(", ")})` : ""}
                {s.error && <div className="error-box" style={{ marginTop: 6 }}>{s.error}</div>}
              </td>
              <td>{s.duration_ms}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("vi-VN", { hour12: false });
}

export const groupLabel = (group: string) => group || "Chưa phân nhóm";

/** `<option>`s for a test case `<select>`, in one `<optgroup>` per project · group. */
export function CaseOptions<T extends { test_id: string; project_name: string; group_name: string }>({ cases, label }: { cases: T[]; label: (c: T) => string }) {
  const groups = new Map<string, T[]>();
  for (const c of cases) {
    const key = `${c.project_name || "—"} · ${groupLabel(c.group_name)}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return (
    <>
      {[...groups].map(([key, list]) => (
        <optgroup key={key} label={key}>
          {list.map((c) => (
            <option key={c.test_id} value={c.test_id}>
              {label(c)}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <em className="hint">{hint}</em>}
    </label>
  );
}
