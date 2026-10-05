import { readFileSync, existsSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { BrowserProfile, Environment } from "../../shared/types";
import { normalizeDomains } from "../../core/domains";
import { normalizeExtensionToken } from "../../core/extensionToken";
import type { AppContext } from "../context";
import { AppError, newId, now } from "../util";
import { secretKeys } from "./secrets";

export interface EnvironmentInput {
  environment_id?: string;
  name: string;
  base_url: string;
  /** Omitted by the UI: the base URL host plus extra domains saved earlier. */
  allowed_domains?: string[];
  /** Omitted by the UI: the existing list is kept. */
  secret_fields?: string[];
}

export function listEnvironments(ctx: AppContext): Environment[] {
  return ctx.repo.environments.where("1=1 ORDER BY name");
}

export function getEnvironment(ctx: AppContext, id: string): Environment {
  const env = ctx.repo.environments.get(id);
  if (!env) throw new AppError(`Không tìm thấy environment ${id}`);
  return env;
}

export function saveEnvironment(ctx: AppContext, input: EnvironmentInput): Environment {
  let url: URL;
  try {
    url = new URL(input.base_url);
  } catch {
    throw new AppError("base_url không hợp lệ");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new AppError("base_url phải là http(s)");
  if (!input.name.trim()) throw new AppError("Thiếu tên environment");
  const ts = now();
  const existing = input.environment_id ? ctx.repo.environments.get(input.environment_id) : undefined;
  const oldHost = existing ? new URL(existing.base_url).hostname.toLowerCase() : null;
  const extraDomains = input.allowed_domains ?? (existing?.allowed_domains ?? []).filter((d) => d !== oldHost);
  const env: Environment = {
    environment_id: existing?.environment_id ?? newId("env"),
    name: input.name.trim(),
    base_url: input.base_url.trim(),
    allowed_domains: normalizeDomains(input.base_url, extraDomains),
    runner_auth_ref: existing?.runner_auth_ref ?? null,
    runner_auth_updated_at: existing?.runner_auth_updated_at ?? null,
    secret_fields: [...new Set((input.secret_fields ?? existing?.secret_fields ?? []).map((s) => s.trim()).filter(Boolean))],
    created_at: existing?.created_at ?? ts,
    updated_at: ts,
  };
  if (existing) ctx.repo.environments.update([env.environment_id], env);
  else ctx.repo.environments.insert(env);
  ctx.repo.audit(existing ? "environment.update" : "environment.create", "environment", env.environment_id, {
    base_url: env.base_url,
    allowed_domains: env.allowed_domains,
  });
  return env;
}

/** Variables marked Secret in any test case, plus names saved on the environment before that existed. */
export function environmentSecretFields(ctx: AppContext, env: Environment): string[] {
  const names = new Set(env.secret_fields);
  for (const tc of ctx.repo.testCases.where("1=1")) for (const f of tc.input_schema.fields) if (f.secret) names.add(f.name);
  return [...names].sort();
}

export function setEnvironmentSecret(ctx: AppContext, envId: string, field: string, value: string) {
  const env = getEnvironment(ctx, envId);
  if (!environmentSecretFields(ctx, env).includes(field)) throw new AppError(`"${field}" không phải biến secret của test case nào`);
  if (value) ctx.secrets.set(secretKeys.envSecret(envId, field), value);
  else ctx.secrets.delete(secretKeys.envSecret(envId, field));
  ctx.repo.audit("environment.secret.set", "environment", envId, { field, cleared: !value });
}

export function environmentSecretStatus(ctx: AppContext, envId: string): Record<string, boolean> {
  const env = getEnvironment(ctx, envId);
  return Object.fromEntries(environmentSecretFields(ctx, env).map((f) => [f, ctx.secrets.has(secretKeys.envSecret(envId, f))]));
}

/** Real secret values for a run; never persisted outside the secret store. */
export function environmentSecrets(ctx: AppContext, envId: string): Record<string, string> {
  const env = getEnvironment(ctx, envId);
  const out: Record<string, string> = {};
  for (const f of environmentSecretFields(ctx, env)) {
    const v = ctx.secrets.get(secretKeys.envSecret(envId, f));
    if (v) out[f] = v;
  }
  return out;
}

// ---------------- Browser profiles ----------------

export interface ProfileInput {
  browser_profile_id?: string;
  display_name: string;
  profile_dir_name: string;
  browser: "chrome" | "msedge";
  extension_token?: string | null;
}

function withToken(ctx: AppContext, p: Omit<BrowserProfile, "has_extension_token">): BrowserProfile {
  return { ...p, has_extension_token: ctx.secrets.has(secretKeys.profileToken(p.browser_profile_id)) };
}

export function listProfiles(ctx: AppContext): BrowserProfile[] {
  return ctx.repo.profiles.where("1=1 ORDER BY display_name").map((p) => withToken(ctx, p));
}

export function getProfile(ctx: AppContext, id: string): BrowserProfile {
  const p = ctx.repo.profiles.get(id);
  if (!p) throw new AppError(`Không tìm thấy browser profile ${id}`);
  return withToken(ctx, p);
}

export function saveProfile(ctx: AppContext, input: ProfileInput): BrowserProfile {
  if (!input.display_name.trim() || !input.profile_dir_name.trim()) throw new AppError("Cần nhãn hiển thị và profile_dir_name");
  const existing = input.browser_profile_id ? ctx.repo.profiles.get(input.browser_profile_id) : undefined;
  const clash = ctx.repo.profiles
    .where("profile_dir_name = ? AND browser = ?", input.profile_dir_name.trim(), input.browser)
    .find((p) => p.browser_profile_id !== existing?.browser_profile_id);
  if (clash) throw new AppError(`Profile dir "${input.profile_dir_name}" đã được đăng ký với nhãn "${clash.display_name}"`);
  const record = {
    browser_profile_id: existing?.browser_profile_id ?? newId("prof"),
    display_name: input.display_name.trim(),
    profile_dir_name: input.profile_dir_name.trim(),
    browser: input.browser,
    machine_id: hostname(),
    created_at: existing?.created_at ?? now(),
  };
  if (existing) ctx.repo.profiles.update([record.browser_profile_id], record);
  else ctx.repo.profiles.insert(record);
  if (input.extension_token !== undefined && input.extension_token !== null) {
    const token = normalizeExtensionToken(input.extension_token);
    if (token) ctx.secrets.set(secretKeys.profileToken(record.browser_profile_id), token);
    else ctx.secrets.delete(secretKeys.profileToken(record.browser_profile_id));
  }
  ctx.repo.audit(existing ? "profile.update" : "profile.create", "browser_profile", record.browser_profile_id, {
    display_name: record.display_name,
    profile_dir_name: record.profile_dir_name,
    browser: record.browser,
  });
  return withToken(ctx, record);
}

export function deleteProfile(ctx: AppContext, id: string) {
  ctx.repo.profiles.delete(id);
  ctx.secrets.delete(secretKeys.profileToken(id));
  ctx.repo.audit("profile.delete", "browser_profile", id);
}

export interface DetectedProfile {
  browser: "chrome" | "msedge";
  profile_dir_name: string;
  name: string;
}

export function detectLocalProfiles(): DetectedProfile[] {
  const base = process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? "", "AppData", "Local");
  const sources: { browser: "chrome" | "msedge"; dir: string }[] = [
    { browser: "chrome", dir: join(base, "Google", "Chrome", "User Data") },
    { browser: "msedge", dir: join(base, "Microsoft", "Edge", "User Data") },
  ];
  const out: DetectedProfile[] = [];
  for (const s of sources) {
    const file = join(s.dir, "Local State");
    if (!existsSync(file)) continue;
    try {
      const state = JSON.parse(readFileSync(file, "utf8"));
      const cache = state?.profile?.info_cache ?? {};
      for (const [dir, info] of Object.entries<Record<string, unknown>>(cache)) {
        out.push({ browser: s.browser, profile_dir_name: dir, name: String(info.name ?? dir) });
      }
    } catch {
      // unreadable Local State is not fatal
    }
  }
  return out;
}
