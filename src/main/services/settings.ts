import type { Settings } from "../../shared/types";
import type { Repo } from "../db/repo";
import { secretKeys, type SecretStore } from "./secrets";

type StoredSettings = Omit<Settings, "has_openai_key" | "has_cursor_key">;

export const DEFAULT_SETTINGS: StoredSettings = {
  codex_model: "",
  cursor_model: "composer-2.5",
  training_timeout_min: 15,
  training_max_actions: 80,
  training_max_repairs: 2,
  run_timeout_sec: 180,
  max_concurrent_runs: 2,
  runner_browser: "chrome",
  runner_headless: true,
  runner_fs_restricted: true,
  artifact_retention_days: 30,
};

export function getSettings(repo: Repo, secrets: SecretStore): Settings {
  const stored = repo.getSetting<Partial<StoredSettings>>("app") ?? {};
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    has_openai_key: secrets.has(secretKeys.openaiKey),
    has_cursor_key: secrets.has(secretKeys.cursorKey),
  };
}

export function updateSettings(repo: Repo, secrets: SecretStore, patch: Partial<StoredSettings>): Settings {
  const current = getSettings(repo, secrets);
  const next: StoredSettings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof StoredSettings)[]) {
    (next as Record<string, unknown>)[key] = key in patch ? patch[key] : current[key];
  }
  next.training_timeout_min = clamp(next.training_timeout_min, 1, 120);
  next.training_max_actions = clamp(next.training_max_actions, 5, 500);
  next.training_max_repairs = clamp(next.training_max_repairs, 0, 5);
  next.run_timeout_sec = clamp(next.run_timeout_sec, 10, 3600);
  next.max_concurrent_runs = clamp(next.max_concurrent_runs, 1, 8);
  next.artifact_retention_days = clamp(next.artifact_retention_days, 1, 3650);
  repo.setSetting("app", next);
  return getSettings(repo, secrets);
}

function clamp(v: number, min: number, max: number): number {
  const n = Number(v);
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}
