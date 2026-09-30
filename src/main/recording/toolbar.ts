import { TOOLBAR_TAG } from "../../core/recording";

/** Name of the binding the in-page toolbar calls; exposed with BrowserContext.exposeBinding. */
export const TOOLBAR_BINDING = "__e2eRec";

/** What the toolbar shows; pushed to every tab after each change. */
export interface ToolbarState {
  step: number;
  total: number;
  text: string;
  /** Current step asks for a screenshot. */
  shot: boolean;
  /** Current step is the "close the browser" step. */
  close: boolean;
  actions: number;
  shots: number;
}

/**
 * Floating control bar injected into every page of the recording browser. It lives in a closed shadow root so
 * page CSS cannot restyle it; the recorder sees clicks on it only as clicks on the host, which
 * cleanRecording drops. Styles use a
 * constructed stylesheet and nodes are built without innerHTML so strict CSP / Trusted Types pages still work.
 */
export const TOOLBAR_SCRIPT = `(() => {
  if (window.top !== window || window.__e2eRecInstalled) return;
  window.__e2eRecInstalled = true;
  const BIND = ${JSON.stringify(TOOLBAR_BINDING)};
  const CSS = \`
    .bar { position: fixed; bottom: 12px; z-index: 2147483647; display: flex; align-items: center; gap: 6px;
      max-width: min(820px, calc(100vw - 24px)); padding: 6px 8px; box-sizing: border-box;
      background: #151c26; color: #e8edf3; border-radius: 8px; box-shadow: 0 6px 24px rgba(0,0,0,.35);
      font: 13px/1.3 "Segoe UI", system-ui, sans-serif; }
    .bar.left { left: 12px; } .bar.right { right: 12px; }
    .rec { width: 10px; height: 10px; border-radius: 50%; background: #e5484d; flex: none; animation: blink 1.2s infinite; }
    @keyframes blink { 50% { opacity: .35; } }
    .step { min-width: 0; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 0 4px; }
    .step b { color: #9db2ff; font-weight: 600; margin-right: 6px; }
    button { all: unset; cursor: pointer; padding: 5px 9px; border-radius: 5px; background: #273244; color: #fff; white-space: nowrap; }
    button:hover { background: #33415a; }
    button:disabled { opacity: .35; cursor: default; }
    button.hot { background: #2446c7; box-shadow: 0 0 0 2px #7d98ff; }
    button.stop { background: #8d2219; }
    button.stop:hover { background: #a52c22; }
    .count { color: #9aa8ba; font-size: 12px; white-space: nowrap; }
    .flash { color: #6ee7a8; font-size: 12px; white-space: nowrap; }
  \`;
  let state = null;
  let side = "left";
  let host, bar, stepEl, prevBtn, nextBtn, shotBtn, stopBtn, countEl, flashEl, flashTimer;
  const el = (tag, cls, text, title) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    if (title) e.title = title;
    return e;
  };
  const send = (cmd) => {
    const fn = window[BIND];
    if (typeof fn !== "function") return;
    Promise.resolve(fn(cmd)).then((s) => { if (s) { state = s; render(); } }).catch(() => {});
  };
  const flash = (text) => {
    flashEl.textContent = text;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flashEl.textContent = ""; }, 1600);
  };
  const build = () => {
    host = document.createElement(${JSON.stringify(TOOLBAR_TAG)});
    const root = host.attachShadow({ mode: "closed" });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      root.adoptedStyleSheets = [sheet];
    } catch {
      root.appendChild(el("style", "", CSS));
    }
    bar = el("div", "bar " + side);
    prevBtn = el("button", "", "‹", "Bước trước");
    stepEl = el("span", "step");
    nextBtn = el("button", "", "›", "Bước tiếp");
    shotBtn = el("button", "", "📷 Chụp màn hình", "Script sẽ chụp màn hình tại thời điểm này");
    stopBtn = el("button", "stop", "■ Kết thúc", "Dừng ghi, đóng trình duyệt và tạo candidate");
    countEl = el("span", "count");
    flashEl = el("span", "flash");
    const sideBtn = el("button", "", "⇆", "Chuyển thanh sang góc bên kia");
    bar.append(el("span", "rec", null, "Đang ghi thao tác"), prevBtn, stepEl, nextBtn, shotBtn, stopBtn, countEl, flashEl, sideBtn);
    root.appendChild(bar);
    prevBtn.addEventListener("click", () => send({ type: "prev" }));
    nextBtn.addEventListener("click", () => send({ type: "next" }));
    shotBtn.addEventListener("click", () => { send({ type: "shot" }); flash("Đã đánh dấu chụp ✓"); });
    stopBtn.addEventListener("click", () => { stopBtn.disabled = true; send({ type: "stop" }); });
    sideBtn.addEventListener("click", () => { side = side === "left" ? "right" : "left"; bar.className = "bar " + side; });
    const center = (b) => { const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
    Object.defineProperty(host, "__e2eRects", { value: () => ({ prev: center(prevBtn), next: center(nextBtn), shot: center(shotBtn), stop: center(stopBtn) }) });
    render();
  };
  const render = () => {
    if (!bar) return;
    if (!state) { stepEl.replaceChildren(el("b", "", "Đang ghi…")); return; }
    stepEl.replaceChildren(el("b", "", "Bước " + state.step + "/" + state.total), document.createTextNode(state.text || ""));
    stepEl.title = state.text || "";
    prevBtn.disabled = state.step <= 1;
    nextBtn.disabled = state.step >= state.total;
    shotBtn.className = state.shot ? "hot" : "";
    stopBtn.textContent = state.close ? "■ Đóng trình duyệt & kết thúc" : "■ Kết thúc";
    countEl.textContent = state.actions + " thao tác · " + state.shots + " ảnh";
  };
  window.__e2eRecSet = (s) => { state = s; render(); };
  const mount = () => {
    if (!document.documentElement) return;
    if (!host) build();
    if (!host.isConnected) document.documentElement.appendChild(host);
  };
  // Playwright's own recorder tools (toggle recording, pick locator, assertions) would silently break this flow.
  // They sit in a closed shadow root pinned to the top edge of the x-pw-glass pane, so clip that strip away
  // (also from hit testing) and keep the pane's hover highlight everywhere else.
  const PW_TOOLS_CSS = "x-pw-glass { clip-path: inset(34px 0 0 0) !important; }";
  const hidePwTools = () => {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(PW_TOOLS_CSS);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    } catch {
      document.documentElement.appendChild(el("style", "", PW_TOOLS_CSS));
    }
  };
  const start = () => {
    mount();
    hidePwTools();
    send({ type: "hello" });
    new MutationObserver(() => { if (host && !host.isConnected) mount(); }).observe(document.documentElement, { childList: true });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();`;
