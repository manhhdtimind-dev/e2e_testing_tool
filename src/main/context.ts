import type { Repo } from "./db/repo";
import type { SecretStore } from "./services/secrets";
import type { Settings } from "../shared/types";
import { getSettings } from "./services/settings";

export type AppEventType = "training:event" | "training:attempt" | "trial:update" | "run:update" | "auth:session";

export interface AppContext {
  repo: Repo;
  secrets: SecretStore;
  emit(type: AppEventType, payload: unknown): void;
  settings(): Settings;
}

export function createContext(repo: Repo, secrets: SecretStore, emit: AppContext["emit"]): AppContext {
  return { repo, secrets, emit, settings: () => getSettings(repo, secrets) };
}
