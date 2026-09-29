import type { Db, Row } from "./database";
import type {
  BrowserProfile,
  CandidateRevision,
  Environment,
  ProviderThread,
  Script,
  ScriptVersion,
  TestCase,
  TestRun,
  TrainingAttempt,
  TrialRun,
  AuditEntry,
} from "../../shared/types";

interface TableSpec {
  name: string;
  pk: string[];
  json: string[];
  bool?: string[];
}

const TABLES = {
  test_cases: { name: "test_cases", pk: ["test_id"], json: ["steps", "input_schema", "sample_input", "raw_import"] },
  environments: { name: "environments", pk: ["environment_id"], json: ["allowed_domains", "auth_check", "secret_fields"] },
  browser_profiles: { name: "browser_profiles", pk: ["browser_profile_id"], json: [] },
  scripts: { name: "scripts", pk: ["script_id"], json: [] },
  provider_threads: { name: "provider_threads", pk: ["id"], json: [] },
  training_attempts: { name: "training_attempts", pk: ["attempt_id"], json: ["sample_input", "artifacts"] },
  candidates: { name: "candidates", pk: ["candidate_id"], json: [] },
  trials: { name: "trials", pk: ["trial_id"], json: ["input_snapshot", "evidence_refs"] },
  versions: { name: "versions", pk: ["script_id", "version_no"], json: [] },
  test_runs: { name: "test_runs", pk: ["run_id"], json: ["input_snapshot", "evidence_refs"] },
} satisfies Record<string, TableSpec>;

type TableName = keyof typeof TABLES;

function decode<T>(spec: TableSpec, row: Row | undefined): T | undefined {
  if (!row) return undefined;
  const out: Row = { ...row };
  for (const c of spec.json) {
    if (typeof out[c] === "string") out[c] = JSON.parse(out[c] as string);
  }
  return out as T;
}

function encodeValue(spec: TableSpec, key: string, value: unknown): unknown {
  if (spec.json.includes(key)) return value === null || value === undefined ? null : JSON.stringify(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  return value ?? null;
}

class Table<T extends object> {
  constructor(
    private db: Db,
    private spec: TableSpec,
    private columns: string[],
  ) {}

  insert(obj: T): T {
    const cols = this.columns.filter((c) => c in obj);
    const sql = `INSERT INTO ${this.spec.name} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`;
    this.db.run(sql, ...cols.map((c) => encodeValue(this.spec, c, (obj as Row)[c])));
    return obj;
  }

  update(pk: unknown[], patch: Partial<T>): void {
    const cols = Object.keys(patch).filter((c) => this.columns.includes(c) && !this.spec.pk.includes(c));
    if (cols.length === 0) return;
    const sql = `UPDATE ${this.spec.name} SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE ${this.spec.pk.map((k) => `${k} = ?`).join(" AND ")}`;
    this.db.run(sql, ...cols.map((c) => encodeValue(this.spec, c, (patch as Row)[c])), ...pk);
  }

  get(...pk: unknown[]): T | undefined {
    return decode<T>(this.spec, this.db.get(`SELECT * FROM ${this.spec.name} WHERE ${this.spec.pk.map((k) => `${k} = ?`).join(" AND ")}`, ...pk));
  }

  where(clause = "1=1", ...params: unknown[]): T[] {
    return this.db.all(`SELECT * FROM ${this.spec.name} WHERE ${clause}`, ...params).map((r) => decode<T>(this.spec, r)!);
  }

  delete(...pk: unknown[]) {
    this.db.run(`DELETE FROM ${this.spec.name} WHERE ${this.spec.pk.map((k) => `${k} = ?`).join(" AND ")}`, ...pk);
  }
}

function columnsOf(db: Db, table: string): string[] {
  return db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((r) => r.name);
}

export class Repo {
  readonly testCases: Table<TestCase>;
  readonly environments: Table<Omit<Environment, never>>;
  readonly profiles: Table<Omit<BrowserProfile, "has_extension_token">>;
  readonly scripts: Table<Script>;
  readonly threads: Table<ProviderThread>;
  readonly attempts: Table<TrainingAttempt>;
  readonly candidates: Table<CandidateRevision>;
  readonly trials: Table<TrialRun>;
  readonly versions: Table<ScriptVersion>;
  readonly testRuns: Table<TestRun>;

  constructor(readonly db: Db) {
    const make = <T extends object>(t: TableName) => new Table<T>(db, TABLES[t], columnsOf(db, TABLES[t].name));
    this.testCases = make("test_cases");
    this.environments = make("environments");
    this.profiles = make("browser_profiles");
    this.scripts = make("scripts");
    this.threads = make("provider_threads");
    this.attempts = make("training_attempts");
    this.candidates = make("candidates");
    this.trials = make("trials");
    this.versions = make("versions");
    this.testRuns = make("test_runs");
  }

  audit(action: string, entity: string, entityId: string | null, details: Record<string, unknown> = {}) {
    this.db.run(
      "INSERT INTO audit_log (at, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?)",
      new Date().toISOString(),
      action,
      entity,
      entityId,
      JSON.stringify(details),
    );
  }

  listAudit(limit = 500): AuditEntry[] {
    return this.db
      .all<Row>("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", limit)
      .map((r) => ({ ...(r as unknown as AuditEntry), details: JSON.parse(r.details as string) }));
  }

  getSetting<T>(key: string): T | undefined {
    const row = this.db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key);
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  setSetting(key: string, value: unknown) {
    this.db.run(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      JSON.stringify(value),
    );
  }
}
