// Demo website for exercising Training/Trial/Testing locally.
// Login: demo / demo123. POST /__admin/break?on=1 renames the Save button to break locators.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.DEMO_PORT ?? 4567);
const sessions = new Set();
const campaigns = [];
const assets = [];
let broken = false;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const layout = (title, body, user = true) => `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font-family:system-ui;margin:0;background:#f5f6f8}header{background:#1f2937;color:#fff;padding:12px 24px;display:flex;justify-content:space-between}
header a{color:#cbd5e1}main{max-width:760px;margin:24px auto;background:#fff;padding:24px;border-radius:8px}label{display:block;margin:12px 0 4px}
input,select{padding:8px;width:100%;box-sizing:border-box}button{margin-top:16px;padding:8px 16px}table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid #e5e7eb;padding:8px;text-align:left}</style>
</head><body>${user ? `<header><span>Demo Ads</span><span><a href="/assets">Assets</a> · Xin chào demo · <a href="/logout">Logout</a></span></header>` : ""}<main>${body}</main></body></html>`;

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie ?? "").split(";").map((c) => c.trim().split("=")).filter((p) => p[0]));
}

async function readBody(req) {
  let data = "";
  for await (const chunk of req) data += chunk;
  return Object.fromEntries(new URLSearchParams(data));
}

