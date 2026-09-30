import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Browser, BrowserContext, ElementHandle, Page } from "playwright";
import type { AgentProvider, CandidateRevision, Environment, InputValues, RecordingState, TestCase } from "../../shared/types";
import { buildRecordedScript, sanitizeRecordedAction, TOOLBAR_TAG, type RecordedAction, type RecordingEvent, type StableFix } from "../../core/recording";
import { fragileReason } from "../../core/selectorStability";
import { findStableLocator, takeActionTarget, TARGET_CAPTURE_SCRIPT } from "./stableLocator";
import { stepDirectives, type StepDirectives } from "../../core/stepDirectives";
import type { AppContext } from "../context";
import { artifactDir, toArtifactRef } from "../paths";
import { AppError, newId, now, sha256 } from "../util";
import { environmentSecrets, getEnvironment } from "../services/environments";
import { runnerAuthStatus } from "../services/execution";
import { getOrCreateScript, isScriptTraining, latestCandidate, trainingSchemaIssues } from "../training/orchestrator";
import { TOOLBAR_BINDING, TOOLBAR_SCRIPT, type ToolbarState } from "./toolbar";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright") as typeof import("playwright");

/** Same viewport as the Trial/Testing runner so responsive layouts (and thus locators) match. */
const VIEWPORT = { width: 1366, height: 820 };

type RecorderSink = {
  actionAdded?: (page: Page, action: unknown, code: string) => void;
  actionUpdated?: (page: Page, action: unknown, code: string) => void;
};
/** Playwright's recorder hook (used by `playwright codegen`); private API, pinned with the playwright version. */
type RecorderContext = BrowserContext & {
  _enableRecorder?: (params: { language: string; mode: "recording"; recorderMode: "api" }, sink: RecorderSink) => Promise<void>;
};

interface Session {
  state: RecordingState;
  tc: TestCase;
  env: Environment;
  agent: AgentProvider;
  sample: InputValues;
  directives: StepDirectives;
  browser: Browser | null;
  context: BrowserContext | null;
  events: RecordingEvent[];
  /**
   * Tab URL before the next action. The recorder reports an action only after running it (and maybe navigating),
   * but always before a toolbar button command; the toolbar's "hello" on page load may come before that report.
   */
  lastUrl: WeakMap<Page, string>;
  /** Index in `events` → element the action ran on, taken from the page's event capture when the action was reported. */
  targets: Map<number, Promise<ElementHandle | null>>;
  /** Index in `events` → stable replacement for that action's fragile selector, looked up on the live page right after the action. */
  stable: Map<number, { selector: string; fix: Promise<StableFix> }>;
}

const STABLE_LOOKUP_MS = 5000;

function trackStability(s: Session, page: Page, index: number, action: RecordedAction) {
  const selector = action.selector;
  if (!selector || s.stable.get(index)?.selector === selector) return;
  const reason = fragileReason(selector);
  if (!reason) return void s.stable.delete(index);
  const lookup = (s.targets.get(index) ?? Promise.resolve(null))
    .then((target) => findStableLocator(page, selector, { actionName: action.name, target }))
    .catch(() => null);
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), STABLE_LOOKUP_MS));
  s.stable.set(index, { selector, fix: Promise.race([lookup, timeout]).then((locator) => ({ reason, locator })) });
}

function clearTracking(s: Session) {
  s.stable.clear();
  s.targets.clear();
}

let current: Session | null = null;

const ACTIVE = new Set<RecordingState["status"]>(["STARTING", "RECORDING", "SAVING"]);

export function recordingState(): RecordingState | null {
  return current ? { ...current.state } : null;
}

/** A recording is running (optionally: for this test case); Training and edits of that script must wait. */
export function isRecording(testId?: string): boolean {
  return !!current && ACTIVE.has(current.state.status) && (!testId || current.state.test_id === testId);
}

function emit(ctx: AppContext, s: Session) {
  ctx.emit("recording:state", { ...s.state });
}

function toolbarState(s: Session): ToolbarState {
  const { step, step_count, action_count, shot_count } = s.state;
  return {
    step,
    total: step_count,
    text: s.tc.steps[step - 1] ?? "",
    shot: s.directives.screenshot.includes(step),
    close: s.directives.close.includes(step),
    actions: action_count,
    shots: shot_count,
  };
}

