import { mkdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface AppPaths {
  data: string;
  db: string;
  artifacts: string;
  workspaces: string;
}

let current: AppPaths | null = null;

export function initPaths(dataDir: string): AppPaths {
  const p: AppPaths = {
    data: dataDir,
    db: join(dataDir, "e2e.sqlite"),
    artifacts: join(dataDir, "artifacts"),
    workspaces: join(dataDir, "workspaces"),
  };
  for (const d of [p.data, p.artifacts, p.workspaces]) mkdirSync(d, { recursive: true });
  current = p;
  return p;
}

export function paths(): AppPaths {
  if (!current) throw new Error("paths not initialized");
  return current;
}

export function artifactDir(kind: "attempts" | "trials" | "runs", id: string): string {
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
