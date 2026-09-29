import { app, BrowserWindow, ipcMain, net, protocol, safeStorage, session } from "electron";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Db } from "./db/database";
import { Repo } from "./db/repo";
import { SecretStore } from "./services/secrets";
import { createContext } from "./context";
import { fromArtifactRef, initPaths } from "./paths";
import { createApi, type Api } from "./api";
import { cleanupArtifacts } from "./services/history";

const here = dirname(fileURLToPath(import.meta.url));
const devUrl = process.env.E2E_RENDERER_URL;
let mainWindow: BrowserWindow | null = null;

protocol.registerSchemesAsPrivileged([{ scheme: "artifact", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: "E2E AI Trainer",
    backgroundColor: "#0f1115",
    webPreferences: {
      preload: join(here, "..", "preload", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (e, url) => {
    if (!devUrl || !url.startsWith(devUrl)) e.preventDefault();
  });
  if (devUrl) void mainWindow.loadURL(devUrl);
  else void mainWindow.loadFile(join(here, "..", "renderer", "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  const dataDir = process.env.E2E_DATA_DIR ?? join(app.getPath("userData"), "data");
  const p = initPaths(dataDir);
  const db = new Db(p.db);
  const repo = new Repo(db);
  const secrets = new SecretStore(db, {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (s) => safeStorage.encryptString(s),
    decrypt: (b) => safeStorage.decryptString(b),
  });
  const ctx = createContext(repo, secrets, (type, payload) => mainWindow?.webContents.send("app-event", { type, payload }));
  const api = createApi(ctx, () => mainWindow);

  protocol.handle("artifact", (req) => {
    const url = new URL(req.url);
    const ref = decodeURIComponent(url.pathname.replace(/^\//, ""));
    try {
      const abs = fromArtifactRef(ref);
      if (!existsSync(abs)) return new Response("not found", { status: 404 });
      return net.fetch(pathToFileURL(abs).toString());
    } catch {
      return new Response("forbidden", { status: 403 });
    }
  });

  if (!devUrl) {
    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      cb({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": ["default-src 'self'; img-src 'self' artifact: data:; style-src 'self' 'unsafe-inline'; script-src 'self'"],
        },
      });
    });
  }

  ipcMain.handle("api", async (_e, method: keyof Api, args: unknown[]) => {
    const fn = api[method] as ((...a: unknown[]) => unknown) | undefined;
    if (typeof fn !== "function") return { ok: false, error: `Unknown method ${String(method)}` };
    try {
      return { ok: true, data: await fn(...args) };
    } catch (e) {
      return { ok: false, error: (e as Error).message ?? String(e) };
    }
  });

  // Attempts/runs that were in flight when the app closed cannot resume.
  for (const table of ["training_attempts", "trials"]) {
    db.run(`UPDATE ${table} SET status = 'FAILED', error${table === "trials" ? "_message" : ""} = 'Ứng dụng đã đóng khi đang chạy', finished_at = ? WHERE status IN ('QUEUED','RUNNING')`, new Date().toISOString());
  }
  db.run(
    "UPDATE test_runs SET execution_status = 'ERROR', error_code = 'EXCEPTION', error_message = 'Ứng dụng đã đóng khi đang chạy', finished_at = ? WHERE execution_status IN ('QUEUED','RUNNING')",
    new Date().toISOString(),
  );
  try {
    cleanupArtifacts(ctx);
  } catch (e) {
    console.error("artifact cleanup failed", e);
  }

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