function broadcast(s: Session) {
  const st = JSON.stringify(toolbarState(s));
  for (const page of s.context?.pages() ?? []) {
    page.evaluate(`window.__e2eRecSet && window.__e2eRecSet(${st})`).catch(() => undefined);
  }
}

function setStep(s: Session, step: number) {
  const next = Math.min(Math.max(step, 1), Math.max(s.state.step_count, 1));
  if (next === s.state.step) return;
  s.state.step = next;
  s.events.push({ kind: "step", t: Date.now(), step: next });
}

const pageUrl = (p: Page) => {
  try {
    return p.url();
  } catch {
    return "";
  }
};

export async function startRecording(
  ctx: AppContext,
  req: { test_id: string; environment_id: string; sample_input: InputValues; agent: AgentProvider },
): Promise<RecordingState> {
  if (current && ACTIVE.has(current.state.status)) {
    throw new AppError(`Đang ghi thao tác cho ${current.state.test_id}. Kết thúc hoặc huỷ phiên đó trước.`);
  }
  const tc = ctx.repo.testCases.get(req.test_id);
  if (!tc) throw new AppError(`Không tìm thấy test case ${req.test_id}`);
  if (!tc.confirmed_at) throw new AppError("Test case chưa được xác nhận");
  const env = getEnvironment(ctx, req.environment_id);
  if (!runnerAuthStatus(ctx, env)) {
    throw new AppError(`Environment "${env.name}" chưa có runner auth. Vào Environment → đăng nhập cho runner trước khi ghi thao tác.`);
  }
  const script = ctx.repo.scripts.where("test_id = ?", tc.test_id)[0];
  if (script && isScriptTraining(script.script_id)) throw new AppError("Script đang có lượt Training chạy; đợi xong hoặc huỷ trước khi ghi thao tác");
  const inputIssues = trainingSchemaIssues(tc, req.sample_input);
  if (inputIssues.length) throw new AppError(`Input mẫu không hợp lệ:\n${inputIssues.join("\n")}`);
  const sample = Object.fromEntries(Object.entries(req.sample_input).filter(([k]) => tc.input_schema.fields.some((f) => f.name === k && !f.secret)));
  const sampleChanges = tc.input_schema.fields
    .filter((f) => !f.secret)
    .map((f) => ({ field: f.name, from: tc.sample_input[f.name] ?? "", to: sample[f.name] ?? "" }))
    .filter((c) => c.from !== c.to);

  const s: Session = {
    state: {
      session_id: newId("rec"),
      test_id: tc.test_id,
      environment_id: env.environment_id,
      status: "STARTING",
      step: 1,
      step_count: tc.steps.length,
      action_count: 0,
      shot_count: 0,
      candidate_id: null,
      revision_no: null,
      notes: [],
      error: null,
      started_at: now(),
      sample_changes: sampleChanges,
    },
    tc,
    env,
    agent: req.agent,
    sample,
    directives: stepDirectives(tc.steps),
    browser: null,
    context: null,
    events: [{ kind: "step", t: Date.now(), step: 1 }],
    lastUrl: new WeakMap(),
    targets: new Map(),
    stable: new Map(),
  };
  current = s;
  emit(ctx, s);

  try {
    const settings = ctx.settings();
    const storageState = JSON.parse(ctx.secrets.get(env.runner_auth_ref!) ?? "{}");
    const cdpPort = process.env.E2E_RECORDING_CDP_PORT;
    s.browser = await chromium.launch({
      channel: settings.runner_browser === "chromium" ? undefined : settings.runner_browser,
      headless: false,
      args: cdpPort ? [`--remote-debugging-port=${cdpPort}`] : [],
    });
    const context = (await s.browser.newContext({ storageState, viewport: VIEWPORT })) as RecorderContext;
    s.context = context;
    if (typeof context._enableRecorder !== "function") {
      throw new AppError("Phiên bản Playwright đang dùng không có recorder để ghi thao tác.");
    }
    await context.exposeBinding(TOOLBAR_BINDING, (source, cmd) => onToolbar(ctx, s, source.page, cmd as { type?: string }));
    await context.addInitScript(TOOLBAR_SCRIPT);
    await context.addInitScript(TARGET_CAPTURE_SCRIPT);
    const pageIndex = (p: Page) => Math.max(context.pages().indexOf(p), 0);
    await context._enableRecorder(
      { language: "javascript", mode: "recording", recorderMode: "api" },
      {
        actionAdded: (p, action, code) => {
          if (s.state.status !== "RECORDING" && s.state.status !== "STARTING") return;
          const a = sanitizeRecordedAction(action);
          if (a.selector?.includes(TOOLBAR_TAG) || code.includes(TOOLBAR_TAG)) return;
          s.events.push({ kind: "action", t: Date.now(), page: pageIndex(p), url: s.lastUrl.get(p) ?? pageUrl(p), action: a, code });
          s.lastUrl.set(p, pageUrl(p));
          s.targets.set(s.events.length - 1, takeActionTarget(p, a).catch(() => null));
          trackStability(s, p, s.events.length - 1, a);
          if (a.name !== "openPage" && a.name !== "closePage") s.state.action_count++;
          emit(ctx, s);
          broadcast(s);
        },
        actionUpdated: (p, action, code) => {
          if (s.state.status !== "RECORDING") return;
          for (let i = s.events.length - 1; i >= 0; i--) {
            const e = s.events[i];
            if (e.kind === "action") {
              const a = sanitizeRecordedAction(action);
              s.events[i] = { ...e, page: pageIndex(p), action: a, code };
              trackStability(s, p, i, a);
              break;
            }
          }
        },
      },
    );
    s.browser.on("disconnected", () => void finishRecording(ctx, s.state.session_id).catch(() => undefined));
    const page = await context.newPage();
    await page.goto(env.base_url).catch(() => undefined);
    if (s.state.status !== "STARTING") return { ...s.state };
    s.state.status = "RECORDING";
    emit(ctx, s);
    ctx.repo.audit("recording.start", "test_case", tc.test_id, { environment_id: env.environment_id, session_id: s.state.session_id });
    return { ...s.state };
  } catch (e) {
    s.state.status = "FAILED";
    s.state.error = (e as Error).message;
    await s.browser?.close().catch(() => undefined);
    emit(ctx, s);
    throw e instanceof AppError ? e : new AppError(`Không mở được trình duyệt để ghi thao tác: ${(e as Error).message}`);
  }
}

