import type { Db } from "../db/database";
import { now } from "../util";

export interface Encryptor {
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
}

/**
 * Secrets (API keys, extension tokens, runner storage state, environment secret values)
 * live only in this table, encrypted with the OS keychain via Electron safeStorage.
 */
export class SecretStore {
  constructor(
    private db: Db,
    private enc: Encryptor,
  ) {}

  set(key: string, value: string) {
    const encrypted = this.enc.available();
    const stored = encrypted ? this.enc.encrypt(value).toString("base64") : Buffer.from(value, "utf8").toString("base64");
    this.db.run(
      "INSERT INTO secrets (key, value, encrypted, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, encrypted = excluded.encrypted, updated_at = excluded.updated_at",
      key,
      stored,
      encrypted ? 1 : 0,
      now(),
    );
  }

  get(key: string): string | null {
    const row = this.db.get<{ value: string; encrypted: number }>("SELECT value, encrypted FROM secrets WHERE key = ?", key);
    if (!row) return null;
    const buf = Buffer.from(row.value, "base64");
    if (!row.encrypted) return buf.toString("utf8");
    try {
      return this.enc.decrypt(buf);
    } catch {
      throw new Error(
        `Không giải mã được secret "${key}" — dữ liệu được mã hoá bởi tài khoản Windows hoặc máy khác. Hãy nhập lại giá trị này (API key ở Cài đặt; secret, runner auth, extension token ở Environment).`,
      );
    }
  }

  has(key: string): boolean {
    return !!this.db.get("SELECT 1 FROM secrets WHERE key = ?", key);
  }

  delete(key: string) {
    this.db.run("DELETE FROM secrets WHERE key = ?", key);
  }

  keysWithPrefix(prefix: string): string[] {
    return this.db.all<{ key: string }>("SELECT key FROM secrets WHERE key LIKE ?", `${prefix}%`).map((r) => r.key);
  }
}

export const secretKeys = {
  openaiKey: "api_key:openai",
  cursorKey: "api_key:cursor",
  profileToken: (profileId: string) => `profile_token:${profileId}`,
  runnerAuth: (envId: string) => `runner_auth:${envId}`,
  envSecret: (envId: string, field: string) => `env_secret:${envId}:${field}`,
};
