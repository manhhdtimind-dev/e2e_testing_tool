import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentProvider,
  AttemptKind,
  CandidateRevision,
  Environment,
  Evidence,
  InputValues,
  ProviderThread,
  RunnerResult,
  Script,
  ScriptValidation,
  TestCase,
  TrainingAttempt,
  TrainingEvent,
} from "../../shared/types";
import { validateInput } from "../../core/inputValidation";
import { validateScript } from "../../core/scriptValidator";
import { findProfileConflicts } from "../../core/profileConflict";
import type { AppContext } from "../context";
import { artifactDir, paths, toArtifactRef } from "../paths";
import { AppError, newId, now, sha256, truncate } from "../util";
import { environmentSecrets, getEnvironment, getProfile, listProfiles } from "../services/environments";
import { secretKeys } from "../services/secrets";
import { runPreflight } from "./preflight";
import { playwrightMcpServer } from "./mcpConfig";
import type { AgentAdapter, AgentTurnResult } from "./adapters/types";
import { ThreadUnavailableError } from "./adapters/types";
import { codexAdapter } from "./adapters/codex";
import { cursorAdapter } from "./adapters/cursor";
import {
  CANDIDATE_FILE,
  FILE_ACCESS_HINT,
  FIXTURES_DIR,
  bootstrapPrompt,
  fileInputsBlock,
  initialPrompt,
  isFileAccessDenied,
  parseVerdict,
  projectReferencesBlock,
  repairPrompt,
  revisePrompt,
  verifyFailPrompt,
  type RunContext,
} from "./prompt";
import { redactText } from "../../core/inputValidation";
import { writeProjectReferences } from "./projectContext";
import { verifyDraft, type VerifyRun } from "./draftVerify";
import { recordVerificationTrial, runVerification, verificationInput, type VerificationInput } from "../services/execution";
import { copyFixturesTo, resolveFileFields } from "../services/fixtures";

/** Extra agent turns allowed after the app's verification run of a draft fails. */
const VERIFY_FIX_ROUNDS = 2;

type VerificationData = { result: RunnerResult; evidence: Evidence; started_at: string; finished_at: string };

const adapters: Record<AgentProvider, AgentAdapter> = { codex: codexAdapter, cursor: cursorAdapter };

export interface StartTrainingRequest {
  test_id: string;
  environment_id: string;
  agent: AgentProvider;
  browser_profile_id: string;
  sample_input: InputValues;
  prompt: string;
  context_ref?: { type: "trial" | "test_run"; id: string } | null;
  /** Start over from the test case: new provider thread, previous candidates are not given to the agent. */
  fresh?: boolean;
}

const busyProfiles = new Set<string>();
const busyScripts = new Set<string>();
const controllers = new Map<string, AbortController>();

export const isScriptTraining = (scriptId: string) => busyScripts.has(scriptId);

export function trainingSchemaIssues(tc: TestCase, sample: InputValues): string[] {
  const schema = { fields: tc.input_schema.fields.filter((f) => !f.secret).map((f) => ({ ...f })) };
  const values = Object.fromEntries(Object.entries(sample).filter(([k]) => schema.fields.some((f) => f.name === k)));
  return validateInput(schema, values);
}

export function getOrCreateScript(ctx: AppContext, testId: string, agent: AgentProvider): Script {
  const existing = ctx.repo.scripts.where("test_id = ?", testId)[0];
  if (existing) return existing;
  const script: Script = { script_id: newId("scr"), test_id: testId, active_agent: agent, training_thread_id: null, created_at: now() };
  ctx.repo.scripts.insert(script);
  ctx.repo.audit("script.create", "script", script.script_id, { test_id: testId, agent });
  return script;
}

export function latestCandidate(ctx: AppContext, scriptId: string): CandidateRevision | undefined {
  return ctx.repo.candidates.where("script_id = ? ORDER BY revision_no DESC LIMIT 1", scriptId)[0];
}