async function onToolbar(ctx: AppContext, s: Session, page: Page, cmd: { type?: string }): Promise<ToolbarState> {
  if (s.state.status !== "RECORDING") return toolbarState(s);
  if (cmd?.type !== "hello") s.lastUrl.set(page, pageUrl(page));
  switch (cmd?.type) {
    case "prev":
      setStep(s, s.state.step - 1);
      break;
    case "next":
      setStep(s, s.state.step + 1);
      break;
    case "shot":
      s.events.push({ kind: "shot", t: Date.now(), url: pageUrl(page) });
      s.state.shot_count++;
      if (s.directives.screenshot.includes(s.state.step)) setStep(s, s.state.step + 1);
      break;
    case "stop":
      setImmediate(() => void finishRecording(ctx, s.state.session_id).catch(() => undefined));
      return toolbarState(s);
    default:
      return toolbarState(s);
  }
  emit(ctx, s);
  broadcast(s);
  return toolbarState(s);
}

function saveCandidate(ctx: AppContext, s: Session, closeAtEnd: boolean, events: RecordingEvent[]): CandidateRevision {
  const secretNames = new Set(s.tc.input_schema.fields.filter((f) => f.secret).map((f) => f.name));
  const secrets = Object.fromEntries(Object.entries(environmentSecrets(ctx, s.env.environment_id)).filter(([k]) => secretNames.has(k)));
  const build = buildRecordedScript(events, {
    baseUrl: s.env.base_url,
    schema: s.tc.input_schema,
    sample: s.sample,
    secrets,
    steps: s.tc.steps,
    closeAtEnd,
  });
  if (!build.actionCount) throw new AppError("Chưa ghi được thao tác nào nên không tạo candidate.");
  if (!ctx.repo.testCases.get(s.tc.test_id)) throw new AppError("Test case đã bị xoá trong lúc ghi.");
  const script = getOrCreateScript(ctx, s.tc.test_id, s.agent);
  if (isScriptTraining(script.script_id)) throw new AppError("Script đang có lượt Training chạy nên chưa lưu được thao tác đã ghi.");

  const candidateId = newId("cand");
  const dir = artifactDir("recordings", candidateId);
  const logPath = join(dir, "action_log.json");
  writeFileSync(
    logPath,
    JSON.stringify(
      { session_id: s.state.session_id, environment_id: s.env.environment_id, started_at: s.state.started_at, finished_at: now(), notes: build.notes, actions: build.log },
      null,
      2,
    ),
  );
  const candidate: CandidateRevision = {
    candidate_id: candidateId,
    script_id: script.script_id,
    revision_no: (latestCandidate(ctx, script.script_id)?.revision_no ?? 0) + 1,
    source: build.source,
    source_hash: sha256(build.source),
    action_log_ref: toArtifactRef(logPath),
    provider_thread_id: null,
    attempt_id: null,
    origin: "recorded",
    status: "DRAFT",
    reviewed_at: null,
    created_at: now(),
  };
  ctx.repo.candidates.insert(candidate);
  ctx.repo.audit("candidate.recorded", "candidate", candidate.candidate_id, {
    script_id: script.script_id,
    revision_no: candidate.revision_no,
    source_hash: candidate.source_hash,
    actions: build.actionCount,
    notes: build.notes.length,
    session_id: s.state.session_id,
  });
  s.state.notes = build.notes;
  return candidate;
}

