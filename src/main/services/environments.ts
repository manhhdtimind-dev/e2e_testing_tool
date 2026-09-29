import { readFileSync, existsSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { AuthCheck, BrowserProfile, Environment } from "../../shared/types";
import { authCheckConfigured } from "../../core/authCheck";
import { normalizeDomains } from "../../core/domains";
import type { AppContext } from "../context";
import { AppError, newId, now } from "../util";
import { secretKeys } from "./secrets";

export interface EnvironmentInput {
  environment_id?: string;
  name: string;
  base_url: string;
  allowed_domains: string[];
  auth_check: AuthCheck;
  secret_fields: string[];
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
  const env: Environment = {
    environment_id: existing?.environment_id ?? newId("env"),
    name: input.name.trim(),
    base_url: input.base_url.trim(),
    allowed_domains: normalizeDomains(input.base_url, input.allowed_domains),
    auth_check: {
      check_url: input.auth_check.check_url.trim(),
      rules: input.auth_check.rules.filter((r) => r.value.trim()).map((r) => ({ type: r.type, value: r.value.trim() })),
    },
    runner_auth_ref: existing?.runner_auth_ref ?? null,
    runner_auth_updated_at: existing?.runner_auth_updated_at ?? null,
    secret_fields: [...new Set(input.secret_fields.map((s) => s.trim()).filter(Boolean))],
    created_at: existing?.created_at ?? ts,
    updated_at: ts,
  };
  if (existing) ctx.repo.environments.update([env.environment_id], env);
  else ctx.repo.environments.insert(env);
  ctx.repo.audit(existing ? "environment.update" : "environment.create", "environment", env.environment_id, {
    base_url: env.base_url,
    allowed_domains: env.allowed_domains,
    auth_check: env.auth_check,
  });
  return env;
}

export function requireAuthCheck(env: Environment) {
  if (!authCheckConfigured(env.auth_check)) {
    throw new AppError(`Environment "${env.name}" chưa cấu hình phép kiểm tra đăng nhập (auth_check)`);
  }
}

export function setEnvironmentSecret(ctx: AppContext, envId: string, field: string, value: string) {
  const env = getEnvironment(ctx, envId);
  if (!env.secret_fields.includes(field)) throw new AppError(`"${field}" không nằm trong danh sách secret của environment`);
  if (value) ctx.secrets.set(secretKeys.envSecret(envId, field), value);
  else ctx.secrets.delete(secretKeys.envSecret(envId, field));
  ctx.repo.audit("environment.secret.set", "environment", envId, { field, cleared: !value });
}

export function environmentSecretStatus(ctx: AppContext, envId: string): Record<string, boolean> {
  const env = getEnvironment(ctx, envId);
  return Object.fromEntries(env.secret_fields.map((f) => [f, ctx.secrets.has(secretKeys.envSecret(envId, f))]));
}

/** Real secret values for a run; never persisted outside the secret store. */
export function environmentSecrets(ctx: AppContext, envId: string): Record<string, string> {
  const env = getEnvironment(ctx, envId);
  const out: Record<string, string> = {};
  for (const f of env.secret_fields) {
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
    if (input.extension_token) ctx.secrets.set(secretKeys.profileToken(record.browser_profile_id), input.extension_token);
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