export function startTraining(ctx: AppContext, req: StartTrainingRequest): TrainingAttempt {
  const tc = ctx.repo.testCases.get(req.test_id);
  if (!tc) throw new AppError(`Không tìm thấy test case ${req.test_id}`);
  if (!tc.confirmed_at) throw new AppError("Test case chưa được xác nhận");
  const env = getEnvironment(ctx, req.environment_id);
  const profile = getProfile(ctx, req.browser_profile_id);
  const conflicts = findProfileConflicts(req.prompt, listProfiles(ctx), profile.browser_profile_id);
  if (conflicts.length) {
    throw new AppError(
      `Prompt nhắc tới profile khác (${conflicts.map((c) => `"${c.display_name}"`).join(", ")}) trong khi UI đang chọn "${profile.display_name}". Hãy chọn profile trên giao diện; prompt không thể đổi profile.`,
    );
  }
  const inputIssues = trainingSchemaIssues(tc, req.sample_input);
  if (!inputIssues.length) inputIssues.push(...resolveFileFields(tc, req.sample_input).issues);
  if (inputIssues.length) throw new AppError(`Input mẫu không hợp lệ:\n${inputIssues.join("\n")}`);
  if (req.agent === "cursor" && !ctx.secrets.has(secretKeys.cursorKey)) throw new AppError("Chưa cấu hình Cursor API key (Cài đặt)");
  if (busyProfiles.has(profile.browser_profile_id)) throw new AppError(`Profile "${profile.display_name}" đang được dùng cho một lượt Training khác`);

  const script = getOrCreateScript(ctx, tc.test_id, req.agent);
  if (busyScripts.has(script.script_id)) throw new AppError("Script này đang có một lượt Training chạy");
  const hasHistory = ctx.repo.attempts.where("script_id = ?", script.script_id).length > 0 || !!latestCandidate(ctx, script.script_id);
  const activeThread = script.training_thread_id ? ctx.repo.threads.get(script.training_thread_id) : undefined;
  let kind: AttemptKind = hasHistory ? "revise" : "initial";
  if (req.context_ref?.type === "test_run") kind = "from_test_run";
  if (activeThread && activeThread.provider !== req.agent) kind = "switch_agent";
  if (req.fresh) kind = "retrain";
  const contextRef = kind === "retrain" ? null : req.context_ref;

  const attempt: TrainingAttempt = {
    attempt_id: newId("att"),
    script_id: script.script_id,
    thread_id: null,
    agent: req.agent,
    browser_profile_id: profile.browser_profile_id,
    environment_id: env.environment_id,
    kind,
    prompt: req.prompt,
    context_ref: contextRef ? `${contextRef.type}:${contextRef.id}` : null,
    sample_input: Object.fromEntries(Object.entries(req.sample_input).filter(([k]) => tc.input_schema.fields.some((f) => f.name === k && !f.secret))),
    status: "QUEUED",
    preflight_status: null,
    error: null,
    candidate_id: null,
    action_count: 0,
    artifacts: {},
    created_at: now(),
    started_at: null,
    finished_at: null,
  };
  ctx.repo.attempts.insert(attempt);
  ctx.repo.audit("training.prompt", "training_attempt", attempt.attempt_id, {
    script_id: script.script_id,
    agent: req.agent,
    profile: profile.display_name,
    profile_dir_name: profile.profile_dir_name,
    environment_id: env.environment_id,
    kind,
    prompt: req.prompt,
  });
  busyProfiles.add(profile.browser_profile_id);
  busyScripts.add(script.script_id);
  const controller = new AbortController();
  controllers.set(attempt.attempt_id, controller);
  ctx.emit("training:attempt", attempt);
  void executeAttempt(ctx, attempt, tc, env, controller).finally(() => {
    busyProfiles.delete(profile.browser_profile_id);
    busyScripts.delete(script.script_id);
    controllers.delete(attempt.attempt_id);
  });
  return attempt;
}