/** Stops the recording, closes the browser and stores the result as a DRAFT candidate. */
export async function finishRecording(ctx: AppContext, sessionId?: string): Promise<RecordingState> {
  const s = current;
  if (!s || (sessionId && s.state.session_id !== sessionId)) throw new AppError("Không còn phiên ghi thao tác này");
  if (s.state.status !== "RECORDING") return { ...s.state };
  s.state.status = "SAVING";
  emit(ctx, s);
  const firstClose = s.directives.close[0];
  const closeAtEnd = firstClose !== undefined && s.state.step >= firstClose;
  const fixes = new Map(await Promise.all([...s.stable].map(async ([i, { fix }]) => [i, await fix] as const)));
  const events = s.events.map((e, i) => (e.kind === "action" && fixes.has(i) ? { ...e, stable: fixes.get(i) } : e));
  await s.browser?.close().catch(() => undefined);
  try {
    const c = saveCandidate(ctx, s, closeAtEnd, events);
    s.state.status = "SAVED";
    s.state.candidate_id = c.candidate_id;
    s.state.revision_no = c.revision_no;
  } catch (e) {
    s.state.status = "FAILED";
    s.state.error = (e as Error).message;
    ctx.repo.audit("recording.failed", "test_case", s.tc.test_id, { session_id: s.state.session_id, error: s.state.error });
  }
  s.events = [];
  clearTracking(s);
  emit(ctx, s);
  return { ...s.state };
}

/** Discards the recording without creating anything. */
export async function cancelRecording(ctx: AppContext, sessionId?: string): Promise<RecordingState> {
  const s = current;
  if (!s || (sessionId && s.state.session_id !== sessionId)) throw new AppError("Không còn phiên ghi thao tác này");
  if (s.state.status !== "RECORDING" && s.state.status !== "STARTING") return { ...s.state };
  s.state.status = "CANCELLED";
  s.events = [];
  clearTracking(s);
  await s.browser?.close().catch(() => undefined);
  ctx.repo.audit("recording.cancel", "test_case", s.tc.test_id, { session_id: s.state.session_id });
  emit(ctx, s);
  return { ...s.state };
}

/** App shutdown: close the recording browser without saving. */
export async function abortRecording(): Promise<void> {
  const s = current;
  if (!s || !ACTIVE.has(s.state.status)) return;
  s.state.status = "CANCELLED";
  s.events = [];
  clearTracking(s);
  await s.browser?.close().catch(() => undefined);
}
