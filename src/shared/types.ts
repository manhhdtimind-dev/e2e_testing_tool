export type AgentProvider = "codex" | "cursor";

export type FieldType = "string" | "number" | "boolean";

export interface InputField {
  name: string;
  type: FieldType;
  required: boolean;
  secret: boolean;
}

export interface InputSchema {
  fields: InputField[];
}

export type InputValues = Record<string, string>;

export interface Project {
  project_id: string;
  name: string;
  created_at: string;
}

/** Either an existing project or a name for a project to create. */
export type ProjectTarget = { project_id: string } | { new_name: string };

export interface TestCase {
  test_id: string;
  project_id: string | null;
  /** Test case group; for Excel imports this is the sheet name. Empty = ungrouped. */
  group_name: string;
  title: string;
  steps: string[];
  input_schema: InputSchema;
  sample_input: InputValues;
  expected_result: string;
  raw_import: Record<string, unknown> | null;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Environment {
  environment_id: string;
  name: string;
  base_url: string;
  allowed_domains: string[];
  runner_auth_ref: string | null;
  runner_auth_updated_at: string | null;
  secret_fields: string[];
  created_at: string;
  updated_at: string;
}

export interface BrowserProfile {
  browser_profile_id: string;
  display_name: string;
  profile_dir_name: string;
  browser: "chrome" | "msedge";
  machine_id: string;
  has_extension_token: boolean;
  created_at: string;
}

export interface Script {
  script_id: string;
  test_id: string;
  active_agent: AgentProvider;
  training_thread_id: string | null;
  created_at: string;
}

export type ThreadStatus = "ACTIVE" | "SUPERSEDED" | "BROKEN";

export interface ProviderThread {
  id: string;
  provider: AgentProvider;
  provider_thread_id: string | null;
  script_id: string;
  created_at: string;
  supersedes_thread_id: string | null;
  status: ThreadStatus;
}

export type AttemptStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "AUTH_REQUIRED";
export type AttemptKind = "initial" | "revise" | "from_test_run" | "switch_agent" | "retrain";

export interface TrainingAttempt {
  attempt_id: string;
  script_id: string;
  thread_id: string | null;
  agent: AgentProvider;
  browser_profile_id: string;
  environment_id: string;
  kind: AttemptKind;
  prompt: string;
  context_ref: string | null;
  sample_input: InputValues;
  status: AttemptStatus;
  preflight_status: PreflightStatus | null;
  error: string | null;
  candidate_id: string | null;
  action_count: number;
  artifacts: AttemptArtifacts;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface AttemptArtifacts {
  events?: string;
  action_log?: string;
  final_screenshot?: string;
  final_message?: string;
}

export type CandidateStatus = "DRAFT" | "APPROVED" | "REJECTED";

export interface CandidateRevision {
  candidate_id: string;
  script_id: string;
  revision_no: number;
  source: string;
  source_hash: string;
  action_log_ref: string | null;
  provider_thread_id: string | null;
  attempt_id: string | null;
  status: CandidateStatus;
  reviewed_at: string | null;
  created_at: string;
}

export type TrialStatus = "QUEUED" | "RUNNING" | "PASSED" | "FAILED" | "AUTH_REQUIRED";

export type ExecutionErrorCode =
  | "LOCATOR"
  | "ACTION"
  | "TIMEOUT"
  | "AUTH_REQUIRED"
  | "DOMAIN_BLOCKED"
  | "INPUT_INVALID"
  | "SCRIPT_INVALID"
  | "EXCEPTION";

export interface Evidence {
  /** Last screenshot taken by the script (older runs: taken by the runner). */
  screenshot?: string;
  /** Every screenshot the script took, in order. */
  screenshots?: string[];
  trace?: string;
  steps?: string;
  log?: string;
}

export interface TrialRun {
  trial_id: string;
  candidate_id: string;
  source_hash: string;
  environment_id: string;
  input_snapshot: InputValues;
  status: TrialStatus;
  error_code: ExecutionErrorCode | null;
  error_message: string | null;
  evidence_refs: Evidence;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export type VersionStatus = "APPROVED" | "SUSPECTED_BROKEN" | "RETIRED";

export interface ScriptVersion {
  script_id: string;
  version_no: number;
  candidate_id: string;
  source_hash: string;
  source: string;
  /** Latest PASSED trial of this exact source in this environment, if any; accepting does not require one. */
  trial_id: string | null;
  environment_id: string;
  status: VersionStatus;
  approved_at: string;
  approved_by: string;
}

export type ExecutionStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "ERROR";
export type ReviewResult = "PENDING" | "PASS" | "FAIL";

export interface TestRun {
  run_id: string;
  test_id: string;
  script_id: string;
  version_no: number;
  environment_id: string;
  input_snapshot: InputValues;
  execution_status: ExecutionStatus;
  error_code: ExecutionErrorCode | null;
  error_message: string | null;
  review_result: ReviewResult | null;
  review_note: string | null;
  reviewed_at: string | null;
  evidence_refs: Evidence;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface AuditEntry {
  id: number;
  at: string;
  action: string;
  entity: string;
  entity_id: string | null;
  details: Record<string, unknown>;
}

export type PreflightStatus = "CONNECTED" | "AUTH_REQUIRED" | "PROFILE_UNAVAILABLE";

export interface PreflightResult {
  status: Exclude<PreflightStatus, "AUTH_REQUIRED">;
  message: string;
  url?: string;
}

export interface StepLog {
  index: number;
  action: string;
  target: string;
  args: string[];
  started_at: string;
  duration_ms: number;
  ok: boolean;
  error?: string;
}

export interface RunnerResult {
  ok: boolean;
  error_code: ExecutionErrorCode | null;
  error_message: string | null;
  steps: StepLog[];
  /** Screenshots taken by the script itself; the runner never captures on its own. */
  screenshots: string[];
  trace: string | null;
  duration_ms: number;
  final_url: string | null;
}

export interface TrainingEvent {
  ts: string;
  kind: "status" | "message" | "tool_call" | "tool_result" | "file_change" | "command" | "error" | "thinking";
  text?: string;
  tool?: string;
  server?: string;
  call_id?: string;
  args?: unknown;
  result?: unknown;
  ok?: boolean;
}

export interface Settings {
  codex_model: string;
  cursor_model: string;
  training_timeout_min: number;
  training_max_actions: number;
  training_max_repairs: number;
  run_timeout_sec: number;
  max_concurrent_runs: number;
  runner_browser: "chrome" | "chromium" | "msedge";
  runner_headless: boolean;
  runner_keep_open: boolean;
  /** Delay before each browser action in headed runs so a person can follow along (0 = full speed). */
  runner_slow_mo_ms: number;
  runner_fs_restricted: boolean;
  artifact_retention_days: number;
  has_openai_key: boolean;
  has_cursor_key: boolean;
}

export interface ValidationIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  line?: number;
}

export interface ScriptValidation {
  ok: boolean;
  issues: ValidationIssue[];
  used_fields: string[];
}

export interface ImportIssue {
  /** Excel sheet the issue belongs to (absent for CSV/YAML). */
  sheet?: string;
  row: number;
  column: string;
  message: string;
}

export interface ParsedTestCase {
  /** Excel sheet the case came from (absent for CSV/YAML). */
  sheet?: string;
  row: number;
  group: string;
  test_id: string;
  title: string;
  steps: string[];
  input: InputValues;
  input_schema: InputSchema;
  expected_result: string;
  raw: Record<string, unknown>;
}

export interface ImportPreview {
  file_name: string;
  cases: ParsedTestCase[];
  issues: ImportIssue[];
  /** Sheets ignored because they have no test_id column or no rows. */
  skipped_sheets?: string[];
}
