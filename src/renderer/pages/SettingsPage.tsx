import { useEffect, useState } from "react";
import type { AgentProvider, BrowserProfile, Settings } from "../../shared/types";
import { api, type ApiResult } from "../api";
import { Badge, Field, Panel, fmtTime, useAction } from "../components/ui";

const SPEED_PRESETS = [
  { ms: 0, label: "Tối đa (không nghỉ)" },
  { ms: 250, label: "Nhanh — 250 ms / thao tác" },
  { ms: 500, label: "Vừa — 500 ms / thao tác (mặc định)" },
  { ms: 1000, label: "Chậm — 1 giây / thao tác" },
  { ms: 2000, label: "Rất chậm — 2 giây / thao tác" },
];

type Integration = ApiResult<"getIntegrationStatus">;
type EnvRow = ApiResult<"listEnvironments">[number];

export function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [keys, setKeys] = useState({ codex: "", cursor: "" });
  const [integration, setIntegration] = useState<Integration | null>(null);
  const [profiles, setProfiles] = useState<BrowserProfile[]>([]);
  const [envs, setEnvs] = useState<EnvRow[]>([]);
  const [check, setCheck] = useState({ profile: "", env: "" });
  const [checking, setChecking] = useState<AgentProvider | null>(null);
  const { run, busy } = useAction();

  useEffect(() => {
    void Promise.all([api.getSettings(), api.getIntegrationStatus(), api.listProfiles(), api.listEnvironments()]).then(([s, i, p, e]) => {
      setSettings(s);
      setIntegration(i);
      setProfiles(p);
      setEnvs(e);
      setCheck({ profile: p[0]?.browser_profile_id ?? "", env: e[0]?.environment_id ?? "" });
    });
  }, []);

  if (!settings) return null;
  const num = (k: keyof Settings) => (e: React.ChangeEvent<HTMLInputElement>) => setSettings({ ...settings, [k]: Number(e.target.value) });

  return (
    <div>
      <div className="page-head">
        <h1>Cài đặt</h1>
        <p>Thông tin xác thực agent, giới hạn chạy và kiểm tra tích hợp.</p>
      </div>
      <div className="stack" style={{ maxWidth: 980 }}>
        <Panel title="Agent">
          <div className="form-grid">
            <Field label="OpenAI API key cho Codex" hint={settings.has_openai_key ? "Đã lưu. Nhập để thay." : "Tuỳ chọn nếu Codex CLI đã đăng nhập (codex login)."}>
              <div className="row">
                <input type="password" style={{ flex: 1 }} value={keys.codex} onChange={(e) => setKeys({ ...keys, codex: e.target.value })} />
                <button className="btn sm" disabled={busy || !keys.codex} onClick={() => run(() => api.setApiKey("codex", keys.codex), "Đã lưu key").then((s) => s && (setSettings(s), setKeys({ ...keys, codex: "" })))}>
                  Lưu
                </button>
                {settings.has_openai_key && (
                  <button className="btn sm" onClick={() => run(() => api.setApiKey("codex", ""), "Đã xoá key").then((s) => s && setSettings(s))}>
                    Xoá
                  </button>
                )}
              </div>
            </Field>
            <Field label="Cursor API key" hint={settings.has_cursor_key ? "Đã lưu. Nhập để thay." : "Bắt buộc để dùng Cursor SDK."}>
              <div className="row">
                <input type="password" style={{ flex: 1 }} value={keys.cursor} onChange={(e) => setKeys({ ...keys, cursor: e.target.value })} />
                <button className="btn sm" disabled={busy || !keys.cursor} onClick={() => run(() => api.setApiKey("cursor", keys.cursor), "Đã lưu key").then((s) => s && (setSettings(s), setKeys({ ...keys, cursor: "" })))}>
                  Lưu
                </button>
                {settings.has_cursor_key && (
                  <button className="btn sm" onClick={() => run(() => api.setApiKey("cursor", ""), "Đã xoá key").then((s) => s && setSettings(s))}>
                    Xoá
                  </button>
                )}
              </div>
            </Field>
            <Field label="Model Codex" hint="Để trống = mặc định của Codex CLI">
              <input type="text" value={settings.codex_model} onChange={(e) => setSettings({ ...settings, codex_model: e.target.value })} />
            </Field>
            <Field label="Model Cursor">
              <input type="text" value={settings.cursor_model} onChange={(e) => setSettings({ ...settings, cursor_model: e.target.value })} />
            </Field>
          </div>
        </Panel>

        <Panel title="Giới hạn">
          <div className="form-grid">
            <Field label="Thời gian tối đa mỗi lượt Training (phút)">
              <input type="number" value={settings.training_timeout_min} onChange={num("training_timeout_min")} />
            </Field>
            <Field label="Số browser action tối đa mỗi lượt">
              <input type="number" value={settings.training_max_actions} onChange={num("training_max_actions")} />
            </Field>
            <Field label="Số lần yêu cầu agent sửa khi candidate lỗi">
              <input type="number" value={settings.training_max_repairs} onChange={num("training_max_repairs")} />
            </Field>
            <label className="field">
              <span>Dùng script đã duyệt cùng dự án làm tham chiếu</span>
              <input type="checkbox" checked={settings.training_project_refs} onChange={(e) => setSettings({ ...settings, training_project_refs: e.target.checked })} />
              <em className="hint">
                Agent dùng lại trang, locator của các version APPROVED khác trong dự án. Khi environment có runner auth, agent soạn nháp trước và app chạy ẩn để kiểm chứng (tối đa 2 lần sửa), lần chạy cuối được lưu làm Trial của candidate.
              </em>
            </label>
            <Field label="Timeout mỗi Trial/Test run (giây)">
              <input type="number" value={settings.run_timeout_sec} onChange={num("run_timeout_sec")} />
            </Field>
            <Field label="Số run chạy đồng thời">
              <input type="number" value={settings.max_concurrent_runs} onChange={num("max_concurrent_runs")} />
            </Field>
            <Field label="Thời hạn lưu screenshot/trace (ngày)">
              <input type="number" value={settings.artifact_retention_days} onChange={num("artifact_retention_days")} />
            </Field>
          </div>
        </Panel>

        <Panel title="Runner (Trial / Testing)">
          <div className="form-grid">
            <Field label="Browser">
              <select value={settings.runner_browser} onChange={(e) => setSettings({ ...settings, runner_browser: e.target.value as Settings["runner_browser"] })}>
                <option value="chrome">Google Chrome (đã cài)</option>
                <option value="msedge">Microsoft Edge (đã cài)</option>
                <option value="chromium">Chromium của Playwright</option>
              </select>
            </Field>
            <label className="field">
              <span>Chạy ẩn (headless)</span>
              <input type="checkbox" checked={settings.runner_headless} onChange={(e) => setSettings({ ...settings, runner_headless: e.target.checked })} />
            </label>
            <label className="field">
              <span>Giữ browser mở sau Trial / Testing</span>
              <input
                type="checkbox"
                checked={settings.runner_keep_open}
                disabled={settings.runner_headless}
                onChange={(e) => setSettings({ ...settings, runner_keep_open: e.target.checked })}
              />
              <em className="hint">Chỉ khi không chạy ẩn. Sau khi script xong, runner không thao tác thêm; đóng cửa sổ browser để kết thúc (tối đa 30 phút).</em>
            </label>
            <label className="field">
              <span>Tốc độ thao tác</span>
              <select
                value={SPEED_PRESETS.some((p) => p.ms === settings.runner_slow_mo_ms) ? settings.runner_slow_mo_ms : "custom"}
                disabled={settings.runner_headless}
                onChange={(e) => e.target.value !== "custom" && setSettings({ ...settings, runner_slow_mo_ms: Number(e.target.value) })}
              >
                {SPEED_PRESETS.map((p) => (
                  <option key={p.ms} value={p.ms}>
                    {p.label}
                  </option>
                ))}
                {!SPEED_PRESETS.some((p) => p.ms === settings.runner_slow_mo_ms) && <option value="custom">Tuỳ chỉnh — {settings.runner_slow_mo_ms} ms</option>}
              </select>
              <em className="hint">Khoảng nghỉ trước mỗi thao tác khi chạy có giao diện, để theo dõi được. Chạy ẩn luôn ở tốc độ tối đa.</em>
            </label>
            <label className="field">
              <span>Giới hạn ghi file của runner</span>
              <input type="checkbox" checked={settings.runner_fs_restricted} onChange={(e) => setSettings({ ...settings, runner_fs_restricted: e.target.checked })} />
              <em className="hint">Node permission model: script chỉ ghi được vào thư mục run.</em>
            </label>
          </div>
          <div className="row end" style={{ marginTop: 12 }}>
            <button className="btn primary" disabled={busy} onClick={() => run(() => api.updateSettings(settings), "Đã lưu cài đặt").then((s) => s && setSettings(s))}>
              Lưu cài đặt
            </button>
          </div>
        </Panel>

        <Panel title="Kiểm tra tích hợp agent">
          <p className="hint" style={{ marginTop: 0 }}>
            Bắt buộc trên máy đích: SDK → Playwright MCP Extension → đúng profile → preflight → tool action → candidate file. Adapter chỉ được coi là hoạt động khi kiểm tra này đạt.
          </p>
          <div className="row" style={{ marginBottom: 12 }}>
            <select value={check.profile} onChange={(e) => setCheck({ ...check, profile: e.target.value })}>
              {profiles.length === 0 && <option value="">Chưa đăng ký Chrome profile (màn Environment)</option>}
              {profiles.map((p) => (
                <option key={p.browser_profile_id} value={p.browser_profile_id}>
                  {p.display_name} ({p.profile_dir_name})
                </option>
              ))}
            </select>
            <select value={check.env} onChange={(e) => setCheck({ ...check, env: e.target.value })}>
              {envs.map((e) => (
                <option key={e.environment_id} value={e.environment_id}>
                  {e.name}
                </option>
              ))}
            </select>
          </div>
          {(["codex", "cursor"] as AgentProvider[]).map((a) => {
            const r = integration?.[a];
            return (
              <div key={a} className="panel" style={{ padding: 12, marginBottom: 10 }}>
                <div className="row">
                  <strong style={{ fontFamily: "var(--display)", letterSpacing: "0.04em", width: 80 }}>{a === "codex" ? "CODEX" : "CURSOR"}</strong>
                  {r ? <Badge status={r.ok ? "PASSED" : "FAILED"} /> : <span className="badge">CHƯA KIỂM TRA</span>}
                  {r && (
                    <span className="small muted">
                      {fmtTime(r.at)} · {r.profile} · {r.environment}
                    </span>
                  )}
                  <span style={{ flex: 1 }} />
                  <button
                    className="btn"
                    disabled={!!checking || !check.profile || !check.env}
                    onClick={async () => {
                      setChecking(a);
                      const res = await run(() => api.runIntegrationCheck(a, check.profile, check.env));
                      setChecking(null);
                      if (res) setIntegration((i) => (i ? { ...i, [a]: res } : i));
                    }}
                  >
                    {checking === a ? "Đang kiểm tra…" : "Chạy kiểm tra"}
                  </button>
                </div>
                {r && (
                  <ul className="small" style={{ margin: "8px 0 0", paddingLeft: 18 }}>
                    {r.checks.map((c, i) => (
                      <li key={i}>
                        <Badge status={c.ok ? "PASSED" : "FAILED"} /> {c.name} — <span className="muted">{c.detail}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </Panel>
      </div>
    </div>
  );
}
