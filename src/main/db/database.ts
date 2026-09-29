import { DatabaseSync } from "node:sqlite";

export const MIGRATIONS: string[] = [
  `
  CREATE TABLE test_cases (
    test_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    steps TEXT NOT NULL,
    input_schema TEXT NOT NULL,
    sample_input TEXT NOT NULL,
    expected_result TEXT NOT NULL,
    raw_import TEXT,
    confirmed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE environments (
    environment_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    allowed_domains TEXT NOT NULL,
    auth_check TEXT NOT NULL,
    runner_auth_ref TEXT,
    runner_auth_updated_at TEXT,
    secret_fields TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE browser_profiles (
    browser_profile_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    profile_dir_name TEXT NOT NULL,
    browser TEXT NOT NULL,
    machine_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE scripts (
    script_id TEXT PRIMARY KEY,
    test_id TEXT NOT NULL UNIQUE REFERENCES test_cases(test_id),
    active_agent TEXT NOT NULL,
    training_thread_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE provider_threads (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    provider_thread_id TEXT,
    script_id TEXT NOT NULL REFERENCES scripts(script_id),
    created_at TEXT NOT NULL,
    supersedes_thread_id TEXT,
    status TEXT NOT NULL
  );
  CREATE TABLE training_attempts (
    attempt_id TEXT PRIMARY KEY,
    script_id TEXT NOT NULL REFERENCES scripts(script_id),
    thread_id TEXT,
    agent TEXT NOT NULL,
    browser_profile_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    prompt TEXT NOT NULL,
    context_ref TEXT,
    sample_input TEXT NOT NULL,
    status TEXT NOT NULL,
    preflight_status TEXT,
    error TEXT,
    candidate_id TEXT,
    action_count INTEGER NOT NULL DEFAULT 0,
    artifacts TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  );
  CREATE TABLE candidates (
    candidate_id TEXT PRIMARY KEY,
    script_id TEXT NOT NULL REFERENCES scripts(script_id),
    revision_no INTEGER NOT NULL,
    source TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    action_log_ref TEXT,
    provider_thread_id TEXT,
    attempt_id TEXT,
    status TEXT NOT NULL,
    reviewed_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (script_id, revision_no)
  );
  CREATE TRIGGER candidates_immutable BEFORE UPDATE OF source, source_hash, revision_no, script_id ON candidates
  BEGIN SELECT RAISE(ABORT, 'candidate revision is immutable'); END;
  CREATE TABLE trials (
    trial_id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL REFERENCES candidates(candidate_id),
    source_hash TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    input_snapshot TEXT NOT NULL,
    status TEXT NOT NULL,
    error_code TEXT,
    error_message TEXT,
    evidence_refs TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  );
  CREATE TABLE versions (
    script_id TEXT NOT NULL REFERENCES scripts(script_id),
    version_no INTEGER NOT NULL,
    candidate_id TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    source TEXT NOT NULL,
    trial_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    status TEXT NOT NULL,
    approved_at TEXT NOT NULL,
    approved_by TEXT NOT NULL,
    PRIMARY KEY (script_id, version_no)
  );
  CREATE TRIGGER versions_immutable BEFORE UPDATE OF source, source_hash, candidate_id, version_no, script_id ON versions
  BEGIN SELECT RAISE(ABORT, 'script version is immutable'); END;
  CREATE TABLE test_runs (
    run_id TEXT PRIMARY KEY,
    test_id TEXT NOT NULL,
    script_id TEXT NOT NULL,
    version_no INTEGER NOT NULL,
    environment_id TEXT NOT NULL,
    input_snapshot TEXT NOT NULL,
    execution_status TEXT NOT NULL,
    error_code TEXT,
    error_message TEXT,
    review_result TEXT,
    review_note TEXT,
    reviewed_at TEXT,
    evidence_refs TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  );
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id TEXT,
    details TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL, encrypted INTEGER NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX idx_attempts_script ON training_attempts(script_id, created_at);
  CREATE INDEX idx_candidates_script ON candidates(script_id, revision_no);
  CREATE INDEX idx_trials_candidate ON trials(candidate_id);
  CREATE INDEX idx_runs_test ON test_runs(test_id, created_at);
  `,
  `ALTER TABLE environments DROP COLUMN auth_check;`,
  `
  DROP TRIGGER versions_immutable;
  CREATE TABLE versions_new (
    script_id TEXT NOT NULL REFERENCES scripts(script_id),
    version_no INTEGER NOT NULL,
    candidate_id TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    source TEXT NOT NULL,
    trial_id TEXT,
    environment_id TEXT NOT NULL,
    status TEXT NOT NULL,
    approved_at TEXT NOT NULL,
    approved_by TEXT NOT NULL,
    PRIMARY KEY (script_id, version_no)
  );
  INSERT INTO versions_new SELECT script_id, version_no, candidate_id, source_hash, source, trial_id, environment_id, status, approved_at, approved_by FROM versions;
  DROP TABLE versions;
  ALTER TABLE versions_new RENAME TO versions;
  CREATE TRIGGER versions_immutable BEFORE UPDATE OF source, source_hash, candidate_id, version_no, script_id ON versions
  BEGIN SELECT RAISE(ABORT, 'script version is immutable'); END;
  `,
];

export type Row = Record<string, unknown>;

export class Db {
  readonly raw: DatabaseSync;

  constructor(file: string) {
    this.raw = new DatabaseSync(file);
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate() {
    const current = Number((this.raw.prepare("PRAGMA user_version").get() as Row).user_version ?? 0);
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.raw.exec("BEGIN");
      try {
        this.raw.exec(MIGRATIONS[v]);
        this.raw.exec(`PRAGMA user_version = ${v + 1}`);
        this.raw.exec("COMMIT");
      } catch (e) {
        this.raw.exec("ROLLBACK");
        throw e;
      }
    }
  }

  all<T = Row>(sql: string, ...params: unknown[]): T[] {
    return this.raw.prepare(sql).all(...(params as never[])) as T[];
  }

  get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
    return this.raw.prepare(sql).get(...(params as never[])) as T | undefined;
  }

  run(sql: string, ...params: unknown[]) {
    return this.raw.prepare(sql).run(...(params as never[]));
  }

  tx<T>(fn: () => T): T {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.raw.exec("COMMIT");
      return out;
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    }
  }

  close() {
    this.raw.close();
  }
}