/** Stores hand-edited code as a new DRAFT revision; like any candidate it needs a PASSED trial before Approve. */
export function saveManualCandidate(ctx: AppContext, baseCandidateId: string, source: string, environmentId?: string): CandidateRevision {
  const base = ctx.repo.candidates.get(baseCandidateId);
  if (!base) throw new AppError("Không tìm thấy candidate");
  if (busyScripts.has(base.script_id)) throw new AppError("Script đang có lượt Training chạy; đợi xong hoặc huỷ trước khi lưu code sửa tay");
  const script = ctx.repo.scripts.get(base.script_id)!;
  const tc = ctx.repo.testCases.get(script.test_id);
  if (!tc) throw new AppError("Không tìm thấy test case của script");

  const text = source.replace(/\r\n/g, "\n");
  if (!text.trim()) throw new AppError("Script đang trống");
  const hash = sha256(text);
  if (hash === base.source_hash) throw new AppError(`Code chưa thay đổi so với candidate #${base.revision_no}`);

  const baseAttempt = base.attempt_id ? ctx.repo.attempts.get(base.attempt_id) : undefined;
  const validation = validateScript(text, {
    schema: tc.input_schema,
    sampleInput: baseAttempt?.sample_input ?? tc.sample_input,
    secretValues: environmentId ? Object.values(environmentSecrets(ctx, environmentId)) : [],
    steps: tc.steps,
  });
  const errors = validation.issues.filter((i) => i.severity === "error");
  if (errors.length) throw new AppError(`Code chưa đạt kiểm tra:\n${errors.map((i) => `${i.line ? `dòng ${i.line}: ` : ""}${i.message}`).join("\n")}`);

  const latest = latestCandidate(ctx, base.script_id)!;
  const candidate: CandidateRevision = {
    candidate_id: newId("cand"),
    script_id: base.script_id,
    revision_no: latest.revision_no + 1,
    source: text,
    source_hash: hash,
    action_log_ref: null,
    provider_thread_id: null,
    attempt_id: null,
    origin: "manual",
    status: "DRAFT",
    reviewed_at: now(),
    created_at: now(),
  };
  ctx.repo.candidates.insert(candidate);
  ctx.repo.audit("candidate.manual_edit", "candidate", candidate.candidate_id, {
    script_id: base.script_id,
    base_revision: base.revision_no,
    revision_no: candidate.revision_no,
    source_hash: hash,
    warnings: validation.issues.length - errors.length,
  });
  return candidate;
}

export function cancelTraining(ctx: AppContext, attemptId: string) {
  const c = controllers.get(attemptId);
  if (!c) throw new AppError("Lượt Training không còn chạy");
  c.abort("USER_CANCEL");
  ctx.repo.audit("training.cancel", "training_attempt", attemptId);
}

function updateAttempt(ctx: AppContext, attempt: TrainingAttempt, patch: Partial<TrainingAttempt>) {
  Object.assign(attempt, patch);
  ctx.repo.attempts.update([attempt.attempt_id], patch);
  ctx.emit("training:attempt", { ...attempt });
}

function newestImage(dir: string): string | null {
  if (!existsSync(dir)) return null;
  let best: { path: string; mtime: number } | null = null;
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        if (!(d === dir && name === FIXTURES_DIR)) walk(p);
      } else if (/\.(png|jpe?g)$/i.test(name) && (!best || st.mtimeMs > best.mtime)) best = { path: p, mtime: st.mtimeMs };
    }
  };
  walk(dir);
  return best ? (best as { path: string }).path : null;
}

function runContextFor(ctx: AppContext, ref: string | null, candidate: CandidateRevision | undefined): RunContext | null {
  if (ref?.startsWith("test_run:")) {
    const run = ctx.repo.testRuns.get(ref.slice("test_run:".length));
    if (run) {
      return {
        label: `Failed Testing run ${run.run_id} (approved version v${run.version_no})`,
        status: run.execution_status,
        error_code: run.error_code,
        error_message: run.error_message,
        steps: readSteps(run.evidence_refs.steps),
        input: run.input_snapshot,
      };
    }
  }
  const trialId = ref?.startsWith("trial:") ? ref.slice("trial:".length) : null;
  const trial = trialId
    ? ctx.repo.trials.get(trialId)
    : candidate
      ? ctx.repo.trials.where("candidate_id = ? AND status IN ('PASSED','FAILED','AUTH_REQUIRED') ORDER BY created_at DESC LIMIT 1", candidate.candidate_id)[0]
      : undefined;
  if (!trial) return null;
  return {
    label: `Latest trial run of candidate revision (trial ${trial.trial_id})`,
    status: trial.status,
    error_code: trial.error_code,
    error_message: trial.error_message,
    steps: readSteps(trial.evidence_refs.steps),
    input: trial.input_snapshot,
  };
}

