import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface AppPaths {
  data: string;
  db: string;
  artifacts: string;
  /** Agent working folders; the content is rewritten every turn, so it may live outside the data folder. */
  workspaces: string;
  /** Upload fixtures, one folder per project; kept apart from artifacts so cleanup never touches them. */
  fixtures: string;
}

let current: AppPaths | null = null;

export function initPaths(dataDir: string): AppPaths {
  const p: AppPaths = {
    data: dataDir,
    db: join(dataDir, "e2e.sqlite"),
    artifacts: join(dataDir, "artifacts"),
    workspaces: pickWorkspacesDir(dataDir),
    fixtures: join(dataDir, "fixtures"),
  };
  for (const d of [p.data, p.artifacts, p.workspaces, p.fixtures]) mkdirSync(d, { recursive: true });
  current = p;
  return p;
}

/**
 * Cursor SDK keeps each local agent's SQLite store at
 * `<home>\.cursor\projects\<cwd slug>\sdk-agent-store\<md5>\agents\agent-<64 hex>\store.db`,
 * and SQLite on Windows cannot open a path of MAX_PATH (260) characters or more.
 */
const WIN_MAX_PATH = 259;
const CURSOR_STORE_OVERHEAD =
  "\\.cursor\\projects\\".length + "\\sdk-agent-store\\".length + 32 + "\\agents\\".length + "agent-".length + 64 + "\\store.db-journal".length;
/** Longest workspace folder name: `scr_` + 16 hex (`_integration_cursor` is shorter). */
const WORKSPACE_NAME_MAX = 20;

const cursorSlug = (path: string) => path.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");

export function cursorStorePathLength(workspacesDir: string, home = homedir()): number {
  return home.length + CURSOR_STORE_OVERHEAD + cursorSlug(workspacesDir).length + 1 + WORKSPACE_NAME_MAX;
}

export function pickWorkspacesDir(dataDir: string, platform = process.platform, env = process.env, home = homedir()): string {
  const inData = join(dataDir, "workspaces");
  if (platform !== "win32") return inData;
  const candidates = [inData, join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "E2E-AI-Trainer", "ws")];
  return candidates.find((d) => cursorStorePathLength(d, home) <= WIN_MAX_PATH) ?? candidates[candidates.length - 1];
}

export function paths(): AppPaths {
  if (!current) throw new Error("paths not initialized");
  return current;
}

export function artifactDir(kind: "attempts" | "trials" | "runs" | "recordings", id: string): string {
  const dir = join(paths().artifacts, kind, id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Artifact references are stored relative to the artifacts root. */
export function toArtifactRef(abs: string): string {
  return relative(paths().artifacts, abs).split(sep).join("/");
}

export function fromArtifactRef(ref: string): string {
  const abs = resolve(paths().artifacts, ref);
  const rel = relative(paths().artifacts, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Artifact path nằm ngoài thư mục artifacts");
  return abs;
}
