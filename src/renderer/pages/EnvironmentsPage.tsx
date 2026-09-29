import { useCallback, useEffect, useState } from "react";
import type { BrowserProfile, PreflightResult } from "../../shared/types";
import { api, useAppEvent, type ApiResult } from "../api";
import { Badge, Field, Panel, fmtTime, useAction } from "../components/ui";

type EnvRow = ApiResult<"listEnvironments">[number];
type Detected = ApiResult<"detectProfiles">[number];

interface EnvDraft {
  environment_id?: string;
  name: string;
  base_url: string;
  allowed_domains: string;
  secret_fields: string;
}

const blankEnv = (): EnvDraft => ({ name: "", base_url: "", allowed_domains: "", secret_fields: "" });

function EnvironmentEditor({ env, profiles, onSaved }: { env: EnvRow | null; profiles: BrowserProfile[]; onSaved: (id: string) => void }) {
  const [d, setD] = useState<EnvDraft>(blankEnv());
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [authSession, setAuthSession] = useState<string | null>(null);
  const [preProfile, setPreProfile] = useState("");
  const [pre, setPre] = useState<PreflightResult | null>(null);
  const { run, busy } = useAction();

  useEffect(() => {
    setD(
      env
        ? {
            environment_id: env.environment_id,
            name: env.name,
            base_url: env.base_url,
            allowed_domains: env.allowed_domains.join(", "),
            secret_fields: env.secret_fields.join(", "),
          }
        : blankEnv(),
    );
    setSecretValues({});
    setPre(null);
    setAuthSession(null);
  }, [env]);

  useAppEvent<{ session_id: string; state: string }>("auth:session", (p) => {
    if (p.session_id === authSession && p.state !== "saved") setAuthSession(null);
  });

  const save = async () => {
    const saved = await run(
      () =>
        api.saveEnvironment({
          environment_id: d.environment_id,
          name: d.name,
          base_url: d.base_url,
          allowed_domains: d.allowed_domains.split(/[,\s]+/).filter(Boolean),
          secret_fields: d.secret_fields.split(/[,\s]+/).filter(Boolean),
        }),
      "Đã lưu environment",
    );
    if (saved) onSaved(saved.environment_id);
  };

  return (
    <div className="stack">
      <Panel title={env ? env.name : "Environment mới"}>
        <div className="form-grid">
          <Field label="Tên">
            <input type="text" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />
          </Field>
          <Field label="Base URL">
            <input type="url" value={d.base_url} placeholder="https://app.example.com" onChange={(e) => setD({ ...d, base_url: e.target.value })} />
          </Field>
          <Field label="Allowed domains" hint="Phân tách bằng dấu phẩy; hỗ trợ *.example.com. Domain của base URL luôn được thêm.">
            <input type="text" value={d.allowed_domains} onChange={(e) => setD({ ...d, allowed_domains: e.target.value })} />
          </Field>
        </div>
        <div className="form-grid" style={{ marginTop: 14 }}>
          <Field label="Biến secret của environment" hint="Tên biến input lấy giá trị từ kho secret (vd: password)">
            <input type="text" value={d.secret_fields} onChange={(e) => setD({ ...d, secret_fields: e.target.value })} />
          </Field>
        </div>
        <div className="row end" style={{ marginTop: 14 }}>
          <button className="btn primary" disabled={busy} onClick={save}>
            Lưu environment
          </button>
        </div>
      </Panel>

      {env && env.secret_fields.length > 0 && (
        <Panel title="Giá trị secret">
          <p className="hint" style={{ marginTop: 0 }}>
            Được mã hoá bằng khoá của hệ điều hành. Không xuất hiện trong test case, prompt, script hay log.
          </p>
          {env.secret_fields.map((f) => (
            <div className="row" key={f} style={{ marginBottom: 8 }}>
              <span className="mono" style={{ width: 160 }}>
                {f}
              </span>
              <Badge status={env.secret_status[f] ? "PASSED" : "PENDING"} title={env.secret_status[f] ? "Đã lưu" : "Chưa có"} />
              <input type="password" placeholder={env.secret_status[f] ? "Nhập để thay giá trị" : "Nhập giá trị"} value={secretValues[f] ?? ""} onChange={(e) => setSecretValues({ ...secretValues, [f]: e.target.value })} />
              <button
                className="btn sm"
                disabled={busy || !secretValues[f]}
                onClick={async () => {
                  await run(() => api.setEnvironmentSecret(env.environment_id, f, secretValues[f]), `Đã lưu secret ${f}`);
                  setSecretValues({ ...secretValues, [f]: "" });
                  onSaved(env.environment_id);
                }}
              >
                Lưu
              </button>
            </div>
          ))}
        </Panel>
      )}

      {env && (
        <Panel title="Runner auth (Trial / Testing)">
          <p className="hint" style={{ marginTop: 0 }}>
            Runner chạy trên browser context riêng, dùng storage state tạo từ một phiên đăng nhập riêng — không sao chép cookie từ Chrome profile của Training.
          </p>
          <div className="row">
            <Badge status={env.runner_auth_ready ? "CONNECTED" : "AUTH_REQUIRED"} title={env.runner_auth_ready ? "Đã có auth state" : "Chưa có"} />
            <span className="muted small">{env.runner_auth_ready ? `Cập nhật ${fmtTime(env.runner_auth_updated_at)}` : "Chưa có auth state cho runner"}</span>
            <span style={{ flex: 1 }} />
            {!authSession ? (
              <button
                className="btn"
                disabled={busy}
                onClick={async () => {
                  const s = await run(() => api.beginRunnerLogin(env.environment_id));
                  if (s) setAuthSession(s.session_id);
                }}
              >
                Mở trình duyệt để đăng nhập
              </button>
            ) : (
              <>
                <span className="small">Đăng nhập trong cửa sổ vừa mở, sau đó bấm:</span>
                <button
                  className="btn primary"
                  disabled={busy}
                  onClick={async () => {
                    await run(() => api.finishRunnerLogin(authSession), "Đã lưu runner auth state");
                    setAuthSession(null);
                    onSaved(env.environment_id);
                  }}
                >
                  Lưu phiên đăng nhập
                </button>
                <button className="btn" onClick={() => api.cancelRunnerLogin(authSession).then(() => setAuthSession(null))}>
                  Huỷ
                </button>
              </>
            )}
            {env.runner_auth_ready && (
              <button
                className="btn"
                onClick={async () => {
                  if (!confirm("Xoá runner auth state?")) return;
                  await run(() => api.clearRunnerAuth(env.environment_id), "Đã xoá runner auth");
                  onSaved(env.environment_id);
                }}
              >
                Xoá
              </button>
            )}
          </div>
        </Panel>
      )}

      {env && (
        <Panel title="Kiểm tra kết nối Training profile">
          <div className="row">
            <select value={preProfile} onChange={(e) => setPreProfile(e.target.value)}>
              <option value="">— Chọn Chrome profile —</option>
              {profiles.map((p) => (
                <option key={p.browser_profile_id} value={p.browser_profile_id}>
                  {p.display_name} ({p.profile_dir_name})
                </option>
              ))}
            </select>
            <button
              className="btn"
              disabled={busy || !preProfile}
              onClick={async () => {
                setPre(null);
                const r = await run(() => api.preflight(preProfile, env.environment_id));
                if (r) setPre(r);
              }}
            >
              {busy ? "Đang kiểm tra…" : "Chạy preflight"}
            </button>
            {pre && <Badge status={pre.status} />}
          </div>
          {pre && <div className={pre.status === "CONNECTED" ? "info-box" : "error-box"} style={{ marginTop: 10 }}>{pre.message}</div>}
        </Panel>
      )}
    </div>
  );
}