function readSteps(ref: string | undefined) {
  if (!ref) return [];
  try {
    return JSON.parse(readFileSync(join(paths().artifacts, ref), "utf8"));
  } catch {
    return [];
  }
}

function createThread(ctx: AppContext, script: Script, provider: AgentProvider, supersedes: ProviderThread | undefined, reason: string): ProviderThread {
  const thread: ProviderThread = {
    id: newId("thr"),
    provider,
    provider_thread_id: null,
    script_id: script.script_id,
    created_at: now(),
    supersedes_thread_id: supersedes?.id ?? null,
    status: "ACTIVE",
  };
  ctx.repo.db.tx(() => {
    if (supersedes && supersedes.status === "ACTIVE") ctx.repo.threads.update([supersedes.id], { status: "SUPERSEDED" });
    ctx.repo.threads.insert(thread);
    ctx.repo.scripts.update([script.script_id], { training_thread_id: thread.id, active_agent: provider });
  });
  script.training_thread_id = thread.id;
  script.active_agent = provider;
  ctx.repo.audit("thread.create", "provider_thread", thread.id, { script_id: script.script_id, provider, supersedes: supersedes?.id ?? null, reason });
  return thread;
}

async function executeAttempt(ctx: AppContext, attempt: TrainingAttempt, tc: TestCase, env: Environment, controller: AbortController) {
  const settings = ctx.settings();
  const dir = artifactDir("attempts", attempt.attempt_id);
  const eventsPath = join(dir, "events.jsonl");
  const mcpOut = join(dir, "mcp-output");
  mkdirSync(mcpOut, { recursive: true });
  const secrets = Object.values(environmentSecrets(ctx, env.environment_id));
  const actionLog: TrainingEvent[] = [];
  let finalMessage = "";
  let fileAccessDenied = false;

  const emitEvent = (e: TrainingEvent) => {
    const clean: TrainingEvent = JSON.parse(redactText(JSON.stringify(e), secrets));
    if (typeof clean.result === "string") clean.result = truncate(clean.result, 20_000);
    appendFileSync(eventsPath, `${JSON.stringify(clean)}\n`);
    const isBrowserTool = (clean.kind === "tool_call" || clean.kind === "tool_result") && (clean.server === "playwright" || clean.tool?.startsWith("browser_"));
    if (isBrowserTool) actionLog.push(clean);
    if (clean.kind === "tool_call" && clean.tool?.startsWith("browser_")) {
      attempt.action_count++;
      if (attempt.action_count > settings.training_max_actions) controller.abort("ACTION_LIMIT");
    }
    ctx.emit("training:event", { attempt_id: attempt.attempt_id, event: { ...clean, result: typeof clean.result === "string" ? truncate(clean.result, 3000) : clean.result } });
    if (!fileAccessDenied && isFileAccessDenied(clean)) {
      fileAccessDenied = true;
      emitEvent({ ts: now(), kind: "error", text: FILE_ACCESS_HINT });
    }
  };

  const timeout = setTimeout(() => controller.abort("TIMEOUT"), settings.training_timeout_min * 60_000);
  const abortReason = () => {
    const r = String(controller.signal.reason ?? "");
    if (r === "TIMEOUT") return `Vượt quá thời gian cho phép (${settings.training_timeout_min} phút)`;
    if (r === "ACTION_LIMIT") return `Vượt quá số browser action cho phép (${settings.training_max_actions})`;
    if (r === "USER_CANCEL") return "Người dùng đã huỷ lượt Training";
    return r || "Đã huỷ";
  };

  try {
    updateAttempt(ctx, attempt, { status: "RUNNING", started_at: now() });
    const profile = getProfile(ctx, attempt.browser_profile_id);
    const token = ctx.secrets.get(secretKeys.profileToken(profile.browser_profile_id));

    emitEvent({ ts: now(), kind: "status", text: `Preflight profile "${profile.display_name}" (${profile.profile_dir_name})…` });
    const pre = await runPreflight(profile, env, token);
    emitEvent({ ts: now(), kind: "status", text: `Preflight: ${pre.status} — ${pre.message}` });
    ctx.repo.audit("training.preflight", "training_attempt", attempt.attempt_id, { status: pre.status, url: pre.url ?? null });
    if (pre.status !== "CONNECTED") {
      updateAttempt(ctx, attempt, {
        preflight_status: pre.status,
        status: "FAILED",
        error: pre.message,
      });
      return;
    }
    updateAttempt(ctx, attempt, { preflight_status: "CONNECTED" });

    const script = ctx.repo.scripts.get(attempt.script_id)!;
    let thread = script.training_thread_id ? ctx.repo.threads.get(script.training_thread_id) : undefined;
    let freshThread = false;
    const retrain = attempt.kind === "retrain";
    if (retrain || !thread || thread.provider !== attempt.agent || thread.status !== "ACTIVE") {
      const reason = retrain
        ? "retrain from scratch"
        : !thread
          ? "first training"
          : thread.provider !== attempt.agent
            ? `switch ${thread.provider} → ${attempt.agent}`
            : "replace inactive thread";
      thread = createThread(ctx, script, attempt.agent, thread, reason);
      freshThread = true;
    } else if (!thread.provider_thread_id) {
      freshThread = true;
    }
    updateAttempt(ctx, attempt, { thread_id: thread.id });

    const workspace = join(paths().workspaces, script.script_id);
    mkdirSync(workspace, { recursive: true });
    const candidatePath = join(workspace, CANDIDATE_FILE);
    const latest = latestCandidate(ctx, script.script_id);
    if (latest && !retrain) writeFileSync(candidatePath, latest.source);
    else rmSync(candidatePath, { force: true });

    const refs = writeProjectReferences(ctx, tc, workspace);
    const fromScratch = retrain || !latest;
    const verifyPlan = refs.length && fromScratch ? verificationInput(ctx, tc, env, attempt.sample_input) : null;
    const draftMode = !!verifyPlan?.input;
    const projectBlock = refs.length ? projectReferencesBlock({ testIds: refs.map((r) => r.test_id), draft: draftMode }) : "";
    if (refs.length) {
      const mode = draftMode
        ? " Chế độ soạn nháp: agent viết trước phần đã có trong tham chiếu, app chạy ẩn để kiểm chứng."
        : verifyPlan
          ? ` Không kiểm chứng tự động: ${verifyPlan.reason}.`
          : "";
      emitEvent({ ts: now(), kind: "status", text: `Tham chiếu dự án: ${refs.length} script đã duyệt (${refs.map((r) => r.test_id).join(", ")}).${mode}` });
    }
    const uploads = copyFixturesTo(tc, attempt.sample_input, join(mcpOut, FIXTURES_DIR));
    if (uploads.issues.length) throw new AppError(`Input mẫu không hợp lệ:\n${uploads.issues.join("\n")}`);
    const uploadFiles = Object.entries(uploads.paths).map(([field, path]) => ({ field, name: attempt.sample_input[field], path }));
    if (uploadFiles.length) emitEvent({ ts: now(), kind: "status", text: `File mẫu để tải lên: ${uploadFiles.map((f) => f.name).join(", ")}.` });
    const extra = [projectBlock, fileInputsBlock(uploadFiles)].filter(Boolean).join("\n\n");

    const lastRun = runContextFor(ctx, attempt.context_ref, latest);
    const priorPrompts = ctx.repo.attempts
      .where("script_id = ? AND attempt_id != ? ORDER BY created_at", script.script_id, attempt.attempt_id)
      .map((a) => a.prompt)
      .filter(Boolean);
    const buildPrompt = (fresh: boolean, reason: string) => {
      if (retrain) return initialPrompt(tc, env, attempt.sample_input, settings.training_max_actions, attempt.prompt, extra);
      if (fresh && (latest || priorPrompts.length)) {
        return bootstrapPrompt({
          tc,
          env,
          sample: attempt.sample_input,
          maxActions: settings.training_max_actions,
          revisionNo: latest?.revision_no ?? null,
          promptHistory: priorPrompts,
          lastRun,
          userPrompt: attempt.prompt,
          reason,
          extra,
        });
      }
      if (fresh) return initialPrompt(tc, env, attempt.sample_input, settings.training_max_actions, attempt.prompt, extra);
      return revisePrompt({
        userPrompt: attempt.prompt,
        revisionNo: latest?.revision_no ?? null,
        sample: attempt.sample_input,
        tc,
        lastRun,
        maxActions: settings.training_max_actions,
        extra,
      });
    };

    const adapter = adapters[attempt.agent];
    const apiKey = ctx.secrets.get(attempt.agent === "codex" ? secretKeys.openaiKey : secretKeys.cursorKey);
    const model = attempt.agent === "codex" ? settings.codex_model : settings.cursor_model;
    const mcp = playwrightMcpServer({ profile, env, extensionToken: token, outputDir: mcpOut });

    const turn = async (prompt: string): Promise<AgentTurnResult> => {
      const res = await adapter.runTurn({
        providerThreadId: thread!.provider_thread_id,
        prompt,
        cwd: workspace,
        mcp,
        model,
        apiKey,
        title: `E2E ${tc.test_id}`,
        signal: controller.signal,
        onEvent: emitEvent,
      });
      if (res.providerThreadId && res.providerThreadId !== thread!.provider_thread_id) {
        ctx.repo.threads.update([thread!.id], { provider_thread_id: res.providerThreadId });
        thread!.provider_thread_id = res.providerThreadId;
      }
      if (res.finalText) finalMessage = res.finalText;
      return res;
    };

    const switchReason = attempt.kind === "switch_agent" ? "The previous work was done with a different AI agent; its saved state is summarised below." : "The previous conversation thread could not be resumed; its saved state is summarised below.";
    let result: AgentTurnResult;
    try {
      emitEvent({ ts: now(), kind: "status", text: `Gửi yêu cầu tới ${attempt.agent === "codex" ? "Codex" : "Cursor"}${freshThread ? " (thread mới)" : " (tiếp tục thread)"}…` });
      result = await turn(buildPrompt(freshThread, switchReason));
    } catch (e) {
      if (!(e instanceof ThreadUnavailableError)) throw e;
      emitEvent({ ts: now(), kind: "status", text: `Không tiếp tục được thread cũ (${e.message}); tạo thread thay thế cùng provider.` });
      ctx.repo.threads.update([thread.id], { status: "BROKEN" });
      thread = createThread(ctx, script, attempt.agent, { ...thread, status: "BROKEN" }, "thread unavailable");
      updateAttempt(ctx, attempt, { thread_id: thread.id });
      result = await turn(buildPrompt(true, "The previous conversation thread could not be resumed; its saved state is summarised below."));
    }

    if (result.status === "cancelled" || controller.signal.aborted) {
      updateAttempt(ctx, attempt, { status: "FAILED", error: abortReason() });
      return;
    }
    let verdict = parseVerdict(result.finalText);
    if (verdict.status === "auth_required") {
      updateAttempt(ctx, attempt, { status: "AUTH_REQUIRED", preflight_status: "AUTH_REQUIRED", error: `Phiên đăng nhập của profile hết hạn trong lúc Training: ${verdict.reason}` });
      return;
    }
    if (result.status === "failed") {
      updateAttempt(ctx, attempt, { status: "FAILED", error: `Agent lỗi: ${result.error ?? "không rõ"}` });
      return;
    }

    const validationOf = (source: string): ScriptValidation =>
      validateScript(source, { schema: tc.input_schema, sampleInput: attempt.sample_input, secretValues: secrets, steps: tc.steps });
    let source = existsSync(candidatePath) ? readFileSync(candidatePath, "utf8") : null;
    let validation = source ? validationOf(source) : null;
    for (let i = 0; source && validation && !validation.ok && i < settings.training_max_repairs; i++) {
      emitEvent({ ts: now(), kind: "status", text: `Candidate chưa đạt kiểm tra (${validation.issues.filter((x) => x.severity === "error").length} lỗi); yêu cầu agent sửa (lần ${i + 1}).` });
      const r = await turn(repairPrompt(validation.issues));
      if (r.status !== "completed" || controller.signal.aborted) {
        updateAttempt(ctx, attempt, { status: "FAILED", error: controller.signal.aborted ? abortReason() : `Agent lỗi khi sửa: ${r.error ?? ""}` });
        return;
      }
      verdict = parseVerdict(r.finalText);
      source = existsSync(candidatePath) ? readFileSync(candidatePath, "utf8") : null;
      validation = source ? validationOf(source) : null;
    }
    const readCandidate = () => (existsSync(candidatePath) ? readFileSync(candidatePath, "utf8") : null);
    /** Current candidate.ts after asking the agent to fix validation errors; null when it stays invalid or a turn fails. */
    const repairedSource = async (): Promise<string | null> => {
      let src = readCandidate();
      let v = src ? validationOf(src) : null;
      for (let i = 0; src && v && !v.ok && i < settings.training_max_repairs; i++) {
        const r = await turn(repairPrompt(v.issues));
        if (r.status !== "completed" || controller.signal.aborted) return null;
        src = readCandidate();
        v = src ? validationOf(src) : null;
      }
      return src && v?.ok ? src : null;
    };

    let verification: { input: VerificationInput; run: VerifyRun<VerificationData> } | null = null;
    if (draftMode && source && validation?.ok && verdict.status !== "blocked") {
      const input = verifyPlan!.input!;
      const outcome = await verifyDraft<VerificationData>(source, {
        maxFixRounds: VERIFY_FIX_ROUNDS,
        aborted: () => controller.signal.aborted,
        status: (text) => emitEvent({ ts: now(), kind: "status", text }),
        run: async (src, round) => {
          const started_at = now();
          const { result, evidence } = await runVerification(ctx, join(dir, `verify-${round}`), src, env, input);
          return {
            ok: result.ok,
            authRequired: result.error_code === "AUTH_REQUIRED",
            summary: `${result.error_code ?? "FAILED"} — ${(result.error_message ?? "").split("\n")[0].slice(0, 200)}`,
            data: { result, evidence, started_at, finished_at: now() },
          };
        },
        fix: async (failed, round) => {
          const r = await turn(
            verifyFailPrompt({
              tc,
              round,
              maxActions: settings.training_max_actions,
              run: {
                label: `Verification run ${round} of ${CANDIDATE_FILE}`,
                status: "FAILED",
                error_code: failed.data.result.error_code,
                error_message: failed.data.result.error_message,
                steps: readSteps(failed.data.evidence.steps),
                input: input.snapshot,
              },
            }),
          );
          if (r.status !== "completed" || controller.signal.aborted) return null;
          const fixVerdict = parseVerdict(r.finalText).status;
          if (fixVerdict === "blocked" || fixVerdict === "auth_required") return null;
          return repairedSource();
        },
      });
      if (controller.signal.aborted) {
        updateAttempt(ctx, attempt, { status: "FAILED", error: abortReason() });
        return;
      }
      source = outcome.source;
      writeFileSync(candidatePath, source);
      validation = validationOf(source);
      verification = { input, run: outcome.last };
    }
    writeFileSync(join(dir, "validation.json"), JSON.stringify(validation, null, 2));

    if (!source) {
      updateAttempt(ctx, attempt, {
        status: "FAILED",
        error: `Agent chưa tạo file ${CANDIDATE_FILE}. Code chỉ nằm trong chat không được tính là candidate.${verdict.reason ? ` Lý do agent: ${verdict.reason}` : ""}`,
      });
      return;
    }
    const hash = sha256(source);
    if (latest && latest.source_hash === hash) {
      updateAttempt(ctx, attempt, {
        status: "FAILED",
        error: verdict.status === "blocked" ? `Agent dừng: ${verdict.reason}` : `Agent không thay đổi ${CANDIDATE_FILE} so với revision #${latest.revision_no}`,
      });
      return;
    }
    if (!validation!.ok) {
      const errs = validation!.issues.filter((i) => i.severity === "error").map((i) => `${i.line ? `dòng ${i.line}: ` : ""}${i.message}`);
      updateAttempt(ctx, attempt, { status: "FAILED", error: `Candidate không đạt kiểm tra sau ${settings.training_max_repairs} lần sửa:\n${errs.join("\n")}` });
      return;
    }

    const candidate: CandidateRevision = {
      candidate_id: newId("cand"),
      script_id: script.script_id,
      revision_no: (latest?.revision_no ?? 0) + 1,
      source,
      source_hash: hash,
      action_log_ref: toArtifactRef(join(dir, "action_log.json")),
      provider_thread_id: thread.id,
      attempt_id: attempt.attempt_id,
      origin: "ai",
      status: "DRAFT",
      reviewed_at: null,
      created_at: now(),
    };
    ctx.repo.candidates.insert(candidate);
    ctx.repo.audit("candidate.create", "candidate", candidate.candidate_id, {
      script_id: script.script_id,
      revision_no: candidate.revision_no,
      source_hash: hash,
      agent: attempt.agent,
      attempt_id: attempt.attempt_id,
    });
    if (verification) {
      const trial = recordVerificationTrial(ctx, candidate, env, verification.input, verification.run.data);
      emitEvent({ ts: now(), kind: "status", text: `Đã lưu lần chạy kiểm chứng cuối làm Trial ${trial.status} của candidate #${candidate.revision_no}.` });
    }
    updateAttempt(ctx, attempt, {
      status: verdict.status === "blocked" ? "FAILED" : "COMPLETED",
      candidate_id: candidate.candidate_id,
      error: verdict.status === "blocked" ? `Agent dừng giữa chừng: ${verdict.reason}. Đã lưu candidate #${candidate.revision_no} từ phần đã làm.` : null,
    });
  } catch (e) {
    updateAttempt(ctx, attempt, { status: "FAILED", error: controller.signal.aborted ? abortReason() : redactText((e as Error).message ?? String(e), secrets) });
  } finally {
    clearTimeout(timeout);
    writeFileSync(join(dir, "action_log.json"), JSON.stringify(actionLog, null, 2));
    if (finalMessage) writeFileSync(join(dir, "final_message.txt"), redactText(finalMessage, secrets));
    const shot = newestImage(mcpOut);
    const artifacts: TrainingAttempt["artifacts"] = {
      events: toArtifactRef(eventsPath),
      action_log: toArtifactRef(join(dir, "action_log.json")),
      ...(finalMessage ? { final_message: toArtifactRef(join(dir, "final_message.txt")) } : {}),
    };
    if (shot) {
      const dest = join(dir, `final${shot.slice(shot.lastIndexOf("."))}`);
      copyFileSync(shot, dest);
      artifacts.final_screenshot = toArtifactRef(dest);
    }
    const hint = fileAccessDenied && attempt.status === "FAILED" && !attempt.error?.includes(FILE_ACCESS_HINT) ? { error: `${attempt.error ?? ""}\n${FILE_ACCESS_HINT}`.trim() } : {};
    updateAttempt(ctx, attempt, { artifacts, action_count: attempt.action_count, finished_at: now(), ...hint });
    ctx.repo.audit("training.finish", "training_attempt", attempt.attempt_id, { status: attempt.status, candidate_id: attempt.candidate_id, actions: attempt.action_count });
  }
}

export function isTrainingBusy(profileId: string): boolean {
  return busyProfiles.has(profileId);
}