/** Minimal multipart/form-data reader: returns the first file part as { name, size }. */
async function readUpload(req) {
  const boundary = (req.headers["content-type"] ?? "").match(/boundary=(?:"([^"]+)"|([^;]+))/);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!boundary) return null;
  const raw = Buffer.concat(chunks).toString("latin1");
  const m = raw.match(/Content-Disposition: form-data; name="[^"]*"; filename="([^"]*)"\r\n(?:[^\r\n]+\r\n)*\r\n/i);
  if (!m || !m[1]) return null;
  const start = m.index + m[0].length;
  const end = raw.indexOf(`\r\n--${boundary[1] ?? boundary[2]}`, start);
  return { name: Buffer.from(m[1], "latin1").toString("utf8"), size: (end < 0 ? raw.length : end) - start };
}

/**
 * Element Plus–style select: the combobox has no accessible name and an id generated per page load,
 * so the recorder falls back to `#el-id-…` (exercises the stable-locator lookup of the recording).
 */
function ownerSelect() {
  const id = `el-id-${1000 + Math.floor(Math.random() * 9000)}-${100 + Math.floor(Math.random() * 900)}`;
  return `<div class="form-item"><label class="form-item__label">Owner</label><div class="form-item__content"><div class="flex w-full">
      <div class="select__wrapper"><input id="${id}" class="select__input" role="combobox" aria-expanded="false" readonly autocomplete="off"><span class="select__placeholder">Select owner</span></div>
      <ul class="select__menu" role="listbox" hidden><li role="option">Alice</li><li role="option">Bob</li></ul>
      <input type="hidden" name="owner"></div></div></div>
      <script>(() => {
        const box = document.getElementById(${JSON.stringify(id)}), menu = document.querySelector(".select__menu");
        box.addEventListener("click", () => { menu.hidden = !menu.hidden; box.setAttribute("aria-expanded", String(!menu.hidden)); });
        menu.addEventListener("click", (e) => {
          const li = e.target.closest("li"); if (!li) return;
          document.querySelector("input[name=owner]").value = li.textContent;
          document.querySelector(".select__placeholder").textContent = li.textContent;
          menu.hidden = true; box.setAttribute("aria-expanded", "false");
        });
      })();</script>`;
}

/**
 * Element Plus 2.x–style select with the label inside the form item content and the same "Select" placeholder in every
 * field: the recorder names the placeholder by position (`getByText('Select').first()`), which points at another field
 * once the previous one has a value.
 */
function placeholderSelect(label, options) {
  return `<div class="form-item"><div class="form-item__content"><div class="flex w-full"><label class="text-sm">${esc(label)}</label></div>
      <div class="dselect"><div class="dselect__wrapper"><div class="dselect__selection"><span class="dselect__placeholder">Select</span></div></div>
      <ul class="dselect__menu" role="listbox" hidden>${options.map((o) => `<li role="option">${esc(o)}</li>`).join("")}</ul></div></div></div>
      <script>(() => {
        const root = document.currentScript.previousElementSibling.querySelector(".dselect");
        const menu = root.querySelector(".dselect__menu"), text = root.querySelector(".dselect__placeholder");
        root.querySelector(".dselect__wrapper").addEventListener("click", () => { menu.hidden = !menu.hidden; });
        menu.addEventListener("click", (e) => { const li = e.target.closest("li"); if (li) { text.textContent = li.textContent; menu.hidden = true; } });
      })();</script>`;
}

function send(res, status, html, headers = {}) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
  res.end(html);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const authed = sessions.has(parseCookies(req).sid);

  if (url.pathname === "/__admin/break" && req.method === "POST") {
    broken = url.searchParams.get("on") === "1";
    return send(res, 200, `broken=${broken}`);
  }
  if (url.pathname === "/__admin/reset" && req.method === "POST") {
    campaigns.length = 0;
    assets.length = 0;
    broken = false;
    return send(res, 200, "reset");
  }
  if (url.pathname === "/__admin/autologin" && process.env.DEMO_AUTOLOGIN === "1") {
    const sid = randomUUID();
    sessions.add(sid);
    return send(res, 302, "", { location: "/campaigns", "set-cookie": `sid=${sid}; Path=/; HttpOnly` });
  }
  if (url.pathname === "/login" && req.method === "GET") {
    return send(res, 200, layout("Đăng nhập", `<h1>Đăng nhập</h1><form method="post" action="/login">
      <label for="u">Username</label><input id="u" name="username"><label for="p">Password</label><input id="p" name="password" type="password">
      <button type="submit">Sign in</button></form>`, false));
  }
  if (url.pathname === "/login" && req.method === "POST") {
    const body = await readBody(req);
    if (body.username === "demo" && body.password === "demo123") {
      const sid = randomUUID();
      sessions.add(sid);
      return send(res, 302, "", { location: "/campaigns", "set-cookie": `sid=${sid}; Path=/; HttpOnly` });
    }
    return send(res, 401, layout("Đăng nhập", `<p role="alert">Sai tài khoản</p><a href="/login">Thử lại</a>`, false));
  }
  if (url.pathname === "/logout") {
    sessions.delete(parseCookies(req).sid);
    return send(res, 302, "", { location: "/login" });
  }
  if (!authed) return send(res, 302, "", { location: "/login" });

  if (url.pathname === "/" || url.pathname === "/campaigns") {
    const rows = campaigns.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.objective)}</td></tr>`).join("");
    return send(res, 200, layout("Campaign List", `<h1>Campaign List</h1><a href="/campaigns/new" role="button">Create Campaign</a>
      <table aria-label="Campaigns"><thead><tr><th>Name</th><th>Objective</th></tr></thead><tbody>${rows || `<tr><td colspan="2">Chưa có campaign</td></tr>`}</tbody></table>`));
  }
  if (url.pathname === "/campaigns/new" && req.method === "GET") {
    return send(res, 200, layout("Create Campaign", `<h1>Create Campaign</h1><form method="post" action="/campaigns/new">
      <label for="name">Campaign Name</label><input id="name" name="name" required>
      <label for="obj">Objective</label><select id="obj" name="objective"><option>Sales</option><option>Awareness</option><option>Traffic</option></select>
      ${ownerSelect()}
      ${placeholderSelect("Region", ["EU", "US"])}
      ${placeholderSelect("Channel", ["Search", "Video"])}
      ${placeholderSelect("Tier", ["Gold", "Silver"])}
      <button type="submit">${broken ? "Lưu lại" : "Save"}</button></form>`));
  }
  if (url.pathname === "/campaigns/new" && req.method === "POST") {
    const body = await readBody(req);
    campaigns.push({ name: body.name ?? "", objective: body.objective ?? "" });
    return send(res, 302, "", { location: "/campaigns" });
  }
  if (url.pathname === "/assets" && req.method === "GET") {
    const rows = assets.map((a) => `<tr><td>${esc(a.name)}</td><td>${a.size} bytes</td></tr>`).join("");
    return send(res, 200, layout("Assets", `<h1>Assets</h1><a href="/assets/upload" role="button">Upload asset</a>
      <table aria-label="Assets"><thead><tr><th>File</th><th>Size</th></tr></thead><tbody>${rows || `<tr><td colspan="2">Chưa có file</td></tr>`}</tbody></table>`));
  }
  if (url.pathname === "/assets/upload" && req.method === "GET") {
    return send(res, 200, layout("Upload asset", `<h1>Upload asset</h1><form method="post" action="/assets/upload" enctype="multipart/form-data">
      <label for="file">Banner file</label><input id="file" name="file" type="file" required>
      <button type="submit">Upload</button></form>`));
  }
  if (url.pathname === "/assets/upload" && req.method === "POST") {
    const file = await readUpload(req);
    if (!file) return send(res, 400, layout("Upload asset", `<p role="alert">Chưa chọn file</p><a href="/assets/upload">Thử lại</a>`));
    assets.push(file);
    return send(res, 302, "", { location: "/assets" });
  }
  send(res, 404, layout("404", "<h1>Không tìm thấy</h1>"));
});

server.listen(PORT, "127.0.0.1", () => console.log(`Demo site: http://localhost:${PORT} (demo / demo123)`));