function ProfilesPanel({ profiles, reload }: { profiles: BrowserProfile[]; reload: () => void }) {
  const [detected, setDetected] = useState<Detected[]>([]);
  const [draft, setDraft] = useState<{ id?: string; display_name: string; profile_dir_name: string; browser: "chrome" | "msedge"; token: string }>({
    display_name: "",
    profile_dir_name: "",
    browser: "chrome",
    token: "",
  });
  const { run, busy } = useAction();
  useEffect(() => {
    api.detectProfiles().then(setDetected).catch(() => setDetected([]));
  }, []);
  const matchedIndex = detected.findIndex((p) => p.browser === draft.browser && p.profile_dir_name === draft.profile_dir_name.trim());

  return (
    <Panel title="Chrome profiles cho Training">
      <p className="hint" style={{ marginTop: 0 }}>
        Mỗi profile cần cài Playwright Extension. Worker kết nối bằng <span className="mono">--profile-dir-name</span>, không dùng nhãn hiển thị để kết nối. Token của extension (tuỳ chọn) giúp bỏ qua bước xác nhận kết nối trong trình duyệt.
      </p>
      {profiles.length > 0 && (
        <table className="t" style={{ marginBottom: 14 }}>
          <thead>
            <tr>
              <th>Nhãn</th>
              <th>profile_dir_name</th>
              <th>Browser</th>
              <th>Máy</th>
              <th>Token</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {profiles.map((p) => (
              <tr key={p.browser_profile_id}>
                <td>{p.display_name}</td>
                <td className="mono">{p.profile_dir_name}</td>
                <td>{p.browser}</td>
                <td className="small">{p.machine_id}</td>
                <td>{p.has_extension_token ? <Badge status="PASSED" title="Đã lưu token" /> : <span className="muted small">—</span>}</td>
                <td className="row">
                  <button className="btn sm" onClick={() => setDraft({ id: p.browser_profile_id, display_name: p.display_name, profile_dir_name: p.profile_dir_name, browser: p.browser, token: "" })}>
                    Sửa
                  </button>
                  <button
                    className="btn sm"
                    onClick={async () => {
                      if (!confirm(`Xoá profile ${p.display_name}?`)) return;
                      await run(() => api.deleteProfile(p.browser_profile_id), "Đã xoá profile");
                      reload();
                    }}
                  >
                    Xoá
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="form-grid">
        <Field label="Chọn từ profile trên máy">
          <select
            value={matchedIndex >= 0 ? String(matchedIndex) : ""}
            onChange={(e) => {
              const found = detected[Number(e.target.value)];
              if (found) setDraft({ ...draft, profile_dir_name: found.profile_dir_name, browser: found.browser, display_name: draft.display_name || found.name });
            }}
          >
            <option value="">
              {!detected.length ? "Không tìm thấy profile" : draft.profile_dir_name && matchedIndex < 0 ? `Không có "${draft.profile_dir_name}" trên máy này` : "— Chọn —"}
            </option>
            {detected.map((p, i) => (
              <option key={`${p.browser}-${p.profile_dir_name}`} value={i}>
                {p.browser === "chrome" ? "Chrome" : "Edge"} · {p.name} ({p.profile_dir_name})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Nhãn hiển thị">
          <input type="text" value={draft.display_name} onChange={(e) => setDraft({ ...draft, display_name: e.target.value })} />
        </Field>
        <Field label="profile_dir_name">
          <input type="text" className="mono" placeholder="Profile 1" value={draft.profile_dir_name} onChange={(e) => setDraft({ ...draft, profile_dir_name: e.target.value })} />
        </Field>
        <Field label="Browser">
          <select value={draft.browser} onChange={(e) => setDraft({ ...draft, browser: e.target.value as "chrome" | "msedge" })}>
            <option value="chrome">Chrome</option>
            <option value="msedge">Edge</option>
          </select>
        </Field>
        <Field label="Extension token (tuỳ chọn)" hint="Dán token hoặc cả dòng PLAYWRIGHT_MCP_EXTENSION_TOKEN=… từ extension.">

          <input type="password" value={draft.token} placeholder={draft.id ? "Để trống = giữ nguyên" : ""} onChange={(e) => setDraft({ ...draft, token: e.target.value })} />
        </Field>
      </div>
      <div className="row end" style={{ marginTop: 12 }}>
        {draft.id && (
          <button className="btn" onClick={() => setDraft({ display_name: "", profile_dir_name: "", browser: "chrome", token: "" })}>
            Huỷ sửa
          </button>
        )}
        <button
          className="btn primary"
          disabled={busy || !draft.display_name || !draft.profile_dir_name}
          onClick={async () => {
            const r = await run(
              () =>
                api.saveProfile({
                  browser_profile_id: draft.id,
                  display_name: draft.display_name,
                  profile_dir_name: draft.profile_dir_name,
                  browser: draft.browser,
                  extension_token: draft.token ? draft.token : draft.id ? null : "",
                }),
              "Đã lưu profile",
            );
            if (r) {
              setDraft({ display_name: "", profile_dir_name: "", browser: "chrome", token: "" });
              reload();
            }
          }}
        >
          {draft.id ? "Lưu profile" : "Đăng ký profile"}
        </button>
      </div>
    </Panel>
  );
}

export function EnvironmentsPage() {
  const [envs, setEnvs] = useState<EnvRow[]>([]);
  const [profiles, setProfiles] = useState<BrowserProfile[]>([]);
  const [selected, setSelected] = useState<string | "new" | null>(null);

  const load = useCallback(async () => {
    const [e, p] = await Promise.all([api.listEnvironments(), api.listProfiles()]);
    setEnvs(e);
    setProfiles(p);
    setSelected((s) => s ?? e[0]?.environment_id ?? "new");
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const env = selected && selected !== "new" ? (envs.find((e) => e.environment_id === selected) ?? null) : null;

  return (
    <div>
      <div className="page-head">
        <h1>Environment</h1>
        <p>Website test, runner auth và Chrome profile cho Training.</p>
      </div>
      <div className="split">
        <div className="stack">
          <Panel title="Environments" actions={<button className="btn sm" onClick={() => setSelected("new")}>Thêm</button>} bodyClass="">
            {envs.length === 0 ? (
              <div className="empty">Chưa có environment.</div>
            ) : (
              <ul className="list">
                {envs.map((e) => (
                  <li key={e.environment_id} className={e.environment_id === selected ? "sel" : ""} onClick={() => setSelected(e.environment_id)}>
                    <div className="line">
                      <span className="title">{e.name}</span>
                      <span style={{ marginLeft: "auto" }}>
                        <Badge status={e.runner_auth_ready ? "CONNECTED" : "AUTH_REQUIRED"} title="Runner auth" />
                      </span>
                    </div>
                    <span className="mono muted">{e.base_url}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
        <div className="stack">
          <EnvironmentEditor
            env={env}
            profiles={profiles}
            onSaved={async (id) => {
              await load();
              setSelected(id);
            }}
          />
          <ProfilesPanel profiles={profiles} reload={load} />
        </div>
      </div>
    </div>
  );
}
