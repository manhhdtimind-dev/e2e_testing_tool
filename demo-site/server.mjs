// Demo website for exercising Training/Trial/Testing locally.
// Login: demo / demo123. POST /__admin/break?on=1 renames the Save button to break locators.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.DEMO_PORT ?? 4567);
const sessions = new Set();
const campaigns = [];
let broken = false;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const layout = (title, body, user = true) => `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font-family:system-ui;margin:0;background:#f5f6f8}header{background:#1f2937;color:#fff;padding:12px 24px;display:flex;justify-content:space-between}
header a{color:#cbd5e1}main{max-width:760px;margin:24px auto;background:#fff;padding:24px;border-radius:8px}label{display:block;margin:12px 0 4px}
input,select{padding:8px;width:100%;box-sizing:border-box}button{margin-top:16px;padding:8px 16px}table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid #e5e7eb;padding:8px;text-align:left}</style>
</head><body>${user ? `<header><span>Demo Ads</span><span>Xin chào demo · <a href="/logout">Logout</a></span></header>` : ""}<main>${body}</main></body></html>`;

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie ?? "").split(";").map((c) => c.trim().split("=")).filter((p) => p[0]));
}

async function readBody(req) {
  let data = "";
  for await (const chunk of req) data += chunk;
  return Object.fromEntries(new URLSearchParams(data));
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
      <button type="submit">${broken ? "Lưu lại" : "Save"}</button></form>`));
  }
  if (url.pathname === "/campaigns/new" && req.method === "POST") {
    const body = await readBody(req);
    campaigns.push({ name: body.name ?? "", objective: body.objective ?? "" });
    return send(res, 302, "", { location: "/campaigns" });
  }
  send(res, 404, layout("404", "<h1>Không tìm thấy</h1>"));
});

server.listen(PORT, "127.0.0.1", () => console.log(`Demo site: http://localhost:${PORT} (demo / demo123)`));
